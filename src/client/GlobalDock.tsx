import { useState } from 'react'

export function GlobalDock() {
  const [visible, setVisible] = useState(true)
  if (!visible) {
    return (
      <button
        type="button"
        onClick={() => setVisible(true)}
        style={{
          position: 'fixed', bottom: '20px', right: '20px',
          width: '36px', height: '36px', borderRadius: '999px',
          border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', boxShadow: '0 4px 12px rgba(0,0,0,0.08)', fontSize: '16px',
        }}
        title="显示记忆 Dock"
      >
        🧠
      </button>
    )
  }
  return (
    <div
      style={{
        position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '10px 14px', borderRadius: '16px',
        background: 'rgba(255,255,255,0.88)', backdropFilter: 'blur(16px)',
        border: '1px solid var(--dsw-alias-border-l2)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)',
        maxWidth: 'min(640px, 90vw)', zIndex: 9999,
      }}
    >
      <div style={{ fontSize: '14px' }}>🧠</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--dsw-alias-label-primary)' }}>
          本机系统信息 <span style={{ fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)', marginLeft: '6px' }}>[fact]</span>
        </div>
        <div style={{ fontSize: '11px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '320px' }}>
          Ubuntu 26.04 · Ryzen 5 5600H · 14Gi · 免密 sudo
        </div>
      </div>
      <div style={{ fontSize: '10px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' }}>#system</div>
      <button
        type="button"
        onClick={() => setVisible(false)}
        style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)', fontSize: '14px', padding: '2px 6px' }}
        aria-label="关闭"
      >
        ×
      </button>
    </div>
  )
}
