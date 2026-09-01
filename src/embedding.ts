/**
 * 远端 embedding 服务：有 DEEPSEEK_API_KEY 时走远端，失败/无 Key 回退到本地 BM25。
 * @module dsh-echo-memory/embedding
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hasDeepSeekKey as hasKeySync } from './store.js'

const EMBED_MODEL = 'deepseek-embedding'
const EMBED_URL = 'https://api.deepseek.com/v1/embeddings'
const CACHE_MAX = 200
const cache = new Map<string, readonly number[]>()

/** 从 env 或 ~/.dsh/.credentials.yaml 读取 DeepSeek Key（与 harness 凭证一致）。 */
export async function resolveDeepSeekKey(): Promise<string | undefined> {
  const env = process.env.DEEPSEEK_API_KEY?.trim()
  if (env) return env
  try {
    const raw = await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const m = raw.match(/DEEPSEEK_API_KEY:\s*([^\s#]+)/)
    if (m?.[1]) return m[1].trim()
  } catch { /* ignore */ }
  return undefined
}

export function hasDeepSeekKeySync(): boolean {
  return hasKeySync()
}

/** 同步快检（启动时用），真正的异步检查用 resolveDeepSeekKey。 */
export function hasDeepSeekKey(): boolean {
  return hasKeySync()
}

export { clearHasKeyCache } from './store.js'

/** 余弦相似度（-1..1）。 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const av = a[i]!
    const bv = b[i]!
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 单条 embedding，带内存缓存。 */
export async function embed(text: string): Promise<readonly number[]> {
  const key = text.trim()
  if (key.length === 0) throw new Error('empty text')
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const apiKey = await resolveDeepSeekKey()
  if (!apiKey) throw new Error('no DEEPSEEK_API_KEY')
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: key }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`embedding failed ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json() as { data?: Array<{ embedding?: number[] }>; embedding?: number[] }
  const vec = data.data?.[0]?.embedding ?? (data as { embedding?: number[] }).embedding
  if (!Array.isArray(vec) || vec.length === 0) throw new Error('invalid embedding response')
  const frozen = Object.freeze([...vec])
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value as string | undefined
    if (first !== undefined) cache.delete(first)
  }
  cache.set(key, frozen)
  return frozen
}

/** 批量 embed（迁移回填用，逐条串行避免限流）。 */
export async function embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
  const out: (readonly number[])[] = []
  for (const t of texts) out.push(await embed(t))
  return out
}
