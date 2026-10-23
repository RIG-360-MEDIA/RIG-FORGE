'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import type { TaskSummary, TaskCategorySummary } from '@/lib/types'
import TaskFormModal, { type Member } from './tasks/TaskFormModal'
import ManageCategoriesModal from './tasks/ManageCategoriesModal'
import DeleteTaskDialog from './tasks/DeleteTaskDialog'
import { useProjectTasks } from './tasks/useProjectTasks'
import {
  NONE, PAYMENT_POINTS, PRIORITIES, PRIORITY_STYLES, STATUS_LABELS, SUGGESTED_CATEGORIES,
  compareByDue, fieldClass, formatDate, isOverdue, optionClass, pastedLines, shortDate, toDateInput,
  type Priority, type TaskStatus,
} from './tasks/shared'

// The project's task list: the plan of work, by category, written up before
// anyone is given anything. Admins and the project lead build it (quick add,
// paste a list, categories) and hand items out with Assign, one at a time or
// many at once. Everyone on the project can read it. Once assigned, an item is
// also tracked in the Tasks tab; both tabs read the same tasks.

export interface TaskListTabProps {
  projectId: string
  /** Admin (projects.manage) or the project lead: may build the list and assign. */
  canManage: boolean
  /** tasks.manage: may also rename, reorder and archive the shared categories. */
  canManageCategories: boolean
}

type PlanFilter = 'all' | 'unassigned' | 'assigned' | 'done'
const FILTER_LABELS: Record<PlanFilter, string> = {
  all: 'All', unassigned: 'Not assigned', assigned: 'Assigned', done: 'Done',
}

// ─── AssignPanel ──────────────────────────────────────────────────────────────

interface AssignPanelProps {
  task: TaskSummary
  members: Member[]
  openCounts: Map<string, number>
  onSave: (change: Record<string, unknown>) => Promise<boolean>
  onClose: () => void
}

/** Person, deadline, priority, Save: everything needed to hand an item to someone. */
function AssignPanel({ task, members, openCounts, onSave, onClose }: AssignPanelProps) {
  const [assigneeId, setAssigneeId] = useState(task.assigneeId ?? '')
  const [dueDate, setDueDate]       = useState(toDateInput(task.dueDate))
  const [priority, setPriority]     = useState<Priority>((task.priority as Priority) ?? 'MEDIUM')
  const [saving, setSaving]         = useState(false)
  const personRef = useRef<HTMLSelectElement>(null)

  useEffect(() => { personRef.current?.focus() }, [])

  async function save(change: Record<string, unknown>) {
    setSaving(true)
    if (await onSave(change)) onClose()
    setSaving(false)
  }

  return (
    <div
      className="flex flex-wrap items-end gap-3 px-4 py-3 bg-accent/5 border-t border-border-default"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
    >
      <label className="flex flex-col gap-1 text-[11px] text-muted uppercase tracking-wider">
        Person
        <select ref={personRef} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className={`${fieldClass} min-w-[11rem]`}>
          <option value="" className={optionClass}>Choose a person...</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId} className={optionClass}>
              {m.name}{openCounts.get(m.userId) ? ` (${openCounts.get(m.userId)} open)` : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted uppercase tracking-wider">
        Deadline
        <input type="date" value={dueDate} min={toDateInput(task.startDate) || undefined} onChange={(e) => setDueDate(e.target.value)} className={fieldClass} />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted uppercase tracking-wider">
        Priority
        <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className={fieldClass}>
          {PRIORITIES.map((p) => <option key={p} value={p} className={optionClass}>{p}</option>)}
        </select>
      </label>
      <div className="flex gap-2 ml-auto">
        {task.assigneeId && (
          <button type="button" disabled={saving} onClick={() => void save({ assigneeId: null })} className="px-3 py-1.5 text-xs text-secondary hover:text-status-danger">
            Unassign
          </button>
        )}
        <button type="button" disabled={saving} onClick={onClose} className="px-3 py-1.5 text-xs text-secondary hover:text-primary">
          Cancel
        </button>
        <button
          type="button"
          disabled={saving || !assigneeId}
          onClick={() => void save({ assigneeId, dueDate: dueDate || null, priority })}
          className="px-4 py-1.5 text-xs font-medium rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {saving ? 'Saving...' : task.assigneeId ? 'Save' : 'Assign'}
        </button>
      </div>
    </div>
  )
}

