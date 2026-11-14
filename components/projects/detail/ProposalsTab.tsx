'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiResponse } from '@/lib/types'
import {
  DISCIPLINES, PROJECT_TYPES, PROPOSAL_STATUS_TEXT, buildRefNo, financialYear, rupeeFigure, totalRate,
  type Discipline, type ProposalContent, type ProposalSettingsData, type ProposalStage, type ProposalStatus, type ProposalView,
} from '@/lib/proposal-types'
import { STANDARD_SQFT_SCHEDULE } from '@/lib/payment-types'
import { ErrorLine, Modal, field, ghostBtn, label, primaryBtn } from './PaymentsTab'

// Fee proposals for a project: the AI drafts the project-specific wording,
// fees and terms come from the form and Firm details, the admin edits and
// downloads it as a PDF in the firm's letterhead, and an accepted proposal
// sets up the project's payments. ADMIN and SUPER_ADMIN only.

async function api<T>(url: string, method = 'GET', body?: unknown): Promise<{ data: T | null; error: string | null }> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: body === undefined ? undefined : JSON.stringify(body) })
    const json = await res.json().catch(() => ({})) as ApiResponse<T>
    if (!res.ok || json.error) return { data: null, error: json.error ?? 'Something went wrong. Please try again.' }
    return { data: (json.data ?? null) as T | null, error: null }
  } catch {
    return { data: null, error: 'Network error. Please try again.' }
  }
}

const lines = (t: string) => t.split('\n').map((x) => x.trim()).filter(Boolean)
const showDate = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const today = () => new Date().toISOString().slice(0, 10)

