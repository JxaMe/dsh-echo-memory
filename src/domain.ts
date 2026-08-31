/**
 * dsh-echo-memory 记忆领域：单一数据源（身份、版式、记录 schema）。
 * 记录 schema 用 zod 描述，存储层（storage-domain json 后端）在打开时校验全部已存记录。
 * @module dsh-echo-memory/domain
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** 记忆类型封闭词表：fact 事实 / preference 偏好 / project 项目 / session 会话结论。 */
export const MEMORY_KINDS = ['fact', 'preference', 'project', 'session'] as const

/** 一条记忆的类型。 */
export type MemoryKind = (typeof MEMORY_KINDS)[number]

/** 记忆来源封闭词表（当前生产者：memory_save 写 agent、自动捕获写 auto）。 */
export const MEMORY_SOURCES = ['agent', 'auto'] as const

/** 一条记忆的写入来源。 */
export type MemorySource = (typeof MEMORY_SOURCES)[number]

/** 无工作区归属（跨项目可用）的记忆工作区值。 */
export const GLOBAL_WORKSPACE = '*'

/** 宿主形状适配：从 agent 会话取当前工作区 cwd（prompt 组装 / 工具执行共用；无会话时 undefined）。 */
export function agentWorkspace(
  agent: { readonly session?: { readonly header?: { readonly cwd?: string } } } | undefined,
): string | undefined {
  return agent?.session?.header?.cwd
}

/**
 * 一条持久记忆。id 为插件自产的不透明字符串（`mem-<ts>-<seq>`），
 * 只在包内流动、不跨包边界传递，因此不做品牌化。
 */
export interface MemoryRecord {
  /** 唯一记录 id（`mem-<createdAt>-<seq>`）。 */
  readonly id: string
  /** 归属工作区（会话绝对 cwd）；`*` 表示跨项目全局记忆。 */
  readonly workspace: string
  /** 记忆类型。 */
  readonly kind: MemoryKind
  /** 模型可见的记忆正文（写入时按配置截断）。 */
  readonly content: string
  /** 检索标签（小写、去重、按配置限量）。 */
  readonly tags: readonly string[]
  /** 强化计数：同工作区同类型同正文的重复写入使其 +1。 */
  readonly strength: number
  /** 写入来源。 */
  readonly source: MemorySource
  /** 创建时间（Unix epoch 毫秒）。 */
  readonly createdAt: number
  /** 最近写入/强化时间（Unix epoch 毫秒）。 */
  readonly updatedAt: number
  /** 墓碑删除时间（Unix epoch 毫秒）；存在即已标记删除（检索/注入不可见，purge 时物理清除）。 */
  readonly deletedAt?: number | undefined
}

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** 一条记忆记录运行时 schema；读取时逐条校验已存数据，格式违反即拒绝打开领域。 */
export const memoryRecordSchema = z.object({
  id: z.string().min(1),
  workspace: z.string().min(1),
  kind: z.enum(MEMORY_KINDS),
  content: z.string().min(1),
  tags: z.array(z.string().min(1)).max(32),
  strength: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  source: z.enum(MEMORY_SOURCES),
  createdAt: nonNegativeSafeInteger,
  updatedAt: nonNegativeSafeInteger,
  // 可选字段：旧数据无此键，解读为未删除；不 bump 领域版本（向后兼容）。
  deletedAt: nonNegativeSafeInteger.optional(),
}).superRefine((record, ctx) => {
  if (record.updatedAt < record.createdAt) {
    ctx.addIssue({
      code: 'custom',
      path: ['updatedAt'],
      message: 'memory updatedAt must not precede createdAt',
    })
  }
  if (record.deletedAt !== undefined && record.deletedAt < record.createdAt) {
    ctx.addIssue({
      code: 'custom',
      path: ['deletedAt'],
      message: 'memory deletedAt must not precede createdAt',
    })
  }
  if (new Set(record.tags).size !== record.tags.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['tags'],
      message: 'memory tags must be unique',
    })
  }
}) as unknown as z.ZodType<MemoryRecord>

/** 记忆领域：后端 unit 名 = `memory`，落盘 `$DSH_HOME/storages/memory.json`。 */
export const memoryDomainSpec = defineDomain({
  name: 'memory',
  version: 1,
  tables: {
    memories: domainTable<string, MemoryRecord>(memoryRecordSchema),
  },
})