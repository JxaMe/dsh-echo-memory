/**
 * dsh-memory 设置卡片：编辑 `memory` 命名空间的用户分节。
 * 结构与视觉复刻官方 PluginCard + fields（ui-settings-plugins 的私有实现，
 * 不得跨插件导入，故以自包含方式重写）：默认折叠，header 整行可点展开；
 * 展开态是卡片局部 state，草稿存于 controller、独立于折叠保留。
 * 样式经一次性注入的 `<style>`（类名前缀 `dshm-` 隔离，幂等）承载——
 * 数值逐项取自官方 PluginCard.module.css / fields.module.css，
 * 内联 style 无法表达 :hover / :focus-visible / 相邻选择器。
 * @module dsh-memory/client/card
 */

import { useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryCardFace, MemoryCardField, MemoryCardFieldState, MemoryCardState } from './card-controller.ts'
import type { MemoryCardTextField } from './card-controller.ts'
import type { MemoryKey } from './locales.ts'

/** 卡片组件 props：槽位运行时份额 + locale 份额 + 插槽 inject 面。 */
export type MemoryPluginCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.memory'>
  & InjectFace<MemoryCardFace>

/** 注入样式表的元素 id（幂等锚点）。 */
const STYLE_ID = 'dsh-memory-card-styles'

/**
 * 把卡片样式注入文档头（幂等）：数值逐项对齐官方
 * PluginCard.module.css / fields.module.css，仅类名加 `dshm-` 前缀隔离。
 */
function ensureCardStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.textContent = `
.dshm-card { list-style: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-3); transition: border-color .16s, background .16s; }
.dshm-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.dshm-cardOpen { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-label-dimmed); }
.dshm-header { width: 100%; appearance: none; border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-radius: 12px; }
.dshm-header:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dshm-headText { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dshm-name { font-size: 15px; font-weight: 600; line-height: 1.4; color: var(--dsw-alias-label-primary); }
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
.dshm-inputInvalid { border-color: var(--dsw-alias-label-error); }
textarea.dshm-input { height: auto; min-height: 72px; padding: 8px 12px; resize: vertical; }
.dshm-checkbox { width: 16px; height: 16px; margin: 0; accent-color: var(--dsw-alias-brand-primary); }
.dshm-checkbox:disabled { cursor: default; }
.dshm-invalid { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-error); }
.dshm-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dshm-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 0 4px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dshm-failed { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-error); }
.dshm-btn { appearance: none; border: 1px solid transparent; border-radius: 8px; padding: 5px 14px; font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer; }
.dshm-discard { border-color: var(--dsw-alias-border-l2); background: none; color: var(--dsw-alias-label-secondary); }
.dshm-discard:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }
.dshm-save { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
.dshm-btn:disabled { opacity: 0.4; cursor: default; }
.dshm-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
`
  document.head.appendChild(tag)
}

/**
 * 字段行的覆盖态头部件：「已覆盖」徽标 +「恢复默认」按钮（对齐官方 fields 布局）。
 */
function OverrideHead(props: {
  htmlFor: string
  label: string
  overriddenLabel: string
  resetLabel: string
  overridden: boolean
  onReset: () => void
}) {
  return (
    <div className="dshm-head">
      <label className="dshm-label" htmlFor={props.htmlFor}>{props.label}</label>
      {props.overridden
        ? (
          <>
            <span className="dshm-badge">{props.overriddenLabel}</span>
            <button type="button" className="dshm-reset" onClick={props.onReset}>{props.resetLabel}</button>
          </>
        )
        : null}
    </div>
  )
}

/**
 * 渲染一句话字段控件（数字/句式文本，纵向布局对齐官方 ValueField）。
 */
export function MemoryTextField(props: {
  t: (key: MemoryKey) => string
  id: string
  label: string
  hint: string
  state: MemoryCardFieldState
  field: MemoryCardTextField
  textarea?: boolean
  numeric?: boolean
  onEdit: (text: string) => void
  onReset: (field: MemoryCardField) => void
}) {
  const { t, state } = props
  const inputClass = state.invalid ? 'dshm-input dshm-inputInvalid' : 'dshm-input'
  const common = {
    id: props.id,
    className: inputClass,
    value: state.text,
    'aria-invalid': state.invalid,
    onChange: (event: { target: { value: string } }) => { props.onEdit(event.target.value) },
  }
  return (
    <div className="dshm-field">
      <OverrideHead
        htmlFor={props.id}
        label={props.label}
        overriddenLabel={t('field.overridden')}
        resetLabel={t('field.reset')}
        overridden={state.overridden}
        onReset={() => { props.onReset(props.field) }}
      />
      {props.textarea === true
        ? <textarea rows={3} {...common} />
        : <input type="text" inputMode={props.numeric === true ? 'numeric' : undefined} {...common} />}
      <p className={state.invalid ? 'dshm-invalid' : 'dshm-hint'}>
        {state.invalid ? t('field.invalidNumber') : props.hint}
      </p>
    </div>
  )
}

