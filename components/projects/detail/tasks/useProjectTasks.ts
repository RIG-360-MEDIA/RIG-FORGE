'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiResponse, PaginatedResponse, TaskCategorySummary, TaskSummary } from '@/lib/types'
import type { Member } from './TaskFormModal'

/**
 * A project's tasks, the people who can be given them, and the company's task
 * categories, with every write the Task List and Tasks tabs make. Both tabs
 * read the same tasks: the Task List is the plan, the Tasks tab the work
 * already handed out.
 */
export function useProjectTasks(projectId: string) {
  const [tasks, setTasks]           = useState<TaskSummary[]>([])
  const [members, setMembers]       = useState<Member[]>([])
  const [categories, setCategories] = useState<TaskCategorySummary[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)
  const [notice, setNotice]         = useState<string | null>(null)

  const flash = useCallback((message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice((m) => (m === message ? null : m)), 4000)
  }, [])

  const fetchTasks = useCallback(async () => {
    try {
      const params = new URLSearchParams({ projectId, limit: '500' })
      const res = await fetch(`/api/tasks?${params}`, { credentials: 'include' })
      const json = await res.json() as ApiResponse<PaginatedResponse<TaskSummary>>
      if (!res.ok || json.error) { setError(json.error ?? 'Failed to load tasks.'); return }
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

  const replaceTasks = useCallback((updated: TaskSummary[]) => {
    const byId = new Map(updated.map((t) => [t.id, t]))
    setTasks((prev) => prev.map((t) => byId.get(t.id) ?? t))
  }, [])

  /** Change one task. Status changes show at once; others when the server confirms. */
  const patchTask = useCallback(async (taskId: string, change: Record<string, unknown>): Promise<boolean> => {
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
        return false
      }
      replaceTasks([json.data])
      return true
    } catch {
      setError('Network error. Please try again.')
      void fetchTasks()
      return false
    }
  }, [fetchTasks, replaceTasks])

  const createOne = useCallback(async (title: string, categoryId: string | null): Promise<boolean> => {
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
      return true
    } catch {
      setError('Network error. Please try again.')
      return false
    }
  }, [projectId])

  const createMany = useCallback(async (titles: string[], categoryId: string | null): Promise<boolean> => {
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
      flash(`Added ${json.data.length} items.`)
      return true
    } catch {
      setError('Network error. Please try again.')
      return false
    }
  }, [projectId, flash])

  /** Change many tasks at once; returns how many were changed, or null on failure. */
  const bulkUpdate = useCallback(async (taskIds: string[], set: Record<string, unknown>): Promise<number | null> => {
    try {
      const res = await fetch('/api/tasks/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ taskIds, set }),
      })
      const json = await res.json() as ApiResponse<TaskSummary[]>
      if (!res.ok || json.error || !json.data) { setError(json.error ?? 'Could not update the tasks.'); return null }
      replaceTasks(json.data)
      return json.data.length
    } catch {
      setError('Network error. Please try again.')
      return null
    }
  }, [replaceTasks])

  const addCategory = useCallback(async (name: string): Promise<TaskCategorySummary | null> => {
    const clean = name.trim()
    if (!clean) return null
    try {
      const res = await fetch('/api/task-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: clean, projectId }),
      })
      const json = await res.json() as ApiResponse<TaskCategorySummary>
      if (!res.ok || json.error || !json.data) { setError(json.error ?? 'Could not add the category.'); return null }
      const cat = json.data
      setCategories((prev) => (prev.some((c) => c.id === cat.id) ? prev : [...prev, cat]))
      return cat
    } catch {
      setError('Network error. Please try again.')
      return null
    }
  }, [projectId])

  /** Soft-delete; returns an error message, or null when it worked. */
  const deleteTask = useCallback(async (taskId: string): Promise<string | null> => {
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE', credentials: 'include' })
      const json = await res.json() as ApiResponse<{ id: string }>
      if (!res.ok || json.error) return json.error ?? 'Failed to delete task.'
      setTasks((prev) => prev.filter((t) => t.id !== taskId))
      return null
    } catch {
      return 'Network error. Please try again.'
    }
  }, [])

  return {
    tasks, setTasks, members, categories, loading, error, setError, notice, flash,
    fetchTasks, fetchCategories, replaceTasks, patchTask, createOne, createMany, bulkUpdate, addCategory, deleteTask,
  }
}
