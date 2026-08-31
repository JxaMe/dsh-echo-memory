/** `settings.memory` 命名空间字典（dsh-memory 设置卡片的文案）。 */

/** 简体中文词典（键集的事实标准）。 */
export const zh = {
  'card.title': '记忆（dsh-memory）',
  'card.description': '跨会话持久记忆：提示词注入与自动捕获的行为设置，保存后即时生效。',
  'card.expand': '展开设置',
  'card.collapse': '收起设置',
  'card.unsaved': '未保存',
  'field.injectEnabled': '提示词注入',
  'field.injectEnabled.hint': '每次模型请求注入当前工作区的记忆',
  'field.injectLimit': '注入条数上限',
  'field.injectLimit.hint': '单次注入记忆条目数（1–50）',
  'field.injectMaxChars': '注入文本长度上限',
  'field.injectMaxChars.hint': '注入文本 UTF-16 长度上限（100–20000）',
  'field.captureEnabled': '自动捕获「记住」句式',
  'field.captureEnabled.hint': '从用户消息中识别「记住 / 请记住 / remember that」等句式并自动落库',
  'field.capturePatterns': '捕获句式',
  'field.capturePatterns.hint': '每行一条触发句式（大小写不敏感的子串匹配）',
  'field.captureMaxPerSession': '每会话捕获条数上限',
  'field.captureMaxPerSession.hint': '单个运行期会话自动捕获的记忆条数上限（1–1000）',
  'field.overridden': '已覆盖',
  'field.reset': '恢复默认',
  'field.invalidNumber': '请填数字；留空表示使用默认值。',
  'action.save': '保存',
  'action.discard': '放弃修改',
  'status.saving': '保存中…',
  'status.failed': '本部署没有接受这些值，已保留供你修改。',
  'status.readOnly': '本部署的设置为只读。',
  'status.unavailable': '记忆设置暂不可用',
} satisfies Record<string, string>

/** `settings.memory` 命名空间的键并集。 */
export type MemoryKey = keyof typeof zh

/** 英文词典（与中文键集完整对应）。 */
export const en = {
  'card.title': 'Memory (dsh-memory)',
  'card.description': 'Cross-session persistent memory: prompt injection and auto-capture behavior. Changes apply immediately after saving.',
  'card.expand': 'Show settings',
  'card.collapse': 'Hide settings',
  'card.unsaved': 'Unsaved',
  'field.injectEnabled': 'Prompt injection',
  'field.injectEnabled.hint': 'Inject memories of the current workspace into every model request',
  'field.injectLimit': 'Injection entry limit',
  'field.injectLimit.hint': 'Memories injected per request (1–50)',
  'field.injectMaxChars': 'Injection text limit',
  'field.injectMaxChars.hint': 'UTF-16 length cap of the injected text (100–20000)',
  'field.captureEnabled': 'Auto-capture "remember" phrases',
  'field.captureEnabled.hint': 'Detect phrases like "remember / please remember / remember that" in user messages and store them',
  'field.capturePatterns': 'Capture phrases',
  'field.capturePatterns.hint': 'One trigger phrase per line (case-insensitive substring match)',
  'field.captureMaxPerSession': 'Per-session capture limit',
  'field.captureMaxPerSession.hint': 'Auto-captured memories per running session (1–1000)',
  'field.overridden': 'Overridden',
  'field.reset': 'Reset',
  'field.invalidNumber': 'Enter a number; empty means using the default.',
  'action.save': 'Save',
  'action.discard': 'Discard changes',
  'status.saving': 'Saving…',
  'status.failed': 'The deployment did not accept these values; they were left for you to correct.',
  'status.readOnly': 'This deployment stores settings read-only.',
  'status.unavailable': 'Memory settings are unavailable',
} satisfies Record<MemoryKey, string>