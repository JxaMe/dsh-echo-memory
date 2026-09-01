/**
 * @deprecated 远端 embedding 已下掉，保留兼容存根（后续再规划）。
 * 所有导出保留签名但不再发起网络请求。
 * @module dsh-echo-memory/embedding
 */

export async function resolveDeepSeekKey(): Promise<string | undefined> {
  return undefined
}

export function hasDeepSeekKeySync(): boolean {
  return false
}

export function hasDeepSeekKey(): boolean {
  return false
}

export { clearHasKeyCache } from './store.js'

/** 余弦相似度（保留纯函数，本地可用）。 */
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

/** @deprecated 已下掉，调用直接抛错由上层回退到 BM25 */
export async function embed(_text: string): Promise<readonly number[]> {
  throw new Error('embedding disabled')
}

/** @deprecated 已下掉 */
export async function embedBatch(_texts: readonly string[]): Promise<readonly (readonly number[])[]> {
  throw new Error('embedding disabled')
}
