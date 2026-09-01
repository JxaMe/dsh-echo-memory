/**
 * 按需召回的 pre-step 注入：从本次 claimed 的用户消息抽 query，检索相关记忆，
 * 以 UserMessage 形式追加到决策的 messages 末尾（离模型答案最近）。
 * 广播式 systemPrompt 注入已废弃，此文件是唯一注入点。
 * @module dsh-echo-memory/recall
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { MemoryStore } from './store.js'
import { GLOBAL_WORKSPACE, agentWorkspace } from './domain.js'
import type { MemoryInjectionConfig } from './prompt.js'
import { expandWithLocalSynonyms, hasDeepSeekKey, keywordScore, recencyFactor, tokenizeForRecall } from './store.js'
import { cosine, embed } from './embedding.js'

/** 从 claimed messages 抽取用于检索的 query（所有 text 块拼接，保留原始大小写由 scorer 统一 lower）。 */
export function extractQuery(messages: readonly UserMessage[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== 'text') continue
      const t = block.text.trim()
      if (t.length > 0) parts.push(t)
    }
  }
  // 过长 query 截到 2000 字符避免 scorer 做无意义长串扫描；足够覆盖常见问题。
  const joined = parts.join('\n').trim()
  return joined.length > 2000 ? joined.slice(0, 2000) : joined
}

/** 渲染 recall 区块的完整文本（含标题），hit 文本由 store.renderRecallText 提供。 */
export function renderRecallBlock(recallText: string): string {
  return `[记忆召回] 与当前话题相关的记忆（仅作参考，按需使用）：\n${recallText}`
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-echo-memory:recall': { kind: 'dsh-echo-memory:recall'; hits: number }
  }
}

/**
 * 构造 pre-step 监听器的核心逻辑（可单测）：决定是否注入以及注入内容。
 * @param store - 仓储
 * @param read - 每次 step 现读的注入配置
 * @param agent - 当前 agent（取 workspace）
 * @param messages - 本次 claimed 的原始用户消息（抽 query 用）
 * @returns 命中文本与 hit 数，或 undefined 表示不注入
 */
/** 泛词阈值：低分时只留与最高分近乎相同的命中，避免 Ubuntu 这类泛词一次带回俩；高分时按 0.6 相对阈值 */
function filterRecallHits(hits: ReadonlyArray<{ record: { id: string }; score: number }>): typeof hits {
  if (hits.length <= 1) return hits as typeof hits
  const max = hits[0]!.score
  if (max < 0.01) return [] as unknown as typeof hits
  if (max < 0.35) {
    return hits.filter(h => h.score >= max * 0.95) as unknown as typeof hits
  }
  return hits.filter(h => h.score >= max * 0.6 && h.score >= 0.12) as unknown as typeof hits
}

export function decideRecall(
  store: MemoryStore,
  read: () => MemoryInjectionConfig,
  agent: Agent,
  messages: readonly UserMessage[],
): { text: string; hits: number } | undefined {
  const { enabled, limit, maxChars } = read()
  if (!enabled) return undefined
  const query = extractQuery(messages)
  if (query.length === 0) {
    store.recordAssembly(true, false)
    return undefined
  }
  const workspace = agentWorkspace(agent) ?? GLOBAL_WORKSPACE
  const rawHits = store.searchForRecall(workspace, query, limit)
  const hits = filterRecallHits(rawHits)
  if (hits.length === 0) {
    store.recordAssembly(true, false)
    return undefined
  }
  const recallText = store.renderRecallText(hits as any, maxChars)
  if (recallText.length === 0) {
    store.recordAssembly(true, false)
    return undefined
  }
  store.recordAssembly(true, true)
  return { text: renderRecallBlock(recallText), hits: hits.length }
}

