/**
 * 卡片字段的纯转换函数：存储值 ↔ 草稿文本。
 * 与官方 card-form 的规格语义一致（空草稿 = 清除覆盖回组合层；非法草稿阻塞保存），
 * 实现自包含，方便单测。
 * @module dsh-memory/client/card-util
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

/** 句式字段：存储的字符串数组渲染为每行一条的草稿文本。 */
export function patternsDraft(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').join('\n')
    : ''
}

/**
 * 句式字段草稿解析：按行 trim 去空后写成字符串数组；全空 = 清除。
 * @param text - 用户输入的草稿（每行一条句式）。
 */
export function parsePatternsField(text: string): FieldWrite {
  const patterns = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  return patterns.length === 0 ? { kind: 'clear' } : { kind: 'set', value: patterns }
}

/** 布尔字段：存储值投影为复选框选中态。 */
export function booleanDraft(value: unknown): boolean {
  return value === true
}