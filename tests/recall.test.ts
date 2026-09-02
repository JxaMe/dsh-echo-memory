/**
 * 按需召回测试：query 相关才注入，与 AGENTS.md 的常驻注入区分。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../src/store.js'
import type { StoreLimits } from '../src/store.js'
import { GLOBAL_WORKSPACE, type MemoryRecord } from '../src/domain.js'
import { FakeKvTable } from './helpers.js'
import { extractQuery, decideRecall, renderRecallBlock, createRecallMessage } from '../src/recall.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'

const LIMITS: StoreLimits = { contentMaxChars: 500, tagsMax: 8 }

function makeStore(): MemoryStore {
  return new MemoryStore(new FakeKvTable<string, MemoryRecord>(), LIMITS)
}

function agent(cwd: string): Agent {
  return { session: { header: { id: 's1', cwd } } } as unknown as Agent
}

function userMsg(text: string): UserMessage {
  return {
    id: `msg-${Math.random()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

test('extractQuery：多条消息拼接并截断', () => {
  assert.equal(extractQuery([userMsg('  hello  '), userMsg('world')]), 'hello\nworld')
  assert.equal(extractQuery([]), '')
  assert.equal(extractQuery([userMsg('   ')]), '')
  const long = 'a'.repeat(3000)
  assert.equal(extractQuery([userMsg(long)]).length, 2000)
})

test('extractQuery：手动粘贴的「相关记忆」回显块剥掉，避免拿 A 搜 A', () => {
  const echo = '相关记忆 · 按需使用：\n- [fact] VPS（RackNerd）IP 192.236.246.90 SSH root 密码 secret'
  // 只有回显块 → 空 query
  assert.equal(extractQuery([userMsg(echo)]), '')
  // 回显 + 真实提问（两个块）→ 真实提问保留
  assert.equal(extractQuery([userMsg(echo), userMsg('VPS 怎么续费')]), 'VPS 怎么续费')
  // 回显 + 追问混在同一个块 → 同样剥掉回显、保留追问，不误伤
  assert.equal(extractQuery([userMsg(echo + '\n追问：VPS 怎么续费？')]), '追问：VPS 怎么续费？')
  // 前导空白也识别
  assert.equal(extractQuery([userMsg('   ' + echo)]), '')
})

test('extractQuery：真实提问含「相关记忆」字样但非回显标题开头，照常保留', () => {
  assert.equal(extractQuery([userMsg('帮我查一下 相关记忆 功能怎么关')]), '帮我查一下 相关记忆 功能怎么关')
  // 正常提问不该被剥，能搜到才正常召回
  assert.equal(extractQuery([userMsg('VPS 怎么续费')]), 'VPS 怎么续费')
})

test('searchForRecall：只召回相关记忆，无问不召回', async () => {
  const store = makeStore()
  await store.save({ workspace: '/w/a', content: '部署走 systemd', tags: ['deploy'] }, 1000)
  await store.save({ workspace: '/w/a', content: '前端用 React', tags: ['fe'] }, 1000)
  await store.save({ workspace: GLOBAL_WORKSPACE, content: '用户偏好简洁', tags: ['pref'] }, 1000)
  // 相关 query 只召回 systemd
  let hits = store.searchForRecall('/w/a', 'systemd 怎么配', 8, 2000)
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.record.content, '部署走 systemd')
  // 前端 query 召回 React
  hits = store.searchForRecall('/w/a', 'react 组件', 8, 2000)
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.record.content, '前端用 React')
  // 无关 query 不召回
  hits = store.searchForRecall('/w/a', '完全无关的 golang', 8, 2000)
  assert.equal(hits.length, 0)
  // 空 query 不召回（避免广播）
  hits = store.searchForRecall('/w/a', '   ', 8, 2000)
  assert.equal(hits.length, 0)
})

test('searchForRecall：工作区 + 全局入选，其他工作区排除', async () => {
  const store = makeStore()
  await store.save({ workspace: '/w/a', content: '项目 A 的 API', tags: ['api'] }, 1000)
  await store.save({ workspace: '/w/b', content: '项目 B 的 API', tags: ['api'] }, 1000)
  await store.save({ workspace: GLOBAL_WORKSPACE, content: '全局 API 规范', tags: ['api'] }, 1000)
  const hits = store.searchForRecall('/w/a', 'api', 10, 2000)
  const contents = hits.map(h => h.record.content).sort()
  assert.deepEqual(contents, ['全局 API 规范', '项目 A 的 API'])
})

test('searchForRecall：90天老记忆仍可召回（按需不过滤老化）', async () => {
  const store = makeStore()
  const NOW = 100 * 24 * 60 * 60 * 1000
  await store.save({ workspace: '/w', content: '百天前的 systemd 笔记', tags: ['deploy'] }, NOW - 91 * 24 * 60 * 60 * 1000)
  // 广播式会过滤老化，但按需只要相关就回
  assert.equal(store.rankedForInjection('/w', 8, NOW).length, 0)
  const hits = store.searchForRecall('/w', 'systemd', 8, NOW)
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.record.content, '百天前的 systemd 笔记')
})

test('renderRecallText：按 maxChars 截断', async () => {
  const store = makeStore()
  await store.save({ workspace: '/w', content: '记忆1', tags: ['a'] }, 1000)
  await store.save({ workspace: '/w', content: '记忆2', tags: ['b'] }, 1000)
  const hits = store.searchForRecall('/w', '记忆', 8, 2000)
  assert.equal(hits.length, 2)
  const text = store.renderRecallText(hits, 20)
  assert.ok(text.length <= 20)
  assert.ok(text.endsWith('…') || text.includes('记忆1'))
})

test('decideRecall：enabled=false 或空query不注入', async () => {
  const store = makeStore()
  await store.save({ workspace: '/w/a', content: '部署走 systemd' }, 1000)
  const ag = agent('/w/a')
  // disabled
  let res = decideRecall(store, () => ({ enabled: false, limit: 8, maxChars: 1500 }), ag, [userMsg('systemd')])
  assert.equal(res, undefined)
  // 空 query
  res = decideRecall(store, () => ({ enabled: true, limit: 8, maxChars: 1500 }), ag, [userMsg('   ')])
  assert.equal(res, undefined)
  // 无关
  res = decideRecall(store, () => ({ enabled: true, limit: 8, maxChars: 1500 }), ag, [userMsg('无关词')])
  assert.equal(res, undefined)
})

test('decideRecall：相关时注入并计 stats', async () => {
  const store = makeStore()
  await store.save({ workspace: '/w/a', content: '部署走 systemd 详细步骤', tags: ['deploy'] }, 1000)
  const ag = agent('/w/a')
  const before = store.injectionStats
  assert.deepEqual(before, { requests: 0, withContent: 0 })
  const res = decideRecall(store, () => ({ enabled: true, limit: 8, maxChars: 1500 }), ag, [userMsg('systemd 怎么部署')])
  assert.ok(res)
  assert.match(res!.text, /相关记忆/)
  assert.match(res!.text, /部署走 systemd/)
  assert.equal(res!.hits, 1)
  assert.deepEqual(store.injectionStats, { requests: 1, withContent: 1 })
  // 渲染块检查
  const msg = createRecallMessage(res!.text, res!.hits)
  assert.equal(msg.role, 'user')
  const first = msg.content[0] as { type: string; text: string } | undefined
  assert.match(first?.type === 'text' ? first.text : '', /相关记忆/)
})

test('decideRecall：敏感记忆自动召回排除（仅手动可查）', async () => {
  const store = makeStore()
  await store.save({ workspace: '/w/a', content: 'VPS（RackNerd）密码 secret123 IP 192.236.246.90', tags: ['vps'], sensitive: true }, 1000)
  await store.save({ workspace: '/w/a', content: '部署走 systemd 详细步骤', tags: ['deploy'], sensitive: false }, 1001)
  const ag = agent('/w/a')
  // 即使 query 命中的就是敏感词，自动召回也不带它
  let res = decideRecall(store, () => ({ enabled: true, limit: 8, maxChars: 1500 }), ag, [userMsg('vps 密码 secret123')])
  assert.equal(res, undefined)
  // 非敏感记忆照常召回
  res = decideRecall(store, () => ({ enabled: true, limit: 8, maxChars: 1500 }), ag, [userMsg('systemd 怎么部署')])
  assert.ok(res)
  assert.match(res!.text, /部署走 systemd/)
  // 手动 memory_search 路径仍可查（store.searchForRecall 不含过滤，过滤在 decideRecall 层）
  const hits = store.searchForRecall('/w/a', 'vps 密码 secret123', 8, 2000)
  assert.ok(hits.some(h => h.record.sensitive === true))
})

test('decideRecall：limit 与 maxChars 生效', async () => {
  const store = makeStore()
  for (let i = 0; i < 5; i++) {
    await store.save({ workspace: '/w/a', content: `记忆 api-${i}`, tags: ['api'] }, 1000 + i)
  }
  const ag = agent('/w/a')
  const res1 = decideRecall(store, () => ({ enabled: true, limit: 2, maxChars: 1500 }), ag, [userMsg('api')])
  assert.equal(res1!.hits, 2)
  const res2 = decideRecall(store, () => ({ enabled: true, limit: 8, maxChars: 10 }), ag, [userMsg('api')])
  assert.ok(res2!.text.length > 10) // 含标题所以略超，但 recallText 本体被截断
  assert.ok(res2!.text.includes('…'))
})

test('renderRecallBlock 格式', () => {
  assert.equal(renderRecallBlock('- [fact] hi'), '相关记忆 · 按需使用：\n- [fact] hi')
})
