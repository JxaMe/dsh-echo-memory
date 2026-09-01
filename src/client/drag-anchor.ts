import { useCallback, useRef } from 'react'

const STORAGE_KEY = 'dshm-dock-pos'
const DOT_SIZE = 44

export function useDragAnchor(
  pos: { x: number; y: number } | null,
  setPos: (p: { x: number; y: number } | null) => void,
  onTap: () => void,
): {
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

export function loadDragPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as { x: number; y: number }
    if (typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      const nx = Math.min(window.innerWidth - DOT_SIZE - 4, Math.max(4, p.x))
      const ny = Math.min(window.innerHeight - DOT_SIZE - 4, Math.max(4, p.y))
      return { x: nx, y: ny }
    }
  } catch {}
  return null
}
