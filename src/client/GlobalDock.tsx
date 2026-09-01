import { useCallback, useEffect, useRef, useState } from 'react'
import { elephantImage } from './elephantImage.ts'

type RecallHit = { id: string; kind: string; content: string; tags: readonly string[]; strength: number }
type LastRecall = { at: number; query: string; hits: RecallHit[] }
type RecallHistoryEntry = { at: number; query: string; hits: RecallHit[] }
type MemoryRecord = { id: string; content: string; kind: string; tags: readonly string[]; strength: number; updatedAt: number; workspace: string }

const STORAGE_KEY = 'dshm-dock-pos'
const DOT_SIZE = 44

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

function formatTime(ts: number): string {
  const d = Date.now() - ts
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}小时前`
  return `${Math.floor(d / 86_400_000)}天前`
}

function useDockDrag(pos: { x: number; y: number } | null, setPos: (p: { x: number; y: number } | null) => void, onTap: () => void): {
  posStyle: React.CSSProperties
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void
    onPointerMove: (e: React.PointerEvent) => void
    onPointerUp: (e: React.PointerEvent) => void
    onDoubleClick: () => void
  }
} {
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null)
  const posStyle: React.CSSProperties = pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : { right: '20px', bottom: '20px' }
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top, moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY
    if (Math.hypot(dx, dy) > 3) dragRef.current.moved = true
    const nx = Math.min(window.innerWidth - DOT_SIZE - 4, Math.max(4, dragRef.current.origX + dx))
    const ny = Math.min(window.innerHeight - DOT_SIZE - 4, Math.max(4, dragRef.current.origY + dy))
    setPos({ x: nx, y: ny })
  }, [setPos])
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const info = dragRef.current
    dragRef.current = null
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch {}
    if (info?.moved) {
      const dx = e.clientX - info.startX
      const dy = e.clientY - info.startY
      const nx = Math.min(window.innerWidth - DOT_SIZE - 4, Math.max(4, info.origX + dx))
      const ny = Math.min(window.innerHeight - DOT_SIZE - 4, Math.max(4, info.origY + dy))
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: nx, y: ny })) } catch {}
      setPos({ x: nx, y: ny })
      return
    }
    onTap()
  }, [onTap, setPos])
  const onDoubleClick = useCallback(() => {
    setPos(null)
    try { localStorage.removeItem(STORAGE_KEY) } catch {}
  }, [setPos])
  return { posStyle, handlers: { onPointerDown, onPointerMove, onPointerUp, onDoubleClick } }
}

export function GlobalDock() {
  const [hits, setHits] = useState<RecallHit[]>([])
  const [showBig, setShowBig] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [dotPos, setDotPos] = useState<{ x: number; y: number } | null>(null)
  const [showManage, setShowManage] = useState(false)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<MemoryRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [manageQuery, setManageQuery] = useState('')
  const [activeTab, setActiveTab] = useState<'memory' | 'recall'>('memory')
  const [history, setHistory] = useState<RecallHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [isDropOver, setIsDropOver] = useState(false)
  const [isPanelDropOver, setIsPanelDropOver] = useState(false)
  const [dropToast, setDropToast] = useState<string | null>(null)
  const lastAtRef = useRef(0)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dropToastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const openManage = useCallback(() => setShowManage(true), [])

  const saveDropped = useCallback(async (raw: string) => {
    const text = raw.trim()
    if (text.length < 2) return
    const clipped = text.length > 500 ? text.slice(0, 500) : text
    try {
      const res = await fetch('/api/dsh-echo-memory/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: clipped }) })
      if (!res.ok) throw new Error('save failed')
      const preview = clipped.length > 20 ? clipped.slice(0, 20).trimEnd() + '…' : clipped
      setDropToast(`已记住：${preview}`)
      if (dropToastTimer.current) clearTimeout(dropToastTimer.current)
      dropToastTimer.current = setTimeout(() => setDropToast(null), 2200)
      if (showManage && activeTab === 'memory') {
        try {
          const r = await fetch(`/api/dsh-echo-memory/list?limit=20&q=${encodeURIComponent(manageQuery.trim())}`)
          const data = (await r.json()) as { items: MemoryRecord[] }
          setItems(Array.isArray(data.items) ? data.items : [])
        } catch {}
      }
    } catch {
      setDropToast('保存失败')
      if (dropToastTimer.current) clearTimeout(dropToastTimer.current)
      dropToastTimer.current = setTimeout(() => setDropToast(null), 2200)
    }
  }, [showManage, activeTab, manageQuery])

  const dotDropHandlers = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!isDropOver) setIsDropOver(true) },
    onDragEnter: (e: React.DragEvent) => { e.preventDefault(); setIsDropOver(true) },
    onDragLeave: () => setIsDropOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setIsDropOver(false)
      const t = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text') || ''
      if (t.trim().length >= 2) void saveDropped(t)
    },
  }

  const panelDropHandlers = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!isPanelDropOver) setIsPanelDropOver(true) },
    onDragEnter: (e: React.DragEvent) => { e.preventDefault(); setIsPanelDropOver(true) },
    onDragLeave: (e: React.DragEvent) => {
      const rel = e.relatedTarget as HTMLElement | null
      if (rel && (e.currentTarget as HTMLElement).contains(rel)) return
      setIsPanelDropOver(false)
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setIsPanelDropOver(false)
      const t = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text') || ''
      if (t.trim().length >= 2) void saveDropped(t)
    },
  }

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const p = JSON.parse(raw) as { x: number; y: number }
        if (typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          const nx = Math.min(window.innerWidth - DOT_SIZE - 4, Math.max(4, p.x))
          const ny = Math.min(window.innerHeight - DOT_SIZE - 4, Math.max(4, p.y))
          setDotPos({ x: nx, y: ny })
        }
      }
    } catch {}
  }, [])

  // 召回轮询
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
        if (showManage) return
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
  }, [showManage])

  // 管理面板数据 - 记忆列表
  useEffect(() => {
    if (!showManage || activeTab !== 'memory') return
    let cancelled = false
    const fetchList = async () => {
      setLoading(true)
      try {
        const url = `/api/dsh-echo-memory/list?limit=20&q=${encodeURIComponent(manageQuery.trim())}`
        const res = await fetch(url, { headers: { Accept: 'application/json' } })
        if (!res.ok) return
        const data = (await res.json()) as { items: MemoryRecord[] }
        if (cancelled) return
        setItems(Array.isArray(data.items) ? data.items : [])
      } catch {} finally {
        if (!cancelled) setLoading(false)
      }
    }
    void fetchList()
    const t = setTimeout(fetchList, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [showManage, manageQuery, activeTab])

  // 管理面板数据 - 召回历史
  useEffect(() => {
    if (!showManage || activeTab !== 'recall') return
    let cancelled = false
    const fetchHistory = async () => {
      setHistoryLoading(true)
      try {
        const res = await fetch('/api/dsh-echo-memory/recall-history', { headers: { Accept: 'application/json' } })
        if (!res.ok) return
        const data = (await res.json()) as { items: RecallHistoryEntry[] }
        if (cancelled) return
        setHistory(Array.isArray(data.items) ? data.items : [])
      } catch {} finally {
        if (!cancelled) setHistoryLoading(false)
      }
    }
    void fetchHistory()
    return () => { cancelled = true }
  }, [showManage, activeTab])

  // 清理 toast 定时器
  useEffect(() => () => { if (dropToastTimer.current) clearTimeout(dropToastTimer.current) }, [])

  const first = hits[0]
  const more = hits.length > 1 ? hits.length - 1 : 0
  const dotDrag = useDockDrag(dotPos, setDotPos, openManage)

  // 管理面板优先
  if (showManage) {
    return (
      <>
        <div
          {...panelDropHandlers}
          style={{
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            width: 'min(380px, calc(100vw - 32px))',
            maxHeight: 'min(480px, calc(100vh - 80px))',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: '12px',
            background: 'var(--dsw-alias-bg-layer-2)',
            border: isPanelDropOver ? '1px solid var(--dsw-alias-brand-primary)' : '1px solid var(--dsw-alias-border-l2)',
            boxShadow: isPanelDropOver ? '0 16px 40px rgba(0,0,0,0.16), 0 0 0 2px rgba(99,102,241,0.15)' : '0 16px 40px rgba(0,0,0,0.16), 0 4px 12px rgba(0,0,0,0.08)',
            zIndex: 9999,
            overflow: 'hidden',
            transition: 'border-color .15s, box-shadow .15s',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid var(--dsw-alias-border-l2)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <img src={elephantImage} alt="" draggable={false} onDragStart={(e) => e.preventDefault()} style={{ width: '20px', height: '20px', borderRadius: '50%', objectFit: 'cover', display: 'block', border: '1px solid white', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', pointerEvents: 'none', userSelect: 'none' }} />
              <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--dsw-alias-label-primary)' }}>记忆</span>
              {activeTab === 'memory' && <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', background: 'var(--dsw-alias-bg-layer-3)', padding: '1px 6px', borderRadius: '999px' }}>{items.length}</span>}
              {activeTab === 'recall' && <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', background: 'var(--dsw-alias-bg-layer-3)', padding: '1px 6px', borderRadius: '999px' }}>{history.length}</span>}
            </div>
            <button
              type="button"
              onClick={() => setShowManage(false)}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)', fontSize: '16px', padding: '2px 6px' }}
            >
              ×
            </button>
          </div>

          <div style={{ display: 'flex', gap: '4px', padding: '8px 14px 0', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setActiveTab('memory')}
              style={{
                flex: 1,
                padding: '6px 8px',
                borderRadius: '8px',
                border: activeTab === 'memory' ? '1px solid var(--dsw-alias-border-l2)' : '1px solid transparent',
                background: activeTab === 'memory' ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
                color: activeTab === 'memory' ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
                fontSize: '12px',
                fontWeight: activeTab === 'memory' ? 600 : 400,
                cursor: 'pointer',
              }}
            >
              记忆
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('recall')}
              style={{
                flex: 1,
                padding: '6px 8px',
                borderRadius: '8px',
                border: activeTab === 'recall' ? '1px solid var(--dsw-alias-border-l2)' : '1px solid transparent',
                background: activeTab === 'recall' ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
                color: activeTab === 'recall' ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
                fontSize: '12px',
                fontWeight: activeTab === 'recall' ? 600 : 400,
                cursor: 'pointer',
              }}
            >
              召回历史
            </button>
          </div>

          {isPanelDropOver && (
            <div style={{ margin: '8px 14px 0', padding: '8px 10px', borderRadius: '8px', border: '1px dashed var(--dsw-alias-brand-primary)', background: 'rgba(99,102,241,0.06)', fontSize: '12px', color: 'var(--dsw-alias-brand-primary)', textAlign: 'center', flexShrink: 0 }}>
              松手即可记住
            </div>
          )}

          {activeTab === 'memory' ? (
            <>
              <div style={{ padding: '10px 14px', flexShrink: 0 }}>
                <input
                  value={manageQuery}
                  onChange={(e) => setManageQuery(e.target.value)}
                  placeholder="搜索记忆…"
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '8px 10px',
                    borderRadius: '8px',
                    border: '1px solid var(--dsw-alias-border-l2)',
                    background: 'var(--dsw-alias-bg-layer-3)',
                    color: 'var(--dsw-alias-label-primary)',
                    fontSize: '12px',
                    outline: 'none',
                  }}
                />
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px', minHeight: 0 }}>
                {loading && items.length === 0 ? (
                  <div style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>加载中…</div>
                ) : items.length === 0 ? (
                  <div style={{ padding: '24px', textAlign: 'center' }}>
                    <div style={{ fontSize: '20px', marginBottom: '6px' }}>📭</div>
                    <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>{manageQuery ? '无匹配' : '还没有记忆'}</div>
                    <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '6px' }}>选中文字拖到原点或本面板也能直接记住</div>
                  </div>
                ) : (
                  items.map((r) => {
                    const isEditing = editingId === r.id
                    return (
                      <div
                        key={r.id}
                        style={{
                          padding: '10px 8px',
                          borderRadius: '8px',
                          background: isEditing ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
                          marginBottom: '2px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', border: '1px solid var(--dsw-alias-border-l2)', padding: '0 5px', borderRadius: '999px', lineHeight: '16px' }}>{r.kind}</span>
                          <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }}>{formatTime(r.updatedAt)}</span>
                          {r.tags.length > 0 && <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }}>#{r.tags[0]}</span>}
                          {r.strength > 1 && <span style={{ fontSize: '10px', color: 'var(--dsw-alias-label-tertiary)' }}>×{r.strength}</span>}
                        </div>
                        {isEditing ? (
                          <div style={{ marginTop: '6px' }}>
                            <textarea
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
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
                                onClick={() => setEditingId(null)}
                                style={{ padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', fontSize: '12px', cursor: 'pointer' }}
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  const c = draft.trim()
                                  if (!c) return
                                  await fetch('/api/dsh-echo-memory/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: r.id, content: c }) })
                                  setEditingId(null)
                                  const url = `/api/dsh-echo-memory/list?limit=20&q=${encodeURIComponent(manageQuery.trim())}`
                                  const res = await fetch(url)
                                  const data = (await res.json()) as { items: MemoryRecord[] }
                                  setItems(Array.isArray(data.items) ? data.items : [])
                                }}
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
                                onClick={() => {
                                  setEditingId(r.id)
                                  setDraft(r.content)
                                }}
                                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', padding: '2px 4px' }}
                              >
                                ✎ 编辑
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  if (!confirm('删除这条记忆？')) return
                                  await fetch('/api/dsh-echo-memory/forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: r.id }) })
                                  setItems((prev) => prev.filter((x) => x.id !== r.id))
                                }}
                                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', padding: '2px 4px' }}
                              >
                                🗑 删除
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  try { await navigator.clipboard.writeText(r.content) } catch {}
                                }}
                                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', padding: '2px 4px' }}
                              >
                                ⎘ 复制
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )
                  })
                )}
              </div>

              <div style={{ padding: '8px 14px', borderTop: '1px solid var(--dsw-alias-border-l2)', display: 'flex', gap: '8px', flexShrink: 0 }}>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key !== 'Enter') return
                    const c = query.trim()
                    if (!c) return
                    await fetch('/api/dsh-echo-memory/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: c }) })
                    setQuery('')
                    const res = await fetch(`/api/dsh-echo-memory/list?limit=20&q=${encodeURIComponent(manageQuery.trim())}`)
                    const data = (await res.json()) as { items: MemoryRecord[] }
                    setItems(Array.isArray(data.items) ? data.items : [])
                  }}
                  placeholder="记住：回车保存…"
                  style={{
                    flex: 1,
                    padding: '8px 10px',
                    borderRadius: '8px',
                    border: '1px solid var(--dsw-alias-border-l2)',
                    background: 'var(--dsw-alias-bg-layer-3)',
                    color: 'var(--dsw-alias-label-primary)',
                    fontSize: '12px',
                    outline: 'none',
                  }}
                />
                <button
                  type="button"
                  onClick={async () => {
                    const c = query.trim()
                    if (!c) return
                    await fetch('/api/dsh-echo-memory/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: c }) })
                    setQuery('')
                    const res = await fetch(`/api/dsh-echo-memory/list?limit=20&q=${encodeURIComponent(manageQuery.trim())}`)
                    const data = (await res.json()) as { items: MemoryRecord[] }
                    setItems(Array.isArray(data.items) ? data.items : [])
                  }}
                  style={{ padding: '8px 14px', borderRadius: '8px', border: 'none', background: 'var(--dsw-alias-interactive-bg)', color: 'white', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                >
                  保存
                </button>
              </div>
            </>
          ) : (
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px 8px', minHeight: 0 }}>
              {historyLoading && history.length === 0 ? (
                <div style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>加载中…</div>
              ) : history.length === 0 ? (
                <div style={{ padding: '24px', textAlign: 'center' }}>
                  <div style={{ fontSize: '20px', marginBottom: '6px' }}>💭</div>
                  <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>还没有召回</div>
                  <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '4px' }}>和 agent 聊天时，相关记忆会自动出现在这里</div>
                </div>
              ) : (
                history.map((entry) => (
                  <div key={entry.at} style={{ padding: '10px 8px', borderRadius: '8px', marginBottom: '8px', background: 'var(--dsw-alias-bg-layer-3)' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap', marginBottom: '4px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.query.slice(0, 60)}</span>
                      <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' }}>{formatTime(entry.at)}</span>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginBottom: '6px' }}>命中 {entry.hits.length} 条</div>
                    {entry.hits.map((h) => {
                      const { title, body } = splitTitle(h.content)
                      const short = body ? (body.length > 60 ? body.slice(0, 60).trimEnd() + '…' : body) : h.content.slice(0, 60)
                      return (
                        <div key={h.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', padding: '6px 8px', borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-2)', marginBottom: '4px' }}>
                          <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', border: '1px solid var(--dsw-alias-border-l2)', padding: '0 5px', borderRadius: '999px', lineHeight: '16px', flexShrink: 0 }}>{h.kind}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            {title && <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', lineHeight: 1.4 }}>{title}</div>}
                            <div style={{ fontSize: '12px', lineHeight: 1.4, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-word' }}>{short}</div>
                            {h.tags.length > 0 && <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '2px' }}>#{h.tags[0]}{h.strength > 1 ? ` ×${h.strength}` : ''}</div>}
                          </div>
                          <button
                            type="button"
                            onClick={async () => { try { await navigator.clipboard.writeText(h.content) } catch {} }}
                            style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', padding: '2px 4px', flexShrink: 0 }}
                            title="复制"
                          >
                            ⎘
                          </button>
                        </div>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        {dropToast && (
          <div style={{ position: 'fixed', bottom: '510px', right: '20px', padding: '8px 12px', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', fontSize: '12px', color: 'var(--dsw-alias-label-primary)', zIndex: 10000, maxWidth: 'min(320px, calc(100vw - 32px))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {dropToast}
          </div>
        )}
      </>
    )
  }

  const dotBaseStyle: React.CSSProperties = {
    position: 'fixed',
    width: '44px',
    height: '44px',
    borderRadius: '999px',
    border: isDropOver ? '2px solid var(--dsw-alias-brand-primary)' : '2px solid white',
    background: 'var(--dsw-alias-bg-layer-2)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'grab',
    boxShadow: isDropOver ? '0 4px 16px rgba(99,102,241,0.25), 0 0 0 3px rgba(99,102,241,0.15)' : '0 4px 12px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.06)',
    fontSize: '16px',
    zIndex: 9999,
    touchAction: 'none',
    userSelect: 'none',
    overflow: 'hidden',
    padding: 0,
    transform: isDropOver ? 'scale(1.08)' : 'scale(1)',
    transition: 'transform .15s, border-color .15s, box-shadow .15s',
  }

  const dotImg = <img src={elephantImage} alt="" draggable={false} onDragStart={(e) => e.preventDefault()} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%', display: 'block', pointerEvents: 'none', userSelect: 'none' }} />

  const dotButton = (title: string) => (
    <button
      type="button"
      {...dotDrag.handlers}
      {...dotDropHandlers}
      style={{ ...dotBaseStyle, ...dotDrag.posStyle }}
      title={title}
    >
      {dotImg}
    </button>
  )

  if (!first) {
    return (
      <>
        {dotButton('记忆管理 · 点击打开 / 拖动移动 / 双击复位 · 拖文字到此可直接记住')}
        {dropToast && <div style={{ position: 'fixed', bottom: '76px', right: '20px', padding: '8px 12px', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', fontSize: '12px', color: 'var(--dsw-alias-label-primary)', zIndex: 10000 }}>{dropToast}</div>}
        {isDropOver && <div style={{ position: 'fixed', bottom: '76px', right: '20px', padding: '6px 10px', borderRadius: '999px', background: 'var(--dsw-alias-brand-primary)', color: 'white', fontSize: '11px', zIndex: 10000, pointerEvents: 'none' }}>松手记住</div>}
      </>
    )
  }

  if (collapsed && !showBig) {
    return (
      <>
        {dotButton('已召回 · 点击打开记忆管理 / 拖动移动 / 双击复位 · 拖文字到此可直接记住')}
        {dropToast && <div style={{ position: 'fixed', bottom: '76px', right: '20px', padding: '8px 12px', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', fontSize: '12px', color: 'var(--dsw-alias-label-primary)', zIndex: 10000 }}>{dropToast}</div>}
        {isDropOver && <div style={{ position: 'fixed', bottom: '76px', right: '20px', padding: '6px 10px', borderRadius: '999px', background: 'var(--dsw-alias-brand-primary)', color: 'white', fontSize: '11px', zIndex: 10000, pointerEvents: 'none' }}>松手记住</div>}
      </>
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
      <div style={{ paddingTop: '1px' }}><img src={elephantImage} alt="" draggable={false} onDragStart={(e) => e.preventDefault()} style={{ width: '20px', height: '20px', borderRadius: '50%', objectFit: 'cover', display: 'block', border: '1px solid white', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', pointerEvents: 'none', userSelect: 'none' }} /></div>
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
