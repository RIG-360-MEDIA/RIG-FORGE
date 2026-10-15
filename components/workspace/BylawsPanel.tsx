'use client'

import { useState } from 'react'
import { ScrollText, Search } from 'lucide-react'

interface BylawsMatch {
  server: string
  path: string
  fileName: string
  score: number
  excerpt: string
  /** The table row that applies to the plot area in the question. */
  matchedRow?: string
}

interface BylawsResult {
  query: string
  /** What every result had to satisfy, e.g. "FAR and a 2,000 sq m plot". */
  requirement: string | null
  /** False: nothing satisfied all of it; the matches are only the closest. */
  allMatched: boolean
  matches: BylawsMatch[]
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
  const [meta, setMeta] = useState<{ requirement: string | null; allMatched: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [notConfigured, setNotConfigured] = useState(false)

  const runSearch = async () => {
    if (!q.trim()) return
    setLoading(true); setErr(null); setNotConfigured(false)
    try {
      const r = await api<BylawsResult>('/api/nas/bylaws/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q.trim() }),
      })
      setMatches(r.matches || [])
      setMeta({ requirement: r.requirement ?? null, allMatched: r.allMatched !== false })
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
          placeholder="Ask a full question, e.g. “FAR for a 2000 sq m plot”…"
          className="px-2 py-1 text-sm border border-border-default rounded bg-transparent text-text-primary flex-1 min-w-[200px]"
        />
        <button
          onClick={() => void runSearch()}
          disabled={loading || !q.trim()}
          className="inline-flex items-center gap-1.5 px-3 py-1 text-sm border border-border-default rounded text-text-secondary disabled:opacity-50"
        >
          {loading ? 'Searching…' : <><Search className="h-4 w-4" aria-hidden="true" />Search</>}
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
            <button onClick={() => { setMatches(null); setMeta(null) }} className="hover:text-text-primary">✕ clear</button>
          </div>
          {meta?.requirement && (
            meta.allMatched ? (
              <div className="px-3 py-2 text-xs text-text-secondary">
                Every result covers <span className="font-medium text-text-primary">{meta.requirement}</span>.
              </div>
            ) : (
              <div className="px-3 py-2 text-xs text-amber-700 bg-amber-50 border-amber-200">
                No passage covers <span className="font-medium">{meta.requirement}</span> together. Showing the
                closest passages instead; check the figure for your plot size in the document.
              </div>
            )
          )}
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
                  <ScrollText className="inline h-4 w-4 mr-1.5 -mt-0.5 align-middle" aria-hidden="true" />{m.fileName}
                </a>
                <span className="text-text-secondary text-xs font-mono shrink-0">{Math.round(m.score * 100)}% match</span>
              </div>
              {m.matchedRow && (
                <p className="text-xs font-mono px-2 py-1 rounded bg-surface-raised text-text-primary">
                  <span className="text-text-secondary">Matching row:</span> {m.matchedRow}
                </p>
              )}
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
