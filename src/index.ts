/**
 * dsh-echo-memory：DSH 专用跨会话记忆插件。
 * 单行挂载（bundle patch `insert` 的 host 平面行），实例化后：
 *  1. 打开 `memory` 存储领域（storage-domain json 后端，落盘 `$DSH_HOME/storages/memory.json`）；
 *  2. 向 tools 部署全局层注册 memory_save / memory_search / memory_forget；
 *  3. 注册 systemPrompt 动态上下文（组装期注入 Top-N 记忆，按会话 cwd 过滤）；
 *  4. 监听 session/event 捕获用户「记住」句式（可配置、按会话限流）。
 * 同时以 `ctx.memory`（Service）向其他 DSH 插件暴露 save/search/forget。
 * @module dsh-echo-memory
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { join } from 'node:path'
import '@deepseek-ai/dsh-session'
import s from '@deepseek-ai/schemastery'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
// Type-only：pull `ctx.connection` 的 Context merge 与 RPC 类型（host 侧通道注册）。
import type { HostConnectionRpc } from '@deepseek-ai/dsh-client-connection'
import { memoryDomainSpec, GLOBAL_WORKSPACE } from './domain.js'
import { MemoryStore } from './store.js'
import type { SaveInput, SaveOutcome, SearchHit, SearchOptions } from './store.js'
import { memoryTools } from './tools.js'
import { CaptureFeed, createCaptureHandler } from './capture.js'
import { memoryContextText } from './prompt.js'
import { migrateMemoryFile } from './migrate.js'
import {
  DEFAULT_CAPTURE_PATTERNS, DELETION_MODES, MEMORY_SETTINGS_NS, MEMORY_SETTINGS_SCHEMA,
  type DeletionMode, type MemorySettings,
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
  /** 删除记忆的行为模式（默认墓碑机制）。 */
  readonly deletionMode: DeletionMode
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** dsh-echo-memory 提供的能力（供其他 DSH 插件消费）。 */
    memory: MemoryService
  }
}

/**
 * 浏览器卡片 RPC endpoints（`/api` 共享通道上的 2 段式 endpoint）。
 * 两侧拼写必须一致：host 注册与 client 调用各自拼写（跨半侧不产生值依赖，
 * 与官方 `SHELL_NS` 约定同一理由）。
 */
const MEMORY_PURGE_ENDPOINT = 'dsh-echo-memory/purge-tombstones'
const MEMORY_STATS_ENDPOINT = 'dsh-echo-memory/stats'

/** dsh-echo-memory 插件本体：记忆 Service + 工具 + 注入 + 捕获的四合一装配。 */
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
    deletionMode: s.union(DELETION_MODES).default('tombstone'),
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
    // 消费方（注入提供方、捕获监听器、删除执行）每次现读解析值，因此更改即时生效。
    installSettingsSection(ctx, MEMORY_SETTINGS_NS, MEMORY_SETTINGS_SCHEMA, this.settingsEntry, {
      setSource: (current) => { this.readSettings = current },
      onChange: () => {},
    })
    // 浏览器卡片 RPC（彻底删除 + 统计）通道（官方 gateway 同款 intercept 模式）。
    this.registerCardRpc(ctx)
  }

  /** 打开领域并注册全部能力；任何一步失败都会让插件加载失败（配置错误响亮）。 */
  protected async [Service.init](): Promise<void> {
    // 领域版本迁移（文件级，open 之前）：schema 破坏性变更在此升级旧库。
    await migrateMemoryFile(storageRoot(), memoryDomainSpec.version)
    const domain = await this.ctx.storageDomain.open(memoryDomainSpec)
    this.ctx.effect(() => async () => {
      await domain.close()
    }, 'dsh-echo-memory.domainClose')
    const table = domain.table('memories')
    this.store = new MemoryStore(table, {
      contentMaxChars: this.config.contentMaxChars,
      tagsMax: this.config.tagsMax,
    })
    this.registerTools()
    this.registerPrompt()
    this.registerCapture()
    console.log('[dsh-echo-memory] loaded (memory domain open; tools: memory_save, memory_search, memory_forget)')
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
   * 删除一条记忆（与 memory_forget 工具同一入口，模式现读设置）。
   * @param id - 记录 id。
   */
  forget(id: string): Promise<boolean> {
    return this.requireStore().forget(id, this.readSettings().deletionMode)
  }

  /**
   * 彻底清除全部墓碑记录（浏览器卡片「彻底删除」按钮的后端动作）。
   * @returns 本次清除的墓碑条数。
   */
  purgeTombstones(): Promise<number> {
    return this.requireStore().purgeDeleted()
  }

  /** 运行期统计（浏览器卡片展示）：注入次数/命中数 + 活跃记忆条数。 */
  memoryStats(): { readonly injections: { readonly requests: number; readonly withContent: number }; readonly memories: number } {
    const store = this.requireStore()
    return { injections: store.injectionStats, memories: store.liveCount() }
  }

  /** 注册卡片 RPC（彻底删除 + 统计）：官方 gateway 同款 intercept 模式（通道 `/api`，authority trusted-host）。 */
  private registerCardRpc(ctx: Context): void {
    ctx.inject(['connection'], (connectionCtx) => {
      connectionCtx.connection.rpc.intercept(
        '/api',
        endpoint => endpoint === MEMORY_PURGE_ENDPOINT || endpoint === MEMORY_STATS_ENDPOINT,
        async (endpoint) => {
          const wrap = (value: unknown) => ({ ok: true, value } as const)
          try {
            if (endpoint === MEMORY_PURGE_ENDPOINT) {
              return wrap({ purged: await this.purgeTombstones() })
            }
            if (endpoint === MEMORY_STATS_ENDPOINT) {
              return wrap(this.memoryStats())
            }
            return { ok: false, error: { code: 'internal', message: `unknown endpoint: ${endpoint}`, details: {} } } as const
          } catch (error) {
            return {
              ok: false,
              error: {
                code: 'internal',
                message: error instanceof Error ? error.message : String(error),
                details: {},
              },
            } as const
          }
        },
        { authority: 'trusted-host' },
      )
    })
  }

  private registerTools(): void {
    for (const tool of memoryTools(
      this.requireStore(),
      this.config.defaultWorkspace,
      () => this.readSettings().deletionMode,
    )) {
      this.ctx.tools.register(tool)
    }
  }

  private readonly captureFeed = new CaptureFeed()

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
      }, this.captureFeed),
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
    }, this.requireStore(), this.captureFeed))
  }

  private requireStore(): MemoryStore {
    const store = this.store
    if (store === undefined) {
      throw new Error('dsh-echo-memory: store not ready (Service.init did not complete)')
    }
    return store
  }
}

/** 存储后端根目录（与 dsh 标准装配一致：`$DSH_HOME/storages`，默认 `~/.dsh/storages`）。 */
function storageRoot(): string {
  const home = process.env.DSH_HOME ?? homedir()
  return join(home, 'storages')
}

export type { MemoryKind, MemoryRecord } from './domain.js'
export type { MemorySource } from './domain.js'
export { GLOBAL_WORKSPACE } from './domain.js'
export { MemoryStore } from './store.js'
export type { SaveInput, SaveOutcome, SearchHit, SearchOptions, StoreLimits } from './store.js'
export type { SearchOutputItem } from './tools.js'
export {
  DELETION_MODES, MEMORY_SETTINGS_NS, MEMORY_SETTINGS_NS_VALUE, MEMORY_SETTINGS_SCHEMA,
  type DeletionMode, type MemorySettings,
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
    deletionMode: config.deletionMode,
  }
}