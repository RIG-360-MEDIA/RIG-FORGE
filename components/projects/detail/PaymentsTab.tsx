'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ApiResponse } from '@/lib/types'
import {
  FEE_CHANGE_LABELS, PAYMENT_MODES, STANDARD_SQFT_SCHEDULE, amountForArea, areaToCenti, formatArea, formatInr, formatPercentBp,
  gstOn, paiseToRupeesText, rupeesToPaise,
  type FeeBasis, type PaymentMode, type PaymentsSummary, type PhaseView, type ReceiptView,
} from '@/lib/payment-types'

// A project's payments: the agreed fee and its changes, the billing phases,
// every payment received and what it paid for. ADMIN and SUPER_ADMIN only
// (the page shows this tab only to them, and every API refuses anyone else).
// Nothing here is a typed-in total: received, balances and on-account are
// calculated from the receipts, which are never edited (only reversed).

export const field = 'w-full bg-background-primary border border-border-default rounded px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-accent [color-scheme:light]'
export const label = 'flex flex-col gap-1 text-[11px] font-medium text-muted uppercase tracking-wider'
export const primaryBtn = 'px-4 py-2 text-sm font-semibold rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50'
export const ghostBtn = 'px-3 py-2 text-sm text-secondary hover:text-primary'

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

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
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

export function ErrorLine({ text }: { text: string | null }) {
  return text ? <div className="text-sm text-status-danger bg-status-danger/10 border border-status-danger/30 rounded px-3 py-2">{text}</div> : null
}

const STATUS_STYLE: Record<PhaseView['status'], string> = {
  PAID: 'bg-status-success/15 text-status-success',
  PART_PAID: 'bg-status-warning/15 text-status-warning',
  UNPAID: 'bg-surface-sunken text-secondary',
}
const STATUS_TEXT: Record<PhaseView['status'], string> = { PAID: 'Paid', PART_PAID: 'Part paid', UNPAID: 'Not paid' }

// ─── Setup ────────────────────────────────────────────────────────────────────

interface SetupRow { key: string; group: string; name: string; rate: string; on: boolean; custom?: boolean }

const BASIS_LABEL: Record<FeeBasis, string> = { PER_SQFT: 'Rate per sq ft', FIXED: 'Fixed fee', PERCENT: '% of construction cost' }

/** Acres ("1.5") x rupees per acre, in paise, or null. */
function landscapeAmount(acres: string, ratePerAcre: string): number | null {
  const m = acres.trim().match(/^(\d{1,5})(?:\.(\d{1,2}))?$/)
  const rate = rupeesToPaise(ratePerAcre)
  if (!m || rate === null) return null
  const hundredths = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0')
  const v = Math.floor((rate * hundredths + 50) / 100)
  return v > 0 ? v : null
}

