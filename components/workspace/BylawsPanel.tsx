'use client'

import { useState } from 'react'

interface BylawsMatch {
  server: string
  path: string
  fileName: string
  score: number
  excerpt: string
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: 'include', ...init })
  const j = await r.json()
  if (!r.ok || j.error) throw new Error(j.error || 'Request failed')
  return j.data as T
}

// Direct semantic search over the separate bylaws RAG index (own Qdrant
// collection — see lib/rag/index-bylaws-file.ts). Independent of the Forgie
// chatbot: works even when ASSISTANT_ENABLED is off, since it only needs the
// embedding + vector search pipeline, not an LLM.
export default function BylawsPanel() {
  const [q, setQ] = useState('')
  const [matches, setMatches] = useState<BylawsMatch[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [notConfigured, setNotConfigured] = useState(false)

  const runSearch = async () => {
    if (!q.trim()) return
    setLoading(true); setErr(null); setNotConfigured(false)
    try {
      const r = await api<{ query: string; matches: BylawsMatch[] }>('/api/nas/bylaws/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q.trim() }),
      })
      setMatches(r.matches || [])
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Search failed'
      if (/not configured/i.test(msg)) setNotConfigured(true)
      else setErr(msg)
    } finally {
      setLoading(false)
    }
  }

  const viewUrl = (server: string, path: string) =>
    `/api/nas/download?server=${encodeURIComponent(server)}&path=${encodeURIComponent(path)}&inline=1`

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void runSearch() }}
          placeholder="Ask about a bylaw, e.g. “maximum building height”…"
          className="px-2 py-1 text-sm border border-border-default rounded bg-transparent text-text-primary flex-1 min-w-[200px]"
        />
        <button
          onClick={() => void runSearch()}
          disabled={loading || !q.trim()}
          className="px-3 py-1 text-sm border border-border-default rounded text-text-secondary disabled:opacity-50"
        >
          {loading ? 'Searching…' : '📜 Search'}
        </button>
      </div>

      {err && <div className="text-sm text-red-500">{err}</div>}
      {notConfigured && (
        <div className="text-sm text-text-secondary p-4 border border-border-default rounded text-center">
          Bylaws content search isn&apos;t configured for this deployment yet.
        </div>
      )}

      {matches && (
        <div className="border border-border-default rounded divide-y divide-border-default">
          <div className="px-3 py-2 text-xs font-mono text-text-secondary flex justify-between">
            <span>{matches.length} result{matches.length === 1 ? '' : 's'} for “{q}”</span>
            <button onClick={() => setMatches(null)} className="hover:text-text-primary">✕ clear</button>
          </div>
          {matches.map((m, i) => (
            <div key={`${m.path}-${i}`} className="px-3 py-3 text-sm space-y-1">
              <div className="flex items-center justify-between gap-2">
                <a
                  href={viewUrl(m.server, m.path)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-text-primary font-medium truncate hover:underline"
                  title={m.path}
                >
                  📜 {m.fileName}
                </a>
                <span className="text-text-secondary text-xs font-mono shrink-0">{Math.round(m.score * 100)}% match</span>
              </div>
              <p className="text-text-secondary text-xs leading-relaxed whitespace-pre-wrap">{m.excerpt}</p>
            </div>
          ))}
          {matches.length === 0 && !loading && (
            <div className="px-3 py-3 text-sm text-text-secondary">No matching passages found.</div>
          )}
        </div>
      )}

      {!matches && !err && !notConfigured && !loading && (
        <div className="px-3 py-6 text-sm text-text-secondary text-center">
          Search Trijya&apos;s bylaws documents by meaning — ask a question above.
        </div>
      )}
    </div>
  )
}
