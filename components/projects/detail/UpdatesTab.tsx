'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Globe, Link, Lock } from 'lucide-react'
import type { MessageResponse, ApiResponse } from '@/lib/types'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UpdatesTabProps {
  projectId: string
  currentUser: {
    id: string
    name: string
    role: string
  }
  isLead: boolean
  isAdmin?: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}

function formatTime(date: Date | string): string {
  return new Date(date).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

/** Replace bare URLs with clickable links */
function linkify(text: string): React.ReactNode[] {
  const urlRegex = /https?:\/\/\S+/g
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index))
    const url = match[0]
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent-ink underline underline-offset-2 hover:text-accent-ink/80 break-all"
      >
        {url}
      </a>,
    )
    lastIndex = match.index + url.length
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return parts
}

// ─── MessageBubble ────────────────────────────────────────────────────────────

interface MessageBubbleProps {
  message: MessageResponse
  isOwn: boolean
  isAuthorLead: boolean
}

function MessageBubble({ message, isOwn, isAuthorLead }: MessageBubbleProps) {
  const initials  = getInitials(message.authorName)
  const isPrivate = message.visibility === 'LEAD_ADMIN'

  return (
    <div className={`flex gap-3 ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      <div className="shrink-0">
        {message.authorAvatar ? (
          <img src={message.authorAvatar} alt={message.authorName} className="w-8 h-8 rounded-full object-cover" />
        ) : (
          <span className="w-8 h-8 rounded-full bg-accent/20 text-accent-ink flex items-center justify-center text-xs font-bold select-none">
            {initials}
          </span>
        )}
      </div>

      {/* Content column */}
      <div className={`max-w-[70%] space-y-1 flex flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
        {/* Author meta row */}
        <div className={`flex items-center gap-1.5 text-xs flex-wrap ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
          <span className="font-medium text-foreground">{message.authorName}</span>
          {(message.authorRole ?? '') === 'ADMIN' && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-900/40 text-amber-400">Admin</span>
          )}
          {isAuthorLead && (message.authorRole ?? '') !== 'ADMIN' && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-900/40 text-blue-400">Lead</span>
          )}
          {isPrivate && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-900/40 text-amber-400" title="Visible to Lead & Admins only">
              <Lock className="h-3 w-3" aria-hidden="true" />
              private
            </span>
          )}
          <span className="text-muted">{formatTime(message.createdAt)}</span>
          {message.edited && <span className="text-muted italic">(edited)</span>}
        </div>

        {/* Text bubble */}
        <div
          className={[
            'rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words',
            isPrivate
              ? isOwn
                ? 'bg-amber-950/60 text-amber-100 rounded-tr-none border border-amber-700/40'
                : 'bg-amber-950/40 text-amber-50 rounded-tl-none border border-amber-700/40'
              : isOwn
                ? 'bg-blue-950 text-blue-100 rounded-tr-none'
                : 'bg-gray-800 text-foreground rounded-tl-none',
          ].join(' ')}
        >
          {linkify(message.content)}
        </div>

        {/* Link chip */}
        {message.fileUrl && (
          <a
            href={message.fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 mt-1 font-mono text-[10px] text-accent-ink border border-accent/40 px-2 py-1 hover:bg-accent/10 transition-colors rounded"
          >
            <Link className="h-3 w-3 shrink-0" aria-hidden="true" />
            {message.fileName ?? message.fileUrl}
          </a>
        )}
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function UpdatesTab({ projectId, currentUser, isLead, isAdmin = false }: UpdatesTabProps) {
  const [messages, setMessages] = useState<MessageResponse[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [draft, setDraft]       = useState('')
  const [sending, setSending]   = useState(false)

  // Visibility: everyone can toggle
  const [visibility, setVisibility] = useState<'TEAM' | 'LEAD_ADMIN'>('TEAM')

  // Link attachment
  const [linkUrl,   setLinkUrl]   = useState('')
  const [linkLabel, setLinkLabel] = useState('')

  const bottomRef   = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pollRef     = useRef<ReturnType<typeof setInterval> | null>(null)

  function scrollToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const fetchMessages = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const res  = await fetch(`/api/threads/project/${projectId}?limit=100`, { credentials: 'include' })
      const json = await res.json() as ApiResponse<{ messages: MessageResponse[] }>
      if (!res.ok || json.error) {
        if (!silent) setError(json.error ?? 'Failed to load updates.')
        return
      }
      setMessages(json.data?.messages ?? [])
    } catch {
      if (!silent) setError('Network error loading updates.')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void fetchMessages(false)
    pollRef.current = setInterval(() => void fetchMessages(true), 15_000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [fetchMessages])

  useEffect(() => {
    if (!loading) scrollToBottom()
  }, [loading, messages.length])

  async function handleSend() {
    const content = draft.trim()
    if (!content || sending) return

    setSending(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { content, visibility }
      if (linkUrl.trim()) {
        body.fileUrl  = linkUrl.trim()
        body.fileName = linkLabel.trim() || linkUrl.trim()
        body.fileType = 'link'
      }

      const res  = await fetch(`/api/threads/project/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      })
      const json = await res.json() as ApiResponse<MessageResponse>
      if (!res.ok || json.error) {
        setError(json.error ?? 'Failed to send message.')
        return
      }
      if (json.data) setMessages((prev) => [...prev, json.data!])
      setDraft('')
      setLinkUrl('')
      setLinkLabel('')
      setTimeout(scrollToBottom, 50)
    } catch {
      setError('Network error. Message not sent.')
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  const hasLink = linkUrl.trim().length > 0

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full min-h-[500px]">

      {/* Error banner */}
      {error && (
        <div className="mx-4 mt-2 text-sm text-status-danger bg-status-danger/10 border border-status-danger/30 rounded px-3 py-2 shrink-0">
          {error}
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {loading && (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-surface-raised animate-pulse shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-24 bg-surface-raised rounded animate-pulse" />
                  <div className="h-10 w-64 bg-surface-raised rounded animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && messages.length === 0 && (
          <div className="flex items-center justify-center h-32 text-sm text-muted">
            No updates yet. Be the first to post!
          </div>
        )}

        {!loading && messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isOwn={msg.authorId === currentUser.id}
            isAuthorLead={isLead && msg.authorId === currentUser.id}
          />
        ))}

        <div ref={bottomRef} />
      </div>

      {/* ── Compose area ───────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-border-default px-4 py-3 space-y-2">

        {/* Row 1: Visibility toggle — available to ALL members */}
        <div className="flex items-center gap-1">
          <span className="font-mono text-[10px] text-muted tracking-widest mr-1">VISIBLE TO:</span>
          <button
            type="button"
            onClick={() => setVisibility('TEAM')}
            disabled={sending}
            className={`inline-flex items-center gap-1 font-mono text-[10px] tracking-widest px-2 py-1 border transition-colors ${
              visibility === 'TEAM'
                ? 'border-accent text-accent-ink bg-accent/10'
                : 'border-border-default text-muted hover:text-secondary'
            }`}
          >
            <Globe className="h-3 w-3" aria-hidden="true" />
            TEAM
          </button>
          <button
            type="button"
            onClick={() => setVisibility('LEAD_ADMIN')}
            disabled={sending}
            className={`inline-flex items-center gap-1 font-mono text-[10px] tracking-widest px-2 py-1 border transition-colors ${
              visibility === 'LEAD_ADMIN'
                ? 'border-amber-500 text-amber-400 bg-amber-500/10'
                : 'border-border-default text-muted hover:text-secondary'
            }`}
          >
            <Lock className="h-3 w-3" aria-hidden="true" />
            LEAD & ADMINS ONLY
          </button>
        </div>

        {/* Row 2: Optional link attachment */}
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted tracking-widest shrink-0"><Link className="h-3 w-3" aria-hidden="true" />LINK:</span>
          <input
            type="text"
            value={linkLabel}
            onChange={(e) => setLinkLabel(e.target.value)}
            placeholder="Label (optional)"
            disabled={sending}
            className="w-28 shrink-0 bg-surface-raised border border-border-default rounded px-2 py-1 text-xs focus:outline-none focus:border-accent disabled:opacity-50"
          />
          <input
            type="url"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://..."
            disabled={sending}
            className="flex-1 min-w-0 bg-surface-raised border border-border-default rounded px-2 py-1 text-xs focus:outline-none focus:border-accent disabled:opacity-50"
          />
          {hasLink && (
            <button
              type="button"
              onClick={() => { setLinkUrl(''); setLinkLabel('') }}
              className="text-muted hover:text-status-danger transition-colors shrink-0 text-xs"
              title="Clear link"
            >
              ✕
            </button>
          )}
        </div>

        {/* Row 3: Textarea + send */}
        <div className="flex gap-3 items-end">
          <textarea
            ref={textareaRef}
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
            placeholder={
              visibility === 'LEAD_ADMIN'
                ? 'Private message to lead & admins… (Enter to send)'
                : 'Write an update… (Enter to send, Shift+Enter for newline)'
            }
            className={`flex-1 border rounded px-3 py-2 text-sm focus:outline-none resize-none disabled:opacity-50 transition-colors ${
              visibility === 'LEAD_ADMIN'
                ? 'bg-amber-950/20 border-amber-700/50 focus:border-amber-500 text-amber-50 placeholder:text-amber-700'
                : 'bg-surface-raised border-border-default focus:border-accent'
            }`}
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sending || !draft.trim()}
            className="px-4 py-2 text-sm font-medium bg-accent text-white rounded hover:bg-accent/80 disabled:opacity-50 transition-colors self-end"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}
