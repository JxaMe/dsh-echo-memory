/**
 * 设置读取器：schema 默认 < 组合层 base < 用户分节 的三层合并只在此一处。
 * 消费方（注入/捕获/删除/工具）通过 get() 现读，保存面板即生效。
 * @module dsh-echo-memory/settings-reader
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  MEMORY_SETTINGS_NS,
  MEMORY_SETTINGS_SCHEMA,
  type MemorySettings,
} from './settings.js'

export interface SettingsReader {
  /** 现读合并后的设置（每调用一次解析一次）。 */
  get(): MemorySettings
  /** 注册设置分节并绑定三层合并源（installSection 的 setSource 回调）。 */
  install(ctx: Context, entry: MemorySettings): void
}

/**
 * 构造设置读取器：首次 get() 之前先 install 绑定源，之后每次现读。
 * @param initial - 插件 Config 投影的初始默认分节（schema < base 已合并到 Config）。
 */
export function createSettingsReader(initial: MemorySettings): SettingsReader {
  let raw: () => MemorySettings = () => initial
  return {
    get(): MemorySettings {
      return raw()
    },
    install(ctx: Context, entry: MemorySettings): void {
      ctx.inject(['settings'], (settingsCtx) => {
        settingsCtx.settings.installSection(ctx, MEMORY_SETTINGS_NS, MEMORY_SETTINGS_SCHEMA, entry, {
          setSource: (current: () => MemorySettings) => { raw = current },
          onChange: () => {},
        })
      })
    },
  }
}
