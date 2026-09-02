/**
 * 设置卡片的暂存表单控制器：把 `memory` 命名空间的 SettingsScope 桥接到
 * 卡片的快照 store 与动作。设计遵循官方 card-form 的暂存原则——用户输入先入草稿，
 * 只有「保存」才发起持久化写入；「已覆盖」以用户层字段出现与否为准，而非值比较。
 * 实现自包含（官方 card-form 是 ui-settings-plugins 的私有实现，不得跨插件导入）。
 * @module dsh-echo-memory/client/card-controller
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DeletionMode } from '../settings.ts'
import type { MemorySettings } from '../settings.ts'
import { isRecord, parseField, projectCardState, type StagedEdit } from './card-projection.ts'
import type { FieldWrite } from './card-util.ts'

/** 卡片可编辑的字段名。 */
export type MemoryCardField =
  | 'injectEnabled'
  | 'injectLimit'
  | 'injectMaxChars'
  | 'deletionMode'

/** 文本类字段（数字与上限，走草稿文本）。 */
export type MemoryCardTextField = Exclude<MemoryCardField, 'injectEnabled' | 'deletionMode'>

/** 布尔类字段（复选框，草稿即布尔值）。 */
export type MemoryCardBooleanField = 'injectEnabled'

/** 选项类字段（选择控件，草稿即选项值）。 */
export type MemoryCardChoiceField = 'deletionMode'

/** 文本字段控件渲染状态。 */
export interface MemoryCardFieldState {
  /** 草稿文本（无草稿时渲染当前有效值）。 */
  text: string
  /** 保存是否会在用户层留下该字段（草稿编辑自答，预览保存结果）。 */
  overridden: boolean
  /** 草稿不是该字段可接受的值，阻塞保存。 */
  invalid: boolean
}

/** 布尔字段控件渲染状态。 */
export interface MemoryCardBooleanState {
  /** 复选框选中态。 */
  checked: boolean
  /** 保存是否会在用户层留下该字段。 */
  overridden: boolean
}

/** 选项字段控件渲染状态。 */
export interface MemoryCardChoiceState {
  /** 当前选中值。 */
  value: DeletionMode
  /** 保存是否会在用户层留下该字段。 */
  overridden: boolean
}

/** 卡片「彻底删除」动作的瞬时状态。 */
export type MemoryPurgeState =
  | { phase: 'idle' }
  | { phase: 'busy' }
  | { phase: 'done'; purged: number }
  | { phase: 'failed' }

/** 回收站条目（Host /api/dsh-echo-memory/deleted 返回形状）。 */
export interface RecycleItem {
  readonly id: string
  readonly content: string
  readonly kind: string
  readonly workspace: string
  readonly tags: readonly string[]
  readonly strength: number
  readonly deletedAt: number
}

/** 回收站列表瞬时状态。 */
export type RecycleState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'done'; items: readonly RecycleItem[] }
  | { phase: 'failed' }

/** Host 返回的运行期统计载荷（读写两侧自拼类型，不跨半侧值依赖）。 */
export interface MemoryStatsPayload {
  readonly injections: { readonly requests: number; readonly withContent: number }
  readonly memories: number
}

/** 卡片统计区的瞬时状态。 */
export type MemoryStatsState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'done'; data: MemoryStatsPayload }
  | { phase: 'failed' }

/** 回收站单项动作（恢复/彻底删除/编辑）的瞬时反馈；文案键在 locales（controller 不持 i18n）。 */
export type MemoryActionFeedback =
  | { kind: 'ok'; message: 'restored' | 'purgedOne' | 'updated' }
  | { kind: 'error'; message: 'restoreFailed' | 'purgeOneFailed' | 'updateFailed' }
  | null