// ─── PlanRow ──────────────────────────────────────────────────────────────────

interface PlanRowProps {
  task: TaskSummary
  canManage: boolean
  selected: boolean
  assigning: boolean
  members: Member[]
  openCounts: Map<string, number>
  onToggleSelect: (id: string) => void
  onStartAssign: (id: string | null) => void
  onSaveAssign: (task: TaskSummary, change: Record<string, unknown>) => Promise<boolean>
  onEdit: (task: TaskSummary) => void
  onDelete: (task: TaskSummary) => void
}

function PlanRow({
  task, canManage, selected, assigning, members, openCounts, onToggleSelect, onStartAssign, onSaveAssign, onEdit, onDelete,
}: PlanRowProps) {
  const [expanded, setExpanded] = useState(false)
  const done = task.status === 'DONE'
  const overdue = isOverdue(task)

  return (
    <div className={`border-b border-border-default ${selected ? 'bg-accent/5' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
        {canManage && (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(task.id)}
            aria-label={`Select ${task.title}`}
            className="accent-[rgb(var(--c-accent))] h-4 w-4 shrink-0 cursor-pointer"
          />
        )}
        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="flex-1 min-w-[12rem] text-left" title="Show details">
          <span className={`text-sm font-medium ${done ? 'line-through text-muted' : task.points === PAYMENT_POINTS ? 'text-status-danger' : 'text-primary'}`}>
            {task.title}
          </span>
        </button>

        {/* Assignment: who and by when, or an Assign button. */}
        <div className="shrink-0 flex items-center gap-2">
          {task.assigneeId ? (
            <button
              type="button"
              disabled={!canManage}
              onClick={() => onStartAssign(assigning ? null : task.id)}
              title={canManage ? 'Change who it is assigned to' : undefined}
              className={`text-xs text-left rounded px-2 py-1 border border-transparent ${canManage ? 'hover:border-border-default cursor-pointer' : 'cursor-default'}`}
            >
              <span className="text-primary">{task.assigneeName ?? 'Someone'}</span>
              {task.dueDate && (
                <span className={overdue ? 'text-status-danger' : 'text-muted'}>{`, ${shortDate(task.dueDate)}`}</span>
              )}
            </button>
          ) : canManage ? (
            <button
              type="button"
              onClick={() => onStartAssign(assigning ? null : task.id)}
              className="px-3 py-1 text-xs font-medium rounded border border-accent text-accent hover:bg-accent hover:text-white transition-colors"
            >
              Assign
            </button>
          ) : (
            <span className="text-xs text-muted">Not assigned yet</span>
          )}
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${PRIORITY_STYLES[task.priority as Priority] ?? PRIORITY_STYLES.MEDIUM}`}>
            {task.priority}
          </span>
          {task.assigneeId && (
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${done ? 'bg-status-success/20 text-status-success' : 'bg-surface-sunken text-secondary'}`}>
              {STATUS_LABELS[task.status as TaskStatus] ?? task.status}
            </span>
          )}
        </div>

        {canManage && (
          <div className="shrink-0 whitespace-nowrap">
            <button type="button" onClick={() => onEdit(task)} className="text-xs text-secondary hover:text-primary px-2 py-1">Edit</button>
            <button type="button" onClick={() => onDelete(task)} className="text-xs text-secondary hover:text-status-danger px-2 py-1">Delete</button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="px-6 pb-3 space-y-1 text-sm">
          {task.description && <p className="text-foreground whitespace-pre-line">{task.description}</p>}
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
            <span>Assigned to: <span className="text-foreground">{task.assigneeName ?? 'Nobody yet'}</span></span>
            <span>Deadline: <span className="text-foreground">{formatDate(task.dueDate)}</span></span>
            <span>Status: <span className="text-foreground">{STATUS_LABELS[task.status as TaskStatus] ?? task.status}</span></span>
          </div>
        </div>
      )}

      {assigning && (
        <AssignPanel
          task={task}
          members={members}
          openCounts={openCounts}
          onSave={(change) => onSaveAssign(task, change)}
          onClose={() => onStartAssign(null)}
        />
      )}
    </div>
  )
}

// ─── QuickAdd ─────────────────────────────────────────────────────────────────

interface QuickAddProps {
  label: string
  inputRef?: (el: HTMLInputElement | null) => void
  onAdd: (title: string) => Promise<boolean>
  onAddMany: (titles: string[]) => Promise<boolean>
}

/** "+ Add item" at the foot of a category: type, Enter, type the next; or paste a list. */
function QuickAdd({ label, inputRef, onAdd, onAddMany }: QuickAddProps) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<string[] | null>(null)

  // The box clears at once and the item saves in the background, so the next
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
        // Never disabled: a disabled box loses focus mid-typing.
        readOnly={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void submit() }
          if (e.key === 'Escape') { setValue(''); setPending(null) }
        }}
        onPaste={(e) => {
          const lines = pastedLines(e.clipboardData.getData('text'))
          if (lines.length > 1) { e.preventDefault(); setPending(lines.slice(0, 200)) }
        }}
        maxLength={200}
        placeholder={`+ Add item to ${label} (Enter to add; paste a list to add many)`}
        aria-label={`Add an item to ${label}`}
        className={`w-full bg-transparent border border-dashed border-border-default rounded px-3 py-1.5 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-accent focus:border-solid ${busy ? 'opacity-60' : ''}`}
      />
      {pending && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs bg-surface-raised border border-border-default rounded px-3 py-2">
          <span className="text-primary">Add {pending.length} items to {label}?</span>
          <span className="text-muted truncate max-w-[24rem]">{pending.slice(0, 3).join(', ')}{pending.length > 3 ? ', ...' : ''}</span>
          <span className="ml-auto flex gap-2">
            <button type="button" disabled={busy} onClick={() => void addPending()} className="px-3 py-1 rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50">
              {busy ? 'Adding...' : `Add ${pending.length} items`}
            </button>
            <button type="button" disabled={busy} onClick={() => setPending(null)} className="px-2 py-1 text-secondary hover:text-primary">Cancel</button>
          </span>
        </div>
      )}
    </div>
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

/** Shown while items are ticked: each control applies to all of them at once. */
function BulkBar({ count, members, categories, busy, onApply, onClear }: BulkBarProps) {
  return (
    <div className="sticky bottom-4 z-30">
      <div className="flex flex-wrap items-center gap-2 bg-surface-raised border border-accent/40 shadow-lg rounded-lg px-4 py-3">
        <span className="text-sm font-medium text-primary mr-1">{count} selected</span>
        <select value="" disabled={busy} onChange={(e) => e.target.value && onApply({ assigneeId: e.target.value === NONE ? null : e.target.value })} aria-label="Assign selected items to" className={fieldClass}>
          <option value="" className={optionClass}>Assign to...</option>
          {members.map((m) => <option key={m.userId} value={m.userId} className={optionClass}>{m.name}</option>)}
          <option value={NONE} className={optionClass}>Unassign</option>
        </select>
        <label className="flex items-center gap-1 text-xs text-muted">
          Deadline
          <input type="date" disabled={busy} onChange={(e) => e.target.value && onApply({ dueDate: e.target.value })} aria-label="Deadline for selected items" className={fieldClass} />
        </label>
        <select value="" disabled={busy} onChange={(e) => e.target.value && onApply({ priority: e.target.value })} aria-label="Priority for selected items" className={fieldClass}>
          <option value="" className={optionClass}>Priority...</option>
          {PRIORITIES.map((p) => <option key={p} value={p} className={optionClass}>{p}</option>)}
        </select>
        <select value="" disabled={busy} onChange={(e) => e.target.value && onApply({ categoryId: e.target.value === NONE ? null : e.target.value })} aria-label="Move selected items to category" className={fieldClass}>
          <option value="" className={optionClass}>Move to...</option>
          {categories.map((c) => <option key={c.id} value={c.id} className={optionClass}>{c.name}</option>)}
          <option value={NONE} className={optionClass}>No category</option>
        </select>
        <button type="button" onClick={onClear} disabled={busy} className="ml-auto text-xs text-secondary hover:text-primary px-2 py-1">Clear selection</button>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TaskListTab({ projectId, canManage, canManageCategories }: TaskListTabProps) {
  const {
    tasks, members, categories, loading, error, setError, notice, flash,
    fetchTasks, fetchCategories, replaceTasks, patchTask, createOne, createMany, bulkUpdate, addCategory, deleteTask,
  } = useProjectTasks(projectId)

  const [filter, setFilter]         = useState<PlanFilter>('all')
  const [search, setSearch]         = useState('')
  const [collapsed, setCollapsed]   = useState<Set<string>>(new Set())
  const [selected, setSelected]     = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy]     = useState(false)
  const [assigningId, setAssigningId] = useState<string | null>(null)
  // Categories added in this visit, shown even before they hold an item, so
  // the new group's "+ Add item" is right there to type into.
  const [shownEmpty, setShownEmpty] = useState<string[]>([])
  const [addingCategory, setAddingCategory] = useState(false)
  const [categoryDraft, setCategoryDraft]   = useState('')
  const [manageCategories, setManageCategories] = useState(false)
  const [editingTask, setEditingTask]   = useState<TaskSummary | null>(null)
  const [deletingTask, setDeletingTask] = useState<TaskSummary | null>(null)
  const quickAddInputs = useRef(new Map<string, HTMLInputElement>())
  const focusAfterRender = useRef<string | null>(null)

  // Focus a group's add box once it has rendered (after adding a category).
  useEffect(() => {
    const key = focusAfterRender.current
    if (!key) return
    const el = quickAddInputs.current.get(key)
    if (el) { el.focus(); focusAfterRender.current = null }
  })

  const openCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of tasks) if (t.assigneeId && t.status !== 'DONE') m.set(t.assigneeId, (m.get(t.assigneeId) ?? 0) + 1)
    return m
  }, [tasks])

  const filtered = useMemo(() => tasks.filter((t) => {
    if (filter === 'unassigned' && (t.assigneeId || t.status === 'DONE')) return false
    if (filter === 'assigned' && !t.assigneeId) return false
    if (filter === 'done' && t.status !== 'DONE') return false
    if (search.trim()) {
      const q = search.toLowerCase()
      return t.title.toLowerCase().includes(q)
        || (t.assigneeName?.toLowerCase().includes(q) ?? false)
        || (t.categoryName?.toLowerCase().includes(q) ?? false)
    }
    return true
  }), [tasks, filter, search])

  /** Groups in category order; "No category" last. A category shows when it has items or was just added. */
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
    for (const [key, list] of byKey) {
      if (key !== NONE && !categories.some((c) => c.id === key)) {
        out.push({ key, label: list[0]?.categoryName ?? 'Archived category', categoryId: key })
      }
    }
    if (byKey.has(NONE) || out.length === 0) {
      out.push({ key: NONE, label: out.length === 0 ? 'Items' : 'No category', categoryId: null })
    }
    // Items not yet assigned first (the ones that need attention), done last.
    const rank = (t: TaskSummary) => (t.status === 'DONE' ? 2 : t.assigneeId ? 1 : 0)
    return out.map((g) => ({
      ...g,
      all: byKey.get(g.key) ?? [],
      visible: filtered
        .filter((t) => (t.categoryId ?? NONE) === g.key)
        .sort((a, b) => rank(a) - rank(b) || compareByDue(a, b)),
    }))
  }, [tasks, filtered, categories, shownEmpty])

  const filtering = filter !== 'all' || search.trim() !== ''
  const totals = useMemo(() => ({
    items: tasks.length,
    unassigned: tasks.filter((t) => !t.assigneeId && t.status !== 'DONE').length,
  }), [tasks])
  const unusedSuggestions = SUGGESTED_CATEGORIES.filter(
    (s) => !categories.some((c) => c.name.toLowerCase() === s.toLowerCase()),
  )

  function toggleSelect(id: string) {
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  function selectMany(ids: string[], on: boolean) {
    setSelected((prev) => { const next = new Set(prev); for (const id of ids) { if (on) next.add(id); else next.delete(id) } return next })
  }

  async function saveAssign(task: TaskSummary, change: Record<string, unknown>): Promise<boolean> {
    const ok = await patchTask(task.id, change)
    if (ok) {
      const name = members.find((m) => m.userId === change.assigneeId)?.name
      flash(change.assigneeId ? `"${task.title}" assigned to ${name ?? 'them'}.` : `"${task.title}" unassigned.`)
    }
    return ok
  }

  async function applyBulk(set: Record<string, unknown>) {
    const ids = [...selected]
    if (ids.length === 0) return
    setBulkBusy(true)
    setError(null)
    const n = await bulkUpdate(ids, set)
    if (n !== null) {
      const who = members.find((m) => m.userId === set.assigneeId)?.name
      flash('assigneeId' in set
        ? (set.assigneeId ? `Assigned ${n} items to ${who ?? 'them'}.` : `Unassigned ${n} items.`)
        : 'categoryId' in set ? `Moved ${n} items.` : `Updated ${n} items.`)
      setSelected(new Set())
    }
    setBulkBusy(false)
  }

  async function handleAddCategory(name: string) {
    const cat = await addCategory(name)
    if (!cat) return
    setShownEmpty((prev) => (prev.includes(cat.id) ? prev : [...prev, cat.id]))
    setCollapsed((prev) => { const next = new Set(prev); next.delete(cat.id); return next })
    setCategoryDraft('')
    setAddingCategory(false)
    focusAfterRender.current = cat.id
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* What this tab is, in a line, and how much is still to hand out. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-sm text-secondary">
          The plan of work for this project, by category. {canManage ? 'Assign an item to give it to someone; it then shows in Tasks.' : 'Items given to someone also show in Tasks.'}
        </p>
        {!loading && totals.items > 0 && (
          <p className="text-xs text-muted">
            {totals.items} items, {totals.unassigned} not assigned yet
          </p>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'unassigned', 'assigned', 'done'] as PlanFilter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${filter === f ? 'bg-accent text-white' : 'bg-surface-raised text-secondary hover:text-primary'}`}
          >
            {FILTER_LABELS[f]}
          </button>
        ))}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search the list…"
          className="ml-auto bg-surface-raised border border-border-default rounded px-3 py-1.5 text-xs focus:outline-none focus:border-accent w-48"
        />
        {canManage && (
          <button
            type="button"
            onClick={() => setAddingCategory((v) => !v)}
            className="px-3 py-1.5 text-xs font-medium rounded bg-accent text-white hover:bg-accent/80 transition-colors"
          >
            + Category
          </button>
        )}
        {canManageCategories && (
          <button type="button" onClick={() => setManageCategories(true)} className="px-3 py-1.5 text-xs font-medium rounded bg-surface-raised text-secondary hover:text-primary transition-colors">
            Manage categories
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
                if (e.key === 'Enter') void handleAddCategory(categoryDraft)
                if (e.key === 'Escape') setAddingCategory(false)
              }}
              maxLength={60}
              placeholder="Category name, e.g. Electrical"
              aria-label="New category name"
              className="flex-1 bg-background-primary border border-border-default rounded px-3 py-1.5 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-accent"
            />
            <button type="button" onClick={() => void handleAddCategory(categoryDraft)} className="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent-hover">Add</button>
            <button type="button" onClick={() => setAddingCategory(false)} className="px-2 py-1.5 text-xs text-secondary hover:text-primary">Cancel</button>
          </div>
          {unusedSuggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted mr-1">Quick add:</span>
              {unusedSuggestions.map((s) => (
                <button key={s} type="button" onClick={() => void handleAddCategory(s)} className="text-xs px-2 py-0.5 rounded-full border border-border-default text-secondary hover:text-primary hover:border-accent">
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

      {loading && (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => <div key={i} className="h-10 bg-surface-raised rounded animate-pulse" />)}
        </div>
      )}

      {!loading && totals.items === 0 && !canManage && (
        <p className="text-sm text-muted">No task list for this project yet.</p>
      )}

      {/* Category groups */}
      {!loading && (totals.items > 0 || canManage) && (
        <div className="space-y-4">
          {groups
            .filter((g) => !filtering || g.visible.length > 0 || shownEmpty.includes(g.key))
            .map((g) => {
              const assigned = g.all.filter((t) => t.assigneeId).length
              const done = g.all.filter((t) => t.status === 'DONE').length
              const pct = g.all.length ? Math.round((done / g.all.length) * 100) : 0
              const isCollapsed = collapsed.has(g.key)
              const allSelected = g.visible.length > 0 && g.visible.every((t) => selected.has(t.id))
              return (
                <section key={g.key} className="border border-border-default rounded-lg overflow-hidden">
                  <header className="flex flex-wrap items-center gap-3 px-4 py-2.5 bg-surface-raised/60 border-b border-border-default">
                    {canManage && g.visible.length > 0 && (
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={() => selectMany(g.visible.map((t) => t.id), !allSelected)}
                        aria-label={`Select all items in ${g.label}`}
                        className="accent-[rgb(var(--c-accent))] h-4 w-4 cursor-pointer"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => setCollapsed((prev) => { const next = new Set(prev); if (next.has(g.key)) next.delete(g.key); else next.add(g.key); return next })}
                      aria-expanded={!isCollapsed}
                      className="flex items-center gap-2 text-left"
                    >
                      <span className="text-xs text-muted w-3">{isCollapsed ? '+' : '−'}</span>
                      <span className="text-sm font-semibold tracking-wide text-primary uppercase">{g.label}</span>
                    </button>
                    <span className="text-xs text-muted">
                      {g.all.length} {g.all.length === 1 ? 'item' : 'items'}, {assigned} assigned, {done} done
                    </span>
                    {g.all.length > 0 && (
                      <div className="hidden sm:block w-24 h-1.5 rounded bg-surface-sunken overflow-hidden" aria-hidden>
                        <div className="h-full bg-status-success" style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </header>

                  {!isCollapsed && (
                    <div>
                      {g.visible.length === 0 && (
                        <p className="text-xs text-muted px-4 py-3 italic">
                          {g.all.length === 0 ? 'No items yet.' : 'No items match this filter.'}
                        </p>
                      )}
                      {g.visible.map((t) => (
                        <PlanRow
                          key={t.id}
                          task={t}
                          canManage={canManage}
                          selected={selected.has(t.id)}
                          assigning={assigningId === t.id}
                          members={members}
                          openCounts={openCounts}
                          onToggleSelect={toggleSelect}
                          onStartAssign={setAssigningId}
                          onSaveAssign={saveAssign}
                          onEdit={setEditingTask}
                          onDelete={setDeletingTask}
                        />
                      ))}
                      {canManage && (
                        <QuickAdd
                          label={g.label}
                          inputRef={(el) => { if (el) quickAddInputs.current.set(g.key, el); else quickAddInputs.current.delete(g.key) }}
                          onAdd={(title) => createOne(title, g.categoryId)}
                          onAddMany={(titles) => createMany(titles, g.categoryId)}
                        />
                      )}
                    </div>
                  )}
                </section>
              )
            })}
          {filtering && groups.every((g) => g.visible.length === 0) && (
            <p className="text-sm text-muted px-1">No items match this filter.</p>
          )}
        </div>
      )}

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

      {deletingTask && (
        <DeleteTaskDialog
          task={deletingTask}
          onCancel={() => setDeletingTask(null)}
          onConfirm={async () => {
            const err = await deleteTask(deletingTask.id)
            if (!err) {
              setSelected((prev) => { const next = new Set(prev); next.delete(deletingTask.id); return next })
              setDeletingTask(null)
            }
            return err
          }}
        />
      )}
    </div>
  )
}
