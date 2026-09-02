/**
 * 记忆卡片样式：一次性注入的 `<style>`（类名前缀 `dshm-` 隔离，幂等）。
 * 数值逐项对齐官方 PluginCard.module.css / fields.module.css——改样式先读官方源码。
 * @module dsh-echo-memory/client/card-styles
 */

/** 注入样式表的元素 id（幂等锚点）。 */
export const CARD_STYLE_ID = 'dsh-echo-memory-card-styles'

/**
 * 把卡片样式注入文档头（幂等）：数值逐项对齐官方
 * PluginCard.module.css / fields.module.css，仅类名加 `dshm-` 前缀隔离。
 */
export function ensureCardStyles(): void {
  if (document.getElementById(CARD_STYLE_ID) !== null) return
  const tag = document.createElement('style')
  tag.id = CARD_STYLE_ID
  tag.textContent = `.dshm-card { list-style: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-3); transition: border-color .16s, background .16s; }
.dshm-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.dshm-cardOpen { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-label-dimmed); }
.dshm-header { width: 100%; appearance: none; border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-radius: 12px; }
.dshm-header:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dshm-headText { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dshm-name { font-size: 15px; font-weight: 600; line-height: 1.4; color: var(--dsw-alias-label-primary); }
.dshm-version { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary); margin-left: 6px; vertical-align: middle; }
.dshm-desc { font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dshm-pending { flex: none; border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.dshm-chevron { flex: none; display: inline-flex; color: var(--dsw-alias-label-tertiary); transition: transform .16s; }
.dshm-chevronOpen { transform: rotate(180deg); }
.dshm-body { border-top: 1px solid var(--dsw-alias-border-l2); margin: 0 16px; padding-bottom: 8px; }
.dshm-readOnly { margin: 12px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dshm-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.dshm-field + .dshm-field { border-top: 1px solid var(--dsw-alias-border-l2); }
.dshm-head { display: flex; align-items: center; gap: 8px; }
.dshm-label { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dshm-badge { border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 17px; white-space: nowrap; font-weight: 500; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.dshm-reset { border: none; background: none; padding: 0; font: inherit; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dshm-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.dshm-input { height: 34px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dshm-input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dshm-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dshm-inputInvalid { border-color: var(--dsw-alias-state-error-primary); }
textarea.dshm-input { height: auto; min-height: 72px; padding: 8px 12px; resize: vertical; }
.dshm-checkbox { width: 16px; height: 16px; margin: 0; accent-color: var(--dsw-alias-brand-primary); }
.dshm-checkbox:disabled { cursor: default; }
.dshm-invalid { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.dshm-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dshm-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 0 4px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dshm-failed { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.dshm-btn { appearance: none; border: 1px solid transparent; border-radius: 8px; padding: 5px 14px; font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer; }
.dshm-discard { border-color: var(--dsw-alias-border-l2); background: none; color: var(--dsw-alias-label-secondary); }
.dshm-discard:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }
.dshm-save { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
.dshm-btn:disabled { opacity: 0.4; cursor: default; }
.dshm-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshm-purge { border-top: 1px solid var(--dsw-alias-border-l2); }
.dshm-purgeRow { display: flex; align-items: center; gap: 12px; }
.dshm-danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); background: none; }
.dshm-danger:hover:not(:disabled) { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-bg-layer-3); }
.dshm-recycle { border-top: 1px solid var(--dsw-alias-border-l2); padding: 12px 0; }
.dshm-recycleHead { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.dshm-recycleTitle { flex: 1; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dshm-recycleList { display: flex; flex-direction: column; gap: 8px; }
.dshm-recycleItem { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-3); }
.dshm-recycleContent { flex: 1; min-width: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-primary); word-break: break-word; }
.dshm-recycleMeta { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-top: 2px; }
.dshm-recycleActions { display: flex; gap: 6px; flex: none; }
.dshm-btnSmall { padding: 3px 10px; font-size: 12px; }
.dshm-progress { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-module-platform); overflow: hidden; }
.dshm-progressFill { height: 100%; background: var(--dsw-alias-brand-primary); transition: width .22s; }`
  document.head.appendChild(tag)
}
