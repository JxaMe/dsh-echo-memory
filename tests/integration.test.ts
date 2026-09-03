/**
 * 集成测试（探针转正）：真实 JsonStorageBackend + 真实磁盘 + 构建态 Store + 工具层。
 * 覆盖纯单测够不到的三层：真实 zod 校验读盘、原子落盘形状、跨重启持久化、
 * memory_save/search/forget 三个工具的 schema 与 execute 真链路。
 * 每次测试用独立临时目录，结束即删，不触碰真实 DSH_HOME。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { memoryDomainSpec, memoryRecordSchema } from '../src/domain.js'
import { MemoryStore } from '../src/store.js'
import { memoryTools } from '../src/tools.js'

/** 复刻 DomainFacility.open 语义：loadAll → zod 逐条校验 → 写穿表。 */
class TableAdapter {
  private records = new Map<string, unknown>()
  constructor(private readonly unit: { loadAll(): Promise<unknown>; putRecord(table: string, key: string, value: unknown): Promise<void>; deleteRecord(table: string, key: string): Promise<void> }) {}

  async init(): Promise<void> {
    this.records = new Map()
    const all = await this.unit.loadAll() as { tables: Record<string, Record<string, unknown>> }
    for (const rec of Object.values(all.tables.memories ?? {})) {
      const parsed = memoryRecordSchema.parse(rec)
      this.records.set(parsed.id, parsed)
    }
  }

  get(key: string): unknown { return this.records.get(key) }
  entries(): IterableIterator<[string, unknown]> { return this.records.entries() }
  keys(): IterableIterator<string> { return this.records.keys() }
  get size(): number { return this.records.size }
  async put(key: string, value: unknown): Promise<void> {
    this.records.set(key, value)
    await this.unit.putRecord('memories', key, value)
  }
  async delete(key: string): Promise<boolean> {
    const ok = this.records.delete(key)
    await this.unit.deleteRecord('memories', key)
    return ok
  }
  async update(key: string, fn: (value: unknown) => unknown): Promise<unknown> {
    const next = fn(this.records.get(key))
    await this.put(key, next)
    return next
  }
}

/** 开一个完整后端 + store + 工具三件套（每个用例独立临时目录）。 */
async function openStore(dir: string): Promise<{ store: MemoryStore; tools: ReturnType<typeof memoryTools>; backend: JsonStorageBackend; file: string }> {
  const root = join(dir, 'storages')
  const backend = new JsonStorageBackend(root)
  const unit = await backend.kv.open(descriptorOf(memoryDomainSpec))
  const adapter = new TableAdapter(unit)
  await adapter.init()
  const store = new MemoryStore(adapter as never, { contentMaxChars: 500, tagsMax: 8 })
  const tools = memoryTools(store, '*', () => 'tombstone')
  return { store, tools, backend, file: join(root, 'memory.json') }
}

