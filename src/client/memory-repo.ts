export type MemoryRecord = { id: string; content: string; kind: string; tags: readonly string[]; strength: number; updatedAt: number; workspace: string; sensitive?: boolean }

export async function fetchList(query: string, limit: number = 20): Promise<MemoryRecord[]> {
  const url = `/api/dsh-echo-memory/list?limit=${limit}${query.trim().length > 0 ? `&q=${encodeURIComponent(query.trim())}` : ''}`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`list failed HTTP ${res.status}`)
  const data = (await res.json()) as { items: MemoryRecord[] }
  if (!Array.isArray(data.items)) throw new Error('list returned malformed payload')
  return data.items
}

export async function saveMemory(content: string, workspace: string = '*', sensitive: boolean = false): Promise<boolean> {
  const res = await fetch('/api/dsh-echo-memory/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, workspace, sensitive }) })
  return res.ok
}

export async function updateMemory(id: string, content: string): Promise<boolean> {
  const res = await fetch('/api/dsh-echo-memory/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, content }) })
  return res.ok
}

export async function updateSensitive(id: string, sensitive: boolean): Promise<boolean> {
  const res = await fetch('/api/dsh-echo-memory/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, sensitive }) })
  return res.ok
}

export async function forgetMemory(id: string): Promise<boolean> {
  const res = await fetch('/api/dsh-echo-memory/forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
  return res.ok
}
