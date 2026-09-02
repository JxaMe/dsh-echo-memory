/**
 * 设置卡片字段纯转换函数测试（card-util）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  booleanDraft,
  numberDraft,
  parseNumberField,
} from '../src/client/card-util.js'

test('numberDraft：数字渲染为文本，非数字渲染为空', () => {
  assert.equal(numberDraft(5), '5')
  assert.equal(numberDraft(0), '0')
  assert.equal(numberDraft(undefined), '')
  assert.equal(numberDraft('8'), '')
})

test('parseNumberField：空=清除，有限数字=写入，其余=非法', () => {
  assert.deepEqual(parseNumberField(''), { kind: 'clear' })
  assert.deepEqual(parseNumberField('  12 '), { kind: 'set', value: 12 })
  assert.equal(parseNumberField('abc'), undefined)
  assert.equal(parseNumberField('1e999'), undefined)
})

test('booleanDraft：仅 true 投影为选中', () => {
  assert.equal(booleanDraft(true), true)
  assert.equal(booleanDraft(false), false)
  assert.equal(booleanDraft(undefined), false)
})