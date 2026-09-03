/**
 * dock-util 纯函数测试：标题切分、相对时间。
 * copyText 依赖浏览器剪贴板，不在 Node 单测覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitTitle, formatTime } from '../src/client/dock-util.js'

test('splitTitle：冒号/逗号/短文本/长文本', () => {
  assert.deepEqual(splitTitle('标题：正文'), { title: '标题', body: '正文' })
  assert.deepEqual(splitTitle('标题,正文'), { title: '标题', body: '正文' })
  assert.deepEqual(splitTitle('短文本'), { title: '短文本', body: '' })
  assert.deepEqual(splitTitle('这是一段超过二十个字符的很长很长的记忆内容没有明显分隔符'), { title: '', body: '这是一段超过二十个字符的很长很长的记忆内容没有明显分隔符' })
})

test('formatTime：刚刚/分钟/小时/天/超过 30 天显示日期', () => {
  const now = Date.now()
  assert.equal(formatTime(now), '刚刚')
  assert.equal(formatTime(now - 60_000), '1分钟前')
  assert.equal(formatTime(now - 3_600_000), '1小时前')
  assert.equal(formatTime(now - 86_400_000), '1天前')
  const old = now - 31 * 86_400_000
  assert.match(formatTime(old), /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/)
})
