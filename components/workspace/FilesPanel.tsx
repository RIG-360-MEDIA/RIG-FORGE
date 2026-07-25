'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

interface NasEntry { name: string; isDir: boolean; size: number; mtime: number }
interface SearchHit { name: string; path: string; isDir: boolean; size: number; server?: string }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: 'include', ...init })
  const j = await r.json()
  if (!r.ok || j.error) throw new Error(j.error || 'Request failed')
  return j.data as T
}

function fmtSize(n: number): string {
  if (!n) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}
function ext(name: string): string { return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '' }
const VIEWABLE = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'csv', 'svg', 'bmp'])
function icon(e: { isDir: boolean; name: string }): string {
  if (e.isDir) return '📁'
  const x = ext(e.name)
  if (x === 'pdf') return '📕'
  if (['xls', 'xlsx', 'csv'].includes(x)) return '📊'
  if (['doc', 'docx'].includes(x)) return '📄'
  if (['dwg', 'dxf', 'rvt', 'skp', '3ds', 'max'].includes(x)) return '📐'
  if (['jpg', 'jpeg', 'png', 'gif', 'tif', 'tiff', 'bmp', 'webp'].includes(x)) return '🖼️'
  if (['mp4', 'mov', 'avi', 'mkv'].includes(x)) return '🎬'
  if (['mp3', 'wav', 'amr', 'm4a'].includes(x)) return '🎵'
  if (['zip', 'rar', '7z'].includes(x)) return '🗜️'
  return '📦'
}
const joinPath = (dir: string, name: string) => (dir.endsWith('/') ? dir : dir + '/') + name
const parentOf = (p: string) => '/' + p.split('/').filter(Boolean).slice(0, -1).join('/')

