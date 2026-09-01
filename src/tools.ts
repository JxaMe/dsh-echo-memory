/**
 * 模型可见的记忆工具：memory_save / memory_search / memory_forget。
 * 注册进 tools 注册表的部署全局层（host 平面），全部 agent/会话可见；
 * 卡片渲染意图统一为 `generic`（回退通用卡片，不引入 UI 专属格式）。
 * @module dsh-echo-memory/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MEMORY_KINDS, agentWorkspace } from './domain.js'
import type { MemoryKind } from './domain.js'
import type { MemoryStore, SearchHit } from './store.js'
import { tagSuffix } from './store.js'
import type { DeletionMode } from './settings.js'
import { expandWithLocalSynonyms, scorePlainBM25, tokenizeForRecall } from './scoring.js'

/** 记忆类型枚举（模型可见的字符串字面量）。 */
const KIND_OPTIONS: readonly MemoryKind[] = [...MEMORY_KINDS]

/**
 * 解析工具调用归属的工作区：显式参数（非空）> 当前 agent 会话 cwd > 部署缺省（`*`）。
 * 显式空串视为未传，避免污染全局。
 */
function workspaceOf(
  args: { readonly workspace?: string },
  exec: ToolRunContext,
  fallback: string,
): string {
  const explicit = args.workspace?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit
  return agentWorkspace(exec.agent) ?? fallback
}

/** 检索结果渲染：模型可见文本（含 id，便于后续 memory_forget 引用）。 */
function renderSearch(items: readonly SearchOutputItem[]): string {
  if (items.length === 0) return '未找到匹配的记忆。'
  const lines = items.map((item, index) =>
    `${index + 1}. [${item.kind}] ${item.content}`
    + `${tagSuffix(item.tags)}`
    + ` (id=${item.id}, x${item.strength}, ${item.workspace})`)
  return `找到 ${items.length} 条记忆：\n${lines.join('\n')}`
}

/** memory_search 规范输出里的一条命中（tag 数组转普通数组跨工具边界返回）。 */
export interface SearchOutputItem {
  readonly id: string
  readonly content: string
  readonly kind: string
  readonly workspace: string
  readonly tags: string[]
  readonly strength: number
}

function toOutputItem({ record }: SearchHit): SearchOutputItem {
  return {
    id: record.id,
    content: record.content,
    kind: record.kind,
    workspace: record.workspace,
    tags: [...record.tags],
    strength: record.strength,
  }
}

/**
 * 构造三个记忆工具。
 * @param store - 已就绪的记忆仓储（execute 时保证已打开）。
 * @param defaultWorkspace - 无会话 cwd 时的归属工作区，缺省 `*`。
 * @param readDeletionMode - 现读删除模式（设置面板保存即生效）。
 */
export function memoryTools(
  store: MemoryStore,
  defaultWorkspace: string,
  readDeletionMode: () => DeletionMode,
): readonly ToolDefinition[] {
  const save = defineTool({
    name: 'memory_save',
    description:
      '把一条长期记忆写入 dsh 记忆库（跨会话持久）。同一工作区内内容与类型完全相同的记忆会强化（strength+1）而不是重复保存。'
      + '适合记住用户偏好、项目约束、已定决策。',
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: '要记住的事实/偏好/决策，一句完整的话',
      },
      kind: {
        type: 'string',
        enum: KIND_OPTIONS,
        description: '记忆类型：fact 事实 / preference 偏好 / project 项目 / session 会话结论，缺省 fact',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '检索标签（自动小写、去重），缺省空',
      },
      workspace: {
        type: 'string',
        description: '记忆归属工作区（绝对路径）；缺省用当前会话 cwd，未知时用 *',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          saved: { type: 'boolean', required: true },
          existed: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          strength: { type: 'integer', required: true },
          workspace: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.existed
          ? `记忆已强化（id=${value.id}, strength=${value.strength}, workspace=${value.workspace}）`
          : `已保存记忆（id=${value.id}, workspace=${value.workspace}）`,
      }],
    },
    async execute(args, exec) {
      const workspace = workspaceOf(args, exec, defaultWorkspace)
      const outcome = await store.save({
        workspace,
        content: args.content,
        kind: args.kind,
        tags: args.tags,
        source: 'agent',
      })
      return {
        saved: true,
        existed: outcome.existed,
        id: outcome.id,
        strength: outcome.strength,
        workspace: outcome.workspace,
      }
    },
  })

  const search = defineTool({
    name: 'memory_search',
    description:
      '检索 dsh 记忆库（标签/内容关键词评分排序，跨会话）。想回应用户偏好、之前决策或项目约束但记不清细节时使用。'
      + '不传 query 时返回最近记忆。',
    parameters: {
      query: {
        type: 'string',
        description: '关键词或短语（大小写不敏感），缺省返回最近记忆',
      },
      workspace: {
        type: 'string',
        description: '限定工作区（绝对路径）',
      },
      kind: {
        type: 'string',
        enum: KIND_OPTIONS,
        description: '限定记忆类型',
      },
      limit: {
        type: 'integer',
        description: '返回条数上限 1–50，缺省 8',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                content: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                workspace: { type: 'string', required: true },
                tags: { type: 'array', items: { type: 'string' }, required: true },
                strength: { type: 'integer', required: true },
              },
            },
            required: true,
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSearch(value.items) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const q = args.query?.trim() ?? ''
      if (q.length === 0) {
        const hits = store.search({
          query: args.query,
          workspace: args.workspace?.trim() ? args.workspace : undefined,
          kind: args.kind,
          limit: args.limit,
        })
        return { items: hits.map(toOutputItem) }
      }
      const limit = args.limit ?? 8
      const rawWorkspace = args.workspace?.trim()
      if (rawWorkspace !== undefined && rawWorkspace.length > 0) {
        const ws = rawWorkspace
        const hits = store.searchForRecall(ws, q, limit)
        const filtered = args.kind === undefined ? hits : hits.filter(h => h.record.kind === args.kind)
        return { items: filtered.map(toOutputItem) }
      }
      // 未指定 workspace：跨全部工作区搜（工具侧不限制全局，全量召回），复用统一 BM25
      const all = store.allLive()
      if (all.length === 0) return { items: [] }
      const candidates = args.kind === undefined ? all : all.filter(r => r.kind === args.kind)
      if (candidates.length === 0) return { items: [] }
      const baseTokens = tokenizeForRecall(q)
      const tokens = expandWithLocalSynonyms(baseTokens)
      const now = Date.now()
      const hits = scorePlainBM25(candidates, tokens, now)
      return { items: hits.slice(0, limit).map(toOutputItem) }
    },
  })

  const forget = defineTool({
    name: 'memory_forget',
    description:
      '删除一条记忆（按 id，行为随设置面板的「删除模式」：墓碑机制 = 标记删除并立即可见性消失，'
      + '彻底删除 = 立即物理删除）。id 来自 memory_search / memory_save 的结果；仅在用户明确要求删除时使用。',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: '要删除的记忆 id',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.removed ? '记忆已删除。' : '未找到该记忆（可能已被删除）。',
      }],
    },
    async execute(args) {
      return { removed: await store.forget(args.id, readDeletionMode()) }
    },
  })

  return [save, search, forget]
}