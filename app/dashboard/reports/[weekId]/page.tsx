'use client'

import { useEffect, useState, useRef } from 'react'
import { CheckSquare, FolderOpen, NotebookPen, RefreshCw, Users } from 'lucide-react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'

import { useAuth } from '@/hooks/useAuth'
import { userCan } from '@/lib/permissions'
import { WeeklyReportEmployeeCard } from '@/components/reports/WeeklyReportEmployeeCard'
import type {
  WeeklyReportSnapshot,
  WeeklyReportSummary,
  WeeklyReportProjectSnapshot,
  ProjectReportSnapshot,
  ProjectReportProjectEntry,
  EmployeeReportSnapshot,
  EmployeeReportEntry,
} from '@/lib/types'

// ─── Types ────────────────────────────────────────────────────────────────────

type SortMode = 'activity' | 'tasks' | 'name'

type AnySnapshot = WeeklyReportSnapshot | ProjectReportSnapshot | EmployeeReportSnapshot

interface ReportFull extends WeeklyReportSummary {
  snapshot: AnySnapshot
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(date: Date | string) {
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function fmtShort(date: Date | string) {
  return new Date(date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReportDetailPage() {
  const router    = useRouter()
  const params    = useParams()
  const weekId    = params.weekId as string
  const { user, loading } = useAuth()

  const [report,     setReport]     = useState<ReportFull | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [sortMode,   setSortMode]   = useState<SortMode>('activity')
  const printRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!loading && user && !userCan(user, 'reports.view')) router.replace('/dashboard')
  }, [user, loading, router])

  useEffect(() => {
    if (!loading && user && userCan(user, 'reports.view') && weekId) {
      fetch(`/api/reports/${weekId}`)
        .then((r) => r.json())
        .then((body) => {
          if (body.error) setFetchError(body.error)
          else setReport(body.data as ReportFull)
        })
        .catch(() => setFetchError('Network error loading report'))
    }
  }, [loading, user, weekId])

  function handlePrint() {
    window.print()
  }

  // ── Loading / Error states ──────────────────────────────────────────────────
  if (loading || !user) return <Spinner />
  if (!userCan(user, 'reports.view')) return null
  if (fetchError) return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <BackLink /><div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">{fetchError}</div>
    </div>
  )
  if (!report) return <Spinner />

  const type = report.reportType ?? 'WEEKLY'

