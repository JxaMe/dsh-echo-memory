/**
 * dsh-memory：DSH 专用跨会话记忆插件。
 * 单行挂载（bundle patch `insert` 的 host 平面行），实例化后：
 *  1. 打开 `memory` 存储领域（storage-domain json 后端，落盘 `$DSH_HOME/storages/memory.json`）；
 *  2. 向 tools 部署全局层注册 memory_save / memory_search / memory_forget；
 *  3. 注册 systemPrompt 动态上下文（组装期注入 Top-N 记忆，按会话 cwd 过滤）；
 *  4. 监听 session/event 捕获用户「记住」句式（可配置、按会话限流）。
 * 同时以 `ctx.memory`（Service）向其他 DSH 插件暴露 save/search/forget。
 * @module dsh-memory
 */

import { Context, Service } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-session'
import s from '@deepseek-ai/schemastery'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { memoryDomainSpec, GLOBAL_WORKSPACE } from './domain.js'
import { MemoryStore } from './store.js'
import type { SaveInput, SaveOutcome, SearchHit, SearchOptions } from './store.js'
import { memoryTools } from './tools.js'
import { createCaptureHandler } from './capture.js'
import { memoryContextText } from './prompt.js'
import {
  DEFAULT_CAPTURE_PATTERNS, MEMORY_SETTINGS_NS, MEMORY_SETTINGS_SCHEMA, type MemorySettings,
} from './settings.js'

/** 插件配置：所有部署可调参数都经 cordis.yml 行配置提供，无硬编码 tunable。 */
export interface Config {
  /** 是否向每次模型请求注入记忆上下文。 */
  readonly injectEnabled: boolean
  /** 注入记忆条数上限。 */
  readonly injectLimit: number
  /** 注入文本 UTF-16 长度上限。 */
  readonly injectMaxChars: number
  /** PromptContext 排序序号（同序按注册顺序连接）。 */
  readonly injectOrder: number
  /** 是否自动捕获用户「记住」句式。 */
  readonly captureEnabled: boolean
  /** 触发自动捕获的句式（大小写不敏感子串）。 */
  readonly capturePatterns: string[]
  /** 每个运行期会话的自动捕获条数上限。 */
  readonly captureMaxPerSession: number
  /** 单条记忆正文 UTF-16 长度上限。 */
  readonly contentMaxChars: number
  /** 单条记忆标签上限。 */
  readonly tagsMax: number
  /** 无会话 cwd 可归属时的默认工作区。 */
  readonly defaultWorkspace: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** dsh-memory 提供的能力（供其他 DSH 插件消费）。 */
    memory: MemoryService
  }
}

/** dsh-memory 插件本体：记忆 Service + 工具 + 注入 + 捕获的四合一装配。 */
export default class MemoryService extends Service {
  static inject = ['storageDomain', 'systemPrompt', 'tools']

  /** 配置 schema；缺省值即插件内置行为（与同名 Config 接口对应）。 */
  static Config: s<Config> = s.object({
    injectEnabled: s.boolean().default(true),
    injectLimit: s.number().step(1).min(1).max(50).default(8),
    injectMaxChars: s.number().step(1).min(100).max(20000).default(1500),
    injectOrder: s.number().step(1).default(10),
    captureEnabled: s.boolean().default(true),
    capturePatterns: s.array(s.string()).default([...DEFAULT_CAPTURE_PATTERNS]),
    captureMaxPerSession: s.number().step(1).min(1).max(1000).default(20),
    contentMaxChars: s.number().step(1).min(20).max(2000).default(500),
    tagsMax: s.number().step(1).min(0).max(32).default(8),
    defaultWorkspace: s.string().default(GLOBAL_WORKSPACE),
  })

  private readonly config: Config
  private readonly settingsEntry: MemorySettings
  private readSettings: () => MemorySettings
  private store: MemoryStore | undefined

