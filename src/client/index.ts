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
import type { MemoryStatsPayload } from './card-controller.ts'
import { MemoryPluginCard } from './MemoryPluginCard.tsx'
import { createElement } from 'react'
// @ts-ignore platform external provided by shell
import { createRoot } from 'react-dom/client'
import { en, zh, type MemoryKey } from './locales.ts'
import { GlobalDock } from './GlobalDock.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 记忆设置卡片的字典命名空间。 */
    'settings.memory': MemoryKey
  }
}

// 命名空间值在浏览器侧拼写而非从 Host 包导入：client 包不得值依赖 Host 包
// （与官方 bash-card-controller 的 SHELL_NS 同一约定）。
const MEMORY_SETTINGS_NS = 'memory'

/** 本卡片的 locale 命名空间。 */
const LOCALE_NS = 'settings.memory'

/** 必需服务：槽位注册、文案、连接载体、设置 scope 与远程失效转发。 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * 浏览器插件主体：注册记忆卡片。
 * @param ctx - 浏览器 cordis 上下文（上述注入就绪后执行）。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-echo-memory: settings card dictionaries')
  // 全站悬浮 Dock（瞬态预览，常驻右下角可唤起）
  ctx.effect(() => {
    const container = document.createElement('div')
    container.id = 'dshm-global-dock-root'
    document.body.appendChild(container)
    const root = createRoot(container)
    root.render(createElement(GlobalDock))
    return () => {
      root.unmount()
      container.remove()
    }
  }, 'dsh-echo-memory: global dock')
  const controller = new MemoryCardController(
    ctx.settingsScope.bind<MemorySettings>({ namespace: MEMORY_SETTINGS_NS }),
    () => invokePurge(),
    () => invokeStats(),
    () => invokeRecycle(),
    (id) => invokeRestore(id),
    (id) => invokePurgeOne(id),
    (id, patch) => invokeUpdate(id, patch),
  )
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: MEMORY_SETTINGS_NS,
    locale: LOCALE_NS,
    inject: () => controller.inject(),
  }, MemoryPluginCard))
}

/** 对 Host HTTP 路由发起请求：非 2xx 抛错（失败如实可见），返回解析后的 JSON。 */
async function fetchJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, init)
  if (!res.ok) throw new Error(`${path} fetch failed HTTP ${res.status}`)
  return res.json() as unknown
}

async function invokePurge(): Promise<number> {
  const value = await fetchJson('/api/dsh-echo-memory/purge', { method: 'POST', headers: { 'Accept': 'application/json' } })
  const purged = (value as { readonly purged?: unknown }).purged
  return typeof purged === 'number' ? purged : 0
}

async function invokeStats(): Promise<MemoryStatsPayload> {
  const value = await fetchJson('/api/dsh-echo-memory/stats', { method: 'GET', headers: { 'Accept': 'application/json' } })
  const injections = (value as { readonly injections?: unknown }).injections
  const memories = (value as { readonly memories?: unknown }).memories
  const requests = (injections as { readonly requests?: unknown } | undefined)?.requests
  const withContent = (injections as { readonly withContent?: unknown } | undefined)?.withContent
  if (typeof requests !== 'number' || typeof withContent !== 'number' || typeof memories !== 'number') {
    throw new Error('dsh-echo-memory: host returned malformed stats')
  }
  return { injections: { requests, withContent }, memories }
}

async function invokeRecycle(): Promise<import('./card-controller.ts').RecycleItem[]> {
  const value = await fetchJson('/api/dsh-echo-memory/deleted?limit=20', { method: 'GET', headers: { 'Accept': 'application/json' } })
  const items = (value as { readonly items?: unknown }).items
  if (!Array.isArray(items)) return []
  return items as import('./card-controller.ts').RecycleItem[]
}

async function invokeRestore(id: string): Promise<boolean> {
  const value = await fetchJson('/api/dsh-echo-memory/restore', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ id }) })
  return Boolean((value as { readonly restored?: unknown }).restored)
}

async function invokePurgeOne(id: string): Promise<boolean> {
  const value = await fetchJson('/api/dsh-echo-memory/purge-one', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ id }) })
  return Boolean((value as { readonly purged?: unknown }).purged)
}

async function invokeUpdate(id: string, patch: { content?: string }): Promise<boolean> {
  const value = await fetchJson('/api/dsh-echo-memory/update', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ id, ...patch }) })
  return Boolean((value as { readonly updated?: unknown }).updated)
}



export type { MemoryCardFace, MemoryCardState, MemoryCardChoiceState, MemoryPurgeState } from './card-controller.ts'
export type { MemoryPluginCardProps } from './MemoryPluginCard.tsx'
export type { MemoryKey } from './locales.ts'