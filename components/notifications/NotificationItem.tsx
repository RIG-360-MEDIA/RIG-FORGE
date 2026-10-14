'use client'

import type { ReactNode } from 'react'
import { Hand, TriangleAlert } from 'lucide-react'

import type { NotificationItem as NotificationItemType } from '@/store/notificationStore'

// ─── Type icon / colour ────────────────────────────────────────────────────

function getTypeSymbol(type: string): ReactNode {
  switch (type) {
    case 'WELCOME':                return <Hand className="inline-block w-3.5 h-3.5" aria-hidden="true" />
    case 'TICKET_RAISED':         return '■'
    case 'TICKET_ACCEPTED':       return '○'
    case 'TICKET_ASSIGNED':       return '◆'
    case 'TICKET_COMPLETED':      return '✓'
    case 'TICKET_CANCELLED':      return '✕'
    case 'TASK_ASSIGNED':         return '◆'
    case 'TASK_DONE':             return '✓'
    case 'TASK_OVERDUE':          return <TriangleAlert className="inline-block w-3.5 h-3.5" aria-hidden="true" />
    case 'PROJECT_UPDATE':        return '▸'
    case 'PROJECT_ANNOUNCEMENT':  return '◉'
    case 'PROJECT_MEMBER_ADDED':  return '+'
    case 'PROJECT_LEAD_ASSIGNED': return '★'
    case 'ONBOARDING_APPROVED':   return '✓'
    case 'ONBOARDING_PENDING':    return '◌'
    default:                      return '◉'
  }
}

function getTypeColor(type: string): string {
  switch (type) {
    case 'WELCOME':                return 'text-accent-ink'
    case 'TICKET_RAISED':
    case 'TICKET_ACCEPTED':
    case 'ONBOARDING_PENDING':    return 'text-status-warning'
    case 'TICKET_COMPLETED':
    case 'TASK_DONE':
    case 'ONBOARDING_APPROVED':   return 'text-accent-ink'
    case 'TICKET_CANCELLED':
    case 'TASK_OVERDUE':          return 'text-status-danger'
    case 'TICKET_ASSIGNED':
    case 'TASK_ASSIGNED':
    case 'PROJECT_MEMBER_ADDED':
    case 'PROJECT_LEAD_ASSIGNED': return 'text-accent-ink'
    default:                      return 'text-text-muted'
  }
}

function formatRelativeTime(createdAt: Date): string {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt)
  const diffMs  = Date.now() - date.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  const diffHr  = Math.floor(diffMs / 3_600_000)
  const diffDay = Math.floor(diffMs / 86_400_000)

  if (diffMin < 1)   return 'just now'
  if (diffMin < 60)  return `${diffMin}m ago`
  if (diffHr  < 24)  return `${diffHr}h ago`
  if (diffDay === 1) return 'Yesterday'

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  })
}

// ─── Props ─────────────────────────────────────────────────────────────────

interface NotificationItemProps {
  notification: NotificationItemType
  onRead:     (id: string) => void
  onNavigate: (linkTo: string) => void
  onDelete:   (id: string) => void
  selectable: boolean
  selected:   boolean
  onSelect:   (id: string) => void
}

// ─── Component ─────────────────────────────────────────────────────────────

export default function NotificationItem({
  notification,
  onRead,
  onNavigate,
  onDelete,
  selectable,
  selected,
  onSelect,
}: NotificationItemProps) {
  const { id, type, title, body, read, linkTo, createdAt } = notification

  function handleClick() {
    if (selectable) { onSelect(id); return }
    onRead(id)
    if (linkTo) onNavigate(linkTo)
  }

  return (
    <div
      className={[
        'group flex gap-3 px-4 py-3 border-b border-border-default cursor-pointer transition-colors',
        'hover:bg-background-tertiary',
        read ? 'bg-transparent' : 'bg-background-primary/50',
        selected ? 'bg-accent/5' : '',
      ].join(' ')}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick() }}
    >
      {/* Checkbox (select mode) or unread dot + icon */}
      <div className="flex items-start gap-1.5 shrink-0 pt-0.5">
        {selectable ? (
          <span
            className={[
              'w-4 h-4 rounded border flex items-center justify-center mt-0.5 transition-all',
              selected
                ? 'bg-accent border-accent'
                : 'bg-surface-raised border-border-default',
            ].join(' ')}
          >
            {selected && (
              <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 10 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 4l3 3 5-6" />
              </svg>
            )}
          </span>
        ) : (
          <>
            <span className={['block rounded-full w-[6px] h-[6px] mt-[3px] shrink-0', read ? 'bg-transparent' : 'bg-accent'].join(' ')} />
            <span className={['text-sm font-mono leading-none', getTypeColor(type)].join(' ')}>
              {getTypeSymbol(type)}
            </span>
          </>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className={['font-mono text-xs text-text-primary truncate leading-snug', read ? 'font-normal' : 'font-bold'].join(' ')}>
          {title}
        </p>
        <p className="font-mono text-xs text-text-secondary leading-relaxed line-clamp-2 mt-0.5">
          {body}
        </p>
        <p className="font-mono text-[11px] text-text-muted mt-1">{formatRelativeTime(createdAt)}</p>
      </div>

      {/* Right side: arrow OR delete button */}
      <div className="flex items-start shrink-0 pt-0.5 gap-1">
        {!selectable && linkTo && (
          <span className="text-text-muted text-xs">→</span>
        )}
        {!selectable && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(id) }}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity p-2 rounded hover:text-status-danger text-text-muted"
            title="Delete notification"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
