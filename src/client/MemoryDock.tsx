/**
 * 瞬态 Dock 预览：输入框上方悬浮，命中才冒泡，无命中自动收起。
 * 当前为纯展示（静态预览 + 手动触发），后续接 Host 的 last-recall 推送即为动态。
 * @module dsh-echo-memory/client/dock
 */

import { useEffect, useState } from 'react'

interface DockItem {
  readonly title: string
  readonly body: string
  readonly kind: string
  readonly tags: readonly string[]
}

const PREVIEW_ITEMS: readonly DockItem[] = [
  { title: '本机系统信息', body: 'Ubuntu 26.04 · Ryzen 5 5600H · 14Gi · 免密 sudo', kind: 'fact', tags: ['system'] },
  { title: '部署走 systemd', body: 'dsh-web 由 systemd 管理，systemctl restart dsh-web', kind: 'fact', tags: ['deploy', 'systemd'] },
]

export function MemoryDockPreview() {
  const [visible, setVisible] = useState(true)
  const [items] = useState<readonly DockItem[]>(PREVIEW_ITEMS.slice(0, 1))
  // 3s 后自动收起，模拟瞬态
  useEffect(() => {
    if (!visible) return
    const t = setTimeout(() => setVisible(false), 4000)
    return () => clearTimeout(t)
  }, [visible])
  if (!visible) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
        <button type="button" className="dshm-btn" onClick={() => setVisible(true)}>预览 Dock</button>
      </div>
    )
  }
  return (
    <div className="dshm-dockWrap">
      <div className="dshm-dock">
        {items.map(item => (
          <div key={item.title} className="dshm-dockCard">
            <div className="dshm-dockTitle">{item.title} <span className="dshm-dockKind">[{item.kind}]</span></div>
            <div className="dshm-dockBody">{item.body}</div>
            {item.tags.length > 0 ? <div className="dshm-dockTags">{item.tags.map(t => `#${t}`).join(' ')}</div> : null}
          </div>
        ))}
      </div>
      <div className="dshm-dockHint">命中才显示 · 3 秒后自动收起 · 悬浮不占位</div>
    </div>
  )
}

export function ensureDockStyles(): void {
  if (document.getElementById('dshm-dock-styles') !== null) return
  const tag = document.createElement('style')
  tag.id = 'dshm-dock-styles'
  tag.textContent = `
.dshm-dockWrap { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 12px 0 4px; }
.dshm-dock { display: flex; gap: 10px; padding: 10px 14px; border-radius: 16px; background: rgba(255,255,255,0.82); backdrop-filter: blur(12px); border: 1px solid var(--dsw-alias-border-l2); box-shadow: 0 8px 24px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.06); max-width: 560px; }
.dshm-dockCard { min-width: 180px; max-width: 240px; padding: 8px 10px; border-radius: 10px; background: var(--dsw-alias-bg-layer-3); border: 1px solid var(--dsw-alias-border-l2); }
.dshm-dockTitle { font-size: 12px; font-weight: 700; color: var(--dsw-alias-label-primary); line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshm-dockKind { font-weight: 400; color: var(--dsw-alias-label-tertiary); margin-left: 6px; }
.dshm-dockBody { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dshm-dockTags { font-size: 10px; color: var(--dsw-alias-label-tertiary); margin-top: 4px; }
.dshm-dockHint { font-size: 10px; color: var(--dsw-alias-label-tertiary); }
`
  document.head.appendChild(tag)
}
