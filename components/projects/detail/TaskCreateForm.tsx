'use client'

import { useState, useEffect, useRef } from 'react'

import Avatar from '@/components/ui/Avatar'
import type { ProjectDetail, TaskSummary, ApiResponse } from '@/lib/types'

type Member = ProjectDetail['members'][number]

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const

interface TaskCreateFormProps {
  projectId: string
  columnStatus: string
  members: Member[]
  onCancel: () => void
  onCreated: (task: TaskSummary) => void
  onErrorToast: (message: string) => void
}

export default function TaskCreateForm({
  projectId,
  columnStatus,
  members,
  onCancel,
  onCreated,
  onErrorToast,
}: TaskCreateFormProps) {
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<string>('MEDIUM')
  const [assigneeId, setAssigneeId] = useState<string | null>(null)
  const [estimateHours, setEstimateHours] = useState<string>('')
  const [startDate, setStartDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [footerError, setFooterError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  const todayStr = new Date().toISOString().split('T')[0] ?? ''

  async function handleSubmit() {
    if (submitting) return
    if (!title.trim()) return
    setSubmitting(true)
    setFooterError(null)
    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        projectId,
        status: columnStatus,
        priority,
      }
      if (assigneeId) body.assigneeId = assigneeId
      const est = parseFloat(estimateHours)
      if (estimateHours.trim() !== '' && !isNaN(est) && est > 0) {
        body.estimateHours = est
      }
      if (startDate) body.startDate = new Date(startDate).toISOString()
      if (dueDate) body.dueDate = new Date(dueDate).toISOString()

      // Caught client-side too so the user sees it immediately; the API
      // enforces the same rule regardless (see app/api/tasks/route.ts).
      if (startDate && dueDate && new Date(startDate) > new Date(dueDate)) {
        const msg = 'Start date must be on or before the due date'
        setFooterError(msg)
        setSubmitting(false)
        return
      }

      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as ApiResponse<TaskSummary>
      if (res.ok && json.data) {
        onCreated(json.data)
        onCancel()
      } else {
        const msg = json.error ?? 'Failed to create task'
        setFooterError(msg)
        onErrorToast(msg)
      }
    } catch {
      const msg = 'Network error'
      setFooterError(msg)
      onErrorToast(msg)
    } finally {
      setSubmitting(false)
    }
  }

  const selectedMember = assigneeId ? members.find((m) => m.userId === assigneeId) : null

  return (
    <div className="forge-card p-4 mt-3 border-l-[3px] border-l-accent">
      <div className="flex flex-col gap-3">
        <div>
          <input
            ref={titleRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="Task title..."
            className="w-full bg-background-primary border border-accent font-mono text-sm text-primary px-3 py-2 placeholder:text-muted focus:outline-none focus:border-accent"
          />
        </div>

        <div>
          <p className="font-mono text-[10px] text-muted tracking-widest uppercase mb-1">PRIORITY</p>
          <div className="relative w-fit">
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="appearance-none bg-background-primary border border-border-default py-1 pl-2 pr-7 font-mono text-xs text-primary focus:border-accent focus:outline-none cursor-pointer"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-muted text-[10px]">
              ▾
            </span>
          </div>
        </div>

        <div className="relative">
          <p className="font-mono text-[10px] text-muted tracking-widest uppercase mb-1">
            ASSIGN TO
          </p>
          <button
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            className="w-full flex items-center gap-2 bg-background-primary border border-border-default px-3 py-2 text-left font-mono text-xs text-primary hover:border-accent transition-colors"
          >
            {selectedMember ? (
              <>
                <Avatar
                  name={selectedMember.name}
                  avatarUrl={selectedMember.avatarUrl}
                  size="sm"
                />
                <span>{selectedMember.name}</span>
              </>
            ) : (
              <span className="text-muted">Unassigned</span>
            )}
            <span className="ml-auto text-muted">▾</span>
          </button>
          {pickerOpen && (
            <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-background-secondary border border-border-default max-h-40 overflow-y-auto shadow-lg">
              <button
                type="button"
                onClick={() => {
                  setAssigneeId(null)
                  setPickerOpen(false)
                }}
                className="w-full px-3 py-2 text-left font-mono text-xs text-muted hover:bg-background-tertiary"
              >
                — Unassigned
              </button>
              {members.map((m) => (
                <button
                  key={m.userId}
                  type="button"
                  onClick={() => {
                    setAssigneeId(m.userId)
                    setPickerOpen(false)
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-background-tertiary text-left"
                >
                  <Avatar name={m.name} avatarUrl={m.avatarUrl} size="sm" />
                  <span className="font-mono text-xs text-primary">{m.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <p className="font-mono text-[10px] text-muted tracking-widest uppercase mb-1">
            ESTIMATE (hours)
          </p>
          <input
            type="number"
            min={0}
            step={0.5}
            value={estimateHours}
            onChange={(e) => setEstimateHours(e.target.value)}
            className="w-[100px] bg-background-primary border border-border-default font-mono text-sm text-primary px-3 py-2 focus:border-accent focus:outline-none"
          />
        </div>

        <div>
          <p className="font-mono text-[10px] text-muted tracking-widest uppercase mb-1">
            START DATE
          </p>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="bg-background-primary border border-border-default font-mono text-sm text-primary px-3 py-2 focus:border-accent focus:outline-none [color-scheme:light]"
          />
        </div>

        <div>
          <p className="font-mono text-[10px] text-muted tracking-widest uppercase mb-1">
            DUE DATE
          </p>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            min={startDate || todayStr}
            className="bg-background-primary border border-border-default font-mono text-sm text-primary px-3 py-2 focus:border-accent focus:outline-none [color-scheme:light]"
          />
        </div>
      </div>

      {footerError && (
        <p className="mt-3 font-mono text-[10px] text-status-danger">{footerError}</p>
      )}

      <div className="mt-3 flex justify-between items-center">
        <button
          type="button"
          onClick={onCancel}
          className="font-mono text-xs text-muted tracking-widest hover:text-primary"
        >
          ✕ CANCEL
        </button>
        <button
          type="button"
          disabled={!title.trim() || submitting}
          onClick={() => void handleSubmit()}
          className="bg-accent hover:bg-accent-hover disabled:opacity-50 text-background-primary font-mono text-xs tracking-widest px-4 py-2 transition-colors"
        >
          {submitting ? 'ADDING...' : 'ADD TASK'}
        </button>
      </div>
    </div>
  )
}
