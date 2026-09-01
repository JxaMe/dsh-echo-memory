/**
 * 记忆仓储：领域表之上的纯业务逻辑（无 ctx 依赖，逻辑可单测）。
 * 写入顺序由调用方负责——工具的 execute 与捕获监听串行化度足够，单宿主进程内不做额外加锁；
 * 存储领域自身按写链串行。
 * @module dsh-echo-memory/store
 */

import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { MemoryKind, MemoryRecord, MemorySource } from './domain.js'
import { GLOBAL_WORKSPACE } from './domain.js'
import type { DeletionMode } from './settings.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 一次保存的写限值（由插件配置解析而来）。 */
export interface StoreLimits {
  /** 单条记忆正文最大 UTF-16 长度。 */
  readonly contentMaxChars: number
  /** 单条记忆标签上限。 */
  readonly tagsMax: number
}

/** 提示词注入统计（运行期内存计数，重启清零）。 */
export interface InjectionStats {
  /** 启用注入时的组装请求次数。 */
  readonly requests: number
  /** 组装时实际注入了非空记忆的次数。 */
  readonly withContent: number
}

/** 保存一条记忆的输入；kind/source 缺省值由默认规则补齐。 */
export interface SaveInput {
  /** 归属工作区（绝对路径）；空串归一化为 `*`。 */
  readonly workspace: string
  /** 记忆正文（写入时 trim + 按 limit 截断）。 */
  readonly content: string
  /** 记忆类型，缺省 `fact`（显式 undefined 等同缺省）。 */
  readonly kind?: MemoryKind | undefined
  /** 检索标签（小写、去重、限量）。 */
  readonly tags?: readonly string[] | undefined
  /** 写入来源，缺省 `agent`。 */
  readonly source?: MemorySource | undefined
}

/** 一次保存的结果；existed=true 表示强化了既有记录而非新建。 */
export interface SaveOutcome {
  /** 命中的既有记录是否已存在。 */
  readonly existed: boolean
  /** 记录 id（新建或既有）。 */
  readonly id: string
  /** 保存后的强度。 */
  readonly strength: number
  /** 实际归属工作区。 */
  readonly workspace: string
}

/** 检索选项；全部可选（显式 undefined 等同缺省），组合取交集。 */
export interface SearchOptions {
  /** 关键词/短语（大小写不敏感），空串返回按新鲜度排序的记录。 */
  readonly query?: string | undefined
  /** 限定工作区（绝对路径）。 */
  readonly workspace?: string | undefined
  /** 限定记忆类型。 */
  readonly kind?: MemoryKind | undefined
  /** 返回条数上限 1–50，缺省 8。 */
  readonly limit?: number | undefined
}

/** 一次命中的记录与其评分（排序依据，不对外承诺稳定值）。 */
export interface SearchHit {
  readonly record: MemoryRecord
  readonly score: number
}

/** 提示词注入时的一次候选及其排名分。 */
export interface RecallCandidate {
  readonly record: MemoryRecord
  readonly rank: number
}

/** 记忆正文归一化：trim + 按配置截断（UTF-16 长度计）。 */
export function normalizeContent(content: string, maxChars: number): string {
  const trimmed = content.trim()
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed
}

/** 标签归一化：小写、去重、限量（保持出现顺序）。 */
export function normalizeTags(tags: readonly string[] | undefined, max: number): readonly string[] {
  if (tags === undefined || tags.length === 0) return Object.freeze([])
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase()
    if (tag.length === 0 || seen.has(tag)) continue
    seen.add(tag)
    result.push(tag)
    if (result.length >= max) break
  }
  return Object.freeze(result)
}

import {
  BM25_B,
  BM25_K1,
  BM25F_W_BODY,
  BM25F_W_TAGS,
  BM25F_W_TITLE,
  FRESH_WINDOW_MS,
  HYBRID_ALPHA,
  LOCAL_SYNONYMS,
  META_QUERY_RE,
  STOPWORDS,
  clampInt,
  expandWithLocalSynonyms,
  filterRecallHits,
  filterStopwords,
  isMetaQuery,
  keywordScore,
  recencyFactor,
  scoreBM25F,
  scoreHybridBM25,
  scorePlainBM25,
  tieBreak,
  tokenizeForRecall,
} from './scoring.js'