const STATUS_STYLE: Record<ProposalStatus, string> = {
  DRAFT: 'bg-surface-sunken text-secondary',
  SENT: 'bg-status-warning/15 text-status-warning',
  ACCEPTED: 'bg-status-success/15 text-status-success',
  DECLINED: 'bg-status-danger/15 text-status-danger',
}
function StatusPill({ status }: { status: ProposalStatus }) {
  return <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${STATUS_STYLE[status]}`}>{PROPOSAL_STATUS_TEXT[status]}</span>
}

const defaultStages = (ds: Discipline[]): ProposalStage[] => {
  const groups = new Set<string>(DISCIPLINES.filter((d) => ds.includes(d.key)).map((d) => d.group))
  return STANDARD_SQFT_SCHEDULE.filter((s) => groups.has(s.group)).map((s) => ({ ...s }))
}

// ─── Fee table editor (new proposal and editor) ──────────────────────────────

function StagesEditor({ stages, onChange, disabled }: { stages: ProposalStage[]; onChange: (s: ProposalStage[]) => void; disabled?: boolean }) {
  const set = (i: number, patch: Partial<ProposalStage>) => onChange(stages.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const groups = [...new Set(stages.map((s) => s.group))]
  return (
    <div className="rounded-lg border border-border-default">
      <div className="grid grid-cols-[1fr_5.5rem_2rem] gap-2 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted border-b border-border-default">
        <span>Payment stage</span><span className="text-right">₹ / sq ft</span><span />
      </div>
      {groups.map((g) => (
        <div key={g} className="border-b border-border-default last:border-b-0 py-1">
          <p className="px-3 pt-1 text-[11px] font-semibold uppercase tracking-wider text-accent">{g}</p>
          {stages.map((s, i) => s.group !== g ? null : (
            <div key={i} className="grid grid-cols-[1fr_5.5rem_2rem] gap-2 px-3 py-1 items-center">
              <input value={s.name} disabled={disabled} onChange={(e) => set(i, { name: e.target.value })} maxLength={160} aria-label="Stage name" className={`${field} py-1`} />
              <input value={String(s.rate)} disabled={disabled} inputMode="decimal" aria-label={`Rate for ${s.name}`}
                onChange={(e) => { const v = Number(e.target.value); set(i, { rate: Number.isFinite(v) ? v : 0 }) }}
                className={`${field} py-1 text-right tabular-nums`} />
              {!disabled && <button type="button" onClick={() => onChange(stages.filter((_, j) => j !== i))} aria-label={`Remove ${s.name}`} className="text-muted hover:text-status-danger text-lg leading-none">×</button>}
            </div>
          ))}
        </div>
      ))}
      <div className="flex items-center justify-between px-3 py-2 border-t border-border-default">
        {!disabled ? (
          <span className="flex gap-3">
            {DISCIPLINES.map((d) => (
              <button key={d.key} type="button" className="text-xs text-accent hover:underline"
                onClick={() => onChange([...stages, { group: d.group, name: 'New stage', rate: 5 }])}>+ {d.group}</button>
            ))}
          </span>
        ) : <span />}
        <span className="text-sm font-semibold tabular-nums text-primary">Total ₹{totalRate(stages).toFixed(2)} / sq ft</span>
      </div>
    </div>
  )
}

// ─── New proposal ────────────────────────────────────────────────────────────

function NewProposalModal({ projectId, projectName, onClose, onCreated }: {
  projectId: string; projectName: string; onClose: () => void; onCreated: (p: ProposalView) => void
}) {
  const [salutation, setSalutation] = useState('Sir')
  const [name, setName] = useState('')
  const [city, setCity] = useState('')
  const [projectType, setProjectType] = useState('Resort')
  const [location, setLocation] = useState('')
  const [disciplines, setDisciplines] = useState<Discipline[]>(['Architecture', 'Structural', 'MEP and fire safety', 'Interior'])
  const [notes, setNotes] = useState('')
  const [stages, setStages] = useState<ProposalStage[]>(defaultStages(['Architecture', 'Structural', 'MEP and fire safety', 'Interior']))
  const [area, setArea] = useState('')
  const [gst, setGst] = useState('18')
  const [landscape, setLandscape] = useState('3,00,000')
  const [visits, setVisits] = useState('50')
  const [extraVisit, setExtraVisit] = useState('15,000')
  const [outstation, setOutstation] = useState('25,000')
  const [showFees, setShowFees] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggle(d: Discipline, on: boolean) {
    const next = on ? DISCIPLINES.map((x) => x.key).filter((k) => k === d || disciplines.includes(k)) : disciplines.filter((x) => x !== d)
    setDisciplines(next)
    setStages(defaultStages(next))
  }

  async function create() {
    setBusy(true); setError(null)
    const num = (t: string) => t.replace(/[,\s₹]/g, '')
    const r = await api<ProposalView>(`/api/projects/${projectId}/proposals`, 'POST', {
      client: { salutation, name, city }, projectType, location, disciplines, notes, date: today(),
      fees: {
        stages, areaSqft: area, gstPercent: num(gst), landscapePerAcre: num(landscape) || 0,
        siteVisitsIncluded: num(visits), extraVisitRate: num(extraVisit), outstationPerDay: num(outstation),
      },
    })
    setBusy(false)
    if (r.error) { setError(r.error); return }
    if (r.data) onCreated(r.data)
  }

  return (
    <Modal title="New proposal" onClose={busy ? () => {} : onClose} wide>
      <p className="text-sm text-secondary">For <b className="text-primary">{projectName}</b>. The AI writes the letter, project brief and scope of work from these details; the fees and terms below are used exactly as given.</p>
      <div className="grid grid-cols-[7rem_1fr_1fr] gap-3">
        <label className={label}>Dear
          <select value={salutation} onChange={(e) => setSalutation(e.target.value)} className={field}>
            {['Sir', 'Madam', 'Sir/Madam', 'Sirs'].map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label className={label}>Client name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Mr. K C Singhal" className={field} /></label>
        <label className={label}>Client city<input value={city} onChange={(e) => setCity(e.target.value)} maxLength={80} placeholder="e.g. Delhi" className={field} /></label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className={label}>Kind of project
          <input value={projectType} onChange={(e) => setProjectType(e.target.value)} list="proposal-types" maxLength={80} className={field} />
          <datalist id="proposal-types">{PROJECT_TYPES.map((t) => <option key={t} value={t} />)}</datalist>
        </label>
        <label className={label}>Site location<input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={120} placeholder="e.g. Dehradun, Uttarakhand" className={field} /></label>
      </div>
      <div>
        <p className={`${label} mb-1`}>Disciplines</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {DISCIPLINES.map((d) => (
            <label key={d.key} className="flex items-center gap-2 text-sm text-primary">
              <input type="checkbox" checked={disciplines.includes(d.key)} onChange={(e) => toggle(d.key, e.target.checked)} className="accent-accent" />{d.key}
            </label>
          ))}
        </div>
      </div>
      <label className={label}>Notes for the AI (optional)
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={2000} className={field}
          placeholder="e.g. 40 cottages, clubhouse, spa and restaurant on a hill slope; BOH design excluded; client wants vastu-compliant layouts" />
      </label>

      <div className="rounded-lg border border-border-default">
        <button type="button" onClick={() => setShowFees((v) => !v)} className="flex w-full items-center justify-between px-3 py-2 text-left">
          <span className="text-sm font-medium text-primary">Fees and terms</span>
          <span className="text-xs text-muted">₹{totalRate(stages).toFixed(2)} / sq ft · GST {gst || 0}% · landscape ₹{landscape || 0} / acre · {visits || 0} site visits {showFees ? '(hide)' : '(change)'}</span>
        </button>
        {showFees && (
          <div className="space-y-3 border-t border-border-default p-3">
            <StagesEditor stages={stages} onChange={setStages} />
            <div className="grid grid-cols-3 gap-3">
              <label className={label}>Built-up area, if known (sq ft)<input value={area} onChange={(e) => setArea(e.target.value)} inputMode="decimal" placeholder="optional" className={field} /></label>
              <label className={label}>GST (%)<input value={gst} onChange={(e) => setGst(e.target.value)} inputMode="decimal" className={field} /></label>
              <label className={label}>Landscape (₹ per acre, 0 = none)<input value={landscape} onChange={(e) => setLandscape(e.target.value)} inputMode="decimal" className={field} /></label>
              <label className={label}>Site visits included<input value={visits} onChange={(e) => setVisits(e.target.value)} inputMode="numeric" className={field} /></label>
              <label className={label}>Each extra visit (₹)<input value={extraVisit} onChange={(e) => setExtraVisit(e.target.value)} inputMode="decimal" className={field} /></label>
              <label className={label}>Out-of-state visit (₹ per day)<input value={outstation} onChange={(e) => setOutstation(e.target.value)} inputMode="decimal" className={field} /></label>
            </div>
          </div>
        )}
      </div>
      <ErrorLine text={error} />
      <div className="flex items-center justify-end gap-3">
        {busy && <span className="text-xs text-muted">Writing the proposal, this can take up to a minute...</span>}
        <button type="button" onClick={onClose} disabled={busy} className={ghostBtn}>Cancel</button>
        <button type="button" disabled={busy || !name.trim() || !location.trim() || !projectType.trim() || disciplines.length === 0 || stages.length === 0} onClick={() => void create()} className={primaryBtn}>
          {busy ? 'Writing...' : 'Write proposal with AI'}
        </button>
      </div>
    </Modal>
  )
}

// ─── Accept ──────────────────────────────────────────────────────────────────

function AcceptModal({ projectId, proposal, onClose, onDone }: {
  projectId: string; proposal: ProposalView; onClose: () => void; onDone: (p: ProposalView, paymentsCreated: boolean) => void
}) {
  const [area, setArea] = useState(proposal.content.fees.areaSqft ?? '')
  const [acres, setAcres] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const f = proposal.content.fees
  const sq = Number(area.replace(/[,\s]/g, ''))
  const fee = sq > 0 ? Math.round(totalRate(f.stages) * sq) + (f.landscapePerAcre && Number(acres) > 0 ? Math.round(f.landscapePerAcre * Number(acres)) : 0) : null

  async function save() {
    setBusy(true); setError(null)
    const r = await api<{ proposal: ProposalView; paymentsCreated: boolean }>(`/api/projects/${projectId}/proposals/${proposal.id}/accept`, 'POST', { area, landscapeAcres: acres })
    setBusy(false)
    if (r.error) { setError(r.error); return }
    if (r.data) onDone(r.data.proposal, r.data.paymentsCreated)
  }
  return (
    <Modal title="Client accepted the proposal" onClose={onClose}>
      <p className="text-sm text-secondary">The fee table becomes this project&apos;s payment schedule: every stage at its rate x the area, with GST {f.gstPercent}%. The area can be revised later in Payments.</p>
      <label className={label}>Built-up area (sq ft)<input autoFocus value={area} onChange={(e) => setArea(e.target.value)} inputMode="decimal" placeholder="e.g. 12,500" className={field} /></label>
      {!!f.landscapePerAcre && <label className={label}>Landscape area (acres, optional)<input value={acres} onChange={(e) => setAcres(e.target.value)} inputMode="decimal" placeholder="e.g. 2.5" className={field} /></label>}
      {fee !== null && <p className="text-sm text-secondary">Fee <b className="text-primary">₹{rupeeFigure(fee)}</b>{f.gstPercent > 0 ? ` + GST ₹${rupeeFigure(Math.round(fee * f.gstPercent) / 100)}` : ''}</p>}
      <ErrorLine text={error} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
        <button type="button" disabled={busy || !(sq > 0)} onClick={() => void save()} className={primaryBtn}>{busy ? 'Saving...' : 'Accept and set up payments'}</button>
      </div>
    </Modal>
  )
}

// ─── Editor ──────────────────────────────────────────────────────────────────

function ProposalEditor({ projectId, initial, onBack, onChanged }: {
  projectId: string; initial: ProposalView; onBack: () => void; onChanged: (p: ProposalView | null) => void
}) {
  const [p, setP] = useState(initial)
  const [c, setC] = useState<ProposalContent>(initial.content)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [accepting, setAccepting] = useState(false)
  const readOnly = p.status !== 'DRAFT'
  const url = `/api/projects/${projectId}/proposals/${p.id}`

  function edit(patch: Partial<ProposalContent>) { setC((x) => ({ ...x, ...patch })); setDirty(true) }
  function editFees(patch: Partial<ProposalContent['fees']>) { setC((x) => ({ ...x, fees: { ...x.fees, ...patch } })); setDirty(true) }
  function done(next: ProposalView, msg: string) { setP(next); setC(next.content); setDirty(false); onChanged(next); setNotice(msg); setError(null) }

  async function run(what: string, method: string, body?: unknown, msg = 'Saved.') {
    setBusy(what); setError(null); setNotice(null)
    const r = await api<ProposalView>(url, method, body)
    setBusy(null)
    if (r.error) { setError(r.error); return null }
    if (r.data) done(r.data, msg)
    return r.data
  }
  const save = () => run('save', 'PATCH', { content: c })
  async function openPdf() {
    if (dirty && !(await save())) return
    window.open(`/print/proposals/${projectId}/${p.id}`, '_blank', 'noopener')
  }
  async function remove() {
    if (!window.confirm(`Delete draft ${p.refNo}? Its reference number will not be used again.`)) return
    setBusy('delete')
    const r = await api<{ id: string }>(url, 'DELETE')
    setBusy(null)
    if (r.error) { setError(r.error); return }
    onChanged(null); onBack()
  }

  const area = (k: keyof ProposalContent['fees'], v: string) => editFees({ [k]: lines(v) } as Partial<ProposalContent['fees']>)
  const ta = 'w-full bg-background-primary border border-border-default rounded px-3 py-2 text-sm text-primary focus:outline-none focus:border-accent disabled:opacity-70'

  return (
    <div className="space-y-4 pt-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <button type="button" onClick={onBack} className="text-xs text-muted hover:text-primary">← All proposals</button>
          <h2 className="text-base font-semibold text-primary flex items-center gap-2">{p.refNo} <StatusPill status={p.status} /></h2>
          <p className="text-xs text-muted">{c.draftedBy ? `Wording by ${c.draftedBy}. ` : ''}{readOnly ? 'Sent proposals cannot be edited; reopen as a draft to change it.' : 'Check every line before sending.'}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!readOnly && <button type="button" disabled={!!busy} onClick={() => void run('redraft', 'PATCH', { redraft: true, notes: c.notes }, 'Wording rewritten. Fees were kept as they were.')} className="px-3 py-2 text-xs font-medium rounded border border-border-default text-primary hover:border-accent">{busy === 'redraft' ? 'Rewriting...' : 'Rewrite wording with AI'}</button>}
          {!readOnly && <button type="button" disabled={!!busy || !dirty} onClick={() => void save()} className="px-3 py-2 text-xs font-medium rounded border border-border-default text-primary hover:border-accent disabled:opacity-40">{busy === 'save' ? 'Saving...' : dirty ? 'Save changes' : 'Saved'}</button>}
          <button type="button" disabled={!!busy} onClick={() => void openPdf()} className={primaryBtn}>Preview and download PDF</button>
        </div>
      </div>
      {notice && <div role="status" className="text-sm text-status-success bg-status-success/10 border border-status-success/30 rounded-lg px-3 py-2">{notice}</div>}
      <ErrorLine text={error} />

      <div className="flex flex-wrap gap-2 rounded-lg border border-border-default bg-surface-raised/40 px-4 py-3 text-sm">
        <span className="text-secondary mr-auto">
          {p.status === 'DRAFT' && 'Next: download the PDF, send it to the client, then mark it as sent.'}
          {p.status === 'SENT' && `Sent ${p.sentAt ? showDate(p.sentAt) : ''}. When the client agrees, accept it to set up payments.`}
          {p.status === 'ACCEPTED' && `Accepted ${p.acceptedAt ? showDate(p.acceptedAt) : ''}. Its fee table is the project's payment schedule (Payments tab).`}
          {p.status === 'DECLINED' && 'The client declined. Reopen it to revise and send again.'}
        </span>
        {p.status === 'DRAFT' && <button type="button" disabled={!!busy || dirty} title={dirty ? 'Save first' : ''} onClick={() => void run('sent', 'PATCH', { status: 'SENT' }, 'Marked as sent. The letterhead and terms are now fixed for this proposal.')} className="text-xs font-semibold text-accent hover:underline disabled:opacity-40">Mark as sent</button>}
        {(p.status === 'DRAFT' || p.status === 'SENT') && <button type="button" disabled={!!busy || dirty} onClick={() => setAccepting(true)} className="text-xs font-semibold text-status-success hover:underline disabled:opacity-40">Client accepted</button>}
        {p.status === 'SENT' && <button type="button" disabled={!!busy} onClick={() => void run('declined', 'PATCH', { status: 'DECLINED' }, 'Marked as declined.')} className="text-xs text-secondary hover:text-status-danger">Client declined</button>}
        {(p.status === 'SENT' || p.status === 'DECLINED') && <button type="button" disabled={!!busy} onClick={() => void run('reopen', 'PATCH', { status: 'DRAFT' }, 'Reopened as a draft.')} className="text-xs text-secondary hover:text-primary">Reopen as draft</button>}
        {p.status === 'DRAFT' && <button type="button" disabled={!!busy} onClick={() => void remove()} className="text-xs text-secondary hover:text-status-danger">Delete draft</button>}
      </div>

      <section className="rounded-xl border border-border-default p-4 space-y-3">
        <h3 className="text-sm font-semibold text-primary">Cover letter</h3>
        <div className="grid grid-cols-[7rem_1fr_1fr_10rem] gap-3">
          <label className={label}>Dear<input value={c.client.salutation} disabled={readOnly} onChange={(e) => edit({ client: { ...c.client, salutation: e.target.value } })} className={field} /></label>
          <label className={label}>Client<input value={c.client.name} disabled={readOnly} onChange={(e) => edit({ client: { ...c.client, name: e.target.value } })} className={field} /></label>
          <label className={label}>City<input value={c.client.city} disabled={readOnly} onChange={(e) => edit({ client: { ...c.client, city: e.target.value } })} className={field} /></label>
          <label className={label}>Date<input type="date" value={c.date} disabled={readOnly} onChange={(e) => edit({ date: e.target.value })} className={field} /></label>
        </div>
        <label className={label}>Subject<textarea value={c.subject} disabled={readOnly} onChange={(e) => edit({ subject: e.target.value })} rows={2} className={ta} /></label>
        <label className={label}>Letter (blank line between paragraphs)<textarea value={c.intro} disabled={readOnly} onChange={(e) => edit({ intro: e.target.value })} rows={6} className={ta} /></label>
      </section>

      <section className="rounded-xl border border-border-default p-4 space-y-3">
        <h3 className="text-sm font-semibold text-primary">Project brief and scope of work</h3>
        <div className="grid grid-cols-3 gap-3">
          <label className={`${label} col-span-1`}>Title<input value={c.brief.title} disabled={readOnly} onChange={(e) => edit({ brief: { ...c.brief, title: e.target.value } })} className={field} /></label>
          <label className={label}>Project<input value={c.projectType} disabled={readOnly} onChange={(e) => edit({ projectType: e.target.value })} className={field} /></label>
          <label className={label}>Location<input value={c.location} disabled={readOnly} onChange={(e) => edit({ location: e.target.value })} className={field} /></label>
        </div>
        <label className={label}>Scope in brief (one per line)<textarea value={c.brief.scopeSummary.join('\n')} disabled={readOnly} onChange={(e) => edit({ brief: { ...c.brief, scopeSummary: lines(e.target.value) } })} rows={3} className={ta} /></label>
        <div className="grid gap-3 md:grid-cols-2">
          {c.scope.map((s, i) => (
            <label key={i} className={label}>{s.discipline} (one item per line)
              <textarea value={s.items.join('\n')} disabled={readOnly} rows={Math.min(16, s.items.length + 2)} className={ta}
                onChange={(e) => edit({ scope: c.scope.map((x, j) => (j === i ? { ...x, items: e.target.value.split('\n') } : x)) })}
                onBlur={() => edit({ scope: c.scope.map((x) => ({ ...x, items: x.items.map((t) => t.trim()).filter(Boolean) })) })} />
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border-default p-4 space-y-3">
        <h3 className="text-sm font-semibold text-primary">Professional fees</h3>
        <StagesEditor stages={c.fees.stages} disabled={readOnly} onChange={(stages) => editFees({ stages })} />
        <div className="grid grid-cols-3 gap-3">
          <label className={label}>Built-up area, if known (sq ft)<input value={c.fees.areaSqft} disabled={readOnly} onChange={(e) => editFees({ areaSqft: e.target.value })} className={field} /></label>
          <label className={label}>GST (%)<input value={String(c.fees.gstPercent)} disabled={readOnly} inputMode="decimal" onChange={(e) => editFees({ gstPercent: Number(e.target.value) || 0 })} className={field} /></label>
          <label className={label}>Landscape (₹ per acre)<input value={String(c.fees.landscapePerAcre ?? 0)} disabled={readOnly} inputMode="decimal" onChange={(e) => editFees({ landscapePerAcre: Number(e.target.value.replace(/,/g, '')) || 0 })} className={field} /></label>
          <label className={label}>Site visits included<input value={String(c.fees.siteVisitsIncluded ?? '')} disabled={readOnly} inputMode="numeric" onChange={(e) => editFees({ siteVisitsIncluded: Number(e.target.value) || null })} className={field} /></label>
          <label className={label}>Each extra visit (₹)<input value={String(c.fees.extraVisitRate ?? '')} disabled={readOnly} inputMode="decimal" onChange={(e) => editFees({ extraVisitRate: Number(e.target.value.replace(/,/g, '')) || null })} className={field} /></label>
          <label className={label}>Out-of-state visit (₹ per day)<input value={String(c.fees.outstationPerDay ?? '')} disabled={readOnly} inputMode="decimal" onChange={(e) => editFees({ outstationPerDay: Number(e.target.value.replace(/,/g, '')) || null })} className={field} /></label>
          <label className={label}>Offer valid (months)<input value={String(c.fees.offerValidMonths)} disabled={readOnly} inputMode="numeric" onChange={(e) => editFees({ offerValidMonths: Number(e.target.value) || 1 })} className={field} /></label>
          <label className={label}>Engagement term (months)<input value={String(c.fees.engagementMonths)} disabled={readOnly} inputMode="numeric" onChange={(e) => editFees({ engagementMonths: Number(e.target.value) || 24 })} className={field} /></label>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className={label}>Sanction drawings notes (one per line)<textarea value={c.fees.sanctionNotes.join('\n')} disabled={readOnly} onChange={(e) => area('sanctionNotes', e.target.value)} rows={5} className={ta} /></label>
          <label className={label}>Exclusions (one per line)<textarea value={c.fees.exclusions.join('\n')} disabled={readOnly} onChange={(e) => area('exclusions', e.target.value)} rows={5} className={ta} /></label>
        </div>
      </section>

      <section className="rounded-xl border border-border-default p-4 space-y-3">
        <h3 className="text-sm font-semibold text-primary">Closing</h3>
        <textarea value={c.closing} disabled={readOnly} onChange={(e) => edit({ closing: e.target.value })} rows={2} className={ta} />
        <p className="text-xs text-muted">Client responsibilities, reimbursables, indemnity, copyright, interpretation and arbitration come from Firm details and are the same in every proposal.</p>
      </section>

      {accepting && <AcceptModal projectId={projectId} proposal={p} onClose={() => setAccepting(false)} onDone={(np, created) => {
        setAccepting(false)
        done(np, created ? 'Accepted. The payment schedule is set up in the Payments tab.' : 'Accepted. This project already had payments set up, so they were left as they are.')
      }} />}
    </div>
  )
}

// ─── Firm details ────────────────────────────────────────────────────────────

function FirmDetailsModal({ initial, onClose, onSaved }: { initial: ProposalSettingsData; onClose: () => void; onSaved: (s: ProposalSettingsData) => void }) {
  const [s, setS] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const f = s.firm
  const setF = (patch: Partial<typeof f>) => setS((x) => ({ ...x, firm: { ...x.firm, ...patch } }))
  const setBank = (patch: Partial<typeof f.bank>) => setS((x) => ({ ...x, firm: { ...x.firm, bank: { ...x.firm.bank, ...patch } } }))
  const setT = (patch: Partial<typeof s.terms>) => setS((x) => ({ ...x, terms: { ...x.terms, ...patch } }))
  const ta = 'w-full bg-background-primary border border-border-default rounded px-3 py-2 text-sm text-primary focus:outline-none focus:border-accent'

  function pickLogo(file: File | undefined) {
    if (!file) return
    if (file.size > 280_000) { setError('The logo must be smaller than about 280 KB'); return }
    const r = new FileReader()
    r.onload = () => setF({ logoDataUrl: String(r.result) })
    r.readAsDataURL(file)
  }
  async function save() {
    setBusy(true); setError(null)
    const r = await api<{ data: ProposalSettingsData }>('/api/proposal-settings', 'PUT', s)
    setBusy(false)
    if (r.error) { setError(r.error); return }
    if (r.data) onSaved(r.data.data)
  }
  const input = (k: keyof typeof f, l: string, ph = '') => (
    <label className={label}>{l}<input value={String(f[k] ?? '')} onChange={(e) => setF({ [k]: e.target.value } as Partial<typeof f>)} placeholder={ph} className={field} /></label>
  )

  return (
    <Modal title="Firm details for proposals" onClose={onClose} wide>
      <p className="text-sm text-secondary">Set once for the whole company. Every proposal uses these; a proposal already sent keeps the details it was sent with.</p>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-accent">Letterhead</h3>
      <div className="grid grid-cols-2 gap-3">
        {input('name', 'Firm name', 'e.g. Trijya Design Studio')}
        {input('tagline', 'Services line', 'ARCHITECTURE | VASTU | INTERIOR | LANDSCAPE | PLANNING')}
        {input('address', 'Address')}
        {input('homeState', 'Home state (for out-of-state visits)', 'e.g. Uttarakhand')}
        {input('email', 'Email')}
        {input('phone', 'Phone (optional)')}
        {input('signatoryName', 'Signed by')}
        {input('signatoryTitle', 'Title')}
      </div>
      <div className="flex items-center gap-3">
        {f.logoDataUrl && <img src={f.logoDataUrl} alt="Logo" className="h-14 w-14 object-contain rounded border border-border-default bg-white" />}
        <label className="text-xs font-medium text-accent hover:underline cursor-pointer">
          {f.logoDataUrl ? 'Change logo' : 'Add logo (PNG, JPEG or SVG)'}
          <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden" onChange={(e) => pickLogo(e.target.files?.[0])} />
        </label>
        {f.logoDataUrl && <button type="button" onClick={() => setF({ logoDataUrl: null })} className="text-xs text-secondary hover:text-status-danger">Remove</button>}
      </div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-accent">Reference numbers</h3>
      <div className="grid grid-cols-2 gap-3">
        {input('refPrefix', 'Prefix', 'e.g. TDS/Offer/DD/Arch')}
        <label className={label}>Next number<input value={String(f.nextSerial)} inputMode="numeric" onChange={(e) => setF({ nextSerial: Number(e.target.value) || 1 })} className={field} /></label>
      </div>
      <p className="text-xs text-muted">The next proposal will be <b className="text-primary">{buildRefNo(f.refPrefix, f.nextSerial, financialYear(today()))}</b>.</p>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-accent">Payment details printed on proposals</h3>
      <div className="grid grid-cols-2 gap-3">
        {input('chequePayee', 'Cheques in favour of')}
        <label className={label}>Account name<input value={f.bank.accountName} onChange={(e) => setBank({ accountName: e.target.value })} className={field} /></label>
        <label className={label}>Account number<input value={f.bank.accountNo} onChange={(e) => setBank({ accountNo: e.target.value })} className={field} /></label>
        <label className={label}>Bank and branch<input value={f.bank.bankName} onChange={(e) => setBank({ bankName: e.target.value })} className={field} /></label>
        <label className={label}>IFSC<input value={f.bank.ifsc} onChange={(e) => setBank({ ifsc: e.target.value })} className={field} /></label>
        {input('pan', 'PAN')}
        {input('gstin', 'GSTIN')}
      </div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-accent">Standard terms</h3>
      <label className={label}>Client&apos;s role and responsibilities (one per line)<textarea value={s.terms.clientRoles.join('\n')} onChange={(e) => setT({ clientRoles: e.target.value.split('\n') })} rows={6} className={ta} /></label>
      <label className={label}>Reimbursable expenses (one per line; the out-of-state visit line is added from each proposal)<textarea value={s.terms.reimbursables.join('\n')} onChange={(e) => setT({ reimbursables: e.target.value.split('\n') })} rows={3} className={ta} /></label>
      {(['noDeductions', 'forceMajeure', 'indemnification', 'copyright', 'interpretation', 'arbitration'] as const).map((k) => (
        <label key={k} className={label}>{{ noDeductions: 'No deductions', forceMajeure: 'Force majeure', indemnification: 'Indemnification', copyright: 'Ownership of copyright', interpretation: 'Interpretation', arbitration: 'Arbitration' }[k]}
          <textarea value={s.terms[k]} onChange={(e) => setT({ [k]: e.target.value } as Partial<typeof s.terms>)} rows={3} className={ta} />
        </label>
      ))}
      <ErrorLine text={error} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
        <button type="button" disabled={busy} onClick={() => void save()} className={primaryBtn}>{busy ? 'Saving...' : 'Save firm details'}</button>
      </div>
    </Modal>
  )
}

// ─── Main ────────────────────────────────────────────────────────────────────

export default function ProposalsTab({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [list, setList] = useState<ProposalView[] | null>(null)
  const [settings, setSettings] = useState<ProposalSettingsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<ProposalView | null>(null)
  const [creating, setCreating] = useState(false)
  const [firmOpen, setFirmOpen] = useState(false)

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      api<ProposalView[]>(`/api/projects/${projectId}/proposals`),
      api<{ data: ProposalSettingsData }>('/api/proposal-settings'),
    ])
    if (a.error || b.error) setError(a.error ?? b.error)
    setList(a.data ?? []); setSettings(b.data?.data ?? null)
  }, [projectId])
  useEffect(() => { void load() }, [load])

  const changed = (p: ProposalView | null) => {
    void load()
    if (p) setOpen(p)
  }

  if (!list || !settings) return error ? <ErrorLine text={error} /> : <div className="h-24 rounded-xl bg-surface-raised animate-pulse" />

  if (open) return <ProposalEditor key={open.id} projectId={projectId} initial={open} onBack={() => setOpen(null)} onChanged={changed} />

  return (
    <div className="space-y-4 pt-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-primary">Proposals</h2>
          <p className="text-xs text-muted">Fee proposals for this project, written with AI in your letterhead. Only admins can see this.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setFirmOpen(true)} className="px-3 py-2 text-xs font-medium rounded border border-border-default text-primary hover:border-accent">Firm details</button>
          <button type="button" onClick={() => setCreating(true)} className={primaryBtn}>New proposal</button>
        </div>
      </div>
      <ErrorLine text={error} />
      {!settings.firm.name && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-status-warning/40 bg-status-warning/10 px-4 py-2.5 text-sm">
          <span className="text-primary">Fill in your firm details once (letterhead, signatory, bank details, reference numbers) so proposals print correctly.</span>
          <button type="button" onClick={() => setFirmOpen(true)} className="text-xs font-semibold text-accent hover:underline">Firm details</button>
        </div>
      )}
      {list.length === 0 ? (
        <div className="rounded-xl border border-border-default px-4 py-10 text-center">
          <p className="text-sm text-secondary">No proposals for this project yet.</p>
          <button type="button" onClick={() => setCreating(true)} className={`mt-3 ${primaryBtn}`}>Write the first proposal</button>
        </div>
      ) : (
        <ul className="rounded-xl border border-border-default divide-y divide-border-default">
          {list.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => setOpen(p)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-surface-raised/40">
                <span className="text-sm font-semibold text-primary">{p.refNo}</span>
                <StatusPill status={p.status} />
                <span className="text-sm text-secondary">{p.content.client.name} · {p.content.projectType} at {p.content.location}</span>
                <span className="ml-auto text-xs text-muted tabular-nums">₹{totalRate(p.content.fees.stages).toFixed(2)} / sq ft · {showDate(p.content.date)} · {p.createdByName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {creating && <NewProposalModal projectId={projectId} projectName={projectName} onClose={() => setCreating(false)} onCreated={(p) => { setCreating(false); void load(); setOpen(p) }} />}
      {firmOpen && <FirmDetailsModal initial={settings} onClose={() => setFirmOpen(false)} onSaved={(s) => { setSettings(s); setFirmOpen(false) }} />}
    </div>
  )
}
