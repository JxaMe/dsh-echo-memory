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
import { filterRecallHits } from './scoring.js'

/** 「相关记忆 · 按需使用：」回显标题。用户可能手动把已注入的召回块粘回输入，作为普通 text 块并入 query，导致拿 A 搜 A 的自增强；据此做内容级剥离作为 isRecallMessage 的补充。 */
const RECALL_ECHO_PREFIX = '相关记忆 · 按需使用：'

/**
 * 从一个 text 块中剥掉「以标题开头的回显段」：标题行 + 紧接的列表条目行，其余（真实追问）保留。
 * 只剥标题行/列表行，避免整块丢弃误伤「回显 + 追问混在同一块」的真实提问，保证该召的仍召。
 * 回显格式就是「标题 + \n 多条 `- ` 列表」；追加的追问不与列表条目同行，可安全保留。
 */
function stripRecallEcho(text: string): string {
  const block = text.trim()
  if (!block.startsWith(RECALL_ECHO_PREFIX)) return text
  const lines = block.split('\n')
  let i = 0
  // 跳过标题行
  i++
  // 跳过紧接的列表条目行（列表条目以 `- ` 开头）
  while (i < lines.length && /^\s*-\s+/.test(lines[i]!)) i++
  const rest = lines.slice(i).join('\n').trim()
  return rest
}

/** 从 claimed messages 抽取用于检索的 query（所有 text 块拼接，保留原始大小写由 scorer 统一 lower）。过滤 recall 回显（自动注入的 by source.kind，手动粘贴的内容级剥离），避免自增强。 */
export function extractQuery(messages: readonly UserMessage[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    if (isRecallMessage(msg)) continue
    for (const block of msg.content) {
      if (block.type !== 'text') continue
      const stripped = stripRecallEcho(block.text)
      const t = stripped.trim()
      if (t.length > 0) parts.push(t)
    }
  }
  // 过长 query 截到 2000 字符避免 scorer 做无意义长串扫描；足够覆盖常见问题。
  const joined = parts.join('\n').trim()
  return joined.length > 2000 ? joined.slice(0, 2000) : joined
}

/** 渲染 recall 区块的完整文本（含标题），hit 文本由 store.renderRecallText 提供。 */
export function renderRecallBlock(recallText: string): string {
  return `相关记忆 · 按需使用：\n${recallText}`
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
export function decideRecall(
  store: MemoryStore,
  read: () => MemoryInjectionConfig,
  agent: Agent,
  messages: readonly UserMessage[],
): { text: string; hits: number; rawHits: readonly import('./store.js').SearchHit[] } | undefined {
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
  const recallText = store.renderRecallText(hits, maxChars)
  if (recallText.length === 0) {
    store.recordAssembly(true, false)
    return undefined
  }
  store.recordAssembly(true, true)
  return { text: renderRecallBlock(recallText), hits: hits.length, rawHits: hits }
}

/**
 * @deprecated 直接用 decideRecall，异步向量已下掉（保留兼容，同步包一层 Promise）。
 */
export async function decideRecallAsync(
  store: MemoryStore,
  read: () => MemoryInjectionConfig,
  agent: Agent,
  messages: readonly UserMessage[],
): Promise<{ text: string; hits: number; rawHits: readonly import('./store.js').SearchHit[] } | undefined> {
  return decideRecall(store, read, agent, messages)
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
