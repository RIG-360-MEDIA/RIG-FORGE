'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ApiResponse } from '@/lib/types'
import {
  FEE_CHANGE_LABELS, PAYMENT_MODES, formatInr, formatPercentBp, paiseToRupeesText, rupeesToPaise,
  type FeeBasis, type PaymentMode, type PaymentsSummary, type PhaseView, type ReceiptView,
} from '@/lib/payment-types'

// A project's payments: the agreed fee and its changes, the billing phases,
// every payment received and what it paid for. ADMIN and SUPER_ADMIN only
// (the page shows this tab only to them, and every API refuses anyone else).
// Nothing here is a typed-in total: received, balances and on-account are
// calculated from the receipts, which are never edited (only reversed).

const field = 'w-full bg-background-primary border border-border-default rounded px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-accent [color-scheme:light]'
const label = 'flex flex-col gap-1 text-[11px] font-medium text-muted uppercase tracking-wider'
const primaryBtn = 'px-4 py-2 text-sm font-semibold rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50'
const ghostBtn = 'px-3 py-2 text-sm text-secondary hover:text-primary'

const todayText = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const showDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '')
const showWhen = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const modeLabel = (m: PaymentMode) => PAYMENT_MODES.find((x) => x.value === m)?.label ?? m

async function send(url: string, method: string, body?: unknown): Promise<{ data: PaymentsSummary | null; error: string | null; code?: string }> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: body === undefined ? undefined : JSON.stringify(body) })
    const json = await res.json().catch(() => ({})) as ApiResponse<PaymentsSummary> & { code?: string }
    if (!res.ok || json.error) return { data: null, error: json.error ?? 'Something went wrong. Please try again.', code: json.code }
    return { data: json.data ?? null, error: null }
  } catch {
    return { data: null, error: 'Network error. Please try again.' }
  }
}

// ─── Small parts ──────────────────────────────────────────────────────────────

function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className={`bg-surface-raised border border-border-default rounded-xl w-full ${wide ? 'max-w-2xl' : 'max-w-md'} p-6 space-y-4 text-primary max-h-[90vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  )
}

function ErrorLine({ text }: { text: string | null }) {
  return text ? <div className="text-sm text-status-danger bg-status-danger/10 border border-status-danger/30 rounded px-3 py-2">{text}</div> : null
}

function Stat({ title, value, sub, tone }: { title: string; value: string; sub?: string; tone?: 'good' | 'warn' | 'bad' }) {
  const color = tone === 'good' ? 'text-status-success' : tone === 'warn' ? 'text-status-warning' : tone === 'bad' ? 'text-status-danger' : 'text-primary'
  return (
    <div className="rounded-xl border border-border-default bg-surface-raised/50 px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted">{title}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </div>
  )
}

const STATUS_STYLE: Record<PhaseView['status'], string> = {
  PAID: 'bg-status-success/15 text-status-success',
  PART_PAID: 'bg-status-warning/15 text-status-warning',
  UNPAID: 'bg-surface-sunken text-secondary',
}
const STATUS_TEXT: Record<PhaseView['status'], string> = { PAID: 'Paid', PART_PAID: 'Part paid', UNPAID: 'Unpaid' }

// ─── Setup ────────────────────────────────────────────────────────────────────

function SetupCard({ projectId, onDone }: { projectId: string; onDone: (s: PaymentsSummary) => void }) {
  const [basis, setBasis] = useState<FeeBasis>('FIXED')
  const [fee, setFee] = useState('')
  const [cost, setCost] = useState('')
  const [percent, setPercent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const costPaise = rupeesToPaise(cost)
  const pct = Number(percent)
  const preview = basis === 'FIXED'
    ? rupeesToPaise(fee)
    : costPaise !== null && pct > 0 && pct <= 100 ? Math.round(costPaise * pct / 100) : null

  async function save() {
    setBusy(true); setError(null)
    const r = await send(`/api/projects/${projectId}/payments`, 'POST', basis === 'FIXED' ? { basis, fee } : { basis, estimatedCost: cost, percent })
    setBusy(false)
    if (r.error) { setError(r.error); return }
    if (r.data) onDone(r.data)
  }

  return (
    <div className="rounded-xl border border-border-default bg-surface-raised/40 p-6 space-y-4 max-w-xl">
      <div>
        <h3 className="text-base font-semibold text-primary">Set up this project&apos;s fee</h3>
        <p className="text-sm text-secondary mt-1">Done once. Any later change is recorded as a fee change with a reason, so the history always shows how the fee came about.</p>
      </div>
      <div role="radiogroup" aria-label="How the fee is set" className="inline-flex rounded-lg border border-border-default p-0.5">
        {(['FIXED', 'PERCENT'] as FeeBasis[]).map((b) => (
          <button key={b} type="button" role="radio" aria-checked={basis === b} onClick={() => setBasis(b)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${basis === b ? 'bg-accent text-white' : 'text-secondary hover:text-primary'}`}>
            {b === 'FIXED' ? 'Fixed fee' : '% of construction cost'}
          </button>
        ))}
      </div>
      {basis === 'FIXED' ? (
        <label className={label}>Agreed fee (₹)<input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="e.g. 15,00,000" className={field} /></label>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>Estimated construction cost (₹)<input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="e.g. 2,00,00,000" className={field} /></label>
          <label className={label}>Fee percentage (%)<input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="e.g. 7.5" className={field} /></label>
        </div>
      )}
      <p className="text-sm text-secondary">Fee: <span className="font-semibold text-primary tabular-nums">{preview !== null && preview > 0 ? formatInr(preview) : '—'}</span></p>
      <ErrorLine text={error} />
      <button type="button" disabled={busy || preview === null || preview <= 0} onClick={() => void save()} className={primaryBtn}>
        {busy ? 'Saving...' : 'Set up fee'}
      </button>
    </div>
  )
}

