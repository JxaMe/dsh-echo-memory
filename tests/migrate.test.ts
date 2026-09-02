/**
 * 记忆文件迁移器测试：版本相等不动 / 版本先进拒绝 / 缺迁移链拒绝 / 有链升级写回 / 幂等 / 新库跳过。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureMemoryFileUsable, MEMORY_MIGRATIONS, migrateMemoryFile, quarantineMemoryFile, type MemoryMigration } from '../src/migrate.js'

/** 造一个合法形状的记忆文件。 */
function file(version: number, records: Record<string, unknown>): string {
  return JSON.stringify({ unit: { name: 'memory', version }, global: null, tables: { memories: records } })
}

test('版本相等：不动文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-migrate-'))
  try {
    const body = file(1, { a: { id: 'a', v: 1 } })
    await writeFile(join(dir, 'memory.json'), body)
    assert.equal(await migrateMemoryFile(dir, 1), false)
    assert.equal(await readFile(join(dir, 'memory.json'), 'utf8'), body)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('文件不存在：新库跳过', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-migrate-'))
  try {
    assert.equal(await migrateMemoryFile(dir, 1), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('文件版本高于代码：拒绝降级', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-migrate-'))
  try {
    await writeFile(join(dir, 'memory.json'), file(3, {}))
    await assert.rejects(() => migrateMemoryFile(dir, 1), /newer than code version/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('版本落后但无迁移链：响亮拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-migrate-'))
  try {
    // 当前有 1→2 链，但 0→1 仍无链，0→1 应失败
    assert.ok(MEMORY_MIGRATIONS.some(m => m.from === 1))
    await writeFile(join(dir, 'memory.json'), file(0, {}))
    await assert.rejects(() => migrateMemoryFile(dir, 1), /no migration chain|missing migration/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('有迁移链：逐级升级记录并原子写回，再次调用幂等', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-migrate-'))
  try {
    const chain: readonly MemoryMigration[] = [
      {
        from: 1,
        up: (record) => {
          const r = record as { id: string }
          return { ...r, upgraded: true }
        },
      },
    ]
    await writeFile(join(dir, 'memory.json'), file(1, {
      a: { id: 'a', content: '旧记录' },
      b: { id: 'b', content: '另一条' },
    }))
    assert.equal(await migrateMemoryFile(dir, 2, chain), true)
    const after = JSON.parse(await readFile(join(dir, 'memory.json'), 'utf8'))
    assert.equal(after.unit.version, 2)
    assert.equal(after.tables.memories.a.upgraded, true)
    assert.equal(after.tables.memories.b.upgraded, true)
    // 幂等：版本已到位，再跑不动
    assert.equal(await migrateMemoryFile(dir, 2, chain), false)
    // 原子写：目录无 tmp 残留
    const files = await readdir(dir)
    assert.equal(files.filter((name: string) => name.endsWith('.tmp')).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('v2→v3：移除向量字段并把旧 auto 来源归一为 agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-migrate-'))
  try {
    await writeFile(join(dir, 'memory.json'), file(2, {
      a: { id: 'a', source: 'auto', content: '旧自动捕获', embedding: [0.1, 0.2], embeddingAt: 1000 },
      b: { id: 'b', source: 'agent', content: '普通保存' },
    }))
    assert.equal(await migrateMemoryFile(dir, 3), true)
    const after = JSON.parse(await readFile(join(dir, 'memory.json'), 'utf8'))
    assert.equal(after.unit.version, 3)
    assert.equal(after.tables.memories.a.source, 'agent')
    assert.equal(after.tables.memories.b.source, 'agent')
    assert.ok(!('embedding' in after.tables.memories.a))
    assert.ok(!('embeddingAt' in after.tables.memories.a))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
// ---------- 数据损坏自愈 ----------

test('损坏 JSON：ensure 隔离备份并返回 recovered-corrupt，原文件被移走可建空库', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-migrate-'))
  try {
    await writeFile(join(dir, 'memory.json'), '{ this is not json')
    const outcome = await ensureMemoryFileUsable(dir, 2)
    assert.equal(outcome.kind, 'recovered-corrupt')
    const backup = (outcome as { kind: 'recovered-corrupt'; backupPath: string }).backupPath
    assert.equal(await readFile(backup, 'utf8'), '{ this is not json')
    await assert.rejects(() => readFile(join(dir, 'memory.json'), 'utf8'))
    assert.ok((await readdir(dir)).some(f => f.startsWith('memory.json.corrupt-')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('损坏 JSON（版本畸形）：ensure 同样隔离', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-migrate-'))
  try {
    await writeFile(join(dir, 'memory.json'), JSON.stringify({ unit: { version: 'x' }, tables: {} }))
    const outcome = await ensureMemoryFileUsable(dir, 2)
    assert.equal(outcome.kind, 'recovered-corrupt')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('版本比代码新：ensure 保持响亮拒绝（不静默降级）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-migrate-'))
  try {
    await writeFile(join(dir, 'memory.json'), file(3, {}))
    await assert.rejects(() => ensureMemoryFileUsable(dir, 1), /newer than code version/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('正常文件：ensure 返回 ok + migrated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-migrate-'))
  try {
    await writeFile(join(dir, 'memory.json'), file(1, {}))
    const outcome = await ensureMemoryFileUsable(dir, 2)
    assert.equal(outcome.kind, 'ok')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('quarantineMemoryFile：隔离备份保留原内容', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-migrate-'))
  try {
    await writeFile(join(dir, 'memory.json'), 'raw-content')
    const backup = await quarantineMemoryFile(dir)
    assert.equal(await readFile(backup, 'utf8'), 'raw-content')
    await assert.rejects(() => readFile(join(dir, 'memory.json'), 'utf8'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