export async function decideRecallAsync(
  store: MemoryStore,
  read: () => MemoryInjectionConfig,
  agent: Agent,
  messages: readonly UserMessage[],
): Promise<{ text: string; hits: number } | undefined> {
  const { enabled, limit, maxChars } = read()
  if (!enabled) return undefined
  const query = extractQuery(messages)
  if (query.length === 0) {
    store.recordAssembly(true, false)
    return undefined
  }
  const workspace = agentWorkspace(agent) ?? GLOBAL_WORKSPACE
  if (!hasDeepSeekKey()) return decideRecall(store, read, agent, messages)
  try {
    const queryVec = await embed(query)
    const candidates = store.liveRecords(workspace)
    if (candidates.length === 0) {
      store.recordAssembly(true, false)
      return undefined
    }
    const baseTokens = tokenizeForRecall(query)
    const tokens = expandWithLocalSynonyms(baseTokens)
    const df = new Map<string, number>()
    for (const tok of tokens) {
      let c = 0
      for (const rec of candidates) if (keywordScore(rec, tok) > 0) c += 1
      df.set(tok, c)
    }
    const N = candidates.length
    const idf = new Map<string, number>()
    for (const tok of tokens) idf.set(tok, Math.log((N - (df.get(tok) ?? 0) + 0.5) / ((df.get(tok) ?? 0) + 0.5) + 1))
    let totalLen = 0
    const fieldLen = new Map<string, number>()
    for (const rec of candidates) {
      const len = rec.content.length + rec.tags.join(' ').length
      fieldLen.set(rec.id, len)
      totalLen += len
    }
    const avgLen = totalLen / Math.max(1, candidates.length)
    const k1 = 1.2, b = 0.75, alpha = 0.7
    const now = Date.now()
    const scored: Array<{ record: typeof candidates[number]; score: number }> = []
    let maxBm25 = 0
    const bm25Map = new Map<string, number>()
    for (const rec of candidates) {
      let bm25 = 0
      const len = fieldLen.get(rec.id) ?? rec.content.length
      for (const tok of tokens) {
        const tf = keywordScore(rec, tok)
        if (tf === 0) continue
        const curIdf = idf.get(tok) ?? 0
        bm25 += curIdf * (tf * (k1 + 1) / (tf + k1 * (1 - b + b * (len / Math.max(1, avgLen)))))
      }
      bm25Map.set(rec.id, bm25)
      if (bm25 > maxBm25) maxBm25 = bm25
    }
    for (const rec of candidates) {
      const bm25 = bm25Map.get(rec.id) ?? 0
      const normBm25 = maxBm25 > 0 ? bm25 / maxBm25 : 0
      let cos = 0
      if (rec.embedding && rec.embedding.length > 0) {
        try { cos = Math.max(0, cosine(queryVec, rec.embedding)) } catch { cos = 0 }
      }
      const hasVec = rec.embedding && rec.embedding.length > 0
      const hybrid = hasVec ? alpha * cos + (1 - alpha) * normBm25 : normBm25
      if (hybrid === 0) continue
      const finalScore = hybrid * (1 + Math.log2(rec.strength)) * recencyFactor(rec.updatedAt, now)
      scored.push({ record: rec, score: finalScore })
    }
    scored.sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt || (a.record.id < b.record.id ? -1 : 1))
    const sliced = scored.slice(0, Math.max(1, Math.min(limit, 50))).map(s => ({ record: s.record, score: s.score }))
    const hits = filterRecallHits(sliced)
    if (hits.length === 0) {
      store.recordAssembly(true, false)
      return undefined
    }
    const recallText = store.renderRecallText(hits as any, maxChars)
    if (recallText.length === 0) {
      store.recordAssembly(true, false)
      return undefined
    }
    store.recordAssembly(true, true)
    return { text: renderRecallBlock(recallText), hits: hits.length }
  } catch {
    return decideRecall(store, read, agent, messages)
  }
}

/** 是否为本插件的 recall 注入消息（用于幂等或去重判断，预留）。 */
export function isRecallMessage(msg: UserMessage): boolean {
  return (msg.source as { kind?: string }).kind === 'dsh-echo-memory:recall'
}

/** 创建实际注入的 UserMessage。 */
export function createRecallMessage(text: string, hits: number): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-echo-memory:recall', hits } as unknown as UserMessage['source'],
  })
}