// ─── Allocation editor (record payment, allocate on-account) ──────────────────

function AllocationEditor({ phases, total, values, onChange }: {
  phases: PhaseView[]
  /** Money available to count against phases, in paise (null while the amount is not valid). */
  total: number | null
  values: Record<string, string>
  onChange: (v: Record<string, string>) => void
}) {
  const open = phases.filter((p) => p.isActive && p.balance > 0)
  const used = open.reduce((s, p) => s + (rupeesToPaise(values[p.id] ?? '') ?? 0), 0)
  const left = total === null ? null : total - used

  function fillInOrder() {
    if (total === null) return
    let rest = total
    const next: Record<string, string> = {}
    for (const p of open) {
      if (rest <= 0) break
      const take = Math.min(rest, p.balance)
      next[p.id] = paiseToRupeesText(take)
      rest -= take
    }
    onChange(next)
  }

  if (open.length === 0) return <p className="text-sm text-muted">Every phase is fully paid; this payment will stay on account.</p>
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Count it against phases</p>
        <button type="button" onClick={fillInOrder} disabled={total === null} className="text-xs font-medium text-accent hover:underline disabled:opacity-40">Fill in phase order</button>
      </div>
      <ul className="rounded-lg border border-border-default divide-y divide-border-default">
        {open.map((p) => {
          const v = values[p.id] ?? ''
          const paise = v ? rupeesToPaise(v) : 0
          const bad = paise === null || (paise ?? 0) > p.balance
          return (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2">
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-primary truncate">{p.name}</span>
                <span className="block text-[11px] text-muted">Balance {formatInr(p.balance)}</span>
              </span>
              <span className="w-36 shrink-0">
              <input
                inputMode="decimal"
                value={v}
                onChange={(e) => onChange({ ...values, [p.id]: e.target.value })}
                placeholder="0"
                aria-label={`Amount for ${p.name}`}
                className={`${field} text-right tabular-nums ${bad ? 'border-status-danger' : ''}`}
              />
              </span>
            </li>
          )
        })}
      </ul>
      {left !== null && (
        <p className={`text-xs ${left < 0 ? 'text-status-danger' : 'text-muted'}`}>
          {left < 0 ? `${formatInr(-left)} more than the payment` : left > 0 ? `${formatInr(left)} will stay on account` : 'All of it is counted against phases'}
        </p>
      )}
    </div>
  )
}

const allocationList = (values: Record<string, string>) =>
  Object.entries(values).filter(([, v]) => v.trim() && rupeesToPaise(v) !== 0).map(([phaseId, amount]) => ({ phaseId, amount }))

// ─── Record payment ───────────────────────────────────────────────────────────

