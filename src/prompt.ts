/**
 * 提示词注入：向每次模型请求的组装注入 Top-N 持久记忆。
 * 用 ctx.systemPrompt.context —— 动态模型上下文按 durable user-role 快照落会话日志，
 * 满足「模型可见 ⟺ 已记录」约定；文本为空时空转零开销。
 * 开关与限量在每次组装时现读（设置面板变更即时生效）。
 * @module dsh-echo-memory/prompt
 */

import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
// 模块增强：dsh-agent 为 AssembleContext 增加当前 agent 字段（用于取会话 cwd）。
// import type 即可携带该声明，不产生运行时依赖。
import type {} from '@deepseek-ai/dsh-agent'
import type { MemoryStore } from './store.js'
import { GLOBAL_WORKSPACE, agentWorkspace } from './domain.js'

/** 一次组装读取的注入配置（由调用方从当前设置源投影）。 */
export interface MemoryInjectionConfig {
  /** 是否注入（面板关闭时贡献空文本）。 */
  readonly enabled: boolean
  /** 注入条数上限。 */
  readonly limit: number
  /** 注入文本 UTF-16 长度上限。 */
  readonly maxChars: number
}

/**
 * 构造组装期文本提供方：解析当前 agent 会话 cwd 过滤工作区记忆（`*` 全局记忆始终入选），
 * 渲染 Top-N 条；provider 必须全函数式，任何失败只告警一次并返回空串，绝不打断组装。
 * @param store - 已就绪的仓储。
 * @param read - 每次组装现读的注入配置（面板变更即时生效）。
 */
export function memoryContextText(
  store: MemoryStore,
  read: () => MemoryInjectionConfig,
): (context: AssembleContext) => string {
  let warnedOnce = false
  return (context) => {
    try {
      const { enabled, limit, maxChars } = read()
      if (!enabled) return ''
      const workspace = agentWorkspace(context.agent) ?? GLOBAL_WORKSPACE
      return store.recallText({ workspace, limit, maxChars })
    } catch (error) {
      if (!warnedOnce) {
        warnedOnce = true
        console.warn('[dsh-echo-memory] prompt context provider failed; injection disabled for this instance', error)
      }
      return ''
    }
  }
}