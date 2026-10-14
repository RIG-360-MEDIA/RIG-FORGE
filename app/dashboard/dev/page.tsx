'use client'

/**
 * HIDDEN developer dashboard — /dashboard/dev
 *
 * Not linked from any nav. Server-side access is gated by the
 * DEV_DASHBOARD_EMAILS allowlist (see /api/dev/forgie-usage). If the logged-in
 * user isn't on the allowlist the API returns 404 and we bounce to /dashboard.
 *
 * Shows a name card per user with their Forgie usage; clicking a card opens a
 * panel with every web + WhatsApp conversation transcript and every action
 * Forgie executed on their behalf.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useRouter } from 'next/navigation'

import { useAuth } from '@/hooks/useAuth'

interface UserRow {
  id: string
  name: string
  email: string
  role: string
  whatsappNumber: string | null
  isActive: boolean
  webConversations: number
  waConversations: number
  webMessages: number
  waMessages: number
  actions: number
  lastActiveAt: string | null
}

interface Message {
  id: string
  role: 'USER' | 'ASSISTANT' | 'SYSTEM' | 'TOOL'
  content: string
  provider: string | null
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  createdAt: string
}

interface Conversation {
  id: string
  channel: 'WEB' | 'WHATSAPP'
  title: string | null
  isPinned: boolean
  isArchived: boolean
  createdAt: string
  updatedAt: string
  messages: Message[]
}

interface ActionLog {
  id: string
  action: string
  args: unknown
  result: unknown
  success: boolean
  error: string | null
  createdAt: string
}

interface Detail {
  user: { id: string; name: string; email: string; role: string; whatsappNumber: string | null }
  conversations: Conversation[]
  actions: ActionLog[]
}

interface Latency {
  windowDays: number
  count: number
  p50Ms: number
  p95Ms: number
  avgMs: number
  avgInputTokens: number
  sloP95Ms: number
  sloBreached: boolean
  byProvider: Array<{ provider: string | null; count: number; p50Ms: number; p95Ms: number; avgMs: number }>
}

function fmtMs(ms: number): string {
  if (!ms) return '—'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

export default function DevDashboardPage() {
  const router = useRouter()
  const { user, loading } = useAuth()
  const [rows, setRows] = useState<UserRow[] | null>(null)
  const [denied, setDenied] = useState(false)
  const [selected, setSelected] = useState<UserRow | null>(null)
  const [instances, setInstances] = useState<{ id: string; label: string }[]>([])
  const [instance, setInstance] = useState<string>('rig360')
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [latency, setLatency] = useState<Latency | null>(null)

  useEffect(() => {
    if (loading || !user) return
    let cancelled = false
    setRows(null)
    setSelected(null)
    setUnavailable(null)
    setLatency(null)
    void (async () => {
      try {
        const res = await fetch(`/api/dev/forgie-usage?instance=${encodeURIComponent(instance)}`, {
          credentials: 'include',
        })
        if (res.status === 404 || res.status === 403) {
          setDenied(true)
          router.replace('/dashboard')
          return
        }
        const json = (await res.json()) as {
          data?: {
            users: UserRow[]
            instances?: { id: string; label: string }[]
            unavailable?: boolean
            reason?: string
            latency?: Latency | null
          }
        }
        if (cancelled) return
        if (json.data?.instances) setInstances(json.data.instances)
        setUnavailable(json.data?.unavailable ? json.data.reason ?? 'Instance unavailable' : null)
        setRows(json.data?.users ?? [])
        setLatency(json.data?.latency ?? null)
      } catch {
        if (!cancelled) setDenied(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loading, user, router, instance])

  if (loading || (!rows && !denied)) {
    return <div className="p-8 text-sm text-text-muted">Loading…</div>
  }
  if (denied) return null

  const totalUsers = rows?.length ?? 0
  const totalChats = (rows ?? []).reduce((s, r) => s + r.webConversations + r.waConversations, 0)
  const totalActions = (rows ?? []).reduce((s, r) => s + r.actions, 0)
  const companyLabel = instances.find((i) => i.id === instance)?.label ?? instance

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="mb-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-text-primary">Forgie — Developer Console</h1>
            <span className="text-[10px] font-mono uppercase tracking-widest bg-[#1A1A1A] text-white px-2 py-0.5 rounded">
              hidden
            </span>
          </div>

          {instances.length > 1 && (
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              <span className="font-mono uppercase tracking-widest text-text-muted">Company</span>
              <select
                value={instance}
                onChange={(e) => setInstance(e.target.value)}
                className="bg-surface-raised border border-border-default rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent-ink"
              >
                {instances.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <p className="text-sm text-text-secondary mt-1">
          Every user's Forgie activity — web &amp; WhatsApp chats and the actions Forgie ran for them.
          Visible only to allowlisted developer accounts.
        </p>
        {unavailable && (
          <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            This company's data isn't reachable from this deployment ({unavailable}). Its schema may not
            be provisioned here.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <StatCard label="Users" value={totalUsers} />
        <StatCard label="Total conversations" value={totalChats} />
        <StatCard label="AI-executed actions" value={totalActions} />
      </div>

      {/* Forgie latency — THIS company only (dev-only observability) */}
      {latency && latency.count > 0 && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-mono uppercase tracking-widest text-text-muted">
              Forgie latency — {companyLabel} · last {latency.windowDays}d
            </h2>
            <span className="text-[11px] text-text-muted">{latency.count.toLocaleString()} turns</span>
          </div>
          {latency.sloBreached && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              p95 is {fmtMs(latency.p95Ms)} — above the {fmtMs(latency.sloP95Ms)} target.
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <LatCard label="Median (p50)" value={fmtMs(latency.p50Ms)} />
            <LatCard label="p95" value={fmtMs(latency.p95Ms)} bad={latency.sloBreached} />
            <LatCard label="Average" value={fmtMs(latency.avgMs)} />
            <LatCard label="Avg input tokens" value={latency.avgInputTokens.toLocaleString()} />
          </div>
          {latency.byProvider.length > 0 && (
            <div className="overflow-x-auto mt-3">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-mono uppercase tracking-widest text-text-muted">
                    <th className="px-3 py-2">Provider</th>
                    <th className="px-3 py-2 text-right">Turns</th>
                    <th className="px-3 py-2 text-right">p50</th>
                    <th className="px-3 py-2 text-right">p95</th>
                    <th className="px-3 py-2 text-right">Avg</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {latency.byProvider.map((p) => (
                    <tr key={p.provider ?? 'null'}>
                      <td className="px-3 py-2 font-medium">{p.provider ?? '—'}</td>
                      <td className="px-3 py-2 text-right">{p.count.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right text-text-secondary">{fmtMs(p.p50Ms)}</td>
                      <td className="px-3 py-2 text-right text-text-secondary">{fmtMs(p.p95Ms)}</td>
                      <td className="px-3 py-2 text-right text-text-secondary">{fmtMs(p.avgMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {(rows ?? []).map((r) => (
          <button
            key={r.id}
            onClick={() => setSelected(r)}
            className="text-left bg-surface-raised border border-border-default rounded-lg p-4 hover:border-border-strong hover:shadow-sm transition"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold text-text-primary truncate">{r.name}</p>
                <p className="text-xs text-text-muted truncate">{r.email}</p>
              </div>
              <span className="shrink-0 text-[10px] font-mono uppercase tracking-wide text-text-secondary">
                {r.role.replace('_', ' ')}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 mt-4">
              <Metric label="Web" value={r.webConversations} sub={`${r.webMessages} msg`} />
              <Metric label="WhatsApp" value={r.waConversations} sub={`${r.waMessages} msg`} />
              <Metric label="Actions" value={r.actions} sub="ran" />
            </div>

            <div className="mt-3 flex items-center justify-between text-[11px] text-text-muted">
              <span>{r.whatsappNumber ?? 'no WA number'}</span>
              <span>{r.lastActiveAt ? `active ${relative(r.lastActiveAt)}` : 'never used'}</span>
            </div>
            {!r.isActive && (
              <span className="inline-block mt-2 text-[10px] font-mono uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                inactive
              </span>
            )}
          </button>
        ))}
      </div>

      {selected && (
        <DetailPanel row={selected} instance={instance} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}

// ─── Detail slide-over ─────────────────────────────────────────────────────────

function DetailPanel({
  row,
  instance,
  onClose,
}: {
  row: UserRow
  instance: string
  onClose: () => void
}) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [tab, setTab] = useState<'WEB' | 'WHATSAPP' | 'ACTIONS'>('WEB')
  const [openConv, setOpenConv] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const res = await fetch(
        `/api/dev/forgie-usage/${row.id}?instance=${encodeURIComponent(instance)}`,
        { credentials: 'include' },
      )
      const json = (await res.json()) as { data?: Detail }
      setDetail(json.data ?? null)
    })()
  }, [row.id, instance])

  const convs = detail?.conversations ?? []
  const webConvs = convs.filter((c) => c.channel === 'WEB')
  const waConvs = convs.filter((c) => c.channel === 'WHATSAPP')
  const shown = tab === 'WEB' ? webConvs : tab === 'WHATSAPP' ? waConvs : []

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-surface-mid h-full overflow-y-auto shadow-xl">
        <div className="sticky top-0 bg-surface-mid border-b border-border-default px-5 py-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-text-primary">{row.name}</h2>
            <p className="text-xs text-text-muted">{row.email}{row.whatsappNumber ? ` · ${row.whatsappNumber}` : ''}</p>
          </div>
          <button type="button" aria-label="Close panel" onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl leading-none p-1">×</button>
        </div>

        <div className="flex gap-1 px-5 pt-4">
          <Tab active={tab === 'WEB'} onClick={() => setTab('WEB')}>Web ({webConvs.length})</Tab>
          <Tab active={tab === 'WHATSAPP'} onClick={() => setTab('WHATSAPP')}>WhatsApp ({waConvs.length})</Tab>
          <Tab active={tab === 'ACTIONS'} onClick={() => setTab('ACTIONS')}>Actions ({detail?.actions.length ?? 0})</Tab>
        </div>

        <div className="px-5 py-4">
          {!detail && <p className="text-sm text-text-muted">Loading…</p>}

          {detail && tab !== 'ACTIONS' && shown.length === 0 && (
            <p className="text-sm text-text-muted">No {tab === 'WEB' ? 'web' : 'WhatsApp'} conversations.</p>
          )}

          {detail && tab !== 'ACTIONS' && shown.map((c) => (
            <div key={c.id} className="mb-3 bg-surface-raised border border-border-default rounded-lg overflow-hidden">
              <button
                onClick={() => setOpenConv(openConv === c.id ? null : c.id)}
                className="w-full text-left px-4 py-3 flex items-center justify-between gap-2 hover:bg-black/[0.02]"
              >
                <span className="text-sm font-medium text-text-primary truncate">
                  {c.title || 'Untitled conversation'}
                </span>
                <span className="shrink-0 text-[11px] text-text-muted">
                  {c.messages.length} msg · {relative(c.updatedAt)}
                </span>
              </button>
              {openConv === c.id && (
                <div className="px-4 pb-4 space-y-3 border-t border-border-subtle pt-3">
                  {c.messages.map((m) => (
                    <MessageBubble key={m.id} m={m} />
                  ))}
                </div>
              )}
            </div>
          ))}

          {detail && tab === 'ACTIONS' && (
            detail.actions.length === 0 ? (
              <p className="text-sm text-text-muted">Forgie hasn't run any actions for this user.</p>
            ) : (
              <div className="space-y-2">
                {detail.actions.map((a) => (
                  <div key={a.id} className="bg-surface-raised border border-border-default rounded-lg px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={['w-2 h-2 rounded-full', a.success ? 'bg-emerald-500' : 'bg-red-500'].join(' ')} />
                      <span className="text-sm font-medium">{a.action.replace(/_/g, ' ')}</span>
                      <span className="ml-auto text-[11px] text-text-muted">{relative(a.createdAt)}</span>
                    </div>
                    {a.error && <p className="text-xs text-red-600 mt-1">{a.error}</p>}
                    <pre className="mt-2 text-[11px] text-text-secondary bg-black/[0.03] rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
                      {safeJson(a.args)}
                    </pre>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}

function MessageBubble({ m }: { m: Message }) {
  const isUser = m.role === 'USER'
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={[
          'max-w-[85%] rounded-lg px-3 py-2 text-sm',
          isUser ? 'bg-[#1A1A1A] text-white' : 'bg-black/[0.04] text-text-primary',
        ].join(' ')}
      >
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[9px] font-mono uppercase tracking-widest opacity-60">
            {m.role}{m.provider ? ` · ${m.provider}` : ''}
          </span>
        </div>
        <p className="whitespace-pre-wrap break-words">{m.content}</p>
      </div>
    </div>
  )
}

// ─── Atoms ───────────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-surface-raised border border-border-default rounded-lg p-4">
      <p className="text-xs text-text-muted uppercase tracking-wide mb-1">{label}</p>
      <p className="text-2xl font-bold text-text-primary">{value.toLocaleString()}</p>
    </div>
  )
}

function LatCard({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className={`bg-surface-raised border rounded-lg p-4 ${bad ? 'border-red-300' : 'border-border-default'}`}>
      <p className="text-xs text-text-muted uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-2xl font-bold ${bad ? 'text-red-600' : 'text-text-primary'}`}>{value}</p>
    </div>
  )
}

function Metric({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="bg-black/[0.03] rounded-md px-2 py-1.5 text-center">
      <p className="text-[10px] font-mono uppercase tracking-wide text-text-muted">{label}</p>
      <p className="text-lg font-bold text-text-primary leading-tight">{value}</p>
      <p className="text-[10px] text-text-muted">{sub}</p>
    </div>
  )
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={[
        'px-3 py-1.5 text-xs font-mono uppercase tracking-wide rounded-t-md',
        active ? 'bg-surface-raised text-text-primary border border-border-default border-b-white' : 'text-text-muted hover:text-text-secondary',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

function relative(iso: string): string {
  const then = new Date(iso).getTime()
  const diffMin = Math.floor((Date.now() - then) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
