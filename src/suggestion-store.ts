/**
 * 待确认建议队列（Host 侧内存，不持久化）：AI 调 memory_suggest 后进队列，Dock 轮询展示，用户确认后真存。
 * @module dsh-echo-memory/suggestion-store
 */

import type { MemoryKind } from './domain.js'

export interface SuggestionEntry {
  readonly id: string
  readonly content: string
  readonly kind?: MemoryKind | undefined
  readonly tags?: readonly string[] | undefined
  readonly workspace: string
  readonly at: number
}

export const SUGGESTION_MAX = 5

export class SuggestionStore {
  private items: SuggestionEntry[] = []
  private seq = 0

  list(): SuggestionEntry[] {
    return [...this.items]
  }

  add(
    input: string | { content: string; kind?: MemoryKind | undefined; tags?: readonly string[] | undefined; workspace?: string | undefined },
    now: number = Date.now(),
  ): SuggestionEntry {
    const raw = typeof input === 'string' ? input : input.content
    const trimmed = raw.trim()
    if (trimmed.length === 0) throw new TypeError('suggestion content must not be empty')
    const workspace = typeof input === 'string' ? '*' : (input.workspace?.trim() || '*')
    // 去重：同内容同工作区已在队列则不重复入队
    const dup = this.items.find((e) => e.content === trimmed.slice(0, 500) && e.workspace === workspace)
    if (dup) return dup
    const id = `sug-${now}-${this.seq++}`
    const entry: SuggestionEntry = {
      id,
      content: trimmed.slice(0, 500),
      kind: typeof input === 'string' ? undefined : input.kind,
      tags: typeof input === 'string' ? undefined : input.tags,
      workspace,
      at: now,
    }
    this.items.unshift(entry)
    if (this.items.length > SUGGESTION_MAX) this.items.length = SUGGESTION_MAX
    return entry
  }

  dismiss(id: string): boolean {
    const idx = this.items.findIndex((e) => e.id === id)
    if (idx === -1) return false
    this.items.splice(idx, 1)
    return true
  }
}
