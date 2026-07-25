'use client'

import { useEffect, useState, useCallback } from 'react'

import { useToast } from '@/components/ui/Toast'
import { capabilityGroups } from '@/lib/permissions'
import type { ApiResponse } from '@/lib/types'

interface CustomRole {
  id: string
  name: string
  baseRole: 'ADMIN' | 'EMPLOYEE'
  permissions: string[]
  userCount?: number
}

interface RolesManagerProps {
  open: boolean
  onClose: () => void
  /** Notifies parent when roles change so member panels can refresh their list. */
  onRolesChanged?: () => void
}

const GROUPS = capabilityGroups()

export default function RolesManager({ open, onClose, onRolesChanged }: RolesManagerProps) {
  const { addToast } = useToast()
  const [roles, setRoles] = useState<CustomRole[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // Editor state (create or edit)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [baseRole, setBaseRole] = useState<'ADMIN' | 'EMPLOYEE'>('EMPLOYEE')
  const [perms, setPerms] = useState<Set<string>>(new Set())

  const resetEditor = () => { setEditingId(null); setName(''); setBaseRole('EMPLOYEE'); setPerms(new Set()) }

  const fetchRoles = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/roles', { credentials: 'include' })
      const json = await res.json() as ApiResponse<CustomRole[]>
      if (res.ok && json.data) setRoles(json.data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (open) { void fetchRoles(); resetEditor() } }, [open, fetchRoles])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    if (open) document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const togglePerm = (key: string) => {
    setPerms((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const startEdit = (r: CustomRole) => {
    setEditingId(r.id)
    setName(r.name)
    setBaseRole(r.baseRole)
    setPerms(new Set(r.permissions))
  }

  const handleSave = async () => {
    if (name.trim().length < 2) { addToast('error', 'Role name must be at least 2 characters'); return }
    setSaving(true)
    try {
      const payload = { name: name.trim(), baseRole, permissions: [...perms] }
      const res = await fetch(editingId ? `/api/admin/roles/${editingId}` : '/api/admin/roles', {
        method: editingId ? 'PATCH' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json() as ApiResponse<CustomRole>
      if (!res.ok || json.error) { addToast('error', json.error ?? 'Failed to save role'); return }
      addToast('success', editingId ? 'Role updated' : `Role "${payload.name}" created`)
      resetEditor()
      await fetchRoles()
      onRolesChanged?.()
    } catch {
      addToast('error', 'Network error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (r: CustomRole) => {
    if (!confirm(`Delete role "${r.name}"? ${r.userCount ? `${r.userCount} member(s) will be unassigned.` : ''}`)) return
    try {
      const res = await fetch(`/api/admin/roles/${r.id}`, { method: 'DELETE', credentials: 'include' })
      const json = await res.json() as ApiResponse<{ id: string }>
      if (!res.ok || json.error) { addToast('error', json.error ?? 'Failed to delete'); return }
      addToast('success', `Role "${r.name}" deleted`)
      if (editingId === r.id) resetEditor()
      await fetchRoles()
      onRolesChanged?.()
    } catch {
      addToast('error', 'Network error')
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label="Roles and permissions"
        className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-background-secondary border border-border-default shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-default sticky top-0 bg-background-secondary z-10">
          <p className="font-mono text-sm font-bold text-primary tracking-widest uppercase">Roles &amp; Permissions</p>
          <button type="button" onClick={onClose} className="font-mono text-lg text-muted hover:text-accent-ink" aria-label="Close">✕</button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* Existing roles */}
          <div>
            <p className="font-mono text-[10px] text-muted tracking-widest uppercase mb-3">Custom Roles</p>
            {loading ? (
              <p className="font-mono text-xs text-muted animate-pulse">LOADING...</p>
            ) : roles.length === 0 ? (
              <p className="font-mono text-xs text-muted">No custom roles yet. Create one below.</p>
            ) : (
              <ul className="space-y-2">
                {roles.map((r) => (
                  <li key={r.id} className="forge-card p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-sm text-primary font-bold truncate">
                        {r.name}
                        <span className="ml-2 font-mono text-[9px] tracking-widest border border-border-default px-1 py-0.5 text-muted">
                          base: {r.baseRole}
                        </span>
                      </p>
                      <p className="font-mono text-[10px] text-muted mt-0.5">
                        {r.permissions.length} permission{r.permissions.length === 1 ? '' : 's'}
                        {r.userCount ? ` · ${r.userCount} member${r.userCount === 1 ? '' : 's'}` : ''}
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button type="button" onClick={() => startEdit(r)}
                        className="font-mono text-[10px] tracking-widest text-accent-ink border border-accent/40 px-2 py-1 hover:bg-accent/10">EDIT</button>
                      <button type="button" onClick={() => void handleDelete(r)}
                        className="font-mono text-[10px] tracking-widest text-status-danger border border-status-danger/40 px-2 py-1 hover:bg-status-danger/10">DELETE</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Editor */}
          <div className="border-t border-border-default pt-5 space-y-4">
            <p className="font-mono text-[10px] text-muted tracking-widest uppercase">
              {editingId ? 'Edit Role' : 'Create New Role'}
            </p>

            <div className="flex flex-wrap gap-3">
              <input type="text" placeholder="Role name (e.g. Manager)" value={name} onChange={(e) => setName(e.target.value)}
                className="flex-1 min-w-[200px] border border-border-default bg-background-primary px-3 py-2 font-mono text-xs text-primary placeholder:text-muted focus:outline-none focus:border-accent" />
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-muted tracking-widest">BASE:</span>
                {(['EMPLOYEE', 'ADMIN'] as const).map((b) => (
                  <button key={b} type="button" onClick={() => setBaseRole(b)}
                    className={`font-mono text-[10px] tracking-widest px-2 py-1.5 border transition-colors ${
                      baseRole === b ? 'border-accent text-accent-ink bg-accent/10' : 'border-border-default text-secondary hover:border-accent'
                    }`}>{b}</button>
                ))}
              </div>
            </div>
            <p className="font-mono text-[10px] text-muted leading-relaxed">
              A new role starts with standard employee access and no extra permissions — toggle on
              exactly the capabilities this role should add. Base role sets the fallback access level.
            </p>

            {/* Permission toggles grouped */}
            <div className="space-y-4">
              {GROUPS.map(({ group, items }) => (
                <div key={group}>
                  <p className="font-mono text-[10px] text-accent-ink tracking-widest uppercase mb-2">{group}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {items.map((cap) => {
                      const on = perms.has(cap.key)
                      return (
                        <button key={cap.key} type="button" onClick={() => togglePerm(cap.key)}
                          className={`text-left flex items-start gap-2 p-2 border transition-colors ${
                            on ? 'border-accent bg-accent/5' : 'border-border-default hover:border-accent/40'
                          }`}>
                          <span className={`mt-0.5 w-3.5 h-3.5 shrink-0 border flex items-center justify-center font-mono text-[9px] ${
                            on ? 'border-accent bg-accent text-background-primary' : 'border-border-default text-transparent'
                          }`}>✓</span>
                          <span className="min-w-0">
                            <span className="block font-mono text-xs text-primary">{cap.label}</span>
                            {cap.hint && <span className="block font-mono text-[9px] text-muted leading-tight">{cap.hint}</span>}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex gap-2 pt-2">
              {editingId && (
                <button type="button" onClick={resetEditor}
                  className="font-mono text-xs tracking-widest px-4 py-2 border border-border-default text-secondary hover:text-primary">CANCEL</button>
              )}
              <button type="button" onClick={() => void handleSave()} disabled={saving}
                className="flex-1 font-mono text-xs tracking-widest py-2 border border-accent text-accent-ink hover:bg-accent hover:text-background-primary transition-colors disabled:opacity-40">
                {saving ? 'SAVING...' : editingId ? 'SAVE CHANGES' : 'CREATE ROLE'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
