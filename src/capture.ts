/**
 * 自动捕获：监听 `session/event` 的 `user/message`，按显式「记住」句式落库。
 * 只采用确定性规则（不调 LLM、不产生 Token 开销），句式与上限全部可配置。
 * 配置每次事件现读（设置面板变更即时生效）。
 * @module dsh-echo-memory/capture
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { GLOBAL_WORKSPACE } from './domain.js'
import type { MemoryStore } from './store.js'

/** 自动捕获配置（来自记忆设置源的既定子集，每次事件现读）。 */
export interface CaptureConfig {
  /** 是否启用自动捕获（面板关闭时监听器直接放行）。 */
  readonly enabled: boolean
  /** 触发捕获的句式列表（大小写不敏感的子串匹配，按出现顺序取第一个命中）。 */
  readonly patterns: readonly string[]
  /** 每个运行期会话 id 的自动捕获条数上限。 */
  readonly maxPerSession: number
}

/** 捕获成功后的确认条目（供提示词注入转述给用户，一次消费）。 */
export interface CaptureFeedEntry {
  /** 捕获发生的会话 id（确认只回显给同一会话）。 */
  readonly sessionId: string
  /** 已落库的记忆正文。 */
  readonly content: string
}

/**
 * 捕获确认缓冲：捕获保存**成功**后才入队；提示词组装时按会话取出
 * （take = 消费），保证「确认 = 真存上了」且只转述一次。
 * 带 10 分钟 TTL：若会话永不再组装，条目自动过期，避免内存泄漏。
 */
export class CaptureFeed {
  private readonly entries: Array<CaptureFeedEntry & { readonly at: number }> = []
  private static readonly TTL_MS = 10 * 60 * 1000

  /** 记一条已落库的捕获；保存失败不得入队（由调用方在 resolve 后调）。 */
  push(entry: CaptureFeedEntry): void {
    this.expire()
    this.entries.push({ ...entry, at: Date.now() })
  }

  /** 取出并消费指定会话的全部待确认条目（无则空数组）。 */
  take(sessionId: string): CaptureFeedEntry[] {
    this.expire()
    const taken = this.entries.filter(entry => entry.sessionId === sessionId)
    if (taken.length === 0) return taken
    const rest = this.entries.filter(entry => entry.sessionId !== sessionId)
    this.entries.length = 0
    this.entries.push(...rest)
    return taken.map(({ sessionId: sid, content }) => ({ sessionId: sid, content }))
  }

  private expire(): void {
    const now = Date.now()
    const cutoff = now - CaptureFeed.TTL_MS
    // 惰性清理：超过 TTL 的条目丢弃
    let write = 0
    for (let read = 0; read < this.entries.length; read++) {
      const e = this.entries[read]!
      if (e.at >= cutoff) {
        this.entries[write++] = e
      }
    }
    if (write < this.entries.length) this.entries.length = write
  }
}

/**
 * 构造捕获监听器。返回的 handler 可能抛错（store 未就绪等），
 * 由注册方用 `ctx.on` 挂载；内部捕获保存失败仅告警，不打断事件流。
 * @param config - 每次事件现读的捕获配置（面板变更即时生效）。
 * @param store - 已就绪的仓储。
 * @param feed - 捕获确认缓冲：保存成功后才入队（失败不报「已记住」）。
 */
export function createCaptureHandler(
  config: () => CaptureConfig,
  store: MemoryStore,
  feed: CaptureFeed,
): (session: Session, event: SessionEvent) => void {
  const counts = new Map<string, number>()
  const lastSeen = new Map<string, number>()
  const SESSION_TTL_MS = 60 * 60 * 1000 // 1h 未活跃的会话计数自动清理
  const MAX_SESSIONS = 500
  function gcCounts(): void {
    if (counts.size < MAX_SESSIONS) return
    const now = Date.now()
    for (const [sid, at] of lastSeen) {
      if (now - at > SESSION_TTL_MS) {
        counts.delete(sid)
        lastSeen.delete(sid)
      }
    }
    // 若仍超限，按最旧的淘汰
    if (counts.size >= MAX_SESSIONS) {
      const oldest = [...lastSeen.entries()].sort((a, b) => a[1] - b[1]).slice(0, counts.size - MAX_SESSIONS + 1)
      for (const [sid] of oldest) {
        counts.delete(sid)
        lastSeen.delete(sid)
      }
    }
  }
  return (session, event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
    const text = event.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    if (text.trim().length === 0) return
    const cfg = config()
    if (!cfg.enabled) return
    const patterns = cfg.patterns
      .map(pattern => pattern.trim().toLowerCase())
      .filter(pattern => pattern.length > 0)
    const normalized = text.toLowerCase()
    let bestPattern: string | undefined
    let bestIndex = Infinity
    for (const pattern of patterns) {
      const idx = normalized.indexOf(pattern)
      if (idx !== -1 && idx < bestIndex) {
        bestIndex = idx
        bestPattern = pattern
      }
    }
    if (bestPattern === undefined) return
    const pattern = bestPattern
    const index = bestIndex
    const sessionKey = session.header.id
    lastSeen.set(sessionKey, Date.now())
    gcCounts()
    const used = counts.get(sessionKey) ?? 0
    if (used >= cfg.maxPerSession) return
    const claimed = text.slice(index + pattern.length).replace(/^[:：,，。.\s]+/, '').trim()
    if (claimed.length === 0) return
    if (claimed.length < 2 || claimed.toLowerCase() === pattern) return
    const content = claimed
    if (content.length < 2) return
    counts.set(sessionKey, used + 1) // 校验通过后才占额
    const workspace = session.header.cwd ?? GLOBAL_WORKSPACE
    void store.save({ workspace, content, kind: 'fact', source: 'auto', tags: [] })
      .then(() => {
        // 确认 = 真存上了：resolve 后才进缓冲（失败不报「已记住」）。
        feed.push({ sessionId: sessionKey, content })
      })
      .catch(error => {
        // 保存失败：回滚到占额前的值，失败不消耗会话额度
        counts.set(sessionKey, used)
        console.warn('[dsh-echo-memory] auto capture failed; message skipped', error)
      })
  }
}