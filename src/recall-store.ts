/**
 * 召回记录（Host 侧）：latest + history 的有界缓冲。
 * Client 侧 Adapter（轮询 / 未来 SSE）都可基于此接口，缝隙单一。
 * @module dsh-echo-memory/recall-store
 */

export interface RecallEntry {
  readonly at: number
  readonly query: string
  readonly hits: Array<{ id: string; kind: string; content: string; tags: readonly string[]; strength: number }>
}

export const RECALL_HISTORY_MAX = 20

/** 召回记录缓冲：单一真相，Ring 式裁剪。 */
export class RecallStore {
  private latest: RecallEntry | null = null
  private history: RecallEntry[] = []

  /** 最近一次召回（无则 null）。 */
  get last(): RecallEntry | null {
    return this.latest
  }

  /** 历史快照（最新在前）。 */
  list(): RecallEntry[] {
    return [...this.history]
  }

  /** 记一次召回：覆盖 latest，历史头插并裁剪到上限。 */
  record(entry: RecallEntry): void {
    this.latest = entry
    this.history.unshift(entry)
    if (this.history.length > RECALL_HISTORY_MAX) this.history.length = RECALL_HISTORY_MAX
  }
}