function RecordPaymentModal({ projectId, summary, onClose, onSaved }: {
  projectId: string; summary: PaymentsSummary; onClose: () => void; onSaved: (s: PaymentsSummary, msg: string) => void
}) {
  const [receivedOn, setReceivedOn] = useState(todayText())
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState<PaymentMode>('BANK')
  const [reference, setReference] = useState('')
  const [payer, setPayer] = useState('')
  const [note, setNote] = useState('')
  const [alloc, setAlloc] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState<string | null>(null)

  const paise = rupeesToPaise(amount)

  async function save(confirmDuplicate = false) {
    setBusy(true); setError(null)
    const r = await send(`/api/projects/${projectId}/payments/receipts`, 'POST', {
      receivedOn, amount, mode, reference, payer, note, allocations: allocationList(alloc), confirmDuplicate,
    })
    setBusy(false)
    if (r.code === 'DUPLICATE') { setDuplicate(r.error); return }
    if (r.error) { setError(r.error); return }
    if (r.data) onSaved(r.data, `Payment of ${formatInr(paise ?? 0)} recorded.`)
  }

  return (
    <Modal title="Record a payment received" onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-3">
        <label className={label}>Amount received (₹)<input autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 3,00,000" className={field} /></label>
        <label className={label}>Received on<input type="date" value={receivedOn} max={todayText()} onChange={(e) => setReceivedOn(e.target.value)} className={field} /></label>
        <label className={label}>Paid by
          <select value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)} className={field}>
            {PAYMENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <label className={label}>Reference (UTR, cheque no.)<input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} className={field} /></label>
        <label className={label}>Received from<input value={payer} onChange={(e) => setPayer(e.target.value)} maxLength={100} placeholder="Client name" className={field} /></label>
        <label className={label}>Note<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={field} /></label>
      </div>
      <AllocationEditor phases={summary.phases} total={paise} values={alloc} onChange={setAlloc} />
      <ErrorLine text={error} />
      {duplicate && (
        <div className="text-sm bg-status-warning/10 border border-status-warning/40 rounded px-3 py-2 space-y-2">
          <p className="text-primary">{duplicate}</p>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => void save(true)} className="px-3 py-1.5 text-xs font-semibold rounded bg-status-warning text-white">It is a separate payment, record it</button>
            <button type="button" onClick={() => setDuplicate(null)} className="px-3 py-1.5 text-xs text-secondary">Go back</button>
          </div>
        </div>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
        <button type="button" disabled={busy || paise === null || paise <= 0 || !!duplicate} onClick={() => void save()} className={primaryBtn}>
          {busy ? 'Saving...' : 'Record payment'}
        </button>
      </div>
    </Modal>
  )
}

// ─── Phase form (add / edit) ──────────────────────────────────────────────────

