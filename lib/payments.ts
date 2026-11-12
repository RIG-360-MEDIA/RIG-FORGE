import type { NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/db'
import { getTokenFromCookies, verifyToken, type TokenPayload } from '@/lib/auth'
import { errorResponse } from '@/lib/api-helpers'
import { isAdminRole } from '@/lib/roles'
import { TX_OPTIONS } from '@/lib/task-categories'
import {
  FEE_CHANGE_LABELS, formatInr,
  type FeeBasis, type FeeChangeKind, type PaymentMode, type PaymentsSummary, type PhaseStatus,
} from '@/lib/payment-types'

// ─── Who may use payments ────────────────────────────────────────────────────

/**
 * Payments are for ADMIN and SUPER_ADMIN only (the base role, not a custom
 * capability, so no role builder setting can widen it), and never for an
 * external client or supplier account. Checked on the server by every
 * payments route; hiding the tab is only a convenience.
 */
export function canUsePayments(payload: Pick<TokenPayload, 'role' | 'isExternal'>): boolean {
  return isAdminRole(payload.role) && !payload.isExternal
}

/** Auth + admin check + the project, for every payments route. */
export async function paymentsGuard(request: NextRequest, projectId: string):
  Promise<{ payload: TokenPayload; project: { id: string; name: string } } | { response: Response }> {
  const token = getTokenFromCookies(request)
  if (!token) return { response: errorResponse('Authentication required', 401) }
  const payload = verifyToken(token)
  if (!payload) return { response: errorResponse('Invalid or expired token', 401) }
  if (!canUsePayments(payload)) return { response: errorResponse('Payments are only for admins', 403) }
  const project = await prisma.project.findFirst({ where: { id: projectId, isActive: true }, select: { id: true, name: true } })
  if (!project) return { response: errorResponse('Project not found', 404) }
  return { payload, project }
}

// ─── Money ───────────────────────────────────────────────────────────────────

/** Largest amount accepted anywhere: Rs 1,000 crore. */
const MAX_PAISE = BigInt(1000000000000)

/**
 * Rupees typed by a person ("1,50,000", "150000.5", 2500) to whole paise,
 * exactly: parsed as text, never multiplied as a float (0.1 + 0.2 problems).
 * Commas and spaces allowed, at most 2 decimals. `signed` allows a leading
 * minus (fee reductions). Returns null for anything else.
 */
export function parseRupees(raw: unknown, { signed = false } = {}): bigint | null {
  const text = typeof raw === 'number' ? (Number.isFinite(raw) ? raw.toFixed(2) : '') : typeof raw === 'string' ? raw : ''
  const t = text.replace(/[,\s₹]/g, '')
  const m = t.match(/^(-)?(\d{1,13})(?:\.(\d{1,2}))?$/)
  if (!m) return null
  if (m[1] && !signed) return null
  const paise = BigInt(m[2]!) * BigInt(100) + BigInt((m[3] ?? '').padEnd(2, '0') || '0')
  if (paise > MAX_PAISE) return null
  return m[1] ? -paise : paise
}

/** "7.5" or 7.5 (percent) to basis points (750). 0 < p <= 100, at most 2 decimals. */
export function parsePercentBp(raw: unknown): number | null {
  const t = (typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '').trim().replace(/%$/, '')
  const m = t.match(/^(\d{1,3})(?:\.(\d{1,2}))?$/)
  if (!m) return null
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0')
  return bp > 0 && bp <= 10000 ? bp : null
}

/** amount x bp / 10000, rounded half up, in paise. */
export function percentOf(amount: bigint, bp: number): bigint {
  return (amount * BigInt(bp) + BigInt(5000)) / BigInt(10000)
}

/** A calendar date ("2026-11-12" or an ISO string) to midnight UTC, or null. */
export function parseDay(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw) return null
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3]) ? null : d
}

export const PAYMENT_MODE_VALUES: PaymentMode[] = ['BANK', 'UPI', 'CHEQUE', 'CASH', 'OTHER']

