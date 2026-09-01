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
    () => invokeRecycle(ctx),
    (id) => invokeRestore(ctx, id),
    (id) => invokePurgeOne(ctx, id),
    (id, patch) => invokeUpdate(ctx, id, patch),
  )
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: MEMORY_SETTINGS_NS_VALUE,
    locale: LOCALE_NS,
    inject: () => controller.inject(),
  }, MemoryPluginCard))
}

/**
 * 调用 Host 的「彻底删除」——改走 webServer 直连
 * @param _ctx - 未使用，保留签名
 * @returns 本次清除的墓碑条数；失败抛出
 */
async function invokePurge(_ctx: ClientContext): Promise<number> {
  const res = await fetch('/api/dsh-echo-memory/purge', { method: 'POST', headers: { 'Accept': 'application/json' } })
  if (!res.ok) throw new Error(`purge fetch failed HTTP ${res.status}`)
  const value = await res.json() as unknown
  const purged = (value as { readonly purged?: unknown }).purged
  return typeof purged === 'number' ? purged : 0
}

/** 拉取 Host 运行期统计（注入次数/命中 + 记忆条数）——改走 webServer 直连 */
async function invokeStats(_ctx: ClientContext): Promise<MemoryStatsPayload> {
  const res = await fetch('/api/dsh-echo-memory/stats', { method: 'GET', headers: { 'Accept': 'application/json' } })
  if (!res.ok) throw new Error(`stats fetch failed HTTP ${res.status}`)
  const value = await res.json() as unknown
  const injections = (value as { readonly injections?: unknown }).injections
  const memories = (value as { readonly memories?: unknown }).memories
  const requests = (injections as { readonly requests?: unknown } | undefined)?.requests
  const withContent = (injections as { readonly withContent?: unknown } | undefined)?.withContent
  if (typeof requests !== 'number' || typeof withContent !== 'number' || typeof memories !== 'number') {
    throw new Error('dsh-echo-memory: host returned malformed stats')
  }
  return { injections: { requests, withContent }, memories }
}

async function invokeRecycle(_ctx: ClientContext): Promise<import('./card-controller.ts').RecycleItem[]> {
  const res = await fetch('/api/dsh-echo-memory/deleted?limit=20', { method: 'GET', headers: { 'Accept': 'application/json' } })
  if (!res.ok) throw new Error(`recycle fetch failed HTTP ${res.status}`)
  const value = await res.json() as unknown
  const items = (value as { readonly items?: unknown }).items
  if (!Array.isArray(items)) return []
  return items as import('./card-controller.ts').RecycleItem[]
}

async function invokeRestore(_ctx: ClientContext, id: string): Promise<boolean> {
  const res = await fetch('/api/dsh-echo-memory/restore', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ id }) })
  if (!res.ok) throw new Error(`restore failed HTTP ${res.status}`)
  const value = await res.json() as unknown
  return Boolean((value as { readonly restored?: unknown }).restored)
}

async function invokePurgeOne(_ctx: ClientContext, id: string): Promise<boolean> {
  const res = await fetch('/api/dsh-echo-memory/purge-one', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ id }) })
  if (!res.ok) throw new Error(`purge-one failed HTTP ${res.status}`)
  const value = await res.json() as unknown
  return Boolean((value as { readonly purged?: unknown }).purged)
}

async function invokeUpdate(_ctx: ClientContext, id: string, patch: { content?: string }): Promise<boolean> {
  const res = await fetch('/api/dsh-echo-memory/update', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ id, ...patch }) })
  if (!res.ok) throw new Error(`update failed HTTP ${res.status}`)
  const value = await res.json() as unknown
  return Boolean((value as { readonly updated?: unknown }).updated)
}



export type { MemoryCardFace, MemoryCardState, MemoryCardChoiceState, MemoryPurgeState } from './card-controller.ts'
export type { MemoryPluginCardProps } from './MemoryPluginCard.tsx'
export type { MemoryKey } from './locales.ts'