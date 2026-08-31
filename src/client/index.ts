/**
 * dsh-memory 浏览器半侧：把记忆设置卡片注册进「插件配置」分区的
 * `settings.plugin.item` 槽位（key = 与 Host 一致的 `memory` 命名空间），
 * 由 ui-settings-plugins 的 configurable 标签页按命名空间配对渲染。
 * 跨插件协作只走服务（slots/locale/settingsScope），不产生值导入。
 * @module dsh-memory/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only：pull ctx.settingsScope 的 Context merge。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only：pull `settings.plugin.item` 的 SlotMap 声明（本卡片注册的槽位）。
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
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

/** 必需服务：槽位注册、文案、连接载体、设置 scope 与远程失效转发。 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * 浏览器插件主体：注册记忆卡片。
 * @param ctx - 浏览器 cordis 上下文（上述注入就绪后执行）。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-memory: settings card dictionaries')
  const controller = new MemoryCardController(
    ctx.settingsScope.bind<MemorySettings>({ namespace: MEMORY_SETTINGS_NS_VALUE }),
  )
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: MEMORY_SETTINGS_NS_VALUE,
    locale: LOCALE_NS,
    inject: () => controller.inject(),
  }, MemoryPluginCard))
}

export type { MemoryCardFace, MemoryCardState } from './card-controller.ts'
export type { MemoryPluginCardProps } from './MemoryPluginCard.tsx'
export type { MemoryKey } from './locales.ts'