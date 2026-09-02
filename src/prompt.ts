/**
 * 提示词注入：向每次模型请求的组装注入记忆提议提示词。
 * 用 ctx.systemPrompt.context —— 动态模型上下文按 durable user-role 快照落会话日志。
 * @module dsh-echo-memory/prompt
 */

/** 一次组装读取的注入配置（由调用方从当前设置源投影）。 */
export interface MemoryInjectionConfig {
  /** 是否注入（面板关闭时贡献空文本）。 */
  readonly enabled: boolean
  /** 注入条数上限。 */
  readonly limit: number
  /** 注入文本 UTF-16 长度上限。 */
  readonly maxChars: number
}

/** 提议提示词：每轮注入，带“若无则不提”判断，避免逼 AI 每轮找话题；并让 AI 自主判断归属工作区。 */
export function suggestionPromptText(): string {
  return '【记忆提议】若本轮对话出现值得长期记住的用户偏好、项目约束或已定决策，且记忆库尚无，请调用 memory_suggest 提议一条（经 Dock 弹条让用户确认后才真存）；若无则不提，不必每轮都找话题。归属判断：仅本项目有效的约束/决策用当前会话 cwd，跨项目通用的偏好用全局 *。不要直接调 memory_save。'
}
