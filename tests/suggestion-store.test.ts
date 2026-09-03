/**
 * SuggestionStore 纯逻辑测试：入队、去重、上限、dismiss。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SuggestionStore, SUGGESTION_MAX } from '../src/suggestion-store.js'

test('add：字符串/对象入队，返回带 id 的条目', () => {
  const store = new SuggestionStore()
  const a = store.add('记住这条', 1000)
  assert.equal(a.content, '记住这条')
  assert.equal(a.workspace, '*')
  assert.equal(a.id, 'sug-1000-0')
  const b = store.add({ content: '项目约束', workspace: '/w' }, 1001)
  assert.equal(b.workspace, '/w')
  assert.equal(b.id, 'sug-1001-1')
  assert.equal(store.list().length, 2)
})

test('add：空内容抛错，长内容截断到 500', () => {
  const store = new SuggestionStore()
  assert.throws(() => store.add('   '), TypeError)
  const long = 'x'.repeat(600)
  const item = store.add(long, 1)
  assert.equal(item.content.length, 500)
})

test('add：同内容同工作区去重，不新增', () => {
  const store = new SuggestionStore()
  store.add({ content: '重复内容', workspace: '/w' }, 1)
  const dup = store.add({ content: '重复内容', workspace: '/w' }, 2)
  assert.equal(store.list().length, 1)
  assert.equal(dup.id, 'sug-1-0')
})

test('add：超过 SUGGESTION_MAX 只保留最新 N 条', () => {
  const store = new SuggestionStore()
  for (let i = 0; i < SUGGESTION_MAX + 3; i++) {
    store.add(`item-${i}`, i)
  }
  const items = store.list()
  assert.equal(items.length, SUGGESTION_MAX)
  assert.equal(items[0]?.content, `item-${SUGGESTION_MAX + 2}`)
})

test('dismiss：存在则移除并返回 true，不存在返回 false', () => {
  const store = new SuggestionStore()
  const item = store.add('待移除', 1)
  assert.equal(store.dismiss('missing'), false)
  assert.equal(store.dismiss(item.id), true)
  assert.equal(store.list().length, 0)
  assert.equal(store.dismiss(item.id), false)
})