/** Trimmed text, or null when empty; 'too-long' over the limit. */
export function cleanText(raw: unknown, max: number): string | null | 'too-long' {
  if (typeof raw !== 'string') return null
  const t = raw.trim().replace(/\s+/g, ' ')
  if (!t) return null
  return t.length > max ? 'too-long' : t
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/** The client inside a transaction (the org-scoped, extended client). */
type Tx = Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

/**
 * Run a payments write for one project: in a transaction, holding a lock on
 * that project's payments, so two admins recording at the same moment are
 * applied one after the other and every check (balances, duplicates) sees
 * the other's result. The lock names no table and ends with the transaction.
 */
export function withProjectPaymentsLock<T>(projectId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payments:${projectId}`}))`
    return fn(tx)
  }, TX_OPTIONS)
}

/** BigInts in an audit detail become numbers (JSON cannot hold BigInt). */
function jsonSafe(detail: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))
}

export async function audit(tx: Tx, projectId: string, userId: string, action: string, detail: Record<string, unknown>) {
  await tx.paymentAuditLog.create({ data: { projectId, userId, action, detail: jsonSafe(detail) } })
}

/** Money already counted against each phase, from receipts that are not reversed. */
export async function allocatedByPhase(tx: Tx | typeof prisma, projectId: string): Promise<Map<string, bigint>> {
  const rows = await tx.paymentAllocation.findMany({
    where: { phase: { projectId }, receipt: { reversedAt: null } },
    select: { phaseId: true, amount: true },
  })
  const m = new Map<string, bigint>()
  for (const r of rows) m.set(r.phaseId, (m.get(r.phaseId) ?? BigInt(0)) + r.amount)
  return m
}

/**
 * Check a list of { phaseId, amount } to count against phases, inside the
 * project lock: every phase is this project's and active, no phase twice,
 * every amount more than 0 and at most that phase's remaining balance, and
 * the total at most `available` (the receipt's amount, or what is still on
 * account). Returns the rows, or an error to show.
 */
export async function checkAllocations(
  tx: Tx, projectId: string, raw: unknown, available: bigint,
): Promise<{ rows: { phaseId: string; amount: bigint }[]; total: bigint } | { error: string }> {
  if (raw === undefined || raw === null) return { rows: [], total: BigInt(0) }
  if (!Array.isArray(raw)) return { error: 'allocations must be a list' }
  if (raw.length > 100) return { error: 'Too many stages in one payment' }
  const phases = await tx.paymentPhase.findMany({ where: { projectId, isActive: true }, select: { id: true, name: true, amount: true } })
  const received = await allocatedByPhase(tx, projectId)
  const rows: { phaseId: string; amount: bigint }[] = []
  const seen = new Set<string>()
  let total = BigInt(0)
  for (const entry of raw as { phaseId?: unknown; amount?: unknown }[]) {
    const phase = phases.find((p) => p.id === entry?.phaseId)
    if (!phase) return { error: "A payment can only go to a stage in this project's schedule" }
    if (seen.has(phase.id)) return { error: `${phase.name} is listed twice` }
    seen.add(phase.id)
    const amount = parseRupees(entry.amount)
    if (amount === null || amount <= BigInt(0)) return { error: `Enter an amount for ${phase.name}, more than 0` }
    const balance = phase.amount - (received.get(phase.id) ?? BigInt(0))
    if (amount > balance) {
      return { error: `${phase.name} has only ${formatInr(Number(balance > BigInt(0) ? balance : BigInt(0)))} left to pay. Put the rest towards another stage, or leave it as an advance.` }
    }
    rows.push({ phaseId: phase.id, amount })
    total += amount
  }
  if (total > available) return { error: `The stages add up to ${formatInr(Number(total))}, more than the ${formatInr(Number(available))} available` }
  return { rows, total }
}

