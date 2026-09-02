/**
 * Dock 纯工具函数：标题/正文切分、相对时间文案、剪贴板复制。
 * 与 React 无关，可单测；GlobalDock 与记忆列表项共用。
 * @module dsh-echo-memory/client/dock-util
 */

/** 把记忆正文切成「标题：正文」（冒号/逗号/短正文）形状。 */
export function splitTitle(content: string): { title: string; body: string } {
  const raw = content.trim()
  const colon = raw.search(/[:：]/)
  if (colon > 0 && colon < 24) {
    return { title: raw.slice(0, colon).trim(), body: raw.slice(colon + 1).replace(/^[:：\s]+/, '').trim() }
  }
  const comma = raw.search(/[，,]/)
  if (comma > 0 && comma < 24) {
    return { title: raw.slice(0, comma).trim(), body: raw.slice(comma + 1).trim() }
  }
  if (raw.length <= 20) return { title: raw, body: '' }
  return { title: '', body: raw }
}

/** 相对时间文案（刚刚 / N分钟前 / N小时前 / N天前）。 */
export function formatTime(ts: number): string {
  const d = Date.now() - ts
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}小时前`
  return `${Math.floor(d / 86_400_000)}天前`
}

/** 复制文本到剪贴板（navigator.clipboard，回退 execCommand）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch { return false }
}

/** Dock 全局轻提示（面板与原点共用，GlobalDock 持有单一真相）。 */
export type Toast = { text: string; kind: 'ok' | 'error' }

/** 存储恢复事件（host `/api/dsh-echo-memory/storage-status` 返回的 recovered）。 */
export type StorageRecovered = { at: number; backupPath: string }