function PhaseModal({ projectId, summary, phase, onClose, onSaved }: {
  projectId: string; summary: PaymentsSummary; phase: PhaseView | null; onClose: () => void; onSaved: (s: PaymentsSummary, msg: string) => void
}) {
  const remaining = summary.totals.fee - summary.totals.phasesTotal
  const [name, setName] = useState(phase?.name ?? '')
  const [by, setBy] = useState<'amount' | 'percent'>('amount')
  const [amount, setAmount] = useState(phase ? paiseToRupeesText(phase.amount) : remaining > 0 ? paiseToRupeesText(remaining) : '')
  const [percent, setPercent] = useState('')
  const [dueDate, setDueDate] = useState(phase?.dueDate?.slice(0, 10) ?? '')
  const [note, setNote] = useState(phase?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pct = Number(percent)
  const preview = by === 'amount' ? rupeesToPaise(amount) : pct > 0 && pct <= 100 ? Math.round(summary.totals.fee * pct / 100) : null

  async function save() {
    setBusy(true); setError(null)
    const body = phase
      ? { name, amount, dueDate: dueDate || null, note }
      : { name, ...(by === 'amount' ? { amount } : { percent }), dueDate: dueDate || null, note }
    const r = await send(phase ? `/api/projects/${projectId}/payments/phases/${phase.id}` : `/api/projects/${projectId}/payments/phases`, phase ? 'PATCH' : 'POST', body)
    setBusy(false)
    if (r.error) { setError(r.error); return }
    if (r.data) onSaved(r.data, phase ? `"${name}" saved.` : `Phase "${name}" added.`)
  }

  return (
    <Modal title={phase ? `Edit ${phase.name}` : 'Add a billing phase'} onClose={onClose}>
      <label className={label}>Phase name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="e.g. Working drawings" className={field} /></label>
      {!phase && (
        <div className="inline-flex rounded-lg border border-border-default p-0.5">
          {(['amount', 'percent'] as const).map((b) => (
            <button key={b} type="button" onClick={() => setBy(b)} className={`px-3 py-1 text-xs font-medium rounded-md ${by === b ? 'bg-accent text-white' : 'text-secondary'}`}>
              {b === 'amount' ? 'Amount' : '% of fee'}
            </button>
          ))}
        </div>
      )}
      {by === 'amount' || phase ? (
        <label className={label}>Amount (₹)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={field} /></label>
      ) : (
        <label className={label}>Percentage of the fee ({formatInr(summary.totals.fee)})<input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="e.g. 25" className={field} /></label>
      )}
      {phase && phase.received > 0 && <p className="text-xs text-muted">{formatInr(phase.received)} already received against this phase; the amount cannot go below that.</p>}
      <p className="text-xs text-muted">
        Phase amount: <span className="text-primary font-medium">{preview !== null && preview > 0 ? formatInr(preview) : '—'}</span>
        {!phase && remaining !== 0 && <> · {remaining > 0 ? `${formatInr(remaining)} of the fee is not in any phase yet` : `phases are ${formatInr(-remaining)} over the fee`}</>}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label className={label}>Due date (optional)<input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={field} /></label>
        <label className={label}>Note (optional)<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={field} /></label>
      </div>
      <ErrorLine text={error} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
        <button type="button" disabled={busy || !name.trim() || preview === null || preview <= 0} onClick={() => void save()} className={primaryBtn}>
          {busy ? 'Saving...' : phase ? 'Save' : 'Add phase'}
        </button>
      </div>
    </Modal>
  )
}

// ─── Fee change ───────────────────────────────────────────────────────────────

function FeeChangeModal({ projectId, summary, onClose, onSaved }: {
  projectId: string; summary: PaymentsSummary; onClose: () => void; onSaved: (s: PaymentsSummary, msg: string) => void
}) {
  const isPercent = summary.plan?.basis === 'PERCENT'
  const [kind, setKind] = useState<'VARIATION' | 'CORRECTION' | 'COST_REVISION'>(isPercent ? 'COST_REVISION' : 'VARIATION')
  const [amount, setAmount] = useState('')
  const [cost, setCost] = useState(summary.fee.estimatedCost !== null ? paiseToRupeesText(summary.fee.estimatedCost) : '')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const bp = summary.plan?.percentBp ?? 0
  const delta = kind === 'COST_REVISION'
    ? (() => { const c = rupeesToPaise(cost); return c === null ? null : Math.round(c * bp / 10000) - Math.round((summary.fee.estimatedCost ?? 0) * bp / 10000) })()
    : rupeesToPaise(amount, { signed: true })

  async function save() {
    setBusy(true); setError(null)
    const r = await send(`/api/projects/${projectId}/payments/fee-changes`, 'POST',
      kind === 'COST_REVISION' ? { kind, estimatedCost: cost, reason } : { kind, amountDelta: amount, reason })
    setBusy(false)
    if (r.error) { setError(r.error); return }
    if (r.data) onSaved(r.data, `Fee is now ${formatInr(r.data.totals.fee)}.`)
  }

  return (
    <Modal title="Change the fee" onClose={onClose}>
      <p className="text-sm text-secondary">The agreed fee is kept; this adds a change with your reason. Current fee: <span className="font-semibold text-primary">{formatInr(summary.totals.fee)}</span></p>
      <label className={label}>Kind of change
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={field}>
          {isPercent && <option value="COST_REVISION">New construction cost estimate</option>}
          <option value="VARIATION">Variation (more or less work)</option>
          <option value="CORRECTION">Correction</option>
        </select>
      </label>
      {kind === 'COST_REVISION' ? (
        <label className={label}>New estimated construction cost (₹)<input autoFocus inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} className={field} /></label>
      ) : (
        <label className={label}>Amount to add (₹; use a minus to reduce)<input autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 50000 or -25000" className={field} /></label>
      )}
      <label className={label}>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Basement added at client's request" className={field} /></label>
      {delta !== null && delta !== 0 && (
        <p className="text-sm text-secondary">Fee {delta > 0 ? 'rises' : 'falls'} by {formatInr(Math.abs(delta))} to <span className="font-semibold text-primary">{formatInr(summary.totals.fee + delta)}</span>.</p>
      )}
      <ErrorLine text={error} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
        <button type="button" disabled={busy || delta === null || delta === 0 || reason.trim().length < 3} onClick={() => void save()} className={primaryBtn}>
          {busy ? 'Saving...' : 'Record change'}
        </button>
      </div>
    </Modal>
  )
}

