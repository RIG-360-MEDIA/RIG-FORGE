'use client'

import { useCallback, useEffect, useState } from 'react'
import { Bot, GitPullRequestDraft, Sparkles } from 'lucide-react'

interface Repo {
  name: string
  fullName: string
  description: string | null
  url: string
  private: boolean
  language: string | null
  openIssues: number
  pushedAt: string
}
interface Commit { sha: string; message: string; authorName: string; authorLogin: string | null; date: string; url: string }
interface PR { number: number; title: string; state: string; draft: boolean; authorLogin: string; url: string; labels: string[] }
interface Issue { number: number; title: string; state: string; authorLogin: string; assigneeLogin: string | null; url: string; labels: string[] }
type View = 'commits' | 'prs' | 'issues'

async function api<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'include' })
  const j = await r.json()
  if (!r.ok || j.error) throw new Error(j.error || 'Request failed')
  return j.data as T
}
async function api2<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok || j.error) throw new Error(j.error || 'Request failed')
  return j.data as T
}

function shortDate(d: string): string {
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return ''
  return dt.toLocaleDateString([], { day: '2-digit', month: 'short' })
}

export default function CodePanel() {
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [err, setErr] = useState('')
  const [active, setActive] = useState<Repo | null>(null)
  const [view, setView] = useState<View>('commits')
  const [items, setItems] = useState<Commit[] | PR[] | Issue[]>([])
  const [loadingItems, setLoadingItems] = useState(false)
  const [summary, setSummary] = useState('')
  const [summarizing, setSummarizing] = useState(false)

  async function summarize() {
    if (!active) return
    setSummarizing(true)
    setSummary('')
    try {
      const r = await api2<{ text: string }>('/api/github/assist', { repo: active.name, view })
      setSummary(r.text)
    } catch (e) {
      setSummary('Forgie failed: ' + (e as Error).message)
    } finally {
      setSummarizing(false)
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ repos: Repo[] }>('/api/github/repos')
        setRepos(r.repos)
      } catch (e) {
        setErr((e as Error).message)
        setRepos([])
      }
    })()
  }, [])

  const loadItems = useCallback(async (repo: string, v: View) => {
    setLoadingItems(true)
    setItems([])
    try {
      const r = await api<{ items: Commit[] | PR[] | Issue[] }>(`/api/github/repo?repo=${encodeURIComponent(repo)}&view=${v}`)
      setItems(r.items)
    } catch (e) {
      console.error('[code] items', e)
    } finally {
      setLoadingItems(false)
    }
  }, [])

  function openRepo(r: Repo) {
    setActive(r)
    setView('commits')
    setSummary('')
    void loadItems(r.name, 'commits')
  }
  function switchView(v: View) {
    setView(v)
    setSummary('')
    if (active) void loadItems(active.name, v)
  }

  if (repos === null) return <div className="p-8 font-mono text-sm text-text-secondary">Loading repositories…</div>
  if (err) {
    return (
      <div className="p-10 text-center border border-border-default rounded-xl">
        <p className="text-2xl mb-2">⌥</p>
        <p className="text-lg font-medium text-text-primary mb-1">GitHub unavailable</p>
        <p className="text-sm text-text-secondary">{err}</p>
      </div>
    )
  }

  const subTab = (v: View, label: string) => (
    <button
      type="button"
      onClick={() => switchView(v)}
      className={`px-3 py-1.5 text-xs font-mono rounded-full ${view === v ? 'bg-[#3F7A0A] text-white' : 'border border-border-default text-text-secondary'}`}
    >
      {label}
    </button>
  )

  return (
    <div className="flex h-[calc(100vh-9rem)] border border-border-default rounded-xl overflow-hidden">
      {/* Repo list */}
      <div className={`w-full sm:w-72 shrink-0 sm:border-r border-border-default flex-col bg-surface-raised/40 ${active ? 'hidden sm:flex' : 'flex'}`}>
        <div className="h-12 px-4 flex items-center border-b border-border-default">
          <span className="font-mono text-xs uppercase tracking-widest text-text-secondary">Repositories ({repos.length})</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {repos.length === 0 ? (
            <p className="p-4 text-xs text-text-secondary">No repositories.</p>
          ) : (
            repos.map((r) => (
              <button
                key={r.fullName}
                type="button"
                onClick={() => openRepo(r)}
                className={`w-full text-left px-3 py-2.5 border-b border-border-subtle hover:bg-text-primary//[0.03] ${active?.name === r.name ? 'bg-[#3F7A0A]/10' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary truncate">{r.name}</span>
                  {r.private && <span className="text-[9px] font-mono text-text-secondary border border-border-default rounded px-1">private</span>}
                </div>
                <p className="text-[11px] text-text-secondary truncate">{r.description || 'No description'}</p>
                <p className="text-[10px] text-text-muted mt-0.5">{r.language || '—'} · {r.openIssues} open · {shortDate(r.pushedAt)}</p>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Detail */}
      <div className={`flex-1 min-w-0 flex-col ${active ? 'flex' : 'hidden sm:flex'}`}>
        {!active ? (
          <div className="flex-1 flex items-center justify-center text-text-secondary text-sm">Select a repository</div>
        ) : (
          <>
            <div className="px-5 py-4 border-b border-border-default">
              <button type="button" onClick={() => setActive(null)} className="sm:hidden text-text-secondary text-sm mb-2">‹ Repos</button>
              <div className="flex items-center justify-between gap-2">
                <p className="text-lg font-medium text-text-primary truncate">{active.name}</p>
                <a href={active.url} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-accent-ink shrink-0">Open ↗</a>
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-3">
                {subTab('commits', 'Commits')}
                {subTab('prs', 'Pull requests')}
                {subTab('issues', 'Issues')}
                <button type="button" onClick={() => void summarize()} disabled={summarizing} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono rounded-full border border-border-default text-text-primary disabled:opacity-40"><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />Summarize</button>
              </div>
              {summarizing && <p className="text-xs text-accent-ink mt-2">Forgie is reading the repo…</p>}
              {summary && <div className="mt-2 p-2.5 rounded-lg bg-[#EDE7FB] text-[#2A1A4A] text-sm whitespace-pre-wrap"><Bot className="inline h-4 w-4 mr-1.5 -mt-0.5 align-middle" aria-hidden="true" />{summary}</div>}
            </div>
            <div className="flex-1 overflow-y-auto">
              {loadingItems ? (
                <p className="p-5 text-sm text-text-secondary">Loading…</p>
              ) : items.length === 0 ? (
                <p className="p-5 text-sm text-text-secondary">Nothing here.</p>
              ) : view === 'commits' ? (
                (items as Commit[]).map((c) => (
                  <a key={c.sha} href={c.url} target="_blank" rel="noopener noreferrer" className="block px-5 py-2.5 border-b border-border-subtle hover:bg-text-primary//[0.03]">
                    <p className="text-sm text-text-primary truncate">{c.message}</p>
                    <p className="text-[11px] text-text-secondary mt-0.5"><span className="font-mono">{c.sha}</span> · {c.authorLogin || c.authorName} · {shortDate(c.date)}</p>
                  </a>
                ))
              ) : view === 'prs' ? (
                (items as PR[]).map((p) => (
                  <a key={p.number} href={p.url} target="_blank" rel="noopener noreferrer" className="block px-5 py-2.5 border-b border-border-subtle hover:bg-text-primary//[0.03]">
                    <p className="text-sm text-text-primary truncate">{p.draft && <GitPullRequestDraft className="inline h-3.5 w-3.5 mr-1.5 -mt-0.5 align-middle text-text-secondary" aria-label="Draft" />}{p.title}</p>
                    <p className="text-[11px] text-text-secondary mt-0.5">#{p.number} · {p.authorLogin}{p.labels.length ? ` · ${p.labels.join(', ')}` : ''}</p>
                  </a>
                ))
              ) : (
                (items as Issue[]).map((i) => (
                  <a key={i.number} href={i.url} target="_blank" rel="noopener noreferrer" className="block px-5 py-2.5 border-b border-border-subtle hover:bg-text-primary//[0.03]">
                    <p className="text-sm text-text-primary truncate">{i.title}</p>
                    <p className="text-[11px] text-text-secondary mt-0.5">#{i.number} · {i.authorLogin}{i.assigneeLogin ? ` → ${i.assigneeLogin}` : ''}{i.labels.length ? ` · ${i.labels.join(', ')}` : ''}</p>
                  </a>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
