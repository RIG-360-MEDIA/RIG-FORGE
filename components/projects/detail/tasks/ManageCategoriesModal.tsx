'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiResponse, TaskCategorySummary } from '@/lib/types'

interface ManageCategoriesModalProps {
  onClose: () => void
  /** Called after any change, so the Tasks tab reloads its category list. */
  onChanged: () => void
}

/**
 * Admin list of the company's task categories: rename, reorder, archive and
 * bring back. Categories are shared by every project, so changes here show
 * on all of them. Archiving hides a category from pickers but leaves it on
 * the tasks that already use it.
 */
export default function ManageCategoriesModal({ onClose, onChanged }: ManageCategoriesModalProps) {
  const [rows, setRows] = useState<TaskCategorySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/task-categories?all=1', { credentials: 'include' })
      const json = await res.json() as ApiResponse<TaskCategorySummary[]>
      if (!res.ok || json.error) { setError(json.error ?? 'Could not load categories.'); return }
      setRows(json.data ?? [])
    } catch {
      setError('Network error loading categories.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function save(id: string, body: Record<string, unknown>): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/task-categories/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      })
      const json = await res.json() as ApiResponse<TaskCategorySummary>
      if (!res.ok || json.error) { setError(json.error ?? 'Could not save.'); return false }
      return true
    } catch {
      setError('Network error. Please try again.')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function rename(id: string) {
    if (!draft.trim()) return
    if (await save(id, { name: draft })) { setEditingId(null); await load(); onChanged() }
  }

  async function toggleActive(row: TaskCategorySummary) {
    if (await save(row.id, { isActive: !row.isActive })) { await load(); onChanged() }
  }

  // Swap with the neighbour, then number every row by its new position, so
  // rows that shared a sortOrder (added at the same time) still move.
  async function move(index: number, delta: -1 | 1) {
    const other = index + delta
    if (other < 0 || other >= rows.length) return
    const order = [...rows]
    ;[order[index], order[other]] = [order[other]!, order[index]!]
    const results = await Promise.all(order.map((r, i) => (r.sortOrder !== i ? save(r.id, { sortOrder: i }) : true)))
    if (results.some(Boolean)) { await load(); onChanged() }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface-raised border border-border-default rounded-lg w-full max-w-md mx-4 p-6 space-y-4 text-primary max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-semibold text-primary">Task categories</h2>
          <p className="text-xs text-muted mt-1">
            Shared by every project. Archived categories stay on the tasks that use them but can no longer be picked.
          </p>
        </div>

        {error && (
          <div className="text-sm text-status-danger bg-status-danger/10 border border-status-danger/30 rounded px-3 py-2">{error}</div>
        )}

        <div className="flex-1 overflow-y-auto -mx-2">
          {loading && <p className="text-sm text-muted px-2">Loading...</p>}
          {!loading && rows.length === 0 && (
            <p className="text-sm text-muted px-2">No categories yet. Add one from a project&apos;s Tasks tab.</p>
          )}
          <ul className="space-y-1">
            {rows.map((row, i) => (
              <li key={row.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-sunken/60">
                {editingId === row.id ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void rename(row.id)
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    maxLength={60}
                    className="flex-1 bg-background-primary border border-border-default rounded px-2 py-1 text-sm text-primary focus:outline-none focus:border-accent"
                  />
                ) : (
                  <span className={`flex-1 text-sm ${row.isActive ? 'text-primary' : 'text-muted line-through'}`}>{row.name}</span>
                )}
                {editingId === row.id ? (
                  <>
                    <button type="button" disabled={busy} onClick={() => void rename(row.id)} className="text-xs text-accent hover:underline disabled:opacity-50">Save</button>
                    <button type="button" onClick={() => setEditingId(null)} className="text-xs text-secondary hover:text-primary">Cancel</button>
                  </>
                ) : (
                  <>
                    <button type="button" disabled={busy || i === 0} onClick={() => void move(i, -1)} aria-label={`Move ${row.name} up`} className="text-xs text-secondary hover:text-primary disabled:opacity-30 px-1">Up</button>
                    <button type="button" disabled={busy || i === rows.length - 1} onClick={() => void move(i, 1)} aria-label={`Move ${row.name} down`} className="text-xs text-secondary hover:text-primary disabled:opacity-30 px-1">Down</button>
                    <button type="button" disabled={busy} onClick={() => { setEditingId(row.id); setDraft(row.name) }} className="text-xs text-secondary hover:text-primary px-1">Rename</button>
                    <button type="button" disabled={busy} onClick={() => void toggleActive(row)} className="text-xs text-secondary hover:text-primary px-1">
                      {row.isActive ? 'Archive' : 'Restore'}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex justify-end pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent-hover transition-colors">Done</button>
        </div>
      </div>
    </div>
  )
}
