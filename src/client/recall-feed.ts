import { useCallback, useEffect, useRef, useState } from 'react'

export type RecallHit = { id: string; kind: string; content: string; tags: readonly string[]; strength: number }
export type LastRecall = { at: number; query: string; hits: RecallHit[] }

export function useRecallFeed(showManage: boolean): {
  hits: RecallHit[]
  showBig: boolean
  collapsed: boolean
  setShowBig: (v: boolean) => void
  setCollapsed: (v: boolean) => void
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

  return { hits, showBig: showBigState, collapsed, setShowBig, setCollapsed }
}