/** 卡片的完整渲染状态。 */
export interface MemoryCardState {
  /** 命名空间未受服务时卡片不渲染控件。 */
  available: boolean
  /** Host 文档是否接受写入。 */
  writable: boolean
  /** 表单持有保存会产生写入的草稿。 */
  dirty: boolean
  /** 存在非法草稿，阻塞保存。 */
  invalid: boolean
  /** 保存正在跨线。 */
  saving: boolean
  /** 最近一次保存未按草稿落库（下次编辑或保存清除）。 */
  failed: boolean
  /** 刚保存成功，2s 内显示“已保存”轻提示。 */
  justSaved: boolean
  injectEnabled: MemoryCardBooleanState
  injectLimit: MemoryCardFieldState
  injectMaxChars: MemoryCardFieldState
  deletionMode: MemoryCardChoiceState
  /** 「彻底删除」动作反馈（按钮点击后更新）。 */
  purge: MemoryPurgeState
  /** 回收站列表。 */
  recycle: RecycleState
  /** 运行期统计（卡片展开时拉取）。 */
  stats: MemoryStatsState
  /** 回收站单项动作（恢复/彻底删除/编辑）的瞬时反馈，2.5s 后自动清除。 */
  actionFeedback: MemoryActionFeedback
}

/** 注册侧 inject 面：hooks compartment（renderer 绑定 useMemoryCard）+ 表单动作。 */
export interface MemoryCardFace {
  hooks: {
    /** 卡片状态快照（渲染订阅的唯一通道）。 */
    memoryCard: SnapshotStore<MemoryCardState>
  }
  /** 暂存一段文本草稿。 */
  edit: (field: MemoryCardTextField, text: string) => void
  /** 暂存一个布尔草稿。 */
  toggle: (field: MemoryCardBooleanField, checked: boolean) => void
  /** 暂存一个选项草稿。 */
  choose: (field: MemoryCardChoiceField, value: DeletionMode) => void
  /** 暂存清除，保存后字段回落到组合层。 */
  resetField: (field: MemoryCardField) => void
  /** 提交全部草稿；settle 时清空草稿并按 Host 接受值重播种。 */
  save: () => Promise<void>
  /** 丢弃全部草稿。 */
  discard: () => void
  /** 彻底删除所有墓碑记忆（后端 RPC，调用方先确认）。 */
  purgeTombstones: () => Promise<void>
  /** 刷新运行期统计（卡片展开时调用；结果进 state.stats）。 */
  refreshStats: () => void
  /** 刷新回收站列表。 */
  refreshRecycle: () => void
  /** 恢复单条墓碑。 */
  restoreOne: (id: string) => Promise<void>
  /** 单条墓碑彻底删除。 */
  purgeOne: (id: string) => Promise<void>
  /** 更新一条记忆；返回是否成功（调用方据此决定是否退出编辑态）。 */
  updateOne: (id: string, patch: { content?: string }) => Promise<boolean>
}

function initial(): MemoryCardState {
  return {
    available: false,
    writable: false,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
    justSaved: false,
    injectEnabled: { checked: false, overridden: false },
    injectLimit: { text: '', overridden: false, invalid: false },
    injectMaxChars: { text: '', overridden: false, invalid: false },
    deletionMode: { value: 'tombstone', overridden: false },
    purge: { phase: 'idle' },
    recycle: { phase: 'idle' },
    stats: { phase: 'idle' },
    actionFeedback: null,
  }
}

/** 记忆设置控制器：scope → 快照 store + 动作。 */
export class MemoryCardController {
  private readonly store: SnapshotStore<MemoryCardState>
  private readonly drafts = new Map<MemoryCardField, StagedEdit>()
  private values: MemorySettings | undefined
  private base: Readonly<Record<string, unknown>> | undefined
  private user: Readonly<Record<string, unknown>> | undefined
  private saving = false
  private failed = false
  private justSaved = false
  private justSavedTimer: ReturnType<typeof setTimeout> | undefined
  private actionTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param scope - 绑定在 `memory` 命名空间上的设置 scope。
   * @param purgeTombstones - 彻底清除墓碑的后端动作（client 半封装 RPC；controller 保持无 ctx 依赖）。
   * @param loadStats - 拉取运行期统计的后端动作。
   */
  constructor(
    private readonly scope: SettingsScope<MemorySettings>,
    private readonly purgeTombstones: () => Promise<number>,
    private readonly loadStats: () => Promise<MemoryStatsPayload>,
    private readonly loadRecycle: () => Promise<readonly RecycleItem[]> = async () => [],
    private readonly restoreOneFn: (id: string) => Promise<boolean> = async () => false,
    private readonly purgeOneFn: (id: string) => Promise<boolean> = async () => false,
    private readonly updateOneFn: (id: string, patch: { content?: string }) => Promise<boolean> = async () => false,
  ) {
    this.store = createSnapshotStore(initial())
    scope.subscribe(() => this.reseed())
    this.reseed()
  }