/** The project's current fee: the sum of its fee changes. */
export async function currentFee(tx: Tx | typeof prisma, planId: string): Promise<{ fee: bigint; estimatedCost: bigint | null }> {
  const changes = await tx.paymentFeeChange.findMany({ where: { planId }, orderBy: { createdAt: 'asc' }, select: { amountDelta: true, estimatedCost: true } })
  let fee = BigInt(0)
  let estimatedCost: bigint | null = null
  for (const c of changes) { fee += c.amountDelta; if (c.estimatedCost !== null) estimatedCost = c.estimatedCost }
  return { fee, estimatedCost }
}

// ─── Read ────────────────────────────────────────────────────────────────────

const n = (v: bigint) => Number(v)

/** Everything the Payments tab shows, every total calculated from the ledger. */
export async function loadPaymentsSummary(projectId: string): Promise<PaymentsSummary> {
  const [plan, phases, receipts, history] = await Promise.all([
    prisma.paymentPlan.findFirst({ where: { projectId }, include: { feeChanges: { orderBy: { createdAt: 'asc' } } } }),
    prisma.paymentPhase.findMany({ where: { projectId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    prisma.paymentReceipt.findMany({
      where: { projectId },
      orderBy: [{ receivedOn: 'desc' }, { createdAt: 'desc' }],
      include: { allocations: { orderBy: { createdAt: 'asc' } } },
    }),
    prisma.paymentAuditLog.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ])

  const userIds = new Set<string>()
  plan?.feeChanges.forEach((c) => userIds.add(c.createdById))
  receipts.forEach((r) => { userIds.add(r.createdById); if (r.reversedById) userIds.add(r.reversedById) })
  history.forEach((h) => userIds.add(h.userId))
  const users = await prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } })
  const nameOf = (id: string | null) => users.find((u) => u.id === id)?.name ?? 'Someone'

  let fee = BigInt(0)
  let estimatedCost: bigint | null = null
  for (const c of plan?.feeChanges ?? []) { fee += c.amountDelta; if (c.estimatedCost !== null) estimatedCost = c.estimatedCost }

  const phaseName = new Map(phases.map((p) => [p.id, p.name]))
  const allocated = new Map<string, bigint>()
  let received = BigInt(0)
  let allocatedTotal = BigInt(0)
  for (const r of receipts) {
    if (r.reversedAt) continue
    received += r.amount
    for (const a of r.allocations) {
      allocated.set(a.phaseId, (allocated.get(a.phaseId) ?? BigInt(0)) + a.amount)
      allocatedTotal += a.amount
    }
  }

  const today = new Date(); today.setUTCHours(0, 0, 0, 0)
  const phaseViews = phases.map((p) => {
    const got = allocated.get(p.id) ?? BigInt(0)
    const balance = p.amount - got
    const status: PhaseStatus = balance <= BigInt(0) ? 'PAID' : got > BigInt(0) ? 'PART_PAID' : 'UNPAID'
    return {
      id: p.id, name: p.name, amount: n(p.amount), received: n(got), balance: n(balance),
      dueDate: p.dueDate?.toISOString() ?? null, note: p.note, sortOrder: p.sortOrder, isActive: p.isActive,
      status, overdue: p.isActive && balance > BigInt(0) && !!p.dueDate && p.dueDate < today,
    }
  })
  const phasesTotal = phases.filter((p) => p.isActive).reduce((s, p) => s + p.amount, BigInt(0))

  const warnings: string[] = []
  if (plan && phases.some((p) => p.isActive) && phasesTotal !== fee) {
    const diff = fee - phasesTotal
    warnings.push(diff > BigInt(0)
      ? `The stages add up to ${formatInr(n(phasesTotal))}, ${formatInr(n(diff))} less than the fee. Add a stage or raise one so the whole fee is billed.`
      : `The stages add up to ${formatInr(n(phasesTotal))}, ${formatInr(n(-diff))} more than the fee. Lower a stage, or change the fee.`)
  }
  if (received > fee && plan) warnings.push(`${formatInr(n(received - fee))} more has been received than the fee.`)
  const onAccount = received - allocatedTotal
  if (onAccount > BigInt(0)) warnings.push(`${formatInr(n(onAccount))} received as an advance, not linked to any stage yet.`)

  return {
    plan: plan ? { basis: plan.basis as FeeBasis, percentBp: plan.percentBp, createdAt: plan.createdAt.toISOString() } : null,
    fee: {
      current: n(fee),
      estimatedCost: estimatedCost === null ? null : n(estimatedCost),
      changes: (plan?.feeChanges ?? []).map((c) => ({
        id: c.id, kind: c.kind as FeeChangeKind, amountDelta: n(c.amountDelta),
        estimatedCost: c.estimatedCost === null ? null : n(c.estimatedCost),
        reason: c.reason, createdAt: c.createdAt.toISOString(), createdByName: nameOf(c.createdById),
      })),
    },
    phases: phaseViews,
    receipts: receipts.map((r) => {
      const alloc = r.allocations.reduce((s, a) => s + a.amount, BigInt(0))
      return {
        id: r.id, receivedOn: r.receivedOn.toISOString(), amount: n(r.amount), mode: r.mode as PaymentMode,
        reference: r.reference, payer: r.payer, note: r.note,
        createdAt: r.createdAt.toISOString(), createdByName: nameOf(r.createdById),
        allocations: r.allocations.map((a) => ({ id: a.id, phaseId: a.phaseId, phaseName: phaseName.get(a.phaseId) ?? 'Stage', amount: n(a.amount), createdAt: a.createdAt.toISOString() })),
        allocated: n(alloc),
        onAccount: r.reversedAt ? 0 : n(r.amount - alloc),
        reversed: r.reversedAt ? { at: r.reversedAt.toISOString(), byName: nameOf(r.reversedById), reason: r.reversalReason ?? '' } : null,
      }
    }),
    totals: {
      fee: n(fee), phasesTotal: n(phasesTotal), received: n(received), allocated: n(allocatedTotal),
      onAccount: n(onAccount), outstanding: n(fee - received),
    },
    warnings,
    history: history.map((h) => ({
      id: h.id, action: h.action, summary: describeAudit(h.action, h.detail as Record<string, unknown>),
      userName: nameOf(h.userId), createdAt: h.createdAt.toISOString(),
    })),
  }
}

