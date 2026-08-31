/**
 * 提示词注入测试：记忆正文 + 捕获确认段（会话隔离、一次消费、与注入开关无关）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CaptureFeed } from '../src/capture.js'
import { memoryContextText } from '../src/prompt.js'
import { MemoryStore } from '../src/store.js'
import type { StoreLimits } from '../src/store.js'
import type { MemoryRecord } from '../src/domain.js'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { FakeKvTable } from './helpers.js'

const LIMITS: StoreLimits = { contentMaxChars: 500, tagsMax: 8 }

function setup() {
  const table = new FakeKvTable<string, MemoryRecord>()
  const store = new MemoryStore(table, LIMITS)
  const feed = new CaptureFeed()
  return { store, feed }
}

function provider(
  store: MemoryStore,
  feed: CaptureFeed,
  enabled = true,
): (context: AssembleContext) => string {
  return memoryContextText(store, () => ({ enabled, limit: 8, maxChars: 1000 }), feed)
}

function context(sessionId: string): AssembleContext {
  return {
    agent: { session: { header: { id: sessionId, cwd: '/workspace/a' } } },
  } as unknown as AssembleContext
}

test('捕获确认段：本会话条目转述一次后消失', () => {
  const { store, feed } = setup()
  feed.push({ sessionId: 's1', content: '部署走 systemd' })
  const text = provider(store, feed)(context('s1'))
  assert.match(text, /\[记忆确认\] 刚刚已自动捕获 1 条记忆：「部署走 systemd」/)
  assert.match(text, /已记住 ✅/)
  // 已消费：再次组装不再出现
  assert.equal(provider(store, feed)(context('s1')), '')
})

test('确认段只回显给捕获发生的会话', () => {
  const { store, feed } = setup()
  feed.push({ sessionId: 's1', content: '部署走 systemd' })
  const other = provider(store, feed)(context('s2'))
  assert.equal(other, '')
  // 本会话的条目未被他人消费
  const self = provider(store, feed)(context('s1'))
  assert.match(self, /部署走 systemd/)
})

test('确认段与注入开关无关：enabled=false 也转述确认', () => {
  const { store, feed } = setup()
  feed.push({ sessionId: 's1', content: '构建走 pnpm' })
  const text = provider(store, feed, false)(context('s1'))
  assert.match(text, /已自动捕获 1 条记忆：「构建走 pnpm」/)
  assert.doesNotMatch(text, /^- \[fact\]/m) // 记忆正文未注入
})

test('多条确认合并为一条提示', () => {
  const { store, feed } = setup()
  feed.push({ sessionId: 's1', content: '第一条' })
  feed.push({ sessionId: 's1', content: '第二条' })
  const text = provider(store, feed)(context('s1'))
  assert.match(text, /已自动捕获 2 条记忆：「第一条」、「第二条」/)
})

test('无待确认条目时不注入记忆（按需召回已迁至 pre-step）', async () => {
  const { store, feed } = setup()
  await store.save({ workspace: '/workspace/a', content: '已有记忆' })
  const text = provider(store, feed)(context('s1'))
  assert.equal(text, '') // 广播式注入已废弃，有记忆也不从 systemPrompt 注入
  assert.doesNotMatch(text, /记忆确认/)
  assert.doesNotMatch(text, /已有记忆/)
})