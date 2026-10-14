'use client'

import { useRef, useState } from 'react'
import { Globe, Lock } from 'lucide-react'

import Avatar from '@/components/ui/Avatar'
import { useAuthStore } from '@/store/authStore'

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_CHARS = 2000

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SendOpts {
  visibility?: 'TEAM' | 'LEAD_ADMIN'
  fileUrl?: string
  fileName?: string
  fileType?: string
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface MessageInputProps {
  onSend:                (content: string, opts?: SendOpts) => Promise<void>
  disabled?:             boolean
  /** When true shows TEAM / Lead & Admins visibility segmented control */
  showVisibilityToggle?: boolean
  /** When true shows the link attachment row */
  showLinkAttachment?:   boolean
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MessageInput({
  onSend,
  disabled,
  showVisibilityToggle,
  showLinkAttachment,
}: MessageInputProps) {
  const { user } = useAuthStore()

  const [content,    setContent]    = useState('')
  const [sending,    setSending]    = useState(false)
  const [inputErr,   setInputErr]   = useState<string | null>(null)
  const [visibility, setVisibility] = useState<'TEAM' | 'LEAD_ADMIN'>('TEAM')
  const [linkUrl,    setLinkUrl]    = useState('')
  const [linkLabel,  setLinkLabel]  = useState('')

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  function adjustHeight() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setContent(e.target.value)
    setInputErr(null)
    adjustHeight()
  }

  async function handleSubmit() {
    const trimmed = content.trim()
    if (!trimmed) return
    if (trimmed.length > MAX_CHARS) {
      setInputErr(`Message exceeds ${MAX_CHARS} characters`)
      return
    }
    const opts: SendOpts = {}
    if (showVisibilityToggle) opts.visibility = visibility
    if (showLinkAttachment && linkUrl.trim()) {
      opts.fileUrl  = linkUrl.trim()
      opts.fileName = linkLabel.trim() || linkUrl.trim()
      opts.fileType = 'link'
    }
    setSending(true)
    setContent('')
    setLinkUrl('')
    setLinkLabel('')
    if (textareaRef.current) textareaRef.current.style.height = '36px'
    try {
      await onSend(trimmed, opts)
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit()
    }
    if (e.key === 'Escape') textareaRef.current?.blur()
  }

  const showCharCount  = content.length > 1500
  const charCountClass =
    content.length > 1950
      ? 'text-status-danger'
      : content.length > 1800
      ? 'text-status-warning'
      : 'text-muted'

  const isDisabled = disabled || sending

  return (
    <div className="flex gap-3 items-end">
      {/* Current user avatar */}
      <div className="shrink-0 mb-1">
        <Avatar name={user?.name ?? '?'} avatarUrl={user?.avatarUrl ?? null} size="sm" />
      </div>

      <div className="flex-1 min-w-0 space-y-2">
        {/* Visibility toggle */}
        {showVisibilityToggle && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setVisibility('TEAM')}
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
        )}

        {/* Link attachment row */}
        {showLinkAttachment && (
          <div className="flex gap-2">
            <input
              type="text"
              value={linkLabel}
              onChange={(e) => setLinkLabel(e.target.value)}
              placeholder="Label (optional)"
              disabled={isDisabled}
              className="w-28 shrink-0 bg-background-primary border border-border-default px-2 py-1 font-mono text-[10px] text-primary placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-50"
            />
            <input
              type="url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://... (optional link)"
              disabled={isDisabled}
              className="flex-1 min-w-0 bg-background-primary border border-border-default px-2 py-1 font-mono text-[10px] text-primary placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-50"
            />
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={isDisabled}
          placeholder="Write a message... (Enter to send, Shift+Enter for new line)"
          rows={1}
          style={{ minHeight: '36px', maxHeight: '96px' }}
          className="bg-background-primary border border-border-default focus:border-accent focus:outline-none font-mono text-xs text-primary placeholder:text-muted placeholder:font-mono placeholder:text-[10px] p-3 w-full resize-none disabled:opacity-50"
        />

        {inputErr && (
          <p className="font-mono text-[10px] text-status-danger mt-1">{inputErr}</p>
        )}

        <div className="flex items-center justify-end gap-3 mt-1">
          {showCharCount && (
            <span className={`font-mono text-[10px] ${charCountClass}`}>
              {content.length} / {MAX_CHARS}
            </span>
          )}
          {content.length > 0 && (
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={isDisabled}
              className="font-mono text-[10px] text-accent-ink hover:underline disabled:opacity-50"
            >
              ▸ SEND
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