// ─── Reverse / allocate ───────────────────────────────────────────────────────

function ReverseModal({ projectId, receipt, onClose, onSaved }: {
  projectId: string; receipt: ReceiptView; onClose: () => void; onSaved: (s: PaymentsSummary, msg: string) => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function save() {
    setBusy(true); setError(null)
    const r = await send(`/api/projects/${projectId}/payments/receipts/${receipt.id}/reverse`, 'POST', { reason })
    setBusy(false)
    if (r.error) { setError(r.error); return }
    if (r.data) onSaved(r.data, `Payment of ${formatInr(receipt.amount)} reversed.`)
  }
  return (
    <Modal title="Reverse this payment" onClose={onClose}>
      <p className="text-sm text-secondary">
        {formatInr(receipt.amount)} received {showDate(receipt.receivedOn)} by {modeLabel(receipt.mode)}{receipt.reference ? ` (${receipt.reference})` : ''}.
        It stays in the history, marked reversed, and stops counting toward every total. This cannot be undone; record it again if needed.
      </p>
      <label className={label}>Reason<input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Entered on the wrong project" className={field} /></label>
      <ErrorLine text={error} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
        <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void save()} className="px-4 py-2 text-sm font-semibold rounded bg-status-danger text-white disabled:opacity-50">
          {busy ? 'Reversing...' : 'Reverse payment'}
        </button>
      </div>
    </Modal>
  )
}

