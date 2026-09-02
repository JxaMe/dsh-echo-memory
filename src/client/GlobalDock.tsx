import { useCallback, useEffect, useRef, useState } from 'react'
import { elephantImage } from './elephantImage.ts'
import { loadDragPos, useDragAnchor as useDockDrag } from './drag-anchor.ts'
import { fetchList as fetchMemoryList, forgetMemory, saveMemory, updateMemory } from './memory-repo.ts'
import { useRecallFeed } from './recall-feed.ts'
import { copyText, formatTime, splitTitle } from './dock-util.ts'
import { MemoryListItem } from './memory-list-item.tsx'

type RecallHit = { id: string; kind: string; content: string; tags: readonly string[]; strength: number }
type LastRecall = { at: number; query: string; hits: RecallHit[] }
type RecallHistoryEntry = { at: number; query: string; hits: RecallHit[] }
type MemoryRecord = { id: string; content: string; kind: string; tags: readonly string[]; strength: number; updatedAt: number; workspace: string }
type Toast = { text: string; kind: 'ok' | 'error' }

const STORAGE_KEY = 'dshm-dock-pos'
const DOT_SIZE = 44

export function GlobalDock() {
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
  const [historyError, setHistoryError] = useState(false)
  const [historyReload, setHistoryReload] = useState(0)
  const [isDropOver, setIsDropOver] = useState(false)
  const [isPanelDropOver, setIsPanelDropOver] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [listError, setListError] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const [suggestPool, setSuggestPool] = useState<MemoryRecord[]>([])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [showSuggest, setShowSuggest] = useState(false)
  const [filterScope, setFilterScope] = useState<'all' | 'global' | 'project'>('all')
  const [saveWorkspace, setSaveWorkspace] = useState<string>('*')
  const [storageRecovered, setStorageRecovered] = useState<{ at: number; backupPath: string } | null>(null)
  const [dismissedRecovery, setDismissedRecovery] = useState(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const showToast = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    setToast({ text, kind })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2200)
  }, [])

  const openManage = useCallback(() => setShowManage(true), [])

  /** 刷新记忆列表：失败静默——保存/编辑/删除后的主反馈不被覆盖，列表加载失败由主加载的错误态兜底。 */
  const refreshList = useCallback(async () => {
    try {
      setItems(await fetchMemoryList(manageQuery))
    } catch {
      // 静默
    }
  }, [manageQuery])

  // 时间文案每分钟刷新一次，否则“刚刚”不会变
  const [, forceTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => forceTick((x) => x + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  const saveDropped = useCallback(async (raw: string) => {
    const text = raw.trim()
    if (text.length < 2) return
    const wasClipped = text.length > 500
    const clipped = wasClipped ? text.slice(0, 500) : text
    let ok = false
    try { ok = await saveMemory(clipped, saveWorkspace) } catch { ok = false }
    const preview = clipped.length > 20 ? clipped.slice(0, 20).trimEnd() + '…' : clipped
    showToast(ok ? `已记住：${preview}${wasClipped ? '（已截断500）' : ''}` : '保存失败', ok ? 'ok' : 'error')
    if (ok && showManage && activeTab === 'memory') void refreshList()
  }, [showManage, activeTab, saveWorkspace, showToast, refreshList])

  /** 快记（回车 / 保存按钮）：失败保留输入框草稿并给反馈。 */
  const quickSave = useCallback(async () => {
    const c = query.trim()
    if (!c) return
    let ok = false
    try { ok = await saveMemory(c, saveWorkspace) } catch { ok = false }
    if (!ok) {
      showToast('保存失败', 'error')
      return
    }
    setQuery('')
    showToast('已记住 ✅')
    void refreshList()
  }, [query, saveWorkspace, showToast, refreshList])

  /** 编辑保存：失败保留编辑态并给反馈。 */
  const handleEditSave = useCallback(async (id: string) => {
    const c = draft.trim()
    if (!c) return
    let ok = false
    try { ok = await updateMemory(id, c) } catch { ok = false }
    if (!ok) {
      showToast('更新失败', 'error')
      return
    }
    setEditingId(null)
    showToast('已更新 ✅')
    void refreshList()
  }, [draft, showToast, refreshList])

  /** 删除：失败不移除列表项并给反馈。 */
  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('删除这条记忆？')) return
    let ok = false
    try { ok = await forgetMemory(id) } catch { ok = false }
    if (!ok) {
      showToast('删除失败', 'error')
      return
    }
    setItems((prev) => prev.filter((x) => x.id !== id))
    showToast('已删除')
  }, [showToast])

  /** 复制：失败给反馈。 */
  const handleCopy = useCallback(async (text: string) => {
    const ok = await copyText(text)
    if (!ok) showToast('复制失败', 'error')
  }, [showToast])

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

  // 召回轮询已收进 useRecallFeed
  const { hits, showBig, collapsed, setShowBig, setCollapsed, pauseHide, resumeHide } = useRecallFeed(showManage)

  // 管理面板数据 - 记忆列表（300ms 防抖，单请求）
  useEffect(() => {
    if (!showManage || activeTab !== 'memory') return
    let cancelled = false
    const t = setTimeout(async () => {
      setLoading(true)
      try {
        const items = await fetchMemoryList(manageQuery)
        if (cancelled) return
        setItems(items)
        setListError(false)
      } catch {
        if (!cancelled) setListError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [showManage, manageQuery, activeTab, reloadTick])

  // 管理面板数据 - 召回历史
  useEffect(() => {
    if (!showManage || activeTab !== 'recall') return
    let cancelled = false
    const fetchHistory = async () => {
      setHistoryLoading(true)
      try {
        const res = await fetch('/api/dsh-echo-memory/recall-history', { headers: { Accept: 'application/json' } })
        if (!res.ok) throw new Error(`recall-history failed HTTP ${res.status}`)
        const data = (await res.json()) as { items: RecallHistoryEntry[] }
        if (cancelled) return
        setHistory(Array.isArray(data.items) ? data.items : [])
        setHistoryError(false)
      } catch {
        if (!cancelled) setHistoryError(true)
      } finally {
        if (!cancelled) setHistoryLoading(false)
      }
    }
    void fetchHistory()
    return () => { cancelled = true }
  }, [showManage, activeTab, historyReload])

  // 搜索联想池：面板打开时拉一次全量用于本地联想
  useEffect(() => {
    if (!showManage || activeTab !== 'memory') return
    let cancelled = false
    const fetchPool = async () => {
      try {
        const res = await fetch('/api/dsh-echo-memory/list?limit=50', { headers: { Accept: 'application/json' } })
        if (!res.ok) return
        const data = (await res.json()) as { items: MemoryRecord[] }
        if (cancelled) return
        setSuggestPool(Array.isArray(data.items) ? data.items : [])
      } catch {}
    }
    void fetchPool()
    return () => { cancelled = true }
  }, [showManage, activeTab])

  // 根据输入生成联想（标签优先，其次标题）
  useEffect(() => {
    const q = manageQuery.trim().toLowerCase()
    if (q.length < 1) { setSuggestions([]); setShowSuggest(false); return }
    // 输入已是完整标签时不提示
    const seen = new Set<string>()
    const out: string[] = []
    const add = (s: string) => {
      const t = s.trim()
      if (t.length < 1 || t.length > 24 || seen.has(t.toLowerCase())) return
      const lower = t.toLowerCase()
      if (!lower.includes(q)) return
      // 完全等于输入的不提示
      if (lower === q) return
      seen.add(lower)
      out.push(t)
    }
    for (const r of suggestPool) {
      for (const tag of r.tags) { add(tag); if (out.length >= 8) break }
      if (out.length >= 8) break
    }
    for (const r of suggestPool) {
      const { title } = splitTitle(r.content)
      if (title) add(title)
      const head = r.content.trim().slice(0, 20).split(/[\s，,、:：]+/)[0]
      if (head && head.length >= 2) add(head)
      if (out.length >= 8) break
    }
    out.sort((a, b) => a.length - b.length)
    const sliced = out.slice(0, 6)
    setSuggestions(sliced)
    setShowSuggest(sliced.length > 0)
  }, [manageQuery, suggestPool])

  // 清理 toast 定时器
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

  // 存储恢复提示：打开面板时查一次 host 的恢复事件，未关闭过就显示一次性 banner
  useEffect(() => {
    if (!showManage || dismissedRecovery) return
    let cancelled = false
    fetch('/api/dsh-echo-memory/storage-status', { headers: { Accept: 'application/json' } })
      .then(res => (res.ok ? res.json() : null))
      .then((data: { recovered: { at: number; backupPath: string } | null } | null) => {
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
            zIndex: 40,
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

          {storageRecovered && !dismissedRecovery && (
            <div style={{ margin: '8px 14px 0', padding: '8px 10px', borderRadius: '8px', border: '1px dashed var(--dsw-alias-state-error-primary)', background: 'rgba(236,19,19,0.06)', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
              <span style={{ flex: 1 }}>⚠️ 检测到记忆文件曾损坏，已自动备份并重置（备份：{storageRecovered.backupPath.split('/').pop()}）</span>
              <button type="button" onClick={() => setDismissedRecovery(true)} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '13px', color: 'inherit', padding: '0 2px' }} aria-label="关闭">×</button>
            </div>
          )}

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
              <div style={{ display: 'flex', gap: '6px', padding: '8px 14px 0', flexShrink: 0 }}>
                {(['all', 'project', 'global'] as const).map((s) => {
                  const label = s === 'all' ? '全部' : s === 'global' ? '全局' : '本项目'
                  const active = filterScope === s
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setFilterScope(s)}
                      style={{
                        padding: '4px 10px',
                        borderRadius: '999px',
                        border: active ? '1px solid var(--dsw-alias-label-primary)' : '1px solid var(--dsw-alias-border-l2)',
                        background: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-bg-layer-3)',
                        color: active ? 'var(--dsw-alias-bg-layer-3)' : 'var(--dsw-alias-label-tertiary)',
                        fontSize: '11px',
                        cursor: 'pointer',
                      }}
                    >
                      {label}
                    </button>
                  )
                })}
                <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', alignSelf: 'center' }}>
                  {filterScope === 'all' ? `${items.length}` : filterScope === 'global' ? `${items.filter(r => r.workspace === '*').length}` : `${items.filter(r => r.workspace !== '*').length}`} 条
                </span>
              </div>
              <div style={{ padding: '10px 14px', flexShrink: 0, position: 'relative' }}>
                <input
                  value={manageQuery}
                  onChange={(e) => setManageQuery(e.target.value)}
                  onFocus={() => { if (suggestions.length > 0) setShowSuggest(true) }}
                  onBlur={() => { setTimeout(() => setShowSuggest(false), 150) }}
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
                {showSuggest && suggestions.length > 0 && (
                  <div style={{ position: 'absolute', top: '38px', left: '14px', right: '14px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 10, overflow: 'hidden' }}>
                    {suggestions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); setManageQuery(s); setShowSuggest(false) }}
                        style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '12px', color: 'var(--dsw-alias-label-primary)' }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--dsw-alias-bg-layer-3)' }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                      >
                        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>⌕</span>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s}</span>
                        <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', flexShrink: 0 }}>回车搜索</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px', minHeight: 0 }}>
                {(() => {
                  const displayItems = filterScope === 'all' ? items : items.filter(r => filterScope === 'global' ? r.workspace === '*' : r.workspace !== '*')
                  if (loading && items.length === 0) return <div style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>加载中…</div>
                  if (listError && items.length === 0) return (
                    <div style={{ padding: '24px', textAlign: 'center' }}>
                      <div style={{ fontSize: '20px', marginBottom: '6px' }}>⚠️</div>
                      <div style={{ fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' }}>加载失败</div>
                      <button
                        type="button"
                        onClick={() => { setListError(false); setReloadTick((x) => x + 1) }}
                        style={{ marginTop: '10px', padding: '4px 14px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', fontSize: '12px', cursor: 'pointer' }}
                      >
                        重试
                      </button>
                    </div>
                  )
                  if (displayItems.length === 0) return (
                    <div style={{ padding: '24px', textAlign: 'center' }}>
                      <div style={{ fontSize: '20px', marginBottom: '6px' }}>📭</div>
                      <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>{manageQuery ? '无匹配' : filterScope !== 'all' ? (filterScope === 'global' ? '暂无全局记忆' : '暂无项目记忆') : '还没有记忆'}</div>
                      <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '6px' }}>选中文字拖到原点或本面板也能直接记住</div>
                    </div>
                  )
                  return displayItems.map((r) => (
                    <MemoryListItem
                      key={r.id}
                      r={r}
                      isEditing={editingId === r.id}
                      draft={draft}
                      onDraftChange={setDraft}
                      onCancel={() => setEditingId(null)}
                      onSave={() => void handleEditSave(r.id)}
                      onStartEdit={() => { setEditingId(r.id); setDraft(r.content) }}
                      onDelete={() => void handleDelete(r.id)}
                      onCopy={() => void handleCopy(r.content)}
                    />
                  ))
                })()}
              </div>

              <div style={{ padding: '8px 14px', borderTop: '1px solid var(--dsw-alias-border-l2)', display: 'flex', gap: '8px', flexShrink: 0, alignItems: 'center' }}>
                <select
                  value={saveWorkspace}
                  onChange={(e) => setSaveWorkspace(e.target.value)}
                  title="选择记忆归属"
                  style={{ padding: '6px 6px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', fontSize: '11px', outline: 'none', maxWidth: '96px', flexShrink: 0 }}
                >
                  <option value="*">全局</option>
                  {[...new Set(suggestPool.map(r => r.workspace))].filter(w => w !== '*').map(w => (
                    <option key={w} value={w}>{w.split('/').pop() || w}</option>
                  ))}
                  {!['*', ...suggestPool.map(r => r.workspace)].includes(saveWorkspace) && <option value={saveWorkspace}>{saveWorkspace.split('/').pop() || saveWorkspace}</option>}
                </select>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    void quickSave()
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
                  onClick={() => void quickSave()}
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
              ) : historyError && history.length === 0 ? (
                <div style={{ padding: '24px', textAlign: 'center' }}>
                  <div style={{ fontSize: '20px', marginBottom: '6px' }}>⚠️</div>
                  <div style={{ fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' }}>加载失败</div>
                  <button
                    type="button"
                    onClick={() => { setHistoryError(false); setHistoryReload((x) => x + 1) }}
                    style={{ marginTop: '10px', padding: '4px 14px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', fontSize: '12px', cursor: 'pointer' }}
                  >
                    重试
                  </button>
                </div>
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
                            onClick={() => { void handleCopy(h.content) }}
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
        {toast && (
          <div style={{ position: 'fixed', bottom: '510px', right: '20px', padding: '8px 12px', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', fontSize: '12px', color: toast.kind === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)', zIndex: 41, maxWidth: 'min(320px, calc(100vw - 32px))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {toast.text}
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
        {toast && <div style={{ position: 'fixed', bottom: '76px', right: '20px', padding: '8px 12px', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', fontSize: '12px', color: toast.kind === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)', zIndex: 41 }}>{toast.text}</div>}
        {isDropOver && <div style={{ position: 'fixed', bottom: '76px', right: '20px', padding: '6px 10px', borderRadius: '999px', background: 'var(--dsw-alias-brand-primary)', color: 'white', fontSize: '11px', zIndex: 41, pointerEvents: 'none' }}>松手记住</div>}
      </>
    )
  }

  if (collapsed && !showBig) {
    return (
      <>
        {dotButton('已召回 · 点击打开记忆管理 / 拖动移动 / 双击复位 · 拖文字到此可直接记住')}
        {toast && <div style={{ position: 'fixed', bottom: '76px', right: '20px', padding: '8px 12px', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', fontSize: '12px', color: toast.kind === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)', zIndex: 41 }}>{toast.text}</div>}
        {isDropOver && <div style={{ position: 'fixed', bottom: '76px', right: '20px', padding: '6px 10px', borderRadius: '999px', background: 'var(--dsw-alias-brand-primary)', color: 'white', fontSize: '11px', zIndex: 41, pointerEvents: 'none' }}>松手记住</div>}
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
      onMouseEnter={pauseHide}
      onMouseLeave={resumeHide}
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
