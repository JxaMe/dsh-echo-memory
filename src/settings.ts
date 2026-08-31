/**
 * dsh-memory 设置命名空间（Host 半侧）：`memory` 命名空间的 schema 与注册标识。
 * 设置在 `$DSH_HOME/settings.yaml` 的 `memory:` 分节；解析顺序 = schema 默认
 * < 组合层 base（cordis.yml 行配置）< 用户分节。客户端卡片与 Host 消费方
 * 通过该命名空间配对。
 * @module dsh-memory/settings
 */

import s from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** 设置命名空间的值（Host 注册键与浏览器卡片 `key` 必须拼写一致）。 */
export const MEMORY_SETTINGS_NS_VALUE = 'memory'

/** 设置命名空间的品牌化 id。 */
export const MEMORY_SETTINGS_NS = settingsNamespace(MEMORY_SETTINGS_NS_VALUE)

/** 触发自动捕获的默认句式（与插件 Config 的 capturePatterns 缺省共享）。 */
export const DEFAULT_CAPTURE_PATTERNS: readonly string[] = Object.freeze([
  '请记住', '记住：', '记住:', 'remember that', 'please remember', 'remember:',
])

/** 用户在设置面板可编辑的记忆行为子集（其余参数留在 cordis.yml 行配置）。 */
export interface MemorySettings {
  /** 是否向每次模型请求注入记忆上下文。 */
  readonly injectEnabled: boolean
  /** 注入记忆条数上限。 */
  readonly injectLimit: number
  /** 注入文本 UTF-16 长度上限。 */
  readonly injectMaxChars: number
  /** 是否自动捕获用户「记住」句式。 */
  readonly captureEnabled: boolean
  /** 触发自动捕获的句式（大小写不敏感子串）。 */
  readonly capturePatterns: string[]
  /** 每个运行期会话的自动捕获条数上限。 */
  readonly captureMaxPerSession: number
}

/** 记忆设置分节的 schema；缺省值与插件 Config 的对应字段一致。 */
export const MEMORY_SETTINGS_SCHEMA: s<MemorySettings> = s.object({
  injectEnabled: s.boolean().default(true),
  injectLimit: s.number().step(1).min(1).max(50).default(8),
  injectMaxChars: s.number().step(1).min(100).max(20000).default(1500),
  captureEnabled: s.boolean().default(true),
  capturePatterns: s.array(s.string()).default([...DEFAULT_CAPTURE_PATTERNS]),
  captureMaxPerSession: s.number().step(1).min(1).max(1000).default(20),
})