test('集成：保存→落盘形状→重启持久化→墓碑→purge 物理清除', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-int-'))
  try {
    // 第一代：保存两条，验证落盘文件形状
    const gen1 = await openStore(dir)
    const saved = await gen1.tools[0]!.execute({ workspace: '/w', content: '集成测试-A', tags: ['it'] }, {} as never) as {
      saved: boolean; existed: boolean; id: string; strength: number; workspace: string
    }
    assert.deepEqual(saved, { saved: true, existed: false, id: saved.id, strength: 1, workspace: '/w' })
    const saved2 = await gen1.tools[0]!.execute({ workspace: '/w', content: '集成测试-B' }, {} as never) as {
      existed: boolean
    }
    assert.equal(saved2.existed, false)

    const disk1 = JSON.parse(await readFile(gen1.file, 'utf8'))
    assert.equal(disk1.unit.name, 'memory')
    assert.equal(disk1.unit.version, 3)
    assert.equal(Object.keys(disk1.tables.memories).length, 2)

    // 工具层：search 规范输出（items 数组，字段齐全）
    const found = await gen1.tools[1]!.execute({ query: '集成测试', workspace: '/w' }, {} as never) as {
      items: Array<{ id: string; content: string; strength: number; tags: string[] }>
    }
    assert.equal(found.items.length, 2)
    for (const item of found.items) {
      assert.equal(typeof item.id, 'string')
      assert.equal(typeof item.content, 'string')
      assert.equal(typeof item.strength, 'number')
      assert.ok(Array.isArray(item.tags))
    }

    // 墓碑删除：落盘带 deletedAt，仍占位
    await gen1.tools[2]!.execute({ id: saved.id }, {} as never)
    const disk2 = JSON.parse(await readFile(gen1.file, 'utf8'))
    assert.equal(typeof disk2.tables.memories[saved.id].deletedAt, 'number')
    assert.equal(Object.keys(disk2.tables.memories).length, 2)

    await gen1.backend.close()

    // 第二代（模拟重启）：两条记录被 zod 校验读入，墓碑不可见
    const gen2 = await openStore(dir)
    assert.equal(gen2.store.search({ query: '' }).length, 1)
    assert.equal(gen2.store.liveCount(), 1)
    // purge：物理清掉墓碑，文件只剩 1 条且无 deletedAt 残留
    assert.equal(await gen2.store.purgeDeleted(), 1)
    const disk3 = JSON.parse(await readFile(gen2.file, 'utf8'))
    assert.equal(Object.keys(disk3.tables.memories).length, 1)
    const records = Object.values(disk3.tables.memories) as Array<{ deletedAt?: unknown }>
    assert.equal(records.every(r => r.deletedAt === undefined), true)
    await gen2.backend.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('集成：重复保存强化跨重启保留（strength 落盘）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-int-'))
  try {
    const gen1 = await openStore(dir)
    await gen1.tools[0]!.execute({ workspace: '/w', content: '强化目标' }, {} as never)
    const b = await gen1.tools[0]!.execute({ workspace: '/w', content: '强化目标' }, {} as never) as {
      existed: boolean; strength: number
    }
    assert.equal(b.existed, true)
    assert.equal(b.strength, 2)
    await gen1.backend.close()

    const gen2 = await openStore(dir)
    const hit = gen2.store.search({ query: '强化目标' })[0]
    assert.ok(hit)
    assert.equal(hit.record.strength, 2)
    await gen2.backend.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('集成：工具 schema 声明（参数/output 形状）与恶意输入护栏', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-int-'))
  try {
    const { tools } = await openStore(dir)
    // 四工具名称（新增 memory_restore）
    assert.deepEqual(tools.map(t => t!.name), ['memory_save', 'memory_search', 'memory_forget', 'memory_restore'])
    // 参数 schema：object + properties + required 数组（save 必填 content；forget 必填 id）
    const saveParams = tools[0]!.parameters as { type: string; properties: Record<string, unknown>; required: string[] }
    assert.equal(saveParams.type, 'object')
    assert.ok(saveParams.properties.content)
    assert.ok(saveParams.required.includes('content'))
    const forgetParams = tools[2]!.parameters as { properties: Record<string, unknown>; required: string[] }
    assert.ok(forgetParams.properties.id)
    assert.ok(forgetParams.required.includes('id'))
    // 输出 schema 的 saved/items/removed 字段存在
    const saveOutput = tools[0]!.output?.schema as { properties: Record<string, unknown> }
    assert.ok('saved' in saveOutput.properties)
    const searchOutput = tools[1]!.output?.schema as { properties: Record<string, unknown> }
    assert.ok('items' in searchOutput.properties)
    const forgetOutput = tools[2]!.output?.schema as { properties: Record<string, unknown> }
    assert.ok('removed' in forgetOutput.properties)
    // 空正文被拒（TypeError 传递到 execute 抛错路径）
    await assert.rejects(
      () => tools[0]!.execute({ workspace: '/w', content: '   ' }, {} as never),
      TypeError,
    )
    // 删除不存在的 id → removed=false
    const gone = await tools[2]!.execute({ id: 'mem-does-not-exist' }, {} as never)
    assert.deepEqual(gone, { removed: false })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})