'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'

import Avatar from '@/components/ui/Avatar'
import ContributionBar from '@/components/ui/ContributionBar'
import type { ProjectSummary } from '@/lib/types'

// ─── Local badge helpers (Badge component lacks project status/priority variants) ─

function ProjectStatusBadge({ status }: { status: string }) {
  const classes: Record<string, string> = {
    ACTIVE: 'border-status-success text-accent-ink',
    ON_HOLD: 'border-status-warning text-status-warning',
    COMPLETED: 'border-border-default text-muted',
    ARCHIVED: 'border-border-default text-muted italic',
  }
  const cls = classes[status] ?? 'border-border-default text-muted'
  return (
    <span className={`inline-block border px-2 py-0.5 font-mono text-[10px] tracking-widest uppercase ${cls}`}>
      {status.replace('_', ' ')}
    </span>
  )
}

function PriorityBadge({ priority }: { priority: string }) {
  const classes: Record<string, string> = {
    CRITICAL: 'border-status-danger text-status-danger',
    HIGH: 'border-accent text-accent-ink',
    MEDIUM: 'border-border-default text-secondary',
    LOW: 'border-border-default text-muted',
  }
  const cls = classes[priority] ?? 'border-border-default text-muted'
  return (
    <span className={`inline-block border px-2 py-0.5 font-mono text-[10px] tracking-widest uppercase ${cls}`}>
      {priority}
    </span>
  )
}

// ─── Status bar color ─────────────────────────────────────────────────────────

const STATUS_BAR_COLOR: Record<string, string> = {
  ACTIVE: 'bg-status-success',
  ON_HOLD: 'bg-status-warning',
  COMPLETED: 'bg-border-default',
  ARCHIVED: 'bg-border-default',
}

// ─── Deadline display ─────────────────────────────────────────────────────────