// 兼容旧测试：store 曾直接暴露评分函数，现转发自 scoring.ts
export {
  BM25_B,
  BM25_K1,
  BM25F_W_BODY,
  BM25F_W_TAGS,
  BM25F_W_TITLE,
  FRESH_WINDOW_MS,
  HYBRID_ALPHA,
  LOCAL_SYNONYMS,
  META_QUERY_RE,
  STOPWORDS,
  clampInt,
  expandWithLocalSynonyms,
  filterRecallHits,
  filterStopwords,
  isMetaQuery,
  keywordScore,
  recencyFactor,
  scoreBM25F,
  scoreHybridBM25,
  scorePlainBM25,
  tieBreak,
  tokenizeForRecall,
}

let cachedHasKey: boolean | undefined
let cachedHasKeyAt = 0
const HAS_KEY_TTL_MS = 30_000
/** 检测是否已配 DeepSeek Key（保留供外部检测，已不用于召回）。带 30s TTL。 */
export function hasDeepSeekKey(): boolean {
  const now = Date.now()
  if (cachedHasKey !== undefined && now - cachedHasKeyAt < HAS_KEY_TTL_MS) return cachedHasKey
  if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.trim().length > 0) {
    cachedHasKey = true
    cachedHasKeyAt = now
    return true
  }
  try {
    const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    // 仅认行首的键，忽略 "# DEEPSEEK_API_KEY: ..." 注释行
    const m = raw.match(/^\s*DEEPSEEK_API_KEY:\s*([^\s#]+)/m)
    const hit = m?.[1] !== undefined && m[1].trim().length > 0
    cachedHasKey = hit
    cachedHasKeyAt = now
    return hit
  } catch {
    cachedHasKey = false
    cachedHasKeyAt = now
    return false
  }
}

/** 清除 hasDeepSeekKey 缓存（测试用，或外部在凭证变更后调用）。 */
export function clearHasKeyCache(): void {
  cachedHasKey = undefined
  cachedHasKeyAt = 0
}

/**
 * 记忆仓储。表句柄由领域打开后注入；读取同步（领域权威内存态），写入 await 持久化后生效。
 */
export class MemoryStore {
  private seq = 0
  private readonly injections: { requests: number; withContent: number } = { requests: 0, withContent: 0 }

  constructor(
    private readonly table: KvTable<string, MemoryRecord>,
    private readonly limits: StoreLimits,
  ) {}

  /** 注入统计快照（prompt 组装时由 memoryContextText 记账）。 */
  get injectionStats(): InjectionStats {
    return { ...this.injections }
  }

  /**
   * 记录一次组装：启用注入时计请求数，注入了非空记忆时计命中数。
   * @param enabled - 本次组装的注入开关（关闭不计）。
   * @param injected - 本次是否注入了非空记忆文本。
   */
  recordAssembly(enabled: boolean, injected: boolean): void {
    if (!enabled) return
    this.injections.requests += 1
    if (injected) this.injections.withContent += 1
  }

  /** 活跃记忆条数（不含墓碑）。 */
  liveCount(): number {
    let count = 0
    for (const [, record] of this.table.entries()) {
      if (record.deletedAt === undefined) count += 1
    }
    return count
  }

  /** 取指定工作区的所有活记录（全局 `*` 始终包含），供混合检索用。 */
  liveRecords(workspace: string): MemoryRecord[] {
    const out: MemoryRecord[] = []
    for (const [, record] of this.table.entries()) {
      if (record.deletedAt !== undefined) continue
      if (record.workspace !== workspace && record.workspace !== GLOBAL_WORKSPACE) continue
      out.push(record)
    }
    return out
  }

  /** 所有活记录（不分工作区），供后台向量回填用。 */
  allLive(): MemoryRecord[] {
    const out: MemoryRecord[] = []
    for (const [, record] of this.table.entries()) {
      if (record.deletedAt !== undefined) continue
      out.push(record)
    }
    return out
  }

  /**
   * 保存一条记忆。同工作区 + 同类型 + 同正文命中**未删除**的既有记录时强化
   * （strength+1、updatedAt 刷新），否则新建记录（墓碑记录不参与查重：删除后重新保存 = 新起点）。
   * @param input - 归一化前的保存输入（workspace 空串按 `*` 处理）。
   * @param now - 时间基准，缺省当前时间（测试注入）。
   * @returns 保存结果；正文不含非空白字符时抛 TypeError。
   */
  async save(input: SaveInput, now: number = Date.now()): Promise<SaveOutcome> {
    const content = normalizeContent(input.content, this.limits.contentMaxChars)
    if (content.length === 0) {
      throw new TypeError('dsh-echo-memory: memory content must contain a non-whitespace character')
    }
    const kind = input.kind ?? 'fact'
    const workspace = input.workspace.trim() === '' ? GLOBAL_WORKSPACE : input.workspace.trim()
    const tags = normalizeTags(input.tags, this.limits.tagsMax)
    const source = input.source ?? 'agent'
    for (const [id, record] of this.table.entries()) {
      if (record.deletedAt !== undefined) continue
      if (record.workspace === workspace && record.kind === kind && record.content === content) {
        const next: MemoryRecord = {
          ...record,
          strength: record.strength + 1,
          updatedAt: now,
        }
        await this.table.put(id, next)
        return { existed: true, id, strength: next.strength, workspace }
      }
    }
    const id = this.nextId(now)
    const record: MemoryRecord = {
      id,
      workspace,
      kind,
      content,
      tags,
      strength: 1,
      source,
      createdAt: now,
      updatedAt: now,
    }
    await this.table.put(id, record)
    return { existed: false, id, strength: 1, workspace }
  }

  /**
   * @deprecated 向量已下掉（保留兼容，调用无效果）
   */
  async setEmbedding(_id: string, _embedding: readonly number[], _now: number = Date.now()): Promise<void> {
    return
  }

  /**
   * 删除一条记忆。按模式：`purge` 物理删除；`tombstone` 打墓碑标记
   * （检索/注入不可见，purgeDeleted 时物理清除）。已删除/不存在的记录 resolve 为 false。
   * @param id - 记录 id。
   * @param mode - 删除行为模式（调用方现读设置传入）。
   * @param now - 时间基准，缺省当前时间（测试注入）。
   */
  async forget(id: string, mode: DeletionMode, now: number = Date.now()): Promise<boolean> {
    if (mode === 'purge') return this.table.delete(id)
    const record = this.table.get(id)
    if (record === undefined || record.deletedAt !== undefined) return false
    await this.table.put(id, { ...record, deletedAt: now })
    return true
  }

  /**
   * 彻底清除全部墓碑记录（物理删除 + 逐条持久化）。设置面板「彻底删除」按钮的后端动作。
   * @returns 本次清除的墓碑条数（0 表示没有待清除的墓碑）。
   */
  async purgeDeleted(): Promise<number> {
    const doomed: string[] = []
    for (const [id, record] of this.table.entries()) {
      if (record.deletedAt !== undefined) doomed.push(id)
    }
    for (const id of doomed) {
      await this.table.delete(id)
    }
    return doomed.length
  }

  /** 列出墓碑（最近删除），按 deletedAt 降序。 */
  listDeleted(limit: number = 20): MemoryRecord[] {
    const out: MemoryRecord[] = []
    for (const [, record] of this.table.entries()) {
      if (record.deletedAt !== undefined) out.push(record)
    }
    out.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0) || (a.id < b.id ? -1 : 1))
    return out.slice(0, clampInt(limit, 20, 1, 100))
  }

  /** 列出最近活跃记忆，按 updatedAt 降序（纯管理用，不走评分）。 */
  listRecent(limit: number = 20): MemoryRecord[] {
    const out: MemoryRecord[] = []
    for (const [, record] of this.table.entries()) {
      if (record.deletedAt !== undefined) continue
      out.push(record)
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
    return out.slice(0, clampInt(limit, 20, 1, 100))
  }

  /** 恢复单条墓碑（清除 deletedAt），不存在或未删除返回 false。 */
  async restore(id: string): Promise<boolean> {
    const rec = this.table.get(id)
    if (rec === undefined || rec.deletedAt === undefined) return false
    const restored: MemoryRecord = {
      id: rec.id,
      workspace: rec.workspace,
      kind: rec.kind,
      content: rec.content,
      tags: rec.tags,
      strength: rec.strength,
      source: rec.source,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      ...(rec.embedding !== undefined ? { embedding: rec.embedding } : {}),
      ...(rec.embeddingAt !== undefined ? { embeddingAt: rec.embeddingAt } : {}),
    }
    await this.table.put(id, restored)
    return true
  }

  /** 单条墓碑彻底删除（仅当已是墓碑时），返回是否删除。 */
  async purgeOne(id: string): Promise<boolean> {
    const rec = this.table.get(id)
    if (rec === undefined || rec.deletedAt === undefined) return false
    return this.table.delete(id)
  }

  /** 更新一条记忆的正文/标签（保留 strength/source/时间，刷新 updatedAt）。 */
  async update(id: string, patch: { content?: string; tags?: readonly string[] }, now: number = Date.now()): Promise<boolean> {
    const rec = this.table.get(id)
    if (rec === undefined) return false
    const content = patch.content !== undefined ? normalizeContent(patch.content, this.limits.contentMaxChars) : rec.content
    if (content.length === 0) return false
    const tags = patch.tags !== undefined ? normalizeTags(patch.tags, this.limits.tagsMax) : rec.tags
    const next: MemoryRecord = { ...rec, content, tags, updatedAt: now }
    await this.table.put(id, next)
    return true
  }

  /**
   * 检索记忆：按查询关键词评分（标签精确 > 标签前缀 > 正文子串），
   * 乘以强度与新鲜度因子后降序，同分按 updatedAt 降序、id 升序。
   * @param options - 过滤与限量；query 为空时返回最近记忆。
   * @returns 命中的记录快照（存储对象本身，勿就地修改）。
   */
  search(options: SearchOptions = {}): SearchHit[] {
    const limit = clampInt(options.limit, 8, 1, 50)
    const now = Date.now()
    const hits: SearchHit[] = []
    for (const [, record] of this.table.entries()) {
      if (record.deletedAt !== undefined) continue
      if (options.workspace !== undefined && record.workspace !== options.workspace) continue
      if (options.kind !== undefined && record.kind !== options.kind) continue
      const word = keywordScore(record, options.query ?? '')
      if (word === 0) continue
      const score = word * (1 + Math.log2(record.strength)) * recencyFactor(record.updatedAt, now)
      hits.push({ record, score })
    }
    hits.sort((a, b) => b.score - a.score || tieBreak(a.record, b.record))
    return hits.slice(0, limit)
  }

  /**
   * 计算提示词注入候选（按排名降序，供 text provider 使用，不注入会话日志之外的内容）。
   * 老化规则：超过新鲜度窗口（90 天）未更新的记忆不参与注入（「自动想起」只带新鲜的），
   * 但 memory_search 仍可显式检索到历史记忆。
   * @param workspace - 当前会话 cwd；`*` 时只取全局记忆。
   * @param limit - 候选上限。
   * @param now - 时间基准，缺省当前时间（测试注入）。
   * @deprecated 广播式召回已由按需召回（searchForRecall + pre-step）取代，保留仅为兼容旧测试与回滚。
   */
  rankedForInjection(workspace: string, limit: number, now: number = Date.now()): RecallCandidate[] {
    const candidates: RecallCandidate[] = []
    for (const [, record] of this.table.entries()) {
      if (record.deletedAt !== undefined) continue
      if (now - record.updatedAt > FRESH_WINDOW_MS) continue // 老化：过期记忆退出注入
      if (record.workspace !== workspace && record.workspace !== GLOBAL_WORKSPACE) continue
      const rank = record.strength * recencyFactor(record.updatedAt, now)
      candidates.push({ record, rank })
    }
    candidates.sort((a, b) => b.rank - a.rank || tieBreak(a.record, b.record))
    return candidates.slice(0, clampInt(limit, 8, 1, 50))
  }

  /**
   * 渲染提示词注入文本：`- [kind] content #tag…（×strength，仅 >1 时）`，
   * 按 maxChars 截断（最后一行补省略号）；无记忆或全部超限返回空串（零贡献）。
   * @param options - 工作区、条数与字符上限。
   * @param now - 时间基准，缺省当前时间（测试注入）。
   * @deprecated 广播式渲染已由按需渲染（renderRecallText）取代。
   */
  recallText(
    options: { readonly workspace: string; readonly limit: number; readonly maxChars: number },
    now: number = Date.now(),
  ): string {
    const maxChars = Math.max(options.maxChars, 1)
    const lines: string[] = []
    let used = 0
    for (const { record } of this.rankedForInjection(options.workspace, options.limit, now)) {
      const line = renderLine(record)
      if (lines.length > 0 && used + line.length + 1 > maxChars) {
        lines.push(`${line.slice(0, Math.max(0, maxChars - used - 1))}…`)
        break
      }
      if (lines.length === 0 && line.length > maxChars) {
        lines.push(`${line.slice(0, Math.max(0, maxChars - 1))}…`)
        break
      }
      lines.push(line)
      used += line.length + 1
    }
    return lines.join('\n')
  }

  /**
   * 按需召回：BM25 + 本地同义词膨胀 + 强度 + 新鲜度，工作区 = 当前会话 cwd 或全局 `*`。
   * 不过滤 90 天老化（相关就召回），但仍用新鲜度加权。空 query 返回空避免广播噪音。
   * @param workspace - 当前会话 cwd；`*` 时只取全局记忆。
   * @param query - 当前用户问题的原文（大小写不敏感）。
   * @param limit - 候选上限。
   * @param now - 时间基准。
   */
  searchForRecall(workspace: string, query: string, limit: number, now: number = Date.now()): SearchHit[] {
    if (isMetaQuery(query)) return []
    const baseTokens = tokenizeForRecall(query)
    if (baseTokens.length === 0) return []
    const tokens = expandWithLocalSynonyms(baseTokens)
    const candidates: MemoryRecord[] = []
    for (const [, record] of this.table.entries()) {
      if (record.deletedAt !== undefined) continue
      if (record.workspace !== workspace && record.workspace !== GLOBAL_WORKSPACE) continue
      candidates.push(record)
    }
    if (candidates.length === 0) return []
    const hits = scoreBM25F(candidates, tokens, now)
    return hits.slice(0, clampInt(limit, 8, 1, 50))
  }

  /**
   * 按需召回的文本渲染（卡片化 A 方案）。
   * 无命中返回空串（零贡献，pre-step 不注入）。
   */
  renderRecallText(hits: readonly SearchHit[], maxChars: number): string {
    const cap = Math.max(maxChars, 1)
    const lines: string[] = []
    let used = 0
    for (const { record } of hits) {
      const line = renderCardLine(record)
      if (lines.length > 0 && used + line.length + 1 > cap) {
        lines.push(`${line.slice(0, Math.max(0, cap - used - 1))}…`)
        break
      }
      if (lines.length === 0 && line.length > cap) {
        lines.push(`${line.slice(0, Math.max(0, cap - 1))}…`)
        break
      }
      lines.push(line)
      used += line.length + 1
    }
    return lines.join('\n')
  }

  private nextId(now: number): string {
    for (;;) {
      const id = `mem-${now}-${this.seq}`
      this.seq += 1
      if (this.table.get(id) === undefined) return id
      if (this.seq > 1_000_000) {
        throw new Error('dsh-echo-memory: memory id space exhausted for this timestamp')
      }
    }
  }
}

/** 标签后缀渲染：` #tag #tag`（无标签返回空串）；召回文本与工具检索渲染共用，防漂移。 */
export function tagSuffix(tags: readonly string[]): string {
  return tags.length > 0 ? ` ${tags.map(tag => `#${tag}`).join(' ')}` : ''
}

/** 一行注入文本的渲染（纯函数，旧格式，保留兼容）。 */
export function renderLine(record: MemoryRecord): string {
  const strength = record.strength > 1 ? ` (x${record.strength})` : ''
  return `- [${record.kind}] ${record.content}${tagSuffix(record.tags)}${strength}`
}

/** 卡片化单行：标题加粗 + 正文 60 字截断（A 方案）。 */
export function renderCardLine(record: MemoryRecord): string {
  const raw = record.content.trim()
  let title = ''
  let body = raw
  const colon = raw.search(/[:：]/)
  if (colon > 0 && colon < 24) {
    title = raw.slice(0, colon).trim()
    body = raw.slice(colon + 1).replace(/^[:：\s]+/, '').trim()
  } else {
    const comma = raw.search(/[，,]/)
    if (comma > 0 && comma < 24) {
      title = raw.slice(0, comma).trim()
      body = raw.slice(comma + 1).trim()
    }
  }
  // 正文精简：60 字 + 去多余空白
  const short = body.length > 60 ? body.slice(0, 60).trimEnd() + '…' : body
  const kind = `[${record.kind}]`
  const tags = tagSuffix(record.tags)
  const strength = record.strength > 1 ? ` (x${record.strength})` : ''
  if (title) return `- **${title}** ${kind} ${short}${tags}${strength}`
  return `- ${kind} ${short}${tags}${strength}`
}