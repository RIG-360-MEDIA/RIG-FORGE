'use client'

import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Ban, BarChart3, Bot, CheckSquare, Copy, FileText, Forward, Image as ImageIcon, Info, Mic, Palette, Paperclip, Pencil, Pin, PinOff, Reply, Search, Square, Star, StarOff, Trash2 } from 'lucide-react'
import type { RealtimeChannel } from '@supabase/supabase-js'

import Avatar from '@/components/ui/Avatar'
import { getSupabaseClient } from '@/lib/supabase/client'
import type { ConversationSummary, ChatMessageDTO, ChatUserLite } from '@/lib/chat/types'
import MessageInfoModal from './MessageInfoModal'
import GroupInfoPanel from './GroupInfoPanel'

function timeLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function sameDay(a: string, b: string): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate()
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayOf = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const dayMs = 86_400_000
  if (dayOf === startToday) return 'Today'
  if (dayOf === startToday - dayMs) return 'Yesterday'
  if (dayOf > startToday - 7 * dayMs) return d.toLocaleDateString([], { weekday: 'long' })
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })
}

// WhatsApp-style inline formatting: *bold* _italic_ ~strike~ `mono` (non-nested).
function formatText(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const regex = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|`[^`\n]+`|@[A-Za-z][A-Za-z0-9_]*)/g
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const tok = m[0]
    const inner = tok.slice(1, -1)
    if (tok[0] === '*') nodes.push(<strong key={key++}>{inner}</strong>)
    else if (tok[0] === '_') nodes.push(<em key={key++}>{inner}</em>)
    else if (tok[0] === '~') nodes.push(<s key={key++}>{inner}</s>)
    else if (tok[0] === '@') nodes.push(<span key={key++} className="text-accent-ink font-medium">{tok}</span>)
    else nodes.push(<code key={key++} className="font-mono text-[0.92em] bg-text-primary/10 rounded px-1">{inner}</code>)
    last = m.index + tok.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function groupReactions(reactions: { emoji: string; userId: string }[], meId: string) {
  const map = new Map<string, { emoji: string; count: number; mine: boolean }>()
  for (const r of reactions) {
    const g = map.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false }
    g.count++
    if (r.userId === meId) g.mine = true
    map.set(r.emoji, g)
  }
  return Array.from(map.values())
}

const REACTION_CHOICES = ['👍', '❤️', '😂', '😮', '😢', '🙏']

function TypingDots() {
  return (
    <span className="inline-flex gap-0.5 items-end">
      {[0, 150, 300].map((d) => (
        <span key={d} className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: `${d}ms` }} />
      ))}
    </span>
  )
}

// Voice-note / audio player with a 1x → 1.5x → 2x playback-speed toggle.
function AudioPlayer({ src }: { src: string }) {
  const ref = useRef<HTMLAudioElement>(null)
  const [speed, setSpeed] = useState(1)
  function cycleSpeed() {
    const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1
    setSpeed(next)
    if (ref.current) ref.current.playbackRate = next
  }
  return (
    <div className="flex items-center gap-2">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={ref} controls src={src} className="max-w-[200px] h-8" />
      <button type="button" onClick={cycleSpeed} title="Playback speed" className="text-[10px] rounded-full border border-border-default px-1.5 py-0.5 shrink-0">
        {speed}x
      </button>
    </div>
  )
}

const SKELETON = [
  ['justify-start', '42%'],
  ['justify-end', '55%'],
  ['justify-start', '60%'],
  ['justify-end', '34%'],
  ['justify-start', '48%'],
] as const

type CtxMenu = { msg: ChatMessageDTO; x: number; y: number } | null

// A poll message: question + options with live vote bars; tap an option to vote.
function PollCard({ msg, meId, onVote }: { msg: ChatMessageDTO; meId: string; onVote: (messageId: string, optionId: string) => void }) {
  const poll = msg.poll
  if (!poll) return null
  const totals = poll.options.map((o) => poll.votes?.[o.id]?.length ?? 0)
  const totalVotes = totals.reduce((a, b) => a + b, 0)
  return (
    <div className="min-w-[220px] max-w-[300px]">
      <p className="font-medium text-sm mb-2 flex items-center gap-1.5"><BarChart3 className="h-4 w-4 shrink-0" aria-hidden="true" />{msg.content}</p>
      <div className="space-y-1.5">
        {poll.options.map((o, i) => {
          const count = totals[i]
          const pct = totalVotes ? Math.round((count / totalVotes) * 100) : 0
          const mine = (poll.votes?.[o.id] ?? []).includes(meId)
          return (
            <button key={o.id} type="button" onClick={() => onVote(msg.id, o.id)} className="block w-full text-left">
              <div className="relative rounded-lg border border-border-default overflow-hidden">
                <div className="absolute inset-y-0 left-0 bg-[#3F7A0A]/15" style={{ width: `${pct}%` }} />
                <div className="relative flex items-center justify-between gap-2 px-2.5 py-1.5 text-sm">
                  <span className="flex items-center gap-1.5">{mine ? <CheckSquare className="h-4 w-4 shrink-0" aria-label="Voted" /> : <Square className="h-4 w-4 shrink-0" aria-hidden="true" />}{o.text}</span>
                  <span className="text-[11px] text-text-secondary shrink-0">{count} · {pct}%</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
      <p className="text-[11px] text-text-secondary mt-1.5">
        {totalVotes} vote{totalVotes === 1 ? '' : 's'}{poll.multi ? ' · multiple choice' : ''}
      </p>
    </div>
  )
}

// Modal to compose a poll: a question + 2–12 options + single/multi toggle.
function PollComposer({ onClose, onCreate }: { onClose: () => void; onCreate: (q: string, opts: string[], multi: boolean) => void }) {
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState<string[]>(['', ''])
  const [multi, setMulti] = useState(false)
  const valid = question.trim() && options.filter((o) => o.trim()).length >= 2
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-[400px] bg-surface-raised rounded-2xl shadow-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-border-default flex items-center justify-between">
          <span className="font-mono text-xs uppercase tracking-widest text-text-secondary">New poll</span>
          <button type="button" onClick={onClose} className="text-text-secondary hover:text-text-primary">✕</button>
        </div>
        <div className="p-4 space-y-3">
          <input
            autoFocus
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask a question…"
            className="w-full h-10 px-3 rounded-lg border border-border-default bg-surface-raised text-sm outline-none focus:border-accent-ink"
          />
          <div className="space-y-2">
            {options.map((opt, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={opt}
                  onChange={(e) => setOptions((os) => os.map((o, j) => (j === i ? e.target.value : o)))}
                  placeholder={`Option ${i + 1}`}
                  className="flex-1 h-9 px-3 rounded-lg border border-border-default bg-surface-raised text-sm outline-none focus:border-accent-ink"
                />
                {options.length > 2 && (
                  <button type="button" onClick={() => setOptions((os) => os.filter((_, j) => j !== i))} className="text-text-secondary hover:text-status-danger">✕</button>
                )}
              </div>
            ))}
            {options.length < 12 && (
              <button type="button" onClick={() => setOptions((os) => [...os, ''])} className="text-accent-ink text-xs font-mono hover:underline">＋ Add option</button>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
            <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} className="accent-[#3F7A0A]" />
            Allow multiple answers
          </label>
        </div>
        <div className="p-4 border-t border-border-default flex justify-end">
          <button
            type="button"
            disabled={!valid}
            onClick={() => { onCreate(question.trim(), options.map((o) => o.trim()).filter(Boolean), multi); onClose() }}
            className="h-9 px-4 rounded-full bg-[#3F7A0A] text-white font-mono text-xs hover:bg-[#356a08] disabled:opacity-40"
          >
            Create poll
          </button>
        </div>
      </div>
    </div>
  )
}

// Per-conversation unsent draft, persisted locally (survives tab switches/reloads).
function draftKey(id: string) {
  return `rf-chat-draft-${id}`
}
function loadDraft(id: string): string {
  try { return localStorage.getItem(draftKey(id)) || '' } catch { return '' }
}
function saveDraft(id: string, text: string) {
  try {
    if (text.trim()) localStorage.setItem(draftKey(id), text)
    else localStorage.removeItem(draftKey(id))
  } catch { /* ignore */ }
}

// Per-user chat wallpaper presets (key → background colour). 'default' = no override.
const WALLPAPERS: Record<string, string> = {
  default: '#F4F4EE',
  sage: '#E7EDE3',
  sky: '#E2EBF1',
  sand: '#F1E9DC',
  rose: '#F3E6E8',
  graphite: '#E6E7E9',
}

export default function MessageThread({
  conversation,
  messages,
  meId,
  loading,
  onSend,
  onSendImage,
  onEdit,
  onDelete,
  onReact,
  onForward,
  onStar,
  onPin,
  users,
  onlineIds,
  onChanged,
  onLeft,
  onBack,
  onSetWallpaper,
  onCreatePoll,
  onVote,
}: {
  conversation: ConversationSummary | null
  messages: ChatMessageDTO[]
  meId: string
  loading: boolean
  onSend: (text: string, replyToId?: string | null) => void
  onSendImage: (file: File) => void
  onEdit: (messageId: string, text: string) => void
  onDelete: (messageId: string) => void
  onReact: (messageId: string, emoji: string) => void
  onForward: (msg: ChatMessageDTO) => void
  onStar: (messageId: string) => void
  onPin: (messageId: string, pin: boolean) => void
  users: ChatUserLite[]
  onlineIds: Set<string>
  onChanged: () => void
  onLeft: () => void
  onBack: () => void
  onSetWallpaper: (conversationId: string, wallpaper: string | null) => void
  onCreatePoll: (question: string, options: string[], multi: boolean) => void
  onVote: (messageId: string, optionId: string) => void
}) {
  const [draft, setDraft] = useState('')
  const [infoMsg, setInfoMsg] = useState<ChatMessageDTO | null>(null)
  const [groupInfoOpen, setGroupInfoOpen] = useState(false)
  const [wallpaperOpen, setWallpaperOpen] = useState(false)
  const [pollOpen, setPollOpen] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [typingName, setTypingName] = useState<string | null>(null)
  const [replyingTo, setReplyingTo] = useState<ChatMessageDTO | null>(null)
  const [editing, setEditing] = useState<ChatMessageDTO | null>(null)
  const [ctxMenu, setCtxMenu] = useState<CtxMenu>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ChatMessageDTO[]>([])
  const [recording, setRecording] = useState(false)
  const [recordSecs, setRecordSecs] = useState(0)

  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const docRef = useRef<HTMLInputElement>(null)
  const mediaRecRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const recordCancelledRef = useRef(false)
  const typingChannelRef = useRef<RealtimeChannel | null>(null)
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastTypingSentRef = useRef(0)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const convoId = conversation?.id

  useEffect(() => {
    bottomRef.current?.scrollIntoView()
    setAtBottom(true)
  }, [convoId])

  // Restore this conversation's saved draft when it opens.
  useEffect(() => {
    setDraft(convoId ? loadDraft(convoId) : '')
  }, [convoId])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 140
    if (near) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  // Typing indicator over a per-conversation Supabase Broadcast channel.
  useEffect(() => {
    const supabase = getSupabaseClient()
    if (!supabase || !convoId) return
    const ch = supabase.channel(`typing:${convoId}`, { config: { broadcast: { self: false } } })
    ch.on('broadcast', { event: 'typing' }, (p) => {
      const { userId, name } = (p.payload ?? {}) as { userId?: string; name?: string }
      if (!userId || userId === meId) return
      setTypingName(name || 'Someone')
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
      typingTimeoutRef.current = setTimeout(() => setTypingName(null), 3500)
    })
    ch.subscribe()
    typingChannelRef.current = ch
    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
      setTypingName(null)
      void supabase.removeChannel(ch)
      typingChannelRef.current = null
    }
  }, [convoId, meId])

  // In-chat full-text search (server-side, debounced).
  useEffect(() => {
    if (!searchOpen || !convoId) { setSearchResults([]); return }
    const q = searchQuery.trim()
    if (!q) { setSearchResults([]); return }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      void fetch(`/api/chat/conversations/${convoId}/search?q=${encodeURIComponent(q)}`, { credentials: 'include' })
        .then((r) => r.json())
        .then((json: { data?: { messages?: ChatMessageDTO[] } }) => setSearchResults(json.data?.messages ?? []))
        .catch(() => setSearchResults([]))
    }, 300)
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [searchQuery, searchOpen, convoId])

  function broadcastTyping() {
    const now = Date.now()
    if (now - lastTypingSentRef.current < 1500) return
    lastTypingSentRef.current = now
    const myName = conversation?.members.find((u) => u.id === meId)?.name ?? 'Someone'
    void typingChannelRef.current?.send({
      type: 'broadcast',
      event: 'typing',
      payload: { userId: meId, name: myName },
    })
  }

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }

  function autoGrow() {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
  }

  function startEdit(msg: ChatMessageDTO) {
    setEditing(msg)
    setReplyingTo(null)
    setDraft(msg.content)
    setTimeout(() => taRef.current?.focus(), 0)
  }

  function send() {
    const text = draft.trim()
    if (!text) return
    if (editing) {
      onEdit(editing.id, text)
      setEditing(null)
    } else {
      onSend(text, replyingTo?.id ?? null)
      setReplyingTo(null)
    }
    setDraft('')
    if (convoId) saveDraft(convoId, '')
    if (taRef.current) taRef.current.style.height = 'auto'
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    send()
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      chunksRef.current = []
      recordCancelledRef.current = false
      mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data) }
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        if (recordCancelledRef.current) return
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        onSendImage(new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' }))
      }
      mr.start()
      mediaRecRef.current = mr
      setRecording(true)
      setRecordSecs(0)
      recTimerRef.current = setInterval(() => setRecordSecs((s) => s + 1), 1000)
    } catch {
      alert('Microphone access is required to record a voice note.')
    }
  }

  function stopRecording() {
    mediaRecRef.current?.stop()
    setRecording(false)
    if (recTimerRef.current) clearInterval(recTimerRef.current)
  }

  function cancelRecording() {
    recordCancelledRef.current = true
    mediaRecRef.current?.stop()
    setRecording(false)
    if (recTimerRef.current) clearInterval(recTimerRef.current)
  }

  if (!conversation) {
    return (
      <section className="hidden md:flex flex-1 min-w-0 items-center justify-center bg-surface-mid">
        <p className="font-mono text-sm text-text-muted">Select a conversation to start chatting</p>
      </section>
    )
  }

  function nameFor(senderId: string | null): string {
    if (!senderId) return 'Forgie'
    const m = conversation?.members.find((u) => u.id === senderId)
    return m?.name ?? 'Someone'
  }

  function scrollToMessage(id: string) {
    const el = document.getElementById(`m-${id}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('ring-2', 'ring-[#3F7A0A]')
    setTimeout(() => el.classList.remove('ring-2', 'ring-[#3F7A0A]'), 1500)
  }

  // 3-state receipt for MY messages: ✓ sent · ✓✓ grey delivered · ✓✓ blue read.
  function receiptFor(msg: ChatMessageDTO) {
    if (!conversation || msg.senderId !== meId) return null
    const others = conversation.members.filter((u) => u.id !== meId)
    if (others.length === 0) return null
    const t = new Date(msg.createdAt).getTime()
    const seenBy = others.filter((u) => u.lastReadAt && new Date(u.lastReadAt).getTime() >= t)
    if (seenBy.length > 0) {
      const label = conversation.type === 'GROUP' ? `✓✓ ${seenBy.length}` : '✓✓'
      return <span title={`Read by ${seenBy.map((u) => u.name).join(', ')}`} className="text-sky-300">{label}</span>
    }
    if (msg.deliveredAt) return <span title="Delivered" className="text-white/60">✓✓</span>
    return <span title="Sent" className="text-white/50">✓</span>
  }

  const others = conversation.members.filter((u) => u.id !== meId)
  const dmOther = conversation.type === 'DIRECT' ? others[0] : null
  const dmOnline = dmOther ? onlineIds.has(dmOther.id) : false
  const groupOnline = conversation.type === 'GROUP' ? others.filter((u) => onlineIds.has(u.id)).length : 0
  const pinnedMessages = messages.filter((m) => m.pinnedAt && !m.deletedAt)

  return (
    <section className="relative flex-1 min-w-0 flex flex-col" style={{ backgroundColor: WALLPAPERS[conversation.wallpaper ?? 'default'] ?? WALLPAPERS.default }}>
      {/* Header */}
      <div
        className={`h-14 shrink-0 px-3 sm:px-4 flex items-center gap-2 sm:gap-3 border-b border-border-default bg-surface-raised/60 ${conversation.type === 'GROUP' ? 'cursor-pointer hover:bg-surface-raised' : ''}`}
        onClick={conversation.type === 'GROUP' ? () => setGroupInfoOpen(true) : undefined}
        title={conversation.type === 'GROUP' ? 'Group info' : undefined}
      >
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onBack() }}
          className="md:hidden text-text-secondary hover:text-text-primary text-lg leading-none"
          title="Back"
        >
          ‹
        </button>
        {conversation.isForgie ? (
          <div className="h-9 w-9 shrink-0 rounded-full bg-bubble-mine text-bubble-mine-ink flex items-center justify-center" aria-label="Forgie"><Bot className="h-5 w-5" aria-hidden="true" /></div>
        ) : (
          <Avatar name={conversation.title ?? '?'} avatarUrl={conversation.avatarUrl} size="sm" />
        )}
        <div className="min-w-0">
          <p className="font-medium text-sm text-text-primary truncate">
            {conversation.type === 'GROUP' ? '# ' : ''}{conversation.title}
          </p>
          {typingName ? (
            <span className="text-[11px] text-accent-ink flex items-center gap-1">
              {conversation.type === 'GROUP' ? `${typingName} is ` : ''}typing <TypingDots />
            </span>
          ) : conversation.type === 'GROUP' ? (
            <p className="text-[11px] text-text-muted truncate">
              {conversation.members.length} members{groupOnline > 0 ? ` · ${groupOnline} online` : ''}
            </p>
          ) : dmOnline ? (
            <p className="text-[11px] text-accent-ink">online</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setSearchOpen((o) => !o); setSearchQuery('') }}
          className="ml-auto text-text-secondary hover:text-text-primary"
          title="Search in chat"
          aria-label="Search in chat"
        >
          <Search className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setWallpaperOpen((o) => !o) }}
          className="text-text-secondary hover:text-text-primary"
          title="Wallpaper"
          aria-label="Wallpaper"
        >
          <Palette className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {wallpaperOpen && (
        <div className="absolute right-3 top-14 z-20 bg-surface-raised border border-border-default rounded-lg shadow-lg p-2 flex gap-2">
          {Object.entries(WALLPAPERS).map(([key, color]) => (
            <button
              key={key}
              type="button"
              onClick={() => { onSetWallpaper(conversation.id, key === 'default' ? null : key); setWallpaperOpen(false) }}
              className={`h-7 w-7 rounded-full border ${(conversation.wallpaper ?? 'default') === key ? 'border-accent-ink ring-2 ring-[#3F7A0A]/30' : 'border-border-default'}`}
              style={{ backgroundColor: color }}
              title={key}
            />
          ))}
        </div>
      )}

      {searchOpen && (
        <div className="shrink-0 border-b border-border-default bg-surface-raised p-2">
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search in this chat…"
            className="w-full h-9 px-3 rounded-lg border border-border-default bg-surface-raised text-sm outline-none focus:border-accent-ink"
          />
          {searchResults.length > 0 && (
            <div className="mt-2 max-h-60 overflow-y-auto">
              {searchResults.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => { scrollToMessage(r.id); setSearchOpen(false) }}
                  className="w-full text-left px-2 py-1.5 rounded hover:bg-text-primary//[0.04]"
                >
                  <p className="text-[11px] text-text-secondary">{r.senderId === meId ? 'You' : nameFor(r.senderId)} · {timeLabel(r.createdAt)}</p>
                  <p className="text-sm text-text-primary truncate">{r.content}</p>
                </button>
              ))}
            </div>
          )}
          {searchQuery.trim() && searchResults.length === 0 && (
            <p className="mt-2 text-xs text-text-secondary px-2">No matches</p>
          )}
        </div>
      )}

      {pinnedMessages.length > 0 && (
        <button
          type="button"
          onClick={() => scrollToMessage(pinnedMessages[pinnedMessages.length - 1].id)}
          className="shrink-0 w-full text-left px-3 py-2 border-b border-border-default bg-[#3F7A0A]/5 flex items-center gap-2"
        >
          <Pin className="h-3.5 w-3.5 shrink-0 text-accent-ink" aria-hidden="true" />
          <span className="text-xs text-text-secondary truncate flex-1">
            {pinnedMessages[pinnedMessages.length - 1].type === 'IMAGE' ? 'Photo' : pinnedMessages[pinnedMessages.length - 1].content}
          </span>
          {pinnedMessages.length > 1 && <span className="text-[10px] text-text-secondary shrink-0">{pinnedMessages.length} pinned</span>}
        </button>
      )}

      {/* Messages */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-3 sm:px-4 py-3 space-y-2">
        {loading ? (
          <div className="space-y-3 animate-pulse pt-2">
            {SKELETON.map(([side, w], i) => (
              <div key={i} className={`flex ${side}`}>
                <div className="h-9 rounded-2xl bg-text-primary//[0.07]" style={{ width: w }} />
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          <p className="font-mono text-xs text-text-muted">No messages yet — say hello.</p>
        ) : (
          messages.map((m, i) => {
            const prev = messages[i - 1]
            const dateSep = !prev || !sameDay(prev.createdAt, m.createdAt) ? (
              <div className="flex justify-center my-2">
                <span className="text-[10px] font-mono uppercase tracking-wide text-text-secondary bg-text-primary//[0.05] rounded-full px-3 py-1">
                  {dayLabel(m.createdAt)}
                </span>
              </div>
            ) : null

            if (m.kind === 'SYSTEM') {
              return (
                <Fragment key={m.id}>
                  {dateSep}
                  <div className="flex justify-center my-1">
                    <span className="text-[11px] text-text-secondary bg-text-primary//[0.05] rounded-full px-3 py-1 text-center">
                      {m.content}
                    </span>
                  </div>
                </Fragment>
              )
            }

            const mine = m.senderId === meId
            const isForgie = m.kind === 'FORGIE'
            const quoted = m.replyToId ? messages.find((x) => x.id === m.replyToId) : null
            const grouped = groupReactions(m.reactions ?? [], meId)
            return (
              <Fragment key={m.id}>
                {dateSep}
                <div id={`m-${m.id}`} className={`flex flex-col rounded-lg transition-shadow ${mine ? 'items-end' : 'items-start'}`}>
                  <div
                    onContextMenu={m.deletedAt ? undefined : (e) => {
                      e.preventDefault()
                      const MW = 180
                      const MH = 360
                      const x = e.clientX + MW > window.innerWidth ? Math.max(8, window.innerWidth - MW - 8) : e.clientX
                      const y = e.clientY + MH > window.innerHeight ? Math.max(8, window.innerHeight - MH - 8) : e.clientY
                      setCtxMenu({ msg: m, x, y })
                    }}
                    onDoubleClick={m.deletedAt ? undefined : () => setReplyingTo(m)}
                    className={`max-w-[78%] sm:max-w-[70%] rounded-2xl px-3 py-2 ${m.deletedAt ? '' : 'cursor-context-menu'} ${
                      mine
                        ? 'bg-[#3F7A0A] text-white rounded-br-sm'
                        : isForgie
                          ? 'bg-bubble-mine text-bubble-mine-ink rounded-bl-sm'
                          : 'bg-surface-raised text-text-primary rounded-bl-sm border border-border-subtle'
                    }`}
                  >
                    {!mine && (isForgie || conversation.type === 'GROUP') && (
                      <p className="text-[10px] font-mono uppercase tracking-wide opacity-70 mb-0.5">
                        {isForgie ? <span className="inline-flex items-center gap-1"><Bot className="h-3 w-3" aria-hidden="true" />Forgie</span> : nameFor(m.senderId)}
                      </p>
                    )}
                    {m.deletedAt ? (
                      <p className="text-sm italic opacity-70"><Ban className="inline h-3.5 w-3.5 mr-1 -mt-0.5 align-middle" aria-hidden="true" />This message was deleted</p>
                    ) : (
                      <>
                        {m.replyToId && (
                          <div className={`mb-1 rounded px-2 py-1 border-l-2 text-xs ${mine ? 'border-white/60 bg-text-primary/10 text-white/80' : 'border-accent-ink bg-text-primary//[0.05] text-text-secondary'}`}>
                            <span className="block font-medium">
                              {quoted ? (quoted.senderId === meId ? 'You' : nameFor(quoted.senderId)) : 'Message'}
                            </span>
                            <span className="block truncate">
                              {quoted ? (quoted.deletedAt ? 'This message was deleted' : quoted.type === 'IMAGE' ? 'Photo' : quoted.content) : '…'}
                            </span>
                          </div>
                        )}
                        {m.type === 'IMAGE' ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={m.content} alt="" loading="lazy" decoding="async" className="rounded-lg max-w-full max-h-72 object-cover" />
                        ) : m.type === 'FILE' ? (
                          <a href={m.content} target="_blank" rel="noopener noreferrer" className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${mine ? 'bg-text-primary/[0.15]' : 'bg-text-primary//[0.04]'}`}>
                            <FileText className="h-5 w-5 shrink-0" aria-hidden="true" />
                            <span className="min-w-0">
                              <span className="block text-sm truncate underline">{m.fileName ?? 'Download file'}</span>
                              {m.fileSize ? <span className="block text-[10px] opacity-70">{formatBytes(m.fileSize)}</span> : null}
                            </span>
                          </a>
                        ) : m.type === 'AUDIO' ? (
                          <AudioPlayer src={m.content} />
                        ) : m.type === 'POLL' ? (
                          <PollCard msg={m} meId={meId} onVote={onVote} />
                        ) : (
                          <>
                            <p className="text-sm whitespace-pre-wrap break-words">{formatText(m.content)}</p>
                            {m.linkPreview && (
                              <a
                                href={m.linkPreview.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-1 block rounded-lg overflow-hidden border border-border-default bg-surface-raised text-text-primary max-w-[280px]"
                              >
                                {m.linkPreview.image && (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={m.linkPreview.image} alt="" className="w-full h-32 object-cover" />
                                )}
                                <div className="p-2">
                                  {m.linkPreview.title && <p className="text-xs font-medium truncate">{m.linkPreview.title}</p>}
                                  {m.linkPreview.description && <p className="text-[11px] text-text-secondary line-clamp-2">{m.linkPreview.description}</p>}
                                  <p className="text-[10px] text-text-secondary truncate mt-0.5">{m.linkPreview.url}</p>
                                </div>
                              </a>
                            )}
                          </>
                        )}
                      </>
                    )}
                    <div className={`text-[10px] mt-0.5 flex items-center justify-end gap-1 ${mine ? 'text-white/70' : 'text-text-muted'}`}>
                      {m.starred && <span title="Starred" aria-label="Starred"><Star className="h-3 w-3 fill-current" aria-hidden="true" /></span>}
                      {m.editedAt && !m.deletedAt && <span className="opacity-60">edited</span>}
                      <span>{timeLabel(m.createdAt)}</span>
                      {mine && !m.deletedAt && receiptFor(m)}
                    </div>
                  </div>
                  {grouped.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-0.5 px-1 max-w-[78%]">
                      {grouped.map((g) => (
                        <button
                          key={g.emoji}
                          type="button"
                          onClick={() => onReact(m.id, g.emoji)}
                          className={`text-[11px] leading-none rounded-full px-1.5 py-1 border ${g.mine ? 'bg-[#3F7A0A]/15 border-[#3F7A0A]/40' : 'bg-surface-raised border-border-default'}`}
                        >
                          {g.emoji}{g.count > 1 ? ` ${g.count}` : ''}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </Fragment>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Jump to latest */}
      {!atBottom && (
        <button
          type="button"
          onClick={() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); setAtBottom(true) }}
          title="Jump to latest"
          className="absolute right-4 bottom-24 z-10 h-9 w-9 rounded-full bg-surface-raised border border-border-default shadow-md flex items-center justify-center text-text-secondary hover:text-text-primary"
        >
          ↓
        </button>
      )}

      {/* Composer (with reply preview) */}
      <div className="shrink-0 border-t border-border-default bg-surface-raised/60">
        {editing && (
          <div className="px-3 pt-2 flex items-center gap-2">
            <span className="text-[11px] text-accent-ink font-medium shrink-0">Editing</span>
            <span className="flex-1 text-xs text-text-secondary truncate">{editing.content}</span>
            <button type="button" onClick={() => { setEditing(null); setDraft('') }} className="text-text-secondary hover:text-text-primary">✕</button>
          </div>
        )}
        {replyingTo && (
          <div className="px-3 pt-2 flex items-start gap-2">
            <div className="flex-1 min-w-0 border-l-2 border-accent-ink bg-text-primary//[0.04] rounded px-2 py-1">
              <p className="text-[11px] text-accent-ink font-medium">
                {replyingTo.senderId === meId ? 'You' : nameFor(replyingTo.senderId)}
              </p>
              <p className="text-xs text-text-secondary truncate">
                {replyingTo.type === 'IMAGE' ? 'Photo' : replyingTo.content}
              </p>
            </div>
            <button type="button" onClick={() => setReplyingTo(null)} className="text-text-secondary hover:text-text-primary">✕</button>
          </div>
        )}
        <form onSubmit={handleSubmit} className="p-3 flex flex-wrap items-end gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            title="Send image"
            aria-label="Send image"
            className="h-10 w-10 shrink-0 rounded-full border border-border-default flex items-center justify-center text-text-secondary hover:text-text-primary"
          >
            <ImageIcon className="h-5 w-5" aria-hidden="true" />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onSendImage(f); e.target.value = '' }}
          />
          <button
            type="button"
            onClick={() => docRef.current?.click()}
            title="Send a file"
            aria-label="Send a file"
            className="h-10 w-10 shrink-0 rounded-full border border-border-default flex items-center justify-center text-text-secondary hover:text-text-primary"
          >
            <Paperclip className="h-5 w-5" aria-hidden="true" />
          </button>
          <input
            ref={docRef}
            type="file"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onSendImage(f); e.target.value = '' }}
          />
          <button
            type="button"
            onClick={() => setPollOpen(true)}
            title="Create a poll"
            aria-label="Create a poll"
            className="h-10 w-10 shrink-0 rounded-full border border-border-default flex items-center justify-center text-text-secondary hover:text-text-primary"
          >
            <BarChart3 className="h-5 w-5" aria-hidden="true" />
          </button>
          {recording ? (
            <>
              <button type="button" onClick={cancelRecording} title="Cancel recording" className="h-10 w-10 shrink-0 rounded-full border border-border-default flex items-center justify-center text-text-secondary hover:text-red-500">
                ✕
              </button>
              <button type="button" onClick={stopRecording} title="Stop & send" className="h-10 px-3 shrink-0 rounded-full bg-red-500 text-white text-xs flex items-center gap-1">
                <Square className="h-3 w-3 fill-current" aria-hidden="true" />
                {recordSecs}s
              </button>
            </>
          ) : (
            <button type="button" onClick={() => void startRecording()} title="Record voice note" aria-label="Record voice note" className="h-10 w-10 shrink-0 rounded-full border border-border-default flex items-center justify-center text-text-secondary hover:text-text-primary">
              <Mic className="h-5 w-5" aria-hidden="true" />
            </button>
          )}
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); if (convoId) saveDraft(convoId, e.target.value); if (e.target.value.trim()) broadcastTyping(); autoGrow() }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            rows={1}
            placeholder="Type a message…  (Shift+Enter for new line)"
            className="order-first w-full sm:order-none sm:w-auto sm:flex-1 max-h-[120px] py-2 px-4 rounded-2xl border border-border-default bg-surface-raised text-sm outline-none focus:border-accent-ink resize-none leading-5"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="ml-auto sm:ml-0 h-10 px-5 rounded-full bg-[#3F7A0A] text-white font-mono text-xs hover:bg-[#356a08] disabled:opacity-40 transition-colors"
          >
            SEND
          </button>
        </form>
      </div>

      {/* Right-click / long-press context menu */}
      {ctxMenu && (
        <div className="fixed inset-0 z-40" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null) }}>
          <div
            className="absolute min-w-[150px] bg-surface-raised border border-border-default rounded-lg shadow-lg py-1"
            style={{ top: ctxMenu.y, left: ctxMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            {!ctxMenu.msg.deletedAt && (
              <div className="flex gap-1 px-2 py-1.5 border-b border-border-default">
                {REACTION_CHOICES.map((e) => (
                  <button key={e} type="button" onClick={() => { onReact(ctxMenu.msg.id, e); setCtxMenu(null) }} className="text-lg leading-none hover:scale-125 transition-transform">{e}</button>
                ))}
              </div>
            )}
            <button type="button" onClick={() => { setReplyingTo(ctxMenu.msg); setCtxMenu(null) }} className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-text-primary//[0.05] flex items-center gap-2"><Reply className="h-4 w-4 shrink-0" aria-hidden="true" />Reply</button>
            {!ctxMenu.msg.deletedAt && ctxMenu.msg.type !== 'IMAGE' && (
              <button type="button" onClick={() => { onForward(ctxMenu.msg); setCtxMenu(null) }} className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-text-primary//[0.05] flex items-center gap-2"><Forward className="h-4 w-4 shrink-0" aria-hidden="true" />Forward</button>
            )}
            {!ctxMenu.msg.deletedAt && (
              <button type="button" onClick={() => { onStar(ctxMenu.msg.id); setCtxMenu(null) }} className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-text-primary//[0.05] flex items-center gap-2">{ctxMenu.msg.starred ? <><StarOff className="h-4 w-4 shrink-0" aria-hidden="true" />Unstar</> : <><Star className="h-4 w-4 shrink-0" aria-hidden="true" />Star</>}</button>
            )}
            {!ctxMenu.msg.deletedAt && (
              <button type="button" onClick={() => { onPin(ctxMenu.msg.id, !ctxMenu.msg.pinnedAt); setCtxMenu(null) }} className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-text-primary//[0.05] flex items-center gap-2">{ctxMenu.msg.pinnedAt ? <><PinOff className="h-4 w-4 shrink-0" aria-hidden="true" />Unpin</> : <><Pin className="h-4 w-4 shrink-0" aria-hidden="true" />Pin</>}</button>
            )}
            {ctxMenu.msg.type !== 'IMAGE' && !ctxMenu.msg.deletedAt && (
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(ctxMenu.msg.content); setCtxMenu(null) }} className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-text-primary//[0.05] flex items-center gap-2"><Copy className="h-4 w-4 shrink-0" aria-hidden="true" />Copy</button>
            )}
            {ctxMenu.msg.senderId === meId && ctxMenu.msg.type !== 'IMAGE' && !ctxMenu.msg.deletedAt && (
              <button type="button" onClick={() => { startEdit(ctxMenu.msg); setCtxMenu(null) }} className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-text-primary//[0.05] flex items-center gap-2"><Pencil className="h-4 w-4 shrink-0" aria-hidden="true" />Edit</button>
            )}
            {ctxMenu.msg.senderId === meId && !ctxMenu.msg.deletedAt && (
              <button type="button" onClick={() => { const id = ctxMenu.msg.id; setCtxMenu(null); if (confirm('Delete this message for everyone?')) onDelete(id) }} className="w-full text-left px-3 py-2 text-sm text-status-danger hover:bg-text-primary//[0.05] flex items-center gap-2"><Trash2 className="h-4 w-4 shrink-0" aria-hidden="true" />Delete</button>
            )}
            {ctxMenu.msg.senderId === meId && (
              <button type="button" onClick={() => { setInfoMsg(ctxMenu.msg); setCtxMenu(null) }} className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-text-primary//[0.05] flex items-center gap-2"><Info className="h-4 w-4 shrink-0" aria-hidden="true" />Info</button>
            )}
          </div>
        </div>
      )}

      {infoMsg && (
        <MessageInfoModal message={infoMsg} conversation={conversation} meId={meId} onClose={() => setInfoMsg(null)} />
      )}

      {groupInfoOpen && conversation.type === 'GROUP' && (
        <GroupInfoPanel
          conversation={conversation}
          meId={meId}
          users={users}
          onClose={() => setGroupInfoOpen(false)}
          onChanged={onChanged}
          onLeft={() => { setGroupInfoOpen(false); onLeft() }}
        />
      )}

      {pollOpen && (
        <PollComposer onClose={() => setPollOpen(false)} onCreate={(q, opts, multi) => onCreatePoll(q, opts, multi)} />
      )}
    </section>
  )
}
