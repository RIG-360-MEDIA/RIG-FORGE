'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'

import Avatar from '@/components/ui/Avatar'
import StatusDot from '@/components/ui/StatusDot'
import Badge from '@/components/ui/Badge'
import ActivityStrip from '@/components/people/ActivityStrip'
import { useToast } from '@/components/ui/Toast'
import type { MemberDetail, ApiResponse } from '@/lib/types'

// ─── Types ───────────────────────────────────────────────────────────────────

interface MemberSlideOverProps {
  memberId: string | null
  isAdmin: boolean
  isSuperAdmin?: boolean
  /** Base admins + super-admins may assign custom roles (create/edit is in RolesManager). */
  canManageRoles?: boolean
  currentUserId?: string   // required for employee guard
  onClose: () => void
  /** Called after a successful removal so the parent can refresh its list. */
  onRemoved?: (userId: string) => void
  /** Called after a successful role change so the parent can update its list. */
  onRoleChanged?: (userId: string, role: string) => void
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(date: Date | string | null): string {
  if (!date) return 'never'
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function formatDate(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

const PRIORITY_CLASSES: Record<string, string> = {
  CRITICAL: 'border-status-danger text-status-danger',
  HIGH: 'border-accent text-accent-ink',
  MEDIUM: 'border-border-default text-secondary',
  LOW: 'border-border-default text-muted',
}

const STATUS_CLASSES: Record<string, string> = {
  ACTIVE: 'border-status-success text-accent-ink',
  ON_HOLD: 'border-status-warning text-status-warning',
  COMPLETED: 'border-border-default text-muted',
  ARCHIVED: 'border-border-default text-muted',
}

// ─── Section heading ──────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[10px] text-muted tracking-widest uppercase mb-3">
      {children}
    </p>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function MemberSlideOver({ memberId, isAdmin, isSuperAdmin = false, canManageRoles = false, currentUserId, onClose, onRemoved, onRoleChanged }: MemberSlideOverProps) {
  // CLIENT-SIDE GUARD: employee cannot view another user's profile
  // The API also enforces this (403), but we also never open the panel
  if (memberId && !isAdmin && currentUserId && memberId !== currentUserId) {
    return null
  }
  const [member, setMember] = useState<MemberDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Admin send notification state
  const [notifTitle, setNotifTitle] = useState('')
  const [notifBody, setNotifBody] = useState('')
  const [sending, setSending] = useState(false)

  // Password reset state
  const [resettingPassword, setResettingPassword] = useState(false)
  const [resetResult, setResetResult] = useState<string | null>(null)
  const [showTempPassword, setShowTempPassword] = useState(false)

  // Remove member state
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [removing, setRemoving] = useState(false)

  // Change role state
  const [changingRole, setChangingRole] = useState(false)
  const [customRoles, setCustomRoles] = useState<{ id: string; name: string }[]>([])

  const { addToast } = useToast()

  // Focus trap ref
  const panelRef = useRef<HTMLDivElement>(null)

  // ── Fetch member detail ────────────────────────────────────────────────────

  const fetchMember = useCallback(async (id: string) => {
    setLoading(true)
    setError(null)
    setMember(null)
    try {
      const res = await fetch(`/api/users/${id}/detail`, { credentials: 'include' })
      const json = (await res.json()) as ApiResponse<MemberDetail>
      if (!res.ok || json.error) {
        setError(json.error ?? 'Failed to load member')
        return
      }
      setMember(json.data)
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (memberId) {
      void fetchMember(memberId)
      setNotifTitle('')
      setNotifBody('')
    }
  }, [memberId, fetchMember])

  // Admins + super-admins: load available custom roles for the assignment control.
  useEffect(() => {
    if (!memberId || !canManageRoles) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/admin/roles', { credentials: 'include' })
        const json = (await res.json()) as ApiResponse<{ id: string; name: string }[]>
        if (!cancelled && res.ok && json.data) setCustomRoles(json.data)
      } catch { /* non-fatal */ }
    })()
    return () => { cancelled = true }
  }, [memberId, canManageRoles])

  // ── Keyboard: Escape to close ──────────────────────────────────────────────

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  // ── Body scroll lock when open ─────────────────────────────────────────────

  useEffect(() => {
    if (memberId) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [memberId])

  // ── Admin: send notification ───────────────────────────────────────────────

  const handleSendNotification = async () => {
    if (!member || !notifTitle.trim() || !notifBody.trim()) return
    setSending(true)
    try {
      const res = await fetch('/api/notifications/admin-send', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUserId: member.id,
          title: notifTitle.trim(),
          body: notifBody.trim(),
        }),
      })
      if (res.ok) {
        addToast('success', 'Notification sent')
        setNotifTitle('')
        setNotifBody('')
      } else {
        addToast('error', 'Failed to send notification')
      }
    } catch {
      addToast('error', 'Network error')
    } finally {
      setSending(false)
    }
  }

  const handleRemoveMember = async () => {
    if (!member || removing) return
    setRemoving(true)
    try {
      const res = await fetch(`/api/users/${member.id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      const json = await res.json() as ApiResponse<{ id: string; name: string }>
      if (!res.ok || json.error) {
        addToast('error', json.error ?? 'Failed to remove member')
        return
      }
      addToast('success', `${member.name} has been removed`)
      onRemoved?.(member.id)
      onClose()
    } catch {
      addToast('error', 'Network error')
    } finally {
      setRemoving(false)
      setConfirmingRemove(false)
    }
  }

  const handleChangeRole = async (newRole: 'ADMIN' | 'EMPLOYEE') => {
    if (!member || changingRole || member.role === newRole) return
    setChangingRole(true)
    try {
      const res = await fetch(`/api/users/${member.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      })
      const json = await res.json() as ApiResponse<{ id: string; name: string; role: string }>
      if (!res.ok || json.error || !json.data) {
        addToast('error', json.error ?? 'Failed to change role')
        return
      }
      setMember((prev) => (prev ? { ...prev, role: json.data!.role as MemberDetail['role'] } : prev))
      onRoleChanged?.(member.id, json.data.role)
      addToast('success', `${member.name} is now ${json.data.role === 'ADMIN' ? 'an Admin' : 'an Employee'}`)
    } catch {
      addToast('error', 'Network error')
    } finally {
      setChangingRole(false)
    }
  }

  const handleAssignCustomRole = async (customRoleId: string | null) => {
    if (!member || changingRole) return
    setChangingRole(true)
    try {
      const res = await fetch(`/api/users/${member.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customRoleId }),
      })
      const json = await res.json() as ApiResponse<{ id: string; name: string; role: string; customRoleId: string | null }>
      if (!res.ok || json.error || !json.data) {
        addToast('error', json.error ?? 'Failed to assign role')
        return
      }
      const assigned = customRoles.find((r) => r.id === json.data!.customRoleId)
      setMember((prev) => (prev ? {
        ...prev,
        role: json.data!.role as MemberDetail['role'],
        customRoleId: json.data!.customRoleId,
        customRoleName: assigned?.name ?? null,
      } : prev))
      onRoleChanged?.(member.id, json.data.role)
      addToast('success', assigned ? `${member.name} assigned to ${assigned.name}` : `${member.name}'s custom role cleared`)
    } catch {
      addToast('error', 'Network error')
    } finally {
      setChangingRole(false)
    }
  }

  const handleResetPassword = async () => {
    if (!member) return
    setResettingPassword(true)
    setResetResult(null)
    try {
      const res = await fetch(`/api/admin/users/${member.id}/reset-password`, {
        method: 'POST',
        credentials: 'include',
      })
      const json = await res.json() as { data: { temporaryPassword: string } | null; error: string | null }
      if (!res.ok || !json.data) {
        addToast('error', json.error ?? 'Failed to reset password')
        return
      }
      setResetResult(json.data.temporaryPassword)
      setShowTempPassword(true)
      // Refresh member data to clear tempPassword display
      void fetchMember(member.id)
      addToast('success', 'Password reset — share new credentials with user')
    } catch {
      addToast('error', 'Network error')
    } finally {
      setResettingPassword(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const isOpen = !!memberId

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-300 ${
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Member profile"
        className={`fixed top-0 right-0 z-50 h-full w-full max-w-md bg-background-secondary border-l border-border-default shadow-2xl flex flex-col transform transition-transform duration-300 ease-in-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* ── Header bar ──────────────────────────────────────── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-default shrink-0">
          <p className="font-mono text-[10px] text-muted tracking-widest uppercase">
            Member Profile
          </p>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-lg text-muted hover:text-accent-ink transition-colors leading-none"
            aria-label="Close panel"
          >
            ✕
          </button>
        </div>

        {/* ── Scrollable content ──────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center h-48">
              <span className="font-mono text-xs text-muted tracking-widest animate-pulse">
                LOADING...
              </span>
            </div>
          )}

          {error && !loading && (
            <div className="px-6 py-8 text-center">
              <p className="font-mono text-sm text-status-danger">{error}</p>
              <button
                type="button"
                onClick={() => memberId && void fetchMember(memberId)}
                className="mt-4 font-mono text-xs text-accent-ink hover:underline"
              >
                RETRY
              </button>
            </div>
          )}

          {member && !loading && (
            <div className="px-6 py-5 space-y-7">

              {/* ── Profile block ──────────────────────────────── */}
              <div className="flex items-start gap-4">
                <div className="relative shrink-0">
                  <Avatar name={member.name} avatarUrl={member.avatarUrl} size="xl" />
                  <span className="absolute bottom-0 right-0">
                    <StatusDot status={member.currentStatus} size="sm" />
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="font-mono font-bold text-xl text-primary leading-tight">
                    {member.name}
                  </h2>
                  <div className="mt-1 flex flex-wrap gap-2 items-center">
                    <Badge label={member.role} variant="role" value={member.role} />
                    {member.isOnboarding && (
                      <span className="font-mono text-[10px] tracking-widest text-status-warning border border-status-warning/30 px-1.5 py-0.5">
                        ONBOARDING
                      </span>
                    )}
                  </div>
                  {member.email && (
                    <p className="font-mono text-xs text-secondary mt-1.5 truncate">
                      {member.email}
                    </p>
                  )}
                  <p className="font-mono text-xs text-muted mt-0.5">
                    {member.currentStatus === 'WORKING' ? '● Working now' : '○ Not working'}
                    {member.lastSeenAt && (
                      <> · last seen {timeAgo(member.lastSeenAt)}</>
                    )}
                  </p>
                </div>
              </div>

              {/* ── Quick stats ────────────────────────────────── */}
              <div className="grid grid-cols-3 gap-3">
                <div className="forge-card p-3 text-center">
                  <p className="font-mono font-bold text-xl text-accent-ink forge-text-glow leading-none">
                    {member.projects.length}
                  </p>
                  <p className="font-mono text-[10px] text-muted tracking-widest mt-1">PROJECTS</p>
                </div>
                <div className="forge-card p-3 text-center">
                  <p className="font-mono font-bold text-xl text-accent-ink forge-text-glow leading-none">
                    {member.ticketsRaisedCount}
                  </p>
                  <p className="font-mono text-[10px] text-muted tracking-widest mt-1">RAISED</p>
                </div>
                <div className="forge-card p-3 text-center">
                  <p className="font-mono font-bold text-xl text-accent-ink forge-text-glow leading-none">
                    {member.ticketsHelpedCount}
                  </p>
                  <p className="font-mono text-[10px] text-muted tracking-widest mt-1">HELPED</p>
                </div>
              </div>

              {/* ── Activity this week ─────────────────────────── */}
              <div>
                <SectionHeading>Activity — Last 7 Days</SectionHeading>
                <ActivityStrip activity={member.activityThisWeek} />
              </div>

              {/* ── Projects ──────────────────────────────────── */}
              {member.projects.length > 0 && (
                <div>
                  <SectionHeading>Projects ({member.projects.length})</SectionHeading>
                  <ul className="space-y-2">
                    {member.projects.map((p) => {
                      const statusCls = STATUS_CLASSES[p.status] ?? 'border-border-default text-muted'
                      const done = p.myDoneTaskCount
                      const total = p.myTaskCount
                      const pct = total > 0 ? Math.round((done / total) * 100) : 0
                      return (
                        <li key={p.id}>
                          <Link
                            href={`/dashboard/projects/${p.id}`}
                            className="forge-card p-3 block hover:border-accent/40 transition-colors group"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <p className="font-mono text-sm text-primary font-bold truncate group-hover:text-accent-ink transition-colors">
                                {p.name}
                              </p>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {p.isLead && (
                                  <span className="font-mono text-[9px] tracking-widest text-accent-ink border border-accent/40 px-1 py-0.5">
                                    LEAD
                                  </span>
                                )}
                                <span className={`font-mono text-[9px] tracking-widest border px-1 py-0.5 ${statusCls}`}>
                                  {p.status.replace('_', ' ')}
                                </span>
                              </div>
                            </div>
                            {total > 0 && (
                              <div className="mt-2">
                                <div className="flex items-center justify-between mb-1">
                                  <span className="font-mono text-[10px] text-muted">
                                    {done}/{total} tasks
                                  </span>
                                  <span className="font-mono text-[10px] text-secondary">
                                    {pct}%
                                  </span>
                                </div>
                                <div className="h-1 bg-background-tertiary rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-accent rounded-full transition-all"
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                              </div>
                            )}
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              {/* ── In-progress tasks ──────────────────────────── */}
              {member.inProgressTasks.length > 0 && (
                <div>
                  <SectionHeading>Active Tasks ({member.inProgressTasks.length})</SectionHeading>
                  <ul className="space-y-2">
                    {member.inProgressTasks.map((t) => {
                      const priCls = PRIORITY_CLASSES[t.priority] ?? 'border-border-default text-muted'
                      return (
                        <li key={t.id} className="forge-card p-3">
                          <div className="flex items-start justify-between gap-2">
                            <p className={`font-mono text-xs font-semibold leading-tight flex-1 ${t.isOverdue ? 'text-status-danger' : 'text-primary'}`}>
                              {t.title}
                            </p>
                            <span className={`font-mono text-[9px] tracking-widest border px-1 py-0.5 shrink-0 ${priCls}`}>
                              {t.priority}
                            </span>
                          </div>
                          <div className="flex items-center justify-between mt-1.5">
                            <p className="font-mono text-[10px] text-muted truncate">
                              {t.projectName}
                            </p>
                            {t.dueDate && (
                              <p className={`font-mono text-[10px] shrink-0 ml-2 ${t.isOverdue ? 'text-status-danger' : 'text-muted'}`}>
                                {t.isOverdue ? '✕ ' : ''}
                                {new Date(t.dueDate).toLocaleDateString('en-US', {
                                  month: 'short',
                                  day: 'numeric',
                                })}
                              </p>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              {/* ── Completed tasks this week ──────────────────── */}
              {member.completedTasksThisWeek.length > 0 && (
                <div>
                  <SectionHeading>Completed This Week ({member.completedTasksThisWeek.length})</SectionHeading>
                  <ul className="space-y-1.5">
                    {member.completedTasksThisWeek.map((t) => (
                      <li key={t.id} className="forge-card p-2.5">
                        <p className="font-mono text-xs text-primary leading-tight">{t.title}</p>
                        <p className="font-mono text-[10px] text-muted mt-0.5">
                          {t.projectName} · {timeAgo(t.completedAt)}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* ── Daily logs ─────────────────────────────────── */}
              {member.dailyLogsThisWeek.length > 0 && (
                <div>
                  <SectionHeading>Daily Logs This Week</SectionHeading>
                  <ul className="space-y-2">
                    {member.dailyLogsThisWeek.map((log) => (
                      <li key={log.date} className="forge-card p-3">
                        <p className="font-mono text-[10px] text-accent-ink tracking-widest mb-1">
                          {formatDate(log.date)}
                        </p>
                        <p className="font-mono text-xs text-primary leading-relaxed">
                          {log.workSummary}
                        </p>
                        {log.notes && (
                          <p className="font-mono text-[10px] text-secondary mt-1 leading-relaxed italic">
                            {log.notes}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* ── Admin Actions ──────────────────────────────── */}
              {isAdmin && (
                <div className="space-y-4">
                  <SectionHeading>Admin Actions</SectionHeading>

                  {/* Change role — SUPER_ADMIN only. Not shown for other SUPER_ADMINs
                       or the viewer's own profile. Toggles between EMPLOYEE and ADMIN. */}
                  {isSuperAdmin &&
                    member.role !== 'SUPER_ADMIN' &&
                    member.id !== currentUserId && (
                    <div className="forge-card p-4 space-y-3">
                      <p className="font-mono text-xs text-secondary font-semibold tracking-wide">
                        Change Role
                      </p>
                      <p className="font-mono text-[10px] text-muted leading-relaxed">
                        Current role: <span className="text-accent-ink">{member.role}</span>
                      </p>
                      <div className="flex gap-2">
                        {(['EMPLOYEE', 'ADMIN'] as const).map((r) => {
                          const active = member.role === r
                          return (
                            <button
                              key={r}
                              type="button"
                              onClick={() => void handleChangeRole(r)}
                              disabled={changingRole || active}
                              className={`flex-1 font-mono text-xs tracking-widest py-2 border transition-colors disabled:cursor-not-allowed ${
                                active
                                  ? 'border-accent text-accent-ink bg-accent/10 opacity-100'
                                  : 'border-border-default text-secondary hover:border-accent hover:text-accent-ink disabled:opacity-40'
                              }`}
                            >
                              {changingRole && !active ? '...' : r}
                            </button>
                          )
                        })}
                      </div>
                      <p className="font-mono text-[10px] text-muted leading-relaxed">
                        Admins can manage members, projects, tickets and reports. Takes effect on the user&apos;s next request.
                      </p>

                    </div>
                  )}

                  {/* Custom role assignment — admins + super-admins (separate from
                       the base-role toggle above, which is super-admin only). */}
                  {canManageRoles &&
                    member.role !== 'SUPER_ADMIN' &&
                    member.id !== currentUserId && (
                    <div className="forge-card p-4 space-y-2">
                      <p className="font-mono text-xs text-secondary font-semibold tracking-wide">
                        Custom Role
                      </p>
                      <p className="font-mono text-[10px] text-muted leading-relaxed">
                        Grant a specific set of permissions. Build or edit roles from &ldquo;Manage Roles&rdquo;.
                      </p>
                      {customRoles.length === 0 ? (
                        <p className="font-mono text-[10px] text-muted">No custom roles yet.</p>
                      ) : (
                        <>
                          <select
                            value={member.customRoleId ?? ''}
                            onChange={(e) => void handleAssignCustomRole(e.target.value || null)}
                            disabled={changingRole}
                            className="w-full border border-border-default bg-background-primary px-2 py-1.5 font-mono text-xs text-primary focus:outline-none focus:border-accent disabled:opacity-40"
                          >
                            <option value="">— No custom role —</option>
                            {customRoles.map((r) => (
                              <option key={r.id} value={r.id}>{r.name}</option>
                            ))}
                          </select>
                          {member.customRoleName && (
                            <p className="font-mono text-[10px] text-accent-ink mt-1">
                              Currently: {member.customRoleName}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {/* Password management (not shown for SUPER_ADMIN accounts) */}
                  {member.role !== 'SUPER_ADMIN' &&
                    (isSuperAdmin || member.role === 'EMPLOYEE') && (
                    <div className="forge-card p-4 space-y-3">
                      <p className="font-mono text-xs text-secondary font-semibold tracking-wide">
                        Password Management
                      </p>

                      {/* Current temp password (if user hasn't changed yet) */}
                      {member.mustChangePassword && member.tempPassword && !resetResult && (
                        <div className="bg-amber-950/20 border border-amber-500/40 px-3 py-2">
                          <p className="font-mono text-[10px] text-amber-400 tracking-widest uppercase mb-1">
                            ⚠ Temp Password (user hasn't changed it yet)
                          </p>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs text-primary flex-1">
                              {showTempPassword ? member.tempPassword : '••••••••••••••••'}
                            </span>
                            <button
                              type="button"
                              onClick={() => setShowTempPassword((v) => !v)}
                              className="font-mono text-[10px] text-muted hover:text-accent-ink tracking-widest transition-colors"
                            >
                              {showTempPassword ? 'HIDE' : 'SHOW'}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Reset result (new temp password just generated) */}
                      {resetResult && (
                        <div className="bg-status-success/10 border border-status-success/40 px-3 py-2">
                          <p className="font-mono text-[10px] text-accent-ink tracking-widest uppercase mb-1">
                            ✓ New Temp Password — Share with user:
                          </p>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs text-primary font-bold flex-1">
                              {showTempPassword ? resetResult : '••••••••••••••••'}
                            </span>
                            <button
                              type="button"
                              onClick={() => setShowTempPassword((v) => !v)}
                              className="font-mono text-[10px] text-muted hover:text-accent-ink tracking-widest"
                            >
                              {showTempPassword ? 'HIDE' : 'SHOW'}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Password status when already changed */}
                      {!member.mustChangePassword && !resetResult && (
                        <p className="font-mono text-[10px] text-muted">
                          ✓ User has set their own password
                        </p>
                      )}

                      <button
                        type="button"
                        onClick={() => void handleResetPassword()}
                        disabled={resettingPassword}
                        className="w-full border border-status-danger text-status-danger font-mono text-xs tracking-widest py-2 hover:bg-status-danger hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {resettingPassword ? 'RESETTING...' : 'RESET PASSWORD'}
                      </button>
                      <p className="font-mono text-[10px] text-muted leading-relaxed">
                        This will generate a new temp password and force the user to change it on next login.
                      </p>
                    </div>
                  )}

                  {/* Remove member — admin can remove EMPLOYEE; super_admin can also remove ADMIN.
                       Never shown for SUPER_ADMIN target or for the viewer's own profile. */}
                  {member.role !== 'SUPER_ADMIN' &&
                    member.id !== currentUserId &&
                    (isSuperAdmin || member.role === 'EMPLOYEE') && (
                    <div className="forge-card p-4 space-y-3 border-status-danger/30">
                      <p className="font-mono text-xs text-status-danger font-semibold tracking-wide">
                        Remove Member
                      </p>
                      <p className="font-mono text-[10px] text-muted leading-relaxed">
                        Deactivates this account. {member.name.split(' ')[0]} won&apos;t be able to log in or appear in lists. Their task and ticket history is preserved.
                      </p>
                      {!confirmingRemove ? (
                        <button
                          type="button"
                          onClick={() => setConfirmingRemove(true)}
                          className="w-full border border-status-danger text-status-danger font-mono text-xs tracking-widest py-2 hover:bg-status-danger hover:text-white transition-colors"
                        >
                          REMOVE MEMBER
                        </button>
                      ) : (
                        <div className="space-y-2">
                          <p className="font-mono text-[10px] text-status-danger leading-relaxed">
                            Are you sure? This will deactivate {member.name}&apos;s account immediately.
                          </p>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => setConfirmingRemove(false)}
                              disabled={removing}
                              className="flex-1 border border-border-default text-secondary font-mono text-xs tracking-widest py-2 hover:text-primary transition-colors disabled:opacity-40"
                            >
                              CANCEL
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleRemoveMember()}
                              disabled={removing}
                              className="flex-1 bg-status-danger text-white font-mono text-xs tracking-widest py-2 hover:opacity-90 transition-opacity disabled:opacity-40"
                            >
                              {removing ? 'REMOVING...' : 'CONFIRM REMOVE'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Send Notification */}
                  <div className="forge-card p-4 space-y-3">
                    <p className="font-mono text-xs text-secondary font-semibold tracking-wide">
                      Send Notification
                    </p>
                    <input
                      type="text"
                      placeholder="Title..."
                      value={notifTitle}
                      onChange={(e) => setNotifTitle(e.target.value)}
                      className="w-full border border-border-default bg-background-primary px-3 py-1.5 font-mono text-xs text-primary placeholder:text-muted focus:outline-none focus:border-accent transition-colors"
                    />
                    <textarea
                      placeholder="Message body..."
                      value={notifBody}
                      onChange={(e) => setNotifBody(e.target.value)}
                      rows={3}
                      className="w-full border border-border-default bg-background-primary px-3 py-1.5 font-mono text-xs text-primary placeholder:text-muted focus:outline-none focus:border-accent transition-colors resize-none"
                    />
                    <button
                      type="button"
                      onClick={() => void handleSendNotification()}
                      disabled={sending || !notifTitle.trim() || !notifBody.trim()}
                      className="w-full border border-accent text-accent-ink font-mono text-xs tracking-widest py-2 hover:bg-accent hover:text-background-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {sending ? 'SENDING...' : 'SEND NOTIFICATION'}
                    </button>
                  </div>
                </div>
              )}

              {/* Bottom spacer */}
              <div className="h-4" />
            </div>
          )}
        </div>
      </div>
    </>
  )
}
