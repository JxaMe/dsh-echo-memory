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

/** 本地同义词表：BM25 之前的轻量膨胀，命中“部署”也能召回“systemd”。无 API Key 时的双保险，回退仍可用。 */
const LOCAL_SYNONYMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '部署': ['systemd', '发布', '上线', 'deploy', 'systemctl'],
  'systemd': ['部署', '服务', 'systemctl', 'deploy'],
  'deploy': ['部署', 'systemd', '发布'],
  '发布': ['部署', '上线', 'deploy'],
  '上线': ['部署', '发布'],
  '前端': ['react', 'ui', '组件', 'vue'],
  'react': ['前端', 'ui', '组件'],
  '组件': ['react', '前端', 'ui'],
  'ui': ['react', '前端', '组件'],
  '后端': ['api', '服务', '接口'],
  'api': ['接口', '后端', '服务'],
  '接口': ['api', '后端'],
  '数据库': ['db', '存储', 'postgres', 'mysql', 'sqlite'],
  '存储': ['数据库', 'db', '落盘'],
  '落盘': ['存储', '持久化', '保存'],
  '记忆': ['memory', '记住'],
  '记住': ['记忆', 'memory'],
  '配置': ['设置', 'config', 'settings'],
  '设置': ['配置', 'config'],
})

/** 按需召回的 query 分词：提“systemd 怎么配”中的有效 token，避免整句不命中。 */
export function tokenizeForRecall(query: string): string[] {
  const trimmed = query.trim().toLowerCase()
  if (trimmed.length === 0) return []
  // 抽取连续的中日韩、字母、数字 token；单字中文也保留（避免“配”丢掉），英文/数字要求 ≥2 避免噪音
  const raw = trimmed.match(/[\u4e00-\u9fa5]+|[a-z0-9]+/gi) ?? []
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const tok of raw) {
    const t = tok.toLowerCase()
    if (t.length === 0 || seen.has(t)) continue
    if (t.length < 2) continue
    // 中文长串拆成 2-gram，避免“本机什么系统”整串不命中“本机系统信息”
    if (/^[\u4e00-\u9fa5]+$/.test(t) && t.length > 4) {
      for (let i = 0; i < t.length - 1; i++) {
        const gram = t.slice(i, i + 2)
        if (seen.has(gram)) continue
        seen.add(gram)
        tokens.push(gram)
        if (tokens.length >= 20) break
      }
      if (!seen.has(t) && tokens.length < 20) {
        seen.add(t)
        tokens.push(t)
      }
    } else {
      seen.add(t)
      tokens.push(t)
    }
    if (tokens.length >= 20) break
  }
  // 中文连续串会把“发布怎么弄”当一整 token，导致同义词表失配；额外扫描已知词表做子串命中
  for (const key of Object.keys(LOCAL_SYNONYMS)) {
    const lower = key.toLowerCase()
    if (seen.has(lower)) continue
    if (trimmed.includes(lower)) {
      seen.add(lower)
      tokens.push(lower)
      if (tokens.length >= 20) break
    }
  }
  return tokens
}

let cachedHasKey: boolean | undefined
/** 检测是否已配 DeepSeek Key（用于远端同义词/embedding，回退到本地 BM25）。 */
export function hasDeepSeekKey(): boolean {
  if (cachedHasKey !== undefined) return cachedHasKey
  if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.trim().length > 0) {
    cachedHasKey = true
    return true
  }
  try {
    const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    cachedHasKey = /DEEPSEEK_API_KEY:\s*sk-/.test(raw)
    return cachedHasKey
  } catch { cachedHasKey = false; return false }
}