/** 布尔字段行：开关 + 提示（官方无布尔字段先例，沿用 field 纵向结构）。 */
function MemoryBooleanField(props: {
  t: (key: MemoryKey) => string
  id: string
  label: string
  hint: string
  checked: boolean
  overridden: boolean
  disabled: boolean
  onToggle: (checked: boolean) => void
  onReset: () => void
}) {
  const { t } = props
  return (
    <div className="dshm-field">
      <OverrideHead
        htmlFor={props.id}
        label={props.label}
        overriddenLabel={t('field.overridden')}
        resetLabel={t('field.reset')}
        overridden={props.overridden}
        onReset={props.onReset}
      />
      <div>
        <input
          id={props.id}
          type="checkbox"
          className="dshm-checkbox"
          checked={props.checked}
          disabled={props.disabled}
          onChange={(event) => { props.onToggle(event.target.checked) }}
        />
      </div>
      <p className="dshm-hint">{props.hint}</p>
    </div>
  )
}

/**
 * 渲染 dsh-memory 设置卡片（默认折叠，header 点击展开；草稿独立于折叠保留）。
 * @param props - locale 文案、卡片状态快照（useMemoryCard）与表单动作。
 * @returns 折叠卡片；命名空间未受服务时不渲染（对齐官方：不留禁用卡残迹）。
 */
export function MemoryPluginCard(props: MemoryPluginCardProps) {
  const [open, setOpen] = useState(false)
  ensureCardStyles()
  const { t } = props
  const state = props.useMemoryCard(snapshot => snapshot)
  if (!state.available) return null
  const title = t('card.title')
  const saveDisabled = !state.writable || state.invalid || state.saving || !state.dirty
  const discardDisabled = state.saving || !state.dirty
  const writable = state.writable
  return (
    <li className={open ? 'dshm-card dshm-cardOpen' : 'dshm-card'}>
      <button
        type="button"
        className="dshm-header"
        aria-expanded={open}
        aria-label={`${t(open ? 'card.collapse' : 'card.expand')}：${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className="dshm-headText">
          <span className="dshm-name">{title}</span>
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
            <MemoryBooleanField
              t={t}
              id="dsh-memory-inject-enabled"
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
              id="dsh-memory-inject-limit"
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
              id="dsh-memory-inject-chars"
              label={t('field.injectMaxChars')}
              hint={t('field.injectMaxChars.hint')}
              state={state.injectMaxChars}
              field="injectMaxChars"
              numeric
              onEdit={(text) => { props.edit('injectMaxChars', text) }}
              onReset={props.resetField}
            />
            <MemoryBooleanField
              t={t}
              id="dsh-memory-capture-enabled"
              label={t('field.captureEnabled')}
              hint={t('field.captureEnabled.hint')}
              checked={state.captureEnabled.checked}
              overridden={state.captureEnabled.overridden}
              disabled={!writable}
              onToggle={(checked) => { props.toggle('captureEnabled', checked) }}
              onReset={() => { props.resetField('captureEnabled') }}
            />
            <MemoryTextField
              t={t}
              id="dsh-memory-capture-patterns"
              label={t('field.capturePatterns')}
              hint={t('field.capturePatterns.hint')}
              state={state.capturePatterns}
              field="capturePatterns"
              textarea
              onEdit={(text) => { props.edit('capturePatterns', text) }}
              onReset={props.resetField}
            />
            <MemoryTextField
              t={t}
              id="dsh-memory-capture-max"
              label={t('field.captureMaxPerSession')}
              hint={t('field.captureMaxPerSession.hint')}
              state={state.captureMaxPerSession}
              field="captureMaxPerSession"
              numeric
              onEdit={(text) => { props.edit('captureMaxPerSession', text) }}
              onReset={props.resetField}
            />
            <div className="dshm-footer">
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
