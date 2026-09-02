/**
 * dsh-echo-memory：DSH 专用跨会话记忆插件。
 * 单行挂载（bundle patch `insert` 的 host 平面行），实例化后：
 *  1. 打开 `memory` 存储领域（storage-domain json 后端，落盘 `$DSH_HOME/storages/memory.json`）；
 *  2. 向 tools 部署全局层注册 memory_save / memory_search / memory_forget / memory_restore / memory_suggest；
 *  3. 注册 systemPrompt 动态上下文（记忆提议提示词，AI 判断是否 memory_suggest）。
 * 对外只走 tools 与 HTTP routes，不提供公开 Service API。
 * @module dsh-echo-memory
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import '@deepseek-ai/dsh-session'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { memoryDomainSpec, GLOBAL_WORKSPACE } from './domain.js'
import { MemoryStore } from './store.js'
import type { SaveInput, SaveOutcome, SearchHit } from './store.js'
import { memoryTools } from './tools.js'
import { suggestionPromptText } from './prompt.js'
import { createRecallMessage, decideRecall, extractQuery, isRecallMessage } from './recall.js'
import { SuggestionStore } from './suggestion-store.js'
import { ensureMemoryFileUsable, quarantineMemoryFile } from './migrate.js'
import {
  DELETION_MODES, MEMORY_SETTINGS_NS, MEMORY_SETTINGS_SCHEMA,
  type DeletionMode, type MemorySettings,
} from './settings.js'
import { registerMemoryRoutes } from './host-routes.js'
import { createSettingsReader } from './settings-reader.js'
import { RecallStore } from './recall-store.js'

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
  /** 单条记忆正文 UTF-16 长度上限。 */
  readonly contentMaxChars: number
  /** 单条记忆标签上限。 */
  readonly tagsMax: number
  /** 无会话 cwd 可归属时的默认工作区。 */
  readonly defaultWorkspace: string
  /** 删除记忆的行为模式（默认墓碑机制）。 */
  readonly deletionMode: DeletionMode
}

/** dsh-echo-memory 插件本体：记忆 Service + 工具 + 注入 + 召回 + 建议的装配。 */
export default class MemoryService extends Service {
  static inject = ['storageDomain', 'systemPrompt', 'tools']

  /** 配置 schema；缺省值即插件内置行为（与同名 Config 接口对应）。 */
  static Config: s<Config> = s.object({
    injectEnabled: s.boolean().default(true),
    injectLimit: s.number().step(1).min(1).max(50).default(8),
    injectMaxChars: s.number().step(1).min(100).max(20000).default(1500),
    injectOrder: s.number().step(1).default(10),
    contentMaxChars: s.number().step(1).min(20).max(2000).default(500),
    tagsMax: s.number().step(1).min(0).max(32).default(8),
    defaultWorkspace: s.string().default(GLOBAL_WORKSPACE),
    deletionMode: s.union(DELETION_MODES).default('tombstone'),
  })

  private readonly config: Config
  private readonly settingsReader: ReturnType<typeof createSettingsReader>
  private store: MemoryStore | undefined
  private readonly recallStore = new RecallStore()
  private readonly suggestionStore = new SuggestionStore()

