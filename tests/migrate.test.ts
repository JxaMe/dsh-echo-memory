/**
 * 记忆文件迁移器测试：版本相等不动 / 版本先进拒绝 / 缺迁移链拒绝 / 有链升级写回 / 幂等 / 新库跳过。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MEMORY_MIGRATIONS, migrateMemoryFile, type MemoryMigration } from '../src/migrate.js'

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