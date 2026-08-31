/**
 * 记忆仓储：领域表之上的纯业务逻辑（无 ctx 依赖，逻辑可单测）。
 * 写入顺序由调用方负责——工具的 execute 与捕获监听串行化度足够，单宿主进程内不做额外加锁；
 * 存储领域自身按写链串行。
 * @module dsh-echo-memory/store
 */

import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { MemoryKind, MemoryRecord, MemorySource } from './domain.js'
import { GLOBAL_WORKSPACE } from './domain.js'

/** 一次保存的写限值（由插件配置解析而来）。 */
export interface StoreLimits {
  /** 单条记忆正文最大 UTF-16 长度。 */
  readonly contentMaxChars: number
  /** 单条记忆标签上限。 */
  readonly tagsMax: number
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

/** 召回期窗口：超过 90 天未更新的记忆，新鲜度因子下限 0.1。 */
const FRESH_WINDOW_MS = 90 * 24 * 60 * 60 * 1000

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  const truncated = Number.isFinite(value) ? Math.trunc(value) : fallback
  if (truncated < min) return min
  if (truncated > max) return max
  return truncated
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

/** 新鲜度因子：1（刚更新）→ 0.1（90 天后），线性衰减。 */
export function recencyFactor(updatedAt: number, now: number): number {
  const ageMs = Math.max(0, now - updatedAt)
  return Math.max(0.1, 1 - (ageMs / FRESH_WINDOW_MS) * 0.9)
}

/** 排序兜底：主键同分时按 updatedAt 降序、id 升序（search 与注入共用）。 */
function tieBreak(a: MemoryRecord, b: MemoryRecord): number {
  return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** 关键词评分：标签精确 +8/个、标签前缀（≥2 字符）+4/个、正文子串 +2/次（上限 5 次）；无匹配返回 0。 */
export function keywordScore(record: MemoryRecord, query: string): number {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return 1
  let score = 0
  if (record.tags.includes(q)) score += 8
  if (q.length >= 2) {
    for (const tag of record.tags) {
      if (tag.startsWith(q)) score += 4
    }
  }
  const content = record.content.toLowerCase()
  let occurrences = 0
  let index = content.indexOf(q)
  while (index !== -1 && occurrences < 5) {
    occurrences += 1
    index = content.indexOf(q, index + q.length)
  }
  score += occurrences * 2
  return score
}

/**
 * 记忆仓储。表句柄由领域打开后注入；读取同步（领域权威内存态），写入 await 持久化后生效。
 */
export class MemoryStore {
  private seq = 0

  constructor(
    private readonly table: KvTable<string, MemoryRecord>,
    private readonly limits: StoreLimits,
  ) {}

  /**
   * 保存一条记忆。同工作区 + 同类型 + 同正文命中既有记录时强化（strength+1、updatedAt 刷新），
   * 否则新建记录。
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

  /** 删除一条记忆；记录不存在时 resolve 为 false。 */
  async forget(id: string): Promise<boolean> {
    return this.table.delete(id)
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
   * @param workspace - 当前会话 cwd；`*` 时只取全局记忆。
   * @param limit - 候选上限。
   * @param now - 时间基准，缺省当前时间（测试注入）。
   */
  rankedForInjection(workspace: string, limit: number, now: number = Date.now()): RecallCandidate[] {
    const candidates: RecallCandidate[] = []
    for (const [, record] of this.table.entries()) {
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

/** 一行注入文本的渲染（纯函数）。 */
export function renderLine(record: MemoryRecord): string {
  const strength = record.strength > 1 ? ` (x${record.strength})` : ''
  return `- [${record.kind}] ${record.content}${tagSuffix(record.tags)}${strength}`
}