  /**
   * @param ctx - 宿主上下文（storageDomain/systemPrompt/tools 就绪后才实例化）。
   * @param config - 经 schema 校验并填充缺省值的插件配置。
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'memory')
    this.config = config
    this.settingsEntry = projectSettings(config)
    this.readSettings = () => this.settingsEntry
    // 设置分节：schema 默认 < 组合层 base（本行 cordis.yml 配置）< 用户分节。
    // 消费方（注入提供方、捕获监听器）每次现读解析值，因此更改即时生效。
    installSettingsSection(ctx, MEMORY_SETTINGS_NS, MEMORY_SETTINGS_SCHEMA, this.settingsEntry, {
      setSource: (current) => { this.readSettings = current },
      onChange: () => {},
    })
  }

  /** 打开领域并注册全部能力；任何一步失败都会让插件加载失败（配置错误响亮）。 */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(memoryDomainSpec)
    this.ctx.effect(() => async () => {
      await domain.close()
    }, 'dsh-memory.domainClose')
    const table = domain.table('memories')
    this.store = new MemoryStore(table, {
      contentMaxChars: this.config.contentMaxChars,
      tagsMax: this.config.tagsMax,
    })
    this.registerTools()
    this.registerPrompt()
    this.registerCapture()
    console.log('[dsh-memory] loaded (memory domain open; tools: memory_save, memory_search, memory_forget)')
  }

  /**
   * 保存一条记忆（与 memory_save 工具同一入口）。
   * @param input - 保存输入（见 MemoryStore.save）。
   */
  save(input: SaveInput): Promise<SaveOutcome> {
    return this.requireStore().save(input)
  }

  /**
   * 检索记忆（与 memory_search 工具同一入口）。
   * @param options - 过滤与限量。
   */
  search(options: SearchOptions = {}): SearchHit[] {
    return this.requireStore().search(options)
  }

  /**
   * 删除一条记忆（与 memory_forget 工具同一入口）。
   * @param id - 记录 id。
   */
  forget(id: string): Promise<boolean> {
    return this.requireStore().forget(id)
  }

  private registerTools(): void {
    for (const tool of memoryTools(this.requireStore(), this.config.defaultWorkspace)) {
      this.ctx.tools.register(tool)
    }
  }

  private registerPrompt(): void {
    this.ctx.systemPrompt.context({
      name: 'memory',
      order: this.config.injectOrder,
      text: memoryContextText(this.requireStore(), () => {
        const settings = this.readSettings()
        return {
          enabled: settings.injectEnabled,
          limit: settings.injectLimit,
          maxChars: settings.injectMaxChars,
        }
      }),
    })
  }

  private registerCapture(): void {
    this.ctx.on('session/event', createCaptureHandler(() => {
      const settings = this.readSettings()
      return {
        enabled: settings.captureEnabled,
        patterns: settings.capturePatterns,
        maxPerSession: settings.captureMaxPerSession,
      }
    }, this.requireStore()))
  }

  private requireStore(): MemoryStore {
    const store = this.store
    if (store === undefined) {
      throw new Error('dsh-memory: store not ready (Service.init did not complete)')
    }
    return store
  }
}

export type { MemoryKind, MemoryRecord } from './domain.js'
export type { MemorySource } from './domain.js'
export { GLOBAL_WORKSPACE } from './domain.js'
export { MemoryStore } from './store.js'
export type { SaveInput, SaveOutcome, SearchHit, SearchOptions, StoreLimits } from './store.js'
export type { SearchOutputItem } from './tools.js'
export {
  MEMORY_SETTINGS_NS, MEMORY_SETTINGS_NS_VALUE, MEMORY_SETTINGS_SCHEMA, type MemorySettings,
} from './settings.js'

/** 把插件 Config 的既定点投影为记忆设置分节（可编辑子集，数组浅拷贝防外部改写）。 */
function projectSettings(config: Config): MemorySettings {
  return {
    injectEnabled: config.injectEnabled,
    injectLimit: config.injectLimit,
    injectMaxChars: config.injectMaxChars,
    captureEnabled: config.captureEnabled,
    capturePatterns: [...config.capturePatterns],
    captureMaxPerSession: config.captureMaxPerSession,
  }
}