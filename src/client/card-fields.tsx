/**
 * 记忆卡片的字段控件簇：覆盖态头 + 文本/布尔/选项三字段行。
 * 纯显示组件（props + locale），与卡片的暂存/保存逻辑解耦——调用方只学三个字段 + OverrideHead。
 * 样式类（dshm-*）由 card-styles.ts 一次性注入。
 * @module dsh-echo-memory/client/card-fields
 */

import type { DeletionMode } from '../settings.ts'
import type { MemoryKey } from './locales.ts'
import type { MemoryCardField, MemoryCardFieldState, MemoryCardTextField } from './card-controller.ts'

/**
 * 字段行的覆盖态头部件：「已覆盖」徽标 +「恢复默认」按钮（对齐官方 fields 布局）。
 */
export function OverrideHead(props: {
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
 * 渲染一句话字段控件（数字/文本，纵向布局对齐官方 ValueField）。
 */
export function MemoryTextField(props: {
  t: (key: MemoryKey) => string
  id: string
  label: string
  hint: string
  state: MemoryCardFieldState
  field: MemoryCardTextField
  numeric?: boolean | undefined
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
      <input type="text" inputMode={props.numeric === true ? 'numeric' : undefined} {...common} />
      <p className={state.invalid ? 'dshm-invalid' : 'dshm-hint'}>
        {state.invalid ? t('field.invalidNumber') : props.hint}
      </p>
    </div>
  )
}

/** 布尔字段行：开关 + 提示（官方无布尔字段先例，沿用 field 纵向结构）。 */
export function MemoryBooleanField(props: {
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

/** 选项字段行：下拉选择（两个删除模式之一）+ 提示。 */
export function MemoryChoiceField(props: {
  t: (key: MemoryKey) => string
  id: string
  label: string
  hint: string
  value: DeletionMode
  overridden: boolean
  disabled: boolean
  options: readonly { value: DeletionMode; label: string }[]
  onChoose: (value: DeletionMode) => void
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
      <select
        id={props.id}
        className="dshm-input"
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => {
          const value = event.target.value
          if (value === 'tombstone' || value === 'purge') props.onChoose(value)
        }}
      >
        {props.options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <p className="dshm-hint">{props.hint}</p>
    </div>
  )
}
