/**
 * Dock 召回历史 tab：展示最近召回条目（query + 命中列表），可复制命中正文。
 * 历史数据与加载态自洽在此；重试驱动内部 reload。
 * @module dsh-echo-memory/client/recall-tab
 */

import { useCallback, useEffect, useState } from 'react'
import { copyText, formatTime, splitTitle, type Toast } from './dock-util.ts'
import type { LastRecall } from './recall-feed.ts'

/** 召回历史条目与最近召回同形。 */
type RecallHistoryEntry = LastRecall

export function RecallTab(props: {
  onToast: (text: string, kind?: Toast['kind']) => void
  onCount: (count: number) => void
}) {
  const [history, setHistory] = useState<RecallHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const [historyReload, setHistoryReload] = useState(0)

  // 时间文案每分钟刷新一次
  const [, forceTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => forceTick((x) => x + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  // 拉取召回历史（挂载 + 重试）
  useEffect(() => {
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
  }, [historyReload])

  // 上报当前条数给面板 header 徽标
  useEffect(() => {
    props.onCount(history.length)
  }, [history, props.onCount])

  const handleCopy = useCallback(async (text: string) => {
    const ok = await copyText(text)
    if (!ok) props.onToast('复制失败', 'error')
  }, [props.onToast])

  if (historyLoading && history.length === 0) {
    return <div style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>加载中…</div>
  }
  if (historyError && history.length === 0) {
    return (
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
    )
  }
  if (history.length === 0) {
    return (
      <div style={{ padding: '24px', textAlign: 'center' }}>
        <div style={{ fontSize: '20px', marginBottom: '6px' }}>💭</div>
        <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>还没有召回</div>
        <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '4px' }}>和 agent 聊天时，相关记忆会自动出现在这里</div>
      </div>
    )
  }
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px 8px', minHeight: 0 }}>
      {history.map((entry) => (
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
      ))}
    </div>
  )
}
