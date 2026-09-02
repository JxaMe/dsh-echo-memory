/**
 * Dock 召回气泡：命中后悬浮的瞬态卡片（标题 + 正文截断 + 关闭）。
 * 纯展示组件，命中数据与显隐状态由父层（GlobalDock + useRecallFeed）持有。
 * @module dsh-echo-memory/client/recall-bubble
 */

import { elephantImage } from './elephantImage.ts'
import { splitTitle } from './dock-util.ts'
import type { RecallHit } from './recall-feed.ts'

export function RecallBubble(props: {
  hit: RecallHit
  more: number
  onClose: () => void
  pauseHide: () => void
  resumeHide: () => void
}) {
  const { hit, more } = props
  const { title, body } = splitTitle(hit.content)
  const bodyShort = body.length > 72 ? body.slice(0, 72).trimEnd() + '…' : body
  const titleText = title || (bodyShort ? '' : hit.content.slice(0, 24))
  const contentText = title ? bodyShort : hit.content.slice(0, 72)

  return (
    <div
      onMouseEnter={props.pauseHide}
      onMouseLeave={props.resumeHide}
      style={{
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        padding: '14px 16px',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-2)',
        backdropFilter: 'blur(12px)',
        border: '1px solid var(--dsw-alias-border-l2)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)',
        width: 'min(380px, calc(100vw - 32px))',
        zIndex: 40,
      }}
    >
      <div style={{ paddingTop: '1px' }}><img src={elephantImage} alt="" draggable={false} onDragStart={(e) => e.preventDefault()} style={{ width: '20px', height: '20px', borderRadius: '50%', objectFit: 'cover', display: 'block', border: '1px solid white', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', pointerEvents: 'none', userSelect: 'none' }} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
          {titleText && (
            <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--dsw-alias-label-primary)', lineHeight: 1.4 }}>
              {titleText}
            </span>
          )}
          <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' }}>[{hit.kind}]</span>
          {hit.tags.length > 0 && (
            <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' }}>
              #{hit.tags[0]}
            </span>
          )}
        </div>
        {contentText && (
          <div
            style={{
              fontSize: '12px',
              lineHeight: 1.5,
              color: 'var(--dsw-alias-label-secondary)',
              marginTop: '4px',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              wordBreak: 'break-word',
            }}
          >
            {contentText}
          </div>
        )}
        {more > 0 && (
          <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '6px' }}>
            还有 {more} 条相关记忆
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={props.onClose}
        style={{
          border: 'none',
          background: 'none',
          cursor: 'pointer',
          color: 'var(--dsw-alias-label-tertiary)',
          fontSize: '16px',
          lineHeight: 1,
          padding: '2px 4px',
          marginLeft: '4px',
          flexShrink: 0,
        }}
        aria-label="关闭"
      >
        ×
      </button>
    </div>
  )
}