export default function FilesPanel() {
  const [servers, setServers] = useState<string[] | null>(null)
  // NAS is configured for the org but its server / tunnel isn't responding.
  const [unreachable, setUnreachable] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [server, setServer] = useState('')
  const [items, setItems] = useState<NasEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [inFolder, setInFolder] = useState(false)
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [uploading, setUploading] = useState(false)
  const [emailFor, setEmailFor] = useState<{ path: string; name: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // Browse history (back/forward). `histIdx` points at the current entry.
  const [hist, setHist] = useState<string[]>(['/'])
  const [histIdx, setHistIdx] = useState(0)
  const path = hist[histIdx] ?? '/'

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2500) }

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ enabled: boolean; reachable?: boolean; servers: { label: string }[] }>('/api/nas/servers')
        if (r.reachable === false) { setUnreachable(true); setServers([]); return }
        setUnreachable(false)
        const labels = (r.servers || []).map((s) => s.label)
        setServers(labels)
        if (labels[0]) setServer(labels[0])
      } catch { setUnreachable(true); setServers([]) }
    })()
  }, [reloadKey])

  const fetchList = useCallback(async (srv: string, p: string) => {
    if (!srv) return
    setLoading(true); setErr(null); setHits(null)
    try {
      const r = await api<{ path: string; items: NasEntry[] }>(
        `/api/nas/list?server=${encodeURIComponent(srv)}&path=${encodeURIComponent(p)}`,
      )
      setItems(r.items || [])
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load'); setItems([]) }
    finally { setLoading(false) }
  }, [])

  // Navigate to a folder = push onto history (truncating any forward entries).
  const goto = useCallback((p: string) => {
    setHist((h) => [...h.slice(0, histIdx + 1), p])
    setHistIdx((i) => i + 1)
  }, [histIdx])

  const back = () => { if (histIdx > 0) setHistIdx(histIdx - 1) }
  const forward = () => { if (histIdx < hist.length - 1) setHistIdx(histIdx + 1) }
  const up = () => { if (path !== '/') goto(parentOf(path)) }

  // Reset history when the server changes.
  useEffect(() => { if (server) { setHist(['/']); setHistIdx(0) } }, [server])
  // Load whenever the current path changes.
  useEffect(() => { if (server) void fetchList(server, path) }, [server, path, fetchList])

  const runSearch = useCallback(async () => {
    if (!q.trim() || !server) return
    setLoading(true); setErr(null)
    try {
      const scope = inFolder ? `&path=${encodeURIComponent(path)}` : ''
      const r = await api<{ results: SearchHit[]; truncated: boolean }>(
        `/api/nas/search?server=${encodeURIComponent(server)}&q=${encodeURIComponent(q.trim())}${scope}`,
      )
      setHits(r.results || [])
    } catch (e) { setErr(e instanceof Error ? e.message : 'Search failed') }
    finally { setLoading(false) }
  }, [q, server, inFolder, path])

  const dlUrl = (p: string, inline: boolean) =>
    `/api/nas/download?server=${encodeURIComponent(server)}&path=${encodeURIComponent(p)}${inline ? '&inline=1' : ''}`
  const view = (p: string) => window.open(dlUrl(p, true), '_blank')
  const download = (p: string) => window.open(dlUrl(p, false), '_blank')

  const shareLink = async (p: string) => {
    try {
      const r = await api<{ path: string; ttlDays: number }>('/api/nas/share', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server, path: p }),
      })
      const url = `${window.location.origin}${r.path}`
      try { await navigator.clipboard.writeText(url) ; flash(`Link copied (valid ${r.ttlDays} days)`) }
      catch { window.prompt('Share link (copy):', url) }
    } catch (e) { flash(e instanceof Error ? e.message : 'Could not create link') }
  }

  const sendEmail = async (to: string, message: string) => {
    if (!emailFor) return
    try {
      await api('/api/nas/share-email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server, path: emailFor.path, to, body: message || undefined }),
      })
      flash(`Emailed ${emailFor.name} to ${to}`)
      setEmailFor(null)
    } catch (e) { flash(e instanceof Error ? e.message : 'Email failed') }
  }

  const onUpload = async (f: File) => {
    setUploading(true); setErr(null)
    try {
      const form = new FormData(); form.append('file', f, f.name)
      const r = await fetch(`/api/nas/upload?server=${encodeURIComponent(server)}&path=${encodeURIComponent(path)}`,
        { method: 'POST', body: form, credentials: 'include' })
      const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || 'Upload failed')
      await fetchList(server, path); flash('Uploaded')
    } catch (e) { setErr(e instanceof Error ? e.message : 'Upload failed') }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = '' }
  }

  const crumbs = path.split('/').filter(Boolean)

  if (servers === null) return <div className="text-sm text-text-secondary p-4">Loading…</div>
  if (unreachable) return (
    <div className="p-6 text-center">
      <p className="text-sm font-medium text-text-primary">NAS is currently unreachable</p>
      <p className="mt-1 text-xs text-text-secondary leading-relaxed max-w-md mx-auto">
        The file server is set up for this workspace but is not responding right now — the storage box or its connection
        (Cloudflare Tunnel) appears to be offline. Files will return automatically once it is back online.
      </p>
      <button
        onClick={() => { setServers(null); setUnreachable(false); setReloadKey((k) => k + 1) }}
        className="mt-4 h-9 px-4 rounded-lg border border-border-default text-xs font-medium text-text-secondary hover:text-text-primary hover:border-accent/50 transition-colors"
      >
        Retry
      </button>
    </div>
  )
  if (servers.length === 0) return <div className="text-sm text-text-secondary p-4">NAS is not available for this workspace.</div>

  const FileActions = ({ p, name }: { p: string; name: string }) => (
    <span className="flex items-center gap-1 shrink-0">
      {VIEWABLE.has(ext(name)) && <button onClick={(e) => { e.stopPropagation(); view(p) }} title="View" className="px-1.5 py-0.5 text-xs rounded hover:bg-surface-raised">👁</button>}
      <button onClick={(e) => { e.stopPropagation(); download(p) }} title="Download" className="px-1.5 py-0.5 text-xs rounded hover:bg-surface-raised">⬇</button>
      <button onClick={(e) => { e.stopPropagation(); void shareLink(p) }} title="Copy share link" className="px-1.5 py-0.5 text-xs rounded hover:bg-surface-raised">🔗</button>
      <button onClick={(e) => { e.stopPropagation(); setEmailFor({ path: p, name }) }} title="Email file" className="px-1.5 py-0.5 text-xs rounded hover:bg-surface-raised">✉️</button>
    </span>
  )

  return (
    <div className="space-y-3 relative">
      {toast && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded bg-accent-ink text-white text-sm shadow-lg">{toast}</div>}

      {/* Server tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {servers.map((s) => (
          <button key={s} onClick={() => { setServer(s); setQ(''); setHits(null) }}
            className={`px-3 py-1 text-sm font-mono rounded border ${server === s ? 'border-accent-ink text-text-primary bg-surface-raised' : 'border-border-default text-text-secondary'}`}>
            🗄️ {s}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={() => fileInput.current?.click()} disabled={uploading || !!hits}
          className="px-3 py-1 text-sm border border-border-default rounded text-text-primary disabled:opacity-50">
          {uploading ? 'Uploading…' : '⬆ Upload'}
        </button>
        <input ref={fileInput} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUpload(f) }} />
      </div>

      {/* Search row */}
      <div className="flex items-center gap-2 flex-wrap">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void runSearch() }}
          placeholder="Search files…" className="px-2 py-1 text-sm border border-border-default rounded bg-transparent text-text-primary flex-1 min-w-[140px]" />
        <button onClick={() => void runSearch()} className="px-3 py-1 text-sm border border-border-default rounded text-text-secondary">Go</button>
        <label className="flex items-center gap-1 text-xs text-text-secondary select-none">
          <input type="checkbox" checked={inFolder} onChange={(e) => setInFolder(e.target.checked)} />
          in this folder
        </label>
      </div>

      {/* Nav bar */}
      {!hits && (
        <div className="flex items-center gap-2 text-sm font-mono text-text-secondary">
          <button onClick={back} disabled={histIdx === 0} className="px-2 py-0.5 rounded border border-border-default disabled:opacity-40" title="Back">◀</button>
          <button onClick={forward} disabled={histIdx >= hist.length - 1} className="px-2 py-0.5 rounded border border-border-default disabled:opacity-40" title="Forward">▶</button>
          <button onClick={up} disabled={path === '/'} className="px-2 py-0.5 rounded border border-border-default disabled:opacity-40" title="Up one folder">▲ Up</button>
          <div className="flex items-center gap-1 flex-wrap overflow-hidden">
            <button onClick={() => goto('/')} className="hover:text-text-primary">{server}</button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                <span>/</span>
                <button onClick={() => goto('/' + crumbs.slice(0, i + 1).join('/'))} className="hover:text-text-primary">{c}</button>
              </span>
            ))}
          </div>
        </div>
      )}

      {err && <div className="text-sm text-red-500">{err}</div>}
      {loading && <div className="text-sm text-text-secondary">Loading…</div>}

      {/* Search results */}
      {hits && (
        <div className="border border-border-default rounded divide-y divide-border-default">
          <div className="px-3 py-2 text-xs font-mono text-text-secondary flex justify-between">
            <span>{hits.length} result{hits.length === 1 ? '' : 's'} for “{q}”{inFolder ? ' in this folder' : ''}</span>
            <button onClick={() => setHits(null)} className="hover:text-text-primary">✕ clear</button>
          </div>
          {hits.map((h) => (
            <div key={h.path} className="px-3 py-2 text-sm flex items-center gap-2">
              <button onClick={() => (h.isDir ? (setHits(null), goto(h.path)) : view(h.path))} className="flex items-center gap-2 flex-1 text-left min-w-0" title={h.path}>
                <span>{icon(h)}</span>
                <span className="text-text-primary truncate">{h.name}</span>
                <span className="text-text-secondary text-xs font-mono truncate hidden sm:inline">{h.path}</span>
              </button>
              {!h.isDir && <FileActions p={h.path} name={h.name} />}
            </div>
          ))}
          {hits.length === 0 && !loading && <div className="px-3 py-3 text-sm text-text-secondary">No matches.</div>}
        </div>
      )}

      {/* Folder listing */}
      {!hits && !loading && (
        <div className="border border-border-default rounded divide-y divide-border-default">
          {items.map((e) => (
            <div key={e.name} className="px-3 py-2 text-sm flex items-center gap-2">
              <button onClick={() => (e.isDir ? goto(joinPath(path, e.name)) : view(joinPath(path, e.name)))} className="flex items-center gap-2 flex-1 text-left min-w-0">
                <span>{icon(e)}</span>
                <span className="text-text-primary truncate">{e.name}</span>
                {!e.isDir && <span className="text-text-secondary text-xs">{fmtSize(e.size)}</span>}
              </button>
              {!e.isDir && <FileActions p={joinPath(path, e.name)} name={e.name} />}
            </div>
          ))}
          {items.length === 0 && <div className="px-3 py-3 text-sm text-text-secondary">Empty folder.</div>}
        </div>
      )}

      {/* Email dialog */}
      {emailFor && <EmailDialog file={emailFor} onCancel={() => setEmailFor(null)} onSend={sendEmail} />}
    </div>
  )
}

function EmailDialog({ file, onCancel, onSend }: { file: { name: string }; onCancel: () => void; onSend: (to: string, msg: string) => void | Promise<void> }) {
  const [to, setTo] = useState('')
  const [msg, setMsg] = useState('')
  const [sending, setSending] = useState(false)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div className="bg-surface-base border border-border-default rounded-lg p-4 w-full max-w-sm space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-medium text-text-primary">Email “{file.name}”</div>
        <input autoFocus value={to} onChange={(e) => setTo(e.target.value)} placeholder="Recipient email"
          className="w-full px-2 py-1.5 text-sm border border-border-default rounded bg-transparent text-text-primary" />
        <textarea value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Message (optional)" rows={3}
          className="w-full px-2 py-1.5 text-sm border border-border-default rounded bg-transparent text-text-primary" />
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1 text-sm text-text-secondary">Cancel</button>
          <button disabled={!to.trim() || sending} onClick={async () => { setSending(true); await onSend(to.trim(), msg); setSending(false) }}
            className="px-3 py-1 text-sm rounded bg-accent-ink text-white disabled:opacity-50">{sending ? 'Sending…' : 'Send'}</button>
        </div>
      </div>
    </div>
  )
}