function SetupCard({ projectId, onDone }: { projectId: string; onDone: (s: PaymentsSummary) => void }) {
  const [basis, setBasis] = useState<FeeBasis>('PER_SQFT')
  const [gst, setGst] = useState('18')
  const [fee, setFee] = useState('')
  const [cost, setCost] = useState('')
  const [percent, setPercent] = useState('')
  const [area, setArea] = useState('')
  const [rows, setRows] = useState<SetupRow[]>(() => STANDARD_SQFT_SCHEDULE.map((s, i) => ({ key: `s${i}`, group: s.group, name: s.name, rate: String(s.rate), on: true })))
  const [landscape, setLandscape] = useState(false)
  const [acres, setAcres] = useState('')
  const [perAcre, setPerAcre] = useState('3,00,000')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const gstBp = (() => { const v = Number(gst.replace('%', '')); return gst.trim() === '' ? 0 : v >= 0 && v <= 100 ? Math.round(v * 100) : null })()
  const areaCenti = areaToCenti(area)
  const used = rows.filter((r) => r.on)
  const badRow = used.some((r) => !r.name.trim() || (rupeesToPaise(r.rate) ?? 0) <= 0)
  const ratePaise = used.reduce((s, r) => s + (rupeesToPaise(r.rate) ?? 0), 0)
  const landPaise = landscape ? landscapeAmount(acres, perAcre) : 0
  const sqftFee = areaCenti === null || badRow ? null : used.reduce((s, r) => s + amountForArea(rupeesToPaise(r.rate) ?? 0, areaCenti), 0)

  const costPaise = rupeesToPaise(cost)
  const pct = Number(percent)
  const preview = basis === 'PER_SQFT'
    ? (sqftFee === null || landPaise === null || (sqftFee + landPaise) <= 0 ? null : sqftFee + landPaise)
    : basis === 'FIXED' ? rupeesToPaise(fee)
      : costPaise !== null && pct > 0 && pct <= 100 ? Math.round(costPaise * pct / 100) : null
  const groups = [...new Set(rows.map((r) => r.group))]

  function setRow(key: string, patch: Partial<SetupRow>) { setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r))) }
  function setGroup(group: string, on: boolean) { setRows((rs) => rs.map((r) => (r.group === group ? { ...r, on } : r))) }
  function addRow() { setRows((rs) => [...rs, { key: `c${Date.now()}`, group: 'Other', name: '', rate: '', on: true, custom: true }]) }

  async function save() {
    setBusy(true); setError(null)
    const body = basis === 'PER_SQFT'
      ? {
          basis, area, gstPercent: gst,
          stages: [
            ...used.map((r) => ({ group: r.group, name: r.name, rate: r.rate })),
            ...(landscape && landPaise ? [{ group: 'Landscape', name: `Landscape design (${acres} acre${acres === '1' ? '' : 's'} at ₹${perAcre} per acre)`, amount: paiseToRupeesText(landPaise) }] : []),
          ],
        }
      : basis === 'FIXED' ? { basis, fee, gstPercent: gst } : { basis, estimatedCost: cost, percent, gstPercent: gst }
    const r = await send(`/api/projects/${projectId}/payments`, 'POST', body)
    setBusy(false)
    if (r.error) { setError(r.error); return }
    if (r.data) onDone(r.data)
  }

  return (
    <div className="rounded-xl border border-border-default bg-surface-raised/40 p-6 space-y-4 max-w-3xl">
      <div>
        <h3 className="text-base font-semibold text-primary">Set up this project&apos;s fee</h3>
        <p className="text-sm text-secondary mt-1">Done once. Later changes (a new area, extra work) are added with a reason, so the history always shows how the fee came about.</p>
      </div>
      <div role="radiogroup" aria-label="How the fee is set" className="inline-flex flex-wrap rounded-lg border border-border-default p-0.5">
        {(['PER_SQFT', 'FIXED', 'PERCENT'] as FeeBasis[]).map((b) => (
          <button key={b} type="button" role="radio" aria-checked={basis === b} onClick={() => setBasis(b)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${basis === b ? 'bg-accent text-white' : 'text-secondary hover:text-primary'}`}>
            {BASIS_LABEL[b]}
          </button>
        ))}
      </div>

      {basis === 'PER_SQFT' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 max-w-md">
            <label className={label}>Built-up area (sq ft)<input inputMode="decimal" value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. 12,500" className={field} /></label>
            <label className={label}>GST (%)<input inputMode="decimal" value={gst} onChange={(e) => setGst(e.target.value)} className={field} /></label>
          </div>
          <div className="rounded-lg border border-border-default">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border-default bg-surface-sunken/40 rounded-t-lg">
              <p className="text-xs font-semibold text-primary">Payment schedule (₹ per sq ft)</p>
              <p className="text-xs text-muted">Trijya standard; change any rate, untick what is not in this job</p>
            </div>
            {groups.map((group) => {
              const inGroup = rows.filter((r) => r.group === group)
              const on = inGroup.some((r) => r.on)
              const sub = inGroup.filter((r) => r.on).reduce((s, r) => s + (rupeesToPaise(r.rate) ?? 0), 0)
              return (
                <div key={group} className="border-b border-border-default last:border-b-0">
                  <label className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer">
                    <span className="flex items-center gap-2 text-sm font-medium text-primary">
                      <input type="checkbox" checked={on} onChange={(e) => setGroup(group, e.target.checked)} className="accent-accent" />
                      {group}
                    </span>
                    <span className="text-xs text-muted tabular-nums">{on ? `₹${paiseToRupeesText(sub)} / sq ft` : 'Not included'}</span>
                  </label>
                  {on && (
                    <ul className="pb-2">
                      {inGroup.map((r) => (
                        <li key={r.key} className={`flex items-center gap-2 pl-8 pr-3 py-1 ${r.on ? '' : 'opacity-50'}`}>
                          <input type="checkbox" checked={r.on} onChange={(e) => setRow(r.key, { on: e.target.checked })} aria-label={`Include ${r.name || 'stage'}`} className="accent-accent" />
                          {r.custom
                            ? <input value={r.name} onChange={(e) => setRow(r.key, { name: e.target.value })} placeholder="Stage name" maxLength={100} className={`${field} py-1`} />
                            : <span className="flex-1 min-w-0 text-sm text-secondary">{r.name}</span>}
                          <span className="w-24 shrink-0">
                            <input inputMode="decimal" value={r.rate} onChange={(e) => setRow(r.key, { rate: e.target.value })} aria-label={`Rate for ${r.name || 'stage'}`} className={`${field} py-1 text-right tabular-nums`} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            })}
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-t border-border-default">
              <button type="button" onClick={addRow} className="text-xs font-medium text-accent hover:underline">+ Add a stage</button>
              <span className="text-sm font-semibold text-primary tabular-nums">Total ₹{paiseToRupeesText(ratePaise)} per sq ft</span>
            </div>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-primary">
              <input type="checkbox" checked={landscape} onChange={(e) => setLandscape(e.target.checked)} className="accent-accent" />
              Landscape design, billed per acre
            </label>
            {landscape && (
              <div className="grid grid-cols-2 gap-3 max-w-md">
                <label className={label}>Acres<input inputMode="decimal" value={acres} onChange={(e) => setAcres(e.target.value)} placeholder="e.g. 2.5" className={field} /></label>
                <label className={label}>₹ per acre<input inputMode="decimal" value={perAcre} onChange={(e) => setPerAcre(e.target.value)} className={field} /></label>
              </div>
            )}
          </div>
        </div>
      )}
      {basis === 'FIXED' && (
        <div className="grid grid-cols-2 gap-3 max-w-md">
          <label className={label}>Agreed fee (₹)<input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="e.g. 15,00,000" className={field} /></label>
          <label className={label}>GST (%)<input inputMode="decimal" value={gst} onChange={(e) => setGst(e.target.value)} className={field} /></label>
        </div>
      )}
      {basis === 'PERCENT' && (
        <div className="grid grid-cols-3 gap-3">
          <label className={label}>Construction cost (₹)<input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="e.g. 2,00,00,000" className={field} /></label>
          <label className={label}>Fee (%)<input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="e.g. 7.5" className={field} /></label>
          <label className={label}>GST (%)<input inputMode="decimal" value={gst} onChange={(e) => setGst(e.target.value)} className={field} /></label>
        </div>
      )}

      <div className="rounded-lg bg-surface-sunken/50 px-4 py-3 text-sm text-secondary space-y-0.5">
        {preview !== null && preview > 0 && gstBp !== null ? (
          <>
            <p>Fee <span className="font-semibold text-primary tabular-nums">{formatInr(preview)}</span>
              {basis === 'PER_SQFT' && areaCenti !== null && <span className="text-muted"> (₹{paiseToRupeesText(ratePaise)} x {formatArea(areaCenti)}{landPaise ? ' + landscape' : ''})</span>}
            </p>
            {gstBp > 0 && <p>GST {formatPercentBp(gstBp)} <span className="tabular-nums">{formatInr(gstOn(preview, gstBp))}</span> · Client pays <span className="font-semibold text-primary tabular-nums">{formatInr(preview + gstOn(preview, gstBp))}</span></p>}
          </>
        ) : (
          <p>{basis === 'PER_SQFT' ? 'Enter the area to see the fee.' : 'Enter the fee to see the total.'}{gstBp === null ? ' The GST rate must be 0 to 100.' : ''}</p>
        )}
      </div>
      <ErrorLine text={error} />
      <button type="button" disabled={busy || preview === null || preview <= 0 || gstBp === null} onClick={() => void save()} className={primaryBtn}>
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


  if (open.length === 0) return <p className="text-sm text-muted">Every stage is fully paid, so this will be kept as an advance.</p>
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Which stage is it for?</p>
        <button type="button" onClick={() => { if (total !== null) onChange(splitInOrder(phases, total)) }} disabled={total === null} className="text-xs font-medium text-accent hover:underline disabled:opacity-40">Split in stage order</button>
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
                <span className="block text-[11px] text-muted truncate">{p.group ? `${p.group} · ` : ''}{formatInr(p.balance)} left to pay{p.gst > 0 ? ' incl. GST' : ''}</span>
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
          {left < 0 ? `${formatInr(-left)} more than the payment` : left > 0 ? `${formatInr(left)} will be kept as an advance (you can link it to a stage later)` : 'All of it goes to the stages above'}
        </p>
      )}
    </div>
  )
}

/** Fill the stages in schedule order with up to `total` paise. */
function splitInOrder(phases: PhaseView[], total: number): Record<string, string> {
  let rest = total
  const next: Record<string, string> = {}
  for (const p of phases.filter((x) => x.isActive && x.balance > 0)) {
    if (rest <= 0) break
    const take = Math.min(rest, p.balance)
    next[p.id] = paiseToRupeesText(take)
    rest -= take
  }
  return next
}

const allocationList = (values: Record<string, string>) =>
  Object.entries(values).filter(([, v]) => v.trim() && rupeesToPaise(v) !== 0).map(([phaseId, amount]) => ({ phaseId, amount }))

// ─── Record payment ───────────────────────────────────────────────────────────

function RecordPaymentModal({ projectId, summary, onClose, onSaved }: {
  projectId: string; summary: PaymentsSummary; onClose: () => void; onSaved: (s: PaymentsSummary, msg: string) => void
}) {
  const [receivedOn, setReceivedOn] = useState(todayText())
  const [amount, setAmount] = useState('')
  const [tds, setTds] = useState('')
  const [mode, setMode] = useState<PaymentMode>('BANK')
  const [reference, setReference] = useState('')
  const [payer, setPayer] = useState('')
  const [note, setNote] = useState('')
  const [alloc, setAlloc] = useState<Record<string, string>>({})
  const [splitByHand, setSplitByHand] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState<string | null>(null)

  const paise = rupeesToPaise(amount)
  const tdsPaise = tds.trim() ? rupeesToPaise(tds) : 0
  // Money plus TDS is what counts as paid, and what is split across stages.
  const credit = paise !== null && tdsPaise !== null ? paise + tdsPaise : null
  // Until the split is edited by hand, it follows the amount: oldest stage first.
  useEffect(() => {
    if (!splitByHand) setAlloc(credit !== null && credit > 0 ? splitInOrder(summary.phases, credit) : {})
  }, [credit, splitByHand, summary.phases])

  async function save(confirmDuplicate = false) {
    setBusy(true); setError(null)
    const r = await send(`/api/projects/${projectId}/payments/receipts`, 'POST', {
      receivedOn, amount, tds, mode, reference, payer, note, allocations: allocationList(alloc), confirmDuplicate,
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
        <label className={label}>TDS deducted by client (₹, optional)<input inputMode="decimal" value={tds} onChange={(e) => setTds(e.target.value)} placeholder="0" className={`${field} ${tdsPaise === null ? 'border-status-danger' : ''}`} /></label>
        <label className={label}>Received on<input type="date" value={receivedOn} max={todayText()} onChange={(e) => setReceivedOn(e.target.value)} className={field} /></label>
        <label className={label}>Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)} className={field}>
            {PAYMENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <label className={label}>Reference (UTR, cheque no.)<input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} className={field} /></label>
        <label className={label}>Received from<input value={payer} onChange={(e) => setPayer(e.target.value)} maxLength={100} placeholder="Client name" className={field} /></label>
        <label className={`${label} col-span-2`}>Note<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={field} /></label>
      </div>
      {tdsPaise !== null && tdsPaise > 0 && paise !== null && (
        <p className="text-xs text-secondary">TDS counts as paid: {formatInr(paise)} received + {formatInr(tdsPaise)} TDS = <span className="font-semibold text-primary">{formatInr(paise + tdsPaise)}</span> towards the stages.</p>
      )}
      <AllocationEditor phases={summary.phases} total={credit} values={alloc} onChange={(v) => { setSplitByHand(true); setAlloc(v) }} />
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
        <button type="button" disabled={busy || paise === null || paise <= 0 || tdsPaise === null || !!duplicate} onClick={() => void save()} className={primaryBtn}>
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
  const perSqft = summary.plan?.basis === 'PER_SQFT'
  const area = summary.plan?.areaCentiSqft ?? null
  const gstBp = summary.plan?.gstBp ?? 0
  const remaining = summary.totals.fee - summary.totals.phasesTotal
  const groups = [...new Set(summary.phases.map((p) => p.group).filter((g): g is string => !!g))]
  const [name, setName] = useState(phase?.name ?? '')
  const [group, setGroup] = useState(phase?.group ?? '')
  const [by, setBy] = useState<'amount' | 'percent' | 'rate'>(phase ? (phase.ratePerSqft !== null ? 'rate' : 'amount') : perSqft ? 'rate' : 'amount')
  const [amount, setAmount] = useState(phase ? paiseToRupeesText(phase.amount) : !perSqft && remaining > 0 ? paiseToRupeesText(remaining) : '')
  const [rate, setRate] = useState(phase?.ratePerSqft != null ? paiseToRupeesText(phase.ratePerSqft) : '')
  const [percent, setPercent] = useState('')
  const [dueDate, setDueDate] = useState(phase?.dueDate?.slice(0, 10) ?? '')
  const [note, setNote] = useState(phase?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pct = Number(percent)
  const ratePaise = rupeesToPaise(rate)
  const preview = by === 'rate'
    ? (ratePaise !== null && area !== null ? amountForArea(ratePaise, area) : null)
    : by === 'amount' ? rupeesToPaise(amount) : pct > 0 && pct <= 100 ? Math.round(summary.totals.fee * pct / 100) : null
  const ways = (perSqft ? ['rate', 'amount'] : ['amount', 'percent']) as ('amount' | 'percent' | 'rate')[]
  const wayText = { rate: '₹ per sq ft', amount: 'Fixed amount', percent: '% of fee' }

  async function save() {
    setBusy(true); setError(null)
    const value = by === 'rate' ? { rate } : by === 'amount' ? { amount } : { percent }
    const body = { name, group, ...value, dueDate: dueDate || null, note }
    const r = await send(phase ? `/api/projects/${projectId}/payments/phases/${phase.id}` : `/api/projects/${projectId}/payments/phases`, phase ? 'PATCH' : 'POST', body)
    setBusy(false)
    if (r.error) { setError(r.error); return }
    if (r.data) onSaved(r.data, phase ? `"${name}" saved.` : `Stage "${name}" added.`)
  }

  return (
    <Modal title={phase ? `Edit ${phase.name}` : 'Add a stage'} onClose={onClose}>
      <label className={label}>Stage name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder={perSqft ? 'e.g. Extra site visits (5 at ₹15,000)' : 'e.g. Working drawings'} className={field} /></label>
      <label className={label}>Group (optional)
        <input value={group} onChange={(e) => setGroup(e.target.value)} list="payment-groups" maxLength={60} placeholder="e.g. Architecture design" className={field} />
        <datalist id="payment-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
      </label>
      {!phase && (
        <div className="inline-flex rounded-lg border border-border-default p-0.5">
          {ways.map((b) => (
            <button key={b} type="button" onClick={() => setBy(b)} className={`px-3 py-1 text-xs font-medium rounded-md ${by === b ? 'bg-accent text-white' : 'text-secondary'}`}>
              {wayText[b]}
            </button>
          ))}
        </div>
      )}
      {by === 'rate' && <label className={label}>Rate (₹ per sq ft{area !== null ? `, x ${formatArea(area)}` : ''})<input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="e.g. 5" className={field} /></label>}
      {by === 'amount' && <label className={label}>Amount (₹, before GST)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={field} /></label>}
      {by === 'percent' && <label className={label}>Percentage of the fee ({formatInr(summary.totals.fee)})<input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="e.g. 25" className={field} /></label>}
      {phase && phase.received > 0 && <p className="text-xs text-muted">{formatInr(phase.received)} already paid for this stage; it cannot go below that.</p>}
      <p className="text-xs text-muted">
        Stage amount: <span className="text-primary font-medium">{preview !== null && preview > 0 ? formatInr(preview) : '—'}</span>
        {preview !== null && preview > 0 && gstBp > 0 && <> + GST {formatInr(gstOn(preview, gstBp))} = <span className="text-primary font-medium">{formatInr(preview + gstOn(preview, gstBp))}</span></>}
        {!phase && !perSqft && remaining !== 0 && <> · {remaining > 0 ? `${formatInr(remaining)} of the fee is not in any stage yet` : `stages are ${formatInr(-remaining)} over the fee`}</>}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label className={label}>Due date (optional)<input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={field} /></label>
        <label className={label}>Note (optional)<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={field} /></label>
      </div>
      <ErrorLine text={error} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
        <button type="button" disabled={busy || !name.trim() || preview === null || preview <= 0} onClick={() => void save()} className={primaryBtn}>
          {busy ? 'Saving...' : phase ? 'Save' : 'Add stage'}
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
  const perSqft = summary.plan?.basis === 'PER_SQFT'
  const [kind, setKind] = useState<'VARIATION' | 'CORRECTION' | 'COST_REVISION' | 'AREA_REVISION'>(perSqft ? 'AREA_REVISION' : isPercent ? 'COST_REVISION' : 'VARIATION')
  const [amount, setAmount] = useState('')
  const [cost, setCost] = useState(summary.fee.estimatedCost !== null ? paiseToRupeesText(summary.fee.estimatedCost) : '')
  const [area, setArea] = useState(summary.plan?.areaCentiSqft != null ? paiseToRupeesText(summary.plan.areaCentiSqft) : '')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const bp = summary.plan?.percentBp ?? 0
  const newArea = areaToCenti(area)
  const delta = kind === 'AREA_REVISION'
    ? (newArea === null ? null : summary.phases.filter((p) => p.isActive && p.ratePerSqft !== null).reduce((s, p) => s + amountForArea(p.ratePerSqft!, newArea) - p.amount, 0))
    : kind === 'COST_REVISION'
      ? (() => { const c = rupeesToPaise(cost); return c === null ? null : Math.round(c * bp / 10000) - Math.round((summary.fee.estimatedCost ?? 0) * bp / 10000) })()
      : rupeesToPaise(amount, { signed: true })

  async function save() {
    setBusy(true); setError(null)
    const r = await send(`/api/projects/${projectId}/payments/fee-changes`, 'POST',
      kind === 'AREA_REVISION' ? { kind, area, reason } : kind === 'COST_REVISION' ? { kind, estimatedCost: cost, reason } : { kind, amountDelta: amount, reason })
    setBusy(false)
    if (r.error) { setError(r.error); return }
    if (r.data) onSaved(r.data, `Fee is now ${formatInr(r.data.totals.fee)}.`)
  }

  if (perSqft) {
    return (
      <Modal title="Revise the area" onClose={onClose}>
        <p className="text-sm text-secondary">Every stage priced per sq ft is recalculated for the new area. The old area stays in the history. Fixed stages (landscape, extras) do not change.</p>
        <label className={label}>New built-up area (sq ft)<input autoFocus inputMode="decimal" value={area} onChange={(e) => setArea(e.target.value)} className={field} /></label>
        <label className={label}>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Final area from approved drawings" className={field} /></label>
        {delta !== null && delta !== 0 && (
          <p className="text-sm text-secondary">Fee {delta > 0 ? 'rises' : 'falls'} by {formatInr(Math.abs(delta))} to <span className="font-semibold text-primary">{formatInr(summary.totals.fee + delta)}</span> (before GST).</p>
        )}
        <ErrorLine text={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
          <button type="button" disabled={busy || newArea === null || newArea === summary.plan?.areaCentiSqft || reason.trim().length < 3} onClick={() => void save()} className={primaryBtn}>
            {busy ? 'Saving...' : 'Revise area'}
          </button>
        </div>
      </Modal>
    )
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
    if (r.data) onSaved(r.data, `Payment entry of ${formatInr(receipt.amount)} cancelled.`)
  }
  return (
    <Modal title="Cancel this payment entry" onClose={onClose}>
      <p className="text-sm text-secondary">
        {formatInr(receipt.amount)} received {showDate(receipt.receivedOn)} by {modeLabel(receipt.mode)}{receipt.reference ? ` (${receipt.reference})` : ''}.
        Use this if it was entered by mistake or the cheque bounced. The entry is kept, marked cancelled, and stops counting in every total. This cannot be undone; record it again if needed.
      </p>
      <label className={label}>Reason<input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Cheque bounced" className={field} /></label>
      <ErrorLine text={error} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={ghostBtn}>Keep it</button>
        <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void save()} className="px-4 py-2 text-sm font-semibold rounded bg-status-danger text-white disabled:opacity-50">
          {busy ? 'Cancelling...' : 'Cancel entry'}
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
    if (r.data) onSaved(r.data, 'Advance linked to stages.')
  }
  return (
    <Modal title="Link the advance to stages" onClose={onClose} wide>
      <p className="text-sm text-secondary">From the {formatInr(receipt.amount)} received {showDate(receipt.receivedOn)}: <span className="font-semibold text-primary">{formatInr(receipt.onAccount)}</span> is an advance, not linked to any stage yet.</p>
      <AllocationEditor phases={summary.phases} total={receipt.onAccount} values={alloc} onChange={setAlloc} />
      <ErrorLine text={error} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
        <button type="button" disabled={busy || list.length === 0} onClick={() => void save()} className={primaryBtn}>{busy ? 'Saving...' : 'Save'}</button>
      </div>
    </Modal>
  )
}

// ─── Row menu ─────────────────────────────────────────────────────────────────

type MenuItem = { text: string; onClick: () => void; danger?: boolean; hidden?: boolean }

function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])
  const shown = items.filter((i) => !i.hidden)
  if (shown.length === 0) return <span className="w-8 shrink-0" />
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        className="h-8 w-8 rounded text-lg leading-none text-muted hover:text-primary hover:bg-surface-sunken"
      >
        ⋯
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-9 z-20 min-w-[12rem] rounded-lg border border-border-default bg-surface-raised py-1 shadow-lg">
          {shown.map((i) => (
            <button
              key={i.text} type="button" role="menuitem"
              onClick={(e) => { e.stopPropagation(); setOpen(false); i.onClick() }}
              className={`block w-full px-3 py-2 text-left text-sm hover:bg-surface-sunken ${i.danger ? 'text-status-danger' : 'text-primary'}`}
            >
              {i.text}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Fee details ──────────────────────────────────────────────────────────────

function FeeDetailsModal({ summary, onClose, onChange }: { summary: PaymentsSummary; onClose: () => void; onChange: () => void }) {
  const perSqft = summary.plan?.basis === 'PER_SQFT'
  const t = summary.totals
  return (
    <Modal title="Fee details" onClose={onClose}>
      <p className="text-sm text-secondary">{feeBasisText(summary)}{summary.plan?.gstBp ? `, plus GST ${formatPercentBp(summary.plan.gstBp)}` : ', no GST'}</p>
      <ul className="rounded-lg border border-border-default divide-y divide-border-default">
        {summary.fee.changes.map((c) => (
          <li key={c.id} className="px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-primary">{c.kind === 'INITIAL' ? 'Agreed fee' : FEE_CHANGE_LABELS[c.kind]}</span>
              <span className={`text-sm font-medium tabular-nums ${c.amountDelta < 0 ? 'text-status-danger' : 'text-primary'}`}>
                {c.kind === 'INITIAL' ? '' : c.amountDelta > 0 ? '+' : '−'}{formatInr(Math.abs(c.amountDelta))}
              </span>
            </div>
            <p className="text-xs text-muted">
              {c.kind !== 'INITIAL' && c.reason ? `${c.reason} · ` : ''}
              {c.estimatedCost !== null ? `cost estimate ${formatInr(c.estimatedCost)} · ` : ''}
              {c.areaCentiSqft !== null ? `area ${formatArea(c.areaCentiSqft)} · ` : ''}
              {c.createdByName}, {showWhen(c.createdAt)}
            </p>
          </li>
        ))}
        {perSqft && t.fee !== summary.fee.current && (
          <li className="flex items-baseline justify-between px-3 py-2.5">
            <span className="text-sm text-primary">Stages added or changed since</span>
            <span className="text-sm font-medium tabular-nums text-primary">{t.fee - summary.fee.current > 0 ? '+' : '−'}{formatInr(Math.abs(t.fee - summary.fee.current))}</span>
          </li>
        )}
        <li className="flex items-baseline justify-between px-3 py-2.5 bg-surface-sunken/50">
          <span className="text-sm font-semibold text-primary">Fee now</span>
          <span className="text-sm font-semibold tabular-nums text-primary">{formatInr(t.fee)}</span>
        </li>
        {t.gst > 0 && (
          <li className="flex items-baseline justify-between px-3 py-2.5 bg-surface-sunken/50">
            <span className="text-sm text-primary">+ GST {formatPercentBp(summary.plan?.gstBp ?? 0)} · client pays</span>
            <span className="text-sm font-semibold tabular-nums text-primary">{formatInr(t.gst)} · {formatInr(t.payable)}</span>
          </li>
        )}
      </ul>
      <p className="text-xs text-muted">
        {perSqft
          ? 'The agreed area is never overwritten. A new area is added with its reason, and every stage priced per sq ft follows it.'
          : 'The agreed fee is never overwritten. A change is added with its reason, so you can always see how the fee came about.'}
      </p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={ghostBtn}>Close</button>
        <button type="button" onClick={onChange} className={primaryBtn}>{perSqft ? 'Revise the area' : 'Change the fee'}</button>
      </div>
    </Modal>
  )
}

function feeBasisText(s: PaymentsSummary): string {
  if (s.plan?.basis === 'PER_SQFT' && s.plan.areaCentiSqft !== null) {
    const fixed = s.phases.filter((p) => p.isActive && p.ratePerSqft === null).reduce((t, p) => t + p.amount, 0)
    return `₹${paiseToRupeesText(s.plan.ratePerSqft ?? 0)} per sq ft x ${formatArea(s.plan.areaCentiSqft)}${fixed > 0 ? ` + ${formatInr(fixed)} fixed (landscape, extras)` : ''}`
  }
  if (s.plan?.basis === 'PERCENT' && s.plan.percentBp !== null && s.fee.estimatedCost !== null) {
    return `${formatPercentBp(s.plan.percentBp)} of ${formatInr(s.fee.estimatedCost)} construction cost`
  }
  return 'Fixed fee'
}

// ─── Main ─────────────────────────────────────────────────────────────────────

type Dialog =
  | { kind: 'record' } | { kind: 'phase'; phase: PhaseView | null } | { kind: 'fee' } | { kind: 'feeDetails' }
  | { kind: 'reverse'; receipt: ReceiptView } | { kind: 'allocate'; receipt: ReceiptView } | null

function PhaseStatusPill({ phase }: { phase: PhaseView }) {
  const [text, style] = phase.overdue
    ? ['Overdue', 'bg-status-danger/15 text-status-danger']
    : [STATUS_TEXT[phase.status], STATUS_STYLE[phase.status]]
  return <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase whitespace-nowrap ${style}`}>{text}</span>
}

function Bar({ value, total, className = 'h-1.5' }: { value: number; total: number; className?: string }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0
  return (
    <div className={`${className} rounded-full bg-surface-sunken overflow-hidden`}>
      <div className="h-full rounded-full bg-status-success" style={{ width: `${pct}%` }} />
    </div>
  )
}

export default function PaymentsTab({ projectId }: { projectId: string }) {
  const [summary, setSummary] = useState<PaymentsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [openPhase, setOpenPhase] = useState<string | null>(null)
  const [showRemoved, setShowRemoved] = useState(false)
  const [showCancelled, setShowCancelled] = useState(false)
  const [showLog, setShowLog] = useState(false)

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
    else if (r.data) saved(r.data, isActive ? `"${phase.name}" is back in the schedule.` : `"${phase.name}" removed from the schedule.`)
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
  const removedPhases = useMemo(() => summary?.phases.filter((p) => !p.isActive) ?? [], [summary])
  const liveReceipts = useMemo(() => summary?.receipts.filter((r) => !r.reversed) ?? [], [summary])
  const cancelled = useMemo(() => summary?.receipts.filter((r) => r.reversed) ?? [], [summary])
  // Which payments paid each phase, for the phase's expanded view.
  const paidInto = useMemo(() => {
    const m = new Map<string, { receipt: ReceiptView; amount: number }[]>()
    for (const r of liveReceipts) for (const a of r.allocations) m.set(a.phaseId, [...(m.get(a.phaseId) ?? []), { receipt: r, amount: a.amount }])
    return m
  }, [liveReceipts])

  if (loading) return <div className="space-y-3">{[...Array(3)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-surface-raised animate-pulse" />)}</div>
  if (!summary) return <ErrorLine text={error ?? 'Could not load payments.'} />

  if (!summary.plan) {
    return (
      <div className="space-y-4 pt-1">
        <div>
          <h2 className="text-base font-semibold text-primary">Payments</h2>
          <p className="text-sm text-secondary mt-0.5">Only admins can see this.</p>
        </div>
        <SetupCard projectId={projectId} onDone={(s) => saved(s, 'Fee set up. Now add the payment schedule.')} />
      </div>
    )
  }

  const t = summary.totals
  const perSqft = summary.plan.basis === 'PER_SQFT'
  const nextDue = activePhases.find((p) => p.balance > 0) ?? null
  const unscheduled = perSqft ? 0 : t.fee - t.phasesTotal
  // Subtotal (incl. GST) for each discipline, shown above its first stage.
  const groupTotal = new Map<string, number>()
  for (const p of activePhases) if (p.group) groupTotal.set(p.group, (groupTotal.get(p.group) ?? 0) + p.gross)
  const advanceReceipt = liveReceipts.slice().reverse().find((r) => r.onAccount > 0) ?? null
  const canLink = activePhases.some((p) => p.balance > 0)
  const feeChanges = summary.fee.changes.length - 1

  return (
    <div className="space-y-5 pt-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-primary">Payments</h2>
          <p className="text-xs text-muted mt-0.5">Only admins can see this.</p>
        </div>
        <button type="button" onClick={() => setDialog({ kind: 'record' })} className={primaryBtn}>Record payment</button>
      </div>

      {notice && <div role="status" className="text-sm text-status-success bg-status-success/10 border border-status-success/30 rounded-lg px-3 py-2">{notice}</div>}
      <ErrorLine text={error} />

      {/* 1. Where things stand */}
      <section className="rounded-xl border border-border-default bg-surface-raised/50 p-5 space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Paid</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-primary">
              {formatInr(t.credited)} <span className="text-base font-normal text-secondary">of {formatInr(t.payable)}</span>
            </p>
            <p className="text-xs text-muted">
              {t.gst > 0 ? `Fee ${formatInr(t.fee)} + GST ${formatInr(t.gst)}` : `Fee ${formatInr(t.fee)}, no GST`}
              {t.tds > 0 ? ` · paid includes ${formatInr(t.tds)} TDS deducted by the client` : ''}
            </p>
          </div>
          <div className="sm:text-right">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted">{t.outstanding < 0 ? 'Paid over the total' : 'Left to receive'}</p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${t.outstanding > 0 ? 'text-status-warning' : t.outstanding < 0 ? 'text-status-danger' : 'text-status-success'}`}>
              {formatInr(Math.abs(t.outstanding))}
            </p>
          </div>
        </div>
        <Bar value={t.credited} total={t.payable} className="h-2" />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-secondary">
          <span>
            Fee: {feeBasisText(summary)}{feeChanges > 0 ? `, changed ${feeChanges === 1 ? 'once' : `${feeChanges} times`}` : ''}
            {' · '}
            <button type="button" onClick={() => setDialog({ kind: 'feeDetails' })} className="font-medium text-accent hover:underline">Fee details</button>
          </span>
          {nextDue ? (
            <span className={nextDue.overdue ? 'text-status-danger' : ''}>
              Next: <span className="font-medium">{nextDue.name}</span>, {formatInr(nextDue.balance)}
              {nextDue.dueDate ? ` ${nextDue.overdue ? 'overdue since' : 'due'} ${showDate(nextDue.dueDate)}` : ''}
            </span>
          ) : activePhases.length > 0 && t.outstanding <= 0 ? <span className="text-status-success">Fully paid</span> : null}
        </div>
      </section>

      {/* Advance: money received that is not linked to a phase yet */}
      {t.onAccount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-status-warning/40 bg-status-warning/10 px-4 py-2.5 text-sm">
          <span className="text-primary"><span className="font-semibold">{formatInr(t.onAccount)}</span> received as an advance, not linked to any stage yet.</span>
          {advanceReceipt && canLink && (
            <button type="button" onClick={() => setDialog({ kind: 'allocate', receipt: advanceReceipt })} className="text-xs font-semibold text-accent hover:underline">Link it to a stage</button>
          )}
        </div>
      )}

      {/* 2. Payment schedule */}
      <section className="rounded-xl border border-border-default">
        <header className="flex items-center justify-between px-4 py-3 bg-surface-raised/60 rounded-t-xl">
          <div>
            <h3 className="text-sm font-semibold text-primary">Payment schedule</h3>
            <p className="text-xs text-muted">The stages the client pays for. Click a stage to see what paid it.</p>
          </div>
          <button type="button" onClick={() => setDialog({ kind: 'phase', phase: null })} className="px-3 py-1.5 text-xs font-medium rounded border border-border-default text-primary hover:border-accent whitespace-nowrap">+ Add stage</button>
        </header>
        {activePhases.length === 0 ? (
          <div className="px-4 py-6 text-center border-t border-border-default">
            <p className="text-sm text-secondary">No stages yet. Split the fee into the stages you bill the client for, e.g. Concept, Drawings, Site.</p>
            <button type="button" onClick={() => setDialog({ kind: 'phase', phase: null })} className={`mt-3 ${primaryBtn}`}>Add the first stage</button>
          </div>
        ) : (
          <ul>
            {activePhases.map((p, i) => {
              const open = openPhase === p.id
              const paid = paidInto.get(p.id) ?? []
              const groupStart = !!p.group && p.group !== activePhases[i - 1]?.group
              return (
                <li key={p.id} className="border-t border-border-default">
                  {groupStart && (
                    <div className="flex items-baseline justify-between px-4 pt-3 pb-1 bg-surface-sunken/30">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-accent">{p.group}</span>
                      <span className="text-xs text-muted tabular-nums pr-11">{formatInr(groupTotal.get(p.group!) ?? 0)}</span>
                    </div>
                  )}
                  <div
                    role="button" tabIndex={0} aria-expanded={open}
                    onClick={() => setOpenPhase(open ? null : p.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenPhase(open ? null : p.id) } }}
                    className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-surface-raised/40"
                  >
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2 min-w-0">
                          <span className="text-sm font-medium text-primary">{i + 1}. {p.name}</span>
                          <PhaseStatusPill phase={p} />
                        </div>
                        <span className="text-right whitespace-nowrap">
                          <span className="block text-sm font-semibold tabular-nums text-primary">{formatInr(p.gross)}</span>
                          {p.gst > 0 && <span className="block text-[11px] text-muted tabular-nums">{formatInr(p.amount)} + GST</span>}
                        </span>
                      </div>
                      <Bar value={p.received} total={p.gross} />
                      <p className="text-xs text-muted">
                        {p.ratePerSqft !== null ? `₹${paiseToRupeesText(p.ratePerSqft)} per sq ft · ` : ''}
                        {p.balance <= 0 ? 'Fully paid' : p.received > 0 ? `${formatInr(p.received)} paid, ${formatInr(p.balance)} left` : 'Nothing paid yet'}
                        {p.dueDate && p.balance > 0 ? ` · ${p.overdue ? 'overdue since' : 'due'} ${showDate(p.dueDate)}` : ''}
                        {p.note ? ` · ${p.note}` : ''}
                      </p>
                    </div>
                    <RowMenu label={`More for ${p.name}`} items={[
                      { text: 'Edit stage', onClick: () => setDialog({ kind: 'phase', phase: p }) },
                      { text: 'Move up', onClick: () => void move(p, -1), hidden: i === 0 },
                      { text: 'Move down', onClick: () => void move(p, 1), hidden: i === activePhases.length - 1 },
                      { text: 'Remove from schedule', onClick: () => void archive(p, false), danger: true, hidden: p.received > 0 },
                    ]} />
                  </div>
                  {open && (
                    <div className="px-4 pb-3 -mt-1">
                      {paid.length === 0 ? (
                        <p className="text-xs text-muted pl-4">No payments linked to this stage yet.</p>
                      ) : (
                        <ul className="ml-4 border-l-2 border-border-default pl-3 space-y-1">
                          {paid.map(({ receipt, amount }) => (
                            <li key={receipt.id} className="text-xs text-secondary">
                              <span className="font-medium tabular-nums text-primary">{formatInr(amount)}</span>
                              {' '}from the {formatInr(receipt.amount)} received {showDate(receipt.receivedOn)}, {modeLabel(receipt.mode)}{receipt.reference ? ` ${receipt.reference}` : ''}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {activePhases.length > 0 && unscheduled !== 0 && (
          <p className="border-t border-border-default px-4 py-2.5 text-xs text-status-warning bg-status-warning/10 last:rounded-b-xl">
            {unscheduled > 0
              ? `${formatInr(unscheduled)} of the fee is not in any stage yet. Add a stage or raise one so the whole fee is billed.`
              : `The stages add up to ${formatInr(-unscheduled)} more than the fee. Lower a stage, or change the fee.`}
          </p>
        )}
        {removedPhases.length > 0 && (
          <div className="border-t border-border-default px-4 py-2">
            <button type="button" onClick={() => setShowRemoved((v) => !v)} className="text-xs text-muted hover:text-primary">
              {showRemoved ? 'Hide' : 'Show'} {countLabel(removedPhases.length, 'removed stage')}
            </button>
            {showRemoved && removedPhases.map((p) => (
              <div key={p.id} className="flex items-center justify-between text-sm text-muted py-1">
                <span>{p.name}, {formatInr(p.amount)}</span>
                <button type="button" onClick={() => void archive(p, true)} className="text-xs text-secondary hover:text-primary">Put back</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 3. Payments received */}
      <section className="rounded-xl border border-border-default">
        <header className="px-4 py-3 bg-surface-raised/60 rounded-t-xl">
          <h3 className="text-sm font-semibold text-primary">Payments received</h3>
          <p className="text-xs text-muted">Every payment from the client, newest first, and the stages it paid for.</p>
        </header>
        {liveReceipts.length === 0 ? (
          <div className="px-4 py-6 text-center border-t border-border-default">
            <p className="text-sm text-secondary">No payments recorded yet.</p>
          </div>
        ) : (
          <ul>
            {liveReceipts.map((r) => (
              <li key={r.id} className="flex items-start gap-3 border-t border-border-default px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="text-sm font-semibold tabular-nums text-primary">{formatInr(r.amount)}</span>
                    {r.tds > 0 && <span className="text-xs font-medium text-secondary tabular-nums">+ TDS {formatInr(r.tds)}</span>}
                    <span className="text-xs text-secondary">{showDate(r.receivedOn)} · {modeLabel(r.mode)}{r.reference ? ` ${r.reference}` : ''}{r.payer ? ` · from ${r.payer}` : ''}</span>
                  </div>
                  <p className="mt-1 text-xs text-secondary">
                    For:{' '}
                    {r.allocations.length === 0 && r.onAccount === 0 ? '—' : null}
                    {r.allocations.map((a, i) => (
                      <span key={a.id}>{i > 0 ? ', ' : ''}{a.phaseName} <span className="tabular-nums">{formatInr(a.amount)}</span></span>
                    ))}
                    {r.onAccount > 0 && (
                      <span className="text-status-warning">{r.allocations.length > 0 ? ', ' : ''}advance <span className="tabular-nums">{formatInr(r.onAccount)}</span></span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted">Entered by {r.createdByName}, {showWhen(r.createdAt)}{r.note ? ` · ${r.note}` : ''}</p>
                </div>
                <RowMenu label={`More for the payment of ${formatInr(r.amount)}`} items={[
                  { text: 'Link advance to a stage', onClick: () => setDialog({ kind: 'allocate', receipt: r }), hidden: !(r.onAccount > 0 && canLink) },
                  { text: 'Cancel this entry', onClick: () => setDialog({ kind: 'reverse', receipt: r }), danger: true },
                ]} />
              </li>
            ))}
          </ul>
        )}
        {cancelled.length > 0 && (
          <div className="border-t border-border-default px-4 py-2">
            <button type="button" onClick={() => setShowCancelled((v) => !v)} className="text-xs text-muted hover:text-primary">
              {showCancelled ? 'Hide' : 'Show'} {cancelled.length} cancelled {cancelled.length === 1 ? 'entry' : 'entries'}
            </button>
            {showCancelled && (
              <ul className="mt-1 space-y-2 pb-1">
                {cancelled.map((r) => (
                  <li key={r.id} className="text-xs text-muted">
                    <span className="line-through tabular-nums">{formatInr(r.amount)}</span> {showDate(r.receivedOn)} · {modeLabel(r.mode)}{r.reference ? ` ${r.reference}` : ''}
                    <span className="block">Cancelled by {r.reversed?.byName}, {r.reversed ? showWhen(r.reversed.at) : ''}: {r.reversed?.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* 4. Activity log */}
      <section>
        <button type="button" onClick={() => setShowLog((v) => !v)} className="text-xs text-muted hover:text-primary">
          {showLog ? 'Hide' : 'Show'} activity log ({summary.history.length})
        </button>
        {showLog && (
          <ul className="mt-2 rounded-xl border border-border-default divide-y divide-border-default">
            {summary.history.map((h) => (
              <li key={h.id} className="px-4 py-2 text-sm flex flex-wrap gap-x-3">
                <span className="text-primary flex-1 min-w-[14rem]">{h.summary}</span>
                <span className="text-xs text-muted">{h.userName}, {showWhen(h.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dialog?.kind === 'record' && <RecordPaymentModal projectId={projectId} summary={summary} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'phase' && <PhaseModal projectId={projectId} summary={summary} phase={dialog.phase} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'fee' && <FeeChangeModal projectId={projectId} summary={summary} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'feeDetails' && <FeeDetailsModal summary={summary} onClose={() => setDialog(null)} onChange={() => setDialog({ kind: 'fee' })} />}
      {dialog?.kind === 'reverse' && <ReverseModal projectId={projectId} receipt={dialog.receipt} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'allocate' && <AllocateModal projectId={projectId} summary={summary} receipt={dialog.receipt} onClose={() => setDialog(null)} onSaved={saved} />}
    </div>
  )
}

function countLabel(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
