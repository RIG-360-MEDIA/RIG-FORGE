'use client'

import { useCallback, useEffect, useState } from 'react'
import { Mail, Users } from 'lucide-react'

interface Contact {
  id: string
  name: string
  email: string | null
  emails: string[]
  phone: string | null
  phones: string[]
  org: string | null
  photo: string | null
}

async function api<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'include' })
  const j = await r.json()
  if (!r.ok || j.error) throw new Error(j.error || 'Request failed')
  return j.data as T
}

function initials(name: string): string {
  return name.split(' ').slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?'
}

export default function ContactsPanel() {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const s = await api<{ features: { contacts: boolean } }>('/api/auth/google/status')
        setConnected(s.features?.contacts ?? false)
      } catch {
        setConnected(false)
      }
    })()
  }, [])

  const load = useCallback(async (query: string) => {
    setLoading(true)
    try {
      const r = await api<{ contacts: Contact[] }>(`/api/google/contacts/list?limit=50${query ? `&q=${encodeURIComponent(query)}` : ''}`)
      setContacts(r.contacts)
    } catch (e) {
      if (/reconnect/i.test((e as Error).message)) setConnected(false)
      else console.error('[contacts]', e)
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
        <Users className="h-7 w-7 mx-auto mb-2 text-text-secondary" aria-hidden="true" />
        <p className="text-lg font-medium text-text-primary mb-1">Connect Google Contacts</p>
        <p className="text-sm text-text-secondary mb-5">Look up and search your Google contacts without leaving the app.</p>
        <a href="/api/auth/google/connect" className="inline-block h-9 leading-9 px-4 rounded-full bg-[#3F7A0A] text-white font-mono text-xs hover:bg-[#356a08]">
          Connect Google
        </a>
        <p className="text-[11px] text-text-secondary mt-4">You&apos;ll be asked to grant read-only Contacts access.</p>
      </div>
    )
  }

  return (
    <div className="border border-border-default rounded-xl overflow-hidden flex flex-col h-[calc(100vh-9rem)]">
      <div className="h-12 px-3 flex items-center gap-2 border-b border-border-default shrink-0">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search contacts…"
          className="flex-1 h-9 px-3 rounded-lg border border-border-default bg-surface-raised text-sm outline-none focus:border-[#3F7A0A]"
        />
        <span className="font-mono text-[10px] uppercase tracking-widest text-text-secondary shrink-0">{q.trim() ? 'Results' : 'All'}</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <p className="p-4 text-xs text-text-secondary">Loading…</p>
        ) : contacts.length === 0 ? (
          <p className="p-4 text-xs text-text-secondary">{q.trim() ? 'No contacts match.' : 'No contacts.'}</p>
        ) : (
          contacts.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-black/[0.05]">
              {c.photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.photo} alt={c.name} className="w-8 h-8 rounded-full object-cover shrink-0" />
              ) : (
                <span className="w-8 h-8 rounded-full bg-accent/20 text-accent-ink flex items-center justify-center text-xs font-bold shrink-0">{initials(c.name)}</span>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm text-text-primary truncate">{c.name}{c.org ? <span className="text-text-secondary"> · {c.org}</span> : null}</p>
                <p className="text-[11px] text-text-secondary truncate">
                  {c.email || ''}{c.email && c.phone ? ' · ' : ''}{c.phone || ''}
                  {!c.email && !c.phone ? 'No email or phone' : ''}
                </p>
              </div>
              {c.email && (
                <a href={`mailto:${c.email}`} className="text-text-secondary shrink-0 hover:text-accent-ink" title="Email" aria-label={`Email ${c.email}`}><Mail className="h-4 w-4" aria-hidden="true" /></a>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