  /**
   * @param ctx - 宿主上下文（storageDomain/systemPrompt/tools 就绪后才实例化）。
   * @param config - 经 schema 校验并填充缺省值的插件配置。
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'memory')
    this.config = config
    // 设置读取器：schema 默认 < 组合层 base < 用户分节的三层合并只在此一处
    this.settingsReader = createSettingsReader(projectSettings(config))
    this.settingsReader.install(ctx, this.settingsReader.get())
    this.registerRoutes(ctx)
  }

  /** 打开领域并注册全部能力；配置/版本类错误保持响亮失败，文件损坏则自愈（隔离备份 + 空库）。 */
  protected async [Service.init](): Promise<void> {
    const root = storageRoot()
    // 文件级可用性保障：正常迁移；JSON 损坏时隔离备份、以空库继续。
    const recovery = await ensureMemoryFileUsable(root, memoryDomainSpec.version)
    if (recovery.kind === 'recovered-corrupt') this.recordRecovery(recovery.backupPath)
    let domain
    try {
      domain = await this.ctx.storageDomain.open(memoryDomainSpec)
    } catch (error) {
      // 打开失败（记录 schema 校验/读取异常）：文件还在则隔离备份后用空库重开；否则保持响亮失败。
      const backupPath = await quarantineMemoryFile(root).catch(() => null)
      if (backupPath === null) throw error
      this.recordRecovery(backupPath)
      domain = await this.ctx.storageDomain.open(memoryDomainSpec)
    }
    this.ctx.effect(() => () => {
      void domain.close()
    }, 'dsh-echo-memory.domainClose')
    const table = domain.table('memories')
    this.store = new MemoryStore(table, {
      contentMaxChars: this.config.contentMaxChars,
      tagsMax: this.config.tagsMax,
    })
    this.registerTools()
    this.registerPrompt()
    this.registerRecall()
    console.log('[dsh-echo-memory] loaded (memory domain open; tools: memory_save, memory_search, memory_forget, memory_restore, memory_suggest; recall: on-demand; suggestions: on; recycle: on)')
  }

  /** 最近一次存储恢复事件（损坏自动隔离）；null 表示本次启动存储正常。 */
  private recovery: { at: number; backupPath: string } | null = null

  private recordRecovery(backupPath: string): void {
    this.recovery = { at: Date.now(), backupPath }
    console.warn(
      `[dsh-echo-memory] 记忆文件损坏，已隔离备份到 ${backupPath}；本次以空库启动。`
      + '原文件保留在备份中，可手动修复后还原。',
    )
  }

  private storageStatus(): { recovered: { at: number; backupPath: string } | null } {
    return { recovered: this.recovery }
  }

  private async save(input: SaveInput): Promise<SaveOutcome> {
    return this.requireStore().save(input)
  }

  private forget(id: string): Promise<boolean> {
    return this.requireStore().forget(id, this.settingsReader.get().deletionMode)
  }

  private restore(id: string): Promise<boolean> {
    return this.requireStore().restore(id)
  }

  private purgeTombstones(): Promise<number> {
    return this.requireStore().purgeDeleted()
  }

  private listDeleted(limit: number = 20): readonly import('./domain.js').MemoryRecord[] {
    return this.requireStore().listDeleted(limit)
  }

  private purgeOne(id: string): Promise<boolean> {
    return this.requireStore().purgeOne(id)
  }

  private updateMemory(id: string, patch: { content?: string; tags?: readonly string[] }): Promise<boolean> {
    return this.requireStore().update(id, patch)
  }

  private listRecent(limit: number = 20): readonly import('./domain.js').MemoryRecord[] {
    return this.requireStore().listRecent(limit)
  }

  private searchRecent(query: string, limit: number = 20): readonly import('./store.js').SearchHit[] {
    if (query.trim().length === 0) return this.listRecent(limit).map(r => ({ record: r, score: 0 }))
    return this.requireStore().search({ query, limit })
  }

  private memoryStats(): { readonly injections: { readonly requests: number; readonly withContent: number }; readonly memories: number } {
    const store = this.requireStore()
    return { injections: store.injectionStats, memories: store.liveCount() }
  }