function AllocateModal({ projectId, summary, receipt, onClose, onSaved }: {
  projectId: string; summary: PaymentsSummary; receipt: ReceiptView; onClose: () => void; onSaved: (s: PaymentsSummary, msg: string) => void
}) {
  const [alloc, setAlloc] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const list = allocationList(alloc)
  async function save() {
    setBusy(true); setError(null)
    const r = await send(`/api/projects/${projectId}/payments/receipts/${receipt.id}/allocate`, 'POST', { allocations: list })
    setBusy(false)
    if (r.error) { setError(r.error); return }
    if (r.data) onSaved(r.data, 'On-account money counted against phases.')
  }
  return (
    <Modal title="Count on-account money against phases" onClose={onClose} wide>
      <p className="text-sm text-secondary">From the {formatInr(receipt.amount)} received {showDate(receipt.receivedOn)}: <span className="font-semibold text-primary">{formatInr(receipt.onAccount)}</span> is on account.</p>
      <AllocationEditor phases={summary.phases} total={receipt.onAccount} values={alloc} onChange={setAlloc} />
      <ErrorLine text={error} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
        <button type="button" disabled={busy || list.length === 0} onClick={() => void save()} className={primaryBtn}>{busy ? 'Saving...' : 'Save'}</button>
      </div>
    </Modal>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

type Dialog =
  | { kind: 'record' } | { kind: 'phase'; phase: PhaseView | null } | { kind: 'fee' }
  | { kind: 'reverse'; receipt: ReceiptView } | { kind: 'allocate'; receipt: ReceiptView } | null

export default function PaymentsTab({ projectId }: { projectId: string }) {
  const [summary, setSummary] = useState<PaymentsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  const load = useCallback(async () => {
    const r = await send(`/api/projects/${projectId}/payments`, 'GET')
    if (r.error) setError(r.error)
    else setSummary(r.data)
    setLoading(false)
  }, [projectId])
  useEffect(() => { void load() }, [load])

  const saved = useCallback((s: PaymentsSummary, msg: string) => {
    setSummary(s); setDialog(null); setError(null); setNotice(msg)
    window.setTimeout(() => setNotice((m) => (m === msg ? null : m)), 4000)
  }, [])

  async function archive(phase: PhaseView, isActive: boolean) {
    const r = await send(`/api/projects/${projectId}/payments/phases/${phase.id}`, 'PATCH', { isActive })
    if (r.error) setError(r.error)
    else if (r.data) saved(r.data, isActive ? `"${phase.name}" restored.` : `"${phase.name}" archived.`)
  }
  async function move(phase: PhaseView, dir: -1 | 1) {
    const active = summary?.phases.filter((p) => p.isActive) ?? []
    const i = active.findIndex((p) => p.id === phase.id)
    const other = active[i + dir]
    if (!other) return
    // Swap positions: give each the other's place (numbered by position so equal values still move).
    const a = await send(`/api/projects/${projectId}/payments/phases/${phase.id}`, 'PATCH', { sortOrder: i + dir })
    const b = a.error ? a : await send(`/api/projects/${projectId}/payments/phases/${other.id}`, 'PATCH', { sortOrder: i })
    if (b.error) setError(b.error)
    else if (b.data) setSummary(b.data)
  }

  const activePhases = useMemo(() => summary?.phases.filter((p) => p.isActive) ?? [], [summary])
  const archived = useMemo(() => summary?.phases.filter((p) => !p.isActive) ?? [], [summary])

  if (loading) return <div className="space-y-3">{[...Array(3)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-surface-raised animate-pulse" />)}</div>
  if (!summary) return <ErrorLine text={error ?? 'Could not load payments.'} />

  if (!summary.plan) {
    return (
      <div className="space-y-4 pt-1">
        <div>
          <h2 className="text-base font-semibold text-primary">Payments</h2>
          <p className="text-sm text-secondary mt-0.5">Visible to admins only.</p>
        </div>
        <SetupCard projectId={projectId} onDone={(s) => saved(s, 'Fee set up. Now add the billing phases.')} />
      </div>
    )
  }

  const t = summary.totals
  const pctReceived = t.fee > 0 ? Math.min(100, Math.round((t.received / t.fee) * 100)) : 0

  return (
    <div className="space-y-5 pt-1">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-primary">Payments</h2>
          <p className="text-sm text-secondary mt-0.5">
            {summary.plan.basis === 'PERCENT' && summary.plan.percentBp !== null && summary.fee.estimatedCost !== null
              ? `Fee ${formatPercentBp(summary.plan.percentBp)} of ${formatInr(summary.fee.estimatedCost)} construction cost${summary.fee.changes.length > 1 ? ', with changes' : ''}. `
              : 'Fixed fee. '}
            Visible to admins only.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setDialog({ kind: 'fee' })} className="px-3 py-2 text-xs font-medium rounded border border-border-default text-primary hover:border-accent">Change fee</button>
          <button type="button" onClick={() => setDialog({ kind: 'phase', phase: null })} className="px-3 py-2 text-xs font-medium rounded border border-border-default text-primary hover:border-accent">+ Phase</button>
          <button type="button" onClick={() => setDialog({ kind: 'record' })} className="px-3 py-2 text-xs font-semibold rounded bg-accent text-white hover:bg-accent-hover">Record payment</button>
        </div>
      </div>

      {notice && <div role="status" className="text-sm text-status-success bg-status-success/10 border border-status-success/30 rounded-lg px-3 py-2">{notice}</div>}
      <ErrorLine text={error} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat title="Fee" value={formatInr(t.fee)} sub={summary.fee.changes.length > 1 ? `${summary.fee.changes.length - 1} change${summary.fee.changes.length > 2 ? 's' : ''} since agreed` : 'As agreed'} />
        <Stat title="Received" value={formatInr(t.received)} sub={`${pctReceived}% of the fee`} tone="good" />
        <Stat title="Outstanding" value={formatInr(Math.max(0, t.outstanding))} sub={t.outstanding < 0 ? `${formatInr(-t.outstanding)} paid over the fee` : 'Fee minus received'} tone={t.outstanding > 0 ? 'warn' : undefined} />
        <Stat title="On account" value={formatInr(t.onAccount)} sub="Received, not yet against a phase" />
      </div>
      <div className="h-2 rounded-full bg-surface-sunken overflow-hidden" aria-label={`${pctReceived}% of the fee received`}>
        <div className="h-full bg-status-success" style={{ width: `${pctReceived}%` }} />
      </div>

      {summary.warnings.length > 0 && (
        <ul className="space-y-1">
          {summary.warnings.map((w) => <li key={w} className="text-sm text-status-warning bg-status-warning/10 border border-status-warning/30 rounded-lg px-3 py-2">{w}</li>)}
        </ul>
      )}

      {/* Phases */}
      <section className="rounded-xl border border-border-default overflow-hidden">
        <header className="flex items-center justify-between px-4 py-3 bg-surface-raised/60">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-primary">Billing phases</h3>
          <span className="text-xs text-muted tabular-nums">{countLabel(activePhases.length, "phase")}, {formatInr(t.phasesTotal)}</span>
        </header>
        {activePhases.length === 0 ? (
          <div className="px-4 py-6 text-center border-t border-border-default">
            <p className="text-sm text-secondary">No phases yet. Split the fee into the stages you bill the client for.</p>
            <button type="button" onClick={() => setDialog({ kind: 'phase', phase: null })} className="mt-3 px-4 py-2 text-xs font-semibold rounded bg-accent text-white hover:bg-accent-hover">Add the first phase</button>
          </div>
        ) : (
          <div className="overflow-x-auto border-t border-border-default">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider text-muted text-left">
                  <th className="px-4 py-2 font-medium">Phase</th>
                  <th className="px-3 py-2 font-medium text-right">Amount</th>
                  <th className="px-3 py-2 font-medium text-right">Received</th>
                  <th className="px-3 py-2 font-medium text-right">Balance</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {activePhases.map((p, i) => (
                  <tr key={p.id} className="border-t border-border-default">
                    <td className="px-4 py-2.5">
                      <span className="text-primary">{i + 1}. {p.name}</span>
                      {(p.dueDate || p.note) && (
                        <span className={`block text-[11px] ${p.overdue ? 'text-status-danger' : 'text-muted'}`}>
                          {p.dueDate ? `${p.overdue ? 'Overdue since' : 'Due'} ${showDate(p.dueDate)}` : ''}{p.dueDate && p.note ? ' · ' : ''}{p.note ?? ''}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatInr(p.amount)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-status-success">{p.received ? formatInr(p.received) : '—'}</td>
                    <td className={`px-3 py-2.5 text-right tabular-nums font-medium ${p.balance > 0 ? 'text-primary' : 'text-muted'}`}>{formatInr(Math.max(0, p.balance))}</td>
                    <td className="px-3 py-2.5"><span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${STATUS_STYLE[p.status]}`}>{STATUS_TEXT[p.status]}</span></td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <button type="button" disabled={i === 0} onClick={() => void move(p, -1)} aria-label={`Move ${p.name} up`} className="text-xs text-muted hover:text-primary px-1 disabled:opacity-30">Up</button>
                      <button type="button" disabled={i === activePhases.length - 1} onClick={() => void move(p, 1)} aria-label={`Move ${p.name} down`} className="text-xs text-muted hover:text-primary px-1 disabled:opacity-30">Down</button>
                      <button type="button" onClick={() => setDialog({ kind: 'phase', phase: p })} className="text-xs text-secondary hover:text-primary px-2">Edit</button>
                      {p.received === 0 && <button type="button" onClick={() => void archive(p, false)} className="text-xs text-secondary hover:text-status-danger px-1">Archive</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {archived.length > 0 && (
          <div className="border-t border-border-default px-4 py-2">
            <button type="button" onClick={() => setShowArchived((v) => !v)} className="text-xs text-muted hover:text-primary">{showArchived ? 'Hide' : 'Show'} {archived.length} archived</button>
            {showArchived && archived.map((p) => (
              <div key={p.id} className="flex items-center justify-between text-sm text-muted py-1">
                <span>{p.name}, {formatInr(p.amount)}</span>
                <button type="button" onClick={() => void archive(p, true)} className="text-xs text-secondary hover:text-primary">Restore</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Receipts */}
      <section className="rounded-xl border border-border-default overflow-hidden">
        <header className="flex items-center justify-between px-4 py-3 bg-surface-raised/60">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-primary">Payments received</h3>
          <span className="text-xs text-muted">{countLabel(summary.receipts.filter((r) => !r.reversed).length, "payment")}{summary.receipts.some((r) => r.reversed) ? `, ${summary.receipts.filter((r) => r.reversed).length} reversed` : ""}</span>
        </header>
        {summary.receipts.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-secondary border-t border-border-default">No payments recorded yet.</p>
        ) : (
          <ul>
            {summary.receipts.map((r) => (
              <li key={r.id} className={`border-t border-border-default px-4 py-3 ${r.reversed ? 'opacity-60' : ''}`}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className={`text-base font-semibold tabular-nums ${r.reversed ? 'line-through text-muted' : 'text-primary'}`}>{formatInr(r.amount)}</span>
                  <span className="text-sm text-secondary">{showDate(r.receivedOn)} · {modeLabel(r.mode)}{r.reference ? ` · ${r.reference}` : ''}{r.payer ? ` · from ${r.payer}` : ''}</span>
                  <span className="ml-auto flex gap-1">
                    {!r.reversed && r.onAccount > 0 && activePhases.some((p) => p.balance > 0) && (
                      <button type="button" onClick={() => setDialog({ kind: 'allocate', receipt: r })} className="text-xs font-medium text-accent hover:underline px-2">Count against a phase</button>
                    )}
                    {!r.reversed && <button type="button" onClick={() => setDialog({ kind: 'reverse', receipt: r })} className="text-xs text-secondary hover:text-status-danger px-2">Reverse</button>}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                  {r.allocations.map((a) => (
                    <span key={a.id} className="px-2 py-0.5 rounded-full bg-surface-sunken text-secondary">{a.phaseName}: {formatInr(a.amount)}</span>
                  ))}
                  {!r.reversed && r.onAccount > 0 && <span className="px-2 py-0.5 rounded-full bg-status-warning/15 text-status-warning">On account: {formatInr(r.onAccount)}</span>}
                </div>
                <p className="mt-1 text-[11px] text-muted">
                  Recorded by {r.createdByName}, {showWhen(r.createdAt)}{r.note ? ` · ${r.note}` : ''}
                  {r.reversed && <span className="text-status-danger"> · Reversed by {r.reversed.byName}, {showWhen(r.reversed.at)}: {r.reversed.reason}</span>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Fee history */}
      <section className="rounded-xl border border-border-default overflow-hidden">
        <header className="px-4 py-3 bg-surface-raised/60"><h3 className="text-sm font-semibold uppercase tracking-wide text-primary">Fee</h3></header>
        <ul>
          {summary.fee.changes.map((c) => (
            <li key={c.id} className="border-t border-border-default px-4 py-2.5 flex flex-wrap items-baseline gap-x-3">
              <span className="text-sm text-primary">{FEE_CHANGE_LABELS[c.kind]}</span>
              <span className={`text-sm tabular-nums font-medium ${c.amountDelta < 0 ? 'text-status-danger' : 'text-primary'}`}>{c.kind === 'INITIAL' ? '' : c.amountDelta > 0 ? '+' : '−'}{formatInr(Math.abs(c.amountDelta))}</span>
              {c.estimatedCost !== null && <span className="text-xs text-muted">cost estimate {formatInr(c.estimatedCost)}</span>}
              <span className="text-xs text-muted ml-auto">{c.createdByName}, {showWhen(c.createdAt)}</span>
              {c.kind !== 'INITIAL' && <span className="w-full text-xs text-secondary">{c.reason}</span>}
            </li>
          ))}
          <li className="border-t border-border-default px-4 py-2.5 flex items-baseline justify-between bg-surface-raised/30">
            <span className="text-sm font-semibold text-primary">Current fee</span>
            <span className="text-sm font-semibold tabular-nums text-primary">{formatInr(t.fee)}</span>
          </li>
        </ul>
      </section>

      {/* History */}
      <section>
        <button type="button" onClick={() => setShowHistory((v) => !v)} className="text-xs text-muted hover:text-primary">
          {showHistory ? 'Hide' : 'Show'} full history ({summary.history.length})
        </button>
        {showHistory && (
          <ul className="mt-2 rounded-xl border border-border-default divide-y divide-border-default">
            {summary.history.map((h) => (
              <li key={h.id} className="px-4 py-2 text-sm flex flex-wrap gap-x-3">
                <span className="text-primary flex-1 min-w-[16rem]">{h.summary}</span>
                <span className="text-xs text-muted">{h.userName}, {showWhen(h.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dialog?.kind === 'record' && <RecordPaymentModal projectId={projectId} summary={summary} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'phase' && <PhaseModal projectId={projectId} summary={summary} phase={dialog.phase} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'fee' && <FeeChangeModal projectId={projectId} summary={summary} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'reverse' && <ReverseModal projectId={projectId} receipt={dialog.receipt} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'allocate' && <AllocateModal projectId={projectId} summary={summary} receipt={dialog.receipt} onClose={() => setDialog(null)} onSaved={saved} />}
    </div>
  )
}

function countLabel(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}
