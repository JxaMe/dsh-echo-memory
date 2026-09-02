/**
 * 卡片字段的纯转换函数：存储值 ↔ 草稿文本。
 * 与官方 card-form 的规格语义一致（空草稿 = 清除覆盖回组合层；非法草稿阻塞保存），
 * 实现自包含，方便单测。
 * @module dsh-echo-memory/client/card-util
 */

/** 一次保存执行的字段写入。 */
export type FieldWrite =
  | { kind: 'set'; value: unknown }
  | { kind: 'clear' }

/** 数字字段：存储值渲染为草稿文本；非数字渲染为空。 */
export function numberDraft(value: unknown): string {
  return typeof value === 'number' ? String(value) : ''
}

/**
 * 数字字段草稿解析：空文本 = 清除；有限数字 = 写入；其余 = undefined（非法，阻塞保存）。
 * @param text - 用户输入的草稿。
 * @returns 写入或清除计划；非法草稿返回 undefined。
 */
export function parseNumberField(text: string): FieldWrite | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'clear' }
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
}

/** 布尔字段：存储值投影为复选框选中态。 */
export function booleanDraft(value: unknown): boolean {
  return value === true
}
