/**
 * RecallStore 纯逻辑测试：latest/history 覆盖、Ring 裁剪、快照隔离。
 * 重构产生的边界行为：头插 + 裁到 RECALL_HISTORY_MAX，list() 必须返回副本。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RECALL_HISTORY_MAX, RecallStore, type RecallEntry } from '../src/recall-store.js'

function entry(query: string, at: number): RecallEntry {
  return { at, query, hits: [] }
}

test('初始：last 为 null，history 为空', () => {
  const s = new RecallStore()
  assert.equal(s.last, null)
  assert.deepEqual(s.list(), [])
})

test('record：覆盖 latest，历史头插（最新在前）', () => {
  const s = new RecallStore()
  s.record(entry('a', 1))
  s.record(entry('b', 2))
  assert.equal(s.last?.query, 'b')
  assert.equal(s.last?.at, 2)
  assert.deepEqual(
    s.list().map((e) => e.query),
    ['b', 'a'],
  )
})

test('record：last 即最近记录本体', () => {
  const s = new RecallStore()
  const e = entry('a', 1)
  s.record(e)
  assert.equal(s.last, e)
})

test('record：超过上限裁剪到 RECALL_HISTORY_MAX（Ring）', () => {
  const s = new RecallStore()
  for (let i = 0; i < RECALL_HISTORY_MAX + 5; i++) {
    s.record(entry(`q${i}`, i))
  }
  assert.equal(s.list().length, RECALL_HISTORY_MAX)
  // 最新在前，最旧的 5 条被裁掉
  assert.equal(s.list()[0]!.query, `q${RECALL_HISTORY_MAX + 4}`)
  assert.equal(s.list()[RECALL_HISTORY_MAX - 1]!.query, 'q5')
  assert.ok(!s.list().some((e) => e.query === 'q4'))
})

test('恰好等于上限：不裁剪', () => {
  const s = new RecallStore()
  for (let i = 0; i < RECALL_HISTORY_MAX; i++) {
    s.record(entry(`q${i}`, i))
  }
  assert.equal(s.list().length, RECALL_HISTORY_MAX)
  assert.equal(s.list()[RECALL_HISTORY_MAX - 1]!.query, 'q0')
})

test('list() 返回快照：外部修改不影响内部', () => {
  const s = new RecallStore()
  s.record(entry('a', 1))
  const snap = s.list()
  snap.pop()
  snap.push(entry('x', 99))
  assert.deepEqual(
    s.list().map((e) => e.query),
    ['a'],
  )
})
