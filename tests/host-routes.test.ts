/**
 * Host 路由层纯逻辑测试：limit 解析 / JSON body 读取 / 同源校验 / 路由注册形状与状态码。
 * 覆盖 400/500 分流：客户端错误如实 400，内部失败如实 500（A 项「失败如实可见」的契约）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  badRequest,
  checkSameOrigin,
  parseLimit,
  readJsonBody,
  registerMemoryRoutes,
  type RouteDeps,
} from '../src/host-routes.js'

// —— badRequest ——

test('badRequest：构造 400 错误（HTTP 层据此写 400，其余异常一律 500）', () => {
  const e = badRequest('oops')
  assert.ok(e instanceof Error)
  assert.equal((e as unknown as { status: number }).status, 400)
})

// —— parseLimit ——

test('parseLimit：缺省回 fallback；合法数字原样返回', () => {
  assert.equal(parseLimit(null, 20, 1, 100), 20)
  assert.equal(parseLimit('5', 20, 1, 100), 5)
  assert.equal(parseLimit('100', 20, 1, 100), 100)
})

test('parseLimit：非数字抛 400；空串 clamp 到下限', () => {
  assert.throws(() => parseLimit('abc', 20, 1, 100), (e: unknown) => (e as { status?: number }).status === 400)
  assert.equal(parseLimit('', 20, 1, 100), 1) // Number('') = 0 → clamp
})

test('parseLimit：越界 clamp 到 [min,max]，小数截断', () => {
  assert.equal(parseLimit('0', 20, 1, 100), 1)
  assert.equal(parseLimit('-5', 20, 1, 100), 1)
  assert.equal(parseLimit('9999', 20, 1, 100), 100)
  assert.equal(parseLimit('3.7', 20, 1, 100), 3)
})

// —— readJsonBody ——

function iterableReq(chunks: string[]): import('node:http').IncomingMessage {
  const source = (async function* () {
    for (const c of chunks) yield Buffer.from(c, 'utf8')
  })()
  return { [Symbol.asyncIterator]: () => source } as unknown as import('node:http').IncomingMessage
}

test('readJsonBody：空 body 视为 {}；合法 JSON 解析；非法 JSON 抛 400', async () => {
  assert.deepEqual(await readJsonBody(iterableReq([])), {})
  assert.deepEqual(await readJsonBody(iterableReq(['{"a":1}'])), { a: 1 })
  await assert.rejects(() => readJsonBody(iterableReq(['{bad'])), (e: unknown) => (e as { status?: number }).status === 400)
})

test('readJsonBody：超过 64KB 抛 400', async () => {
  const big = 'x'.repeat(70 * 1024)
  await assert.rejects(() => readJsonBody(iterableReq([big])), (e: unknown) => (e as { status?: number }).status === 400)
})

// —— checkSameOrigin ——

function originReq(origin: string | undefined, host: string | undefined): import('node:http').IncomingMessage {
  const headers: Record<string, string> = {}
  if (origin !== undefined) headers.origin = origin
  if (host !== undefined) headers.host = host
  return { headers } as unknown as import('node:http').IncomingMessage
}

test('checkSameOrigin：无 Origin/Host 放行；同源放行', () => {
  assert.doesNotThrow(() => checkSameOrigin(originReq(undefined, '127.0.0.1:3080')))
  assert.doesNotThrow(() => checkSameOrigin(originReq('http://127.0.0.1:3080', '127.0.0.1:3080')))
})

test('checkSameOrigin：跨源抛 400；非法 Origin 抛 400', () => {
  assert.throws(() => checkSameOrigin(originReq('http://evil.example', '127.0.0.1:3080')), (e: unknown) => (e as { status?: number }).status === 400)
  assert.throws(() => checkSameOrigin(originReq('not-a-url', '127.0.0.1:3080')), (e: unknown) => (e as { status?: number }).status === 400)
})

// —— registerMemoryRoutes 注册形状与状态码 ——

interface Registration {
  path: string
  kind: string
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>
}

function stubDeps(overrides: Partial<RouteDeps> = {}): { deps: RouteDeps; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {}
  const called = (name: string, args: unknown[]) => { calls[name] = [...(calls[name] ?? []), args] }
  const deps: RouteDeps = {
    readSettings: () => ({ injectEnabled: true, injectLimit: 8, injectMaxChars: 1500, deletionMode: 'tombstone' }),
    getLastRecall: () => null,
    getRecallHistory: () => [],
    getSuggestions: () => { called('getSuggestions', []); return [] },
    dismissSuggestion: (id) => { called('dismissSuggestion', [id]); return true },
    confirmSuggestion: async (id) => { called('confirmSuggestion', [id]); return { saved: true, id } },
    memoryStats: () => ({ injections: { requests: 0, withContent: 0 }, memories: 0 }),
    purgeTombstones: async () => { called('purgeTombstones', []); return 0 },
    listDeleted: (limit) => { called('listDeleted', [limit]); return [] },
    restore: async (id) => { called('restore', [id]); return true },
    purgeOne: async (id) => { called('purgeOne', [id]); return true },
    updateMemory: async (id, patch) => { called('updateMemory', [id, patch]); return true },
    listRecent: (limit) => { called('listRecent', [limit]); return [] },
    searchRecent: (q, limit) => { called('searchRecent', [q, limit]); return [] },
    save: async (input) => { called('save', [input]); return { existed: false, id: 'mem-1', strength: 1, workspace: '*' } },
    forget: async (id) => { called('forget', [id]); return true },
    storageStatus: () => ({ recovered: null }),
    defaultWorkspace: '*',
  }
  return { deps: { ...deps, ...overrides }, calls }
}

function mockCtx(deps: RouteDeps): { registrations: Registration[] } {
  const registrations: Registration[] = []
  const ctx = {
    inject: (_names: string[], cb: (webCtx: unknown) => unknown): unknown => {
      const webCtx = {
        webServer: {
          register: (reg: Registration): (() => void) => { registrations.push(reg); return () => {} },
        },
      }
      return cb(webCtx)
    },
  } as never
  registerMemoryRoutes(ctx, deps)
  return { registrations }
}

function fakeReq(url: string, headers: Record<string, string> = {}, body: string[] = []): import('node:http').IncomingMessage {
  const source = (async function* () {
    for (const c of body) yield Buffer.from(c, 'utf8')
  })()
  return { url, headers, [Symbol.asyncIterator]: () => source } as unknown as import('node:http').IncomingMessage
}

function fakeRes(): { out: { status: number | undefined; body: unknown }; res: import('node:http').ServerResponse } {
  const out: { status: number | undefined; body: unknown } = { status: undefined, body: undefined }
  const res = {
    writeHead: (status: number) => { out.status = status },
    end: (body: string) => { out.body = body },
  } as unknown as import('node:http').ServerResponse
  return { out, res }
}

test('registerMemoryRoutes：注册全部 15 条路由（kind=exact）', () => {
  const base = stubDeps()
  const { registrations } = mockCtx(base.deps)
  const paths = registrations.map(r => r.path).sort()
  assert.deepEqual(paths, [
    '/api/dsh-echo-memory/deleted',
    '/api/dsh-echo-memory/forget',
    '/api/dsh-echo-memory/last-recall',
    '/api/dsh-echo-memory/list',
    '/api/dsh-echo-memory/purge',
    '/api/dsh-echo-memory/purge-one',
    '/api/dsh-echo-memory/recall-history',
    '/api/dsh-echo-memory/restore',
    '/api/dsh-echo-memory/save',
    '/api/dsh-echo-memory/stats',
    '/api/dsh-echo-memory/storage-status',
    '/api/dsh-echo-memory/suggestions',
    '/api/dsh-echo-memory/suggestions/confirm',
    '/api/dsh-echo-memory/suggestions/dismiss',
    '/api/dsh-echo-memory/update',
  ])
  assert.ok(registrations.every(r => r.kind === 'exact'))
})

test('save：空 content 返回 400；正常返回 200 并透传 save 结果', async () => {
  const base = stubDeps()
  const { registrations } = mockCtx(base.deps)
  const save = registrations.find(r => r.path === '/api/dsh-echo-memory/save')!
  // 空 content
  const bad = fakeRes()
  await save.handler(fakeReq('/api/dsh-echo-memory/save', {}, ['{}']), bad.res)
  assert.equal(bad.out.status, 400)
  // 正常
  const ok = fakeRes()
  await save.handler(fakeReq('/api/dsh-echo-memory/save', {}, [JSON.stringify({ content: '记住：pnpm 装包' })]), ok.res)
  assert.equal(ok.out.status, 200)
  assert.deepEqual(JSON.parse(ok.out.body as string), { existed: false, id: 'mem-1', strength: 1, workspace: '*' })
  const saveArgs = base.calls.save?.[0] as unknown[] | undefined
  const saveCall = saveArgs?.[0] as { content?: string; workspace?: string } | undefined
  assert.equal(saveCall?.content, '记住：pnpm 装包')
  assert.equal(saveCall?.workspace, '*') // 缺省工作区
})

test('forget：缺 id 返回 400；正常返回 200', async () => {
  const base = stubDeps()
  const { registrations } = mockCtx(base.deps)
  const forget = registrations.find(r => r.path === '/api/dsh-echo-memory/forget')!
  const bad = fakeRes()
  await forget.handler(fakeReq('/api/dsh-echo-memory/forget', {}, ['{}']), bad.res)
  assert.equal(bad.out.status, 400)
  const ok = fakeRes()
  await forget.handler(fakeReq('/api/dsh-echo-memory/forget', {}, [JSON.stringify({ id: 'mem-1' })]), ok.res)
  assert.equal(ok.out.status, 200)
  assert.deepEqual(JSON.parse(ok.out.body as string), { ok: true })
})

test('list：带 q 走 searchRecent；不带 q 走 listRecent；limit 解析传入', async () => {
  const base = stubDeps()
  const { registrations } = mockCtx(base.deps)
  const list = registrations.find(r => r.path === '/api/dsh-echo-memory/list')!
  const res = fakeRes()
  await list.handler(fakeReq('/api/dsh-echo-memory/list?q=pnpm&limit=7'), res.res)
  assert.equal(res.out.status, 200)
  assert.deepEqual(base.calls.searchRecent?.[0], ['pnpm', 7])
  assert.equal(base.calls.listRecent, undefined)
  const res2 = fakeRes()
  await list.handler(fakeReq('/api/dsh-echo-memory/list'), res2.res)
  assert.equal(res2.out.status, 200)
  assert.deepEqual(base.calls.listRecent?.[0], [20])
})

test('内部失败如实 500（不吞异常伪装成功）', async () => {
  const base = stubDeps({
    memoryStats: () => { throw new Error('boom') },
  })
  const { registrations } = mockCtx(base.deps)
  const stats = registrations.find(r => r.path === '/api/dsh-echo-memory/stats')!
  const res = fakeRes()
  await stats.handler(fakeReq('/api/dsh-echo-memory/stats'), res.res)
  assert.equal(res.out.status, 500)
  assert.deepEqual(JSON.parse(res.out.body as string), { error: 'Error: boom' })
})

test('跨源请求被 400 拦截（Origin 与 Host 不一致）', async () => {
  const base = stubDeps()
  const { registrations } = mockCtx(base.deps)
  const stats = registrations.find(r => r.path === '/api/dsh-echo-memory/stats')!
  const res = fakeRes()
  await stats.handler(fakeReq('/api/dsh-echo-memory/stats', { origin: 'http://evil.example', host: '127.0.0.1:3080' }), res.res)
  assert.equal(res.out.status, 400)
})