  /** 构造卡片插槽注入面。 */
  inject(): MemoryCardFace {
    return {
      hooks: { memoryCard: this.store },
      edit: (field, text) => { this.stageText(field, text) },
      toggle: (field, checked) => { this.stageBool(field, checked) },
      choose: (field, value) => { this.stageChoice(field, value) },
      resetField: field => { this.stageClear(field) },
      save: () => this.save(),
      discard: () => { this.discard() },
      purgeTombstones: () => this.purge(),
      refreshStats: () => { void this.refreshStats() },
      refreshRecycle: () => { void this.refreshRecycle() },
      restoreOne: (id) => this.restoreOne(id),
      purgeOne: (id) => this.purgeOne(id),
      updateOne: (id, patch) => this.updateOne(id, patch),
    }
  }

  private stageText(field: MemoryCardTextField, text: string): void {
    this.drafts.set(field, { kind: 'text', text })
    this.failed = false
    this.clearJustSaved()
    this.emit()
  }

  private stageBool(field: MemoryCardBooleanField, checked: boolean): void {
    this.drafts.set(field, { kind: 'bool', checked })
    this.failed = false
    this.clearJustSaved()
    this.emit()
  }

  private stageChoice(field: MemoryCardChoiceField, value: DeletionMode): void {
    this.drafts.set(field, { kind: 'choice', value })
    this.failed = false
    this.clearJustSaved()
    this.emit()
  }

  private clearJustSaved(): void {
    if (this.justSaved) {
      this.justSaved = false
      if (this.justSavedTimer !== undefined) {
        clearTimeout(this.justSavedTimer)
        this.justSavedTimer = undefined
      }
    }
  }

  /** 执行彻底删除：确认在 UI 侧；结果/失败回投影到卡片。 */
  private async purge(): Promise<void> {
    const current = this.store.getSnapshot()
    if (current.purge.phase === 'busy') return
    this.emitPurge({ phase: 'busy' })
    try {
      const purged = await this.purgeTombstones()
      this.emitPurge({ phase: 'done', purged })
      await this.refreshRecycle()
    } catch (_purgeFailure) {
      this.emitPurge({ phase: 'failed' })
    }
  }

  private emitPurge(state: MemoryPurgeState): void {
    this.store.update((draft) => {
      draft.purge = state
    })
  }

  private async refreshRecycle(): Promise<void> {
    const current = this.store.getSnapshot()
    if (current.recycle.phase === 'loading') return
    this.store.update((draft) => { draft.recycle = { phase: 'loading' } })
    try {
      const items = await this.loadRecycle()
      this.store.update((draft) => { draft.recycle = { phase: 'done', items } })
    } catch {
      this.store.update((draft) => { draft.recycle = { phase: 'failed' } })
    }
  }

  private async restoreOne(id: string): Promise<void> {
    let ok = false
    try { ok = await this.restoreOneFn(id) } catch { ok = false }
    this.setActionFeedback(ok ? { kind: 'ok', message: 'restored' } : { kind: 'error', message: 'restoreFailed' })
    await this.refreshRecycle()
  }

  private async purgeOne(id: string): Promise<void> {
    let ok = false
    try { ok = await this.purgeOneFn(id) } catch { ok = false }
    this.setActionFeedback(ok ? { kind: 'ok', message: 'purgedOne' } : { kind: 'error', message: 'purgeOneFailed' })
    await this.refreshRecycle()
  }

  private async updateOne(id: string, patch: { content?: string }): Promise<boolean> {
    let ok = false
    try { ok = await this.updateOneFn(id, patch) } catch { ok = false }
    this.setActionFeedback(ok ? { kind: 'ok', message: 'updated' } : { kind: 'error', message: 'updateFailed' })
    await this.refreshRecycle()
    return ok
  }

