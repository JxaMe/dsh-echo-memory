/**
 * dsh-echo-memory 浏览器半侧：把记忆设置卡片注册进「插件配置」分区的
 * `settings.plugin.item` 槽位（key = 与 Host 一致的 `memory` 命名空间），
 * 由 ui-settings-plugins 的 configurable 标签页按命名空间配对渲染。
 * 跨插件协作只走服务（slots/locale/settingsScope），不产生值导入。
 * @module dsh-echo-memory/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only：pull ctx.settingsScope 的 Context merge。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only：pull `settings.plugin.item` 的 SlotMap 声明（本卡片注册的槽位）。
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only：pull client 侧 `ctx.connection` 句柄类型（值不入包）。
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// 与 Host 共享的字段类型（type-only，擦除后不产生运行时依赖）。
import type { MemorySettings } from '../settings.ts'
import { MemoryCardController } from './card-controller.ts'
import type { MemoryCardFace } from './card-controller.ts'
import { MemoryPluginCard } from './MemoryPluginCard.tsx'
import type { MemoryPluginCardProps } from './MemoryPluginCard.tsx'
import { MemoryInjectionDock } from './MemoryInjectionDock.tsx'
import type { InjectionPreview } from './MemoryInjectionDock.tsx'
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
const MEMORY_PREVIEW_ENDPOINT = 'dsh-echo-memory/injection-preview'

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
  // 会话注入可视化：输入框上方折叠条（conversation.input.dock，session 作用域， additive）
  // ponytail: any cast avoids adding dsh-client-ui-conversation dep for single dock entry
  ;(ctx.slots.inject as unknown as (key: string, fn: () => () => void) => void)('conversation.input.dock', () => (ctx.slots.register as unknown as (opts: unknown, comp: unknown) => () => void)({
    name: 'conversation.input.dock',
    id: 'memory-injection-preview',
    order: 5,
    locale: LOCALE_NS,
    inject: () => ({
      fetchPreview: (workspace: string) => invokePreview(ctx, workspace),
    }),
  }, MemoryInjectionDock))
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

/** 拉取本会话会注入的记忆预览（走 webServer 直连，绕过 connection 单拦截器限制）。 */
async function invokePreview(_ctx: ClientContext, workspace: string): Promise<InjectionPreview> {
  const res = await fetch(`/api/dsh-echo-memory/preview?workspace=${encodeURIComponent(workspace)}`, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  })
  if (!res.ok) throw new Error(`preview fetch failed HTTP ${res.status}`)
  const value = await res.json() as unknown
  const enabled = (value as { readonly enabled?: unknown }).enabled
  const ws = (value as { readonly workspace?: unknown }).workspace
  const limit = (value as { readonly limit?: unknown }).limit
  const maxChars = (value as { readonly maxChars?: unknown }).maxChars
  const items = (value as { readonly items?: unknown }).items
  const text = (value as { readonly text?: unknown }).text
  if (typeof enabled !== 'boolean' || typeof ws !== 'string' || typeof limit !== 'number' || typeof maxChars !== 'number' || !Array.isArray(items) || typeof text !== 'string') {
    throw new Error('dsh-echo-memory: host returned malformed preview')
  }
  return value as InjectionPreview
}

/** 走 `/api` 共享通道调用一个 2 段式 endpoint，返回 ok 分支的 value。 */
async function rpcCall(ctx: ClientContext, endpoint: string, payload: unknown = {}): Promise<unknown> {
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) {
    throw new Error('dsh-echo-memory: connection service unavailable')
  }
  const result = await connection.rpc.call('/api', endpoint, payload as never)
  if (!result.ok) {
    throw new Error(`dsh-echo-memory: host rejected ${endpoint}: ${result.error.message}`)
  }
  return result.value
}

export type { MemoryCardFace, MemoryCardState, MemoryCardChoiceState, MemoryPurgeState } from './card-controller.ts'
export type { MemoryPluginCardProps } from './MemoryPluginCard.tsx'
export type { MemoryKey } from './locales.ts'