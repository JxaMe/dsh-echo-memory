/**
 * 统一评分模块：BM25/BM25F + 强度 + 新鲜度 + 泛词过滤。
 * 单一真相：store / tools / recall 三处 previously 各写一遍 BM25，已收敛至此。
 * @module dsh-echo-memory/scoring
 */

import type { MemoryRecord } from './domain.js'

/** 召回期窗口：超过 90 天未更新的记忆，新鲜度因子下限 0.1。 */
export const FRESH_WINDOW_MS = 90 * 24 * 60 * 60 * 1000

/** BM25 超参（与现有行为一致，保持可复现）。 */
export const BM25_K1 = 1.2

/** BM25F 字段权重（v1）：标题 > 标签 > 正文 */
export const BM25F_W_TITLE = 2.5
export const BM25F_W_BODY = 1.0
export const BM25F_W_TAGS = 3.0
/** BM25F 字段长度归一化系数（标题短，归一轻；标签极短，不归一） */
export const BM25F_B_TITLE = 0.3
export const BM25F_B_BODY = 0.75
export const BM25F_B_TAGS = 0

// 中文分词：优先用 segment，失败回退 2-gram
// @ts-ignore no types for segment
import Segment from 'segment'
let segment: InstanceType<typeof Segment> | null = null
try {
  const seg = new Segment()
  seg.useDefault()
  // 补自定义词（项目高频词，默认词库未收）
  const customs = ['本机', '回音象', '原点', '召回', '召回历史', '拖选', '分层', '落盘', '部署', '前端', '后端', '存储', '重启', '上线', '发布', '系统', '信息']
  for (const w of customs) {
    const lower = w.toLowerCase()
    const dict: Record<string, unknown> = (seg as unknown as { DICT: { TABLE: Record<string, unknown>; TABLE2: Record<number, Record<string, unknown>> } }).DICT as unknown as Record<string, unknown> as never
    const table = (dict as unknown as { TABLE: Record<string, unknown> }).TABLE
    const table2 = (dict as unknown as { TABLE2: Record<number, Record<string, unknown>> }).TABLE2
    if (table) {
      table[lower] = { p: 1048576, f: 1000 } as unknown as { p: number; f: number }
      table[w] = { p: 1048576, f: 1000 } as unknown as { p: number; f: number }
    }
    const len = w.length
    if (table2) {
      if (!table2[len]) table2[len] = {}
      table2[len][lower] = { p: 1048576, f: 1000 } as unknown as { p: number; f: number }
      table2[len][w] = { p: 1048576, f: 1000 } as unknown as { p: number; f: number }
    }
  }
  segment = seg
} catch { segment = null }

export type Tokenizer = (text: string) => string[]
let overrideTokenizer: Tokenizer | null = null
/** @internal 仅测试用：注入假分词器，传 null 恢复默认 */
export function __setTokenizerForTest(fn: Tokenizer | null): void { overrideTokenizer = fn }
function segmentTokenize(text: string): string[] {
  if (overrideTokenizer) return overrideTokenizer(text)
  if (segment) {
    try { return segment.doSegment(text, { simple: true }) as unknown as string[] } catch { return [] }
  }
  return []
}

/** 停用词：命中不计分，避免“的/了/为什么”这种虚词拉分 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  '的', '了', '吗', '啊', '呢', '吧', '在', '是', '有', '和', '与', '又', '也', '就', '都', '还',
  '为什么', '怎么', '什么', '完全', '无关', '这个', '那个', '这样', '那样', '一些', '一下',
  '我', '你', '他', '她', '它', '我们', '你们', '他们',
  '会', '能', '要', '想', '去', '来', '说',
])

/** 元问题正则：问“为什么召回”这类不该召回（扩展覆盖怎么/原理/如何） */
export const META_QUERY_RE = /(为什么.*召回|召回.*为什么|怎么.*召回|召回.*怎么|如何.*召回|召回.*如何|相关记忆|触发召回|召回原理)/

export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  const truncated = Number.isFinite(value) ? Math.trunc(value) : fallback
  if (truncated < min) return min
  if (truncated > max) return max
  return truncated
}

/** 新鲜度因子：1（刚更新）→ 0.1（90 天后），线性衰减。 */
export function recencyFactor(updatedAt: number, now: number): number {
  const ageMs = Math.max(0, now - updatedAt)
  return Math.max(0.1, 1 - (ageMs / FRESH_WINDOW_MS) * 0.9)
}

