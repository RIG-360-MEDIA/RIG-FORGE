'use client'

import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'

import MemberRow from '@/components/projects/detail/MemberRow'
import MemberSlideOver from '@/components/people/MemberSlideOver'
import Avatar from '@/components/ui/Avatar'
import { useToast } from '@/components/ui/Toast'
import type {
  ProjectDetail,
  ProjectLink,
  ApiResponse,
  MemberSummary,
  PaginatedResponse,
} from '@/lib/types'

// ─── Props ────────────────────────────────────────────────────────────────────

interface OverviewTabProps {
  project: ProjectDetail
  isAdmin: boolean
  isLead: boolean
  currentUserId?: string
  onProjectChange: (next: ProjectDetail) => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTimeAgo(d: Date): string {
  const t = new Date(d as unknown as string).getTime()
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} minutes ago`
  if (s < 86400) return `${Math.floor(s / 3600)} hours ago`
  if (s < 604800) return `${Math.floor(s / 86400)} days ago`
  return `${Math.floor(s / 604800)} weeks ago`
}

function formatDate(d: Date | null): string {
  if (!d) return 'No deadline'
  return new Date(d as unknown as string).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function statusClass(status: string): string {
  const map: Record<string, string> = {
    ACTIVE: 'border-status-success text-accent-ink',
    ON_HOLD: 'border-status-warning text-status-warning',
    COMPLETED: 'border-accent text-accent-ink',
    ARCHIVED: 'border-border-default text-muted',
    CANCELLED: 'border-status-danger text-status-danger',
  }
  return map[status] ?? 'border-border-default text-muted'
}

function priorityClass(priority: string): string {
  const map: Record<string, string> = {
    CRITICAL: 'border-status-danger text-status-danger',
    HIGH: 'border-status-warning text-status-warning',
    MEDIUM: 'border-accent text-accent-ink',
    LOW: 'border-border-default text-muted',
  }
  return map[priority] ?? 'border-border-default text-muted'
}

function avatarColor(name: string): string {
  const colors = [
    'bg-accent/20 text-accent-ink',
    'bg-status-success/20 text-accent-ink',
    'bg-status-warning/20 text-status-warning',
    'bg-status-danger/20 text-status-danger',
  ]
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return colors[Math.abs(hash) % colors.length] ?? colors[0]
}

function initials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase()
}

const MAX_LINKS = 5
const VALID_STATUSES = ['ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED', 'CANCELLED'] as const
const VALID_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const

// ─── Sub-components ───────────────────────────────────────────────────────────

function BlockerStatusBadge({ status }: { status: string }) {
  const display = status.replace(/_/g, ' ')
  const classes: Record<string, string> = {
    OPEN: 'border-status-danger text-status-danger',
    HELP_INCOMING: 'border-status-warning text-status-warning',
    ESCALATED: 'border-accent text-accent-ink',
  }
  const cls = classes[status] ?? 'border-border-default text-muted'
  return (
    <span className={`inline-block border px-2 py-0.5 font-mono text-[10px] tracking-widest uppercase ${cls}`}>
      {display}
    </span>
  )
}

// ─── Description section ──────────────────────────────────────────────────────

interface DescriptionSectionProps {
  projectId: string
  description: string | null
  isAdmin: boolean
  canEdit: boolean
  onSaved: (description: string | null) => void
}

/** Custom ReactMarkdown renderers that match the RIG-FORGE design system */
const markdownComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  // Summary paragraph — slightly more prominent
  p: ({ children }) => (
    <p className="font-mono text-sm text-secondary leading-relaxed mb-3 last:mb-0">
      {children}
    </p>
  ),
  // Bullet list with comfortable spacing
  ul: ({ children }) => (
    <ul className="flex flex-col gap-1.5 mt-1">
      {children}
    </ul>
  ),
  li: ({ children }) => (
    <li className="flex gap-2 font-mono text-xs text-secondary leading-relaxed">
      <span className="text-accent-ink shrink-0 mt-0.5">—</span>
      <span>{children}</span>
    </li>
  ),
  // Bold key terms
  strong: ({ children }) => (
    <strong className="font-semibold text-primary">{children}</strong>
  ),
}

function DescriptionSection({ projectId, description, isAdmin, canEdit, onSaved }: DescriptionSectionProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(description ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ description: draft.trim() || null }),
      })
      const json = (await res.json()) as { data: unknown; error: string | null }
      if (!res.ok) {
        setError(json.error ?? 'Failed to save')
        return
      }
      onSaved(draft.trim() || null)
      setEditing(false)
    } catch {
      setError('Network error')
    } finally {
      setSaving(false)
    }
  }

  function handleCancel() {
    setDraft(description ?? '')
    setEditing(false)
    setError(null)
  }

  const isEmpty = !description || description.trim() === ''

  return (
    <div>
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-mono text-[10px] text-muted tracking-widest uppercase">
          About This Project
        </h3>
        {canEdit && !editing && (
          <button
            type="button"
            onClick={() => { setDraft(description ?? ''); setEditing(true) }}
            className="font-mono text-[10px] text-muted hover:text-accent-ink tracking-widest transition-colors duration-150"
            aria-label="Edit description"
          >
            ✎ EDIT
          </button>
        )}
      </div>

      {/* Edit mode */}
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={7}
            maxLength={1000}
            className="w-full bg-background-primary border border-border-default px-4 py-3 font-mono text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none resize-none transition-colors duration-150"
            placeholder="Add a project description... Markdown supported: **bold**, - bullet"
          />
          {error && <p className="font-mono text-xs text-status-danger">{error}</p>}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="bg-accent hover:bg-accent-hover disabled:opacity-60 text-background-primary font-mono text-xs tracking-widest px-4 py-1.5 transition-colors duration-150"
            >
              {saving ? 'SAVING...' : 'SAVE'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="font-mono text-xs text-muted tracking-widest hover:text-primary transition-colors duration-150"
            >
              CANCEL
            </button>
          </div>
        </div>
      ) : isEmpty ? (
        /* Empty state — differs by role */
        isAdmin ? (
          <div className="flex items-start gap-3 bg-surface-mid border border-border-default rounded-card px-5 py-4">
            <span className="text-muted text-base shrink-0 mt-0.5">✏️</span>
            <p className="font-mono text-xs text-muted leading-relaxed">
              No description yet.{' '}
              {canEdit && (
                <button
                  type="button"
                  onClick={() => { setDraft(''); setEditing(true) }}
                  className="text-accent-ink hover:text-accent-ink underline transition-colors duration-150"
                >
                  Click here to add one.
                </button>
              )}
              {!canEdit && 'Ask a project lead or admin to add one.'}
            </p>
          </div>
        ) : (
          <p className="font-mono text-xs text-muted italic">
            No description available for this project.
          </p>
        )
      ) : (
        /* Description card with left accent border */
        <div className="bg-surface-mid border border-border-default border-l-[3px] border-l-accent rounded-card px-5 py-4">
          <ReactMarkdown components={markdownComponents}>
            {description}
          </ReactMarkdown>
        </div>
      )}
    </div>
  )
}

// ─── Links section ────────────────────────────────────────────────────────────

interface LinksSectionProps {
  projectId: string
  links: ProjectLink[]
  canEdit: boolean
  onSaved: (links: ProjectLink[]) => void
}

function LinksSection({ projectId, links, canEdit, onSaved }: LinksSectionProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<ProjectLink[]>(links)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function startEdit() {
    setDraft(links.length > 0 ? links.map((l) => ({ ...l })) : [])
    setEditing(true)
  }

  function addLink() {
    if (draft.length >= MAX_LINKS) return
    setDraft((prev) => [...prev, { label: '', url: '' }])
  }

  function updateLink(index: number, field: keyof ProjectLink, value: string) {
    setDraft((prev) =>
      prev.map((link, i) => (i === index ? { ...link, [field]: value } : link)),
    )
  }

  function removeLink(index: number) {
    setDraft((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const validLinks = draft.filter((l) => l.label.trim() && l.url.trim())
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ links: validLinks }),
      })
      const json = (await res.json()) as { data: unknown; error: string | null }
      if (!res.ok) {
        setError(json.error ?? 'Failed to save')
        return
      }
      onSaved(validLinks)
      setEditing(false)
    } catch {
      setError('Network error')
    } finally {
      setSaving(false)
    }
  }

  function handleCancel() {
    setDraft(links.map((l) => ({ ...l })))
    setEditing(false)
    setError(null)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-mono text-xs text-muted tracking-widest uppercase">Project Links</h3>
        {canEdit && !editing && (
          <button
            type="button"
            onClick={startEdit}
            className="font-mono text-[10px] text-muted hover:text-accent-ink tracking-widest transition-colors duration-150"
          >
            ✎ EDIT
          </button>
        )}
      </div>

      {editing ? (
        <div className="flex flex-col gap-2">
          {draft.length === 0 && (
            <p className="font-mono text-xs text-muted">No links added</p>
          )}
          {draft.map((link, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input
                type="text"
                value={link.label}
                onChange={(e) => updateLink(i, 'label', e.target.value)}
                placeholder="Label"
                className="w-32 shrink-0 bg-background-primary border border-border-default px-3 py-2 font-mono text-xs text-primary placeholder:text-muted focus:border-accent focus:outline-none transition-colors duration-150"
              />
              <input
                type="text"
                value={link.url}
                onChange={(e) => updateLink(i, 'url', e.target.value)}
                placeholder="https://..."
                className="flex-1 min-w-0 bg-background-primary border border-border-default px-3 py-2 font-mono text-xs text-primary placeholder:text-muted focus:border-accent focus:outline-none transition-colors duration-150"
              />
              <button
                type="button"
                onClick={() => removeLink(i)}
                className="font-mono text-muted hover:text-status-danger transition-colors duration-150 shrink-0 px-1"
                aria-label="Remove link"
              >
                ✕
              </button>
            </div>
          ))}
          {draft.length < MAX_LINKS && (
            <button
              type="button"
              onClick={addLink}
              className="self-start font-mono text-[10px] text-accent-ink tracking-widest hover:text-accent-ink transition-colors duration-150 mt-1"
            >
              + ADD LINK
            </button>
          )}
          {error && <p className="font-mono text-xs text-status-danger">{error}</p>}
          <div className="flex gap-3 mt-1">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="bg-accent hover:bg-accent-hover disabled:opacity-60 text-background-primary font-mono text-xs tracking-widest px-4 py-1.5 transition-colors duration-150"
            >
              {saving ? 'SAVING...' : 'SAVE'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="font-mono text-xs text-muted tracking-widest hover:text-primary transition-colors duration-150"
            >
              CANCEL
            </button>
          </div>
        </div>
      ) : links.length === 0 ? (
        <p className="font-mono text-sm text-muted italic">No links added</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {links.map((link, i) => (
            <li key={i}>
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-sm text-accent-ink hover:underline"
              >
                {link.label || link.url}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── Org user list (shared by the lead picker and the add-member control) ─────

/**
 * Lazily loads the org's active users, once, the first time `enabled` turns true.
 * Both the lead picker and the add-member box need this list and neither should
 * pay for it until an admin actually opens them. On a failed load the ref is
 * released so the next open retries.
 */
function useOrgUsers(enabled: boolean) {
  const [users, setUsers] = useState<MemberSummary[]>([])
  const [loading, setLoading] = useState(false)
  const loadedRef = useRef(false)

  useEffect(() => {
    if (!enabled || loadedRef.current) return
    loadedRef.current = true
    setLoading(true)
    let alive = true
    fetch('/api/users?limit=200', { credentials: 'include' })
      .then((r) => r.json())
      .then((json: ApiResponse<PaginatedResponse<MemberSummary>>) => {
        if (alive && json.data) setUsers(json.data.items)
      })
      .catch(() => { loadedRef.current = false })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [enabled])

  return { users, loading }
}

// ─── Team members grid ────────────────────────────────────────────────────────

interface TeamSectionProps {
  project: ProjectDetail
  isAdmin: boolean
  onProjectChange: (next: ProjectDetail) => void
}

function TeamSection({ project, isAdmin, onProjectChange }: TeamSectionProps) {
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { users, loading } = useOrgUsers(adding)

  const memberIds = new Set(project.members.map((m) => m.userId))
  const candidates = users
    .filter((u) => !memberIds.has(u.id))
    .filter((u) => u.name.toLowerCase().includes(search.trim().toLowerCase()))

  async function addMember(user: MemberSummary) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${project.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userIds: [user.id] }),
      })
      const json = (await res.json()) as ApiResponse<ProjectDetail>
      if (!res.ok || !json.data) {
        setError(json.error ?? 'Failed to add member')
        return
      }
      onProjectChange(json.data)
      setSearch('')
    } catch {
      setError('Network error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="font-mono text-xs text-muted tracking-widest uppercase">
          Team ({project.members.length})
        </h3>
        {isAdmin && (
          <button
            type="button"
            onClick={() => { setAdding((v) => !v); setError(null); setSearch('') }}
            className="font-mono text-[10px] text-muted hover:text-accent-ink tracking-widest uppercase transition-colors duration-150"
          >
            {adding ? 'Done' : '+ Add Member'}
          </button>
        )}
      </div>

      {isAdmin && adding && (
        <div className="mb-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={loading ? 'Loading people...' : 'SEARCH PEOPLE...'}
            disabled={loading || saving}
            autoFocus
            className="w-full bg-background-primary border border-border-default px-3 py-2 font-mono text-xs text-primary placeholder:text-muted focus:border-accent focus:outline-none transition-colors duration-150 disabled:opacity-50"
          />
          {!loading && (
            <div className="mt-1 max-h-48 overflow-y-auto border border-border-default border-t-0">
              {candidates.length === 0 ? (
                <p className="font-mono text-xs text-muted px-3 py-2">
                  {users.length === 0
                    ? 'No people found'
                    : 'Everyone is already on this project'}
                </p>
              ) : (
                candidates.slice(0, 20).map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    disabled={saving}
                    onClick={() => void addMember(u)}
                    className="w-full flex items-center gap-3 px-3 py-2 hover:bg-background-tertiary transition-colors duration-150 text-left disabled:opacity-50"
                  >
                    <Avatar name={u.name} avatarUrl={u.avatarUrl} size="sm" />
                    <span className="font-mono text-xs text-primary flex-1 truncate">{u.name}</span>
                    <span className="font-mono text-[10px] text-muted uppercase tracking-widest shrink-0">
                      {u.role}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
          {error && <p className="font-mono text-[10px] text-status-danger mt-1">{error}</p>}
        </div>
      )}

      {project.members.length === 0 ? (
        <p className="font-mono text-xs text-muted text-center py-4">NO MEMBERS ASSIGNED</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {project.members.map((m) => {
            const isOnline = m.currentStatus === 'WORKING'
            const isProjectLead = m.userId === project.leadId
            const color = avatarColor(m.name)
            return (
              <div
                key={m.userId}
                className="flex flex-col items-center gap-2 p-3 bg-background-secondary border border-border-default"
              >
                {/* Avatar */}
                <div className="relative">
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center font-mono text-sm font-semibold ${color}`}
                  >
                    {initials(m.name)}
                  </div>
                  {/* Status dot */}
                  <span
                    className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-background-secondary ${
                      isOnline ? 'bg-status-success' : 'bg-border-default'
                    }`}
                  />
                </div>
                {/* Name */}
                <span className="font-mono text-xs text-primary text-center leading-tight truncate w-full text-center">
                  {m.name}
                </span>
                {/* Badges */}
                <div className="flex flex-wrap gap-1 justify-center">
                  {isProjectLead && (
                    <span className="font-mono text-[9px] tracking-widest uppercase px-1.5 py-0.5 border border-accent text-accent-ink">
                      LEAD
                    </span>
                  )}
                  <span className="font-mono text-[9px] tracking-widest uppercase px-1.5 py-0.5 border border-border-default text-muted">
                    {m.role}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Project details panel ────────────────────────────────────────────────────

interface DetailsPanelProps {
  project: ProjectDetail
  isAdmin: boolean
  onProjectChange: (next: ProjectDetail) => void
}

function DetailsPanel({ project, isAdmin, onProjectChange }: DetailsPanelProps) {
  const [editingStatus, setEditingStatus] = useState(false)
  const [editingPriority, setEditingPriority] = useState(false)
  const [editingDeadline, setEditingDeadline] = useState(false)
  const [editingLead, setEditingLead] = useState(false)
  const [savingField, setSavingField] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const { users: orgUsers, loading: orgUsersLoading } = useOrgUsers(editingLead)

  async function patchField(payload: Record<string, unknown>) {
    const key = Object.keys(payload)[0] ?? ''
    setSavingField(key)
    setFieldError(null)
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      })
      const json = (await res.json()) as { data: unknown; error: string | null }
      if (!res.ok) {
        setFieldError(json.error ?? 'Failed to save')
        return
      }
      onProjectChange({ ...project, ...payload })
      setEditingStatus(false)
      setEditingPriority(false)
      setEditingDeadline(false)
    } catch {
      setFieldError('Network error')
    } finally {
      setSavingField(null)
    }
  }

  async function changeLead(newLeadId: string | null) {
    setSavingField('leadId')
    setFieldError(null)
    try {
      // The picker lists everyone in the org, not just current members, because
      // the lead you want is often not on the project yet. Put them on the team
      // first so the roster stays consistent with who is leading it.
      let next = project
      if (newLeadId && !project.members.some((m) => m.userId === newLeadId)) {
        const addRes = await fetch(`/api/projects/${project.id}/members`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ userIds: [newLeadId] }),
        })
        const addJson = (await addRes.json()) as ApiResponse<ProjectDetail>
        if (!addRes.ok || !addJson.data) {
          setFieldError(addJson.error ?? 'Could not add the new lead to the project')
          return
        }
        next = addJson.data
      }

      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ leadId: newLeadId }),
      })
      const json = (await res.json()) as { data: unknown; error: string | null }
      if (!res.ok) {
        setFieldError(json.error ?? 'Failed to update lead')
        return
      }
      const newLeadName = newLeadId
        ? (next.members.find((m) => m.userId === newLeadId)?.name
           ?? orgUsers.find((u) => u.id === newLeadId)?.name
           ?? null)
        : null
      onProjectChange({
        ...next,
        leadId: newLeadId,
        leadName: newLeadName,
        members: next.members.map((m) => ({ ...m, isLead: m.userId === newLeadId })),
      })
      setEditingLead(false)
    } catch {
      setFieldError('Network error')
    } finally {
      setSavingField(null)
    }
  }

  const projectMemberIds = new Set(project.members.map((m) => m.userId))
  const nonMemberUsers = orgUsers.filter((u) => !projectMemberIds.has(u.id))

  const todayStr = new Date().toISOString().split('T')[0] ?? ''
  const deadlineStr = project.deadline
    ? new Date(project.deadline as unknown as string).toISOString().split('T')[0] ?? ''
    : ''

  return (
    <div className="flex flex-col gap-4">
      <h3 className="font-mono text-xs text-muted tracking-widest uppercase">Project Details</h3>

      {fieldError && (
        <p className="font-mono text-xs text-status-danger">{fieldError}</p>
      )}

      {/* Status */}
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted tracking-widest uppercase shrink-0">Status</span>
        {isAdmin && editingStatus ? (
          <div className="relative">
            <select
              defaultValue={project.status}
              disabled={savingField === 'status'}
              onChange={(e) => void patchField({ status: e.target.value })}
              className="appearance-none bg-background-primary border border-border-default px-3 py-1 pr-6 font-mono text-xs text-primary focus:border-accent focus:outline-none cursor-pointer"
            >
              {VALID_STATUSES.map((s) => (
                <option key={s} value={s}>{s.replace('_', ' ')}</option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-muted text-[10px]">▾</span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className={`inline-block border px-2 py-0.5 font-mono text-[10px] tracking-widest uppercase ${statusClass(project.status)}`}>
              {project.status.replace('_', ' ')}
            </span>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setEditingStatus(true)}
                className="font-mono text-[10px] text-muted hover:text-accent-ink transition-colors duration-150"
              >
                ✎
              </button>
            )}
          </div>
        )}
      </div>

      {/* Priority */}
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted tracking-widest uppercase shrink-0">Priority</span>
        {isAdmin && editingPriority ? (
          <div className="relative">
            <select
              defaultValue={project.priority}
              disabled={savingField === 'priority'}
              onChange={(e) => void patchField({ priority: e.target.value })}
              className="appearance-none bg-background-primary border border-border-default px-3 py-1 pr-6 font-mono text-xs text-primary focus:border-accent focus:outline-none cursor-pointer"
            >
              {VALID_PRIORITIES.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-muted text-[10px]">▾</span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className={`inline-block border px-2 py-0.5 font-mono text-[10px] tracking-widest uppercase ${priorityClass(project.priority)}`}>
              {project.priority}
            </span>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setEditingPriority(true)}
                className="font-mono text-[10px] text-muted hover:text-accent-ink transition-colors duration-150"
              >
                ✎
              </button>
            )}
          </div>
        )}
      </div>

      {/* Deadline */}
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted tracking-widest uppercase shrink-0">Deadline</span>
        {isAdmin && editingDeadline ? (
          <div className="flex items-center gap-2">
            <input
              type="date"
              defaultValue={deadlineStr}
              min={todayStr}
              disabled={savingField === 'deadline'}
              className="bg-background-primary border border-border-default px-3 py-1 font-mono text-xs text-primary focus:border-accent focus:outline-none transition-colors duration-150 [color-scheme:light]"
              onBlur={(e) => {
                const val = e.target.value
                void patchField({ deadline: val ? new Date(val).toISOString() : null })
              }}
            />
            <button
              type="button"
              onClick={() => setEditingDeadline(false)}
              className="font-mono text-[10px] text-muted hover:text-primary transition-colors duration-150"
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-secondary">{formatDate(project.deadline)}</span>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setEditingDeadline(true)}
                className="font-mono text-[10px] text-muted hover:text-accent-ink transition-colors duration-150"
              >
                ✎
              </button>
            )}
          </div>
        )}
      </div>

      {/* Lead */}
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted tracking-widest uppercase shrink-0">Lead</span>
        {isAdmin && editingLead ? (
          <div className="flex items-center gap-2">
            <div className="relative">
              <select
                defaultValue={project.leadId ?? ''}
                disabled={savingField === 'leadId' || orgUsersLoading}
                onChange={(e) => void changeLead(e.target.value || null)}
                className="appearance-none bg-background-primary border border-border-default px-3 py-1 pr-6 font-mono text-xs text-primary focus:border-accent focus:outline-none cursor-pointer disabled:opacity-60"
              >
                <option value="">{orgUsersLoading ? 'Loading...' : '— No Lead —'}</option>
                {project.members.length > 0 && (
                  <optgroup label="On this project">
                    {project.members.map((m) => (
                      <option key={m.userId} value={m.userId}>{m.name}</option>
                    ))}
                  </optgroup>
                )}
                {/* Anyone else in the org — picking one adds them to the team too. */}
                {nonMemberUsers.length > 0 && (
                  <optgroup label="Add to project as lead">
                    {nonMemberUsers.map((u) => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-muted text-[10px]">▾</span>
            </div>
            <button
              type="button"
              onClick={() => { setEditingLead(false); setFieldError(null) }}
              className="font-mono text-[10px] text-muted hover:text-primary transition-colors duration-150"
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-secondary">{project.leadName ?? '—'}</span>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setEditingLead(true)}
                className="font-mono text-[10px] text-muted hover:text-accent-ink transition-colors duration-150"
                title="Change project lead"
              >
                ✎
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function OverviewTab({ project, isAdmin, isLead, currentUserId, onProjectChange }: OverviewTabProps) {
  const canEdit = isAdmin || isLead
  const { addToast } = useToast()
  const [slideOverMemberId, setSlideOverMemberId] = useState<string | null>(null)

  function handleMemberClick(userId: string) {
    // Employees can only open their own profile
    if (!isAdmin && userId !== currentUserId) return
    setSlideOverMemberId(userId)
  }

  async function handleRemoveMember(userId: string) {
    // Optimistic update; revert if the server rejects. Previously this only
    // mutated local state and never called the API, so removals silently
    // reappeared on refresh.
    const previousMembers = project.members
    onProjectChange({
      ...project,
      members: project.members.filter((m) => m.userId !== userId),
    })
    try {
      const res = await fetch(`/api/projects/${project.id}/members/${userId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      const json = (await res.json()) as ApiResponse<ProjectDetail>
      if (!res.ok || json.error) {
        onProjectChange({ ...project, members: previousMembers })
        addToast('error', json.error ?? 'Failed to remove member')
        return
      }
      if (json.data) onProjectChange(json.data)
      addToast('success', 'Member removed')
    } catch {
      onProjectChange({ ...project, members: previousMembers })
      addToast('error', 'Network error while removing member')
    }
  }

  function handleDescriptionSaved(description: string | null) {
    onProjectChange({ ...project, description })
  }

  function handleLinksSaved(links: ProjectLink[]) {
    onProjectChange({ ...project, links })
  }

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-6 flex flex-col gap-8">
      {/* ── Top row: description + links ── */}
      <div className="flex flex-col lg:flex-row gap-8">
        {/* Description */}
        <div className="flex-1 min-w-0">
          <DescriptionSection
            projectId={project.id}
            description={project.description}
            isAdmin={isAdmin}
            canEdit={canEdit}
            onSaved={handleDescriptionSaved}
          />
        </div>

        {/* Links */}
        <div className="w-full lg:w-72 shrink-0">
          <LinksSection
            projectId={project.id}
            links={project.links}
            canEdit={canEdit}
            onSaved={handleLinksSaved}
          />
        </div>
      </div>

      {/* ── Team members grid ── */}
      <TeamSection project={project} isAdmin={isAdmin} onProjectChange={onProjectChange} />

      {/* ── Bottom row: member rows + blockers + details panel ── */}
      <div className="flex flex-col lg:flex-row gap-8 lg:gap-10">
        {/* Member rows (contribution editing) */}
        <div className="flex-1 min-w-0">
          <h2 className="font-mono text-xs text-muted tracking-widest mb-4 uppercase">Member Contributions</h2>
          {project.members.length === 0 ? (
            <p className="text-center font-mono text-xs text-muted py-8">NO MEMBERS ASSIGNED</p>
          ) : (
            project.members.map((m) => (
              <MemberRow
                key={m.userId}
                projectId={project.id}
                member={m}
                isAdmin={isAdmin}
                currentUserId={currentUserId}
                onMemberClick={handleMemberClick}
                onRemoveMember={handleRemoveMember}
              />
            ))
          )}
        </div>

        {/* Right column: details */}
        <div className="w-full lg:w-80 shrink-0">
          <DetailsPanel
            project={project}
            isAdmin={isAdmin}
            onProjectChange={onProjectChange}
          />
        </div>
      </div>

      {/* Member slide-over: admin sees all, employee only own profile */}
      <MemberSlideOver
        memberId={slideOverMemberId}
        isAdmin={isAdmin}
        currentUserId={currentUserId}
        onClose={() => setSlideOverMemberId(null)}
      />
    </div>
  )
}
