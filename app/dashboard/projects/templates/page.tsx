'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useAuth } from '@/hooks/useAuth'
import { userCan } from '@/lib/permissions'
import ImportTemplatesModal from '@/components/projects/templates/ImportTemplatesModal'
import type { ApiResponse, TaskTemplateSummary } from '@/lib/types'

/**
 * Task templates: ready-made task lists (Architectural design, Interior
 * design...) that a project's Task List is filled from in one step. Admins
 * (tasks.manage) create, import, edit and archive them here.
 */
export default function TaskTemplatesPage() {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const canManage = userCan(user, 'tasks.manage')

  const [rows, setRows] = useState<TaskTemplateSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/task-templates?all=1', { credentials: 'include' })
      const json = await res.json() as ApiResponse<TaskTemplateSummary[]>
      if (!res.ok || json.error) { setError(json.error ?? 'Could not load templates.'); return }
      setRows(json.data ?? [])
    } catch {
      setError('Network error loading templates.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function createEmpty() {
    const name = newName.trim()
    if (!name) return
    const res = await fetch('/api/task-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, items: [] }),
    })
    const json = await res.json() as ApiResponse<{ id: string }>
    if (!res.ok || !json.data) { setError(json.error ?? 'Could not create the template.'); return }
    router.push(`/dashboard/projects/templates/${json.data.id}`)
  }

  async function setActive(t: TaskTemplateSummary, isActive: boolean) {
    const res = await fetch(`/api/task-templates/${t.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ isActive }),
    })
    if (!res.ok) { setError('Could not change the template.'); return }
    await load()
  }

  if (!authLoading && !canManage) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <p className="text-sm text-muted">Only admins can manage task templates.</p>
      </div>
    )
  }

  const active = rows.filter((r) => r.isActive)
  const archived = rows.filter((r) => !r.isActive)

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-5">
      <div>
        <button type="button" onClick={() => router.push('/dashboard/projects')} className="font-mono text-xs tracking-widest text-muted hover:text-primary">
          ← PROJECTS
        </button>
        <div className="flex flex-wrap items-end justify-between gap-3 mt-2">
          <div>
            <h1 className="text-2xl font-semibold text-primary">Task templates</h1>
            <p className="text-sm text-secondary mt-1">
              Ready-made task lists. Pick one when you create a project, or from a project&apos;s Task List, and its items are added there to assign.
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setImporting(true)} className="px-3 py-1.5 text-xs font-medium rounded bg-surface-raised border border-border-default text-primary hover:border-accent">
              Import from Excel
            </button>
            <button type="button" onClick={() => setCreating((v) => !v)} className="px-3 py-1.5 text-xs font-medium rounded bg-accent text-white hover:bg-accent-hover">
              + New template
            </button>
          </div>
        </div>
      </div>

      {creating && (
        <div className="flex gap-2 bg-surface-raised border border-border-default rounded-lg px-4 py-3">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void createEmpty(); if (e.key === 'Escape') setCreating(false) }}
            maxLength={100}
            placeholder="Template name, e.g. Residential bungalow"
            aria-label="New template name"
            className="flex-1 bg-background-primary border border-border-default rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent"
          />
          <button type="button" onClick={() => void createEmpty()} className="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent-hover">Create and add items</button>
        </div>
      )}

      {notice && <div role="status" className="text-sm text-status-success bg-status-success/10 border border-status-success/30 rounded px-3 py-2">{notice}</div>}
      {error && <div className="text-sm text-status-danger bg-status-danger/10 border border-status-danger/30 rounded px-3 py-2">{error}</div>}

      {loading ? (
        <div className="space-y-2">{[...Array(3)].map((_, i) => <div key={i} className="h-16 bg-surface-raised rounded animate-pulse" />)}</div>
      ) : active.length === 0 ? (
        <div className="border border-dashed border-border-default rounded-lg px-6 py-10 text-center space-y-2">
          <p className="text-sm text-primary">No task templates yet.</p>
          <p className="text-xs text-muted">Import your Excel task lists, or create one and add items.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {active.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center gap-3 border border-border-default rounded-lg px-4 py-3 bg-surface-raised/40 hover:border-accent/60">
              <button type="button" onClick={() => router.push(`/dashboard/projects/templates/${t.id}`)} className="flex-1 min-w-[14rem] text-left">
                <p className="text-sm font-semibold text-primary">{t.name}</p>
                <p className="text-xs text-muted mt-0.5">
                  {t.itemCount} items{t.categories.length ? `: ${t.categories.join(', ')}` : ''}
                </p>
              </button>
              <button type="button" onClick={() => router.push(`/dashboard/projects/templates/${t.id}`)} className="text-xs text-secondary hover:text-primary px-2 py-1">Edit</button>
              <button type="button" onClick={() => void setActive(t, false)} className="text-xs text-secondary hover:text-status-danger px-2 py-1">Archive</button>
            </div>
          ))}
        </div>
      )}

      {archived.length > 0 && (
        <div className="space-y-2 pt-2">
          <p className="text-xs text-muted uppercase tracking-wider">Archived</p>
          {archived.map((t) => (
            <div key={t.id} className="flex items-center gap-3 border border-border-default rounded-lg px-4 py-2 opacity-70">
              <span className="flex-1 text-sm text-secondary">{t.name} <span className="text-xs text-muted">({t.itemCount} items)</span></span>
              <button type="button" onClick={() => void setActive(t, true)} className="text-xs text-secondary hover:text-primary px-2 py-1">Restore</button>
            </div>
          ))}
        </div>
      )}

      {importing && (
        <ImportTemplatesModal
          existingNames={rows.map((r) => r.name)}
          onClose={() => setImporting(false)}
          onImported={(n) => { setNotice(`Imported ${n} ${n === 1 ? 'template' : 'templates'}.`); void load() }}
        />
      )}
    </div>
  )
}
