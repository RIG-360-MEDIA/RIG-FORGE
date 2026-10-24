'use client'

import { useState } from 'react'
import { parseTemplateWorkbook, type ParsedSheet } from '@/lib/task-template-import'
import type { ApiResponse } from '@/lib/types'

interface ImportTemplatesModalProps {
  /** Names already in use, to warn before a second "General" is made. */
  existingNames: string[]
  onClose: () => void
  onImported: (count: number) => void
}

interface Draft extends ParsedSheet {
  include: boolean
  open: boolean
}

/**
 * Excel to task templates: choose the file, check what was read (one
 * template per sheet, one category per section), fix any names, import.
 * The file is read in the browser; only the confirmed lists are sent.
 */
export default function ImportTemplatesModal({ existingNames, onClose, onImported }: ImportTemplatesModalProps) {
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string[]>([])

  async function readFile(file: File) {
    setError(null)
    setFileName(file.name)
    try {
      const sheets = parseTemplateWorkbook(await file.arrayBuffer())
      if (sheets.length === 0) { setError('No task lists were found in that file.'); setDrafts(null); return }
      setDrafts(sheets.map((s) => ({ ...s, include: true, open: false })))
    } catch {
      setError('That file could not be read. Save it as .xlsx and try again.')
      setDrafts(null)
    }
  }

  function update(i: number, change: Partial<Draft>) {
    setDrafts((prev) => prev && prev.map((d, j) => (j === i ? { ...d, ...change } : d)))
  }
  function renameGroup(i: number, g: number, category: string) {
    setDrafts((prev) => prev && prev.map((d, j) => (j !== i ? d : {
      ...d, groups: d.groups.map((grp, k) => (k === g ? { ...grp, category } : grp)),
    })))
  }

  async function importAll() {
    if (!drafts) return
    setBusy(true)
    setError(null)
    const made: string[] = []
    for (const d of drafts) {
      if (!d.include || done.includes(d.sheet)) continue
      try {
        const res = await fetch('/api/task-templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            name: d.name,
            items: d.groups.flatMap((g) => g.items.map((title) => ({ title, categoryName: g.category?.trim() || null }))),
          }),
        })
        const json = await res.json() as ApiResponse<{ id: string }>
        if (!res.ok || json.error) { setError(`"${d.name}": ${json.error ?? 'could not be imported'}`); break }
        made.push(d.sheet)
        setDone((prev) => [...prev, d.sheet])
      } catch {
        setError('Network error. Templates already imported are kept; try again for the rest.')
        break
      }
    }
    setBusy(false)
    if (made.length > 0) onImported(made.length)
  }

  const chosen = drafts?.filter((d) => d.include && !done.includes(d.sheet)) ?? []
  const lower = existingNames.map((n) => n.toLowerCase())

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-surface-raised border border-border-default rounded-lg w-full max-w-2xl mx-4 p-6 space-y-4 text-primary max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-lg font-semibold">Import task templates from Excel</h2>
          <p className="text-xs text-muted mt-1">
            Each sheet becomes a template; each section in it (&quot;A | DESIGN&quot;, &quot;Electrical TASK&quot;) becomes a category.
            A Zoho-style export with a &quot;Task Name&quot; column works too. Check the names, then import.
          </p>
        </div>

        <label className="flex items-center gap-3 text-sm">
          <span className="px-3 py-1.5 text-xs font-medium rounded bg-accent text-white hover:bg-accent-hover cursor-pointer">Choose file</span>
          <span className="text-muted truncate">{fileName || 'No file chosen (.xlsx)'}</span>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f) }}
          />
        </label>

        {error && <div className="text-sm text-status-danger bg-status-danger/10 border border-status-danger/30 rounded px-3 py-2">{error}</div>}

        {drafts && (
          <div className="flex-1 overflow-y-auto space-y-3 -mx-1 px-1">
            {drafts.map((d, i) => {
              const count = d.groups.reduce((n, g) => n + g.items.length, 0)
              const imported = done.includes(d.sheet)
              const clash = lower.includes(d.name.trim().toLowerCase())
              return (
                <div key={d.sheet} className={`border rounded-lg ${d.include && !imported ? 'border-border-default' : 'border-border-default opacity-60'}`}>
                  <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-surface-sunken/40">
                    <input
                      type="checkbox"
                      checked={d.include}
                      disabled={imported}
                      onChange={() => update(i, { include: !d.include })}
                      aria-label={`Import sheet ${d.sheet}`}
                      className="accent-[rgb(var(--c-accent))] h-4 w-4"
                    />
                    <input
                      value={d.name}
                      disabled={imported}
                      onChange={(e) => update(i, { name: e.target.value })}
                      aria-label={`Template name for sheet ${d.sheet}`}
                      className="flex-1 min-w-[10rem] bg-background-primary border border-border-default rounded px-2 py-1 text-sm font-medium focus:outline-none focus:border-accent"
                    />
                    <span className="text-xs text-muted">{count} items, sheet &quot;{d.sheet}&quot;</span>
                    {imported && <span className="text-xs text-status-success font-medium">Imported</span>}
                  </div>
                  {clash && !imported && <p className="px-3 pt-1 text-[11px] text-status-warning">A template with this name already exists; this one will be added next to it.</p>}
                  <div className="px-3 py-2 space-y-1.5">
                    {d.groups.map((g, k) => (
                      <div key={k} className="flex items-center gap-2">
                        <span className="text-[11px] text-muted uppercase tracking-wider w-16 shrink-0">Category</span>
                        <input
                          value={g.category ?? ''}
                          disabled={imported}
                          onChange={(e) => renameGroup(i, k, e.target.value)}
                          placeholder="No category"
                          aria-label={`Category name for ${g.items.length} items`}
                          className="flex-1 bg-background-primary border border-border-default rounded px-2 py-0.5 text-xs focus:outline-none focus:border-accent"
                        />
                        <span className="text-xs text-muted w-16 text-right">{g.items.length} items</span>
                      </div>
                    ))}
                    <button type="button" onClick={() => update(i, { open: !d.open })} className="text-xs text-accent hover:underline">
                      {d.open ? 'Hide items' : 'Show items'}
                    </button>
                    {d.open && (
                      <div className="text-xs text-secondary space-y-2 pt-1">
                        {d.groups.map((g, k) => (
                          <div key={k}>
                            <p className="font-medium text-primary">{g.category || 'No category'}</p>
                            <ol className="list-decimal pl-5 space-y-0.5">
                              {g.items.map((t, n) => <li key={n}>{t}</li>)}
                            </ol>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-secondary hover:text-primary">
            {done.length > 0 ? 'Close' : 'Cancel'}
          </button>
          {drafts && (
            <button
              type="button"
              disabled={busy || chosen.length === 0 || chosen.some((d) => !d.name.trim())}
              onClick={() => void importAll()}
              className="px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? 'Importing...' : `Import ${chosen.length} ${chosen.length === 1 ? 'template' : 'templates'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
