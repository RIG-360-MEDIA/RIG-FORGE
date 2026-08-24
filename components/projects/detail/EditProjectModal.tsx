'use client'

import { useState, useEffect } from 'react'

import ClientPicker from '@/components/projects/ClientPicker'
import type { ProjectDetail, ProjectSummary, ApiResponse, ClientSummary } from '@/lib/types'

/**
 * ProjectDetail carries clientId + clientName (flattened), but ClientPicker
 * wants a ClientSummary. Contact fields and projectCount aren't part of the
 * detail payload and the picker doesn't display them for an already-selected
 * client, so this partial shape is sufficient.
 */
function clientFromProject(project: ProjectDetail): ClientSummary | null {
  if (!project.clientId) return null
  return {
    id: project.clientId,
    name: project.clientName ?? '',
    contactEmail: null,
    contactPhone: null,
    projectCount: 0,
  }
}

interface EditProjectModalProps {
  isOpen: boolean
  onClose: () => void
  project: ProjectDetail
  onSaved: (summary: ProjectSummary) => void
}

const STATUSES = ['ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED'] as const
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const

function toDateInputValue(deadline: Date | null): string {
  if (!deadline) return ''
  try {
    return new Date(deadline as unknown as string).toISOString().split('T')[0] ?? ''
  } catch {
    return ''
  }
}

export default function EditProjectModal({
  isOpen,
  onClose,
  project,
  onSaved,
}: EditProjectModalProps) {
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [status, setStatus] = useState(project.status)
  const [priority, setPriority] = useState(project.priority)
  const [deadline, setDeadline] = useState(() => toDateInputValue(project.deadline))
  const [client, setClient] = useState<ClientSummary | null>(() => clientFromProject(project))
  const [siteLocation, setSiteLocation] = useState(project.siteLocation ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setName(project.name)
    setDescription(project.description ?? '')
    setStatus(project.status)
    setPriority(project.priority)
    setDeadline(toDateInputValue(project.deadline))
    setClient(clientFromProject(project))
    setSiteLocation(project.siteLocation ?? '')
    setError(null)
  }, [isOpen, project])

  useEffect(() => {
    if (!isOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  async function handleSave() {
    if (!name.trim()) {
      setError('Project name is required')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          status,
          priority,
          deadline: deadline ? new Date(deadline).toISOString() : null,
          clientId: client?.id ?? null,
          siteLocation: siteLocation.trim() || null,
        }),
      })
      const json = (await res.json()) as ApiResponse<ProjectSummary>
      if (res.ok && json.data) {
        onSaved(json.data)
        onClose()
      } else {
        setError(json.error ?? 'Failed to save')
      }
    } catch {
      setError('Network error — please try again')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="w-full max-w-[560px] bg-background-secondary border border-border-default"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-default">
            <span className="font-mono text-sm text-primary tracking-widest">EDIT PROJECT </span>
            <button
              type="button"
              onClick={onClose}
              className="font-mono text-muted hover:text-primary transition-colors duration-150"
            >
              ✕
            </button>
          </div>

          <div className="px-6 py-6 flex flex-col gap-5">
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
              />
              <p className="font-mono text-[10px] text-muted text-right mt-1">
                {name.length} / 100
              </p>
            </div>

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
              />
              <p className="font-mono text-[10px] text-muted text-right mt-1">
                {description.length} / 500
              </p>
            </div>

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
                      <option key={s} value={s}>
                        {s.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-muted text-xs">
                    ▾
                  </span>
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
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-muted text-xs">
                    ▾
                  </span>
                </div>
              </div>
            </div>

            <div>
              <label className="block font-mono text-xs text-secondary tracking-widest uppercase mb-2">
                Client
              </label>
              <ClientPicker value={client} onChange={setClient} />
            </div>

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

            <div>
              <label className="block font-mono text-xs text-secondary tracking-widest uppercase mb-2">
                Deadline
              </label>
              <input
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                className="w-full bg-background-primary border border-border-default px-4 py-3 font-mono text-sm text-primary focus:border-accent focus:outline-none transition-colors duration-150 [color-scheme:light]"
              />
              <button
                type="button"
                onClick={() => setDeadline('')}
                className="mt-2 font-mono text-[10px] text-muted tracking-widest hover:text-accent-ink transition-colors duration-150"
              >
                CLEAR DEADLINE
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between px-6 py-4 border-t border-border-default">
            <div>{error && <p className="font-mono text-xs text-status-danger">{error}</p>}</div>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={onClose}
                className="font-mono text-xs text-muted tracking-widest hover:text-primary transition-colors duration-150"
              >
                CANCEL
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={submitting}
                className="bg-accent hover:bg-accent-hover disabled:opacity-60 text-background-primary font-mono text-xs tracking-widest px-6 py-2 transition-colors duration-150"
              >
                {submitting ? 'SAVING...' : 'SAVE CHANGES'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
