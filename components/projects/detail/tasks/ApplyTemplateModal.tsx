'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ApiResponse, TaskSummary, TaskTemplateDetail, TaskTemplateSummary } from '@/lib/types'

interface ApplyTemplateModalProps {
  projectId: string
  /** The project's tasks now, to mark template items it already has. */
  existing: TaskSummary[]
  onClose: () => void
  onApplied: (added: TaskSummary[], skipped: number) => void
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * Pick a task template and the items from it this project needs; they are
 * added to the Task List unassigned, under their categories. Items the
 * project already has are shown but cannot be added twice.
 */
export default function ApplyTemplateModal({ projectId, existing, onClose, onApplied }: ApplyTemplateModalProps) {
  const [templates, setTemplates] = useState<TaskTemplateSummary[] | null>(null)
  const [detail, setDetail] = useState<TaskTemplateDetail | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/task-templates', { credentials: 'include' })
        const json = await res.json() as ApiResponse<TaskTemplateSummary[]>
        setTemplates(json.data ?? [])
      } catch {
        setError('Could not load templates.')
      }
    })()
  }, [])

  // Which template items the project already has, counted one for one so a
  // line the template lists twice (ground and first floor) is only marked
  // "already in this project" as many times as the project has it.
  const already = useMemo(() => {
    const have = new Map<string, number>()
    for (const t of existing) {
      const key = `${t.categoryId ?? ''}|${norm(t.title)}`
      have.set(key, (have.get(key) ?? 0) + 1)
    }
    const out = new Set<string>()
    for (const i of detail?.items ?? []) {
      const key = `${i.categoryId ?? ''}|${norm(i.title)}`
      const n = have.get(key) ?? 0
      if (n > 0) { out.add(i.id); have.set(key, n - 1) }
    }
    return out
  }, [existing, detail])
  const isIn = (i: TaskTemplateDetail['items'][number]) => already.has(i.id)

  async function choose(id: string) {
    setDetail(null)
    setError(null)
    try {
      const res = await fetch(`/api/task-templates/${id}`, { credentials: 'include' })
      const json = await res.json() as ApiResponse<TaskTemplateDetail>
      if (!res.ok || !json.data) { setError(json.error ?? 'Could not load the template.'); return }
      setDetail(json.data)
      // Tick everything; items the project already has are never sent
      // (they render disabled and are dropped in apply()).
      setPicked(new Set(json.data.items.map((i) => i.id)))
    } catch {
      setError('Network error.')
    }
  }

  const groups = useMemo(() => {
    if (!detail) return []
    const order: string[] = []
    const map = new Map<string, TaskTemplateDetail['items']>()
    for (const i of detail.items) {
      const k = i.categoryName ?? 'No category'
      if (!map.has(k)) { map.set(k, []); order.push(k) }
      map.get(k)!.push(i)
    }
    return order.map((k) => ({ label: k, items: map.get(k)! }))
  }, [detail])

  function toggle(ids: string[], on: boolean) {
    setPicked((prev) => { const next = new Set(prev); for (const id of ids) { if (on) next.add(id); else next.delete(id) } return next })
  }

  const toAdd = [...picked].filter((id) => !already.has(id)).length

  async function apply() {
    if (!detail || toAdd === 0) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/apply-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ templateId: detail.id, itemIds: [...picked].filter((id) => !already.has(id)) }),
      })
      const json = await res.json() as ApiResponse<{ added: TaskSummary[]; skipped: number }>
      if (!res.ok || !json.data) { setError(json.error ?? 'Could not add the items.'); return }
      onApplied(json.data.added, json.data.skipped)
      onClose()
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-surface-raised border border-border-default rounded-lg w-full max-w-2xl mx-4 p-6 space-y-4 text-primary max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-lg font-semibold">Add from a task template</h2>
          <p className="text-xs text-muted mt-1">Untick anything this project does not need. Items are added unassigned; assign them from the Task List.</p>
        </div>

        {error && <div className="text-sm text-status-danger bg-status-danger/10 border border-status-danger/30 rounded px-3 py-2">{error}</div>}

        {templates === null ? (
          <p className="text-sm text-muted">Loading templates...</p>
        ) : templates.length === 0 ? (
          <p className="text-sm text-muted">No task templates yet. An admin can add them under Projects, Task templates.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                disabled={t.itemCount === 0}
                title={t.itemCount === 0 ? 'This template has no items yet' : undefined}
                onClick={() => void choose(t.id)}
                className={`text-left px-3 py-2 rounded border text-sm disabled:opacity-40 disabled:cursor-not-allowed ${detail?.id === t.id ? 'border-accent bg-accent/10' : 'border-border-default hover:border-accent/60'}`}
              >
                <span className="font-medium">{t.name}</span>
                <span className="block text-[11px] text-muted">{t.itemCount} items</span>
              </button>
            ))}
          </div>
        )}

        {detail && (
          <div className="flex-1 overflow-y-auto space-y-3 border-t border-border-default pt-3">
            {groups.map((g) => {
              const addable = g.items.filter((i) => !isIn(i))
              const all = addable.length > 0 && addable.every((i) => picked.has(i.id))
              return (
                <div key={g.label}>
                  <label className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
                    <input
                      type="checkbox"
                      checked={all}
                      disabled={addable.length === 0}
                      onChange={() => toggle(addable.map((i) => i.id), !all)}
                      className="accent-[rgb(var(--c-accent))] h-4 w-4"
                    />
                    {g.label}
                    <span className="text-xs text-muted normal-case font-normal tracking-normal">{g.items.length} items</span>
                  </label>
                  <ul className="mt-1 pl-6 space-y-0.5">
                    {g.items.map((i) => {
                      const already = isIn(i)
                      return (
                        <li key={i.id}>
                          <label className={`flex items-start gap-2 text-sm ${already ? 'text-muted' : 'text-secondary'}`}>
                            <input
                              type="checkbox"
                              checked={!already && picked.has(i.id)}
                              disabled={already}
                              onChange={() => toggle([i.id], !picked.has(i.id))}
                              className="accent-[rgb(var(--c-accent))] h-3.5 w-3.5 mt-0.5"
                            />
                            <span>{i.title}{already && <span className="text-[11px] ml-1">(already in this project)</span>}</span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )
            })}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-secondary hover:text-primary">Cancel</button>
          <button
            type="button"
            disabled={!detail || toAdd === 0 || busy}
            onClick={() => void apply()}
            className="px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? 'Adding...' : `Add ${toAdd} ${toAdd === 1 ? 'item' : 'items'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
