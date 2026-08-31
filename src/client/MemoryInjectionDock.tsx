/**
 * 会话注入可视化：复用 `conversation.input.dock`（输入框上方全宽条），折叠展示本次会注入的记忆。
 * 透明可验证 “自动想起” 是否生效；零业务状态外泄，纯展示。
 * @module dsh-echo-memory/client/dock
 */

import { useEffect, useId, useState } from 'react'
import { IconChevronDownOutline14, IconChevronUpOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryKey } from './locales.ts'

/** Host 预览载荷（与 Host injectionPreview 同形）。 */
export interface InjectionPreview {
  readonly enabled: boolean
  readonly workspace: string
  readonly limit: number
  readonly maxChars: number
  readonly items: readonly { readonly id: string; readonly kind: string; readonly content: string; readonly tags: readonly string[]; readonly strength: number; readonly workspace: string }[]
  readonly text: string
}

export type MemoryDockInjected = {
  fetchPreview: (workspace: string) => Promise<InjectionPreview>
}

// ponytail: any cast avoids adding dsh-client-ui-conversation dep for single dock entry; keep runtime type trivial
export type MemoryDockProps =
  PropsLocale<'settings.memory'>
  & MemoryDockInjected
  & Record<string, unknown>

const STYLE_ID = 'dsh-echo-memory-dock-styles'
function ensureDockStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.textContent = `
.dshm-dock { box-sizing: border-box; flex: none; contain: content; width: calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset)); max-width: calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset)); margin: 0 auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.dshm-dockHeader { width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 0; background: none; font: inherit; color: var(--dsw-alias-label-secondary); cursor: pointer; text-align: left; }
.dshm-dockHeader:disabled { cursor: default; opacity: 0.6; }
.dshm-dockTitle { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); white-space: nowrap; }
.dshm-dockMeta { flex: 1; min-width: 0; display: flex; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshm-dockChevron { flex: none; display: inline-flex; color: var(--dsw-alias-label-tertiary); }
.dshm-dockBody { border-top: 1px solid var(--dsw-alias-border-l2); padding: 8px 12px; }
.dshm-dockEmpty { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dshm-dockList { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow-y: auto; }
.dshm-dockItem { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-3); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 6px 8px; word-break: break-word; }
.dshm-dockItemMeta { font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshm-dockActions { display: flex; justify-content: flex-end; padding-top: 8px; }
.dshm-refresh { border: 1px solid var(--dsw-alias-border-l2); background: none; border-radius: 6px; padding: 2px 8px; font: inherit; font-size: 11px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dshm-refresh:hover:not(:disabled) { border-color: var(--dsw-alias-label-dimmed); color: var(--dsw-alias-label-primary); }
`
  document.head.appendChild(tag)
}

function formatWorkspace(workspace: string): string {
  return workspace === '*' ? '*' : workspace
}

export function MemoryInjectionDock(props: MemoryDockProps): React.ReactNode {
  ensureDockStyles()
  const { t, fetchPreview } = props
  // ponytail: 最小可视化 — 只展示 Host 计算的 “本次会注入” 列表，不做实时推送，刷新即重取
  const sessionId = (props as unknown as { useSession?: (sel: (s: { sessionId: string }) => string) => string }).useSession?.(s => s.sessionId) ?? ''
  // 直接 selector 返回 string，避免 items 数组引用抖动导致 workspace 频繁重算
  const workspace = (props as unknown as { useWorkspaces?: (sel: (s: { items: readonly { path: string; sessionIds: readonly string[] }[] }) => string) => string }).useWorkspaces?.(
    (s) => s.items.find((w) => w.sessionIds.includes(sessionId))?.path ?? '*',
  ) ?? '*'

  const [collapsed, setCollapsed] = useState(true)
  const [preview, setPreview] = useState<InjectionPreview | null>(null)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'failed'>('idle')
  const listId = useId()

  const load = async (): Promise<void> => {
    setPhase('loading')
    try {
      const data = await fetchPreview(workspace)
      setPreview(data)
      setPhase('idle')
    } catch (error) {
      console.error('[dsh-echo-memory] dock preview failed', error)
      setPhase('failed')
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 按 workspace 重取，fetchPreview 稳定
  }, [workspace])

  // 空工作区或无会话时仍可展示（workspace='*'）
  const enabled = preview?.enabled ?? true
  const items = preview?.items ?? []
  const usage = preview ? `${preview.text.length} / ${preview.maxChars}` : null

  // 无数据时仍保留头部以体现 “透明”：用户能看到 “暂无注入” 而非 “功能消失”
  const headerCount = phase === 'loading'
    ? t('dock.loading')
    : phase === 'failed'
      ? t('dock.failed')
      : !enabled
        ? t('dock.disabled')
        : items.length > 0
          ? t('dock.count').replaceAll('{n}', String(items.length))
          : t('dock.empty')

  return (
    <section className="dshm-dock" aria-label={t('dock.title')}>
      <button
        type="button"
        className="dshm-dockHeader"
        aria-expanded={!collapsed}
        aria-controls={listId}
        onClick={() => { setCollapsed(v => !v) }}
      >
        <span className="dshm-dockTitle">{t('dock.title')}</span>
        <span className="dshm-dockMeta">
          <span>{headerCount}</span>
          {usage !== null && enabled && items.length > 0 && (
            <span>{t('dock.usage').replaceAll('{used}', String(preview!.text.length)).replaceAll('{max}', String(preview!.maxChars))}</span>
          )}
          <span style={{ flex: 1 }} />
          <span>{t('dock.workspace').replaceAll('{workspace}', formatWorkspace(workspace))}</span>
        </span>
        <span className="dshm-dockChevron" aria-hidden>{collapsed ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}</span>
      </button>
      {!collapsed && (
        <div id={listId} className="dshm-dockBody">
          {phase === 'failed' && <p className="dshm-dockEmpty">{t('dock.failed')}</p>}
          {phase !== 'failed' && !enabled && <p className="dshm-dockEmpty">{t('dock.disabled')}</p>}
          {phase !== 'failed' && enabled && items.length === 0 && <p className="dshm-dockEmpty">{t('dock.empty')}</p>}
          {enabled && items.length > 0 && (
            <ul className="dshm-dockList">
              {items.map(item => (
                <li key={item.id} className="dshm-dockItem">
                  <div>- [{item.kind}] {item.content}{item.tags.length > 0 ? ` #${item.tags.join(' #')}` : ''}{item.strength > 1 ? ` (x${item.strength})` : ''}</div>
                  <div className="dshm-dockItemMeta">{item.workspace}</div>
                </li>
              ))}
            </ul>
          )}
          <div className="dshm-dockActions">
            <button type="button" className="dshm-refresh" onClick={() => { void load() }}>{t('dock.refresh')}</button>
          </div>
        </div>
      )}
    </section>
  )
}
