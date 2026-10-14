'use client'

import { useEffect, useRef, useState } from 'react'
import { Link, Lock } from 'lucide-react'

import Avatar from '@/components/ui/Avatar'
import type { LocalMessage } from '@/components/thread/types'

// ─── Timestamp ───────────────────────────────────────────────────────────────

function formatTimestamp(date: Date): string {
  const d   = new Date(date as unknown as string)
  const now = new Date()
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth()    === now.getMonth()    &&
    d.getDate()     === now.getDate()

  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (isToday) return time
  return (
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + time
  )
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface MessageRowProps {
  message:       LocalMessage
  currentUserId: string
  isAdmin:       boolean
  onEdit:        (id: string, content: string) => Promise<void>
  onDelete:      (id: string) => Promise<void>
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function MessageRow({
  message,
  currentUserId,
  isAdmin,
  onEdit,
  onDelete,
}: MessageRowProps) {
  const isOwn    = message.authorId === currentUserId
  const canEdit  = isOwn && !message.optimistic
  const canDelete = (isOwn || isAdmin) && !message.optimistic
  const showActions = canEdit || canDelete

  const [editing,       setEditing]       = useState(false)
  const [editContent,   setEditContent]   = useState(message.content)
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editAreaRef    = useRef<HTMLTextAreaElement>(null)

  // Sync edit content when message changes externally
  useEffect(() => {
    if (!editing) setEditContent(message.content)
  }, [message.content, editing])

  // Auto-grow edit textarea
  useEffect(() => {
    const el = editAreaRef.current
    if (!el || !editing) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`
  }, [editing, editContent])

  // Focus + move cursor to end when entering edit mode
  useEffect(() => {
    if (editing && editAreaRef.current) {
      const el = editAreaRef.current
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [editing])

  // Escape cancels edit
  useEffect(() => {
    if (!editing) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') cancelEdit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing])

  // Cleanup delete timer on unmount
  useEffect(() => {
    return () => {
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    }
  }, [])

  function cancelEdit() {
    setEditing(false)
    setEditContent(message.content)
  }

  async function submitEdit() {
    const trimmed = editContent.trim()
    if (!trimmed || trimmed === message.content) {
      cancelEdit()
      return
    }
    setEditing(false)
    await onEdit(message.id, trimmed)
  }

  function handleDeleteClick() {
    if (!deleteConfirm) {
      setDeleteConfirm(true)
      deleteTimerRef.current = setTimeout(() => setDeleteConfirm(false), 2000)
    } else {
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
      setDeleteConfirm(false)
      void onDelete(message.id)
    }
  }

  const isPrivate = message.visibility === 'LEAD_ADMIN'

  return (
    <div className={`flex gap-3 py-2 group rounded ${message.optimistic ? 'opacity-50' : ''} ${isPrivate ? 'bg-amber-950/20 border-l-2 border-amber-500/50 pl-2' : ''}`}>
      {/* Avatar */}
      <div className="shrink-0 mt-0.5">
        {message.optimistic ? (
          <div className="w-6 h-6 forge-shimmer bg-background-tertiary" />
        ) : (
          <Avatar name={message.authorName} avatarUrl={message.authorAvatar} size="sm" />
        )}
      </div>

      {/* Right side */}
      <div className="flex-1 min-w-0">
        {/* Top row: author + timestamp + actions */}
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-mono text-xs font-bold text-primary shrink-0">
            {message.authorName}
          </span>
          <span className="font-mono text-[10px] text-muted shrink-0">
            {formatTimestamp(message.createdAt)}
          </span>
          {message.edited && (
            <span className="font-mono text-[10px] text-muted italic shrink-0">
              (edited)
            </span>
          )}
          {isPrivate && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-amber-400 shrink-0" title="Visible to Lead & Admins only">
              <Lock className="h-3 w-3" aria-hidden="true" />
              private
            </span>
          )}

          {/* Action buttons — visible on group hover */}
          {showActions && !message.optimistic && (
            <div className="ml-auto flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              {canEdit && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="font-mono text-xs text-muted hover:text-accent-ink leading-none"
                  aria-label="Edit message"
                >
                  ✎
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  onClick={handleDeleteClick}
                  className={`font-mono text-xs leading-none transition-colors ${
                    deleteConfirm
                      ? 'text-status-danger'
                      : 'text-muted hover:text-status-danger'
                  }`}
                  aria-label="Delete message"
                >
                  {deleteConfirm ? '?' : '✕'}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Content / Edit mode */}
        {editing ? (
          <div className="mt-1">
            <textarea
              ref={editAreaRef}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={1}
              className="w-full bg-background-primary border border-accent font-mono text-xs text-primary p-2 resize-none focus:outline-none"
              style={{ maxHeight: '96px', overflowY: 'auto' }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void submitEdit()
                }
              }}
            />
            <div className="flex gap-2 mt-1">
              <button
                type="button"
                onClick={() => void submitEdit()}
                className="font-mono text-[10px] text-accent-ink hover:underline"
              >
                ✓ SAVE
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                className="font-mono text-[10px] text-muted hover:underline"
              >
                ✕ CANCEL
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="mt-0.5 font-mono text-xs text-secondary leading-relaxed whitespace-pre-wrap break-words">
              {message.content}
            </p>
            {message.fileUrl && (
              <a
                href={message.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 mt-1 font-mono text-[10px] text-accent-ink border border-accent/40 px-2 py-0.5 hover:bg-accent/10 transition-colors"
              >
                <Link className="h-3 w-3 shrink-0" aria-hidden="true" />
                {message.fileName ?? message.fileUrl}
              </a>
            )}
          </>
        )}
      </div>
    </div>
  )
}
