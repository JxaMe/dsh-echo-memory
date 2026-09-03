/**
 * tools.ts 纯逻辑测试：工具 schema 形状、参数归一化、workspace 归属、execute 分支。
 * 覆盖 memory_save / memory_search / memory_forget / memory_restore / memory_suggest 的定义与执行。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { memoryTools, renderSearch, toOutputItem, workspaceOf } from '../src/tools.js'
import { MemoryStore } from '../src/store.js'
import type { StoreLimits } from '../src/store.js'
import type { MemoryRecord } from '../src/domain.js'
import { GLOBAL_WORKSPACE } from '../src/domain.js'
import { SuggestionStore } from '../src/suggestion-store.js'
import { FakeKvTable } from './helpers.js'

const LIMITS: StoreLimits = { contentMaxChars: 500, tagsMax: 8 }

function makeStore(): MemoryStore {
  return new MemoryStore(new FakeKvTable<string, MemoryRecord>(), LIMITS)
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const base: MemoryRecord = {
    id: 'mem-1-0',
    workspace: '/workspace/a',
    kind: 'fact',
    content: '部署走 systemd',
    tags: Object.freeze(['deploy', 'systemd']),
    strength: 1,
    source: 'agent',
    createdAt: 1000,
    updatedAt: 1000,
  }
  return { ...base, ...overrides }
}

function execWith(cwd: string | undefined): ToolRunContext {
  return {
    agent: cwd === undefined ? undefined : { session: { header: { cwd } } },
  } as unknown as ToolRunContext
}

// ---------- workspaceOf ----------

test('workspaceOf：显式非空 > 会话 cwd > 缺省', () => {
  assert.equal(workspaceOf({ workspace: '/proj/x' }, execWith('/proj/y'), GLOBAL_WORKSPACE), '/proj/x')
  assert.equal(workspaceOf({}, execWith('/proj/y'), GLOBAL_WORKSPACE), '/proj/y')
  assert.equal(workspaceOf({}, execWith(undefined), GLOBAL_WORKSPACE), GLOBAL_WORKSPACE)
})

test('workspaceOf：显式空串视为未传，回落会话/缺省', () => {
  assert.equal(workspaceOf({ workspace: '  ' }, execWith('/proj/y'), GLOBAL_WORKSPACE), '/proj/y')
  assert.equal(workspaceOf({ workspace: '' }, execWith(undefined), GLOBAL_WORKSPACE), GLOBAL_WORKSPACE)
})

// ---------- renderSearch / toOutputItem ----------

test('renderSearch：空结果给引导文案', () => {
  assert.match(renderSearch([]), /还没这方面的记忆/)
})

test('renderSearch：命中含 id/强度/工作区，模型可引用删除', () => {
  const text = renderSearch([{ id: 'm1', content: '部署走 systemd', kind: 'fact', workspace: '/w', tags: ['deploy'], strength: 2 }])
  assert.match(text, /id=m1/)
  assert.match(text, /x2/)
  assert.match(text, /\/w/)
  assert.match(text, /#deploy/)
})

test('toOutputItem：tag 数组化、字段投影', () => {
  const item = toOutputItem({ record: record({ tags: Object.freeze(['a', 'b']) }) } as never)
  assert.deepEqual(item.tags, ['a', 'b'])
  assert.equal(item.id, 'mem-1-0')
})

// ---------- memoryTools 定义形状 ----------

test('memoryTools（未注入 suggestionStore）：注册 4 个基础工具且名称/参数/output 形状正确', () => {
  const tools = memoryTools(makeStore(), GLOBAL_WORKSPACE, () => 'tombstone')
  assert.deepEqual(tools.map(t => t.name).sort(), ['memory_forget', 'memory_restore', 'memory_save', 'memory_search'])
  const save = tools.find(t => t.name === 'memory_save')!
  const saveParams = save.parameters.properties as Record<string, { type?: string }>
  assert.equal(saveParams.content!.type, 'string')
  assert.deepEqual(save.parameters.required, ['content'])
  assert.ok((save.output.schema.required as readonly string[] | undefined)?.includes('id'))
  const search = tools.find(t => t.name === 'memory_search')!
  const searchProps = search.parameters.properties as Record<string, { description?: string }>
  assert.ok(searchProps.limit?.description?.includes('1–50'))
  const forget = tools.find(t => t.name === 'memory_forget')!
  assert.deepEqual(forget.parameters.required, ['id'])
})

test('memoryTools（注入 suggestionStore）：注册 5 个工具且参数/输出契约完整', () => {
  const tools = memoryTools(makeStore(), GLOBAL_WORKSPACE, () => 'tombstone', new SuggestionStore())
  assert.deepEqual(tools.map(t => t.name).sort(), ['memory_forget', 'memory_restore', 'memory_save', 'memory_search', 'memory_suggest'])

  const byName = new Map(tools.map(t => [t.name, t]))
  const save = byName.get('memory_save')!
  assert.deepEqual(save.parameters.required, ['content'])
  assert.ok((save.output.schema.required as readonly string[] | undefined)?.includes('id'))

  const search = byName.get('memory_search')!
  assert.ok(search.parameters.properties)
  assert.ok((search.output.schema.required as readonly string[] | undefined)?.includes('items'))

  const forget = byName.get('memory_forget')!
  assert.deepEqual(forget.parameters.required, ['id'])
  assert.ok((forget.output.schema.required as readonly string[] | undefined)?.includes('removed'))

  const restore = byName.get('memory_restore')!
  assert.deepEqual(restore.parameters.required, ['id'])
  assert.ok((restore.output.schema.required as readonly string[] | undefined)?.includes('restored'))

  const suggest = byName.get('memory_suggest')!
  assert.deepEqual(suggest.parameters.required, ['content'])
  assert.ok((suggest.output.schema.required as readonly string[] | undefined)?.includes('suggested'))
})

// ---------- execute 行为 ----------

test('execute：save 空内容抛错，正常保存按会话 cwd 归属', async () => {
  const store = makeStore()
  const tools = memoryTools(store, GLOBAL_WORKSPACE, () => 'tombstone')
  const save = tools.find(t => t.name === 'memory_save')!
  await assert.rejects(
    save.execute({ content: '   ' } as never, execWith('/w')),
    TypeError,
  )
  const out = await save.execute({ content: '记住：用 pnpm' } as never, execWith('/w')) as { saved: boolean; workspace: string; existed: boolean }
  assert.equal(out.saved, true)
  assert.equal(out.workspace, '/w')
  assert.equal(out.existed, false)
})

test('execute：save 显式 workspace 覆盖会话', async () => {
  const store = makeStore()
  const tools = memoryTools(store, GLOBAL_WORKSPACE, () => 'tombstone')
  const save = tools.find(t => t.name === 'memory_save')!
  const out = await save.execute({ content: '全局约束', workspace: GLOBAL_WORKSPACE } as never, execWith('/w')) as { workspace: string }
  assert.equal(out.workspace, GLOBAL_WORKSPACE)
})

test('execute：search 无 query 返回最近记忆；有 query 跨全部 BM25F', async () => {
  const store = makeStore()
  await store.save({ workspace: '/w', content: 'VPS 走 systemd 部署', kind: 'fact', source: 'agent' })
  await store.save({ workspace: '/w', content: '前端用 react', kind: 'fact', source: 'agent' })
  const tools = memoryTools(store, GLOBAL_WORKSPACE, () => 'tombstone')
  const search = tools.find(t => t.name === 'memory_search')!
  const recent = await search.execute({} as never, execWith('/w')) as { items: Array<{ content: string }> }
  assert.equal(recent.items.length, 2)
  const hit = await search.execute({ query: 'systemd' } as never, execWith('/w')) as { items: Array<{ content: string }> }
  assert.equal(hit.items.length, 1)
  assert.match(hit.items[0]!.content, /systemd/)
})

test('execute：forget 按删除模式；restore 恢复墓碑', async () => {
  const store = makeStore()
  const saved = await store.save({ workspace: '/w', content: '临时记忆', kind: 'fact', source: 'agent' })
  const tools = memoryTools(store, GLOBAL_WORKSPACE, () => 'tombstone')
  const forget = tools.find(t => t.name === 'memory_forget')!
  const del = await forget.execute({ id: saved.id } as never, execWith('/w')) as { removed: boolean }
  assert.equal(del.removed, true)
  // 墓碑模式下检索不可见
  const search = tools.find(t => t.name === 'memory_search')!
  const after = await search.execute({ query: '临时' } as never, execWith('/w')) as { items: Array<unknown> }
  assert.equal(after.items.length, 0)
  const restore = tools.find(t => t.name === 'memory_restore')!
  const r = await restore.execute({ id: saved.id } as never, execWith('/w')) as { restored: boolean }
  assert.equal(r.restored, true)
  const back = await search.execute({ query: '临时' } as never, execWith('/w')) as { items: Array<unknown> }
  assert.equal(back.items.length, 1)
})
