/**
 * dsh-echo-memory 设置卡片：编辑 `memory` 命名空间的用户分节。
 * 结构与视觉复刻官方 PluginCard + fields（ui-settings-plugins 的私有实现，
 * 不得跨插件导入，故以自包含方式重写）：默认折叠，header 整行可点展开；
 * 展开态是卡片局部 state，草稿存于 controller、独立于折叠保留。
 * 样式经一次性注入的 `<style>`（类名前缀 `dshm-` 隔离，幂等）承载——
 * 数值逐项取自官方 PluginCard.module.css / fields.module.css，
 * 内联 style 无法表达 :hover / :focus-visible / 相邻选择器。
 * @module dsh-echo-memory/client/card
 */

import { useEffect, useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryCardFace } from './card-controller.ts'
import type { MemoryKey } from './locales.ts'
import { copyText, formatTime } from './dock-util.ts'
import { elephantImage } from './elephantImage.ts'
import { MemoryBooleanField, MemoryChoiceField, MemoryTextField } from './card-fields.tsx'
import { ensureCardStyles } from './card-styles.ts'
import pkg from '../../package.json' with { type: 'json' }

/** 卡片组件 props：槽位运行时份额 + locale 份额 + 插槽 inject 面。 */
export type MemoryPluginCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.memory'>
  & InjectFace<MemoryCardFace>

/** 回收站单项动作反馈的文案键映射（controller 存 message 码，渲染时才取词）。 */
const ACTION_FEEDBACK_KEYS = {
  restored: 'action.feedback.restored',
  restoreFailed: 'action.feedback.restoreFailed',
  purgedOne: 'action.feedback.purgedOne',
  purgeOneFailed: 'action.feedback.purgeOneFailed',
  updated: 'action.feedback.updated',
  updateFailed: 'action.feedback.updateFailed',
} as const satisfies Record<string, MemoryKey>


/** 统计行渲染：注入命中率 + 活跃记忆条数（纯函数）。 */
function renderStats(t: (key: MemoryKey) => string, data: { readonly injections: { readonly requests: number; readonly withContent: number }; readonly memories: number }): string {
  const rate = data.injections.requests > 0
    ? Math.round((data.injections.withContent / data.injections.requests) * 100)
    : 0
  return t('stats.line')
    .replaceAll('{hits}', String(data.injections.withContent))
    .replaceAll('{requests}', String(data.injections.requests))
    .replaceAll('{rate}', String(rate))
    .replaceAll('{memories}', String(data.memories))
}

/**
 * 渲染 dsh-echo-memory 设置卡片（默认折叠，header 点击展开；草稿独立于折叠保留）。
 * @param props - locale 文案、卡片状态快照（useMemoryCard）与表单动作。
 * @returns 折叠卡片；命名空间未受服务时不渲染（对齐官方：不留禁用卡残迹）。
 */
