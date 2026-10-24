'use client'

import { useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FileSearch, ScrollText, Search } from 'lucide-react'

import MarkedText from '@/components/workspace/MarkedText'
import { tidy } from '@/lib/rag/highlight'

interface BylawsMatch {
  server: string
  path: string
  fileName: string
  /** Position in its document: with server + path, the passage's id for the source view. */
  chunkIndex?: number
  score: number
  excerpt: string
  /** The table row (or line) that answers the question, as printed. */
  matchedRow?: string
  /** The clause it is in, e.g. "3.2.4.1 Residential – Plotted Development". */
  section?: string
  /** The row against its column labels, e.g. "Front 3 m, Rear 1.5 m, Side-1 0 m, Side-2 0 m". */
  values?: string
}

interface BylawsResult {
  query: string
  /** What every result had to satisfy, e.g. "FAR and a 2,000 sq m plot". */
  requirement: string | null
  /** False: nothing satisfied all of it; the matches are only the closest. */
  allMatched: boolean
  matches: BylawsMatch[]
}

/** Read the NDJSON frames of /api/nas/bylaws/answer as they arrive. */
async function readFrames(res: Response, onFrame: (frame: Record<string, unknown>) => void): Promise<void> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) onFrame(JSON.parse(line))
    }
  }
}

/** Passages above this length start collapsed. */
const COLLAPSE_CHARS = 700

/** The passage text, readable, with the row that answers the question marked. */
function Excerpt({ text, row }: { text: string; row?: string }) {
  const [open, setOpen] = useState(false)
  const body = tidy(text)
  const long = body.length > COLLAPSE_CHARS
  return (
    <div className="mt-1 rounded border border-border-default bg-surface-raised/60">
      <p className="px-3 pt-2 text-[11px] font-medium uppercase tracking-wide text-text-secondary">From the document</p>
      <div className={`relative px-3 pb-2 pt-1 ${long && !open ? 'max-h-48 overflow-hidden' : ''}`}>
        <MarkedText text={body} marks={row ? [row] : []} />
        {long && !open && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface-raised to-transparent" />
        )}
      </div>
      {long && (
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full border-t border-border-default px-3 py-1.5 text-left text-xs font-medium text-text-secondary hover:text-text-primary"
        >
          {open ? 'Show less' : 'Show full passage'}
        </button>
      )}
    </div>
  )
}

// Search over the separate bylaws RAG index (own Qdrant collection — see
// lib/rag/index-bylaws-file.ts) with the whole question, then a written answer
// from the passages found, citing them by number. The passages come first and
// stay visible; without an LLM (ASSISTANT_ENABLED off) they are shown alone.
export default function BylawsPanel() {
  const [q, setQ] = useState('')
  const [matches, setMatches] = useState<BylawsMatch[] | null>(null)
  const [meta, setMeta] = useState<{ requirement: string | null; allMatched: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [notConfigured, setNotConfigured] = useState(false)
  const [answer, setAnswer] = useState('')
  const [answering, setAnswering] = useState(false)
  const [asked, setAsked] = useState('')
  // A newer search makes the frames of an older one stale.
  const searchId = useRef(0)

  const runSearch = async () => {
    const query = q.trim()
    if (!query) return
    const id = ++searchId.current
    setLoading(true); setErr(null); setNotConfigured(false); setAnswer(''); setMatches(null); setMeta(null); setAsked(query)
    try {
      const res = await fetch('/api/nas/bylaws/answer', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.error || 'Request failed')
      }
      await readFrames(res, (f) => {
        if (id !== searchId.current) return
        if (f.type === 'matches') {
          const r = f as unknown as BylawsResult
          setMatches(r.matches || [])
          setMeta({ requirement: r.requirement ?? null, allMatched: r.allMatched !== false })
          setLoading(false)
          setAnswering((r.matches || []).length > 0)
        } else if (f.type === 'text') {
          setAnswer((a) => a + String(f.delta ?? ''))
        } else if (f.type === 'error') {
          setErr(String(f.error ?? 'Could not write an answer'))
        }
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Search failed'
      if (/not configured/i.test(msg)) setNotConfigured(true)
      else setErr(msg)
    } finally {
      if (id === searchId.current) { setLoading(false); setAnswering(false) }
    }
  }

  // The source view: this passage and the PDF page it is on, the row highlighted.
  const sourceUrl = (m: BylawsMatch) =>
    `/dashboard/source?${new URLSearchParams({ c: 'bylaws', s: m.server, p: m.path, i: String(m.chunkIndex), k: m.matchedRow ?? '' })}`

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
            <span>{matches.length} result{matches.length === 1 ? '' : 's'} for “{asked}”</span>
            <button onClick={() => { searchId.current++; setMatches(null); setMeta(null); setAnswer(''); setAnswering(false) }} className="hover:text-text-primary">✕ clear</button>
          </div>
          {(answer || answering) && (
            <div className="px-3 py-3 text-sm text-text-primary space-y-2">
              <p className="text-xs font-medium text-text-secondary">Answer</p>
              {answer ? (
                <div className="prose prose-sm max-w-none text-text-primary prose-p:my-1 prose-ul:my-1 prose-li:my-0 prose-strong:text-text-primary">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-xs text-text-secondary">Writing an answer from the passages below…</p>
              )}
              <p className="text-xs text-text-secondary">Numbers in brackets refer to the passages below. Check the figure in the document before relying on it.</p>
            </div>
          )}
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
                  <span className="font-mono text-text-secondary mr-1.5">[{i + 1}]</span>
                  <ScrollText className="inline h-4 w-4 mr-1.5 -mt-0.5 align-middle" aria-hidden="true" />{m.fileName}
                </a>
                <span className="text-text-secondary text-xs font-mono shrink-0">{Math.round(m.score * 100)}% match</span>
              </div>
              {m.section && (
                <p className="text-xs text-text-secondary">
                  Clause <span className="text-text-primary">{m.section}</span>
                </p>
              )}
              {m.values && (
                <p className="text-sm px-2 py-1 rounded bg-surface-raised text-text-primary font-medium">{m.values}</p>
              )}
              {m.matchedRow && (
                <p className="text-xs font-mono px-2 py-1 rounded bg-surface-raised text-text-primary">
                  <span className="text-text-secondary">{m.values ? 'Row as printed:' : 'Matching line:'}</span> {m.matchedRow}
                </p>
              )}
              <Excerpt text={m.excerpt} row={m.matchedRow} />
              {typeof m.chunkIndex === 'number' && (
                <a
                  href={sourceUrl(m)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-text-primary hover:underline"
                >
                  <FileSearch className="h-3.5 w-3.5" aria-hidden="true" />Show page in the PDF
                </a>
              )}
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
