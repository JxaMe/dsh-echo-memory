/**
 * Dock 记忆列表项：徽标行 + 正文（编辑态 textarea + 操作按钮）。
 * 纯展示组件，动作经 props 回调交给 GlobalDock（失败反馈/乐观 UI 都在父层）。
 * @module dsh-echo-memory/client/memory-list-item
 */

import type { MemoryRecord } from './memory-repo.ts'
import { formatTime } from './dock-util.ts'

export function MemoryListItem(props: {
  r: MemoryRecord
  isEditing: boolean
  draft: string
  onDraftChange: (text: string) => void
  onCancel: () => void
  onSave: () => void
  onStartEdit: () => void
  onDelete: () => void
  onCopy: () => void
}) {
  const { r, isEditing, draft } = props
  return (
    <div
      style={{
        padding: '10px 8px',
        borderRadius: '8px',
        background: isEditing ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
        marginBottom: '2px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', border: '1px solid var(--dsw-alias-border-l2)', padding: '0 5px', borderRadius: '999px', lineHeight: '16px' }}>{r.kind}</span>
        <span style={{ fontSize: '11px', color: r.workspace === '*' ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-tertiary)', border: '1px solid var(--dsw-alias-border-l2)', padding: '0 5px', borderRadius: '999px', lineHeight: '16px', background: r.workspace === '*' ? 'rgba(99,102,241,0.08)' : 'transparent' }}>{r.workspace === '*' ? '全局' : (r.workspace.split('/').pop() || '项目')}</span>
        <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }}>{formatTime(r.updatedAt)}</span>
        {r.tags.length > 0 && <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }}>#{r.tags[0]}</span>}
        {r.strength > 1 && <span style={{ fontSize: '10px', color: 'var(--dsw-alias-label-tertiary)' }}>×{r.strength}</span>}
      </div>
      {isEditing ? (
        <div style={{ marginTop: '6px' }}>
          <textarea
            value={draft}
            onChange={(e) => props.onDraftChange(e.target.value)}
            rows={3}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '8px',
              borderRadius: '8px',
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-base)',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: '12px',
              resize: 'vertical',
              outline: 'none',
            }}
            autoFocus
          />
          <div style={{ display: 'flex', gap: '6px', marginTop: '6px', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={props.onCancel}
              style={{ padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', fontSize: '12px', cursor: 'pointer' }}
            >
              取消
            </button>
            <button
              type="button"
              onClick={props.onSave}
              style={{ padding: '4px 10px', borderRadius: '6px', border: 'none', background: 'var(--dsw-alias-interactive-bg)', color: 'white', fontSize: '12px', cursor: 'pointer' }}
            >
              保存
            </button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)', marginTop: '4px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-word' }}>
            {r.content}
          </div>
          <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
            <button
              type="button"
              onClick={props.onStartEdit}
              style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', padding: '2px 4px' }}
            >
              ✎ 编辑
            </button>
            <button
              type="button"
              onClick={props.onDelete}
              style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', padding: '2px 4px' }}
            >
              🗑 删除
            </button>
            <button
              type="button"
              onClick={props.onCopy}
              style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', padding: '2px 4px' }}
            >
              ⎘ 复制
            </button>
          </div>
        </>
      )}
    </div>
  )
}
