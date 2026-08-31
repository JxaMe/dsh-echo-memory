/**
 * dsh-echo-memory 浏览器半侧：把记忆设置卡片注册进「插件配置」分区的
 * `settings.plugin.item` 槽位（key = 与 Host 一致的 `memory` 命名空间），
 * 由 ui-settings-plugins 的 configurable 标签页按命名空间配对渲染。
 * 跨插件协作只走服务（slots/locale/settingsScope），不产生值导入。
 * @module dsh-echo-memory/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only：pull ctx.settingsScope 的 Context merge。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only：pull `settings.plugin.item` 的 SlotMap 声明（本卡片注册的槽位）。
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only：pull client 侧 `ctx.connection` 句柄类型（值不入包）。
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// 与 Host 共享的字段类型（type-only，擦除后不产生运行时依赖）。
import type { MemorySettings } from '../settings.ts'
import { MemoryCardController } from './card-controller.ts'
import type { MemoryCardFace } from './card-controller.ts'
import { MemoryPluginCard } from './MemoryPluginCard.tsx'
import type { MemoryPluginCardProps } from './MemoryPluginCard.tsx'
import { en, zh, type MemoryKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 记忆设置卡片的字典命名空间。 */
    'settings.memory': MemoryKey
  }
}

// 命名空间值在浏览器侧拼写而非从 Host 包导入：client 包不得值依赖 Host 包
// （与官方 bash-card-controller 的 SHELL_NS 同一约定）。
const MEMORY_SETTINGS_NS_VALUE = 'memory'

/** 本卡片的 locale 命名空间。 */
const LOCALE_NS = 'settings.memory'

/**
 * 卡片 RPC endpoints（与 Host 注册拼写一致；两侧各自拼写，不产生跨半侧值依赖）。
 * call 失败（RPC 层）在此抛出，卡片显示失败态。
 */
const MEMORY_PURGE_ENDPOINT = 'dsh-echo-memory/purge-tombstones'
const MEMORY_STATS_ENDPOINT = 'dsh-echo-memory/stats'

/** Host 返回的运行期统计载荷（与 Host memoryStats() 同形，client 侧自拼类型）。 */
export interface MemoryStatsPayload {
  readonly injections: { readonly requests: number; readonly withContent: number }
  readonly memories: number
}

/** 必需服务：槽位注册、文案、连接载体、设置 scope 与远程失效转发。 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * 浏览器插件主体：注册记忆卡片。
 * @param ctx - 浏览器 cordis 上下文（上述注入就绪后执行）。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-echo-memory: settings card dictionaries')
  const controller = new MemoryCardController(
    ctx.settingsScope.bind<MemorySettings>({ namespace: MEMORY_SETTINGS_NS_VALUE }),
    () => invokePurge(ctx),
    () => invokeStats(ctx),
  )
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: MEMORY_SETTINGS_NS_VALUE,
    locale: LOCALE_NS,
    inject: () => controller.inject(),
  }, MemoryPluginCard))
}

/**
 * 调用 Host 的「彻底删除」RPC（官方 api-gateway 同款通道 `/api`）。
 * @param ctx - 浏览器上下文（inject 已含 connection）。
 * @returns 本次清除的墓碑条数；RPC 失败或业务失败均抛出。
 */
async function invokePurge(ctx: ClientContext): Promise<number> {
  const result = await rpcCall(ctx, MEMORY_PURGE_ENDPOINT)
  const purged = (result as { readonly purged?: unknown }).purged
  return typeof purged === 'number' ? purged : 0
}

/** 拉取 Host 运行期统计（注入次数/命中 + 记忆条数）；失败抛出。 */
async function invokeStats(ctx: ClientContext): Promise<MemoryStatsPayload> {
  const value = await rpcCall(ctx, MEMORY_STATS_ENDPOINT)
  const injections = (value as { readonly injections?: unknown }).injections
  const memories = (value as { readonly memories?: unknown }).memories
  const requests = (injections as { readonly requests?: unknown } | undefined)?.requests
  const withContent = (injections as { readonly withContent?: unknown } | undefined)?.withContent
  if (typeof requests !== 'number' || typeof withContent !== 'number' || typeof memories !== 'number') {
    throw new Error('dsh-echo-memory: host returned malformed stats')
  }
  return { injections: { requests, withContent }, memories }
}

/** 走 `/api` 共享通道调用一个 2 段式 endpoint，返回 ok 分支的 value。 */
async function rpcCall(ctx: ClientContext, endpoint: string): Promise<unknown> {
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) {
    throw new Error('dsh-echo-memory: connection service unavailable')
  }
  const result = await connection.rpc.call('/api', endpoint, {})
  if (!result.ok) {
    throw new Error(`dsh-echo-memory: host rejected ${endpoint}: ${result.error.message}`)
  }
  return result.value
}

export type { MemoryCardFace, MemoryCardState, MemoryCardChoiceState, MemoryPurgeState } from './card-controller.ts'
export type { MemoryPluginCardProps } from './MemoryPluginCard.tsx'
export type { MemoryKey } from './locales.ts'