/** 基于本地表的同义词膨胀（去重，保留原词，权重交给 BM25 的 IDF）。 */
export function expandWithLocalSynonyms(tokens: readonly string[]): string[] {
  const seen = new Set<string>(tokens)
  const expanded = [...tokens]
  for (const tok of tokens) {
    const syns = LOCAL_SYNONYMS[tok]
    if (syns === undefined) continue
    for (const s of syns) {
      const lower = s.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)
      expanded.push(lower)
      if (expanded.length >= 30) break
    }
    if (expanded.length >= 30) break
  }
  return expanded
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

  /** 补写向量（后台异步，不阻塞保存确认）。 */
  async setEmbedding(id: string, embedding: readonly number[], now: number = Date.now()): Promise<void> {
    const rec = this.table.get(id)
    if (rec === undefined || rec.deletedAt !== undefined) return
    await this.table.put(id, { ...rec, embedding: Object.freeze([...embedding]), embeddingAt: now })
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
   * 按需召回：BM25 + 同义词膨胀 + 强度 + 新鲜度，工作区 = 当前会话 cwd 或全局 `*`。
   * 与 rankedForInjection 不同：不过滤 90 天老化（相关就召回），但仍用新鲜度加权。
   * 空 query 返回空（按需 = 无问不召回），避免广播噪音。query 按 token 分词后累加评分，
   * 解决「systemd 怎么配」这类长句中只有部分词命中的召回问题。
   * 同义词膨胀：本地表常驻（无 Key 也可用）；有 DEEPSEEK_API_KEY 时后续可叠加远端 embedding/LLM 膨胀，双保险。
   * @param workspace - 当前会话 cwd；`*` 时只取全局记忆。
   * @param query - 当前用户问题的原文（大小写不敏感）。
   * @param limit - 候选上限。
   * @param now - 时间基准。
   */
  searchForRecall(workspace: string, query: string, limit: number, now: number = Date.now()): SearchHit[] {
    const baseTokens = tokenizeForRecall(query)
    if (baseTokens.length === 0) return []
    // 本地同义词膨胀（无 Key 也生效的双保险；有 Key 时远端路径会在 recall.ts 再叠加）
    const tokens = expandWithLocalSynonyms(baseTokens)
    // 先收集候选池（工作区过滤）
    const candidates: MemoryRecord[] = []
    for (const [, record] of this.table.entries()) {
      if (record.deletedAt !== undefined) continue
      if (record.workspace !== workspace && record.workspace !== GLOBAL_WORKSPACE) continue
      candidates.push(record)
    }
    if (candidates.length === 0) return []
    // BM25 准备：DF 与平均场长
    const df = new Map<string, number>()
    for (const tok of tokens) {
      let c = 0
      for (const rec of candidates) if (keywordScore(rec, tok) > 0) c += 1
      df.set(tok, c)
    }
    const N = candidates.length
    const idf = new Map<string, number>()
    for (const tok of tokens) {
      const f = df.get(tok) ?? 0
      // BM25 IDF 平滑：log((N - df +0.5)/(df+0.5)+1)
      idf.set(tok, Math.log((N - f + 0.5) / (f + 0.5) + 1))
    }
    let totalLen = 0
    const fieldLen = new Map<string, number>()
    for (const rec of candidates) {
      const len = rec.content.length + rec.tags.join(' ').length
      fieldLen.set(rec.id, len)
      totalLen += len
    }
    const avgLen = totalLen / Math.max(1, candidates.length)
    const k1 = 1.2
    const b = 0.75
    const hits: SearchHit[] = []
    for (const record of candidates) {
      let bm25 = 0
      const len = fieldLen.get(record.id) ?? record.content.length
      for (const tok of tokens) {
        const tfRaw = keywordScore(record, tok)
        if (tfRaw === 0) continue
        // TF 归一：keywordScore 已含 tag 权重，这里当 TF 用
        const tf = tfRaw
        const curIdf = idf.get(tok) ?? 0
        const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * (len / Math.max(1, avgLen))))
        bm25 += curIdf * norm
      }
      if (bm25 === 0) continue
      const score = bm25 * (1 + Math.log2(record.strength)) * recencyFactor(record.updatedAt, now)
      hits.push({ record, score })
    }
    hits.sort((a, b) => b.score - a.score || tieBreak(a.record, b.record))
    return hits.slice(0, clampInt(limit, 8, 1, 50))
  }

  /**
   * 按需召回的文本渲染（与 recallText 同格式，但数据源是 query 相关命中）。
   * 无命中返回空串（零贡献，pre-step 不注入）。
   */
  renderRecallText(hits: readonly SearchHit[], maxChars: number): string {
    const cap = Math.max(maxChars, 1)
    const lines: string[] = []
    let used = 0
    for (const { record } of hits) {
      const line = renderLine(record)
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

/** 一行注入文本的渲染（纯函数）。 */
export function renderLine(record: MemoryRecord): string {
  const strength = record.strength > 1 ? ` (x${record.strength})` : ''
  return `- [${record.kind}] ${record.content}${tagSuffix(record.tags)}${strength}`
}