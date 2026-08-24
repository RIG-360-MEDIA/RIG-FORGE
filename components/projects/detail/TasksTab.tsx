'use client'

import { useState, useEffect, useCallback } from 'react'
import type { TaskSummary, PaginatedResponse, ApiResponse } from '@/lib/types'

// ─── Types ────────────────────────────────────────────────────────────────────

type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE'
type Priority   = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

interface Member {
  userId: string
  name: string
  avatarUrl: string | null
}

export interface TasksTabProps {
  projectId: string
  isAdmin: boolean
  isLead: boolean
  currentUserId: string
}

type FilterMode = 'all' | 'mine' | 'TODO' | 'IN_PROGRESS' | 'DONE'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PRIORITY_STYLES: Record<Priority, string> = {
  LOW:      'bg-gray-700 text-gray-300',
  MEDIUM:   'bg-blue-900 text-blue-300',
  HIGH:     'bg-orange-900 text-orange-300',
  CRITICAL: 'bg-red-900 text-red-300',
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  TODO:        'To Do',
  IN_PROGRESS: 'In Progress',
  DONE:        'Done',
}

function isOverdue(task: TaskSummary): boolean {
  if (!task.dueDate || task.status === 'DONE') return false
  return new Date(task.dueDate) < new Date()
}

function formatDate(date: Date | null): string {
  if (!date) return 'No due date'
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

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

  async function handleStatusChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as TaskStatus
    setUpdating(true)
    await onStatusChange(task.id, next)
    setUpdating(false)
  }

  const overdue    = isOverdue(task)
  const isAssignee = task.assigneeId === currentUserId
  // Status can be changed by admin/lead or the task's assignee.
  // Others get a read-only badge.
  const canChangeStatus = canManage || isAssignee

  return (
    <>
      <tr
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`Toggle task details: ${task.title}`}
        className="border-b border-border-default hover:bg-surface-raised/50 cursor-pointer transition-colors"
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((v) => !v) } }}
      >
        <td className="py-3 px-4 max-w-xs">
          <span className="text-sm font-medium truncate block text-primary">{task.title}</span>
        </td>
        <td className="py-3 px-4 text-sm text-muted whitespace-nowrap">
          {task.assigneeName ?? 'Unassigned'}
        </td>
        <td className="py-3 px-4 whitespace-nowrap">
          <span className={`text-xs ${overdue ? 'text-status-danger' : 'text-muted'}`}>
            {formatDate(task.dueDate)}
          </span>
          {overdue && (
            <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-status-danger/20 text-status-danger">
              OVERDUE
            </span>
          )}
        </td>
        <td className="py-3 px-4">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${PRIORITY_STYLES[task.priority as Priority] ?? PRIORITY_STYLES.MEDIUM}`}>
            {task.priority}
          </span>
        </td>
        <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
          {canChangeStatus ? (
            <select
              value={task.status}
              onChange={handleStatusChange}
              disabled={updating}
              className="text-xs bg-background-primary border border-border-default rounded px-2 py-1 text-primary focus:outline-none focus:border-accent disabled:opacity-50 [color-scheme:light]"
            >
              <option value="TODO" className="bg-background-primary text-primary">To Do</option>
              <option value="IN_PROGRESS" className="bg-background-primary text-primary">In Progress</option>
              <option value="DONE" className="bg-background-primary text-primary">Done</option>
            </select>
          ) : (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded uppercase bg-surface-sunken text-secondary">
              {STATUS_LABELS[task.status as TaskStatus] ?? task.status}
            </span>
          )}
        </td>
        {canManage && (
          <td className="py-3 px-4 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => onEdit(task)}
              className="text-xs text-secondary hover:text-primary px-2 py-1 transition-colors"
              title="Edit task"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => onDelete(task)}
              className="text-xs text-secondary hover:text-status-danger px-2 py-1 transition-colors ml-1"
              title="Delete task"
            >
              Delete
            </button>
          </td>
        )}
      </tr>

      {expanded && (
        <tr className="border-b border-border-default bg-surface-raised/30">
          <td colSpan={canManage ? 6 : 5} className="px-6 py-4">
            <div className="space-y-2 text-sm">
              {task.description && (
                <div>
                  <span className="text-muted text-xs uppercase tracking-wider">Description</span>
                  <p className="mt-1 text-foreground">{task.description}</p>
                </div>
              )}
              {task.expectedOutput && (
                <div>
                  <span className="text-muted text-xs uppercase tracking-wider">Expected Output</span>
                  <p className="mt-1 text-foreground">{task.expectedOutput}</p>
                </div>
              )}
              <div className="flex gap-6 text-xs text-muted pt-1">
                <span>Status: <span className="text-foreground">{STATUS_LABELS[task.status as TaskStatus] ?? task.status}</span></span>
                <span>Priority: <span className="text-foreground">{task.priority}</span></span>
                <span>Assignee: <span className="text-foreground">{task.assigneeName ?? 'Unassigned'}</span></span>
                <span>Start: <span className="text-foreground">{formatDate(task.startDate)}</span></span>
                <span>Due: <span className="text-foreground">{formatDate(task.dueDate)}</span></span>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ─── TaskFormModal ────────────────────────────────────────────────────────────

interface TaskFormModalProps {
  mode: 'create' | 'edit'
  projectId: string
  members: Member[]
  task?: TaskSummary | null   // required when mode === 'edit'
  onClose: () => void
  onSaved: (task: TaskSummary) => void
}

function TaskFormModal({ mode, projectId, members, task, onClose, onSaved }: TaskFormModalProps) {
  const isEdit = mode === 'edit'
  const [title, setTitle]               = useState(task?.title ?? '')
  const [description, setDescription]   = useState(task?.description ?? '')
  const [expectedOutput, setExpected]   = useState(task?.expectedOutput ?? '')
  const [assigneeId, setAssigneeId]     = useState(task?.assigneeId ?? '')
  const [priority, setPriority]         = useState<Priority>((task?.priority as Priority) ?? 'MEDIUM')
  const [startDate, setStartDate]       = useState(
    task?.startDate ? new Date(task.startDate).toISOString().slice(0, 10) : '',
  )
  const [dueDate, setDueDate]           = useState(
    task?.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : '',
  )
  const [status, setStatus]             = useState<TaskStatus>((task?.status as TaskStatus) ?? 'TODO')
  const [submitting, setSubmitting]     = useState(false)
  const [error, setError]               = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !expectedOutput.trim()) {
      setError('Title and Expected Output are required.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const url    = isEdit ? `/api/tasks/${task!.id}` : '/api/tasks'
      const method = isEdit ? 'PATCH' : 'POST'
      const payload: Record<string, unknown> = {
        title: title.trim(),
        description: description.trim() || null,
        expectedOutput: expectedOutput.trim(),
        assigneeId: assigneeId || null,
        priority,
        startDate: startDate || null,
        dueDate: dueDate || null,
        status,
      }
      if (startDate && dueDate && new Date(startDate) > new Date(dueDate)) {
        setError('Start date must be on or before the due date.')
        setSubmitting(false)
        return
      }
      if (!isEdit) payload.projectId = projectId

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      })
      const json = await res.json() as ApiResponse<TaskSummary>
      if (!res.ok || json.error) {
        setError(json.error ?? `Failed to ${isEdit ? 'update' : 'create'} task.`)
        return
      }
      if (json.data) onSaved(json.data)
      onClose()
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const fieldClass =
    'mt-1 w-full bg-background-primary border border-border-default rounded px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-accent [color-scheme:light]'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface-raised border border-border-default rounded-lg w-full max-w-lg mx-4 p-6 space-y-4 text-primary">
        <h2 className="text-lg font-semibold text-primary">{isEdit ? 'Edit Task' : 'New Task'}</h2>

        {error && (
          <div className="text-sm text-status-danger bg-status-danger/10 border border-status-danger/30 rounded px-3 py-2">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-muted uppercase tracking-wider">Title *</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={fieldClass}
              placeholder="Task title"
              required
            />
          </div>

          <div>
            <label className="text-xs text-muted uppercase tracking-wider">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className={`${fieldClass} resize-none`}
              placeholder="Optional description"
            />
          </div>

          <div>
            <label className="text-xs text-muted uppercase tracking-wider">Expected Output *</label>
            <textarea
              value={expectedOutput}
              onChange={(e) => setExpected(e.target.value)}
              rows={2}
              className={`${fieldClass} resize-none`}
              placeholder="What should be delivered?"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted uppercase tracking-wider">Assignee</label>
              <select
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                className={fieldClass}
              >
                <option value="" className="bg-background-primary text-primary">Unassigned</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId} className="bg-background-primary text-primary">
                    {m.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs text-muted uppercase tracking-wider">Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
                className={fieldClass}
              >
                <option value="LOW" className="bg-background-primary text-primary">Low</option>
                <option value="MEDIUM" className="bg-background-primary text-primary">Medium</option>
                <option value="HIGH" className="bg-background-primary text-primary">High</option>
                <option value="CRITICAL" className="bg-background-primary text-primary">Critical</option>
              </select>
            </div>

            <div>
              <label className="text-xs text-muted uppercase tracking-wider">Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={fieldClass}
              />
            </div>

            <div>
              <label className="text-xs text-muted uppercase tracking-wider">Due Date</label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                min={startDate || undefined}
                className={fieldClass}
              />
            </div>

            <div>
              <label className="text-xs text-muted uppercase tracking-wider">Status</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as TaskStatus)}
                className={fieldClass}
              >
                <option value="TODO" className="bg-background-primary text-primary">To Do</option>
                <option value="IN_PROGRESS" className="bg-background-primary text-primary">In Progress</option>
                <option value="DONE" className="bg-background-primary text-primary">Done</option>
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-muted hover:text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 transition-colors"
            >
              {submitting
                ? (isEdit ? 'Saving…' : 'Creating…')
                : (isEdit ? 'Save Changes' : 'Create Task')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── TaskGroup ────────────────────────────────────────────────────────────────

interface TaskGroupProps {
  label: string
  tasks: TaskSummary[]
  currentUserId: string
  canManage: boolean
  onStatusChange: (taskId: string, status: TaskStatus) => Promise<void>
  onEdit: (task: TaskSummary) => void
  onDelete: (task: TaskSummary) => void
}

function TaskGroup({ label, tasks, currentUserId, canManage, onStatusChange, onEdit, onDelete }: TaskGroupProps) {
  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-2">
        <span className="text-xs font-bold tracking-widest text-muted uppercase">{label}</span>
        <div className="flex-1 border-t border-border-default" />
        <span className="text-xs text-muted">{tasks.length}</span>
      </div>
      {tasks.length === 0 ? (
        <p className="text-xs text-muted px-4 pb-2 italic">No tasks</p>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full">
          <tbody>
            {tasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                currentUserId={currentUserId}
                canManage={canManage}
                onStatusChange={onStatusChange}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TasksTab({ projectId, isAdmin, isLead, currentUserId }: TasksTabProps) {
  const canManage = isAdmin || isLead

  const [tasks, setTasks]               = useState<TaskSummary[]>([])
  const [members, setMembers]           = useState<Member[]>([])
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState<string | null>(null)
  const [filter, setFilter]             = useState<FilterMode>(canManage ? 'all' : 'mine')
  const [search, setSearch]             = useState('')
  const [showModal, setShowModal]       = useState(false)
  const [editingTask, setEditingTask]   = useState<TaskSummary | null>(null)
  const [deletingTask, setDeletingTask] = useState<TaskSummary | null>(null)
  const [deleteSubmitting, setDeleteSubmitting] = useState(false)
  const [deleteError, setDeleteError]   = useState<string | null>(null)

  const fetchTasks = useCallback(async () => {
    setError(null)
    try {
      const params = new URLSearchParams({ projectId, limit: '50' })
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
      const res = await fetch(`/api/projects/${projectId}/members`, { credentials: 'include' })
      if (!res.ok) return
      const json = await res.json() as ApiResponse<Member[]>
      if (json.data) setMembers(json.data)
    } catch {
      // Members are optional for the modal — fail silently
    }
  }, [projectId])

  useEffect(() => {
    void fetchTasks()
    void fetchMembers()
  }, [fetchTasks, fetchMembers])

  async function handleStatusChange(taskId: string, status: TaskStatus): Promise<void> {
    // Optimistic update
    setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status } : t))
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        // Revert on failure
        void fetchTasks()
      }
    } catch {
      void fetchTasks()
    }
  }

  function handleTaskCreated(task: TaskSummary) {
    setTasks((prev) => [task, ...prev])
  }

  function handleTaskUpdated(task: TaskSummary) {
    setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)))
  }

  async function handleDeleteConfirm() {
    if (!deletingTask) return
    setDeleteSubmitting(true)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/tasks/${deletingTask.id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      const json = await res.json() as ApiResponse<{ id: string }>
      if (!res.ok || json.error) {
        setDeleteError(json.error ?? 'Failed to delete task.')
        return
      }
      setTasks((prev) => prev.filter((t) => t.id !== deletingTask.id))
      setDeletingTask(null)
    } catch {
      setDeleteError('Network error. Please try again.')
    } finally {
      setDeleteSubmitting(false)
    }
  }

  // ── Filtering ──────────────────────────────────────────────────────────────

  const filtered = tasks.filter((t) => {
    if (filter === 'mine' && t.assigneeId !== currentUserId) return false
    if (filter === 'TODO' && t.status !== 'TODO') return false
    if (filter === 'IN_PROGRESS' && t.status !== 'IN_PROGRESS') return false
    if (filter === 'DONE' && t.status !== 'DONE') return false
    if (search.trim()) {
      const q = search.toLowerCase()
      return t.title.toLowerCase().includes(q) || (t.assigneeName?.toLowerCase().includes(q) ?? false)
    }
    return true
  })

  const grouped: Record<TaskStatus, TaskSummary[]> = {
    TODO:        filtered.filter((t) => t.status === 'TODO'),
    IN_PROGRESS: filtered.filter((t) => t.status === 'IN_PROGRESS'),
    DONE:        filtered.filter((t) => t.status === 'DONE'),
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        {canManage && (
          <>
            {(['all', 'mine', 'TODO', 'IN_PROGRESS', 'DONE'] as FilterMode[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={[
                  'px-3 py-1.5 text-xs font-medium rounded transition-colors',
                  filter === f
                    ? 'bg-accent text-white'
                    : 'bg-surface-raised text-secondary hover:text-primary',
                ].join(' ')}
              >
                {f === 'all' ? 'All' : f === 'mine' ? 'My Tasks' : STATUS_LABELS[f as TaskStatus]}
              </button>
            ))}
          </>
        )}

        {!canManage && (
          <span className="px-3 py-1.5 text-xs font-medium rounded bg-accent text-white">
            My Tasks
          </span>
        )}

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
            onClick={() => setShowModal(true)}
            className="px-3 py-1.5 text-xs font-medium rounded bg-accent text-white hover:bg-accent/80 transition-colors"
          >
            + New Task
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="text-sm text-status-danger bg-status-danger/10 border border-status-danger/30 rounded px-3 py-2">
          {error}
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

      {/* Task groups */}
      {!loading && (
        <div className="space-y-6">
          <TaskGroup
            label="To Do"
            tasks={grouped.TODO}
            currentUserId={currentUserId}
            canManage={canManage}
            onStatusChange={handleStatusChange}
            onEdit={setEditingTask}
            onDelete={setDeletingTask}
          />
          <TaskGroup
            label="In Progress"
            tasks={grouped.IN_PROGRESS}
            currentUserId={currentUserId}
            canManage={canManage}
            onStatusChange={handleStatusChange}
            onEdit={setEditingTask}
            onDelete={setDeletingTask}
          />
          <TaskGroup
            label="Done"
            tasks={grouped.DONE}
            currentUserId={currentUserId}
            canManage={canManage}
            onStatusChange={handleStatusChange}
            onEdit={setEditingTask}
            onDelete={setDeletingTask}
          />
        </div>
      )}

      {/* New task modal */}
      {showModal && (
        <TaskFormModal
          mode="create"
          projectId={projectId}
          members={members}
          onClose={() => setShowModal(false)}
          onSaved={handleTaskCreated}
        />
      )}

      {/* Edit task modal */}
      {editingTask && (
        <TaskFormModal
          mode="edit"
          projectId={projectId}
          members={members}
          task={editingTask}
          onClose={() => setEditingTask(null)}
          onSaved={handleTaskUpdated}
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