  /** 全部 HTTP 路由（统计/墓碑清理/列表/保存等，供 card/Dock fetch）— 薄转接，逻辑在 host-routes */
  private registerRoutes(ctx: Context): void {
    registerMemoryRoutes(ctx, {
      readSettings: () => this.settingsReader.get(),
      getLastRecall: () => this.recallStore.last ?? { at: 0, query: '', hits: [] },
      getRecallHistory: () => this.recallStore.list(),
      getSuggestions: () => this.suggestionStore.list(),
      dismissSuggestion: (id) => this.suggestionStore.dismiss(id),
      confirmSuggestion: async (id) => {
        const entry = this.suggestionStore.list().find((e) => e.id === id)
        if (!entry) return { saved: false, id }
        const outcome = await this.save({
          workspace: entry.workspace,
          content: entry.content,
          kind: entry.kind as never,
          tags: entry.tags as never,
          source: 'agent',
        })
        this.suggestionStore.dismiss(id)
        return { saved: true, id: outcome.id }
      },
      // 以下刻意不吞异常：内部失败如实抛给 HTTP 层（→500），client 的 failed/error 态才能真实生效，
      // 而不是伪装成空列表/空回收站/清了 0 条。
      memoryStats: () => this.memoryStats(),
      purgeTombstones: async () => this.purgeTombstones(),
      listDeleted: (limit) => this.listDeleted(limit),
      restore: async (id) => this.restore(id),
      purgeOne: async (id) => this.purgeOne(id),
      updateMemory: async (id, patch) => this.updateMemory(id, patch),
      listRecent: (limit) => this.listRecent(limit),
      searchRecent: (q, limit) => this.searchRecent(q, limit),
      save: async (input) => this.save(input),
      forget: async (id) => this.forget(id),
      storageStatus: () => this.storageStatus(),
      defaultWorkspace: this.config.defaultWorkspace,
    })
  }

  private registerTools(): void {
    for (const tool of memoryTools(
      this.requireStore(),
      this.config.defaultWorkspace,
      () => this.settingsReader.get().deletionMode,
      this.suggestionStore,
    )) {
      this.ctx.tools.register(tool)
    }
  }

  private registerPrompt(): void {
    this.ctx.systemPrompt.context({
      name: 'memory-suggest',
      order: this.config.injectOrder + 1,
      text: suggestionPromptText(),
    })
  }

  private registerRecall(): void {
    let warnedOnce = false
    this.ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      try { signal.throwIfAborted() } catch { return { kind: 'reject' as const, reason: 'aborted' } }
      const decision = await next()
      if (decision.kind === 'reject') return decision
      // 幂等：已含 recall 注入则不再注入，避免重试/多插件重复
      if (messages.some(m => isRecallMessage(m as never)) || decision.messages.some(m => isRecallMessage(m as never))) return decision
      try {
        signal.throwIfAborted()
        const recall = decideRecall(this.requireStore(), () => {
          const s = this.settingsReader.get()
          return { enabled: s.injectEnabled, limit: s.injectLimit, maxChars: s.injectMaxChars }
        }, agent, messages)
        if (recall === undefined) return decision
        // 记录召回供 Dock 拉取（latest + history 缓冲，缝隙单一）
        try {
          const q = extractQuery(messages).slice(0, 200)
          this.recallStore.record({
            at: Date.now(),
            query: q,
            hits: recall.rawHits.map(h => ({ id: h.record.id, kind: h.record.kind, content: h.record.content, tags: [...h.record.tags], strength: h.record.strength })),
          })
        } catch {}
        const injection = createRecallMessage(recall.text, recall.hits)
        return { ...decision, messages: [...decision.messages, injection] }
      } catch (error) {
        if (!warnedOnce) {
          warnedOnce = true
          console.warn('[dsh-echo-memory] recall handler failed; skipping injection for this instance', error)
        }
        return decision
      }
    })
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
  return dshHomePath('storages')
}

export type { MemoryKind, MemoryRecord } from './domain.js'
export type { MemorySource } from './domain.js'
export { GLOBAL_WORKSPACE } from './domain.js'
export { MemoryStore } from './store.js'
export type { SaveInput, SaveOutcome, SearchHit, SearchOptions, StoreLimits } from './store.js'
export type { SearchOutputItem } from './tools.js'
export {
  DELETION_MODES, MEMORY_SETTINGS_NS, MEMORY_SETTINGS_SCHEMA,
  type DeletionMode, type MemorySettings,
} from './settings.js'

/** 把插件 Config 的既定点投影为记忆设置分节（可编辑子集，数组浅拷贝防外部改写）。 */
function projectSettings(config: Config): MemorySettings {
  return {
    injectEnabled: config.injectEnabled,
    injectLimit: config.injectLimit,
    injectMaxChars: config.injectMaxChars,
    deletionMode: config.deletionMode,
  }
}