'use client'

import { useState, useMemo } from 'react'
import type { TaskSummary } from '@/lib/types'
import TaskFormModal from './tasks/TaskFormModal'
import DeleteTaskDialog from './tasks/DeleteTaskDialog'
import { useProjectTasks } from './tasks/useProjectTasks'
import {
  PAYMENT_POINTS, POINTS_LABELS, PRIORITY_STYLES, STATUS_LABELS,
  compareByDue, formatDate, isOverdue, optionClass, type Priority, type TaskStatus,
} from './tasks/shared'

// The work already handed out: every task that has someone on it, by status,
// with who, deadline and priority. Items nobody has been given yet live in
// the Task List tab (the plan); both tabs read the same tasks.

export interface TasksTabProps {
  projectId: string
  /** Admin (projects.manage) or the project lead: may edit and delete any task. */
  canManage: boolean
  currentUserId: string
  /**
   * May this user raise a new task here? True for anyone on the project
   * EXCEPT external client/supplier users.
   */
  canCreate: boolean
}

type FilterMode = 'all' | 'mine' | 'TODO' | 'IN_PROGRESS' | 'DONE'

// ─── TaskRow ──────────────────────────────────────────────────────────────────

interface TaskRowProps {
  task: TaskSummary
  currentUserId: string
  canManage: boolean
  onStatusChange: (taskId: string, status: TaskStatus) => Promise<void>
  onEdit: (task: TaskSummary) => void
  onDelete: (task: TaskSummary) => void
}

