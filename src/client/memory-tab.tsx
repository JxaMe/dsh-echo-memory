/**
 * Dock 记忆管理 tab：筛选/搜索联想/列表增删改/快记。
 * 全部记忆相关 state 与 effect 自洽在此；保存类动作失败保留草稿并给反馈（经 onToast），
 * 列表刷新信号（refreshSignal）由父层在拖放保存成功后驱动。
 * @module dsh-echo-memory/client/memory-tab
 */

import { useCallback, useEffect, useState } from 'react'
import { fetchList as fetchMemoryList, forgetMemory, saveMemory, updateMemory, updateSensitive, type MemoryRecord } from './memory-repo.ts'
import { copyText, splitTitle, type Toast } from './dock-util.ts'
import { MemoryListItem } from './memory-list-item.tsx'

export function MemoryTab(props: {
  onToast: (text: string, kind?: Toast['kind']) => void
  onCount: (count: number) => void
  refreshSignal: number
  saveWorkspace: string
  onSaveWorkspaceChange: (workspace: string) => void
}) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<MemoryRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [manageQuery, setManageQuery] = useState('')
  const [listError, setListError] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const [suggestPool, setSuggestPool] = useState<MemoryRecord[]>([])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [showSuggest, setShowSuggest] = useState(false)
  const [filterScope, setFilterScope] = useState<'all' | 'global' | 'project'>('all')
  const [quickSensitive, setQuickSensitive] = useState(false)

  // 时间文案每分钟刷新一次，否则“刚刚”不会变
  const [, forceTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => forceTick((x) => x + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  // 列表加载（300ms 防抖，单请求；重试/外部刷新信号驱动重拉）
  useEffect(() => {
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
  }, [manageQuery, reloadTick, props.refreshSignal])

  // 搜索联想池：挂载时拉一次全量用于本地联想
  useEffect(() => {
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
  }, [])

  // 根据输入生成联想（标签优先，其次标题）
  useEffect(() => {
    const q = manageQuery.trim().toLowerCase()
    if (q.length < 1) { setSuggestions([]); setShowSuggest(false); return }
    const seen = new Set<string>()
    const out: string[] = []
    const add = (s: string) => {
      const t = s.trim()
      if (t.length < 1 || t.length > 24 || seen.has(t.toLowerCase())) return
      const lower = t.toLowerCase()
      if (!lower.includes(q)) return
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

  // 上报当前条数给面板 header 徽标
  useEffect(() => {
    props.onCount(items.length)
  }, [items, props.onCount])

  /** 刷新列表：失败静默——操作反馈不被覆盖，主加载错误态兜底。 */
  const refreshList = useCallback(async () => {
    try {
      setItems(await fetchMemoryList(manageQuery))
    } catch {
      // 静默
    }
  }, [manageQuery])

  /** 快记（回车 / 保存按钮）：失败保留输入框草稿并给反馈。 */
  const quickSave = useCallback(async () => {
    const c = query.trim()
    if (!c) return
    let ok = false
    try { ok = await saveMemory(c, props.saveWorkspace, quickSensitive) } catch { ok = false }
    if (!ok) {
      props.onToast('保存失败', 'error')
      return
    }
    setQuery('')
    setQuickSensitive(false)
    props.onToast('已记住 ✅')
    void refreshList()
  }, [query, props.saveWorkspace, props.onToast, refreshList, quickSensitive])

  /** 切换敏感标记：失败回滚并给反馈（乐观更新失败时恢复原值）。 */
  const handleToggleSensitive = useCallback(async (id: string, current: boolean) => {
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, sensitive: !current } : x)))
    let ok = false
    try { ok = await updateSensitive(id, !current) } catch { ok = false }
    if (!ok) {
      setItems((prev) => prev.map((x) => (x.id === id ? { ...x, sensitive: current } : x)))
      props.onToast('标记失败', 'error')
      return
    }
    props.onToast(!current ? '已标记敏感，自动召回将排除 🔒' : '已取消敏感标记')
  }, [props.onToast])

  /** 编辑保存：失败保留编辑态并给反馈。 */
  const handleEditSave = useCallback(async (id: string) => {
    const c = draft.trim()
    if (!c) return
    let ok = false
    try { ok = await updateMemory(id, c) } catch { ok = false }
    if (!ok) {
      props.onToast('更新失败', 'error')
      return
    }
    setEditingId(null)
    props.onToast('已更新 ✅')
    void refreshList()
  }, [draft, props.onToast, refreshList])

  /** 删除：失败不移除列表项并给反馈。 */
  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('删除这条记忆？')) return
    let ok = false
    try { ok = await forgetMemory(id) } catch { ok = false }
    if (!ok) {
      props.onToast('删除失败', 'error')
      return
    }
    setItems((prev) => prev.filter((x) => x.id !== id))
    props.onToast('已删除')
  }, [props.onToast])

  /** 复制：失败给反馈。 */
  const handleCopy = useCallback(async (text: string) => {
    const ok = await copyText(text)
    if (!ok) props.onToast('复制失败', 'error')
  }, [props.onToast])

  const displayItems = filterScope === 'all' ? items : items.filter(r => filterScope === 'global' ? r.workspace === '*' : r.workspace !== '*')

  return (
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
              onToggleSensitive={() => void handleToggleSensitive(r.id, r.sensitive === true)}
            />
          ))
        })()}
      </div>

      <div style={{ padding: '8px 14px', borderTop: '1px solid var(--dsw-alias-border-l2)', display: 'flex', gap: '8px', flexShrink: 0, alignItems: 'center' }}>
        <select
          value={props.saveWorkspace}
          onChange={(e) => props.onSaveWorkspaceChange(e.target.value)}
          title="选择记忆归属"
          style={{ padding: '6px 6px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', fontSize: '11px', outline: 'none', maxWidth: '96px', flexShrink: 0 }}
        >
          <option value="*">全局</option>
          {[...new Set(suggestPool.map(r => r.workspace))].filter(w => w !== '*').map(w => (
            <option key={w} value={w}>{w.split('/').pop() || w}</option>
          ))}
          {!['*', ...suggestPool.map(r => r.workspace)].includes(props.saveWorkspace) && <option value={props.saveWorkspace}>{props.saveWorkspace.split('/').pop() || props.saveWorkspace}</option>}
        </select>
        <button
          type="button"
          onClick={() => setQuickSensitive((v) => !v)}
          title={quickSensitive ? '本条将标记为敏感，自动召回排除' : '标记本条为敏感（账号/密码/API key 等）'}
          style={{
            padding: '6px 8px',
            borderRadius: '8px',
            border: quickSensitive ? '1px solid var(--dsw-alias-state-error-primary)' : '1px solid var(--dsw-alias-border-l2)',
            background: quickSensitive ? 'rgba(236,19,19,0.12)' : 'var(--dsw-alias-bg-layer-3)',
            color: quickSensitive ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)',
            fontSize: '12px',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          {quickSensitive ? '🔒 敏感' : '🔓 敏感'}
        </button>
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
  )
}