  /** 投影回收站单项动作反馈；2.5s 后自动清除，避免残留。 */
  private setActionFeedback(feedback: NonNullable<MemoryActionFeedback> | null): void {
    if (this.actionTimer !== undefined) {
      clearTimeout(this.actionTimer)
      this.actionTimer = undefined
    }
    this.store.update((draft) => { draft.actionFeedback = feedback })
    if (feedback !== null) {
      this.actionTimer = setTimeout(() => {
        this.actionTimer = undefined
        this.store.update((draft) => { draft.actionFeedback = null })
      }, 2500)
    }
  }

  /** 拉取运行期统计（卡片展开时触发；失败显示失败态，不打断卡片）。 */
  private async refreshStats(): Promise<void> {
    const current = this.store.getSnapshot()
    if (current.stats.phase === 'loading') return
    this.emitStats({ phase: 'loading' })
    try {
      const data = await this.loadStats()
      this.emitStats({ phase: 'done', data })
    } catch (_statsFailure) {
      this.emitStats({ phase: 'failed' })
    }
  }

  private emitStats(state: MemoryStatsState): void {
    this.store.update((draft) => {
      draft.stats = state
    })
  }

  private stageClear(field: MemoryCardField): void {
    this.drafts.set(field, { kind: 'clear' })
    this.failed = false
    this.clearJustSaved()
    this.emit()
  }

  private discard(): void {
    this.drafts.clear()
    this.failed = false
    this.clearJustSaved()
    this.reseed()
  }

  private async save(): Promise<void> {
    const current = this.store.getSnapshot()
    if (!current.writable || current.invalid || this.saving) return
    this.saving = true
    this.emit()
    let ok = true
    try {
      for (const [field, edit] of this.drafts) {
        if (edit.kind === 'bool') {
          await this.scope.set(field, edit.checked)
          continue
        }
        if (edit.kind === 'choice') {
          await this.scope.set(field, edit.value)
          continue
        }
        if (edit.kind === 'clear') {
          await this.scope.unset(field)
          continue
        }
        const write = parseField(field, edit.text)
        if (write === undefined) continue // 非法草稿被保存按钮阻塞；防御性跳过
        if (write.kind === 'clear') await this.scope.unset(field)
        else await this.scope.set(field, write.value)
      }
      this.drafts.clear()
      this.failed = false
    } catch (_writeFailure) {
      this.failed = true
      ok = false
    }
    this.saving = false
    if (ok) {
      this.justSaved = true
      this.emit()
      if (this.justSavedTimer !== undefined) clearTimeout(this.justSavedTimer)
      this.justSavedTimer = setTimeout(() => {
        this.justSaved = false
        this.justSavedTimer = undefined
        this.emit()
      }, 2000)
    }
    this.reseed()
  }

  /** 从 scope 快照重投影渲染状态；保留未提交草稿。 */
  private reseed(): void {
    const snapshot = this.scope.getSnapshot()
    const available = snapshot.status === 'ready' && snapshot.value !== undefined
    this.values = snapshot.value
    this.base = isRecord(snapshot.base) ? snapshot.base : undefined
    this.user = isRecord(snapshot.user) ? snapshot.user : undefined
    this.emit(available, snapshot.writable)
  }

  private emit(availableOverride?: boolean, writableOverride?: boolean): void {
    this.store.update((draft) => {
      const next = this.projection(availableOverride, writableOverride)
      draft.available = next.available
      draft.writable = next.writable
      draft.dirty = next.dirty
      draft.invalid = next.invalid
      draft.saving = next.saving
      draft.failed = next.failed
      draft.injectEnabled = next.injectEnabled
      draft.injectLimit = next.injectLimit
      draft.injectMaxChars = next.injectMaxChars
      draft.deletionMode = next.deletionMode
    })
  }

  private projection(availableOverride?: boolean, writableOverride?: boolean): MemoryCardState {
    const current = this.store.getSnapshot()
    const available = availableOverride ?? current.available
    const writable = writableOverride ?? current.writable
    return projectCardState({
      drafts: this.drafts,
      values: this.values,
      base: this.base,
      user: this.user,
      available,
      writable,
      saving: this.saving,
      failed: this.failed,
      justSaved: this.justSaved,
      purge: current.purge,
      recycle: current.recycle,
      stats: current.stats,
      actionFeedback: current.actionFeedback,
    })
  }
}
