/**
 * 记忆文件迁移器：领域版本升级的前置步骤。
 * 官方 storage-domain 对版本不匹配的策略是「拒绝打开」（version-mismatch），
 * 没有迁移钩子——本模块在 open 之前对 memory.json 做文件级迁移：
 *  1. 文件版本 == 期望版本 → 不动；
 *  2. 文件版本 < 期望版本 → 沿迁移链逐级转换（每条记录过 up）后原子写回；
 *  3. 文件版本 > 期望版本 → 抛错（数据比代码新，拒绝降级）；
 *  4. 版本落后但缺少迁移链 → 抛错（响亮失败，不静默迁移）。
 * 迁移链用后即弃：迁移完成后 open 走正常校验路径。
 * @module dsh-echo-memory/migrate
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 记忆文件损坏（无法解析/版本畸形）错误：可自愈（隔离备份 + 空库），与版本/迁移链错误区分。 */
export class MemoryFileCorruptedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryFileCorruptedError'
  }
}

/** 一条级间迁移：把上一版本的一条记录转换成下一版本。 */
export interface MemoryMigration {
  /** 迁移起点版本（记录转换前的文件版本）。 */
  readonly from: number
  /** 记录转换（由迁移作者保证输出符合下一版本 schema；未知记录原样放行的责任在 up）。 */
  readonly up: (record: unknown) => unknown
}

/** v1→v2：早期占位迁移（无实际字段变化，保持记录原样）。 */
export const MEMORY_MIGRATIONS: readonly MemoryMigration[] = Object.freeze([
  {
    from: 1,
    up: (record: unknown) => {
      const r = record as Record<string, unknown>
      return { ...r }
    },
  },
  {
    from: 2,
    up: (record: unknown) => {
      const r = record as Record<string, unknown>
      const rest: Record<string, unknown> = { ...r }
      // 移除向量/嵌入占位字段（当前纯本地 BM25F，不再维护向量数据）
      delete rest.embedding
      delete rest.embeddingAt
      if (rest.source === 'auto') rest.source = 'agent'
      return rest
    },
  },
])

/** 迁移目标文件名（与存储领域的 unit 名一致）。 */
const UNIT_FILE = 'memory.json'

/**
 * 迁移指定目录下的记忆文件到期望版本；文件不存在（新库）时静默跳过。
 * @param root - 存储后端根目录（`$DSH_HOME/storages`）。
 * @param expectedVersion - 领域 spec 声明的版本。
 * @param migrations - 迁移链（缺省用模块级 MEMORY_MIGRATIONS；测试可注入）。
 * @returns 是否发生了实际迁移。
 */
export async function migrateMemoryFile(
  root: string,
  expectedVersion: number,
  migrations: readonly MemoryMigration[] = MEMORY_MIGRATIONS,
): Promise<boolean> {
  const path = join(root, UNIT_FILE)
  const raw = await readFile(path, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (raw === undefined) return false

  let file: {
    readonly unit?: { readonly name?: unknown; readonly version?: unknown }
    readonly tables?: Record<string, Record<string, unknown>>
  }
  try {
    file = JSON.parse(raw) as {
      readonly unit?: { readonly name?: unknown; readonly version?: unknown }
      readonly tables?: Record<string, Record<string, unknown>>
    }
  } catch (error) {
    throw new MemoryFileCorruptedError(`dsh-echo-memory: memory file is corrupted (invalid JSON): ${String(error)}`)
  }
  const fileVersion = file.unit?.version ?? 0
  if (typeof fileVersion !== 'number' || fileVersion < 0) {
    throw new MemoryFileCorruptedError(`dsh-echo-memory: memory file has malformed unit version: ${String(file.unit?.version)}`)
  }
  if (fileVersion === expectedVersion) return false
  if (fileVersion > expectedVersion) {
    throw new Error(
      `dsh-echo-memory: memory file version ${String(fileVersion)} is newer than code version `
      + `${String(expectedVersion)}; refusing to open (downgrade would lose data)`,
    )
  }

  // 沿迁移链逐级升级：chain = 传入链中 from 依次衔接的部分。
  const chain = migrations
    .filter(migration => migration.from >= fileVersion && migration.from < expectedVersion)
    .sort((a, b) => a.from - b.from)
  let version = fileVersion
  for (const migration of chain) {
    if (migration.from !== version) {
      throw new Error(
        `dsh-echo-memory: missing migration from version ${String(version)} to ${String(expectedVersion)}; `
        + 'refusing to open the store (no silent migration)',
      )
    }
    const records = file.tables?.memories
    if (records !== undefined) {
      const upgraded: Record<string, unknown> = {}
      for (const [id, record] of Object.entries(records)) {
        upgraded[id] = migration.up(record)
      }
      Object.assign(records, upgraded)
    }
    version += 1
  }
  if (version !== expectedVersion) {
    throw new Error(
      `dsh-echo-memory: no migration chain from file version ${String(fileVersion)} to `
      + `${String(expectedVersion)}; refusing to open the store (no silent migration)`,
    )
  }

  // 原子替换写回：确保目录存在后临时文件 + rename（与 json 后端同一发布协议）。
  await mkdir(root, { recursive: true })
  const tmp = join(root, `.${randomUUID()}.migrate.tmp`)
  const next = { ...file, unit: { ...file.unit, version: expectedVersion } }
  const out = JSON.stringify(next, null, 2)
  await writeFile(tmp, out, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, path)
  return true
}
/**
 * 把记忆文件隔离备份（rename 到 `.corrupt-<ts>` 唯一名），返回备份路径。
 * 原文件被移走后，存储后端在 `open` 时会新建空库——数据保留在备份里可手动修复。
 */
export async function quarantineMemoryFile(root: string): Promise<string> {
  const path = join(root, UNIT_FILE)
  const backup = join(root, `${UNIT_FILE}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`)
  await rename(path, backup)
  return backup
}

/** 打开前的文件可用性保障结果。 */
export type MemoryFileRecovery =
  | { kind: 'ok'; migrated: boolean }
  | { kind: 'recovered-corrupt'; backupPath: string }

/**
 * 打开前的文件可用性保障：正常迁移；文件损坏（JSON 解析失败/版本畸形）时
 * 隔离备份并返回恢复标记，上层以空库继续——数据不丢（备份可手动修复）、插件不瘫痪。
 * 版本比代码新 / 缺迁移链等安全类错误保持抛错（不静默降级）。
 */
export async function ensureMemoryFileUsable(
  root: string,
  expectedVersion: number,
  migrations: readonly MemoryMigration[] = MEMORY_MIGRATIONS,
): Promise<MemoryFileRecovery> {
  try {
    const migrated = await migrateMemoryFile(root, expectedVersion, migrations)
    return { kind: 'ok', migrated }
  } catch (error) {
    if (error instanceof MemoryFileCorruptedError) {
      const backupPath = await quarantineMemoryFile(root)
      return { kind: 'recovered-corrupt', backupPath }
    }
    throw error
  }
}
