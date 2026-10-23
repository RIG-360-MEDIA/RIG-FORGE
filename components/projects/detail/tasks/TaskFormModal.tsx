'use client'

import { useState } from 'react'
import type { TaskCategorySummary, TaskSummary, ApiResponse } from '@/lib/types'

type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE'
type Priority   = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface Member {
  userId: string
  name: string
  avatarUrl: string | null
}

// ─── TaskFormModal ────────────────────────────────────────────────────────────

export interface TaskFormModalProps {
  mode: 'create' | 'edit'
  projectId: string
  members: Member[]
  categories: TaskCategorySummary[]
  /** Pre-selected category for a new task (the group it was opened from). */
  defaultCategoryId?: string | null
  task?: TaskSummary | null   // required when mode === 'edit'
  onClose: () => void
  onSaved: (task: TaskSummary) => void
}

export default function TaskFormModal({ mode, projectId, members, categories, defaultCategoryId, task, onClose, onSaved }: TaskFormModalProps) {
  const isEdit = mode === 'edit'
  const [title, setTitle]               = useState(task?.title ?? '')
  // One text field. Tasks used to have a separate Expected Output; an older
  // task that has one is folded into the description when edited, so nothing
  // is lost and the separate field empties out over time.
  const [description, setDescription]   = useState(() => {
    const d = task?.description?.trim() ?? ''
    const eo = task?.expectedOutput?.trim() ?? ''
    if (!eo) return d
    return d ? `${d}\n\nExpected output: ${eo}` : `Expected output: ${eo}`
  })
  const [assigneeId, setAssigneeId]     = useState(task?.assigneeId ?? '')
  const [categoryId, setCategoryId]     = useState(task?.categoryId ?? defaultCategoryId ?? '')
  const [priority, setPriority]         = useState<Priority>((task?.priority as Priority) ?? 'MEDIUM')
  const [points, setPoints]             = useState<string>(task?.points != null ? String(task.points) : '')
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
    // Only the title is required.
    if (!title.trim()) {
      setError('Title is required.')
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
        // Folded into the description above (see the initial value).
        expectedOutput: null,
        assigneeId: assigneeId || null,
        categoryId: categoryId || null,
        priority,
        points: points === '' ? null : Number(points),
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
              rows={4}
              className={`${fieldClass} resize-y`}
              placeholder="Optional: what needs to be done and what should be delivered"
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
              <label className="text-xs text-muted uppercase tracking-wider">Category</label>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className={fieldClass}
              >
                <option value="" className="bg-background-primary text-primary">No category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id} className="bg-background-primary text-primary">
                    {c.name}
                  </option>
                ))}
                {/* An archived category stays selectable on a task that already has it. */}
                {task?.categoryId && !categories.some((c) => c.id === task.categoryId) && (
                  <option value={task.categoryId} className="bg-background-primary text-primary">
                    {task.categoryName ?? 'Archived category'}
                  </option>
                )}
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
              <label className="text-xs text-muted uppercase tracking-wider">Marks</label>
              <select
                value={points}
                onChange={(e) => setPoints(e.target.value)}
                className={fieldClass}
              >
                <option value="" className="bg-background-primary text-primary">— None —</option>
                <option value="1" className="bg-background-primary text-primary">1 — Small task</option>
                <option value="2" className="bg-background-primary text-primary">2 — Bigger task</option>
                <option value="5" className="bg-background-primary text-primary">5 — Payment related</option>
              </select>
              {points === '5' && (
                <p className="mt-1 text-[10px] text-status-danger">
                  Payment task — will be set to at least HIGH priority
                </p>
              )}
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
