'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import type { TaskSummary, TaskCategorySummary } from '@/lib/types'
import TaskFormModal, { type Member } from './tasks/TaskFormModal'
import ManageCategoriesModal from './tasks/ManageCategoriesModal'
import DeleteTaskDialog from './tasks/DeleteTaskDialog'
import ApplyTemplateModal from './tasks/ApplyTemplateModal'
import { useProjectTasks } from './tasks/useProjectTasks'
import {
  NONE, PAYMENT_POINTS, PRIORITIES, PRIORITY_STYLES, STATUS_LABELS, SUGGESTED_CATEGORIES,
  fieldClass, formatDate, isOverdue, optionClass, pastedLines, shortDate, toDateInput,
  type Priority, type TaskStatus,
} from './tasks/shared'

// The project's task list: the plan of work, by category, written up before
// anyone is given anything. Admins and the project lead build it (templates,
// quick add, paste a list, categories) and hand items out with Assign, one at
// a time or many at once. Everyone on the project can read it. Once assigned,
// an item is also tracked in the Tasks tab; both tabs read the same tasks.

export interface TaskListTabProps {
  projectId: string
  /** Admin (projects.manage) or the project lead: may build the list and assign. */
  canManage: boolean
  /** tasks.manage: may also rename, reorder and archive the shared categories. */
  canManageCategories: boolean
}

type PlanFilter = 'all' | 'unassigned' | 'assigned' | 'done'
const FILTER_LABELS: Record<PlanFilter, string> = {
  all: 'All', unassigned: 'To assign', assigned: 'Assigned', done: 'Done',
}

/** Plan order: the order items were written (or came from a template); done at the end. */
function planOrder(a: TaskSummary, b: TaskSummary): number {
  const d = Number(a.status === 'DONE') - Number(b.status === 'DONE')
  if (d !== 0) return d
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
}

function initials(name: string | null): string {
  return (name ?? '?').split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')
}

const STATUS_DOT: Record<string, string> = {
  TODO: 'bg-text-secondary/50',
  IN_PROGRESS: 'bg-status-warning',
  DONE: 'bg-status-success',
}

// ─── RowMenu ──────────────────────────────────────────────────────────────────

