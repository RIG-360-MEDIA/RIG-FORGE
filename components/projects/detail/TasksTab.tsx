'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { TaskSummary, PaginatedResponse, ApiResponse, TaskCategorySummary } from '@/lib/types'
import TaskFormModal, { type Member } from './tasks/TaskFormModal'
import ManageCategoriesModal from './tasks/ManageCategoriesModal'

// ─── Types ────────────────────────────────────────────────────────────────────

type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE'
type Priority   = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface TasksTabProps {
  projectId: string
  /** projects.manage: shown the project-level admin controls. */
  isAdmin: boolean
  isLead: boolean
  currentUserId: string
  /**
   * May this user raise a new task here? True for anyone on the project, which
   * is everyone who can open this tab, EXCEPT external client/supplier users.
   * Separate from managing the list (assigning, bulk edits, categories), which
   * is for admins and the project lead.
   */
  canCreate: boolean
  /** tasks.manage: may assign and edit any task, and rename or archive categories. */
  canManageAllTasks?: boolean
}

type FilterMode = 'all' | 'mine' | 'unassigned' | 'open' | 'done'

/** Group key for tasks without a category. */
const NONE = '__none__'

/** Offered when a company adds its first categories; any name can be typed instead. */
const SUGGESTED_CATEGORIES = [
  'Civil', 'Structure', 'Electrical', 'Plumbing', 'HVAC', 'Interior', 'Furniture',
  'Landscape', 'Drawings', 'Approvals', 'Site visits', 'Client meetings',
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PRIORITY_STYLES: Record<Priority, string> = {
  LOW:      'bg-gray-700 text-gray-300',
  MEDIUM:   'bg-blue-900 text-blue-300',
  HIGH:     'bg-orange-900 text-orange-300',
  CRITICAL: 'bg-red-900 text-red-300',
}

/** Marks a task can carry. 5 means payment related — see lib/tasks.ts. */
const PAYMENT_POINTS = 5
const POINTS_LABELS: Record<number, string> = {
  1: '1 mark — small task',
  2: '2 marks — bigger task',
  5: '5 marks — payment related',
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  TODO:        'To Do',
  IN_PROGRESS: 'In Progress',
  DONE:        'Done',
}

const FILTER_LABELS: Record<FilterMode, string> = {
  all: 'All', mine: 'My Tasks', unassigned: 'Unassigned', open: 'Open', done: 'Done',
}

function isOverdue(task: TaskSummary): boolean {
  if (!task.dueDate || task.status === 'DONE') return false
  return new Date(task.dueDate) < new Date()
}

function formatDate(date: Date | string | null): string {
  if (!date) return 'No due date'
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** yyyy-mm-dd for a date input. */
function toDateInput(date: Date | string | null): string {
  return date ? new Date(date).toISOString().slice(0, 10) : ''
}

const STATUS_RANK: Record<string, number> = { IN_PROGRESS: 0, TODO: 1, DONE: 2 }

/** Work in progress first, then to-do by due date, done last; ties keep the order they were added. */
function compareTasks(a: TaskSummary, b: TaskSummary): number {
  const s = (STATUS_RANK[a.status] ?? 1) - (STATUS_RANK[b.status] ?? 1)
  if (s !== 0) return s
  const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity
  const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity
  if (da !== db) return da - db
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
}

/** Non-empty lines of pasted text, list bullets and numbering removed. */
function pastedLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•▪◦]|\d{1,3}[.)])\s+/, '').trim())
    .filter(Boolean)
}

const chipClass =
  'text-xs bg-transparent border border-transparent hover:border-border-default focus:border-accent rounded px-1.5 py-0.5 text-primary focus:outline-none cursor-pointer [color-scheme:light]'
const optionClass = 'bg-background-primary text-primary'

// ─── TaskRow ──────────────────────────────────────────────────────────────────

interface TaskRowProps {
  task: TaskSummary
  currentUserId: string
  canManage: boolean
  members: Member[]
  openCounts: Map<string, number>
  selected: boolean
  onToggleSelect: (taskId: string) => void
  onPatch: (taskId: string, change: Record<string, unknown>) => Promise<void>
  onEdit: (task: TaskSummary) => void
  onDelete: (task: TaskSummary) => void
}

