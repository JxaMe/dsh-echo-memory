/**
 * 自动捕获监听器测试：句式命中、来源过滤、按会话限流、内容提取。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CaptureFeed, createCaptureHandler } from '../src/capture.js'
import type { CaptureConfig } from '../src/capture.js'
import { MemoryStore } from '../src/store.js'
import type { StoreLimits } from '../src/store.js'
import type { MemoryRecord } from '../src/domain.js'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { FakeKvTable } from './helpers.js'

const CONFIG: CaptureConfig = {
  enabled: true,
  patterns: ['请记住', '记住：', 'remember that'],
  maxPerSession: 2,
}

const LIMITS: StoreLimits = { contentMaxChars: 500, tagsMax: 8 }

function makeHandler() {
  const table = new FakeKvTable<string, MemoryRecord>()
  const store = new MemoryStore(table, LIMITS)
  const feed = new CaptureFeed()
  const handler = createCaptureHandler(() => CONFIG, store, feed)
  return { handler, store, feed }
}

function session(cwd: string | undefined, id = 'session-1'): Session {
  // 测试只需 header 字段；其余字段与真实 Session 运行时不相关。
  return {
    header: { id, version: 0, createdAt: 1000, ...(cwd === undefined ? {} : { cwd }) },
  } as unknown as Session
}

function userEvent(text: string): SessionEvent {
  // 测试只需 type/data 相关字段；SessionEvent 其余信封字段不参与捕获逻辑。
  return {
    type: 'user/message',
    seq: 1,
    time: 2000,
    data: { id: 'msg-1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  } as unknown as SessionEvent
}

function pluginEvent(text: string): SessionEvent {
  return {
    type: 'user/message',
    seq: 2,
    time: 2000,
    data: { id: 'msg-2', role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'other' } },
  } as unknown as SessionEvent
}

async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

test('命中句式：提取句式后的内容并按会话 cwd 归属', async () => {
  const { handler, store, feed } = makeHandler()
  handler(session('/workspace/a'), userEvent('请记住：部署走 systemd 服务'))
  await settle()
  const hit = store.search({ workspace: '/workspace/a' })[0]
  assert.ok(hit)
  assert.equal(hit.record.content, '部署走 systemd 服务')
  assert.equal(hit.record.kind, 'fact')
  assert.equal(hit.record.source, 'auto')
  assert.equal(hit.record.workspace, '/workspace/a')
  // 保存成功后确认条目入队（带会话 id 与正文），供提示词转述
  const taken = feed.take('session-1')
  assert.equal(taken.length, 1)
  assert.equal(taken[0]?.sessionId, 'session-1')
  assert.equal(taken[0]?.content, '部署走 systemd 服务')
  // 取走即消费
  assert.equal(feed.take('session-1').length, 0)
})

test('句式后无内容时保存整句', async () => {
  const { handler, store } = makeHandler()
  handler(session(undefined), userEvent('请记住'))
  await settle()
  const hit = store.search({ query: '请记住' })[0]
  assert.ok(hit)
  assert.equal(hit.record.content, '请记住')
  assert.equal(hit.record.workspace, '*')
})

test('未命中句式与插件来源不捕获（feed 无入队）', async () => {
  const { handler, store, feed } = makeHandler()
  handler(session('/w'), userEvent('今天天气不错'))
  handler(session('/w'), pluginEvent('请记住：这是插件注入'))
  await settle()
  assert.equal(store.search({}).length, 0)
  assert.equal(feed.take('session-1').length, 0)
})

test('按会话限流：超过 maxPerSession 后不再捕获', async () => {
  const { handler, store } = makeHandler()
  const s = session('/w')
  handler(s, userEvent('请记住：第一条'))
  handler(s, userEvent('请记住：第二条'))
  handler(s, userEvent('请记住：第三条'))
  await settle()
  const hits = store.search({ workspace: '/w' })
  assert.equal(hits.length, 2)
})

test('保存失败：回滚配额（失败不消耗会话额度）且不报已记住', async () => {
  // 可注入失败的 store：第一次 save 抛错，之后正常
  class FlakyStore extends MemoryStore {
    failNext = true
    override async save(
      input: Parameters<MemoryStore['save']>[0],
      now?: number,
    ): Promise<Awaited<ReturnType<MemoryStore['save']>>> {
      if (this.failNext) {
        this.failNext = false
        throw new TypeError('injected failure')
      }
      return super.save(input, now)
    }
  }
  const table = new FakeKvTable<string, MemoryRecord>()
  const store = new FlakyStore(table, LIMITS)
  const feed = new CaptureFeed()
  const handler = createCaptureHandler(() => CONFIG, store, feed)
  const s = session('/w', 'session-q')
  // 真实节奏：每条消息之间等待落定（回滚在失败后、下一条消息前完成）
  handler(s, userEvent('请记住：这条失败'))
  await settle()
  handler(s, userEvent('请记住：第一条'))
  await settle()
  handler(s, userEvent('请记住：第二条'))
  await settle()
  handler(s, userEvent('请记住：第三条'))
  await settle()
  const hits = store.search({ workspace: '/w' })
  // 失败不占额：maxPerSession=2 下 1 次失败 + 3 次尝试 → 成功 2 条且第三条被拒
  assert.equal(hits.length, 2)
  assert.equal(feed.take('session-q').length, 2)
})

test('英文句式 remember that 大小写不敏感', async () => {
  const { handler, store } = makeHandler()
  handler(session('/w'), userEvent('Remember That we ship via pnpm pack'))
  await settle()
  const hit = store.search({ query: 'pnpm' })[0]
  assert.ok(hit)
  assert.equal(hit.record.content, 'we ship via pnpm pack')
})