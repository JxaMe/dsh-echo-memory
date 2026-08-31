/**
 * 模型可见的记忆工具：memory_save / memory_search / memory_forget。
 * 注册进 tools 注册表的部署全局层（host 平面），全部 agent/会话可见；
 * 卡片渲染意图统一为 `generic`（回退通用卡片，不引入 UI 专属格式）。
 * @module dsh-memory/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MEMORY_KINDS, agentWorkspace } from './domain.js'
import type { MemoryKind } from './domain.js'
import type { MemoryStore, SearchHit } from './store.js'
import { tagSuffix } from './store.js'

/** 记忆类型枚举（模型可见的字符串字面量）。 */
const KIND_OPTIONS: readonly MemoryKind[] = [...MEMORY_KINDS]

/**
 * 解析工具调用归属的工作区：显式参数 > 当前 agent 会话 cwd > 部署缺省（`*`）。
 */
function workspaceOf(
  args: { readonly workspace?: string },
  exec: ToolRunContext,
  fallback: string,
): string {
  return args.workspace ?? agentWorkspace(exec.agent) ?? fallback
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
 */
export function memoryTools(store: MemoryStore, defaultWorkspace: string): readonly ToolDefinition[] {
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
    async execute(args, _exec) {
      const hits = store.search({
        query: args.query,
        workspace: args.workspace,
        kind: args.kind,
        limit: args.limit,
      })
      return { items: hits.map(toOutputItem) }
    },
  })

  const forget = defineTool({
    name: 'memory_forget',
    description: '删除一条记忆（按 id）。id 来自 memory_search / memory_save 的结果；仅在用户明确要求删除时使用。',
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
      return { removed: await store.forget(args.id) }
    },
  })

  return [save, search, forget]
}