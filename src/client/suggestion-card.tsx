import type { Suggestion } from './suggestion-feed.ts'

export function SuggestionCard(props: {
  suggestion: Suggestion
  onConfirm: () => void
  onDismiss: () => void
  dotPos: { x: number; y: number } | null
}) {
  const { suggestion, onConfirm, onDismiss, dotPos } = props
  const cardLeft = dotPos ? Math.min(window.innerWidth - 336, Math.max(8, dotPos.x - 276)) : null
  const dotCenterX = dotPos ? dotPos.x + 22 : null
  const arrowLeft = dotPos && cardLeft !== null && dotCenterX !== null ? dotCenterX - cardLeft - 6 : null
  const cardStyle: React.CSSProperties = dotPos
    ? {
        position: 'fixed',
        left: `${cardLeft}px`,
        bottom: `${window.innerHeight - dotPos.y + 12}px`,
        width: '320px',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '14px',
        boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
        padding: '12px 14px',
        zIndex: 45,
        animation: 'dshm-suggest-pop .2s ease',
      }
    : {
        position: 'fixed',
        right: '20px',
        bottom: '80px',
        width: '320px',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '14px',
        boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
        padding: '12px 14px',
        zIndex: 45,
        animation: 'dshm-suggest-pop .2s ease',
      }
  const arrowStyle: React.CSSProperties | undefined =
    dotPos && arrowLeft !== null
      ? {
          position: 'absolute',
          left: `${Math.max(12, Math.min(308, arrowLeft))}px`,
          bottom: '-6px',
          width: '12px',
          height: '12px',
          background: 'var(--dsw-alias-bg-layer-2)',
          borderRight: '1px solid var(--dsw-alias-border-l2)',
          borderBottom: '1px solid var(--dsw-alias-border-l2)',
          transform: 'rotate(45deg)',
        }
      : undefined
  return (
    <div style={cardStyle}>
      {arrowStyle && <div style={arrowStyle} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
        <span style={{ fontSize: '14px' }}>💡</span>
        <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--dsw-alias-interactive-bg, #6366f1)' }}>AI 建议记住</span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: '10px',
            color: 'var(--dsw-alias-label-tertiary)',
            border: '1px solid var(--dsw-alias-border-l2)',
            padding: '0 5px',
            borderRadius: '999px',
            lineHeight: '16px',
          }}
        >
          {suggestion.workspace === '*' ? '全局' : suggestion.workspace.split('/').pop() || '项目'}
        </span>
      </div>
      <div
        style={{
          fontSize: '13px',
          lineHeight: 1.5,
          color: 'var(--dsw-alias-label-primary)',
          maxHeight: '72px',
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          wordBreak: 'break-word',
          marginBottom: '10px',
        }}
      >
        {suggestion.content}
      </div>
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onDismiss}
          style={{
            padding: '6px 12px',
            borderRadius: '999px',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'transparent',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: '12px',
            cursor: 'pointer',
          }}
        >
          忽略
        </button>
        <button
          type="button"
          onClick={onConfirm}
          style={{
            padding: '6px 14px',
            borderRadius: '999px',
            border: 'none',
            background: 'var(--dsw-alias-interactive-bg, #6366f1)',
            color: '#fff',
            fontSize: '12px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          确认记住
        </button>
      </div>
      <style>{`@keyframes dshm-suggest-pop{from{transform:translateY(8px) scale(.98);opacity:0}to{transform:none;opacity:1}}`}</style>
    </div>
  )
}
