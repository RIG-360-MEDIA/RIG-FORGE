'use client'

import { useEffect, useState } from 'react'
import { Bot, Sparkles, Video } from 'lucide-react'

import { useAuthStore } from '@/store/authStore'
import { useBranding } from '@/lib/use-branding'
import JitsiCall from './JitsiCall'

export default function MeetPanel() {
  const user = useAuthStore((s) => s.user)
  const { appNameUpper } = useBranding()
  const displayName = user?.name ?? 'Guest'
  const email = user?.email ?? null
  const avatarUrl = user?.avatarUrl ?? null

  const [activeRoom, setActiveRoom] = useState<string | null>(null)
  const [topic, setTopic] = useState('')
  const [copied, setCopied] = useState(false)
  const [sched, setSched] = useState('')
  const [scheduling, setScheduling] = useState(false)
  const [scheduled, setScheduled] = useState<{ title: string; meetLink: string | null; eventUrl: string | null; start: string | null } | null>(null)
  const [schedErr, setSchedErr] = useState('')

  async function scheduleMeeting() {
    if (!sched.trim()) return
    setScheduling(true); setScheduled(null); setSchedErr('')
    try {
      const r = await fetch('/api/google/meet/schedule', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request: sched.trim() }) })
      const j = await r.json()
      if (!r.ok || j.error) { setSchedErr(j.error || 'Failed to schedule'); return }
      setScheduled(j.data); setSched('')
    } catch (e) {
      setSchedErr((e as Error).message)
    } finally {
      setScheduling(false)
    }
  }

  // Join straight into a call when arriving via an RF invite link (?call=<room>).
  useEffect(() => {
    const room = new URLSearchParams(window.location.search).get('call')
    if (room) setActiveRoom(room)
  }, [])

  function startCall() {
    const slug = topic.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 24)
    const rand = Math.random().toString(36).slice(2, 8)
    setActiveRoom(`forge-${slug ? slug + '-' : ''}${rand}`)
  }

  function leave() {
    setActiveRoom(null)
    const url = new URL(window.location.href)
    url.searchParams.delete('call')
    window.history.replaceState({}, '', url.toString())
  }

  function copyInvite() {
    if (!activeRoom) return
    // RF-only link — opens RIG FORGE and joins the same in-app call.
    const link = `${window.location.origin}/dashboard/workspace?call=${activeRoom}`
    void navigator.clipboard?.writeText(link)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // ── Active call: runs embedded right here in RF ─────────────────────────────
  if (activeRoom) {
    return (
      <div className="border border-border-default rounded-xl overflow-hidden flex flex-col h-[calc(100vh-9rem)]">
        <div className="h-12 px-4 flex items-center justify-between gap-2 border-b border-border-default shrink-0">
          <span className="flex items-center gap-1.5 min-w-0 font-mono text-xs uppercase tracking-widest text-text-secondary"><Video className="h-4 w-4 shrink-0" aria-hidden="true" /><span className="truncate">{activeRoom}</span></span>
          <div className="flex gap-2 shrink-0">
            <button type="button" onClick={copyInvite} className="h-8 px-3 rounded-full border border-border-default text-xs font-mono text-text-primary">
              {copied ? 'Copied!' : 'Copy invite'}
            </button>
            <button type="button" onClick={leave} className="h-8 px-3 rounded-full bg-status-danger text-white text-xs font-mono">Leave</button>
          </div>
        </div>
        <div className="flex-1 min-h-0 bg-black">
          <JitsiCall room={activeRoom} displayName={displayName} email={email} avatarUrl={avatarUrl} onLeave={leave} />
        </div>
      </div>
    )
  }

  // ── Lobby ──────────────────────────────────────────────────────────────────
  return (
    <div className="border border-border-default rounded-xl overflow-hidden">
      <div className="p-6">
        <p className="text-sm font-medium text-text-primary mb-1">Start a video call</p>
        <p className="text-xs text-text-secondary mb-4">Runs entirely inside {appNameUpper} — share the invite link to bring teammates into the same call.</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Topic (optional)"
            className="h-10 px-3 rounded-lg border border-border-default bg-surface-raised text-sm outline-none focus:border-accent-ink w-56"
          />
          <button type="button" onClick={startCall} className="inline-flex items-center gap-1.5 h-10 px-5 rounded-full bg-[#3F7A0A] text-white font-mono text-xs hover:bg-[#356a08]">
            <Video className="h-4 w-4" aria-hidden="true" />
            Start call
          </button>
        </div>
      </div>

      {/* Schedule with Forgie */}
      <div className="p-6 border-t border-border-default">
        <p className="flex items-center gap-1.5 text-sm font-medium text-text-primary mb-1"><Sparkles className="h-4 w-4" aria-hidden="true" />Schedule with Forgie</p>
        <p className="text-xs text-text-secondary mb-4">Describe it in plain English — Forgie creates a calendar event with a Meet link.</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={sched}
            onChange={(e) => setSched(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void scheduleMeeting() }}
            placeholder="e.g. sync with Pranav tomorrow 3pm for 30 min"
            className="flex-1 min-w-[240px] h-10 px-3 rounded-lg border border-border-default bg-surface-raised text-sm outline-none focus:border-accent-ink"
          />
          <button type="button" onClick={() => void scheduleMeeting()} disabled={scheduling || !sched.trim()} className="h-10 px-5 rounded-full border border-border-default text-text-primary font-mono text-xs disabled:opacity-40">
            {scheduling ? 'Scheduling…' : 'Schedule'}
          </button>
        </div>
        {schedErr && <p className="text-xs text-status-danger mt-2">{schedErr}</p>}
        {scheduled && (
          <div className="mt-3 p-3 rounded-lg bg-[#EDE7FB] text-[#2A1A4A] text-sm">
            <Bot className="inline h-4 w-4 mr-1.5 -mt-0.5 align-middle" aria-hidden="true" />Scheduled <span className="font-medium">{scheduled.title}</span>
            {scheduled.start ? ` · ${new Date(scheduled.start).toLocaleString([], { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
            {scheduled.meetLink && <> · <a href={scheduled.meetLink} target="_blank" rel="noopener noreferrer" className="underline">Join call</a></>}
            {scheduled.eventUrl && <> · <a href={scheduled.eventUrl} target="_blank" rel="noopener noreferrer" className="underline">Calendar</a></>}
          </div>
        )}
      </div>
    </div>
  )
}
