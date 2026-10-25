'use client'

import { useState, useEffect, useRef } from 'react'

import Avatar from '@/components/ui/Avatar'
import ClientPicker from '@/components/projects/ClientPicker'
import type { ProjectDetail, MemberSummary, ProjectLink, ApiResponse, PaginatedResponse, ClientSummary } from '@/lib/types'

interface CreateProjectModalProps {
  isOpen: boolean
  onClose: () => void
  onCreated: (detail: ProjectDetail) => void
}

const STATUSES = ['ACTIVE', 'ON_HOLD'] as const
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
const MAX_LINKS = 5

export default function CreateProjectModal({
  isOpen,
  onClose,
  onCreated,
}: CreateProjectModalProps) {
  // ── Form state ──────────────────────────────────────────────────────────────
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<string>('ACTIVE')
  const [priority, setPriority] = useState<string>('MEDIUM')
  const [deadline, setDeadline] = useState('')
  const [leadId, setLeadId] = useState('')
  const [client, setClient] = useState<ClientSummary | null>(null)
  const [siteLocation, setSiteLocation] = useState('')
  const [links, setLinks] = useState<ProjectLink[]>([])
  // Optional task template: its items fill the new project's Task List.
  const [templates, setTemplates] = useState<{ id: string; name: string; itemCount: number }[]>([])
  const [templateIds, setTemplateIds] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Member picker state ─────────────────────────────────────────────────────
  const [allUsers, setAllUsers] = useState<MemberSummary[]>([])
  const [memberSearch, setMemberSearch] = useState('')
  const [selectedMembers, setSelectedMembers] = useState<MemberSummary[]>([])
  const [showMemberDropdown, setShowMemberDropdown] = useState(false)
  const [usersLoading, setUsersLoading] = useState(false)
  const memberSearchRef = useRef<HTMLInputElement>(null)

  // ── Fetch task templates on open ────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return
    fetch('/api/task-templates', { credentials: 'include' })
      .then((r) => r.json())
      .then((json: ApiResponse<{ id: string; name: string; itemCount: number }[]>) => {
        if (json.data) setTemplates(json.data)
      })
      .catch(() => { /* optional — the project can be created without one */ })
  }, [isOpen])

  // ── Fetch users on open ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return
    setUsersLoading(true)
    fetch('/api/users?limit=100', { credentials: 'include' })
      .then((r) => r.json())
      .then((json: ApiResponse<PaginatedResponse<MemberSummary>>) => {
        if (json.data) setAllUsers(json.data.items)
      })
      .catch(() => { /* silently fail */ })
      .finally(() => setUsersLoading(false))
  }, [isOpen])

  // ── Reset form on close ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) {
      setName('')
      setDescription('')
      setStatus('ACTIVE')
      setPriority('MEDIUM')
      setDeadline('')
      setTemplateIds([])
      setLeadId('')
      setClient(null)
      setSiteLocation('')
      setLinks([])
      setMemberSearch('')
      setSelectedMembers([])
      setShowMemberDropdown(false)
      setError(null)
    }
  }, [isOpen])

  // ── Link helpers ────────────────────────────────────────────────────────────
  function addLink() {
    if (links.length >= MAX_LINKS) return
    setLinks((prev) => [...prev, { label: '', url: '' }])
  }

  function updateLink(index: number, field: keyof ProjectLink, value: string) {
    setLinks((prev) =>
      prev.map((link, i) => (i === index ? { ...link, [field]: value } : link)),
    )
  }

  function removeLink(index: number) {
    setLinks((prev) => prev.filter((_, i) => i !== index))
  }

  // ── Close on Escape ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  // ── Filtered member results ─────────────────────────────────────────────────
  const filteredUsers = allUsers.filter(
    (u) =>
      u.name.toLowerCase().includes(memberSearch.toLowerCase()) &&
      !selectedMembers.some((s) => s.id === u.id),
  )

  function addMember(user: MemberSummary) {
    setSelectedMembers((prev) => [...prev, user])
    setMemberSearch('')
    setShowMemberDropdown(false)
    memberSearchRef.current?.focus()
  }

  function removeMember(id: string) {
    setSelectedMembers((prev) => prev.filter((m) => m.id !== id))
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (submitting) return
    if (!name.trim()) {
      setError('Project name is required')
      return
    }
    if (!leadId) {
      setError('Project lead is required')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const validLinks = links.filter((l) => l.label.trim() && l.url.trim())
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          status,
          priority,
          deadline: deadline ? new Date(deadline).toISOString() : undefined,
          leadId,
          clientId: client?.id,
          siteLocation: siteLocation.trim() || undefined,
          links: validLinks.length > 0 ? validLinks : undefined,
          memberIds: selectedMembers.map((m) => m.id),
        }),
      })
      const json = await res.json() as { data: ProjectDetail | null; error: string | null }
      if ((res.status === 201 || res.ok) && json.data) {
        // Fill the Task List from the chosen templates, one after another in
        // the order picked (a line an earlier template already added, same category, is skipped).
        // The project already exists, so a template that fails is reported
        // but does not undo it; it can be added from the project's Task List.
        let project = json.data
        const failed: string[] = []
        for (const id of templateIds) {
          const applied = await fetch(`/api/projects/${project.id}/apply-template`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ templateId: id }),
          }).catch(() => null)
          const result = applied?.ok ? await applied.json().catch(() => null) as { data?: { added?: unknown[] } } | null : null
          if (!result?.data) {
            failed.push(templates.find((t) => t.id === id)?.name ?? 'a template')
          } else {
            // The project came back before its tasks existed; count them in.
            project = { ...project, totalTasks: project.totalTasks + (result.data.added?.length ?? 0) }
          }
        }
        if (failed.length) {
          window.alert(`The project was created, but these task list templates could not be added: ${failed.join(', ')}. Open the project and use "Add from template" in its Task List.`)
        }
        onCreated(project)
        onClose()
      } else {
        setError(json.error ?? 'Failed to create project')
      }
    } catch {
      setError('Network error — please try again')
    } finally {
      setSubmitting(false)
    }
  }

  if (!isOpen) return null

  const todayStr = new Date().toISOString().split('T')[0] ?? ''

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal panel */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="w-full max-w-[560px] bg-background-secondary border border-border-default flex flex-col max-h-[90vh]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-default shrink-0">
            <span className="font-mono text-sm text-primary tracking-widest">
              CREATE PROJECT 
            </span>
            <button
              onClick={onClose}
              className="font-mono text-muted hover:text-primary transition-colors duration-150"
            >
              ✕
            </button>
          </div>

          {/* Form body */}
          <div className="px-6 py-6 flex flex-col gap-5 overflow-y-auto flex-1">
            {/* Project Name */}
            <div>
              <label className="block font-mono text-xs text-secondary tracking-widest uppercase mb-2">
                Project Name <span className="text-status-danger">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                className="w-full bg-background-primary border border-border-default px-4 py-3 font-mono text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none transition-colors duration-150"
                placeholder="e.g. Auth System Rebuild"
              />
              <p className="font-mono text-[10px] text-muted text-right mt-1">
                {name.length} / 100
              </p>
            </div>

            {/* Description */}
            <div>
              <label className="block font-mono text-xs text-secondary tracking-widest uppercase mb-2">
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
                rows={3}
                className="w-full bg-background-primary border border-border-default px-4 py-3 font-mono text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none transition-colors duration-150 resize-none"
                placeholder="Optional project description..."
              />
              <p className="font-mono text-[10px] text-muted text-right mt-1">
                {description.length} / 500
              </p>
            </div>

            {/* Status + Priority row */}
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="block font-mono text-xs text-secondary tracking-widest uppercase mb-2">
                  Status
                </label>
                <div className="relative">
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                    className="w-full appearance-none bg-background-primary border border-border-default px-4 py-3 pr-8 font-mono text-sm text-primary focus:border-accent focus:outline-none cursor-pointer"
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>{s.replace('_', ' ')}</option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-muted text-xs">▾</span>
                </div>
              </div>
              <div className="flex-1">
                <label className="block font-mono text-xs text-secondary tracking-widest uppercase mb-2">
                  Priority
                </label>
                <div className="relative">
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value)}
                    className="w-full appearance-none bg-background-primary border border-border-default px-4 py-3 pr-8 font-mono text-sm text-primary focus:border-accent focus:outline-none cursor-pointer"
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-muted text-xs">▾</span>
                </div>
              </div>
            </div>

            {/* Deadline */}
            <div>
              <label className="block font-mono text-xs text-secondary tracking-widest uppercase mb-2">
                Deadline
              </label>
              <input
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                min={todayStr}
                className="w-full bg-background-primary border border-border-default px-4 py-3 font-mono text-sm text-primary focus:border-accent focus:outline-none transition-colors duration-150 [color-scheme:light]"
              />
            </div>

            {/* Task template */}
            {templates.length > 0 && (
              <div>
                <p id="create-project-templates" className="block font-mono text-xs text-secondary tracking-widest uppercase mb-2">
                  Task list templates
                </p>
                {/* Any number of templates; ticked ones are added in the order ticked. */}
                <div role="group" aria-labelledby="create-project-templates" className="border border-border-default divide-y divide-border-default">
                  {templates.map((t) => {
                    const on = templateIds.includes(t.id)
                    return (
                      <label key={t.id} className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer font-mono text-sm transition-colors duration-150 ${on ? 'bg-accent/10 text-primary' : 'text-secondary hover:bg-surface-raised'}`}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => setTemplateIds((prev) => (on ? prev.filter((x) => x !== t.id) : [...prev, t.id]))}
                          className="accent-[rgb(var(--c-accent))] h-4 w-4 shrink-0"
                        />
                        <span className="flex-1">{t.name}</span>
                        <span className="text-xs text-muted">{t.itemCount} items</span>
                      </label>
                    )
                  })}
                </div>
                <p className="mt-1 font-mono text-[11px] text-muted">
                  {templateIds.length === 0
                    ? 'None ticked: the project starts with an empty task list.'
                    : `${templateIds.length} ticked, up to ${templates.filter((t) => templateIds.includes(t.id)).reduce((n, t) => n + t.itemCount, 0)} items (a line already added under the same category is skipped).`}
                  {' '}Items are added to the Task List unassigned; more templates or extra items can be added later.
                </p>
              </div>
            )}

            {/* Client */}
            <div>
              <label className="block font-mono text-xs text-secondary tracking-widest uppercase mb-2">
                Client
              </label>
              <ClientPicker value={client} onChange={setClient} />
            </div>

            {/* Site Location */}
            <div>
              <label className="block font-mono text-xs text-secondary tracking-widest uppercase mb-2">
                Site Location
              </label>
              <input
                type="text"
                value={siteLocation}
                onChange={(e) => setSiteLocation(e.target.value)}
                maxLength={200}
                className="w-full bg-background-primary border border-border-default px-4 py-3 font-mono text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none transition-colors duration-150"
                placeholder="e.g. Plot 14, Sector 62, Noida"
              />
            </div>

            {/* Project Lead */}
            <div>
              <label className="block font-mono text-xs text-secondary tracking-widest uppercase mb-2">
                Project Lead <span className="text-status-danger">*</span>
              </label>
              <div className="relative">
                <select
                  value={leadId}
                  onChange={(e) => setLeadId(e.target.value)}
                  disabled={usersLoading}
                  className="w-full appearance-none bg-background-primary border border-border-default px-4 py-3 pr-8 font-mono text-sm text-primary focus:border-accent focus:outline-none cursor-pointer disabled:opacity-50"
                >
                  <option value="">
                    {usersLoading ? 'Loading...' : 'Select a project lead'}
                  </option>
                  {allUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-muted text-xs">
                  ▾
                </span>
              </div>
            </div>

            {/* Project Links */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block font-mono text-xs text-secondary tracking-widest uppercase">
                  Project Links
                </label>
                {links.length < MAX_LINKS && (
                  <button
                    type="button"
                    onClick={addLink}
                    className="font-mono text-[10px] text-accent-ink tracking-widest hover:text-accent-ink transition-colors duration-150"
                  >
                    + ADD LINK
                  </button>
                )}
              </div>
              {links.length === 0 ? (
                <p className="font-mono text-xs text-muted">No links added</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {links.map((link, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <input
                        type="text"
                        value={link.label}
                        onChange={(e) => updateLink(i, 'label', e.target.value)}
                        placeholder="Label"
                        className="w-32 shrink-0 bg-background-primary border border-border-default px-3 py-2 font-mono text-xs text-primary placeholder:text-muted focus:border-accent focus:outline-none transition-colors duration-150"
                      />
                      <input
                        type="text"
                        value={link.url}
                        onChange={(e) => updateLink(i, 'url', e.target.value)}
                        placeholder="https://..."
                        className="flex-1 min-w-0 bg-background-primary border border-border-default px-3 py-2 font-mono text-xs text-primary placeholder:text-muted focus:border-accent focus:outline-none transition-colors duration-150"
                      />
                      <button
                        type="button"
                        onClick={() => removeLink(i)}
                        className="font-mono text-muted hover:text-status-danger transition-colors duration-150 shrink-0 px-1"
                        aria-label="Remove link"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Add Members */}
            <div>
              <label className="block font-mono text-xs text-secondary tracking-widest uppercase mb-2">
                Add Members
              </label>

              {/* Member search input */}
              <div className="relative">
                <input
                  ref={memberSearchRef}
                  type="text"
                  value={memberSearch}
                  onChange={(e) => {
                    setMemberSearch(e.target.value)
                    setShowMemberDropdown(e.target.value.length > 0)
                  }}
                  onFocus={() => {
                    if (memberSearch.length > 0) setShowMemberDropdown(true)
                  }}
                  onBlur={() => setTimeout(() => setShowMemberDropdown(false), 150)}
                  placeholder={usersLoading ? 'Loading members...' : 'SEARCH MEMBERS...'}
                  disabled={usersLoading}
                  className="w-full bg-background-primary border border-border-default px-4 py-3 font-mono text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none transition-colors duration-150 disabled:opacity-50"
                />

                {/* Dropdown */}
                {showMemberDropdown && filteredUsers.length > 0 && (
                  <div className="absolute top-full left-0 right-0 z-10 bg-background-secondary border border-border-default border-t-0 max-h-48 overflow-y-auto">
                    {filteredUsers.slice(0, 10).map((user) => (
                      <button
                        key={user.id}
                        onMouseDown={() => addMember(user)}
                        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-background-tertiary transition-colors duration-150 text-left"
                      >
                        <Avatar name={user.name} avatarUrl={user.avatarUrl} size="sm" />
                        <span className="font-mono text-xs text-primary flex-1 truncate">
                          {user.name}
                        </span>
                        <span className="font-mono text-[10px] text-muted uppercase tracking-widest shrink-0">
                          {user.role}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {showMemberDropdown && memberSearch.length > 0 && filteredUsers.length === 0 && (
                  <div className="absolute top-full left-0 right-0 z-10 bg-background-secondary border border-border-default border-t-0 px-4 py-3">
                    <p className="font-mono text-xs text-muted">No members found</p>
                  </div>
                )}
              </div>

              {/* Selected member chips */}
              {selectedMembers.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {selectedMembers.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center gap-2 px-3 py-1.5 bg-background-tertiary border border-border-default"
                    >
                      <Avatar name={m.name} avatarUrl={m.avatarUrl} size="sm" />
                      <span className="font-mono text-xs text-primary">{m.name}</span>
                      <button
                        onClick={() => removeMember(m.id)}
                        className="font-mono text-[10px] text-muted hover:text-primary ml-1 leading-none"
                        aria-label={`Remove ${m.name}`}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 border-t border-border-default shrink-0">
            <div>
              {error && (
                <p className="font-mono text-xs text-status-danger">{error}</p>
              )}
            </div>
            <div className="flex items-center gap-4">
              <button
                onClick={onClose}
                className="font-mono text-xs text-muted tracking-widest hover:text-primary transition-colors duration-150"
              >
                CANCEL
              </button>
              <button
                onClick={() => void handleSubmit()}
                disabled={submitting}
                className="bg-accent hover:bg-accent-hover disabled:opacity-60 text-background-primary font-mono text-xs tracking-widest px-6 py-2 transition-colors duration-150"
              >
                {submitting ? 'CREATING...' : 'CREATE PROJECT'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
