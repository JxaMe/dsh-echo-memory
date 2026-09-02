/**
 * card-projection 纯逻辑测试：草稿 + 三层设置值 → 字段渲染状态。
 * 锁定「暂存 → 字段状态」行为：overridden 按用户层、清除回落 base、非法草稿阻塞、瞬时标志透传。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectCardState, type StagedEdit } from '../src/client/card-projection.ts'
import type { MemoryCardField } from '../src/client/card-controller.ts'
import type { MemorySettings } from '../src/settings.ts'

const BASE: MemorySettings = {
  injectEnabled: true,
  injectLimit: 8,
  injectMaxChars: 1500,
  captureEnabled: true,
  capturePatterns: ['记住：'],
  captureMaxPerSession: 20,
  deletionMode: 'tombstone',
}

interface InputOverrides {
  drafts?: ReadonlyMap<MemoryCardField, StagedEdit>
  values?: MemorySettings
  base?: Readonly<Record<string, unknown>>
  user?: Readonly<Record<string, unknown>>
  available?: boolean
  writable?: boolean
  saving?: boolean
  failed?: boolean
  justSaved?: boolean
  actionFeedback?: { kind: 'ok'; message: 'restored' | 'purgedOne' | 'updated' } | { kind: 'error'; message: 'restoreFailed' | 'purgeOneFailed' | 'updateFailed' } | null
}

function makeInput(overrides: InputOverrides = {}) {
  return {
    drafts: overrides.drafts ?? new Map<MemoryCardField, StagedEdit>(),
    values: overrides.values ?? { ...BASE, injectLimit: 10, captureMaxPerSession: 30 },
    base: overrides.base ?? { injectLimit: 8, injectMaxChars: 1500 },
    user: overrides.user ?? { injectLimit: 10, captureMaxPerSession: 30 },
    available: overrides.available ?? true,
    writable: overrides.writable ?? true,
    saving: overrides.saving ?? false,
    failed: overrides.failed ?? false,
    justSaved: overrides.justSaved ?? false,
    purge: { phase: 'idle' } as const,
    recycle: { phase: 'idle' } as const,
    stats: { phase: 'idle' } as const,
    actionFeedback: overrides.actionFeedback ?? null,
  }
}

test('无草稿：不脏，字段来自 values，overridden 按用户层字段', () => {
  const s = projectCardState(makeInput())
  assert.equal(s.dirty, false)
  assert.equal(s.available, true)
  assert.equal(s.writable, true)
  // user 层覆盖了 injectLimit → overridden
  assert.equal(s.injectLimit.overridden, true)
  assert.equal(s.injectLimit.text, '10')
  // user 层未覆盖 injectMaxChars → 非 overridden，显示 values 值
  assert.equal(s.injectMaxChars.overridden, false)
  assert.equal(s.injectMaxChars.text, '1500')
  // 布尔
  assert.equal(s.injectEnabled.checked, true)
  assert.equal(s.injectEnabled.overridden, false)
  // 选项
  assert.equal(s.deletionMode.value, 'tombstone')
})

test('文本草稿：脏 + 文本进草稿 + overridden 预览', () => {
  const s = projectCardState(makeInput({
    drafts: new Map<MemoryCardField, StagedEdit>([['injectLimit', { kind: 'text', text: '12' }]]),
  }))
  assert.equal(s.dirty, true)
  assert.equal(s.invalid, false)
  assert.equal(s.injectLimit.text, '12')
  assert.equal(s.injectLimit.overridden, true)
})

test('非法文本草稿：invalid=true 阻塞保存', () => {
  const s = projectCardState(makeInput({
    drafts: new Map<MemoryCardField, StagedEdit>([['injectLimit', { kind: 'text', text: 'abc' }]]),
  }))
  assert.equal(s.dirty, true)
  assert.equal(s.invalid, true)
  assert.equal(s.injectLimit.invalid, true)
  assert.equal(s.injectLimit.overridden, false)
})

test('清除草稿：回落组合层 base（base 有值优先于 values）', () => {
  const s = projectCardState(makeInput({
    user: { injectLimit: 10 },
    drafts: new Map<MemoryCardField, StagedEdit>([['injectLimit', { kind: 'clear' }]]),
  }))
  // base.injectLimit = 8（组合层）优先于 values 的 10
  assert.equal(s.injectLimit.text, '8')
  assert.equal(s.injectLimit.overridden, false)
})

test('清除草稿：base 无值则回落 values', () => {
  const s = projectCardState(makeInput({
    base: {},
    drafts: new Map<MemoryCardField, StagedEdit>([['capturePatterns', { kind: 'clear' }]]),
  }))
  assert.equal(s.capturePatterns.text, '记住：')
  assert.equal(s.capturePatterns.overridden, false)
})

test('布尔/选项草稿：直接投影', () => {
  const s = projectCardState(makeInput({
    drafts: new Map<MemoryCardField, StagedEdit>([
      ['captureEnabled', { kind: 'bool', checked: false }],
      ['deletionMode', { kind: 'choice', value: 'purge' }],
    ]),
  }))
  assert.equal(s.captureEnabled.checked, false)
  assert.equal(s.captureEnabled.overridden, true)
  assert.equal(s.deletionMode.value, 'purge')
  assert.equal(s.deletionMode.overridden, true)
})

test('瞬时标志透传：saving/failed/justSaved/available/writable', () => {
  const s = projectCardState(makeInput({ saving: true, failed: true, justSaved: true, available: false, writable: false }))
  assert.equal(s.saving, true)
  assert.equal(s.failed, true)
  assert.equal(s.justSaved, true)
  assert.equal(s.available, false)
  assert.equal(s.writable, false)
})

test('附加状态透传：purge/recycle/stats/actionFeedback', () => {
  const s = projectCardState(makeInput({
    actionFeedback: { kind: 'error', message: 'updateFailed' },
  }))
  assert.deepEqual(s.purge, { phase: 'idle' })
  assert.deepEqual(s.recycle, { phase: 'idle' })
  assert.deepEqual(s.stats, { phase: 'idle' })
  assert.deepEqual(s.actionFeedback, { kind: 'error', message: 'updateFailed' })
})
