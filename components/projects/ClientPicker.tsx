'use client'

import { useEffect, useRef, useState } from 'react'

import type { ApiResponse, ClientSummary } from '@/lib/types'

interface GoogleContact {
  name?: string
  email?: string
  phone?: string
  resourceName?: string
}

interface ClientPickerProps {
  value: ClientSummary | null
  onChange: (client: ClientSummary | null) => void
  /** Set false to render read-only (non-admins can see the client but not change it). */
  canEdit?: boolean
}

/**
 * Searchable client combobox with two ways to add one:
 *   1. type a name that doesn't exist yet → "Create <name>"
 *   2. pull a name off Google Contacts (only when the user has connected Google
 *      with the contacts scope — otherwise that half stays hidden entirely)
 *
 * Contacts is deliberately an ASSIST, not the primary path: /api/google/contacts
 * /list 403s for anyone who hasn't connected Google, which is most users. Manual
 * entry always works.
 */
export default function ClientPicker({ value, onChange, canEdit = true }: ClientPickerProps) {
  const [search, setSearch] = useState('')
  const [clients, setClients] = useState<ClientSummary[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Google Contacts assist — null until probed, [] when unavailable.
  const [contacts, setContacts] = useState<GoogleContact[] | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Load the client list once on mount.
  useEffect(() => {
    let alive = true
    setLoading(true)
    fetch('/api/clients?limit=100', { credentials: 'include' })
      .then((r) => r.json())
      .then((j: ApiResponse<{ items: ClientSummary[] }>) => {
        if (alive && j.data) setClients(j.data.items)
      })
      .catch(() => { /* list stays empty; create-inline still works */ })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  // Probe Google Contacts once. A 403 (not connected) is the common case and is
  // not an error worth surfacing — we just don't show the section.
  useEffect(() => {
    let alive = true
    fetch('/api/google/contacts/list?limit=50', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: ApiResponse<{ contacts: GoogleContact[] }> | null) => {
        if (alive) setContacts(j?.data?.contacts ?? [])
      })
      .catch(() => { if (alive) setContacts([]) })
    return () => { alive = false }
  }, [])

  const term = search.trim().toLowerCase()
  const matches = term ? clients.filter((c) => c.name.toLowerCase().includes(term)) : clients
  const exactExists = clients.some((c) => c.name.toLowerCase() === term)
  const contactMatches =
    term && contacts?.length
      ? contacts
          .filter((c) => (c.name ?? '').toLowerCase().includes(term))
          .filter((c) => !clients.some((cl) => cl.name.toLowerCase() === (c.name ?? '').toLowerCase()))
          .slice(0, 4)
      : []

  async function createClient(name: string, contact?: GoogleContact) {
    const clean = name.trim()
    if (!clean || creating) return
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: clean,
          contactEmail: contact?.email,
          contactPhone: contact?.phone,
          googleContactId: contact?.resourceName,
        }),
      })
      const json = (await res.json()) as ApiResponse<{ client: ClientSummary }>
      if (!res.ok || !json.data) {
        setError(json.error ?? 'Could not create client')
        return
      }
      const created = json.data.client
      // POST returns the existing row on a duplicate name, so de-dupe on id.
      setClients((prev) => (prev.some((c) => c.id === created.id) ? prev : [...prev, created]))
      onChange(created)
      setSearch('')
      setOpen(false)
    } catch {
      setError('Network error — please try again')
    } finally {
      setCreating(false)
    }
  }

  function select(client: ClientSummary) {
    onChange(client)
    setSearch('')
    setOpen(false)
  }

  // ── Selected state ──────────────────────────────────────────────────────────
  if (value) {
    return (
      <div className="flex items-center gap-2 bg-background-primary border border-border-default px-4 py-3">
        <span className="font-mono text-sm text-primary flex-1 truncate">{value.name}</span>
        {canEdit && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="font-mono text-[10px] text-muted hover:text-primary shrink-0"
            aria-label="Clear client"
          >
            ✕
          </button>
        )}
      </div>
    )
  }

  if (!canEdit) {
    return <p className="font-mono text-xs text-muted">No client</p>
  }

  // ── Picker ──────────────────────────────────────────────────────────────────
  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={search}
        onChange={(e) => { setSearch(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={loading ? 'Loading clients...' : 'Search or add a client...'}
        disabled={loading}
        className="w-full bg-background-primary border border-border-default px-4 py-3 font-mono text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none transition-colors duration-150 disabled:opacity-50"
      />

      {open && (matches.length > 0 || term.length > 0) && (
        <div className="absolute top-full left-0 right-0 z-20 bg-background-secondary border border-border-default border-t-0 max-h-56 overflow-y-auto">
          {matches.slice(0, 8).map((c) => (
            <button
              key={c.id}
              type="button"
              onMouseDown={() => select(c)}
              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-background-tertiary transition-colors duration-150 text-left"
            >
              <span className="font-mono text-xs text-primary flex-1 truncate">{c.name}</span>
              {c.projectCount > 0 && (
                <span className="font-mono text-[10px] text-muted shrink-0">
                  {c.projectCount} {c.projectCount === 1 ? 'project' : 'projects'}
                </span>
              )}
            </button>
          ))}

          {contactMatches.length > 0 && (
            <>
              <p className="px-4 py-1.5 font-mono text-[10px] text-muted uppercase tracking-widest border-t border-border-default">
                From Google Contacts
              </p>
              {contactMatches.map((c, i) => (
                <button
                  key={c.resourceName ?? i}
                  type="button"
                  onMouseDown={() => void createClient(c.name ?? '', c)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-background-tertiary transition-colors duration-150 text-left"
                >
                  <span className="font-mono text-xs text-primary flex-1 truncate">{c.name}</span>
                  {c.email && (
                    <span className="font-mono text-[10px] text-muted shrink-0 truncate max-w-[45%]">{c.email}</span>
                  )}
                </button>
              ))}
            </>
          )}

          {term.length > 0 && !exactExists && (
            <button
              type="button"
              onMouseDown={() => void createClient(search)}
              disabled={creating}
              className="w-full px-4 py-2.5 text-left border-t border-border-default hover:bg-background-tertiary transition-colors duration-150 disabled:opacity-50"
            >
              <span className="font-mono text-xs text-accent-ink">
                {creating ? 'Creating...' : `+ Create "${search.trim()}"`}
              </span>
            </button>
          )}

          {matches.length === 0 && contactMatches.length === 0 && term.length === 0 && (
            <p className="px-4 py-3 font-mono text-xs text-muted">No clients yet</p>
          )}
        </div>
      )}

      {error && <p className="font-mono text-[10px] text-status-danger mt-1">{error}</p>}
    </div>
  )
}