function getDeadlineDisplay(deadline: Date | null): { text: string; className: string } {
  if (!deadline) return { text: '—', className: 'text-muted' }
  // deadline arrives as ISO string from JSON despite Date type
  const d = new Date(deadline as unknown as string)
  const diffDays = Math.floor((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  const formatted = d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  if (diffDays < 0) return { text: `✕ ${formatted}`, className: 'text-status-danger' }
  if (diffDays <= 7) return { text: `⚠ ${formatted}`, className: 'text-status-warning' }
  return { text: formatted, className: 'text-secondary' }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const EDIT_STATUSES = ['ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED'] as const
const EDIT_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const

// ─── Props ────────────────────────────────────────────────────────────────────

interface ProjectListRowProps {
  project: ProjectSummary
  isAdmin: boolean
  onUpdate: (updated: ProjectSummary) => void
  onArchive: (id: string) => void
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function toDateInputValue(deadline: Date | null): string {
  if (!deadline) return ''
  try {
    return new Date(deadline as unknown as string).toISOString().split('T')[0] ?? ''
  } catch {
    return ''
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ProjectListRow({
  project,
  isAdmin,
  onUpdate,
  onArchive,
}: ProjectListRowProps) {
  const router = useRouter()

  // ── Edit state ──────────────────────────────────────────────────────────────
  const [editMode, setEditMode] = useState(false)
  const [editName, setEditName] = useState(project.name)
  const [editStatus, setEditStatus] = useState(project.status)
  const [editPriority, setEditPriority] = useState(project.priority)
  const [editDeadline, setEditDeadline] = useState(() => toDateInputValue(project.deadline))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // ── Archive state ───────────────────────────────────────────────────────────
  const [archiveConfirm, setArchiveConfirm] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
  const archiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Navigation ──────────────────────────────────────────────────────────────
  function handleRowClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('[data-no-nav]')) return
    router.push(`/dashboard/projects/${project.id}`)
  }

  // ── Edit handlers ────────────────────────────────────────────────────────────
  function openEdit(e: React.MouseEvent) {
    e.stopPropagation()
    setEditName(project.name)
    setEditStatus(project.status)
    setEditPriority(project.priority)
    setEditDeadline(toDateInputValue(project.deadline))
    setSaveError(null)
    setEditMode(true)
  }

  function cancelEdit(e: React.MouseEvent) {
    e.stopPropagation()
    setEditMode(false)
    setSaveError(null)
  }

  async function handleSave(e: React.MouseEvent) {
    e.stopPropagation()
    if (!editName.trim()) {
      setSaveError('Name required')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: editName.trim(),
          status: editStatus,
          priority: editPriority,
          deadline: editDeadline ? new Date(editDeadline).toISOString() : null,
        }),
      })
      const json = await res.json() as { data: ProjectSummary | null; error: string | null }
      if (res.ok && json.data) {
        onUpdate(json.data)
        setEditMode(false)
      } else {
        setSaveError(json.error ?? 'Save failed')
      }
    } catch {
      setSaveError('Network error')
    } finally {
      setSaving(false)
    }
  }

  // ── Archive handlers ─────────────────────────────────────────────────────────
  function handleArchiveClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (!archiveConfirm) {
      setArchiveConfirm(true)
      archiveTimerRef.current = setTimeout(() => setArchiveConfirm(false), 3000)
    } else {
      if (archiveTimerRef.current) clearTimeout(archiveTimerRef.current)
      void confirmArchive()
    }
  }

  async function confirmArchive() {
    setArchiving(true)
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (res.ok) {
        setIsRemoving(true)
        setTimeout(() => onArchive(project.id), 300)
      } else {
        setArchiving(false)
        setArchiveConfirm(false)
      }
    } catch {
      setArchiving(false)
      setArchiveConfirm(false)
    }
  }

  // ── Derived display values ────────────────────────────────────────────────────
  const deadline = getDeadlineDisplay(project.deadline)
  const barColor = STATUS_BAR_COLOR[project.status] ?? 'bg-border-default'

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open project: ${project.name}`}
      className={`relative flex flex-col gap-3 lg:flex-row lg:items-center px-4 sm:px-6 lg:gap-4 py-3 lg:py-0 lg:min-h-[64px] bg-background-secondary border-b border-border-default hover:bg-background-tertiary cursor-pointer transition-all duration-300 ${isRemoving ? 'opacity-0' : 'opacity-100'}`}
      onClick={handleRowClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); router.push(`/dashboard/projects/${project.id}`) } }}
    >
      {/* Left status bar */}
      <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${barColor}`} />

      {/* ── COLUMN 1: Identity ──────────────────────────────────────────────── */}
      {/* min-w floor so the name never collapses to an ellipsis when the meta
          columns (or an open Forgie dock) squeeze the row. */}
      <div className="flex-1 min-w-0 lg:min-w-[140px]">
        {editMode ? (
          <div data-no-nav className="space-y-2 py-2">
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              className="w-full bg-background-primary border border-border-default px-3 py-1.5 font-mono text-sm text-primary focus:border-accent focus:outline-none"
              placeholder="Project name"
            />
            <div className="relative">
              <select
                value={editPriority}
                onChange={(e) => setEditPriority(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className="w-full appearance-none bg-background-primary border border-border-default px-3 py-1.5 pr-7 font-mono text-xs text-primary focus:border-accent focus:outline-none"
              >
                {EDIT_PRIORITIES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-muted text-xs">▾</span>
            </div>
            {saveError && (
              <p className="font-mono text-[10px] text-status-danger">{saveError}</p>
            )}
          </div>
        ) : (
          <>
            {/* Name gets the FULL column width and may wrap to two lines — it
                used to share the line with the priority badge and truncate to a
                single character on narrower screens. */}
            <span className="font-mono font-bold text-sm text-primary leading-snug break-words line-clamp-3">
              {project.name}
            </span>
            {/* Client + site sit directly under the name so the "CLIENT A–Z"
                sort has something visible to sort by. Hidden entirely when the
                project has neither, to avoid an empty line on internal work. */}
            {(project.clientName || project.siteLocation) && (
              <div className="flex items-center gap-2 min-w-0 mt-0.5">
                {project.clientName && (
                  <span className="font-mono text-[10px] text-accent-ink tracking-widest uppercase truncate">
                    {project.clientName}
                  </span>
                )}
                {project.clientName && project.siteLocation && (
                  <span className="font-mono text-[10px] text-muted shrink-0">·</span>
                )}
                {project.siteLocation && (
                  <span className="font-mono text-[10px] text-muted truncate">
                    {project.siteLocation}
                  </span>
                )}
              </div>
            )}
            <div className="flex items-center gap-2 min-w-0 mt-1">
              <span className="shrink-0">
                <PriorityBadge priority={project.priority} />
              </span>
              {project.description ? (
                <p className="font-mono text-xs text-muted truncate">
                  {project.description}
                </p>
              ) : (
                <p className="font-mono text-xs text-muted italic truncate">No description</p>
              )}
            </div>
          </>
        )}
      </div>

      {/* Meta columns: wrap into rows on mobile; on lg, contents dissolves this
          wrapper so the children become direct columns of the row again. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 lg:contents">

      {/* ── COLUMN 2: Progress ──────────────────────────────────────────────── */}
      <div className="w-full lg:w-32 lg:min-w-0 lg:shrink" data-no-nav>
        <p className="font-mono text-[10px] text-muted tracking-widest uppercase mb-1">
          Progress
        </p>
        <ContributionBar value={project.totalTasks > 0 ? Math.round((project.doneTasks / project.totalTasks) * 100) : 0} showPercentage={false} />
        <p className="font-mono text-[10px] text-muted mt-1">
          {project.doneTasks} / {project.totalTasks} tasks
        </p>
      </div>

      {/* ── COLUMN 3: Members ───────────────────────────────────────────────── */}
      <div className="lg:w-24 shrink-0">
        {project.members.length === 0 ? (
          <span className="font-mono text-xs text-muted">—</span>
        ) : (
          <div className="flex items-center">
            {project.members.map((m, i) => (
              <div key={m.id} style={{ marginLeft: i > 0 ? '-8px' : '0', position: 'relative', zIndex: 10 - i }}>
                <Avatar name={m.name} avatarUrl={m.avatarUrl} size="sm" />
              </div>
            ))}
            {project.memberCount > project.members.length && (
              <span className="font-mono text-[10px] text-muted ml-2">
                +{project.memberCount - project.members.length}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── COLUMN 4: Deadline ──────────────────────────────────────────────── */}
      <div className="lg:w-28 shrink-0">
        {editMode ? (
          <input
            data-no-nav
            type="date"
            value={editDeadline}
            onChange={(e) => setEditDeadline(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            min={new Date().toISOString().split('T')[0]}
            className="w-full bg-background-primary border border-border-default px-2 py-1.5 font-mono text-xs text-primary focus:border-accent focus:outline-none [color-scheme:light]"
          />
        ) : (
          <>
            <p className="font-mono text-[10px] text-muted tracking-widest uppercase mb-1">
              Deadline
            </p>
            <p className={`font-mono text-xs ${deadline.className}`}>{deadline.text}</p>
          </>
        )}
      </div>

      {/* ── COLUMN 5: Status ────────────────────────────────────────────────── */}
      <div className="lg:w-24 shrink-0">
        {editMode ? (
          <div data-no-nav className="relative">
            <select
              value={editStatus}
              onChange={(e) => setEditStatus(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              className="w-full appearance-none bg-background-primary border border-border-default px-2 py-1.5 pr-6 font-mono text-xs text-primary focus:border-accent focus:outline-none"
            >
              {EDIT_STATUSES.map((s) => (
                <option key={s} value={s}>{s.replace('_', ' ')}</option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-muted text-xs">▾</span>
          </div>
        ) : (
          <ProjectStatusBadge status={project.status} />
        )}
      </div>

      </div>

      {/* ── COLUMN 6: Actions (ADMIN only) ──────────────────────────────────── */}
      {isAdmin && (
        <div
          className="w-full lg:w-[124px] shrink-0 flex items-center justify-end gap-1.5"
          data-no-nav
          onClick={(e) => e.stopPropagation()}
        >
          {editMode ? (
            <>
              <button
                onClick={(e) => void handleSave(e)}
                disabled={saving}
                className="h-7 px-2.5 border border-accent/50 rounded font-mono text-[10px] tracking-widest text-accent-ink hover:bg-accent/10 disabled:opacity-50 transition-colors duration-150 whitespace-nowrap"
                title="Save changes"
              >
                {saving ? '…' : 'SAVE'}
              </button>
              <button
                onClick={cancelEdit}
                className="h-7 px-2.5 border border-border-default rounded font-mono text-[10px] tracking-widest text-muted hover:text-primary transition-colors duration-150 whitespace-nowrap"
                title="Cancel"
              >
                CANCEL
              </button>
            </>
          ) : (
            <>
              {/* Labelled, bordered buttons — these were bare "✎" / "▣" glyphs
                  that users could not find (reported by Trijya). */}
              <button
                onClick={openEdit}
                className="h-7 px-2.5 border border-border-default rounded font-mono text-[10px] tracking-widest text-muted hover:text-accent-ink hover:border-accent/50 transition-colors duration-150 whitespace-nowrap"
                title="Edit project"
              >
                EDIT
              </button>
              <button
                onClick={handleArchiveClick}
                disabled={archiving}
                className={`h-7 px-2.5 border rounded font-mono text-[10px] tracking-widest transition-colors duration-150 disabled:opacity-50 whitespace-nowrap ${
                  archiveConfirm
                    ? 'border-status-danger text-status-danger bg-status-danger/10'
                    : 'border-border-default text-muted hover:text-status-danger hover:border-status-danger/50'
                }`}
                title="Delete project (can be restored)"
              >
                {archiveConfirm ? 'SURE?' : 'DELETE'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
