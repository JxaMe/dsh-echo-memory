import { useEffect, useRef, useState } from 'react'

type RecallHit = { id: string; kind: string; content: string; tags: readonly string[]; strength: number }
type LastRecall = { at: number; query: string; hits: RecallHit[] }

const STORAGE_KEY = 'dshm-dock-pos'
const DOT_SIZE = 36

function splitTitle(content: string): { title: string; body: string } {
  const raw = content.trim()
  const colon = raw.search(/[:：]/)
  if (colon > 0 && colon < 24) {
    return { title: raw.slice(0, colon).trim(), body: raw.slice(colon + 1).replace(/^[:：\s]+/, '').trim() }
  }
  const comma = raw.search(/[，,]/)
  if (comma > 0 && comma < 24) {
    return { title: raw.slice(0, comma).trim(), body: raw.slice(comma + 1).trim() }
  }
  if (raw.length <= 20) return { title: raw, body: '' }
  return { title: '', body: raw }
}

export function GlobalDock() {
  const [hits, setHits] = useState<RecallHit[]>([])
  const [showBig, setShowBig] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [dotPos, setDotPos] = useState<{ x: number; y: number } | null>(null)
  const lastAtRef = useRef(0)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null)

  // 恢复上次拖动位置
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const p = JSON.parse(raw) as { x: number; y: number }
        if (typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          // 夹到视口内
          const nx = Math.min(window.innerWidth - DOT_SIZE - 4, Math.max(4, p.x))
          const ny = Math.min(window.innerHeight - DOT_SIZE - 4, Math.max(4, p.y))
          setDotPos({ x: nx, y: ny })
        }
      }
    } catch {}
  }, [])

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch('/api/dsh-echo-memory/last-recall', { headers: { Accept: 'application/json' } })
        if (!res.ok) return
        const data = (await res.json()) as LastRecall
        if (cancelled) return
        if (!data || typeof data.at !== 'number' || !Array.isArray(data.hits) || data.hits.length === 0) return
        if (data.at <= lastAtRef.current) return
        lastAtRef.current = data.at
        setHits(data.hits)
        setCollapsed(false)
        setShowBig(true)
        if (hideTimer.current) clearTimeout(hideTimer.current)
        hideTimer.current = setTimeout(() => {
          setShowBig(false)
          setCollapsed(true)
        }, 6000)
      } catch {}
    }
    void poll()
    const id = setInterval(poll, 2500)
    return () => {
      cancelled = true
      clearInterval(id)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  const first = hits[0]
  const more = hits.length > 1 ? hits.length - 1 : 0

  if (!first) return null

  if (collapsed && !showBig) {
    const posStyle: React.CSSProperties = dotPos
      ? { left: dotPos.x, top: dotPos.y, right: 'auto', bottom: 'auto' }
      : { right: '20px', bottom: '20px' }
    return (
      <button
        type="button"
        onPointerDown={(e) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
          dragRef.current = { startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top, moved: false }
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!dragRef.current) return
          const dx = e.clientX - dragRef.current.startX
          const dy = e.clientY - dragRef.current.startY
          if (Math.hypot(dx, dy) > 3) dragRef.current.moved = true
          const nx = Math.min(window.innerWidth - DOT_SIZE - 4, Math.max(4, dragRef.current.origX + dx))
          const ny = Math.min(window.innerHeight - DOT_SIZE - 4, Math.max(4, dragRef.current.origY + dy))
          setDotPos({ x: nx, y: ny })
        }}
        onPointerUp={(e) => {
          const info = dragRef.current
          dragRef.current = null
          try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch {}
          if (info?.moved) {
            // 拖动结束，落盘
            const cur = dotPos
            // pos 刚 set 还是旧值，取最新计算值
            const dx = e.clientX - info.startX
            const dy = e.clientY - info.startY
            const nx = Math.min(window.innerWidth - DOT_SIZE - 4, Math.max(4, info.origX + dx))
            const ny = Math.min(window.innerHeight - DOT_SIZE - 4, Math.max(4, info.origY + dy))
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: nx, y: ny })) } catch {}
            // 同步一次
            setDotPos({ x: nx, y: ny })
            return
          }
          // 未拖动 = 点击展开
          setCollapsed(false)
          setShowBig(true)
          if (hideTimer.current) clearTimeout(hideTimer.current)
          hideTimer.current = setTimeout(() => {
            setShowBig(false)
            setCollapsed(true)
          }, 6000)
        }}
        onDoubleClick={() => {
          // 双击回默认位置
          setDotPos(null)
          try { localStorage.removeItem(STORAGE_KEY) } catch {}
        }}
        style={{
          position: 'fixed',
          width: '36px',
          height: '36px',
          borderRadius: '999px',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'grab',
          boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          fontSize: '16px',
          zIndex: 9999,
          touchAction: 'none',
          userSelect: 'none',
          ...posStyle,
        }}
        title="已召回 · 点击查看 / 拖动移动 / 双击复位"
      >
        🧠
      </button>
    )
  }

  if (!showBig) return null

  const { title, body } = splitTitle(first.content)
  const bodyShort = body.length > 72 ? body.slice(0, 72).trimEnd() + '…' : body
  const titleText = title || (bodyShort ? '' : first.content.slice(0, 24))
  const contentText = title ? bodyShort : first.content.slice(0, 72)

  return (
    <div
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
        zIndex: 9999,
      }}
    >
      <div style={{ fontSize: '16px', lineHeight: 1, paddingTop: '1px' }}>🧠</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
          {titleText && (
            <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--dsw-alias-label-primary)', lineHeight: 1.4 }}>
              {titleText}
            </span>
          )}
          <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' }}>[{first.kind}]</span>
          {first.tags.length > 0 && (
            <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' }}>
              #{first.tags[0]}
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
        onClick={() => {
          setShowBig(false)
          setCollapsed(true)
          if (hideTimer.current) clearTimeout(hideTimer.current)
        }}
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
