/**
 * Host HTTP 路由：纯转接层，无业务逻辑，薄实现
 * @module dsh-echo-memory/host-routes
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryStore } from './store.js'
import type { MemorySettings } from './settings.js'

export interface RouteDeps {
  store: MemoryStore
  readSettings: () => MemorySettings
  getLastRecall: () => unknown
  getRecallHistory: () => unknown
  memoryStats: () => unknown
  purgeTombstones: () => Promise<number>
  listDeleted: (limit: number) => unknown
  restore: (id: string) => Promise<boolean>
  purgeOne: (id: string) => Promise<boolean>
  updateMemory: (id: string, patch: { content?: string; tags?: readonly string[] }) => Promise<boolean>
  listRecent: (limit: number) => unknown
  searchRecent: (query: string, limit: number) => unknown
  save: (input: { content: string; tags?: string[]; kind?: import('./domain.js').MemoryKind; workspace: string }) => Promise<unknown>
  forget: (id: string) => Promise<boolean>
  defaultWorkspace: string
}

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const MAX_BODY = 64 * 1024
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

export function registerMemoryRoutes(ctx: Context, deps: RouteDeps): void {
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
    route('/api/dsh-echo-memory/stats', async () => deps.memoryStats())
    route('/api/dsh-echo-memory/purge', async () => ({ purged: await deps.purgeTombstones() }))
    route('/api/dsh-echo-memory/deleted', async (req) => {
      const url = new URL(req.url ?? '/api/dsh-echo-memory/deleted', 'http://localhost')
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '20') || 20))
      return { items: deps.listDeleted(limit) }
    })
    route('/api/dsh-echo-memory/restore', async (req) => {
      const body = await readJsonBody(req) as { id?: unknown }
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) throw new Error('missing id')
      return { restored: await deps.restore(id) }
    })
    route('/api/dsh-echo-memory/purge-one', async (req) => {
      const body = await readJsonBody(req) as { id?: unknown }
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) throw new Error('missing id')
      return { purged: await deps.purgeOne(id) }
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
      return { updated: await deps.updateMemory(id, patch) }
    })
    route('/api/dsh-echo-memory/last-recall', async () => deps.getLastRecall())
    route('/api/dsh-echo-memory/recall-history', async () => ({ items: deps.getRecallHistory() }))
    route('/api/dsh-echo-memory/list', async (req) => {
      const url = new URL(req.url ?? '/api/dsh-echo-memory/list', 'http://localhost')
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? '20') || 20))
      const q = url.searchParams.get('q') ?? ''
      const items = q.trim().length > 0
        ? (deps.searchRecent(q, limit) as Array<{ record: unknown }>).map(h => (h as { record: unknown }).record)
        : deps.listRecent(limit) as unknown[]
      // 上面 searchRecent 返回的是 SearchHit[]，但 deps 类型已擦除，直接按 store 行为处理
      // 为保持薄实现，这里不二次过滤，由 store 保证
      return { items }
    })
    route('/api/dsh-echo-memory/save', async (req) => {
      const body = await readJsonBody(req) as { content?: unknown; tags?: unknown; kind?: unknown; workspace?: unknown }
      const content = typeof body.content === 'string' ? body.content : ''
      const tags = Array.isArray(body.tags) ? (body.tags as string[]) : undefined
      const kind = typeof body.kind === 'string' ? body.kind as import('./domain.js').MemoryKind : undefined
      const workspace = typeof body.workspace === 'string' ? body.workspace : deps.defaultWorkspace
      const input: { content: string; workspace: string; tags?: string[]; kind?: import('./domain.js').MemoryKind } = { content, workspace }
      if (tags !== undefined) input.tags = tags
      if (kind !== undefined) input.kind = kind
      return deps.save(input)
    })
    route('/api/dsh-echo-memory/forget', async (req) => {
      const body = await readJsonBody(req) as { id?: unknown }
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) throw new Error('missing id')
      return { ok: await deps.forget(id) }
    })
    return () => { for (const dispose of regs) dispose() }
  })
}
