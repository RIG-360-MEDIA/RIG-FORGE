'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

import { useAuth } from '@/hooks/useAuth'
import { userCan } from '@/lib/permissions'
import type { ApiResponse, TaskCategorySummary, TaskTemplateDetail } from '@/lib/types'

interface Row { key: string; title: string; categoryId: string | null }

const NONE = '__none__'
let seq = 0
const newKey = () => `n${++seq}`

/** Non-empty lines of pasted text, list bullets and numbering removed. */
function pastedLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•▪◦]|\d{1,3}[.)])\s+/, '').trim()).filter(Boolean)
}

/**
 * Edit one task template: its name and its items, grouped by category in the
 * order they were written. Nothing is saved until "Save template"; saving
 * replaces the items, and projects the template was already used on keep
 * their tasks.
 */
export default function TaskTemplateEditorPage() {
  const router = useRouter()
  const { templateId } = useParams<{ templateId: string }>()
  const { user, loading: authLoading } = useAuth()
  const canManage = userCan(user, 'tasks.manage')

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [categories, setCategories] = useState<TaskCategorySummary[]>([])
  const [extraGroups, setExtraGroups] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [addingGroup, setAddingGroup] = useState(false)
  const [groupDraft, setGroupDraft] = useState('')

  const load = useCallback(async () => {
    try {
      const [tRes, cRes] = await Promise.all([
        fetch(`/api/task-templates/${templateId}`, { credentials: 'include' }),
        fetch('/api/task-categories', { credentials: 'include' }),
      ])
      const t = await tRes.json() as ApiResponse<TaskTemplateDetail>
      const c = await cRes.json() as ApiResponse<TaskCategorySummary[]>
      if (!tRes.ok || !t.data) { setError(t.error ?? 'Template not found.'); return }
      setName(t.data.name)
      setDescription(t.data.description ?? '')
      setRows(t.data.items.map((i) => ({ key: i.id, title: i.title, categoryId: i.categoryId })))
      setCategories(c.data ?? [])
      setDirty(false)
    } catch {
      setError('Network error loading the template.')
    } finally {
      setLoading(false)
    }
  }, [templateId])

  useEffect(() => { void load() }, [load])

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const change = (fn: (prev: Row[]) => Row[]) => { setRows(fn); setDirty(true) }
  const catName = (id: string | null) => (id ? categories.find((c) => c.id === id)?.name ?? 'Archived category' : 'No category')

  /** Groups in the order their first item appears, then groups just added. */
  const groups = useMemo(() => {
    const order: string[] = []
    for (const r of rows) { const k = r.categoryId ?? NONE; if (!order.includes(k)) order.push(k) }
    for (const k of extraGroups) if (!order.includes(k)) order.push(k)
    return order.map((k) => ({ key: k, categoryId: k === NONE ? null : k, rows: rows.filter((r) => (r.categoryId ?? NONE) === k) }))
  }, [rows, extraGroups])

  function move(key: string, delta: -1 | 1) {
    change((prev) => {
      const i = prev.findIndex((r) => r.key === key)
      const me = prev[i]!
      // Swap with the nearest row in the same group in that direction.
      let j = i + delta
      while (j >= 0 && j < prev.length && prev[j]!.categoryId !== me.categoryId) j += delta
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      return next
    })
  }

  function addItems(categoryId: string | null, titles: string[]) {
    change((prev) => {
      // New items go at the end of their group, keeping groups together.
      let at = -1
      prev.forEach((r, i) => { if (r.categoryId === categoryId) at = i })
      const fresh = titles.map((title) => ({ key: newKey(), title, categoryId }))
      if (at < 0) return [...prev, ...fresh]
      return [...prev.slice(0, at + 1), ...fresh, ...prev.slice(at + 1)]
    })
  }

  async function addGroup(nameRaw: string) {
    const n = nameRaw.trim()
    if (!n) return
    const res = await fetch('/api/task-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name: n }),
    })
    const json = await res.json() as ApiResponse<TaskCategorySummary>
    if (!res.ok || !json.data) { setError(json.error ?? 'Could not add the category.'); return }
    const cat = json.data
    setCategories((prev) => (prev.some((c) => c.id === cat.id) ? prev : [...prev, cat]))
    setExtraGroups((prev) => [...prev, cat.id])
    setGroupDraft('')
    setAddingGroup(false)
  }

  async function save() {
    if (!name.trim()) { setError('The template needs a name.'); return }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/task-templates/${templateId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name, description,
          items: rows.filter((r) => r.title.trim()).map((r) => ({ title: r.title, categoryId: r.categoryId })),
        }),
      })
      const json = await res.json() as ApiResponse<TaskTemplateDetail>
      if (!res.ok || !json.data) { setError(json.error ?? 'Could not save.'); return }
      setRows(json.data.items.map((i) => ({ key: i.id, title: i.title, categoryId: i.categoryId })))
      setExtraGroups([])
      setDirty(false)
      setNotice(`Saved, ${json.data.items.length} items.`)
      window.setTimeout(() => setNotice(null), 3000)
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  if (!authLoading && !canManage) {
    return <div className="max-w-3xl mx-auto px-4 py-8"><p className="text-sm text-muted">Only admins can edit task templates.</p></div>
  }

  const input = 'bg-background-primary border border-border-default rounded px-2 py-1 text-sm text-primary focus:outline-none focus:border-accent'

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-5 pb-28">
      <button
        type="button"
        onClick={() => { if (!dirty || window.confirm('Leave without saving your changes?')) router.push('/dashboard/projects/templates') }}
        className="font-mono text-xs tracking-widest text-muted hover:text-primary"
      >
        ← TASK TEMPLATES
      </button>

      {loading ? (
        <div className="space-y-2">{[...Array(4)].map((_, i) => <div key={i} className="h-10 bg-surface-raised rounded animate-pulse" />)}</div>
      ) : (
        <>
          <div className="space-y-2">
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setDirty(true) }}
              maxLength={100}
              aria-label="Template name"
              className="w-full text-2xl font-semibold bg-transparent border-b border-transparent hover:border-border-default focus:border-accent focus:outline-none text-primary"
            />
            <input
              value={description}
              onChange={(e) => { setDescription(e.target.value); setDirty(true) }}
              placeholder="Optional note, e.g. which projects this is for"
              aria-label="Template description"
              className="w-full text-sm bg-transparent border-b border-transparent hover:border-border-default focus:border-accent focus:outline-none text-secondary placeholder:text-muted"
            />
            <p className="text-xs text-muted">{rows.length} items in {groups.length} {groups.length === 1 ? 'category' : 'categories'}</p>
          </div>

          {error && <div className="text-sm text-status-danger bg-status-danger/10 border border-status-danger/30 rounded px-3 py-2">{error}</div>}

          <div className="space-y-4">
            {groups.map((g) => (
              <TemplateGroup
                key={g.key}
                label={catName(g.categoryId)}
                rows={g.rows}
                categories={categories}
                input={input}
                onTitle={(key, title) => change((prev) => prev.map((r) => (r.key === key ? { ...r, title } : r)))}
                onCategory={(key, categoryId) => change((prev) => {
                  // Moved to the end of its new group.
                  const row = prev.find((r) => r.key === key)!
                  const rest = prev.filter((r) => r.key !== key)
                  let at = -1
                  rest.forEach((r, i) => { if (r.categoryId === categoryId) at = i })
                  const moved = { ...row, categoryId }
                  return at < 0 ? [...rest, moved] : [...rest.slice(0, at + 1), moved, ...rest.slice(at + 1)]
                })}
                onMove={move}
                onDelete={(key) => change((prev) => prev.filter((r) => r.key !== key))}
                onAdd={(titles) => addItems(g.categoryId, titles)}
              />
            ))}
          </div>

          {addingGroup ? (
            <div className="flex flex-wrap gap-2 bg-surface-raised border border-border-default rounded-lg px-4 py-3">
              <select
                value=""
                onChange={(e) => { if (e.target.value) { setExtraGroups((prev) => [...prev, e.target.value]); setAddingGroup(false) } }}
                aria-label="Add an existing category"
                className={input}
              >
                <option value="">Existing category...</option>
                {categories.filter((c) => !groups.some((g) => g.categoryId === c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <span className="text-xs text-muted self-center">or new:</span>
              <input
                autoFocus
                value={groupDraft}
                onChange={(e) => setGroupDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void addGroup(groupDraft); if (e.key === 'Escape') setAddingGroup(false) }}
                maxLength={60}
                placeholder="New category name"
                className={`${input} flex-1 min-w-[10rem]`}
              />
              <button type="button" onClick={() => void addGroup(groupDraft)} className="px-3 py-1 text-xs rounded bg-accent text-white hover:bg-accent-hover">Add</button>
              <button type="button" onClick={() => setAddingGroup(false)} className="px-2 py-1 text-xs text-secondary hover:text-primary">Cancel</button>
            </div>
          ) : (
            <button type="button" onClick={() => setAddingGroup(true)} className="px-3 py-1.5 text-xs font-medium rounded bg-surface-raised border border-border-default text-primary hover:border-accent">
              + Category
            </button>
          )}
        </>
      )}

      {/* Save bar */}
      {!loading && (
        <div className="fixed bottom-0 inset-x-0 z-30 bg-background-primary/95 border-t border-border-default">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-3">
            <span className={`text-xs ${dirty ? 'text-status-warning' : 'text-muted'}`}>
              {notice ?? (dirty ? 'Unsaved changes' : 'All changes saved')}
            </span>
            <button type="button" disabled={saving || !dirty} onClick={() => void save()} className="ml-auto px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50">
              {saving ? 'Saving...' : 'Save template'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── TemplateGroup ────────────────────────────────────────────────────────────

interface TemplateGroupProps {
  label: string
  rows: Row[]
  categories: TaskCategorySummary[]
  input: string
  onTitle: (key: string, title: string) => void
  onCategory: (key: string, categoryId: string | null) => void
  onMove: (key: string, delta: -1 | 1) => void
  onDelete: (key: string) => void
  onAdd: (titles: string[]) => void
}

function TemplateGroup({ label, rows, categories, input, onTitle, onCategory, onMove, onDelete, onAdd }: TemplateGroupProps) {
  const [draft, setDraft] = useState('')
  return (
    <section className="border border-border-default rounded-lg overflow-hidden">
      <header className="flex items-center gap-3 px-4 py-2.5 bg-surface-raised/60 border-b border-border-default">
        <span className="text-sm font-semibold tracking-wide text-primary uppercase">{label}</span>
        <span className="text-xs text-muted">{rows.length} items</span>
      </header>
      <ol>
        {rows.map((r, i) => (
          <li key={r.key} className="flex flex-wrap items-center gap-2 px-4 py-1.5 border-b border-border-default">
            <span className="text-xs text-muted w-6 text-right">{i + 1}.</span>
            <input
              value={r.title}
              onChange={(e) => onTitle(r.key, e.target.value)}
              maxLength={200}
              aria-label={`Item ${i + 1}`}
              className={`${input} flex-1 min-w-[14rem] border-transparent hover:border-border-default`}
            />
            <select
              value={r.categoryId ?? NONE}
              onChange={(e) => onCategory(r.key, e.target.value === NONE ? null : e.target.value)}
              aria-label={`Category for item ${i + 1}`}
              className="text-xs bg-transparent border border-transparent hover:border-border-default rounded px-1 py-1 text-secondary focus:outline-none"
            >
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value={NONE}>No category</option>
            </select>
            <button type="button" disabled={i === 0} onClick={() => onMove(r.key, -1)} aria-label="Move up" className="text-xs text-secondary hover:text-primary disabled:opacity-30 px-1">Up</button>
            <button type="button" disabled={i === rows.length - 1} onClick={() => onMove(r.key, 1)} aria-label="Move down" className="text-xs text-secondary hover:text-primary disabled:opacity-30 px-1">Down</button>
            <button type="button" onClick={() => onDelete(r.key)} className="text-xs text-secondary hover:text-status-danger px-1">Remove</button>
          </li>
        ))}
      </ol>
      <div className="px-4 py-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) { e.preventDefault(); onAdd([draft.trim()]); setDraft('') }
          }}
          onPaste={(e) => {
            const lines = pastedLines(e.clipboardData.getData('text'))
            if (lines.length > 1) { e.preventDefault(); onAdd(lines.slice(0, 300)) }
          }}
          maxLength={200}
          placeholder={`+ Add item to ${label} (Enter to add; paste a list to add many)`}
          aria-label={`Add an item to ${label}`}
          className="w-full bg-transparent border border-dashed border-border-default rounded px-3 py-1.5 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-accent focus:border-solid"
        />
      </div>
    </section>
  )
}
