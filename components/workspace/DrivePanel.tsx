'use client'

import { useCallback, useEffect, useState } from 'react'
import { FileSpreadsheet, FileText, FileType2, Film, Folder, Image, Music, Package, Presentation, type LucideIcon } from 'lucide-react'

interface DriveFile {
  id: string
  name: string | null
  mimeType: string | null
  size: number | null
  modifiedTime: string | null
  url: string | null
  owners: string[]
  isFolder: boolean
}

async function api<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'include' })
  const j = await r.json()
  if (!r.ok || j.error) throw new Error(j.error || 'Request failed')
  return j.data as T
}

function icon(f: DriveFile): LucideIcon {
  if (f.isFolder) return Folder
  const m = f.mimeType || ''
  if (m.includes('document')) return FileText
  if (m.includes('spreadsheet')) return FileSpreadsheet
  if (m.includes('presentation')) return Presentation
  if (m.includes('pdf')) return FileType2
  if (m.startsWith('image/')) return Image
  if (m.startsWith('video/')) return Film
  if (m.startsWith('audio/')) return Music
  return Package
}
function fmtSize(n: number | null): string {
  if (!n) return ''
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}
function fmtDate(d: string | null): string {
  if (!d) return ''
  const dt = new Date(d); if (isNaN(dt.getTime())) return ''
  return dt.toLocaleDateString([], { day: '2-digit', month: 'short', year: '2-digit' })
}

export default function DrivePanel() {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [files, setFiles] = useState<DriveFile[]>([])
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const s = await api<{ features: { drive: boolean } }>('/api/auth/google/status')
        setConnected(s.features?.drive ?? false)
      } catch {
        setConnected(false)
      }
    })()
  }, [])

  const load = useCallback(async (query: string) => {
    setLoading(true)
    try {
      const r = await api<{ files: DriveFile[] }>(`/api/google/drive/list?limit=30${query ? `&q=${encodeURIComponent(query)}` : ''}`)
      setFiles(r.files)
    } catch (e) {
      if (/reconnect/i.test((e as Error).message)) setConnected(false)
      else console.error('[drive]', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (connected) void load('')
  }, [connected, load])

  // Debounced search
  useEffect(() => {
    if (!connected) return
    const t = setTimeout(() => void load(q.trim()), q.trim() ? 400 : 0)
    return () => clearTimeout(t)
  }, [q, connected, load])

  if (connected === null) return <div className="p-8 font-mono text-sm text-text-secondary">Loading…</div>
  if (!connected) {
    return (
      <div className="p-10 text-center border border-border-default rounded-xl">
        <Folder className="h-7 w-7 mx-auto mb-2 text-text-secondary" aria-hidden="true" />
        <p className="text-lg font-medium text-text-primary mb-1">Connect Google Drive</p>
        <p className="text-sm text-text-secondary mb-5">Browse and search your Drive files without leaving the app.</p>
        <a href="/api/auth/google/connect" className="inline-block h-9 leading-9 px-4 rounded-full bg-[#3F7A0A] text-white font-mono text-xs hover:bg-[#356a08]">
          Connect Google
        </a>
      </div>
    )
  }

  return (
    <div className="border border-border-default rounded-xl overflow-hidden flex flex-col h-[calc(100vh-9rem)]">
      <div className="h-12 px-3 flex items-center gap-2 border-b border-border-default shrink-0">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search Drive…"
          className="flex-1 h-9 px-3 rounded-lg border border-border-default bg-surface-raised text-sm outline-none focus:border-[#3F7A0A]"
        />
        <span className="font-mono text-[10px] uppercase tracking-widest text-text-secondary shrink-0">{q.trim() ? 'Results' : 'Recent'}</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <p className="p-4 text-xs text-text-secondary">Loading…</p>
        ) : files.length === 0 ? (
          <p className="p-4 text-xs text-text-secondary">{q.trim() ? 'No files match.' : 'No files.'}</p>
        ) : (
          files.map((f) => (
            <a
              key={f.id}
              href={f.url || '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-4 py-2.5 border-b border-black/[0.05] hover:bg-black/[0.03]"
            >
              {(() => { const Icon = icon(f); return <Icon className="h-5 w-5 shrink-0 text-text-secondary" aria-hidden="true" /> })()}
              <div className="min-w-0 flex-1">
                <p className="text-sm text-text-primary truncate">{f.name || 'Untitled'}</p>
                <p className="text-[11px] text-text-secondary truncate">
                  {f.owners[0] ? `${f.owners[0]} · ` : ''}{fmtDate(f.modifiedTime)}{f.size ? ` · ${fmtSize(f.size)}` : ''}
                </p>
              </div>
              <span className="text-xs font-mono text-text-secondary shrink-0">↗</span>
            </a>
          ))
        )}
      </div>
    </div>
  )
}
