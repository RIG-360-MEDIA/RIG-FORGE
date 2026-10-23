'use client'

import { useState } from 'react'
import type { TaskSummary } from '@/lib/types'

interface DeleteTaskDialogProps {
  task: TaskSummary
  onCancel: () => void
  /** Returns an error message, or null when it worked. */
  onConfirm: () => Promise<string | null>
}

export default function DeleteTaskDialog({ task, onCancel, onConfirm }: DeleteTaskDialogProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setSubmitting(true)
    setError(null)
    const err = await onConfirm()
    if (err) { setError(err); setSubmitting(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface-raised border border-border-default rounded-lg w-full max-w-md mx-4 p-6 space-y-4 text-primary">
        <h2 className="text-lg font-semibold text-primary">Delete task?</h2>
        <p className="text-sm text-secondary">
          This will remove <span className="font-medium text-primary">&ldquo;{task.title}&rdquo;</span> from the project. This action cannot be undone.
        </p>
        {error && (
          <div className="text-sm text-status-danger bg-status-danger/10 border border-status-danger/30 rounded px-3 py-2">{error}</div>
        )}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onCancel} disabled={submitting} className="px-4 py-2 text-sm text-secondary hover:text-primary transition-colors">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={submitting}
            className="px-4 py-2 text-sm bg-status-danger text-white rounded hover:opacity-90 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
