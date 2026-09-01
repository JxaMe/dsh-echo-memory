export type MemoryRecord = { id: string; content: string; kind: string; tags: readonly string[]; strength: number; updatedAt: number; workspace: string }

export async function fetchList(query: string, limit: number = 20): Promise<MemoryRecord[]> {
  const url = `/api/dsh-echo-memory/list?limit=${limit}${query.trim().length > 0 ? `&q=${encodeURIComponent(query.trim())}` : ''}`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) return []
  const data = (await res.json()) as { items: MemoryRecord[] }
  return Array.isArray(data.items) ? data.items : []
}

export async function saveMemory(content: string, workspace: string = '*'): Promise<boolean> {
  const res = await fetch('/api/dsh-echo-memory/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, workspace }) })
  return res.ok
}

export async function updateMemory(id: string, content: string): Promise<boolean> {
  const res = await fetch('/api/dsh-echo-memory/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, content }) })
  return res.ok
}

export async function forgetMemory(id: string): Promise<boolean> {
  const res = await fetch('/api/dsh-echo-memory/forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
  return res.ok
}
