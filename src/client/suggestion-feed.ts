import { useCallback, useEffect, useState } from 'react'

export type Suggestion = { id: string; content: string; workspace: string; kind?: string | undefined; tags?: readonly string[] | undefined; at: number }

export function useSuggestionFeed(): {
  suggestions: Suggestion[]
  dismiss: (id: string) => Promise<void>
  confirm: (id: string) => Promise<boolean>
  refresh: () => Promise<void>
} {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/dsh-echo-memory/suggestions', { headers: { Accept: 'application/json' } })
      if (!res.ok) return
      const data = (await res.json()) as { items: Suggestion[] }
      if (Array.isArray(data.items)) setSuggestions(data.items)
    } catch {}
  }, [])

  const dismiss = useCallback(async (id: string) => {
    setSuggestions((prev) => prev.filter((s) => s.id !== id))
    try {
      await fetch('/api/dsh-echo-memory/suggestions/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
    } catch {}
  }, [])

  const confirm = useCallback(async (id: string) => {
    try {
      const res = await fetch('/api/dsh-echo-memory/suggestions/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) return false
      setSuggestions((prev) => prev.filter((s) => s.id !== id))
      return true
    } catch {
      return false
    }
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const poll = async () => {
      if (document.hidden) return
      await refresh()
    }
    const schedule = () => {
      if (timer) clearInterval(timer)
      timer = setInterval(poll, document.hidden ? 10000 : 2500)
    }
    void poll()
    schedule()
    const onVisible = () => {
      schedule()
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  return { suggestions, dismiss, confirm, refresh }
}
