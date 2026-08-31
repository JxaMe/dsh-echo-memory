/**
 * MemoryStore 纯逻辑测试：保存/去重强化/删除/检索评分/注入召回/归一化。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  keywordScore,
  MemoryStore,
  normalizeContent,
  normalizeTags,
  recencyFactor,
  renderLine,
} from '../src/store.js'
import type { StoreLimits } from '../src/store.js'
import { GLOBAL_WORKSPACE, type MemoryRecord } from '../src/domain.js'
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

test('save 新建记录：默认值、正文/标签归一化、id 生成', async () => {
  const store = makeStore()
  const outcome = await store.save(
    { workspace: '/workspace/a', content: '  记住这点  ', tags: ['Deploy', 'deploy', ''] },
    2000,
  )
  assert.equal(outcome.existed, false)
  assert.equal(outcome.strength, 1)
  assert.equal(outcome.workspace, '/workspace/a')
  assert.match(outcome.id, /^mem-\d+-\d+$/)
  // 测试通过公开 search 读取，避免依赖私有字段：
  const hit = store.search({ query: '记住' })[0]
  assert.ok(hit)
  assert.equal(hit.record.content, '记住这点')
  assert.deepEqual(hit.record.tags, ['deploy'])
  assert.equal(hit.record.kind, 'fact')
  assert.equal(hit.record.source, 'agent')
  assert.equal(hit.record.createdAt, 2000)
})

test('save 重复写入强化而非重复保存', async () => {
  const store = makeStore()
  const first = await store.save(
    { workspace: '/workspace/a', content: '使用 systemd 管理 dsh-web', tags: ['deploy'] },
    3000,
  )
  const second = await store.save(
    { workspace: '/workspace/a', content: '使用 systemd 管理 dsh-web', tags: ['deploy'] },
    4000,
  )
  assert.equal(second.existed, true)
  assert.equal(second.id, first.id)
  assert.equal(second.strength, 2)
  const hit = store.search({ query: 'systemd' })[0]
  assert.ok(hit)
  assert.equal(hit.record.strength, 2)
  assert.equal(hit.record.createdAt, 3000)
  assert.equal(hit.record.updatedAt, 4000)
  assert.equal(store.search({ query: 'systemd' }).length, 1)
})

test('save 不同工作区同正文 → 各自独立记录', async () => {
  const store = makeStore()
  await store.save({ workspace: '/workspace/a', content: '同一句话' }, 1000)
  await store.save({ workspace: '/workspace/b', content: '同一句话' }, 2000)
  assert.equal(store.search({ query: '同一句话' }).length, 2)
})

test('save 空正文与超长正文', async () => {
  const store = makeStore()
  await assert.rejects(() => store.save({ workspace: '/w', content: '   ' }), TypeError)
  await store.save({ workspace: '/w', content: 'x'.repeat(600) })
  const hit = store.search({ query: 'x' })[0]
  assert.ok(hit)
  assert.equal(hit.record.content.length, 500)
})

test('forget（purge 模式）：存在删除返回 true，不存在返回 false', async () => {
  const store = makeStore()
  const { id } = await store.save({ workspace: '/w', content: '将被删除' })
  assert.equal(await store.forget(id, 'purge'), true)
  assert.equal(store.search({ query: '将被删除' }).length, 0)
  assert.equal(await store.forget(id, 'purge'), false)
})

test('forget（tombstone 模式）：标记删除，检索/注入不可见，可 purge 物理清除', async () => {
  const store = makeStore()
  const { id } = await store.save({ workspace: '/w', content: '墓碑候选', tags: ['dep'] })
  // 标记删除：返回 true，检索/注入全部不可见
  assert.equal(await store.forget(id, 'tombstone', 1_000), true)
  assert.equal(store.search({ query: '墓碑候选' }).length, 0)
  assert.equal(store.rankedForInjection('/w', 8).length, 0)
  assert.equal(store.recallText({ workspace: '/w', limit: 8, maxChars: 1000 }), '')
  // 墓碑仍在表中（占位），重复删除返回 false
  assert.equal(await store.forget(id, 'tombstone'), false)
  // 墓碑不参与查重：重新保存同内容 = 新建
  const again = await store.save({ workspace: '/w', content: '墓碑候选' })
  assert.equal(again.existed, false)
  assert.notEqual(again.id, id)
  // purge：物理清除全部墓碑（逐条持久化），无残留
  assert.equal(await store.purgeDeleted(), 1)
  assert.equal(await store.purgeDeleted(), 0)
  assert.equal(await store.forget(id, 'purge'), false)
})

test('purgeDeleted：混合表只清墓碑，返回清除数量', async () => {
  const store = makeStore()
  const a = await store.save({ workspace: '/w', content: '保留' })
  const b = await store.save({ workspace: '/w', content: '删除1' })
  const c = await store.save({ workspace: '/w', content: '删除2' })
  await store.forget(b.id, 'tombstone')
  await store.forget(c.id, 'tombstone')
  assert.equal(await store.purgeDeleted(), 2)
  assert.equal(store.search({ query: '' }).length, 1)
  assert.equal(store.search({ query: '' })[0]?.record.id, a.id)
})

test('search：工作区/类型过滤、标签精确优先、limit 生效', async () => {
  const store = makeStore()
  await store.save({ workspace: '/workspace/a', content: 'API 用 REST 风格', tags: ['api'] }, 1000)
  await store.save({ workspace: '/workspace/a', content: '日志格式是 JSON', tags: ['log'] }, 2000)
  // 新但仅正文子串命中：标签精确（+8）必须排在正文子串（+2）之前
  await store.save({ workspace: '/workspace/b', content: 'API 走 gRPC' }, 3000)

  const tagged = store.search({ query: 'api', workspace: '/workspace/a' })
  assert.equal(tagged.length, 1)
  assert.equal(tagged[0]?.record.content, 'API 用 REST 风格')

  const both = store.search({ query: 'api' })
  assert.equal(both.length, 2)
  assert.equal(both[0]?.record.workspace, '/workspace/a')

  const none = store.search({ query: '不存在词' })
  assert.equal(none.length, 0)

  const limited = store.search({ query: 'api', limit: 1 })
  assert.equal(limited.length, 1)
})

test('search：无 query 返回最近记忆（updatedAt 降序）', async () => {
  const store = makeStore()
  await store.save({ workspace: '/w', content: '旧的记忆' }, 1000)
  await store.save({ workspace: '/w', content: '新的记忆' }, 5000)
  const hits = store.search({ workspace: '/w' })
  assert.equal(hits[0]?.record.content, '新的记忆')
})

test('rankedForInjection：当前工作区 + 全局入选，其他工作区排除，强度优先', async () => {
  const store = makeStore()
  await store.save({ workspace: '/workspace/a', content: '项目 A 记忆', tags: ['a'] }, 1000)
  await store.save({ workspace: GLOBAL_WORKSPACE, content: '全局偏好', tags: ['g'] }, 1000)
  await store.save({ workspace: '/workspace/b', content: '项目 B 记忆', tags: ['b'] }, 5000)
  await store.save({ workspace: '/workspace/a', content: '项目 A 强记忆', tags: ['a'] }, 1000)
  // 强化"项目 A 强记忆"两次 → strength 3
  await store.save({ workspace: '/workspace/a', content: '项目 A 强记忆', tags: ['a'] }, 1000)
  await store.save({ workspace: '/workspace/a', content: '项目 A 强记忆', tags: ['a'] }, 1000)

  const candidates = store.rankedForInjection('/workspace/a', 10, 5000)
  const contents = candidates.map(c => c.record.content)
  assert.deepEqual(contents, ['项目 A 强记忆', '项目 A 记忆', '全局偏好'])
})

test('recallText：格式、截断、空库', async () => {
  const store = makeStore()
  assert.equal(store.recallText({ workspace: '/w', limit: 8, maxChars: 1500 }), '')

  await store.save({
    workspace: GLOBAL_WORKSPACE,
    content: '用户偏好简洁回复',
    tags: ['preference'],
    kind: 'preference',
  }, 1000)
  const text = store.recallText({ workspace: '/w', limit: 8, maxChars: 1500 }, 2000)
  assert.ok(text.startsWith('- [preference] 用户偏好简洁回复 #preference'))

  await store.save({ workspace: '/w', content: '一'.repeat(200) }, 1000)
  const narrow = store.recallText({ workspace: '/w', limit: 8, maxChars: 50 }, 2000)
  assert.ok(narrow.endsWith('…'))
  assert.ok(narrow.length <= 50)
})

test('归一化与评分纯函数', () => {
  assert.equal(normalizeContent('  abc  ', 10), 'abc')
  assert.equal(normalizeContent('abc', 2), 'ab')
  assert.deepEqual(normalizeTags(['A', 'a', 'B', ''], 8), ['a', 'b'])
  assert.deepEqual(normalizeTags(['x', 'y', 'z'], 2), ['x', 'y'])

  const tagHit = keywordScore(record({ tags: Object.freeze(['api']) }), 'api')
  const contentHit = keywordScore(record({ content: 'API 文档见 wiki' }), 'api')
  assert.ok(tagHit > contentHit)
  assert.equal(keywordScore(record(), '无匹配词'), 0)
  assert.equal(keywordScore(record(), ''), 1)

  assert.ok(recencyFactor(1000, 1000) > recencyFactor(1000, 1000 + 90 * 24 * 60 * 60 * 1000))
  assert.equal(recencyFactor(0, 90 * 24 * 60 * 60 * 1000), 0.1)

  assert.equal(renderLine(record()), '- [fact] 部署走 systemd #deploy #systemd')
  assert.equal(renderLine(record({ strength: 3 })), '- [fact] 部署走 systemd #deploy #systemd (x3)')
})
test('injectionStats：只有启用时记账，命中数正确', () => {
  const store = makeStore()
  assert.deepEqual(store.injectionStats, { requests: 0, withContent: 0 })
  store.recordAssembly(true, false)
  store.recordAssembly(true, true)
  store.recordAssembly(true, true)
  store.recordAssembly(false, true) // 关闭不记账
  assert.deepEqual(store.injectionStats, { requests: 3, withContent: 2 })
})

test('liveCount：只数活跃记忆，不含墓碑', async () => {
  const store = makeStore()
  const a = await store.save({ workspace: '/w', content: '活的' })
  const b = await store.save({ workspace: '/w', content: '待删' })
  assert.equal(store.liveCount(), 2)
  await store.forget(b.id, 'tombstone')
  assert.equal(store.liveCount(), 1)
  assert.ok(a.id !== b.id)
})
