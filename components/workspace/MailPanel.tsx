'use client'

import { useCallback, useEffect, useState } from 'react'
import { Bot, Mail, Sparkles } from 'lucide-react'

import { APP_NAME_UPPER } from '@/lib/branding'

interface MailMsg {
  id: string
  threadId?: string | null
  from: string | null
  subject: string | null
  date: string | null
  snippet: string | null
  isUnread?: boolean
}
interface FullMsg {
  id: string
  from: string | null
  to: string | null
  subject: string | null
  date: string | null
  body: string
  bodyTruncatedToSnippet?: boolean
}
type Compose = { to: string; subject: string; body: string }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: 'include', ...init })
  const j = await r.json()
  if (!r.ok || j.error) throw new Error(j.error || 'Request failed')
  return j.data as T
}

function fromName(from: string | null): string {
  if (!from) return 'Unknown'
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</)
  return (m ? m[1] : from).trim()
}
function extractEmail(from: string | null): string {
  if (!from) return ''
  const m = from.match(/<([^>]+)>/)
  return (m ? m[1] : from).trim()
}
function replySubject(s: string | null): string {
  const sub = s || ''
  return /^re:/i.test(sub) ? sub : `Re: ${sub}`
}
function shortDate(d: string | null): string {
  if (!d) return ''
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return ''
  const now = new Date()
  return dt.toDateString() === now.toDateString()
    ? dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : dt.toLocaleDateString([], { day: '2-digit', month: 'short' })
}

