/**
 * Host HTTP 路由：纯转接层，无业务逻辑，薄实现
 * @module dsh-echo-memory/host-routes
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MemorySettings } from './settings.js'

export interface RouteDeps {
  readSettings: () => MemorySettings
  getLastRecall: () => unknown
  getRecallHistory: () => unknown
  getSuggestions: () => unknown
  dismissSuggestion: (id: string) => boolean
  confirmSuggestion: (id: string) => Promise<unknown>
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
  storageStatus: () => { recovered: { at: number; backupPath: string } | null }
  defaultWorkspace: string
}

/** 构造 400 错误（HTTP 层据此写 400；其余异常一律 500）。 */
export function badRequest(message: string): Error {
  const e = new Error(message)
  ;(e as unknown as { status: number }).status = 400
  return e
}

/** 读取请求 JSON body（≤64KB）；空 body 视为 {}；非法 JSON / 超限抛 400。 */
export async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const MAX_BODY = 64 * 1024
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY) throw badRequest('request body too large')
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw badRequest('invalid JSON body')
  }
}

/** 解析 limit 查询参数：缺省回 fallback；非数字抛 400；越界 clamp 到 [min,max]。 */
export function parseLimit(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw badRequest('invalid limit')
  const clamped = Math.trunc(n)
  if (clamped < min || clamped > max) return Math.min(max, Math.max(min, clamped))
  return clamped
}

/** 同源校验：带 Origin 时要求其 host 与 Host 头一致，否则 400（无 Origin 的本地请求放行）。 */
export function checkSameOrigin(req: import('node:http').IncomingMessage): void {
  const origin = req.headers.origin as string | undefined
  const host = req.headers.host as string | undefined
  if (origin === undefined || host === undefined) return
  try {
    const originHost = new URL(origin).host
    if (originHost !== host) throw badRequest('cross-origin request blocked')
  } catch (e) {
    if ((e as unknown as { status: number }).status === 400) throw e
    // origin 解析失败视为 400
    throw badRequest('invalid origin')
  }
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
            checkSameOrigin(req)
            const body = await handler(req)
            json(res, body)
          } catch (error) {
            const status = (error as unknown as { status?: number }).status === 400 ? 400 : 500
            json(res, { error: String(error) }, status)
          }
        },
      }))
    }
    route('/api/dsh-echo-memory/stats', async () => deps.memoryStats())
    route('/api/dsh-echo-memory/purge', async () => ({ purged: await deps.purgeTombstones() }))
    route('/api/dsh-echo-memory/deleted', async (req) => {
      const url = new URL(req.url ?? '/api/dsh-echo-memory/deleted', 'http://localhost')
      const limit = parseLimit(url.searchParams.get('limit'), 20, 1, 100)
      return { items: deps.listDeleted(limit) }
    })
    route('/api/dsh-echo-memory/restore', async (req) => {
      const body = await readJsonBody(req) as { id?: unknown }
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) throw badRequest('missing id')
      return { restored: await deps.restore(id) }
    })
    route('/api/dsh-echo-memory/purge-one', async (req) => {
      const body = await readJsonBody(req) as { id?: unknown }
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) throw badRequest('missing id')
      return { purged: await deps.purgeOne(id) }
    })
    route('/api/dsh-echo-memory/update', async (req) => {
      const body = await readJsonBody(req) as { id?: unknown; content?: unknown; tags?: unknown }
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) throw badRequest('missing id')
      const content = typeof body.content === 'string' ? body.content : undefined
      const tags = Array.isArray(body.tags) ? (body.tags as string[]) : undefined
      if (content === undefined && tags === undefined) throw badRequest('empty patch')
      const patch: { content?: string; tags?: readonly string[] } = {}
      if (content !== undefined) patch.content = content
      if (tags !== undefined) patch.tags = tags
      return { updated: await deps.updateMemory(id, patch) }
    })
    route('/api/dsh-echo-memory/last-recall', async () => deps.getLastRecall())
    route('/api/dsh-echo-memory/recall-history', async () => ({ items: deps.getRecallHistory() }))
    route('/api/dsh-echo-memory/storage-status', async () => deps.storageStatus())
    route('/api/dsh-echo-memory/list', async (req) => {
      const url = new URL(req.url ?? '/api/dsh-echo-memory/list', 'http://localhost')
      const limit = parseLimit(url.searchParams.get('limit'), 20, 1, 50)
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
      if (content.trim().length === 0) throw badRequest('content must contain non-whitespace')
      const tags = Array.isArray(body.tags) ? (body.tags as string[]) : undefined
      if (tags !== undefined && tags.some(t => typeof t !== 'string')) throw badRequest('invalid tags')
      const kind = typeof body.kind === 'string' ? body.kind as import('./domain.js').MemoryKind : undefined
      if (kind !== undefined && !['fact', 'preference', 'project', 'session'].includes(kind)) throw badRequest('invalid kind')
      const workspace = typeof body.workspace === 'string' ? body.workspace : deps.defaultWorkspace
      const input: { content: string; workspace: string; tags?: string[]; kind?: import('./domain.js').MemoryKind } = { content, workspace }
      if (tags !== undefined) input.tags = tags
      if (kind !== undefined) input.kind = kind
      return deps.save(input)
    })
    route('/api/dsh-echo-memory/forget', async (req) => {
      const body = await readJsonBody(req) as { id?: unknown }
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) throw badRequest('missing id')
      return { ok: await deps.forget(id) }
    })
    route('/api/dsh-echo-memory/suggestions', async () => ({ items: deps.getSuggestions() }))
    route('/api/dsh-echo-memory/suggestions/dismiss', async (req) => {
      const body = await readJsonBody(req) as { id?: unknown }
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) throw badRequest('missing id')
      return { dismissed: deps.dismissSuggestion(id) }
    })
    route('/api/dsh-echo-memory/suggestions/confirm', async (req) => {
      const body = await readJsonBody(req) as { id?: unknown }
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) throw badRequest('missing id')
      return deps.confirmSuggestion(id)
    })
    return () => { for (const dispose of regs) dispose() }
  })
}