export function MemoryPluginCard(props: MemoryPluginCardProps) {
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  ensureCardStyles()
  // 展开时拉取一次运行期统计与回收站（重复展开会再拉，数据保鲜）。
  useEffect(() => {
    if (open) {
      props.refreshStats()
      props.refreshRecycle()
    }
  }, [open, props])
  const handleCopy = (id: string, text: string) => {
    void copyText(text).then((ok) => {
      if (!ok) return
      setCopiedId(id)
      setTimeout(() => setCopiedId(prev => prev === id ? null : prev), 1200)
    })
  }
  const startEdit = (id: string, content: string) => {
    setEditingId(id)
    setEditingContent(content)
  }
  const cancelEdit = () => {
    setEditingId(null)
    setEditingContent('')
  }
  const saveEdit = async () => {
    if (editingId === null) return
    const c = editingContent.trim()
    if (c.length === 0) return
    const ok = await props.updateOne(editingId, { content: c })
    if (ok) cancelEdit()
    // 失败：保持编辑态与草稿，反馈由 actionFeedback「更新失败」呈现
  }
  const { t } = props
  const state = props.useMemoryCard(snapshot => snapshot)
  if (!state.available) return null
  const version = (pkg as { version?: string }).version ?? ''
  const baseTitle = t('card.title')
  const saveDisabled = !state.writable || state.invalid || state.saving || !state.dirty
  const discardDisabled = state.saving || !state.dirty
  const writable = state.writable
  return (
    <li className={open ? 'dshm-card dshm-cardOpen' : 'dshm-card'}>
      <button
        type="button"
        className="dshm-header"
        aria-expanded={open}
        aria-label={`${t(open ? 'card.collapse' : 'card.expand')}：${baseTitle}`}
        onClick={() => { setOpen(!open) }}
      >
        <span style={{ flex: 'none', width: '32px', height: '32px', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-3)', border: '1px solid white', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', padding: 0, boxShadow: '0 1px 6px rgba(0,0,0,0.08)' }} aria-hidden>
          <img src={elephantImage} alt="" draggable={false} onDragStart={(e) => e.preventDefault()} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none', userSelect: 'none' }} />
        </span>
        <span className="dshm-headText">
          <span className="dshm-name">{baseTitle}<span className="dshm-version">v{version}</span></span>
          <span className="dshm-desc">{t('card.description')}</span>
        </span>
        {state.dirty ? <span className="dshm-pending">{t('card.unsaved')}</span> : null}
        <span className={open ? 'dshm-chevron dshm-chevronOpen' : 'dshm-chevron'} aria-hidden={true}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open
        ? (
          <div className="dshm-body">
            {!writable ? <p className="dshm-readOnly" role="status">{t('status.readOnly')}</p> : null}
            {state.stats.phase === 'done'
              ? (
                <p className="dshm-hint" role="status">
                  {renderStats(t, state.stats.data)}
                </p>
              )
              : state.stats.phase === 'failed'
                ? <p className="dshm-hint" role="status">{t('stats.failed')}</p>
                : null}
            <MemoryBooleanField
              t={t}
              id="dsh-echo-memory-inject-enabled"
              label={t('field.injectEnabled')}
              hint={t('field.injectEnabled.hint')}
              checked={state.injectEnabled.checked}
              overridden={state.injectEnabled.overridden}
              disabled={!writable}
              onToggle={(checked) => { props.toggle('injectEnabled', checked) }}
              onReset={() => { props.resetField('injectEnabled') }}
            />
            <MemoryTextField
              t={t}
              id="dsh-echo-memory-inject-limit"
              label={t('field.injectLimit')}
              hint={t('field.injectLimit.hint')}
              state={state.injectLimit}
              field="injectLimit"
              numeric
              onEdit={(text) => { props.edit('injectLimit', text) }}
              onReset={props.resetField}
            />
            <MemoryTextField
              t={t}
              id="dsh-echo-memory-inject-chars"
              label={t('field.injectMaxChars')}
              hint={t('field.injectMaxChars.hint')}
              state={state.injectMaxChars}
              field="injectMaxChars"
              numeric
              onEdit={(text) => { props.edit('injectMaxChars', text) }}
              onReset={props.resetField}
            />
            {state.stats.phase === 'done' ? (() => {
              const limit = Number.parseInt(state.injectLimit.text, 10)
              const max = Number.parseInt(state.injectMaxChars.text, 10)
              const lim = Number.isFinite(limit) && limit > 0 ? limit : 8
              const mx = Number.isFinite(max) && max > 0 ? max : 1500
              const mem = state.stats.data.memories
              const used = Math.min(lim, mem) * 85
              const pct = Math.min(100, Math.round((used / mx) * 100))
              return (
                <div style={{ marginTop: '-6px', marginBottom: '6px' }}>
                  <div className="dshm-progress"><div className="dshm-progressFill" style={{ width: `${pct}%` }} /></div>
                  <p className="dshm-hint" style={{ marginTop: '4px' }}>预估占用 ~{used}/{mx} 字符 · {mem} 条记忆 · 上限 {lim} 条 {pct >= 90 ? '· 接近上限' : ''}</p>
                </div>
              )
            })() : null}
            <MemoryChoiceField
              t={t}
              id="dsh-echo-memory-deletion-mode"
              label={t('field.deletionMode')}
              hint={t('field.deletionMode.hint')}
              value={state.deletionMode.value}
              overridden={state.deletionMode.overridden}
              disabled={!writable}
              options={[
                { value: 'tombstone', label: t('option.deletionMode.tombstone') },
                { value: 'purge', label: t('option.deletionMode.purge') },
              ]}
              onChoose={(value) => { props.choose('deletionMode', value) }}
              onReset={() => { props.resetField('deletionMode') }}
            />
            {state.deletionMode.value === 'tombstone'
              ? (
                <>
                  <div className="dshm-field dshm-purge">
                    <p className="dshm-hint">{t('field.purge.hint')}</p>
                    <div className="dshm-purgeRow">
                      <button
                        type="button"
                        className="dshm-btn dshm-danger"
                        disabled={!writable || state.purge.phase === 'busy'}
                        onClick={() => {
                          if (!window.confirm(t('action.purge.confirm'))) return
                          void props.purgeTombstones()
                        }}
                      >
                        {state.purge.phase === 'busy' ? t('action.purge.busy') : t('action.purge')}
                      </button>
                      {state.purge.phase === 'done'
                        ? (
                          <p className="dshm-hint" role="status">
                            {state.purge.purged > 0
                              ? t('status.purge.done').replaceAll('{n}', String(state.purge.purged))
                              : t('status.purge.empty')}
                          </p>
                        )
                        : null}
                      {state.purge.phase === 'failed'
                        ? <p className="dshm-invalid" role="status">{t('status.purge.failed')}</p>
                        : null}
                    </div>
                  </div>
                  <div className="dshm-recycle">
                    <div className="dshm-recycleHead">
                      <span className="dshm-recycleTitle">{t('field.recycle.title')}</span>
                      <button type="button" className="dshm-reset" onClick={() => { props.refreshRecycle() }}>{t('action.recycle.refresh')}</button>
                    </div>
                    <p className="dshm-hint" style={{ marginBottom: '8px' }}>{t('field.recycle.hint')}</p>
                    {state.recycle.phase === 'loading'
                      ? <p className="dshm-hint">{t('dock.loading')}</p>
                      : state.recycle.phase === 'failed'
                        ? <p className="dshm-invalid">{t('status.recycle.failed')}</p>
                        : state.recycle.phase === 'done' && state.recycle.items.length === 0
                          ? (
                            <div style={{ textAlign: 'center', padding: '16px 0' }}>
                              <div style={{ fontSize: '28px', lineHeight: 1 }}>🗑️</div>
                              <p className="dshm-hint" style={{ marginTop: '6px' }}>{t('field.recycle.empty')}</p>
                              {state.stats.phase === 'done' && state.stats.data.memories === 0 ? (
                                <div style={{ marginTop: '8px' }}>
                                  <p className="dshm-hint">试试说：</p>
                                  <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', flexWrap: 'wrap', marginTop: '4px' }}>
                                    {['帮我记住这个项目用 pnpm', '帮我记住 VPS 在 192.168.1.10', '帮我记住偏好简洁回复'].map(ex => (
                                      <button key={ex} type="button" className="dshm-badge" style={{ cursor: 'pointer', border: 'none' }} onClick={() => { void copyText(ex) }}>{ex}</button>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          )
                          : state.recycle.phase === 'done'
                            ? (
                              <>
                                <p className="dshm-hint" style={{ marginBottom: '6px' }}>{t('field.recycle.count').replaceAll('{n}', String(state.recycle.items.length))}</p>
                                <div className="dshm-recycleList">
                                  {state.recycle.items.map(item => (
                                    <div key={item.id} className="dshm-recycleItem">
                                      <div className="dshm-recycleContent">
                                        {editingId === item.id ? (
                                          <textarea className="dshm-input" style={{ width: '100%', minHeight: '56px' }} value={editingContent} onChange={e => setEditingContent(e.target.value)} />
                                        ) : (
                                          <div>{item.content}</div>
                                        )}
                                        <div className="dshm-recycleMeta" title={new Date(item.deletedAt).toLocaleString()}>{item.kind} · {item.workspace}{item.tags.length > 0 ? ` · #${item.tags.join(' #')}` : ''} · {formatTime(item.deletedAt)}</div>
                                      </div>
                                      <div className="dshm-recycleActions">
                                        {editingId === item.id ? (
                                          <>
                                            <button type="button" className="dshm-btn dshm-btnSmall dshm-save" onClick={() => void saveEdit()}>保存</button>
                                            <button type="button" className="dshm-btn dshm-btnSmall" onClick={cancelEdit}>取消</button>
                                          </>
                                        ) : (
                                          <>
                                            <button type="button" className="dshm-btn dshm-btnSmall" disabled={!writable} title="复制" onClick={() => handleCopy(item.id, item.content)}>{copiedId === item.id ? '已复制' : '⎘'}</button>
                                            <button type="button" className="dshm-btn dshm-btnSmall" disabled={!writable} onClick={() => startEdit(item.id, item.content)}>✎</button>
                                            <button type="button" className="dshm-btn dshm-btnSmall" disabled={!writable} onClick={() => { void props.restoreOne(item.id) }}>{t('action.recycle.restore')}</button>
                                            <button type="button" className="dshm-btn dshm-btnSmall dshm-danger" disabled={!writable} onClick={() => {
                                              if (!window.confirm(t('action.recycle.purgeOne.confirm'))) return
                                              void props.purgeOne(item.id)
                                            }}>{t('action.recycle.purgeOne')}</button>
                                          </>
                                        )}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </>
                            )
                            : null}
                  </div>
                </>
              )
              : null}
            {state.actionFeedback ? (
              <p
                className={state.actionFeedback.kind === 'error' ? 'dshm-failed' : 'dshm-hint'}
                role="status"
                style={state.actionFeedback.kind === 'ok' ? { color: 'var(--dsw-alias-brand-primary)' } : undefined}
              >
                {t(ACTION_FEEDBACK_KEYS[state.actionFeedback.message])}
              </p>
            ) : null}
            <div className="dshm-footer">
              {state.justSaved ? <p className="dshm-hint" role="status" style={{ color: 'var(--dsw-alias-brand-primary)' }}>已保存 ✅</p> : null}
              {state.failed ? <p className="dshm-failed" role="status">{t('status.failed')}</p> : null}
              <button
                type="button"
                className="dshm-btn dshm-discard"
                onClick={props.discard}
                disabled={discardDisabled}
              >
                {t('action.discard')}
              </button>
              <button
                type="button"
                className="dshm-btn dshm-save"
                onClick={() => { void props.save() }}
                disabled={saveDisabled}
              >
                {state.saving ? t('status.saving') : t('action.save')}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}
