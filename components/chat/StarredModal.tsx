'use client'

import { useEffect, useState } from 'react'
import { Star } from 'lucide-react'

import type { StarredMessage } from '@/lib/chat/types'

export default function StarredModal({
  onClose,
  onOpenChat,
}: {
  onClose: () => void
  onOpenChat: (conversationId: string) => void
}) {
  const [items, setItems] = useState<StarredMessage[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/chat/starred', { credentials: 'include' })
      .then((r) => r.json())
      .then((j: { data?: { messages?: StarredMessage[] } }) => setItems(j.data?.messages ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-[440px] max-h-[80vh] bg-surface-raised rounded-2xl shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-border-default flex items-center justify-between">
          <span className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-text-secondary"><Star className="h-3.5 w-3.5" aria-hidden="true" />Starred messages</span>
          <button type="button" onClick={onClose} className="text-text-secondary hover:text-text-primary">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <p className="p-3 text-xs text-text-secondary">Loading…</p>
          ) : items.length === 0 ? (
            <p className="p-3 text-xs text-text-secondary">No starred messages yet. Right-click a message → Star.</p>
          ) : (
            items.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => { onOpenChat(m.conversationId); onClose() }}
                className="w-full text-left px-3 py-2 rounded-lg hover:bg-text-primary//[0.03]"
              >
                <p className="text-[11px] text-text-secondary">
                  {m.conversationTitle ?? 'Direct chat'} · {m.senderName ?? 'Forgie'}
                </p>
                <p className="text-sm text-text-primary truncate">{m.type === 'IMAGE' ? 'Photo' : m.content}</p>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
