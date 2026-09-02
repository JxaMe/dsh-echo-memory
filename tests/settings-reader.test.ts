/**
 * SettingsReader 纯逻辑测试：三层合并唯一入口的绑定约定
 * （schema 默认 < base < 用户分节）——installSection 参数正确 + setSource 绑定后 get() 现读。
 * 通过假 ctx 捕获 installSection 调用，不依赖真实 DSH settings 运行时。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { createSettingsReader } from '../src/settings-reader.js'
import {
  MEMORY_SETTINGS_NS,
  MEMORY_SETTINGS_SCHEMA,
  type MemorySettings,
} from '../src/settings.js'

const BASE: MemorySettings = {
  injectEnabled: true,
  injectLimit: 8,
  injectMaxChars: 1500,
  captureEnabled: true,
  capturePatterns: ['记住：'],
  captureMaxPerSession: 20,
  deletionMode: 'tombstone',
}

interface InstalledSection {
  ns: string
  schema: unknown
  entry: MemorySettings
  setSource: (current: () => MemorySettings) => void
  onChange: () => void
}

interface SettingsService {
  settings: {
    installSection: (
      _ctx: unknown,
      ns: string,
      schema: unknown,
      entry: MemorySettings,
      opts: { setSource: (current: () => MemorySettings) => void; onChange: () => void },
    ) => void
  }
}

/** 假 ctx：inject 同步回调，installSection 把调用参数捕获到 installed。 */
function makeFake() {
  let installed: InstalledSection | null = null
  const ctx: { inject: (keys: readonly string[], cb: (settingsCtx: SettingsService) => void) => void } = {
    inject(_keys, cb) {
      const service: SettingsService = {
        settings: {
          installSection(_ctx, ns, schema, entry, opts) {
            installed = { ns, schema, entry, setSource: opts.setSource, onChange: opts.onChange }
          },
        },
      }
      cb(service)
    },
  }
  return { ctx, getInstalled: () => installed }
}

/** install 并断言 installSection 确实被调用，返回捕获到的分节。 */
function install(reader: ReturnType<typeof createSettingsReader>): InstalledSection {
  const fake = makeFake()
  reader.install(fake.ctx as unknown as Context, BASE)
  const section = fake.getInstalled()
  assert.ok(section, 'installSection 应被调用')
  return section
}

test('未 install：get() 返回 initial', () => {
  const reader = createSettingsReader(BASE)
  assert.equal(reader.get(), BASE)
})

test('install：installSection 收到 NS / SCHEMA / entry', () => {
  const reader = createSettingsReader(BASE)
  const section = install(reader)
  assert.equal(section.ns, MEMORY_SETTINGS_NS)
  assert.equal(section.schema, MEMORY_SETTINGS_SCHEMA)
  assert.equal(section.entry, BASE)
})

test('install 绑定 setSource 后：get() 现读合并值', () => {
  const reader = createSettingsReader(BASE)
  const section = install(reader)
  const merged: MemorySettings = { ...BASE, injectLimit: 3 }
  section.setSource(() => merged)
  assert.equal(reader.get().injectLimit, 3)
})

test('get() 每次现读不缓存：换源即变', () => {
  const reader = createSettingsReader(BASE)
  const section = install(reader)
  section.setSource(() => BASE)
  assert.equal(reader.get().injectLimit, 8)
  section.setSource(() => ({ ...BASE, injectLimit: 50 }))
  assert.equal(reader.get().injectLimit, 50)
  assert.equal(reader.get().deletionMode, 'tombstone')
})

test('先 get() 后 install：源被替换为合并源，get() 跟随', () => {
  const reader = createSettingsReader(BASE)
  assert.equal(reader.get(), BASE)
  const section = install(reader)
  section.setSource(() => ({ ...BASE, captureEnabled: false }))
  assert.equal(reader.get().captureEnabled, false)
})