/** One readable line per audit entry. */
const CHANGED_FIELD: Record<string, string> = { name: 'name', amount: 'amount', dueDate: 'due date', note: 'note', sortOrder: 'position' }

function describeAudit(action: string, d: Record<string, unknown>): string {
  const inr = (v: unknown) => (typeof v === 'number' ? formatInr(v) : '')
  switch (action) {
    case 'SETUP': return `Fee set up: ${inr(d.fee)}${d.basis === 'PERCENT' ? ` (${d.percent} of ${inr(d.estimatedCost)})` : ''}`
    case 'FEE_CHANGE': return `${FEE_CHANGE_LABELS[d.kind as FeeChangeKind] ?? 'Fee change'}: ${(d.amountDelta as number) >= 0 ? '+' : ''}${inr(d.amountDelta)}, fee now ${inr(d.feeAfter)}. ${d.reason ?? ''}`
    case 'PHASE_ADD': return `Stage added: ${d.name}, ${inr(d.amount)}`
    case 'PHASE_EDIT': return `Stage "${d.name}" changed: ${Object.keys((d.changes as object) ?? {}).map((k) => CHANGED_FIELD[k] ?? k).join(', ')}`
    case 'PHASE_ARCHIVE': return `Stage removed from the schedule: ${d.name}`
    case 'PHASE_RESTORE': return `Stage put back in the schedule: ${d.name}`
    case 'RECEIPT': return `Payment recorded: ${inr(d.amount)} by ${d.mode}${d.reference ? ` (${d.reference})` : ''}`
    case 'REVERSE': return `Payment entry of ${inr(d.amount)} cancelled: ${d.reason ?? ''}`
    case 'ALLOCATE': return `Advance of ${inr(d.total)} linked to stages`
    default: return action
  }
}