  return (
    <>
      {/* ── Print-only styles ───────────────────────────────────────────────── */}
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #report-printable, #report-printable * { visibility: visible !important; }
          #report-printable { position: fixed; inset: 0; padding: 32px; background: white; }
          .no-print { display: none !important; }
          @page { margin: 20mm; }
        }
      `}</style>

      <div className="max-w-5xl mx-auto px-4 py-8">
        {/* ── Toolbar ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between mb-5 no-print">
          <BackLink />
          <button
            onClick={handlePrint}
            className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            Export as PDF
          </button>
        </div>

        {/* ── Printable content ────────────────────────────────────────────── */}
        <div id="report-printable" ref={printRef}>
          {type === 'PROJECT'  && <ProjectReport  report={report} snapshot={report.snapshot as ProjectReportSnapshot}  />}
          {type === 'EMPLOYEE' && <EmployeeReport report={report} snapshot={report.snapshot as EmployeeReportSnapshot} sortMode={sortMode} setSortMode={setSortMode} />}
          {type === 'WEEKLY'   && <WeeklyReport   report={report} snapshot={report.snapshot as WeeklyReportSnapshot}   sortMode={sortMode} setSortMode={setSortMode} />}
        </div>
      </div>
    </>
  )
}

// ─── PROJECT REPORT ───────────────────────────────────────────────────────────

function ProjectReport({ report, snapshot }: { report: ReportFull; snapshot: ProjectReportSnapshot }) {
  const totalTasks     = snapshot.projects.reduce((s, p) => s + p.tasks.total,           0)
  const totalDone      = snapshot.projects.reduce((s, p) => s + p.tasks.completed,        0)
  const totalInRange   = snapshot.projects.reduce((s, p) => s + p.tasks.completedInRange, 0)
  const totalOverdue   = snapshot.projects.reduce((s, p) => s + p.tasks.overdue,          0)
  const totalTickets   = snapshot.projects.reduce((s, p) => s + p.ticketsInRange,         0)

  return (
    <div>
      {/* Header */}
      <div className="mb-6 border-b border-border-default pb-5">
        <div className="flex items-center gap-3 mb-1">
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-violet-100 text-violet-700 uppercase tracking-wide">Project Report</span>
          {report.label && <span className="text-sm text-text-muted">{report.label}</span>}
        </div>
        <h1 className="text-2xl font-bold text-text-primary mt-2">
          {fmt(snapshot.dateFrom)} – {fmt(snapshot.dateTo)}
        </h1>
        <p className="text-sm text-text-muted mt-1">Generated {fmt(report.generatedAt)}</p>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
        <StatCard label="Projects"         value={snapshot.projects.length} />
        <StatCard label="Total Tasks"      value={totalTasks} />
        <StatCard label="Completed"        value={totalDone} />
        <StatCard label="Done in Range"    value={totalInRange} />
        <StatCard label="Overdue"          value={totalOverdue} color={totalOverdue > 0 ? 'red' : undefined} />
      </div>

      {/* Project cards */}
      <div className="flex flex-col gap-6">
        {snapshot.projects.map((p) => (
          <ProjectCard key={p.projectId} project={p} />
        ))}
      </div>

      {totalTickets > 0 && (
        <p className="mt-6 text-sm text-text-muted text-right">Total tickets raised in range: <strong>{totalTickets}</strong></p>
      )}
    </div>
  )
}

function ProjectCard({ project: p }: { project: ProjectReportProjectEntry }) {
  const pct = p.tasks.total > 0 ? Math.round((p.tasks.completed / p.tasks.total) * 100) : 0
  const statusColor: Record<string, string> = {
    ACTIVE:    'bg-green-100 text-green-700',
    COMPLETED: 'bg-blue-100 text-blue-700',
    ON_HOLD:   'bg-yellow-100 text-yellow-700',
    CANCELLED: 'bg-red-100 text-red-700',
  }
  return (
    <div className="bg-surface-raised border border-border-default rounded-xl p-5">
      {/* Title row */}
      <div className="flex flex-wrap items-start justify-between gap-2 mb-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <h3 className="text-base font-bold text-text-primary">{p.name}</h3>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColor[p.status] ?? 'bg-surface-highlight text-text-secondary'}`}>
              {p.status.replace('_', ' ')}
            </span>
            {p.tasks.overdue > 0 && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                {p.tasks.overdue} overdue
              </span>
            )}
          </div>
          <p className="text-xs text-text-muted">
            Lead: {p.leadName ?? '—'} · {p.memberCount} member{p.memberCount !== 1 ? 's' : ''}
          </p>
        </div>
        {p.tasks.completedInRange > 0 && (
          <span className="text-xs font-semibold px-2 py-1 rounded-full bg-emerald-100 text-emerald-700">
            +{p.tasks.completedInRange} completed in range
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1 bg-surface-highlight rounded-full h-2 overflow-hidden">
          <div className="h-2 rounded-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs font-medium text-text-secondary shrink-0">
          {p.tasks.completed}/{p.tasks.total} tasks ({pct}%)
        </span>
      </div>
      <div className="flex gap-4 text-xs text-text-muted mb-4">
        <span>{p.tasks.inProgress} in progress</span>
        <span>{p.tasks.total - p.tasks.completed - p.tasks.inProgress} to-do</span>
        {p.ticketsInRange > 0 && <span>{p.ticketsInRange} ticket{p.ticketsInRange !== 1 ? 's' : ''} raised</span>}
      </div>

      {/* Member breakdown table */}
      {p.members.length > 0 && (
        <div className="border border-border-subtle rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-highlight">
              <tr>
                <th className="text-left px-3 py-2 text-xs font-semibold text-text-muted uppercase tracking-wide">Member</th>
                <th className="text-center px-3 py-2 text-xs font-semibold text-text-muted uppercase tracking-wide">Done</th>
                <th className="text-center px-3 py-2 text-xs font-semibold text-text-muted uppercase tracking-wide">In Progress</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {p.members.map((m) => (
                <tr key={m.userId} className="hover:bg-surface-highlight">
                  <td className="px-3 py-2 text-text-primary font-medium">{m.name}</td>
                  <td className="px-3 py-2 text-center text-text-secondary">{m.tasksCompleted}</td>
                  <td className="px-3 py-2 text-center text-text-secondary">{m.tasksInProgress}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── EMPLOYEE REPORT ──────────────────────────────────────────────────────────

function EmployeeReport({
  report,
  snapshot,
  sortMode,
  setSortMode,
}: {
  report: ReportFull
  snapshot: EmployeeReportSnapshot
  sortMode: SortMode
  setSortMode: (m: SortMode) => void
}) {
  const sorted = [...snapshot.employees].sort((a, b) => {
    if (sortMode === 'activity') return b.daysActive - a.daysActive
    if (sortMode === 'tasks')    return b.tasksCompleted.length - a.tasksCompleted.length
    return a.name.localeCompare(b.name)
  })

  const totalActive = snapshot.employees.reduce((s, e) => s + e.daysActive, 0)
  const totalDone   = snapshot.employees.reduce((s, e) => s + e.tasksCompleted.length, 0)
  const totalRaised = snapshot.employees.reduce((s, e) => s + e.ticketsRaised,  0)

  return (
    <div>
      {/* Header */}
      <div className="mb-6 border-b border-border-default pb-5">
        <div className="flex items-center gap-3 mb-1">
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-blue-100 text-blue-700 uppercase tracking-wide">Employee Report</span>
          {report.label && <span className="text-sm text-text-muted">{report.label}</span>}
        </div>
        <h1 className="text-2xl font-bold text-text-primary mt-2">
          {fmt(snapshot.dateFrom)} – {fmt(snapshot.dateTo)}
        </h1>
        <p className="text-sm text-text-muted mt-1">Generated {fmt(report.generatedAt)}</p>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
        <StatCard label="Employees"     value={snapshot.employees.length} />
        <StatCard label="Tasks Completed" value={totalDone} />
        <StatCard label="Tickets Raised"  value={totalRaised} />
      </div>

      {/* Sort control */}
      <div className="flex items-center justify-between mb-4 no-print">
        <h2 className="text-lg font-bold text-text-primary flex items-center gap-2"><Users className="h-5 w-5" aria-hidden="true" />Employee Activity</h2>
        <div className="flex items-center gap-2">
          <label className="text-sm text-text-secondary">Sort by:</label>
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            className="text-sm border border-border-default rounded-md px-3 py-1.5 bg-surface-raised focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="activity">Activity</option>
            <option value="tasks">Tasks Done</option>
            <option value="name">Name</option>
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {sorted.map((emp) => <EmployeeCard key={emp.userId} employee={emp} />)}
      </div>
    </div>
  )
}

function EmployeeCard({ employee: e }: { employee: EmployeeReportEntry }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="bg-surface-raised border border-border-default rounded-xl overflow-hidden">
      {/* Top row */}
      <div className="px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <h3 className="text-base font-bold text-text-primary">{e.name}</h3>
            <p className="text-xs text-text-muted">{e.email} · {e.role.replace('_', ' ')}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 font-medium">
              {e.daysActive} day{e.daysActive !== 1 ? 's' : ''} active
            </span>
            <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 font-medium">
              {e.tasksCompleted.length} done
            </span>
            {e.tasksInProgress.length > 0 && (
              <span className="px-2.5 py-1 rounded-full bg-yellow-50 text-yellow-700 font-medium">
                {e.tasksInProgress.length} in progress
              </span>
            )}
            {e.overdueTasksCount > 0 && (
              <span className="px-2.5 py-1 rounded-full bg-red-50 text-red-700 font-medium">
                {e.overdueTasksCount} overdue
              </span>
            )}
          </div>
        </div>

        {/* Project contributions */}
        {e.projects.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {e.projects.map((pr) => (
              <span key={pr.id} className="text-xs px-2 py-0.5 rounded-full bg-surface-highlight text-text-secondary">
                {pr.name} ({pr.tasksCompleted} done)
              </span>
            ))}
          </div>
        )}

        {/* Ticket counts */}
        {(e.ticketsRaised > 0 || e.ticketsHelped > 0) && (
          <p className="text-xs text-text-muted">
            Tickets raised: {e.ticketsRaised} · Tickets helped: {e.ticketsHelped}
          </p>
        )}
      </div>

      {/* Expand/collapse */}
      {(e.tasksCompleted.length > 0 || e.dailyLogs.length > 0) && (
        <>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="w-full text-left px-5 py-2.5 bg-surface-highlight border-t border-border-subtle text-xs font-medium text-text-secondary hover:bg-surface-highlight transition-colors no-print flex items-center justify-between"
          >
            <span>{expanded ? 'Hide details' : 'Show details'}</span>
            <svg className={`w-4 h-4 text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {expanded && (
            <div className="px-5 py-4 border-t border-border-subtle space-y-4">
              {/* Completed tasks */}
              {e.tasksCompleted.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2 flex items-center gap-1.5"><CheckSquare className="h-3.5 w-3.5" aria-hidden="true" />Completed Tasks</p>
                  <ul className="space-y-1">
                    {e.tasksCompleted.map((t) => (
                      <li key={t.id} className="text-sm text-text-secondary flex items-start gap-1.5">
                        <span className="text-text-muted mt-0.5">·</span>
                        <span>
                          <span className="font-medium">{t.title}</span>
                          <span className="text-text-muted text-xs ml-1">
                            — {t.projectName} · {new Date(t.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* In progress tasks */}
              {e.tasksInProgress.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2 flex items-center gap-1.5"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />In Progress</p>
                  <ul className="space-y-1">
                    {e.tasksInProgress.map((t) => (
                      <li key={t.id} className="text-sm text-text-secondary flex items-start gap-1.5">
                        <span className="text-text-muted mt-0.5">·</span>
                        <span>
                          <span className="font-medium">{t.title}</span>
                          <span className="text-text-muted text-xs ml-1">— {t.projectName}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Daily logs */}
              {e.dailyLogs.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2 flex items-center gap-1.5"><NotebookPen className="h-3.5 w-3.5" aria-hidden="true" />Daily Logs</p>
                  <div className="space-y-2">
                    {e.dailyLogs.map((log) => (
                      <div key={log.date} className="text-sm border-l-2 border-border-default pl-3">
                        <p className="text-xs font-semibold text-text-muted mb-0.5">
                          {new Date(log.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                        </p>
                        <p className="text-text-secondary">{log.workSummary}</p>
                        {log.notes && <p className="text-text-muted text-xs mt-0.5">{log.notes}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── WEEKLY REPORT (legacy) ───────────────────────────────────────────────────

function WeeklyReport({
  report,
  snapshot,
  sortMode,
  setSortMode,
}: {
  report: ReportFull
  snapshot: WeeklyReportSnapshot
  sortMode: SortMode
  setSortMode: (m: SortMode) => void
}) {
  const { companyStats } = snapshot
  const projects = snapshot.projects ?? []
  const activeProjects = projects.filter((p) => p.status === 'ACTIVE')
  const otherProjects  = projects.filter((p) => p.status !== 'ACTIVE')

  const sortedEmployees = [...snapshot.employees].sort((a, b) => {
    if (sortMode === 'activity') return b.daysActive - a.daysActive
    if (sortMode === 'tasks')    return b.tasksCompleted.length - a.tasksCompleted.length
    return a.name.localeCompare(b.name)
  })

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-surface-highlight text-text-secondary uppercase tracking-wide">Weekly Report</span>
        </div>
        <h1 className="text-2xl font-bold text-text-primary">
          {fmtShort(report.weekStart)} – {fmtShort(report.weekEnd)}
        </h1>
        <p className="text-sm text-text-muted mt-1">Generated {fmt(report.generatedAt)}</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-10">
        <StatCard label="Employees"        value={companyStats.totalEmployees} />
        <StatCard label="Active Projects"  value={companyStats.activeProjects ?? activeProjects.length} />
        <StatCard label="Days Active"      value={companyStats.totalDaysActive} />
        <StatCard label="Tasks Done"       value={companyStats.totalTasksCompleted} />
        <StatCard label="Tickets Raised"   value={companyStats.totalTicketsRaised} />
        <StatCard label="Tickets Resolved" value={companyStats.totalTicketsResolved} />
      </div>

      {/* Projects */}
      {projects.length > 0 && (
        <section className="mb-10">
          <h2 className="text-lg font-bold text-text-primary mb-4 flex items-center gap-2"><FolderOpen className="h-5 w-5" aria-hidden="true" />Project Progress</h2>
          {activeProjects.length > 0 && (
            <>
              <p className="text-xs font-semibold text-text-muted uppercase tracking-widest mb-3">Active ({activeProjects.length})</p>
              <div className="flex flex-col gap-3 mb-6">
                {activeProjects.map((p) => <WeeklyProjectRow key={p.projectId} project={p} />)}
              </div>
            </>
          )}
          {otherProjects.length > 0 && (
            <>
              <p className="text-xs font-semibold text-text-muted uppercase tracking-widest mb-3">Other ({otherProjects.length})</p>
              <div className="flex flex-col gap-3">
                {otherProjects.map((p) => <WeeklyProjectRow key={p.projectId} project={p} />)}
              </div>
            </>
          )}
        </section>
      )}

      {/* Employees */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-text-primary flex items-center gap-2"><Users className="h-5 w-5" aria-hidden="true" />Employee Activity</h2>
          <div className="flex items-center gap-2 no-print">
            <label className="text-sm text-text-secondary">Sort by:</label>
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              className="text-sm border border-border-default rounded-md px-3 py-1.5 bg-surface-raised focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="activity">Activity</option>
              <option value="tasks">Tasks Done</option>
              <option value="name">Name</option>
            </select>
          </div>
        </div>
        <div className="flex flex-col gap-4">
          {sortedEmployees.map((emp) => (
            <WeeklyReportEmployeeCard key={emp.userId} employee={emp} />
          ))}
        </div>
      </section>
    </div>
  )
}

function WeeklyProjectRow({ project: p }: { project: WeeklyReportProjectSnapshot }) {
  const pct = p.tasksTotal > 0 ? Math.round((p.tasksCompleted / p.tasksTotal) * 100) : 0
  const statusColor: Record<string, string> = {
    ACTIVE:    'bg-green-100 text-green-700',
    COMPLETED: 'bg-blue-100 text-blue-700',
    ON_HOLD:   'bg-yellow-100 text-yellow-700',
    CANCELLED: 'bg-red-100 text-red-700',
  }
  return (
    <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-text-primary">{p.name}</p>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColor[p.status] ?? 'bg-surface-highlight text-text-secondary'}`}>
              {p.status.replace('_', ' ')}
            </span>
            {p.tasksOverdue > 0 && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                {p.tasksOverdue} overdue
              </span>
            )}
          </div>
          <p className="text-xs text-text-muted mt-0.5">
            Lead: {p.leadName ?? '—'} · {p.memberCount} member{p.memberCount !== 1 ? 's' : ''}
          </p>
        </div>
        {p.completedThisWeek > 0 && (
          <span className="text-xs font-semibold px-2 py-1 rounded-full bg-emerald-100 text-emerald-700">
            +{p.completedThisWeek} done this week
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <div className="flex-1 bg-surface-highlight rounded-full h-2 overflow-hidden">
          <div className="h-2 rounded-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs font-medium text-text-secondary w-20 text-right">
          {p.tasksCompleted}/{p.tasksTotal} ({pct}%)
        </span>
      </div>
      <div className="flex gap-4 mt-2 text-xs text-text-muted">
        <span>{p.tasksInProgress} in progress</span>
        <span>{p.tasksTotal - p.tasksCompleted - p.tasksInProgress} to-do</span>
      </div>
    </div>
  )
}

// ─── Shared atoms ─────────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: number | string; color?: 'red' }) {
  return (
    <div className="bg-surface-raised border border-border-default rounded-lg p-4">
      <p className="text-xs text-text-muted uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-xl font-bold ${color === 'red' ? 'text-red-600' : 'text-text-primary'}`}>{value}</p>
    </div>
  )
}

function BackLink() {
  return (
    <Link href="/dashboard/reports" className="text-blue-600 hover:text-blue-800 text-sm font-medium inline-flex items-center gap-1">
      ← Back to Reports
    </Link>
  )
}

function Spinner() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
    </div>
  )
}
