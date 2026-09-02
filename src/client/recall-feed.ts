import { useCallback, useEffect, useRef, useState } from 'react'

export type RecallHit = { id: string; kind: string; content: string; tags: readonly string[]; strength: number }
export type LastRecall = { at: number; query: string; hits: RecallHit[] }

export function useRecallFeed(showManage: boolean): {
  hits: RecallHit[]
  showBig: boolean
  collapsed: boolean
  setShowBig: (v: boolean) => void
  setCollapsed: (v: boolean) => void
  pauseHide: () => void
  resumeHide: () => void
} {
  const [hits, setHits] = useState<RecallHit[]>([])
  const [showBigState, setShowBigState] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const lastAtRef = useRef(0)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const setShowBig = useCallback((v: boolean) => {
    setShowBigState(v)
    if (!v && hideTimer.current) {
      clearTimeout(hideTimer.current)
      hideTimer.current = undefined
    }
  }, [])

  const pauseHide = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current)
      hideTimer.current = undefined
    }
  }, [])

  const resumeHide = useCallback(() => {
    if (!showBigState || hideTimer.current) return
    hideTimer.current = setTimeout(() => {
      setShowBigState(false)
      setCollapsed(true)
    }, 3000)
  }, [showBigState])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | undefined
    const poll = async () => {
      if (document.hidden) return
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
    const schedule = () => {
      if (timer) clearInterval(timer)
      const interval = document.hidden ? 10000 : 2500
      timer = setInterval(poll, interval)
    }
    const onVisible = () => {
      schedule()
      if (!document.hidden) void poll()
    }
    void poll()
    schedule()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [showManage])

  return { hits, showBig: showBigState, collapsed, setShowBig, setCollapsed, pauseHide, resumeHide }
}