export default function MailPanel() {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [messages, setMessages] = useState<MailMsg[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<FullMsg | null>(null)
  const [loadingMsg, setLoadingMsg] = useState(false)
  const [forgieOut, setForgieOut] = useState('')
  const [forgieBusy, setForgieBusy] = useState(false)
  const [compose, setCompose] = useState<Compose | null>(null)
  const [sending, setSending] = useState(false)
  const [scope, setScope] = useState<'work' | 'all'>('work')

  useEffect(() => {
    void (async () => {
      try {
        const s = await api<{ connected: boolean; email: string | null; features: { gmail: boolean } }>(
          '/api/auth/google/status',
        )
        setConnected(s.features?.gmail ?? false)
        setEmail(s.email)
      } catch {
        setConnected(false)
      }
    })()
  }, [])

  const loadInbox = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api<{ messages: MailMsg[] }>(`/api/google/gmail/list?scope=${scope}&limit=25`)
      setMessages(r.messages)
    } catch (e) {
      // Stale/revoked Google token → fall back to the connect prompt.
      if (/reconnect/i.test((e as Error).message)) setConnected(false)
      else console.error('[mail] inbox', e)
    } finally {
      setLoading(false)
    }
  }, [scope])

  useEffect(() => {
    if (connected) void loadInbox()
  }, [connected, loadInbox])

  async function openMsg(id: string) {
    setLoadingMsg(true)
    setSelected(null)
    setForgieOut('')
    try {
      setSelected(await api<FullMsg>(`/api/google/gmail/message?id=${id}`))
    } catch (e) {
      console.error('[mail] open', e)
    } finally {
      setLoadingMsg(false)
    }
  }

  async function runForgie(mode: 'summarize' | 'reply') {
    if (!selected) return
    setForgieBusy(true)
    setForgieOut('')
    try {
      const r = await api<{ text: string }>('/api/google/gmail/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: selected.id, mode }),
      })
      if (mode === 'reply') {
        setCompose({ to: extractEmail(selected.from), subject: replySubject(selected.subject), body: r.text })
      } else {
        setForgieOut(r.text)
      }
    } catch (e) {
      setForgieOut('Forgie failed: ' + (e as Error).message)
    } finally {
      setForgieBusy(false)
    }
  }

  async function send() {
    if (!compose) return
    setSending(true)
    try {
      await api('/api/google/gmail/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(compose),
      })
      setCompose(null)
    } catch (e) {
      alert('Send failed: ' + (e as Error).message)
    } finally {
      setSending(false)
    }
  }

  if (connected === null) return <div className="p-8 font-mono text-sm text-text-secondary">Loading…</div>
  if (!connected) {
    return (
      <div className="p-10 text-center border border-border-default rounded-xl">
        <Mail className="h-7 w-7 mx-auto mb-2 text-text-secondary" aria-hidden="true" />
        <p className="text-lg font-medium text-text-primary mb-1">Connect Gmail</p>
        <p className="text-sm text-text-secondary mb-5">Read and send mail without leaving {APP_NAME_UPPER}.</p>
        <a href="/api/auth/google/connect" className="inline-block h-9 leading-9 px-4 rounded-full bg-[#3F7A0A] text-white font-mono text-xs hover:bg-[#356a08]">
          Connect Google
        </a>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-9rem)] border border-border-default rounded-xl overflow-hidden">
      {/* Inbox list */}
      <div className={`w-full sm:w-80 shrink-0 sm:border-r border-border-default flex-col bg-surface-raised/40 ${selected ? 'hidden sm:flex' : 'flex'}`}>
        <div className="h-12 px-3 flex items-center justify-between gap-2 border-b border-border-default">
          <div className="flex items-center gap-0.5 bg-text-primary//[0.04] rounded-full p-0.5">
            <button type="button" onClick={() => setScope('work')} title="Team & company mail only" className={`px-2.5 py-1 rounded-full text-[11px] font-mono ${scope === 'work' ? 'bg-[#3F7A0A] text-white' : 'text-text-secondary'}`}>Work</button>
            <button type="button" onClick={() => setScope('all')} title="Everything in your inbox" className={`px-2.5 py-1 rounded-full text-[11px] font-mono ${scope === 'all' ? 'bg-[#3F7A0A] text-white' : 'text-text-secondary'}`}>All</button>
          </div>
          <div className="flex gap-3 items-center">
            <button type="button" onClick={() => setCompose({ to: '', subject: '', body: '' })} className="text-accent-ink text-sm" title="Compose">✎</button>
            <button type="button" onClick={() => void loadInbox()} className="text-text-secondary text-sm" title="Refresh">⟳</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p className="p-4 text-xs text-text-secondary">Loading…</p>
          ) : messages.length === 0 ? (
            <p className="p-4 text-xs text-text-secondary">
              {scope === 'work' ? 'No team/company mail here. Tap “All” to see everything.' : 'No mail in your inbox.'}
            </p>
          ) : (
            messages.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => void openMsg(m.id)}
                className={`w-full text-left px-3 py-2.5 border-b border-border-subtle hover:bg-text-primary//[0.03] ${selected?.id === m.id ? 'bg-[#3F7A0A]/10' : ''}`}
              >
                <div className="flex justify-between gap-2">
                  <span className={`text-sm truncate text-text-primary ${m.isUnread ? 'font-semibold' : ''}`}>{fromName(m.from)}</span>
                  <span className="text-[10px] text-text-secondary shrink-0">{shortDate(m.date)}</span>
                </div>
                <p className={`text-xs truncate ${m.isUnread ? 'font-medium text-text-primary' : 'text-text-secondary'}`}>{m.subject || '(no subject)'}</p>
                <p className="text-[11px] text-text-muted truncate">{m.snippet}</p>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Reading pane */}
      <div className={`flex-1 min-w-0 flex-col ${selected ? 'flex' : 'hidden sm:flex'}`}>
        {loadingMsg ? (
          <div className="p-8 text-sm text-text-secondary">Loading message…</div>
        ) : !selected ? (
          <div className="flex-1 flex items-center justify-center text-text-secondary text-sm">Select a message to read</div>
        ) : (
          <>
            <div className="px-5 py-4 border-b border-border-default">
              <button type="button" onClick={() => setSelected(null)} className="sm:hidden text-text-secondary text-sm mb-2">‹ Inbox</button>
              <p className="text-lg font-medium text-text-primary">{selected.subject || '(no subject)'}</p>
              <p className="text-xs text-text-secondary mt-1 break-all">{selected.from} · {shortDate(selected.date)}</p>
              <div className="flex flex-wrap gap-2 mt-3">
                <button type="button" onClick={() => setCompose({ to: extractEmail(selected.from), subject: replySubject(selected.subject), body: '' })} className="h-8 px-3 rounded-full bg-[#3F7A0A] text-white text-xs font-mono">↩ Reply</button>
                <button type="button" onClick={() => void runForgie('summarize')} disabled={forgieBusy} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-border-default text-xs font-mono text-text-primary disabled:opacity-40"><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />Summarize</button>
                <button type="button" onClick={() => void runForgie('reply')} disabled={forgieBusy} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-border-default text-xs font-mono text-text-primary disabled:opacity-40"><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />Draft reply</button>
              </div>
              {forgieBusy && <p className="text-xs text-accent-ink mt-2">Forgie is thinking…</p>}
              {forgieOut && <div className="mt-2 p-2.5 rounded-lg bg-bubble-mine text-bubble-mine-ink text-sm whitespace-pre-wrap"><Bot className="inline h-4 w-4 mr-1.5 -mt-0.5 align-middle" aria-hidden="true" />{forgieOut}</div>}
            </div>
            <div className="flex-1 overflow-y-auto p-5 text-sm text-text-primary whitespace-pre-wrap break-words">
              {selected.bodyTruncatedToSnippet && (
                <p className="mb-3 text-[11px] text-text-muted not-italic">
                  Preview only — open in Gmail to read the full email.
                </p>
              )}
              {selected.body}
            </div>
          </>
        )}
      </div>

      {/* Compose / reply modal */}
      {compose && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setCompose(null)}>
          <div className="w-full max-w-[560px] bg-surface-raised rounded-2xl shadow-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-border-default flex justify-between items-center">
              <span className="font-mono text-xs uppercase tracking-widest text-text-secondary">New message</span>
              <button type="button" onClick={() => setCompose(null)} className="text-text-secondary hover:text-text-primary">✕</button>
            </div>
            <div className="p-4 space-y-2">
              <input value={compose.to} onChange={(e) => setCompose({ ...compose, to: e.target.value })} placeholder="To" className="w-full h-9 px-3 rounded-lg border border-border-default bg-surface-raised text-sm outline-none focus:border-accent-ink" />
              <input value={compose.subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} placeholder="Subject" className="w-full h-9 px-3 rounded-lg border border-border-default bg-surface-raised text-sm outline-none focus:border-accent-ink" />
              <textarea value={compose.body} onChange={(e) => setCompose({ ...compose, body: e.target.value })} rows={10} placeholder="Write your message…" className="w-full p-3 rounded-lg border border-border-default bg-surface-raised text-sm outline-none focus:border-accent-ink resize-none" />
            </div>
            <div className="p-4 border-t border-border-default flex justify-between items-center">
              <span className="text-[11px] text-text-secondary truncate">{email ? `From ${email}` : ''}</span>
              <button type="button" onClick={() => void send()} disabled={sending || !compose.to.trim() || !compose.body.trim()} className="h-9 px-4 rounded-full bg-[#3F7A0A] text-white font-mono text-xs disabled:opacity-40">
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
