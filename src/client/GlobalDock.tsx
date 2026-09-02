/**
 * 全站悬浮 Dock：原点（可拖动/双击复位/拖文字保存）+ 召回气泡 + 管理面板的协调层。
 * 只保留原点与全局状态：dot 位置、召回轮询、toast、存储恢复提示、拖放保存；
 * 管理面板（dock-panel）与召回气泡（recall-bubble）拆为独立深模块。
 * @module dsh-echo-memory/client/global-dock
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { elephantImage } from './elephantImage.ts'
import { loadDragPos, useDragAnchor as useDockDrag } from './drag-anchor.ts'
import { saveMemory } from './memory-repo.ts'
import { useRecallFeed, type RecallHit } from './recall-feed.ts'
import { type StorageRecovered, type Toast } from './dock-util.ts'
import { DockManagePanel, DockToast } from './dock-panel.tsx'
import { RecallBubble } from './recall-bubble.tsx'

const STORAGE_KEY = 'dshm-dock-pos'
const DOT_SIZE = 44

export function GlobalDock() {
  const [dotPos, setDotPos] = useState<{ x: number; y: number } | null>(null)
  const [showManage, setShowManage] = useState(false)
  const [isDropOver, setIsDropOver] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [saveWorkspace, setSaveWorkspace] = useState<string>('*')
  const [storageRecovered, setStorageRecovered] = useState<StorageRecovered | null>(null)
  const [dismissedRecovery, setDismissedRecovery] = useState(false)
  /** 外部保存成功后自增，驱动管理面板记忆列表重拉（拖放保存走这里）。 */
  const [listRefresh, setListRefresh] = useState(0)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const showToast = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    setToast({ text, kind })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2200)
  }, [])

  const openManage = useCallback(() => setShowManage(true), [])

  /** 拖放/快记的统一落库：保存成功即触发列表刷新信号（失败给反馈）。 */
  const saveDropped = useCallback(async (raw: string) => {
    const text = raw.trim()
    if (text.length < 2) return
    const wasClipped = text.length > 500
    const clipped = wasClipped ? text.slice(0, 500) : text
    let ok = false
    try { ok = await saveMemory(clipped, saveWorkspace) } catch { ok = false }
    const preview = clipped.length > 20 ? clipped.slice(0, 20).trimEnd() + '…' : clipped
    showToast(ok ? `已记住：${preview}${wasClipped ? '（已截断500）' : ''}` : '保存失败', ok ? 'ok' : 'error')
    if (ok) setListRefresh((x) => x + 1)
  }, [saveWorkspace, showToast])

  const dotDropHandlers = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!isDropOver) setIsDropOver(true) },
    onDragEnter: (e: React.DragEvent) => { e.preventDefault(); setIsDropOver(true) },
    onDragLeave: (e: React.DragEvent) => {
      const rel = e.relatedTarget as HTMLElement | null
      if (rel && (e.currentTarget as HTMLElement).contains(rel)) return
      setIsDropOver(false)
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setIsDropOver(false)
      const t = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text') || ''
      if (t.trim().length >= 2) void saveDropped(t)
    },
  }

  useEffect(() => {
    const pos = loadDragPos()
    if (pos) setDotPos(pos)
  }, [])

  // 窗口 resize 后点位越界校正
  useEffect(() => {
    const onResize = () => {
      setDotPos((prev) => {
        if (!prev) return prev
        const nx = Math.min(window.innerWidth - DOT_SIZE - 4, Math.max(4, prev.x))
        const ny = Math.min(window.innerHeight - DOT_SIZE - 4, Math.max(4, prev.y))
        if (nx !== prev.x || ny !== prev.y) {
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: nx, y: ny })) } catch {}
          return { x: nx, y: ny }
        }
        return prev
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 召回轮询与气泡显隐状态机（独立 hook）
  const { hits, showBig, collapsed, setShowBig, setCollapsed, pauseHide, resumeHide } = useRecallFeed(showManage)

  // 清理 toast 定时器
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

  // 存储恢复提示：打开面板时查一次 host 的恢复事件，未关闭过就显示一次性 banner
  useEffect(() => {
    if (!showManage || dismissedRecovery) return
    let cancelled = false
    fetch('/api/dsh-echo-memory/storage-status', { headers: { Accept: 'application/json' } })
      .then(res => (res.ok ? res.json() : null))
      .then((data: { recovered: StorageRecovered | null } | null) => {
        if (cancelled || data?.recovered == null) return
        setStorageRecovered(data.recovered)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [showManage, dismissedRecovery])

  const first = hits[0]
  const more = hits.length > 1 ? hits.length - 1 : 0
  const dotDrag = useDockDrag(dotPos, setDotPos, openManage)

  // 管理面板优先
  if (showManage) {
    return (
      <DockManagePanel
        onClose={() => setShowManage(false)}
        storageRecovered={storageRecovered}
        dismissedRecovery={dismissedRecovery}
        onDismissRecovery={() => setDismissedRecovery(true)}
        toast={toast}
        onToast={showToast}
        onDropText={(text) => void saveDropped(text)}
        refreshSignal={listRefresh}
        saveWorkspace={saveWorkspace}
        onSaveWorkspaceChange={setSaveWorkspace}
      />
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
    zIndex: 40,
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
        <DockToast toast={toast} bottom={76} />
        {isDropOver && <div style={{ position: 'fixed', bottom: '76px', right: '20px', padding: '6px 10px', borderRadius: '999px', background: 'var(--dsw-alias-brand-primary)', color: 'white', fontSize: '11px', zIndex: 41, pointerEvents: 'none' }}>松手记住</div>}
      </>
    )
  }

  if (collapsed && !showBig) {
    return (
      <>
        {dotButton('已召回 · 点击打开记忆管理 / 拖动移动 / 双击复位 · 拖文字到此可直接记住')}
        <DockToast toast={toast} bottom={76} />
        {isDropOver && <div style={{ position: 'fixed', bottom: '76px', right: '20px', padding: '6px 10px', borderRadius: '999px', background: 'var(--dsw-alias-brand-primary)', color: 'white', fontSize: '11px', zIndex: 41, pointerEvents: 'none' }}>松手记住</div>}
      </>
    )
  }

  if (!showBig) return null

  return (
    <RecallBubble
      hit={first}
      more={more}
      onClose={() => { setShowBig(false); setCollapsed(true) }}
      pauseHide={pauseHide}
      resumeHide={resumeHide}
    />
  )
}
