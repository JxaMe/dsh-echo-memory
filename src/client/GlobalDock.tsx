import { useEffect, useRef, useState } from 'react'

type RecallHit = { id: string; kind: string; content: string; tags: readonly string[]; strength: number }
type LastRecall = { at: number; query: string; hits: RecallHit[] }

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
  // 无标题则取前 12 字作标题
  if (raw.length <= 20) return { title: raw, body: '' }
  return { title: '', body: raw }
}

export function GlobalDock() {
  const [hits, setHits] = useState<RecallHit[]>([])
  const [showBig, setShowBig] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const lastAtRef = useRef(0)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

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
    // 立即拉一次，随后每 2.5s 轮询
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

  // 完全未触发过召回时，不占位（也不显示小圆点），保持“不常驻”
  if (!first) return null

  if (collapsed && !showBig) {
    return (
      <button
        type="button"
        onClick={() => {
          setCollapsed(false)
          setShowBig(true)
          if (hideTimer.current) clearTimeout(hideTimer.current)
          hideTimer.current = setTimeout(() => {
            setShowBig(false)
            setCollapsed(true)
          }, 6000)
        }}
        style={{
          position: 'fixed',
          bottom: '20px',
          right: '20px',
          width: '36px',
          height: '36px',
          borderRadius: '999px',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          fontSize: '16px',
          zIndex: 9999,
        }}
        title={`已召回 ${hits.length} 条，点击查看`}
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