/** "More" menu holding the row's less frequent actions (Edit, Delete). */
function RowMenu({ label, onEdit, onDelete }: { label: string; onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${label}`}
        className="h-8 w-8 grid place-items-center rounded text-muted hover:text-primary hover:bg-surface-raised transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden><circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" /></svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-9 z-20 min-w-[8rem] rounded-md border border-border-default bg-surface-raised shadow-lg py-1">
          <button role="menuitem" type="button" onClick={() => { setOpen(false); onEdit() }} className="w-full text-left px-3 py-1.5 text-sm text-primary hover:bg-surface-sunken">
            Edit details
          </button>
          <button role="menuitem" type="button" onClick={() => { setOpen(false); onDelete() }} className="w-full text-left px-3 py-1.5 text-sm text-status-danger hover:bg-surface-sunken">
            Delete
          </button>
        </div>
      )}
    </div>
  )
}

// ─── AssignPanel ──────────────────────────────────────────────────────────────

interface AssignPanelProps {
  task: TaskSummary
  members: Member[]
  openCounts: Map<string, number>
  onSave: (change: Record<string, unknown>) => Promise<boolean>
  onClose: () => void
}

/** Person, deadline, priority, then one Save: everything needed to hand an item to someone. */
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

  const label = 'flex flex-col gap-1 text-[11px] font-medium text-muted uppercase tracking-wider'
  return (
    <div
      className="mx-3 mb-3 rounded-lg border border-accent/40 bg-accent/5 px-4 py-3"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className={label}>
          Assign to
          <select ref={personRef} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className={`${fieldClass} min-w-[12rem] text-sm`}>
            <option value="" className={optionClass}>Choose a person...</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId} className={optionClass}>
                {m.name}{openCounts.get(m.userId) ? ` (${openCounts.get(m.userId)} open)` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Deadline
          <input type="date" value={dueDate} min={toDateInput(task.startDate) || undefined} onChange={(e) => setDueDate(e.target.value)} className={`${fieldClass} text-sm`} />
        </label>
        <label className={label}>
          Priority
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className={`${fieldClass} text-sm`}>
            {PRIORITIES.map((p) => <option key={p} value={p} className={optionClass}>{p.charAt(0) + p.slice(1).toLowerCase()}</option>)}
          </select>
        </label>
        <div className="flex items-center gap-2 ml-auto">
          {task.assigneeId && (
            <button type="button" disabled={saving} onClick={() => void save({ assigneeId: null })} className="px-3 py-2 text-xs text-secondary hover:text-status-danger">
              Unassign
            </button>
          )}
          <button type="button" disabled={saving} onClick={onClose} className="px-3 py-2 text-xs text-secondary hover:text-primary">
            Cancel
          </button>
          <button
            type="button"
            disabled={saving || !assigneeId}
            onClick={() => void save({ assigneeId, dueDate: dueDate || null, priority })}
            className="px-4 py-2 text-xs font-semibold rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? 'Saving...' : task.assigneeId ? 'Save' : 'Assign'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── PlanRow ──────────────────────────────────────────────────────────────────

interface PlanRowProps {
  task: TaskSummary
  index: number
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
  task, index, canManage, selected, assigning, members, openCounts, onToggleSelect, onStartAssign, onSaveAssign, onEdit, onDelete,
}: PlanRowProps) {
  const [expanded, setExpanded] = useState(false)
  const done = task.status === 'DONE'
  const overdue = isOverdue(task)
  const priority = task.priority as Priority
  // MEDIUM is the default and says nothing; only a different priority is shown.
  const showPriority = priority !== 'MEDIUM'

  return (
    <li className={`border-t border-border-default first:border-t-0 ${selected ? 'bg-accent/[0.06]' : ''} ${assigning ? 'bg-surface-raised/40' : ''}`}>
      <div className="group flex items-center gap-3 px-4 py-2.5 min-h-[3.25rem]">
        {canManage && (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(task.id)}
            aria-label={`Select ${task.title}`}
            className="accent-[rgb(var(--c-accent))] h-4 w-4 shrink-0 cursor-pointer"
          />
        )}
        <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted">{index}.</span>

        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="flex-1 min-w-0 text-left">
          <span className={`block text-sm leading-snug ${done ? 'line-through text-muted' : task.points === PAYMENT_POINTS ? 'text-status-danger font-medium' : 'text-primary'}`}>
            {task.title}
          </span>
        </button>

        {showPriority && (
          <span className={`hidden sm:inline shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${PRIORITY_STYLES[priority] ?? ''}`}>
            {priority}
          </span>
        )}

        {/* Who has it and by when, or Assign. */}
        <div className="shrink-0 w-44 sm:w-52 flex justify-end">
          {task.assigneeId ? (
            <button
              type="button"
              disabled={!canManage}
              onClick={() => onStartAssign(assigning ? null : task.id)}
              title={canManage ? 'Change who it is assigned to' : undefined}
              className={`flex items-center gap-2 max-w-full rounded-full pl-1 pr-3 py-1 text-left ${canManage ? 'hover:bg-surface-raised cursor-pointer' : 'cursor-default'}`}
            >
              <span className="relative grid place-items-center h-6 w-6 shrink-0 rounded-full bg-accent/20 text-[10px] font-semibold text-primary">
                {initials(task.assigneeName)}
                <span className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-background-primary ${STATUS_DOT[task.status] ?? STATUS_DOT.TODO}`} title={STATUS_LABELS[task.status as TaskStatus]} />
              </span>
              <span className="min-w-0 leading-tight">
                <span className="block truncate text-xs text-primary">{task.assigneeName ?? 'Someone'}</span>
                <span className={`block text-[11px] ${overdue ? 'text-status-danger' : 'text-muted'}`}>
                  {task.dueDate ? `${overdue ? 'Overdue, ' : 'Due '}${shortDate(task.dueDate)}` : 'No deadline'}
                </span>
              </span>
            </button>
          ) : canManage ? (
            <button
              type="button"
              onClick={() => onStartAssign(assigning ? null : task.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full border border-dashed transition-colors ${assigning ? 'border-accent text-accent' : 'border-border-strong text-secondary hover:border-accent hover:text-accent'}`}
            >
              + Assign
            </button>
          ) : (
            <span className="text-xs text-muted">Not assigned</span>
          )}
        </div>

        {canManage ? (
          <RowMenu label={task.title} onEdit={() => onEdit(task)} onDelete={() => onDelete(task)} />
        ) : (
          <span className="w-8 shrink-0" />
        )}
      </div>

      {expanded && (
        <div className="pl-[4.25rem] pr-4 pb-3 space-y-1 text-sm">
          {task.description && <p className="text-secondary whitespace-pre-line">{task.description}</p>}
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
            <span>Assigned to: <span className="text-primary">{task.assigneeName ?? 'Nobody yet'}</span></span>
            <span>Deadline: <span className="text-primary">{formatDate(task.dueDate)}</span></span>
            <span>Priority: <span className="text-primary">{priority.charAt(0) + priority.slice(1).toLowerCase()}</span></span>
            <span>Status: <span className="text-primary">{STATUS_LABELS[task.status as TaskStatus] ?? task.status}</span></span>
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
    </li>
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
    <div className="px-4 py-2.5 border-t border-border-default">
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
        placeholder={`Add an item to ${label}. Enter to add; paste a list to add many.`}
        aria-label={`Add an item to ${label}`}
        className={`w-full bg-transparent px-2 py-1.5 text-sm text-primary placeholder:text-muted rounded focus:outline-none focus:bg-background-primary focus:ring-1 focus:ring-accent ${busy ? 'opacity-60' : ''}`}
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
  onApply: (set: Record<string, unknown>) => Promise<boolean>
  onClear: () => void
}

/**
 * Shown while items are ticked. Choose any of person, deadline, priority and
 * category, then Apply once: nothing is saved while choosing, so setting all
 * four for ten items is one save, not four (with the selection lost after
 * the first, as it was).
 */
function BulkBar({ count, members, categories, busy, onApply, onClear }: BulkBarProps) {
  const [assignee, setAssignee] = useState('')
  const [due, setDue]           = useState('')
  const [priority, setPriority] = useState('')
  const [category, setCategory] = useState('')

  const set: Record<string, unknown> = {}
  if (assignee) set.assigneeId = assignee === NONE ? null : assignee
  if (due) set.dueDate = due
  if (priority) set.priority = priority
  if (category) set.categoryId = category === NONE ? null : category
  const chosen = Object.keys(set).length

  async function apply() {
    if (await onApply(set)) { setAssignee(''); setDue(''); setPriority(''); setCategory('') }
  }

  const ctl = `${fieldClass} text-sm py-2`
  const label = 'flex flex-col gap-1 text-[11px] font-medium text-muted uppercase tracking-wider'
  return (
    <div className="sticky bottom-4 z-30">
      <div className="rounded-xl border border-accent/50 bg-surface-raised shadow-2xl px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="mr-1 pb-1.5">
            <p className="text-sm font-semibold text-primary">{count} selected</p>
            <button type="button" onClick={onClear} disabled={busy} className="text-xs text-muted hover:text-primary">Clear selection</button>
          </div>
          <label className={label}>
            Assign to
            <select value={assignee} disabled={busy} onChange={(e) => setAssignee(e.target.value)} className={`${ctl} min-w-[11rem]`}>
              <option value="" className={optionClass}>No change</option>
              {members.map((m) => <option key={m.userId} value={m.userId} className={optionClass}>{m.name}</option>)}
              <option value={NONE} className={optionClass}>Nobody (unassign)</option>
            </select>
          </label>
          <label className={label}>
            Deadline
            <input type="date" value={due} disabled={busy} onChange={(e) => setDue(e.target.value)} className={ctl} />
          </label>
          <label className={label}>
            Priority
            <select value={priority} disabled={busy} onChange={(e) => setPriority(e.target.value)} className={ctl}>
              <option value="" className={optionClass}>No change</option>
              {PRIORITIES.map((p) => <option key={p} value={p} className={optionClass}>{p.charAt(0) + p.slice(1).toLowerCase()}</option>)}
            </select>
          </label>
          <label className={label}>
            Category
            <select value={category} disabled={busy} onChange={(e) => setCategory(e.target.value)} className={ctl}>
              <option value="" className={optionClass}>No change</option>
              {categories.map((c) => <option key={c.id} value={c.id} className={optionClass}>{c.name}</option>)}
              <option value={NONE} className={optionClass}>No category</option>
            </select>
          </label>
          <button
            type="button"
            disabled={busy || chosen === 0}
            onClick={() => void apply()}
            className="ml-auto px-5 py-2.5 text-sm font-semibold rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-40"
          >
            {busy ? 'Saving...' : `Apply to ${count} ${count === 1 ? 'item' : 'items'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TaskListTab({ projectId, canManage, canManageCategories }: TaskListTabProps) {
  const {
    tasks, setTasks, members, categories, loading, error, setError, notice, flash,
    fetchTasks, fetchCategories, replaceTasks, patchTask, createOne, createMany, bulkUpdate, addCategory, deleteTask,
  } = useProjectTasks(projectId)

  const [filter, setFilter]         = useState<PlanFilter>('all')
  const [search, setSearch]         = useState('')
  const [collapsed, setCollapsed]   = useState<Set<string>>(new Set())
  const [selected, setSelected]     = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy]     = useState(false)
  const [assigningId, setAssigningId] = useState<string | null>(null)
  // Categories added in this visit, shown even before they hold an item, so
  // the new group's add box is right there to type into.
  const [shownEmpty, setShownEmpty] = useState<string[]>([])
  const [addingCategory, setAddingCategory] = useState(false)
  const [categoryDraft, setCategoryDraft]   = useState('')
  const [manageCategories, setManageCategories] = useState(false)
  const [applyingTemplate, setApplyingTemplate] = useState(false)
  const [editingTask, setEditingTask]   = useState<TaskSummary | null>(null)
  const [deletingTask, setDeletingTask] = useState<TaskSummary | null>(null)
  const quickAddInputs = useRef(new Map<string, HTMLInputElement>())
  const focusAfterRender = useRef<string | null>(null)

  // A selection only ever holds items on screen: changing the filter or the
  // search clears it, so a bulk change cannot reach items the user cannot see.
  useEffect(() => { setSelected(new Set()) }, [filter, search])

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

  const counts = useMemo(() => ({
    all: tasks.length,
    unassigned: tasks.filter((t) => !t.assigneeId && t.status !== 'DONE').length,
    assigned: tasks.filter((t) => t.assigneeId).length,
    done: tasks.filter((t) => t.status === 'DONE').length,
  }), [tasks])

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
    return out.map((g) => {
      // Numbers follow the plan's own order and do not change with the filter.
      const all = [...(byKey.get(g.key) ?? [])].sort(planOrder)
      const number = new Map(all.map((t, i) => [t.id, i + 1]))
      return {
        ...g,
        all,
        number,
        visible: filtered.filter((t) => (t.categoryId ?? NONE) === g.key).sort(planOrder),
      }
    })
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

  async function saveAssign(task: TaskSummary, change: Record<string, unknown>): Promise<boolean> {
    const ok = await patchTask(task.id, change)
    if (ok) {
      const name = members.find((m) => m.userId === change.assigneeId)?.name
      flash(change.assigneeId ? `"${task.title}" assigned to ${name ?? 'them'}.` : `"${task.title}" unassigned.`)
    }
    return ok
  }

  async function applyBulk(set: Record<string, unknown>): Promise<boolean> {
    const ids = [...selected]
    if (ids.length === 0 || Object.keys(set).length === 0) return false
    setBulkBusy(true)
    setError(null)
    const n = await bulkUpdate(ids, set)
    setBulkBusy(false)
    if (n === null) return false
    // One line saying everything that changed.
    const parts: string[] = []
    if ('assigneeId' in set) parts.push(set.assigneeId ? `assigned to ${members.find((m) => m.userId === set.assigneeId)?.name ?? 'them'}` : 'unassigned')
    if (set.dueDate) parts.push(`due ${shortDate(set.dueDate as string)}`)
    if (set.priority) parts.push(`${String(set.priority).toLowerCase()} priority`)
    if ('categoryId' in set) parts.push(`moved to ${categories.find((c) => c.id === set.categoryId)?.name ?? 'no category'}`)
    flash(`${n} ${n === 1 ? 'item' : 'items'} ${parts.join(', ')}.`)
    setSelected(new Set())
    return true
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
    <div className="space-y-4 pt-1">
      {/* Header: what is left to hand out, and the ways to build the list. */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-primary">Task list</h2>
          <p className="text-sm text-secondary mt-0.5">
            {loading ? 'Loading...' : counts.all === 0
              ? 'The plan of work for this project, by category.'
              : `${counts.all} items. ${counts.unassigned} still to assign, ${counts.done} done.`}
            {canManage && counts.all > 0 && ' Assigned items also show in Tasks.'}
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            {canManageCategories && (
              <button type="button" onClick={() => setManageCategories(true)} className="px-2 py-1.5 text-xs text-secondary hover:text-primary underline-offset-4 hover:underline">
                Manage categories
              </button>
            )}
            <button
              type="button"
              onClick={() => setAddingCategory((v) => !v)}
              className="px-3 py-2 text-xs font-medium rounded border border-border-default text-primary hover:border-accent transition-colors"
            >
              + Category
            </button>
            <button
              type="button"
              onClick={() => setApplyingTemplate(true)}
              className="px-3 py-2 text-xs font-semibold rounded bg-accent text-white hover:bg-accent-hover transition-colors"
            >
              Add from template
            </button>
          </div>
        )}
      </div>

      {/* Filters and search */}
      {counts.all > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <div role="tablist" aria-label="Show" className="inline-flex rounded-lg border border-border-default p-0.5 bg-surface-raised/50">
            {(['all', 'unassigned', 'assigned', 'done'] as PlanFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${filter === f ? 'bg-accent text-white' : 'text-secondary hover:text-primary'}`}
              >
                {FILTER_LABELS[f]} <span className={`ml-1 tabular-nums ${filter === f ? 'text-white/80' : 'text-muted'}`}>{counts[f]}</span>
              </button>
            ))}
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items, people or categories"
            className="ml-auto w-full sm:w-64 bg-surface-raised border border-border-default rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-accent"
          />
        </div>
      )}

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
        <div role="status" className="text-sm text-status-success bg-status-success/10 border border-status-success/30 rounded-lg px-3 py-2">{notice}</div>
      )}
      {error && (
        <div className="flex items-start gap-2 text-sm text-status-danger bg-status-danger/10 border border-status-danger/30 rounded-lg px-3 py-2">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-xs hover:underline">Dismiss</button>
        </div>
      )}

      {loading && (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => <div key={i} className="h-12 bg-surface-raised rounded-lg animate-pulse" />)}
        </div>
      )}

      {!loading && counts.all === 0 && !canManage && (
        <p className="text-sm text-muted">No task list for this project yet.</p>
      )}
      {!loading && counts.all === 0 && canManage && (
        <div className="border border-dashed border-border-default rounded-xl px-6 py-8 text-center space-y-2">
          <p className="text-sm font-medium text-primary">This project has no task list yet.</p>
          <p className="text-xs text-muted">Start from one or more templates, or add items below and paste lists in.</p>
          <button type="button" onClick={() => setApplyingTemplate(true)} className="mt-2 px-4 py-2 text-xs font-semibold rounded bg-accent text-white hover:bg-accent-hover">
            Add from template
          </button>
        </div>
      )}

      {/* Category groups */}
      {!loading && (counts.all > 0 || canManage) && (
        <div className="space-y-4">
          {groups
            .filter((g) => !filtering || g.visible.length > 0 || shownEmpty.includes(g.key))
            .map((g) => {
              const total = g.all.length
              const assigned = g.all.filter((t) => t.assigneeId).length
              const done = g.all.filter((t) => t.status === 'DONE').length
              const isCollapsed = collapsed.has(g.key)
              const allSelected = g.visible.length > 0 && g.visible.every((t) => selected.has(t.id))
              const someSelected = !allSelected && g.visible.some((t) => selected.has(t.id))
              return (
                <section key={g.key} className="rounded-xl border border-border-default overflow-hidden bg-background-primary">
                  <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 bg-surface-raised/60">
                    {canManage && g.visible.length > 0 && (
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => { if (el) el.indeterminate = someSelected }}
                        onChange={() => selectMany(g.visible.map((t) => t.id), !allSelected)}
                        aria-label={`Select all items in ${g.label}`}
                        className="accent-[rgb(var(--c-accent))] h-4 w-4 cursor-pointer"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        // Folding a group also unticks its items (they are no longer visible).
                        if (!isCollapsed) selectMany(g.all.map((t) => t.id), false)
                        setCollapsed((prev) => { const next = new Set(prev); if (next.has(g.key)) next.delete(g.key); else next.add(g.key); return next })
                      }}
                      aria-expanded={!isCollapsed}
                      className="flex items-center gap-2 text-left"
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className={`text-muted transition-transform ${isCollapsed ? '-rotate-90' : ''}`}>
                        <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className="text-sm font-semibold tracking-wide text-primary uppercase">{g.label}</span>
                    </button>
                    <span className="text-xs text-muted tabular-nums">
                      {total} {total === 1 ? 'item' : 'items'}
                      {total > 0 && <> · {assigned} assigned · {done} done</>}
                    </span>
                    {total > 0 && (
                      // Two-part bar: done (solid) within assigned (lighter).
                      <div className="ml-auto hidden sm:block w-40 h-1.5 rounded-full bg-surface-sunken overflow-hidden relative" title={`${assigned} of ${total} assigned, ${done} done`}>
                        <div className="absolute inset-y-0 left-0 bg-accent/35" style={{ width: `${(assigned / total) * 100}%` }} />
                        <div className="absolute inset-y-0 left-0 bg-status-success" style={{ width: `${(done / total) * 100}%` }} />
                      </div>
                    )}
                  </header>

                  {!isCollapsed && (
                    <>
                      {g.visible.length === 0 && (
                        <p className="text-xs text-muted px-4 py-3 italic border-t border-border-default">
                          {total === 0 ? 'No items yet.' : 'No items match this filter.'}
                        </p>
                      )}
                      {g.visible.length > 0 && (
                        <ul className="border-t border-border-default">
                          {g.visible.map((t) => (
                            <PlanRow
                              key={t.id}
                              task={t}
                              index={g.number.get(t.id) ?? 0}
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
                        </ul>
                      )}
                      {canManage && (
                        <QuickAdd
                          label={g.label}
                          inputRef={(el) => { if (el) quickAddInputs.current.set(g.key, el); else quickAddInputs.current.delete(g.key) }}
                          onAdd={(title) => createOne(title, g.categoryId)}
                          onAddMany={(titles) => createMany(titles, g.categoryId)}
                        />
                      )}
                    </>
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
          onApply={applyBulk}
          onClear={() => setSelected(new Set())}
        />
      )}

      {applyingTemplate && (
        <ApplyTemplateModal
          projectId={projectId}
          existing={tasks}
          onClose={() => setApplyingTemplate(false)}
          onApplied={(added, skipped) => {
            setTasks((prev) => [...prev, ...added])
            flash(`Added ${added.length} items from the template${skipped ? `; ${skipped} were already here` : ''}.`)
          }}
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
