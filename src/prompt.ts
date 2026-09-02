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
import type { CaptureFeed } from './capture.js'

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
 * 构造组装期文本提供方：仅负责「记住」捕获后的确认转述（召回已迁至 pre-step）。
 * @param feed - 捕获确认缓冲（按当前会话消费）。
 */
export function memoryContextText(feed: CaptureFeed): (context: AssembleContext) => string {
  let warnedOnce = false
  return (context) => {
    try {
      const justCaptured = takeCapturedFor(feed, context)
      // 仅保留捕获确认；记忆召回已迁至 agent/pre-step 按需注入（query 相关才注），避免广播噪音。
      if (justCaptured.length === 0) return ''
      return `[记忆确认] 刚刚已自动捕获 ${justCaptured.length} 条记忆：`
        + justCaptured.map(entry => `「${entry.content}」`).join('、')
        + '。请在回复开头用一句话向用户确认已记住（如「已记住 ✅」），不要复述全部内容，除非用户要求。'
    } catch (error) {
      if (!warnedOnce) {
        warnedOnce = true
        console.warn('[dsh-echo-memory] prompt context provider failed; injection disabled for this instance', error)
      }
      return ''
    }
  }
}

/** 隐藏提议提示词：每轮注入，带“若无则不提”判断，避免逼 AI 每轮找话题；并让 AI 自主判断归属工作区。 */
export function suggestionPromptText(): string {
  return '【记忆提议·隐藏】若本轮对话出现值得长期记住的用户偏好、项目约束或已定决策，且记忆库尚无，请调用 memory_suggest 提议一条（经 Dock 弹条让用户确认后才真存）；若无则不提，不必每轮都找话题。归属判断：仅本项目有效的约束/决策用当前会话 cwd，跨项目通用的偏好用全局 *。不要直接调 memory_save。'
}

/** 从缓冲取出当前会话的待确认条目（无会话上下文时返回空；取出即消费）。 */
function takeCapturedFor(feed: CaptureFeed, context: AssembleContext): ReadonlyArray<{ readonly content: string }> {
  const sessionId = context.agent?.session?.header?.id
  if (sessionId === undefined) return []
  return feed.take(sessionId)
}