/** 排序兜底：主键同分时按 updatedAt 降序、id 升序（search 与注入共用）。 */
export function tieBreak(a: MemoryRecord, b: MemoryRecord): number {
  return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** 关键词评分：标签精确 +8/个、标签前缀（≥2 字符）+4/个（精确不重复计前缀）、正文子串 +2/次（上限 5 次）；无匹配返回 0。 */
export function keywordScore(record: MemoryRecord, query: string): number {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return 1
  let score = 0
  if (record.tags.includes(q)) score += 8
  if (q.length >= 2) {
    for (const tag of record.tags) {
      if (tag !== q && tag.startsWith(q)) score += 4
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
export const LOCAL_SYNONYMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
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
})

/** 按需召回的 query 分词：优先 jieba/segment，失败回退 2-gram */
export function tokenizeForRecall(query: string): string[] {
  const trimmed = query.trim().toLowerCase()
  if (trimmed.length === 0) return []
  const raw = trimmed.match(/[\u4e00-\u9fa5]+|[a-z0-9]+/gi) ?? []
  const seen = new Set<string>()
  const tokens: string[] = []
  const add = (t: string): void => {
    if (t.length < 2 || seen.has(t) || tokens.length >= 20) return
    seen.add(t)
    tokens.push(t)
  }
  for (const tok of raw) {
    const t = tok.toLowerCase()
    if (t.length < 2 || seen.has(t)) continue
    if (/^[\u4e00-\u9fa5]+$/.test(t)) {
      const segs = segmentTokenize(t)
      if (segs.length > 0) {
        for (const w of segs) {
          const lw = String(w).toLowerCase().trim()
          if (lw.length < 2 || seen.has(lw)) continue
          if (/^[，。！？、；：:,\.\s\u3000]+$/.test(lw)) continue
          add(lw)
        }
        if (t.length > 2 && t.length <= 12) add(t)
      } else {
        add(t)
        if (t.length > 2) {
          for (let i = 0; i < t.length - 1; i++) add(t.slice(i, i + 2))
        }
      }
    } else {
      add(t)
    }
    if (tokens.length >= 20) break
  }
  // 额外扫描已知词表做子串命中（解决“发布怎么弄”这类未被切出的同义词）
  for (const key of Object.keys(LOCAL_SYNONYMS)) {
    const lower = key.toLowerCase()
    if (seen.has(lower)) continue
    if (trimmed.includes(lower)) add(lower)
    if (tokens.length >= 20) break
  }
  return tokens
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

/** 是否为元问题（问召回本身，不该召回） */
export function isMetaQuery(query: string): boolean {
  return META_QUERY_RE.test(query.trim().toLowerCase())
}

/** 过滤停用词后的有效 token（保持顺序） */
export function filterStopwords(tokens: readonly string[]): string[] {
  return tokens.filter(t => !STOPWORDS.has(t))
}

/** 泛词过滤：低分时只留与最高分近乎相同的命中，避免 Ubuntu 这类泛词一次带回俩；高分时按 0.6 相对阈值。v1 阈值从 0.12 提到 0.25，过滤幽灵命中。 */
export function filterRecallHits<T extends { readonly score: number }>(hits: readonly T[]): readonly T[] {
  if (hits.length <= 1) return hits
  const max = hits[0]!.score
  if (max < 0.01) return []
  if (max < 0.35) {
    return hits.filter(h => h.score >= max * 0.95)
  }
  return hits.filter(h => h.score >= max * 0.6 && h.score >= 0.25)
}

export interface ScoredHit {
  readonly record: MemoryRecord
  readonly score: number
}

// ————— BM25F v1 —————

function splitTitleRaw(content: string): { title: string; body: string } {
  const raw = content.trim()
  const colon = raw.search(/[:：]/)
  if (colon > 0 && colon < 24) return { title: raw.slice(0, colon).trim(), body: raw.slice(colon + 1).replace(/^[:：\s]+/, '').trim() }
  const comma = raw.search(/[，,]/)
  if (comma > 0 && comma < 24) return { title: raw.slice(0, comma).trim(), body: raw.slice(comma + 1).trim() }
  if (raw.length <= 20) return { title: raw, body: '' }
  return { title: '', body: raw }
}

function countOccurrences(text: string, token: string): number {
  if (token.length === 0) return 0
  let c = 0
  let idx = text.indexOf(token)
  while (idx !== -1 && c < 5) {
    c += 1
    idx = text.indexOf(token, idx + token.length)
  }
  return c
}

function buildBM25FFieldLenMap(candidates: readonly MemoryRecord[]): {
  titleLen: Map<string, number>; bodyLen: Map<string, number>; tagsLen: Map<string, number>;
  avgTitleLen: number; avgBodyLen: number; avgTagsLen: number
} {
  let totalTitle = 0, totalBody = 0, totalTags = 0
  const titleLen = new Map<string, number>()
  const bodyLen = new Map<string, number>()
  const tagsLen = new Map<string, number>()
  for (const rec of candidates) {
    const { title, body } = splitTitleRaw(rec.content)
    const tl = title.length, bl = body.length, gl = rec.tags.join(' ').length
    titleLen.set(rec.id, tl); bodyLen.set(rec.id, bl); tagsLen.set(rec.id, gl)
    totalTitle += tl; totalBody += bl; totalTags += gl
  }
  const n = Math.max(1, candidates.length)
  return { titleLen, bodyLen, tagsLen, avgTitleLen: totalTitle / n || 1, avgBodyLen: totalBody / n || 1, avgTagsLen: totalTags / n || 1 }
}

function buildBM25FIdfMap(tokens: readonly string[], candidates: readonly MemoryRecord[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const tok of tokens) {
    let c = 0
    for (const rec of candidates) {
      const { title, body } = splitTitleRaw(rec.content)
      const lowerTitle = title.toLowerCase(), lowerBody = body.toLowerCase(), lowerTags = rec.tags.join(' ').toLowerCase()
      const hit = lowerTitle.includes(tok) || lowerBody.includes(tok) || lowerTags.includes(tok) || rec.tags.some(t => t === tok || t.startsWith(tok))
      if (hit) c += 1
    }
    df.set(tok, c)
  }
  const N = candidates.length
  const idf = new Map<string, number>()
  for (const tok of tokens) {
    const f = df.get(tok) ?? 0
    idf.set(tok, Math.log((N - f + 0.5) / (f + 0.5) + 1))
  }
  return idf
}

function bm25FForRecord(
  record: MemoryRecord,
  tokens: readonly string[],
  idf: ReadonlyMap<string, number>,
  fieldLens: ReturnType<typeof buildBM25FFieldLenMap>,
): number {
  const { title, body } = splitTitleRaw(record.content)
  const lowerTitle = title.toLowerCase()
  const lowerBody = body.toLowerCase()
  const lowerTagsText = record.tags.join(' ').toLowerCase()
  const tl = fieldLens.titleLen.get(record.id) ?? title.length
  const bl = fieldLens.bodyLen.get(record.id) ?? body.length
  const gl = fieldLens.tagsLen.get(record.id) ?? lowerTagsText.length
  let sum = 0
  for (const tok of tokens) {
    const curIdf = idf.get(tok) ?? 0
    if (curIdf === 0) continue
    // per-field TF
    let tfTitle = 0, tfBody = 0, tfTags = 0
    // title/body: substring count
    tfTitle = countOccurrences(lowerTitle, tok)
    tfBody = countOccurrences(lowerBody, tok)
    // tags: exact/prefix counts (tags are already lower)
    if (record.tags.includes(tok)) tfTags += 1
    // prefix matches (≥2 chars)
    if (tok.length >= 2) {
      for (const tag of record.tags) if (tag.startsWith(tok) && tag !== tok) tfTags += 0.5
    }
    // also substring in tags text
    const tagOcc = countOccurrences(lowerTagsText, tok)
    if (tagOcc > 0) tfTags = Math.max(tfTags, tagOcc * 0.5)

    if (tfTitle === 0 && tfBody === 0 && tfTags === 0) continue

    const normTitle = tl === 0 ? 0 : tfTitle / (1 - BM25F_B_TITLE + BM25F_B_TITLE * (tl / Math.max(1, fieldLens.avgTitleLen)))
    const normBody = bl === 0 ? 0 : tfBody / (1 - BM25F_B_BODY + BM25F_B_BODY * (bl / Math.max(1, fieldLens.avgBodyLen)))
    const normTags = gl === 0 ? tfTags : tfTags / (1 - BM25F_B_TAGS + BM25F_B_TAGS * (gl / Math.max(1, fieldLens.avgTagsLen)))

    const tildeTf = BM25F_W_TITLE * normTitle + BM25F_W_BODY * normBody + BM25F_W_TAGS * normTags
    if (tildeTf === 0) continue
    sum += curIdf * ((tildeTf * (BM25_K1 + 1)) / (tildeTf + BM25_K1))
  }
  return sum
}

/** 召回一站式：分词→同义词→BM25F→过滤，调用方只需给 candidates+query */
export function searchRecall(
  candidates: readonly MemoryRecord[],
  query: string,
  now: number,
  limit: number = 8,
): ScoredHit[] {
  if (isMetaQuery(query)) return []
  const base = tokenizeForRecall(query)
  if (base.length === 0) return []
  const tokens = expandWithLocalSynonyms(base)
  const hits = scoreBM25F(candidates, tokens, now)
  return filterRecallHits(hits).slice(0, clampInt(limit, 8, 1, 50))
}

/**
 * BM25F 评分（v1）：字段加权 + 全局 IDF + 停用词已在外层过滤
 * 调用方需已做停用词过滤与同义词膨胀
 */
export function scoreBM25F(
  candidates: readonly MemoryRecord[],
  tokens: readonly string[],
  now: number,
): ScoredHit[] {
  const effective = filterStopwords(tokens)
  if (candidates.length === 0 || effective.length === 0) return []
  // 单 token 允许召回：稀有词（如 systemd）单 token 也应命中，泛词由阈值与停用词过滤
  const idf = buildBM25FIdfMap(effective, candidates)
  const fieldLens = buildBM25FFieldLenMap(candidates)
  const hits: ScoredHit[] = []
  for (const record of candidates) {
    const bm25f = bm25FForRecord(record, effective, idf, fieldLens)
    if (bm25f === 0) continue
    const score = bm25f * (1 + Math.log2(record.strength)) * recencyFactor(record.updatedAt, now)
    hits.push({ record, score })
  }
  hits.sort((a, b) => b.score - a.score || tieBreak(a.record, b.record))
  return hits
}

