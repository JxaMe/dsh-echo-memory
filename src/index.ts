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
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import '@deepseek-ai/dsh-session'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { memoryDomainSpec, GLOBAL_WORKSPACE } from './domain.js'
import { MemoryStore } from './store.js'
import type { SaveInput, SaveOutcome, SearchHit, SearchOptions } from './store.js'
import { memoryTools } from './tools.js'
import { CaptureFeed, createCaptureHandler } from './capture.js'
import { memoryContextText } from './prompt.js'
import { createRecallMessage, decideRecall, extractQuery } from './recall.js'
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
  private lastRecall: { at: number; query: string; hits: Array<{ id: string; kind: string; content: string; tags: readonly string[]; strength: number }> } | null = null
  private recallHistory: Array<{ at: number; query: string; hits: Array<{ id: string; kind: string; content: string; tags: readonly string[]; strength: number }> }> = []
  private static readonly MAX_RECALL_HISTORY = 20

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
    // alpha.2 起使用 ctx.settings.installSection(owner, ns, schema, entry, hooks)
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, MEMORY_SETTINGS_NS, MEMORY_SETTINGS_SCHEMA, this.settingsEntry, {
        setSource: (current: () => MemorySettings) => { this.readSettings = current },
        onChange: () => {},
      })
    })
    this.registerPreviewRoute(ctx)
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
    this.registerRecall()
    this.registerCapture()
    console.log('[dsh-echo-memory] loaded (memory domain open; tools: memory_save, memory_search, memory_forget, memory_restore; recall: on-demand; recycle: on)')
  }

  /**
   * 保存一条记忆（与 memory_save 工具同一入口）。
   * @param input - 保存输入（见 MemoryStore.save）。
   */
  async save(input: SaveInput): Promise<SaveOutcome> {
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

  /** 恢复一条墓碑记忆（兼容别名 restoreDeleted） */
  restore(id: string): Promise<boolean> {
    return this.requireStore().restore(id)
  }

  /** @deprecated 用 restore */
  restoreDeleted(id: string): Promise<boolean> {
    return this.restore(id)
  }

  /**
   * 彻底清除全部墓碑记录（浏览器卡片「彻底删除」按钮的后端动作）。
   * @returns 本次清除的墓碑条数。
   */
  purgeTombstones(): Promise<number> {
    return this.requireStore().purgeDeleted()
  }

  /** 列出墓碑（回收站） */
  listDeleted(limit: number = 20): readonly import('./domain.js').MemoryRecord[] {
    return this.requireStore().listDeleted(limit)
  }

  /** 单条墓碑彻底删除 */
  purgeOne(id: string): Promise<boolean> {
    return this.requireStore().purgeOne(id)
  }

  /** 更新记忆 */
  updateMemory(id: string, patch: { content?: string; tags?: readonly string[] }): Promise<boolean> {
    return this.requireStore().update(id, patch)
  }

  /** 最近活跃记忆（供 Dock 纯管理面板） */
  listRecent(limit: number = 20): readonly import('./domain.js').MemoryRecord[] {
    return this.requireStore().listRecent(limit)
  }

  /** 搜索（供 Dock 搜索） */
  searchRecent(query: string, limit: number = 20): readonly import('./store.js').SearchHit[] {
    if (query.trim().length === 0) return this.listRecent(limit).map(r => ({ record: r, score: 0 }))
    return this.requireStore().search({ query, limit })
  }

  /** 运行期统计（浏览器卡片展示）：注入次数/命中数 + 活跃记忆条数。 */
  memoryStats(): { readonly injections: { readonly requests: number; readonly withContent: number }; readonly memories: number } {
    const store = this.requireStore()
    return { injections: store.injectionStats, memories: store.liveCount() }
  }

  /** 统计/墓碑清理的 HTTP 直连（供 card/Dock fetch） */
  private registerPreviewRoute(ctx: Context): void {
    ctx.inject(['webServer'], (webCtx) => {
      const regs: Array<() => void> = []
      const json = (res: import('node:http').ServerResponse, body: unknown, status = 200): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const route = (path: string, handler: (req: import('node:http').IncomingMessage) => Promise<unknown>): void => {
        regs.push(webCtx.webServer.register({
          kind: 'exact',
          path,
          handler: async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
            try {
              const body = await handler(req)
              json(res, body)
            } catch (error) {
              json(res, { error: String(error) }, 500)
            }
          },
        }))
      }
      route('/api/dsh-echo-memory/stats', async () => this.memoryStats())
      route('/api/dsh-echo-memory/purge', async () => ({ purged: await this.purgeTombstones() }))
      route('/api/dsh-echo-memory/deleted', async (req) => {
        const url = new URL(req.url ?? '/api/dsh-echo-memory/deleted', 'http://localhost')
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '20') || 20))
        return { items: this.listDeleted(limit) }
      })
      route('/api/dsh-echo-memory/restore', async (req) => {
        const body = await readJsonBody(req) as { id?: unknown }
        const id = typeof body.id === 'string' ? body.id : ''
        if (!id) throw new Error('missing id')
        return { restored: await this.restore(id) }
      })
      route('/api/dsh-echo-memory/purge-one', async (req) => {
        const body = await readJsonBody(req) as { id?: unknown }
        const id = typeof body.id === 'string' ? body.id : ''
        if (!id) throw new Error('missing id')
        return { purged: await this.purgeOne(id) }
      })
      route('/api/dsh-echo-memory/update', async (req) => {
        const body = await readJsonBody(req) as { id?: unknown; content?: unknown; tags?: unknown }
        const id = typeof body.id === 'string' ? body.id : ''
        if (!id) throw new Error('missing id')
        const content = typeof body.content === 'string' ? body.content : undefined
        const tags = Array.isArray(body.tags) ? (body.tags as string[]) : undefined
        const patch: { content?: string; tags?: readonly string[] } = {}
        if (content !== undefined) patch.content = content
        if (tags !== undefined) patch.tags = tags
        return { updated: await this.updateMemory(id, patch) }
      })
      route('/api/dsh-echo-memory/last-recall', async () => this.lastRecall ?? { at: 0, query: '', hits: [] })
      route('/api/dsh-echo-memory/recall-history', async () => ({ items: [...this.recallHistory] }))
      route('/api/dsh-echo-memory/list', async (req) => {
        const url = new URL(req.url ?? '/api/dsh-echo-memory/list', 'http://localhost')
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? '20') || 20))
        const q = url.searchParams.get('q') ?? ''
        const items = q.trim().length > 0
          ? this.searchRecent(q, limit).map(h => h.record)
          : this.listRecent(limit)
        return { items }
      })
      route('/api/dsh-echo-memory/save', async (req) => {
        const body = await readJsonBody(req) as { content?: unknown; tags?: unknown; kind?: unknown; workspace?: unknown }
        const content = typeof body.content === 'string' ? body.content : ''
        const tags = Array.isArray(body.tags) ? (body.tags as string[]) : undefined
        const kind = typeof body.kind === 'string' ? body.kind as import('./domain.js').MemoryKind : undefined
        const workspace = typeof body.workspace === 'string' ? body.workspace : this.config.defaultWorkspace
        return this.save({ content, tags, kind, workspace })
      })
      route('/api/dsh-echo-memory/forget', async (req) => {
        const body = await readJsonBody(req) as { id?: unknown }
        const id = typeof body.id === 'string' ? body.id : ''
        if (!id) throw new Error('missing id')
        return { ok: await this.forget(id) }
      })
      return () => { for (const dispose of regs) dispose() }
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

  private registerRecall(): void {
    let warnedOnce = false
    this.ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      try {
        signal.throwIfAborted()
        const recall = decideRecall(this.requireStore(), () => {
          const s = this.readSettings()
          return { enabled: s.injectEnabled, limit: s.injectLimit, maxChars: s.injectMaxChars }
        }, agent, messages)
        if (recall === undefined) return decision
        // 记录最近一次召回，供全局 Dock 瞬态展示 + 历史
        try {
          const q = extractQuery(messages).slice(0, 200)
          const entry = {
            at: Date.now(),
            query: q,
            hits: recall.rawHits.map(h => ({ id: h.record.id, kind: h.record.kind, content: h.record.content, tags: [...h.record.tags], strength: h.record.strength })),
          }
          this.lastRecall = entry
          this.recallHistory.unshift(entry)
          if (this.recallHistory.length > MemoryService.MAX_RECALL_HISTORY) this.recallHistory.length = MemoryService.MAX_RECALL_HISTORY
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

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const MAX_BODY = 64 * 1024 // 64 KiB 足够记忆 payload，防大包撑内存
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY) throw new Error('request body too large')
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw) as unknown
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