function TaskRow({
  task, currentUserId, canManage, members, openCounts, selected, onToggleSelect, onPatch, onEdit, onDelete,
}: TaskRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [updating, setUpdating] = useState(false)

  const overdue    = isOverdue(task)
  const isAssignee = task.assigneeId === currentUserId
  // Status can be changed by admin/lead or the task's assignee; everything
  // else on the row only by admin/lead. Others see read-only text.
  const canChangeStatus = canManage || isAssignee
  const done = task.status === 'DONE'

  async function patch(change: Record<string, unknown>) {
    setUpdating(true)
    await onPatch(task.id, change)
    setUpdating(false)
  }

  // A task assigned to someone no longer in the member list still shows their name.
  const assigneeMissing = task.assigneeId && !members.some((m) => m.userId === task.assigneeId)

  return (
    <div className={`border-b border-border-default ${selected ? 'bg-accent/5' : ''}`}>
      <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 ${done ? 'opacity-60' : ''}`}>
        {canManage && (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(task.id)}
            aria-label={`Select task ${task.title}`}
            className="accent-[rgb(var(--c-accent))] h-4 w-4 shrink-0 cursor-pointer"
          />
        )}

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex-1 min-w-[12rem] text-left"
          title="Show details"
        >
          {/* Payment-related tasks read in red so they stand out in a long list. */}
          <span className={`text-sm font-medium ${done ? 'line-through' : ''} ${
            task.points === PAYMENT_POINTS ? 'text-status-danger' : 'text-primary'
          }`}>
            {task.title}
          </span>
        </button>

        {/* Assignee */}
        <div className="w-36 shrink-0">
          {canManage ? (
            <select
              value={task.assigneeId ?? ''}
              disabled={updating}
              onChange={(e) => void patch({ assigneeId: e.target.value || null })}
              aria-label={`Assignee for ${task.title}`}
              className={`${chipClass} w-full truncate ${task.assigneeId ? '' : 'text-muted'}`}
            >
              <option value="" className={optionClass}>+ Assign</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId} className={optionClass}>
                  {/* Open-task count helps pick someone, but only in the list, not on the chosen name. */}
                  {m.name}{m.userId !== task.assigneeId && openCounts.get(m.userId) ? ` (${openCounts.get(m.userId)} open)` : ''}
                </option>
              ))}
              {assigneeMissing && (
                <option value={task.assigneeId!} className={optionClass}>{task.assigneeName ?? 'Former member'}</option>
              )}
            </select>
          ) : (
            <span className="text-xs text-muted truncate block">{task.assigneeName ?? 'Unassigned'}</span>
          )}
        </div>

        {/* Due date */}
        <div className="w-32 shrink-0">
          {canManage ? (
            <input
              type="date"
              value={toDateInput(task.dueDate)}
              min={toDateInput(task.startDate) || undefined}
              disabled={updating}
              onChange={(e) => void patch({ dueDate: e.target.value || null })}
              aria-label={`Due date for ${task.title}`}
              className={`${chipClass} w-full ${overdue ? 'text-status-danger' : task.dueDate ? '' : 'text-muted'}`}
            />
          ) : (
            <span className={`text-xs ${overdue ? 'text-status-danger' : 'text-muted'}`}>{formatDate(task.dueDate)}</span>
          )}
        </div>

        {/* Priority + marks */}
        <div className="flex items-center gap-1.5 w-28 shrink-0">
          {canManage ? (
            <select
              value={task.priority}
              disabled={updating}
              onChange={(e) => void patch({ priority: e.target.value })}
              aria-label={`Priority for ${task.title}`}
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase border-0 cursor-pointer focus:outline-none ${PRIORITY_STYLES[task.priority as Priority] ?? PRIORITY_STYLES.MEDIUM}`}
            >
              {(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as Priority[]).map((p) => (
                <option key={p} value={p} className={optionClass}>{p}</option>
              ))}
            </select>
          ) : (
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${PRIORITY_STYLES[task.priority as Priority] ?? PRIORITY_STYLES.MEDIUM}`}>
              {task.priority}
            </span>
          )}
          {task.points != null && (
            <span
              title={POINTS_LABELS[task.points] ?? `${task.points} marks`}
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                task.points === PAYMENT_POINTS ? 'bg-status-danger/20 text-status-danger' : 'bg-surface-raised text-muted'
              }`}
            >
              {task.points}
            </span>
          )}
        </div>

        {/* Status */}
        <div className="w-28 shrink-0">
          {canChangeStatus ? (
            <select
              value={task.status}
              disabled={updating}
              onChange={(e) => void patch({ status: e.target.value })}
              aria-label={`Status for ${task.title}`}
              className="text-xs bg-background-primary border border-border-default rounded px-2 py-1 text-primary focus:outline-none focus:border-accent disabled:opacity-50 [color-scheme:light] w-full"
            >
              <option value="TODO" className={optionClass}>To Do</option>
              <option value="IN_PROGRESS" className={optionClass}>In Progress</option>
              <option value="DONE" className={optionClass}>Done</option>
            </select>
          ) : (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded uppercase bg-surface-sunken text-secondary">
              {STATUS_LABELS[task.status as TaskStatus] ?? task.status}
            </span>
          )}
        </div>

        {canManage && (
          <div className="shrink-0 whitespace-nowrap">
            <button type="button" onClick={() => onEdit(task)} className="text-xs text-secondary hover:text-primary px-2 py-1 transition-colors" title="Edit task">
              Edit
            </button>
            <button type="button" onClick={() => onDelete(task)} className="text-xs text-secondary hover:text-status-danger px-2 py-1 transition-colors" title="Delete task">
              Delete
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="px-6 pb-4 pt-1 space-y-2 text-sm bg-surface-raised/30">
          {task.description && (
            <div>
              <span className="text-muted text-xs uppercase tracking-wider">Description</span>
              <p className="mt-1 text-foreground whitespace-pre-line">{task.description}</p>
            </div>
          )}
          {task.expectedOutput && (
            <div>
              <span className="text-muted text-xs uppercase tracking-wider">Expected Output</span>
              <p className="mt-1 text-foreground">{task.expectedOutput}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted pt-1">
            <span>Category: <span className="text-foreground">{task.categoryName ?? 'None'}</span></span>
            <span>Status: <span className="text-foreground">{STATUS_LABELS[task.status as TaskStatus] ?? task.status}</span></span>
            <span>Marks: <span className={task.points === PAYMENT_POINTS ? 'text-status-danger' : 'text-foreground'}>
              {task.points != null ? (POINTS_LABELS[task.points] ?? task.points) : '—'}
            </span></span>
            <span>Assignee: <span className="text-foreground">{task.assigneeName ?? 'Unassigned'}</span></span>
            <span>Start: <span className="text-foreground">{formatDate(task.startDate)}</span></span>
            <span>Due: <span className="text-foreground">{formatDate(task.dueDate)}</span></span>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── QuickAdd ─────────────────────────────────────────────────────────────────

interface QuickAddProps {
  label: string
  /** Pasting several lines adds one task per line (admins and the lead only). */
  allowPasteMany: boolean
  inputRef?: (el: HTMLInputElement | null) => void
  onAdd: (title: string) => Promise<boolean>
  onAddMany: (titles: string[]) => Promise<boolean>
}

/** "+ Add task" at the foot of a category: type, Enter, type the next one. */
function QuickAdd({ label, allowPasteMany, inputRef, onAdd, onAddMany }: QuickAddProps) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<string[] | null>(null)

  // The box clears at once and the task saves in the background, so the next
  // title can be typed straight away; a title that fails to save comes back.
  async function submit() {
    const title = value.trim()
    if (!title) return
    setValue('')
    if (!(await onAdd(title))) setValue((v) => v || title)
  }

  async function addPending() {
    if (!pending) return
    setBusy(true)
    if (await onAddMany(pending)) setPending(null)
    setBusy(false)
  }

  return (
    <div className="px-4 py-2">
      <input
        ref={inputRef}
        value={value}
        // Only a pasted list blocks the box (while it saves); never disabled,
        // since a disabled box loses focus.
        readOnly={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void submit() }
          if (e.key === 'Escape') { setValue(''); setPending(null) }
        }}
        onPaste={(e) => {
          if (!allowPasteMany) return
          const lines = pastedLines(e.clipboardData.getData('text'))
          if (lines.length > 1) { e.preventDefault(); setPending(lines.slice(0, 200)) }
        }}
        maxLength={200}
        placeholder={allowPasteMany ? `+ Add task to ${label} (Enter to add; paste a list to add many)` : `+ Add task to ${label}`}
        aria-label={`Add a task to ${label}`}
        className={`w-full bg-transparent border border-dashed border-border-default rounded px-3 py-1.5 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-accent focus:border-solid ${busy ? 'opacity-60' : ''}`}
      />
      {pending && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs bg-surface-raised border border-border-default rounded px-3 py-2">
          <span className="text-primary">
            Add {pending.length} tasks to {label}?
          </span>
          <span className="text-muted truncate max-w-[24rem]">
            {pending.slice(0, 3).join(', ')}{pending.length > 3 ? ', ...' : ''}
          </span>
          <span className="ml-auto flex gap-2">
            <button type="button" disabled={busy} onClick={() => void addPending()} className="px-3 py-1 rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50">
              {busy ? 'Adding...' : `Add ${pending.length} tasks`}
            </button>
            <button type="button" disabled={busy} onClick={() => setPending(null)} className="px-2 py-1 text-secondary hover:text-primary">
              Cancel
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

// ─── CategoryGroup ────────────────────────────────────────────────────────────

interface CategoryGroupProps {
  label: string
  tasks: TaskSummary[]
  /** Every task in this category, ignoring the filter, for the progress count. */
  allInCategory: TaskSummary[]
  collapsed: boolean
  onToggleCollapsed: () => void
  canManage: boolean
  canCreate: boolean
  selectedIds: Set<string>
  onSelectMany: (ids: string[], select: boolean) => void
  quickAddRef: (el: HTMLInputElement | null) => void
  onQuickAdd: (title: string) => Promise<boolean>
  onQuickAddMany: (titles: string[]) => Promise<boolean>
  rowProps: Omit<TaskRowProps, 'task' | 'selected'>
}

function CategoryGroup({
  label, tasks, allInCategory, collapsed, onToggleCollapsed, canManage, canCreate, selectedIds,
  onSelectMany, quickAddRef, onQuickAdd, onQuickAddMany, rowProps,
}: CategoryGroupProps) {
  const doneCount = allInCategory.filter((t) => t.status === 'DONE').length
  const total = allInCategory.length
  const pct = total ? Math.round((doneCount / total) * 100) : 0
  const allSelected = tasks.length > 0 && tasks.every((t) => selectedIds.has(t.id))

  return (
    <section className="border border-border-default rounded-lg overflow-hidden">
      <header className="flex items-center gap-3 px-4 py-2.5 bg-surface-raised/60 border-b border-border-default">
        {canManage && tasks.length > 0 && (
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => onSelectMany(tasks.map((t) => t.id), !allSelected)}
            aria-label={`Select all tasks in ${label}`}
            className="accent-[rgb(var(--c-accent))] h-4 w-4 cursor-pointer"
          />
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          className="flex items-center gap-2 text-left"
        >
          <span className="text-xs text-muted w-3">{collapsed ? '+' : '−'}</span>
          <span className="text-sm font-semibold tracking-wide text-primary uppercase">{label}</span>
        </button>
        <span className="text-xs text-muted">{doneCount}/{total} done</span>
        {total > 0 && (
          <div className="hidden sm:block w-24 h-1.5 rounded bg-surface-sunken overflow-hidden" aria-hidden>
            <div className="h-full bg-status-success" style={{ width: `${pct}%` }} />
          </div>
        )}
      </header>

      {!collapsed && (
        <div>
          {tasks.length === 0 && (
            <p className="text-xs text-muted px-4 py-3 italic">
              {total === 0 ? 'No tasks yet.' : 'No tasks match this filter.'}
            </p>
          )}
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} selected={selectedIds.has(t.id)} {...rowProps} />
          ))}
          {canCreate && (
            <QuickAdd
              label={label}
              allowPasteMany={canManage}
              inputRef={quickAddRef}
              onAdd={onQuickAdd}
              onAddMany={onQuickAddMany}
            />
          )}
        </div>
      )}
    </section>
  )
}

// ─── BulkBar ──────────────────────────────────────────────────────────────────

interface BulkBarProps {
  count: number
  members: Member[]
  categories: TaskCategorySummary[]
  busy: boolean
  onApply: (set: Record<string, unknown>) => void
  onClear: () => void
}

/** Shown while tasks are ticked: each control applies to all of them at once. */
function BulkBar({ count, members, categories, busy, onApply, onClear }: BulkBarProps) {
  const ctl = 'text-xs bg-background-primary border border-border-default rounded px-2 py-1.5 text-primary focus:outline-none focus:border-accent disabled:opacity-50 [color-scheme:light]'
  return (
    <div className="sticky bottom-4 z-30">
      <div className="flex flex-wrap items-center gap-2 bg-surface-raised border border-accent/40 shadow-lg rounded-lg px-4 py-3">
        <span className="text-sm font-medium text-primary mr-1">{count} selected</span>
        <select value="" disabled={busy} onChange={(e) => e.target.value && onApply({ assigneeId: e.target.value === NONE ? null : e.target.value })} aria-label="Assign selected tasks to" className={ctl}>
          <option value="" className={optionClass}>Assign to...</option>
          {members.map((m) => <option key={m.userId} value={m.userId} className={optionClass}>{m.name}</option>)}
          <option value={NONE} className={optionClass}>Unassign</option>
        </select>
        <label className="flex items-center gap-1 text-xs text-muted">
          Due
          <input type="date" disabled={busy} onChange={(e) => e.target.value && onApply({ dueDate: e.target.value })} aria-label="Due date for selected tasks" className={ctl} />
        </label>
        <select value="" disabled={busy} onChange={(e) => e.target.value && onApply({ priority: e.target.value })} aria-label="Priority for selected tasks" className={ctl}>
          <option value="" className={optionClass}>Priority...</option>
          {(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as Priority[]).map((p) => <option key={p} value={p} className={optionClass}>{p}</option>)}
        </select>
        <select value="" disabled={busy} onChange={(e) => e.target.value && onApply({ categoryId: e.target.value === NONE ? null : e.target.value })} aria-label="Move selected tasks to category" className={ctl}>
          <option value="" className={optionClass}>Move to...</option>
          {categories.map((c) => <option key={c.id} value={c.id} className={optionClass}>{c.name}</option>)}
          <option value={NONE} className={optionClass}>No category</option>
        </select>
        <select value="" disabled={busy} onChange={(e) => e.target.value && onApply({ status: e.target.value })} aria-label="Status for selected tasks" className={ctl}>
          <option value="" className={optionClass}>Status...</option>
          <option value="TODO" className={optionClass}>To Do</option>
          <option value="IN_PROGRESS" className={optionClass}>In Progress</option>
          <option value="DONE" className={optionClass}>Done</option>
        </select>
        <button type="button" onClick={onClear} disabled={busy} className="ml-auto text-xs text-secondary hover:text-primary px-2 py-1">
          Clear selection
        </button>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TasksTab({ projectId, isAdmin, isLead, currentUserId, canCreate, canManageAllTasks }: TasksTabProps) {
  const canManage = isAdmin || isLead || !!canManageAllTasks

  const [tasks, setTasks]               = useState<TaskSummary[]>([])
  const [members, setMembers]           = useState<Member[]>([])
  const [categories, setCategories]     = useState<TaskCategorySummary[]>([])
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState<string | null>(null)
  const [notice, setNotice]             = useState<string | null>(null)
  const [filter, setFilter]             = useState<FilterMode>(canManage ? 'all' : 'mine')
  const [search, setSearch]             = useState('')
  const [collapsed, setCollapsed]       = useState<Set<string>>(new Set())
  const [selected, setSelected]         = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy]         = useState(false)
  // Categories added in this visit, shown even before they hold a task, so
  // the new group's "+ Add task" is right there to type into.
  const [shownEmpty, setShownEmpty]     = useState<string[]>([])
  const [addingCategory, setAddingCategory] = useState(false)
  const [categoryDraft, setCategoryDraft]   = useState('')
  const [showModal, setShowModal]       = useState(false)
  const [modalCategoryId, setModalCategoryId] = useState<string | null>(null)
  const [manageCategories, setManageCategories] = useState(false)
  const [editingTask, setEditingTask]   = useState<TaskSummary | null>(null)
  const [deletingTask, setDeletingTask] = useState<TaskSummary | null>(null)
  const [deleteSubmitting, setDeleteSubmitting] = useState(false)
  const [deleteError, setDeleteError]   = useState<string | null>(null)
  const quickAddInputs = useRef(new Map<string, HTMLInputElement>())
  const focusAfterRender = useRef<string | null>(null)

  const flash = useCallback((message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice((m) => (m === message ? null : m)), 4000)
  }, [])

  const fetchTasks = useCallback(async () => {
    setError(null)
    try {
      const params = new URLSearchParams({ projectId, limit: '500' })
      const res = await fetch(`/api/tasks?${params}`, { credentials: 'include' })
      const json = await res.json() as ApiResponse<PaginatedResponse<TaskSummary>>
      if (!res.ok || json.error) {
        setError(json.error ?? 'Failed to load tasks.')
        return
      }
      setTasks(json.data?.items ?? [])
    } catch {
      setError('Network error loading tasks.')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const fetchMembers = useCallback(async () => {
    try {
      // includeSuperAdmins: a super admin can be given a task on any project
      // without being added to it, so they must appear in the assignee picker.
      const res = await fetch(`/api/projects/${projectId}/members?includeSuperAdmins=1`, { credentials: 'include' })
      if (!res.ok) return
      const json = await res.json() as ApiResponse<Member[]>
      if (json.data) setMembers(json.data)
    } catch {
      // Members are optional for the pickers — fail silently
    }
  }, [projectId])

  const fetchCategories = useCallback(async () => {
    try {
      const res = await fetch('/api/task-categories', { credentials: 'include' })
      if (!res.ok) return
      const json = await res.json() as ApiResponse<TaskCategorySummary[]>
      if (json.data) setCategories(json.data)
    } catch {
      // Without categories every task shows in one group — fail silently
    }
  }, [])

  useEffect(() => {
    void fetchTasks()
    void fetchMembers()
    void fetchCategories()
  }, [fetchTasks, fetchMembers, fetchCategories])

  // Focus a group's quick-add box once it has rendered (after adding a category).
  useEffect(() => {
    const key = focusAfterRender.current
    if (!key) return
    const el = quickAddInputs.current.get(key)
    if (el) { el.focus(); focusAfterRender.current = null }
  })

  // ── Writes ─────────────────────────────────────────────────────────────────

  const replaceTasks = useCallback((updated: TaskSummary[]) => {
    const byId = new Map(updated.map((t) => [t.id, t]))
    setTasks((prev) => prev.map((t) => byId.get(t.id) ?? t))
  }, [])

  async function handlePatch(taskId: string, change: Record<string, unknown>): Promise<void> {
    // Optimistic for status (the common one-click change); others wait for the server.
    if (Object.keys(change).length === 1 && 'status' in change) {
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: change.status as string } : t)))
    }
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(change),
      })
      const json = await res.json() as ApiResponse<TaskSummary>
      if (!res.ok || json.error || !json.data) {
        setError(json.error ?? 'Could not save that change.')
        void fetchTasks()
        return
      }
      replaceTasks([json.data])
    } catch {
      setError('Network error. Please try again.')
      void fetchTasks()
    }
  }

  async function createOne(title: string, categoryId: string | null): Promise<boolean> {
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ projectId, title, categoryId }),
      })
      const json = await res.json() as ApiResponse<TaskSummary>
      if (!res.ok || json.error || !json.data) { setError(json.error ?? 'Could not add the task.'); return false }
      setTasks((prev) => [...prev, json.data!])
      // A new task is unassigned: make sure the current filter does not hide it.
      if (filter === 'mine' || filter === 'done') setFilter('all')
      return true
    } catch {
      setError('Network error. Please try again.')
      return false
    }
  }

  async function createMany(titles: string[], categoryId: string | null): Promise<boolean> {
    try {
      const res = await fetch('/api/tasks/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ projectId, titles, categoryId }),
      })
      const json = await res.json() as ApiResponse<TaskSummary[]>
      if (!res.ok || json.error || !json.data) { setError(json.error ?? 'Could not add the tasks.'); return false }
      setTasks((prev) => [...prev, ...json.data!])
      if (filter === 'mine' || filter === 'done') setFilter('all')
      flash(`Added ${json.data.length} tasks.`)
      return true
    } catch {
      setError('Network error. Please try again.')
      return false
    }
  }

  async function applyBulk(set: Record<string, unknown>) {
    const ids = [...selected]
    if (ids.length === 0) return
    setBulkBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/tasks/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ taskIds: ids, set }),
      })
      const json = await res.json() as ApiResponse<TaskSummary[]>
      if (!res.ok || json.error || !json.data) { setError(json.error ?? 'Could not update the tasks.'); return }
      replaceTasks(json.data)
      const n = json.data.length
      const what = 'assigneeId' in set
        ? (set.assigneeId ? `Assigned ${n} tasks to ${members.find((m) => m.userId === set.assigneeId)?.name ?? 'them'}` : `Unassigned ${n} tasks`)
        : 'categoryId' in set ? `Moved ${n} tasks`
        : `Updated ${n} tasks`
      flash(`${what}.`)
      setSelected(new Set())
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setBulkBusy(false)
    }
  }

  async function addCategory(name: string) {
    const clean = name.trim()
    if (!clean) return
    try {
      const res = await fetch('/api/task-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: clean, projectId }),
      })
      const json = await res.json() as ApiResponse<TaskCategorySummary>
      if (!res.ok || json.error || !json.data) { setError(json.error ?? 'Could not add the category.'); return }
      const cat = json.data
      setCategories((prev) => (prev.some((c) => c.id === cat.id) ? prev : [...prev, cat]))
      setShownEmpty((prev) => (prev.includes(cat.id) ? prev : [...prev, cat.id]))
      setCollapsed((prev) => { const next = new Set(prev); next.delete(cat.id); return next })
      setCategoryDraft('')
      setAddingCategory(false)
      focusAfterRender.current = cat.id
    } catch {
      setError('Network error. Please try again.')
    }
  }

  async function handleDeleteConfirm() {
    if (!deletingTask) return
    setDeleteSubmitting(true)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/tasks/${deletingTask.id}`, { method: 'DELETE', credentials: 'include' })
      const json = await res.json() as ApiResponse<{ id: string }>
      if (!res.ok || json.error) {
        setDeleteError(json.error ?? 'Failed to delete task.')
        return
      }
      setTasks((prev) => prev.filter((t) => t.id !== deletingTask.id))
      setSelected((prev) => { const next = new Set(prev); next.delete(deletingTask.id); return next })
      setDeletingTask(null)
    } catch {
      setDeleteError('Network error. Please try again.')
    } finally {
      setDeleteSubmitting(false)
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const openCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of tasks) if (t.assigneeId && t.status !== 'DONE') m.set(t.assigneeId, (m.get(t.assigneeId) ?? 0) + 1)
    return m
  }, [tasks])

  const filtered = useMemo(() => tasks.filter((t) => {
    if (filter === 'mine' && t.assigneeId !== currentUserId) return false
    if (filter === 'unassigned' && t.assigneeId) return false
    if (filter === 'open' && t.status === 'DONE') return false
    if (filter === 'done' && t.status !== 'DONE') return false
    if (search.trim()) {
      const q = search.toLowerCase()
      return t.title.toLowerCase().includes(q)
        || (t.assigneeName?.toLowerCase().includes(q) ?? false)
        || (t.categoryName?.toLowerCase().includes(q) ?? false)
    }
    return true
  }), [tasks, filter, search, currentUserId])

  /** Groups in category order; "No category" last. A category shows when it has tasks or was just added. */
  const groups = useMemo(() => {
    const byKey = new Map<string, TaskSummary[]>()
    for (const t of tasks) {
      const key = t.categoryId ?? NONE
      byKey.set(key, [...(byKey.get(key) ?? []), t])
    }
    const out: { key: string; label: string; categoryId: string | null }[] = []
    for (const c of categories) {
      if (byKey.has(c.id) || shownEmpty.includes(c.id)) out.push({ key: c.id, label: c.name, categoryId: c.id })
    }
    // Archived categories that tasks still carry.
    for (const [key, list] of byKey) {
      if (key !== NONE && !categories.some((c) => c.id === key)) {
        out.push({ key, label: list[0]?.categoryName ?? 'Archived category', categoryId: key })
      }
    }
    if (byKey.has(NONE) || out.length === 0) {
      out.push({ key: NONE, label: out.length === 0 ? 'Tasks' : 'No category', categoryId: null })
    }
    return out.map((g) => ({
      ...g,
      all: byKey.get(g.key) ?? [],
      visible: filtered.filter((t) => (t.categoryId ?? NONE) === g.key).sort(compareTasks),
    }))
  }, [tasks, filtered, categories, shownEmpty])

  const filtering = filter !== 'all' || search.trim() !== ''
  const unusedSuggestions = SUGGESTED_CATEGORIES.filter(
    (s) => !categories.some((c) => c.name.toLowerCase() === s.toLowerCase()),
  )

  function toggleSelect(id: string) {
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  function selectMany(ids: string[], on: boolean) {
    setSelected((prev) => { const next = new Set(prev); for (const id of ids) { if (on) next.add(id); else next.delete(id) } return next })
  }

  const rowProps = {
    currentUserId, canManage, members, openCounts,
    onToggleSelect: toggleSelect, onPatch: handlePatch, onEdit: setEditingTask, onDelete: setDeletingTask,
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'mine', 'unassigned', 'open', 'done'] as FilterMode[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={[
              'px-3 py-1.5 text-xs font-medium rounded transition-colors',
              filter === f ? 'bg-accent text-white' : 'bg-surface-raised text-secondary hover:text-primary',
            ].join(' ')}
          >
            {FILTER_LABELS[f]}
          </button>
        ))}

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tasks…"
          className="ml-auto bg-surface-raised border border-border-default rounded px-3 py-1.5 text-xs focus:outline-none focus:border-accent w-48"
        />

        {canManage && (
          <button
            type="button"
            onClick={() => setAddingCategory((v) => !v)}
            className="px-3 py-1.5 text-xs font-medium rounded bg-surface-raised text-primary border border-border-default hover:border-accent transition-colors"
          >
            + Category
          </button>
        )}
        {canManageAllTasks && (
          <button
            type="button"
            onClick={() => setManageCategories(true)}
            className="px-3 py-1.5 text-xs font-medium rounded bg-surface-raised text-secondary hover:text-primary transition-colors"
          >
            Manage categories
          </button>
        )}
        {/* canCreate, not canManage: anyone on the project may raise a task,
            but only admins and the lead may assign, edit or delete. */}
        {canCreate && (
          <button
            type="button"
            onClick={() => { setModalCategoryId(null); setShowModal(true) }}
            className="px-3 py-1.5 text-xs font-medium rounded bg-accent text-white hover:bg-accent/80 transition-colors"
          >
            + New Task
          </button>
        )}
      </div>

      {/* Add a category */}
      {addingCategory && (
        <div className="bg-surface-raised border border-border-default rounded-lg px-4 py-3 space-y-2">
          <div className="flex gap-2">
            <input
              autoFocus
              value={categoryDraft}
              onChange={(e) => setCategoryDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addCategory(categoryDraft)
                if (e.key === 'Escape') setAddingCategory(false)
              }}
              maxLength={60}
              placeholder="Category name, e.g. Electrical"
              aria-label="New category name"
              className="flex-1 bg-background-primary border border-border-default rounded px-3 py-1.5 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-accent"
            />
            <button type="button" onClick={() => void addCategory(categoryDraft)} className="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent-hover">Add</button>
            <button type="button" onClick={() => setAddingCategory(false)} className="px-2 py-1.5 text-xs text-secondary hover:text-primary">Cancel</button>
          </div>
          {unusedSuggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted mr-1">Quick add:</span>
              {unusedSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void addCategory(s)}
                  className="text-xs px-2 py-0.5 rounded-full border border-border-default text-secondary hover:text-primary hover:border-accent"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted">Categories are shared by every project in the company.</p>
        </div>
      )}

      {notice && (
        <div role="status" className="text-sm text-status-success bg-status-success/10 border border-status-success/30 rounded px-3 py-2">{notice}</div>
      )}
      {error && (
        <div className="flex items-start gap-2 text-sm text-status-danger bg-status-danger/10 border border-status-danger/30 rounded px-3 py-2">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-xs hover:underline">Dismiss</button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-10 bg-surface-raised rounded animate-pulse" />
          ))}
        </div>
      )}

      {/* Category groups */}
      {!loading && (
        <div className="space-y-4">
          {groups
            // While filtering, hide groups with nothing to show instead of listing every empty one.
            .filter((g) => !filtering || g.visible.length > 0 || shownEmpty.includes(g.key))
            .map((g) => (
              <CategoryGroup
                key={g.key}
                label={g.label}
                tasks={g.visible}
                allInCategory={g.all}
                collapsed={collapsed.has(g.key)}
                onToggleCollapsed={() => setCollapsed((prev) => {
                  const next = new Set(prev)
                  if (next.has(g.key)) next.delete(g.key); else next.add(g.key)
                  return next
                })}
                canManage={canManage}
                canCreate={canCreate}
                selectedIds={selected}
                onSelectMany={selectMany}
                quickAddRef={(el) => { if (el) quickAddInputs.current.set(g.key, el); else quickAddInputs.current.delete(g.key) }}
                onQuickAdd={(title) => createOne(title, g.categoryId)}
                onQuickAddMany={(titles) => createMany(titles, g.categoryId)}
                rowProps={rowProps}
              />
            ))}
          {filtering && groups.every((g) => g.visible.length === 0) && (
            <p className="text-sm text-muted px-1">No tasks match this filter.</p>
          )}
        </div>
      )}

      {/* Bulk actions */}
      {canManage && selected.size > 0 && (
        <BulkBar
          count={selected.size}
          members={members}
          categories={categories}
          busy={bulkBusy}
          onApply={(set) => void applyBulk(set)}
          onClear={() => setSelected(new Set())}
        />
      )}

      {/* New task modal */}
      {showModal && (
        <TaskFormModal
          mode="create"
          projectId={projectId}
          members={members}
          categories={categories}
          defaultCategoryId={modalCategoryId}
          onClose={() => setShowModal(false)}
          onSaved={(task) => setTasks((prev) => [...prev, task])}
        />
      )}

      {/* Edit task modal */}
      {editingTask && (
        <TaskFormModal
          mode="edit"
          projectId={projectId}
          members={members}
          categories={categories}
          task={editingTask}
          onClose={() => setEditingTask(null)}
          onSaved={(task) => replaceTasks([task])}
        />
      )}

      {manageCategories && (
        <ManageCategoriesModal
          onClose={() => setManageCategories(false)}
          onChanged={() => { void fetchCategories(); void fetchTasks() }}
        />
      )}

      {/* Delete confirmation */}
      {deletingTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-surface-raised border border-border-default rounded-lg w-full max-w-md mx-4 p-6 space-y-4 text-primary">
            <h2 className="text-lg font-semibold text-primary">Delete task?</h2>
            <p className="text-sm text-secondary">
              This will remove <span className="font-medium text-primary">&ldquo;{deletingTask.title}&rdquo;</span> from the project. This action cannot be undone.
            </p>
            {deleteError && (
              <div className="text-sm text-status-danger bg-status-danger/10 border border-status-danger/30 rounded px-3 py-2">
                {deleteError}
              </div>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => { setDeletingTask(null); setDeleteError(null) }}
                disabled={deleteSubmitting}
                className="px-4 py-2 text-sm text-secondary hover:text-primary transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteConfirm()}
                disabled={deleteSubmitting}
                className="px-4 py-2 text-sm bg-status-danger text-white rounded hover:opacity-90 disabled:opacity-50 transition-colors"
              >
                {deleteSubmitting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