function TaskRow({ task, currentUserId, canManage, onStatusChange, onEdit, onDelete }: TaskRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [updating, setUpdating] = useState(false)
  const overdue = isOverdue(task)
  // Status can be changed by admin/lead or the task's assignee; others read it.
  const canChangeStatus = canManage || task.assigneeId === currentUserId

  return (
    <div className="border-b border-border-default">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="flex-1 min-w-[12rem] text-left" title="Show details">
          {/* Payment-related tasks read in red so they stand out in a long list. */}
          <span className={`text-sm font-medium ${task.points === PAYMENT_POINTS ? 'text-status-danger' : 'text-primary'}`}>{task.title}</span>
          {task.categoryName && (
            <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-sunken text-secondary uppercase tracking-wide align-middle">
              {task.categoryName}
            </span>
          )}
        </button>
        <span className="w-32 shrink-0 text-xs text-muted truncate">{task.assigneeName ?? 'Unassigned'}</span>
        <span className="w-36 shrink-0 whitespace-nowrap">
          <span className={`text-xs ${overdue ? 'text-status-danger' : 'text-muted'}`}>{formatDate(task.dueDate)}</span>
          {overdue && <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-status-danger/20 text-status-danger">OVERDUE</span>}
        </span>
        <span className="w-24 shrink-0 flex items-center gap-1.5">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${PRIORITY_STYLES[task.priority as Priority] ?? PRIORITY_STYLES.MEDIUM}`}>{task.priority}</span>
          {task.points != null && (
            <span
              title={POINTS_LABELS[task.points] ?? `${task.points} marks`}
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${task.points === PAYMENT_POINTS ? 'bg-status-danger/20 text-status-danger' : 'bg-surface-raised text-muted'}`}
            >
              {task.points}
            </span>
          )}
        </span>
        <span className="w-28 shrink-0">
          {canChangeStatus ? (
            <select
              value={task.status}
              disabled={updating}
              onChange={async (e) => { setUpdating(true); await onStatusChange(task.id, e.target.value as TaskStatus); setUpdating(false) }}
              aria-label={`Status for ${task.title}`}
              className="w-full text-xs bg-background-primary border border-border-default rounded px-2 py-1 text-primary focus:outline-none focus:border-accent disabled:opacity-50 [color-scheme:light]"
            >
              <option value="TODO" className={optionClass}>To Do</option>
              <option value="IN_PROGRESS" className={optionClass}>In Progress</option>
              <option value="DONE" className={optionClass}>Done</option>
            </select>
          ) : (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded uppercase bg-surface-sunken text-secondary">{STATUS_LABELS[task.status as TaskStatus] ?? task.status}</span>
          )}
        </span>
        {canManage && (
          <span className="shrink-0 whitespace-nowrap">
            <button type="button" onClick={() => onEdit(task)} className="text-xs text-secondary hover:text-primary px-2 py-1">Edit</button>
            <button type="button" onClick={() => onDelete(task)} className="text-xs text-secondary hover:text-status-danger px-2 py-1">Delete</button>
          </span>
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
            <span>Marks: <span className={task.points === PAYMENT_POINTS ? 'text-status-danger' : 'text-foreground'}>{task.points != null ? (POINTS_LABELS[task.points] ?? task.points) : '—'}</span></span>
            <span>Start: <span className="text-foreground">{formatDate(task.startDate)}</span></span>
            <span>Due: <span className="text-foreground">{formatDate(task.dueDate)}</span></span>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TasksTab({ projectId, canManage, currentUserId, canCreate }: TasksTabProps) {
  const { tasks, setTasks, members, categories, loading, error, setError, notice, flash, patchTask, replaceTasks, deleteTask } = useProjectTasks(projectId)

  const [filter, setFilter]             = useState<FilterMode>(canManage ? 'all' : 'mine')
  const [person, setPerson]             = useState('')
  const [search, setSearch]             = useState('')
  const [showModal, setShowModal]       = useState(false)
  const [editingTask, setEditingTask]   = useState<TaskSummary | null>(null)
  const [deletingTask, setDeletingTask] = useState<TaskSummary | null>(null)

  // Only work that has been handed to someone; the rest is in the Task List.
  const assigned = useMemo(() => tasks.filter((t) => t.assigneeId), [tasks])
  const notAssigned = useMemo(() => tasks.filter((t) => !t.assigneeId && t.status !== 'DONE').length, [tasks])
  const people = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of assigned) m.set(t.assigneeId!, t.assigneeName ?? 'Someone')
    return [...m].sort((a, b) => a[1].localeCompare(b[1]))
  }, [assigned])

  const filtered = assigned.filter((t) => {
    if (filter === 'mine' && t.assigneeId !== currentUserId) return false
    if ((filter === 'TODO' || filter === 'IN_PROGRESS' || filter === 'DONE') && t.status !== filter) return false
    if (person && t.assigneeId !== person) return false
    if (search.trim()) {
      const q = search.toLowerCase()
      return t.title.toLowerCase().includes(q)
        || (t.assigneeName?.toLowerCase().includes(q) ?? false)
        || (t.categoryName?.toLowerCase().includes(q) ?? false)
    }
    return true
  })

  const grouped: Record<TaskStatus, TaskSummary[]> = {
    TODO:        filtered.filter((t) => t.status === 'TODO').sort(compareByDue),
    IN_PROGRESS: filtered.filter((t) => t.status === 'IN_PROGRESS').sort(compareByDue),
    DONE:        filtered.filter((t) => t.status === 'DONE').sort(compareByDue),
  }

  async function handleStatusChange(taskId: string, status: TaskStatus) {
    await patchTask(taskId, { status })
  }

  const filters: { id: FilterMode; label: string }[] = [
    { id: 'all', label: 'All' }, { id: 'mine', label: 'My Tasks' },
    { id: 'TODO', label: 'To Do' }, { id: 'IN_PROGRESS', label: 'In Progress' }, { id: 'DONE', label: 'Done' },
  ]

  return (
    <div className="space-y-4">
      {/* Items in the plan that nobody has been given yet. */}
      {canManage && !loading && notAssigned > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm bg-surface-raised border border-border-default rounded px-4 py-2.5">
          <span className="text-primary">
            {notAssigned} {notAssigned === 1 ? 'item' : 'items'} in the task list {notAssigned === 1 ? 'is' : 'are'} not assigned yet.
          </span>
          <a href="#tasklist" className="text-accent hover:underline text-xs font-medium">Open Task List</a>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${filter === f.id ? 'bg-accent text-white' : 'bg-surface-raised text-secondary hover:text-primary'}`}
          >
            {f.label}
          </button>
        ))}
        {people.length > 1 && (
          <select
            value={person}
            onChange={(e) => setPerson(e.target.value)}
            aria-label="Show one person's tasks"
            className="text-xs bg-surface-raised border border-border-default rounded px-2 py-1.5 text-primary focus:outline-none focus:border-accent [color-scheme:light]"
          >
            <option value="" className={optionClass}>Everyone</option>
            {people.map(([id, name]) => <option key={id} value={id} className={optionClass}>{name}</option>)}
          </select>
        )}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tasks…"
          className="ml-auto bg-surface-raised border border-border-default rounded px-3 py-1.5 text-xs focus:outline-none focus:border-accent w-48"
        />
        {canCreate && (
          <button type="button" onClick={() => setShowModal(true)} className="px-3 py-1.5 text-xs font-medium rounded bg-accent text-white hover:bg-accent/80 transition-colors">
            + New Task
          </button>
        )}
      </div>

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

      {!loading && (
        <div className="space-y-6">
          {(['TODO', 'IN_PROGRESS', 'DONE'] as TaskStatus[]).map((status) => (
            <div key={status}>
              <div className="flex items-center gap-3 px-4 py-2">
                <span className="text-xs font-bold tracking-widest text-muted uppercase">{STATUS_LABELS[status]}</span>
                <div className="flex-1 border-t border-border-default" />
                <span className="text-xs text-muted">{grouped[status].length}</span>
              </div>
              {grouped[status].length === 0 ? (
                <p className="text-xs text-muted px-4 pb-2 italic">No tasks</p>
              ) : (
                grouped[status].map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    currentUserId={currentUserId}
                    canManage={canManage}
                    onStatusChange={handleStatusChange}
                    onEdit={setEditingTask}
                    onDelete={setDeletingTask}
                  />
                ))
              )}
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <TaskFormModal
          mode="create"
          projectId={projectId}
          members={members}
          categories={categories}
          onClose={() => setShowModal(false)}
          onSaved={(task) => {
            setTasks((prev) => [...prev, task])
            // Nobody on it, so it is part of the plan, not this list.
            if (!task.assigneeId) flash(`"${task.title}" was added to the Task List. Assign it there to see it here.`)
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
          onSaved={(task) => {
            replaceTasks([task])
            if (!task.assigneeId) flash(`"${task.title}" is no longer assigned, so it moved back to the Task List.`)
          }}
        />
      )}

      {deletingTask && (
        <DeleteTaskDialog
          task={deletingTask}
          onCancel={() => setDeletingTask(null)}
          onConfirm={async () => {
            const err = await deleteTask(deletingTask.id)
            if (!err) setDeletingTask(null)
            return err
          }}
        />
      )}
    </div>
  )
}
