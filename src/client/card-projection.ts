/**
 * 卡片状态投影：从草稿 + 三层设置值（schema默认 < base < 用户）计算字段渲染状态。
 * 纯函数、无 I/O——暂存表单行为可单测；controller 只负责状态变更，投影全在此处。
 * @module dsh-echo-memory/client/card-projection
 */

import type { DeletionMode } from '../settings.ts'
import type { MemorySettings } from '../settings.ts'
import type {
  MemoryActionFeedback,
  MemoryCardBooleanField,
  MemoryCardBooleanState,
  MemoryCardChoiceField,
  MemoryCardChoiceState,
  MemoryCardField,
  MemoryCardFieldState,
  MemoryCardState,
  MemoryCardTextField,
  MemoryPurgeState,
  MemoryStatsState,
  RecycleState,
} from './card-controller.ts'
import {
  booleanDraft,
  numberDraft,
  parseNumberField,
  type FieldWrite,
} from './card-util.ts'

/** 一条暂存编辑。 */
export type StagedEdit =
  | { kind: 'text'; text: string }
  | { kind: 'bool'; checked: boolean }
  | { kind: 'choice'; value: DeletionMode }
  | { kind: 'clear' }

/** 投影输入：草稿 + 三层设置快照 + 瞬时标志（由 controller 从快照收集）。 */
export interface ProjectionInput {
  drafts: ReadonlyMap<MemoryCardField, StagedEdit>
  values: MemorySettings | undefined
  base: Readonly<Record<string, unknown>> | undefined
  user: Readonly<Record<string, unknown>> | undefined
  available: boolean
  writable: boolean
  saving: boolean
  failed: boolean
  justSaved: boolean
  purge: MemoryPurgeState
  recycle: RecycleState
  stats: MemoryStatsState
  actionFeedback: MemoryActionFeedback
}

/** 文本字段的解析/格式化分派表：新增文本字段只改这一处（布尔字段无文本草稿）。 */
const textFieldCodecs: Record<MemoryCardTextField, {
  parse(text: string): FieldWrite | undefined
  format(value: unknown): string
}> = {
  injectLimit: { parse: parseNumberField, format: numberDraft },
  injectMaxChars: { parse: parseNumberField, format: numberDraft },
}

/** 文本字段：草稿 → 写入计划（undefined = 非法；布尔/选项字段永不进入文本解析）。写路径（save）与投影共享。 */
export function parseField(field: MemoryCardField, text: string): FieldWrite | undefined {
  if (field === 'injectEnabled' || field === 'deletionMode') return undefined
  return textFieldCodecs[field].parse(text)
}

/** 文本字段：存储值 → 草稿文本。 */
function formatField(field: MemoryCardTextField, value: unknown): string {
  return textFieldCodecs[field].format(value)
}

/** 窄化记录值（base/user 层）。 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 选项字段：存储值 → 控件值（未知值回落默认 `tombstone`，与新装缺省一致）。 */
function choiceDraft(value: unknown): DeletionMode {
  return value === 'purge' ? 'purge' : 'tombstone'
}

/** 从草稿 + 三层值计算卡片渲染状态（纯函数）。 */
export function projectCardState(input: ProjectionInput): MemoryCardState {
  let invalid = false
  for (const [field, edit] of input.drafts) {
    if (edit.kind !== 'text') continue
    if (parseField(field, edit.text) === undefined) invalid = true
  }
  return {
    available: input.available,
    writable: input.writable,
    dirty: input.drafts.size > 0,
    invalid,
    saving: input.saving,
    failed: input.failed,
    justSaved: input.justSaved,
    injectEnabled: booleanState(input, 'injectEnabled'),
    injectLimit: textState(input, 'injectLimit'),
    injectMaxChars: textState(input, 'injectMaxChars'),
    deletionMode: choiceState(input, 'deletionMode'),
    purge: input.purge,
    recycle: input.recycle,
    stats: input.stats,
    actionFeedback: input.actionFeedback,
  }
}

function textState(input: ProjectionInput, field: MemoryCardTextField): MemoryCardFieldState {
  const edit = input.drafts.get(field)
  if (edit !== undefined && edit.kind === 'text') {
    const write = parseField(field, edit.text)
    return {
      text: edit.text,
      overridden: write !== undefined,
      invalid: write === undefined,
    }
  }
  if (edit !== undefined && edit.kind === 'clear') {
    // 清除草稿：渲染回落基准值（组合层优先），预览「重置」结果。
    return { text: formatField(field, fallbackValue(input, field)), overridden: false, invalid: false }
  }
  return {
    text: formatField(field, input.values?.[field]),
    overridden: isOverridden(input, field),
    invalid: false,
  }
}

function booleanState(input: ProjectionInput, field: MemoryCardBooleanField): MemoryCardBooleanState {
  const edit = input.drafts.get(field)
  if (edit !== undefined && edit.kind === 'bool') {
    return { checked: edit.checked, overridden: true }
  }
  if (edit !== undefined && edit.kind === 'clear') {
    return { checked: booleanDraft(fallbackValue(input, field)), overridden: false }
  }
  return {
    checked: booleanDraft(input.values?.[field]),
    overridden: isOverridden(input, field),
  }
}

function choiceState(input: ProjectionInput, field: MemoryCardChoiceField): MemoryCardChoiceState {
  const edit = input.drafts.get(field)
  if (edit !== undefined && edit.kind === 'choice') {
    return { value: edit.value, overridden: true }
  }
  if (edit !== undefined && edit.kind === 'clear') {
    return { value: choiceDraft(fallbackValue(input, field)), overridden: false }
  }
  return {
    value: choiceDraft(input.values?.[field]),
    overridden: isOverridden(input, field),
  }
}

/** 清除草稿时的回落值：组合层 base 优先，其次当前有效值。 */
function fallbackValue(input: ProjectionInput, field: MemoryCardField): unknown {
  if (input.base !== undefined && Object.prototype.hasOwnProperty.call(input.base, field)) {
    return input.base[field]
  }
  return input.values?.[field]
}

function isOverridden(input: ProjectionInput, field: MemoryCardField): boolean {
  return input.user !== undefined && Object.prototype.hasOwnProperty.call(input.user, field)
}

export { isRecord }
