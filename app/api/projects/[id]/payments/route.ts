import { type NextRequest } from 'next/server'

import { successResponse, errorResponse } from '@/lib/api-helpers'
import { BUSY_MESSAGE, isBusyError } from '@/lib/task-categories'
import {
  amountForArea, cleanText, createPaymentPlan, loadPaymentsSummary, parseArea, parseGstBp, parsePercentBp, parseRupees,
  paymentsGuard, percentOf, withProjectPaymentsLock, type PlanStage,
} from '@/lib/payments'
import type { PaymentsSummary } from '@/lib/payment-types'

interface Ctx { params: { id: string } }

// ─── GET /api/projects/[id]/payments ─────────────────────────────────────────

/** The project's fee, phases, receipts, totals, warnings and history. Admins only. */
export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    const g = await paymentsGuard(request, params.id)
    if ('response' in g) return g.response
    return successResponse<PaymentsSummary>(await loadPaymentsSummary(g.project.id))
  } catch (error) {
    console.error('[GET /api/projects/[id]/payments]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

type StageInput = PlanStage

/**
 * The stages of a per sq ft fee: [{ group?, name, rate }] (rupees per sq ft;
 * the amount is rate x area) or [{ group?, name, amount }] (a fixed amount,
 * e.g. landscape billed per acre). At least one, at most 100.
 */
function parseStages(raw: unknown, area: bigint): StageInput[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'Add at least one stage to the payment schedule'
  if (raw.length > 100) return 'A payment schedule can have at most 100 stages'
  const out: StageInput[] = []
  for (const s of raw as Record<string, unknown>[]) {
    const name = cleanText(s?.name, 100)
    if (name === 'too-long') return 'Stage names must be 100 characters or fewer'
    if (!name) return 'Every stage needs a name'
    const group = cleanText(s.group, 60)
    if (group === 'too-long') return 'Group names must be 60 characters or fewer'
    if (s.rate !== undefined && s.rate !== null && s.rate !== '') {
      const rate = parseRupees(s.rate)
      if (rate === null || rate <= BigInt(0)) return `Enter the rate for "${name}" in rupees per sq ft, more than 0`
      const amount = amountForArea(rate, area)
      if (amount <= BigInt(0)) return `"${name}" comes to less than one paisa at this area`
      out.push({ groupName: group, name, ratePerSqft: rate, amount })
    } else {
      const amount = parseRupees(s.amount)
      if (amount === null || amount <= BigInt(0)) return `Enter a rate per sq ft or an amount for "${name}"`
      out.push({ groupName: group, name, ratePerSqft: null, amount })
    }
  }
  return out
}

// ─── POST /api/projects/[id]/payments ────────────────────────────────────────

/**
 * Set up the project's fee, once, with the GST rate charged on every stage
 * (gstPercent, default 0):
 *   { basis: 'PER_SQFT', area, stages: [{ group?, name, rate | amount }] }
 *       the fee is the stages: rate x area each, plus any fixed ones;
 *   { basis: 'FIXED', fee }
 *   { basis: 'PERCENT', estimatedCost, percent }
 * Later changes are fee changes (POST .../payments/fee-changes), never an edit of this.
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  try {
    const g = await paymentsGuard(request, params.id)
    if ('response' in g) return g.response
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return errorResponse('Request body must be an object', 400)

    const gstBp = body.gstPercent === undefined || body.gstPercent === null || body.gstPercent === '' ? 0 : parseGstBp(body.gstPercent)
    if (gstBp === null) return errorResponse('Enter the GST rate as a percentage from 0 to 100 (for example 18)', 400)

    let basis: 'FIXED' | 'PERCENT' | 'PER_SQFT'
    let fee: bigint
    let percentBp: number | null = null
    let estimatedCost: bigint | null = null
    let area: bigint | null = null
    let stages: StageInput[] = []
    if (body.basis === 'PER_SQFT') {
      area = parseArea(body.area)
      if (area === null) return errorResponse('Enter the built-up area in sq ft, more than 0 (for example 12500 or 12,500.5)', 400)
      const parsed = parseStages(body.stages, area)
      if (typeof parsed === 'string') return errorResponse(parsed, 400)
      basis = 'PER_SQFT'; stages = parsed
      fee = stages.reduce((s, x) => s + x.amount, BigInt(0))
    } else if (body.basis === 'FIXED') {
      const v = parseRupees(body.fee)
      if (v === null || v <= BigInt(0)) return errorResponse('Enter the fee in rupees, more than 0 (for example 1500000 or 15,00,000)', 400)
      basis = 'FIXED'; fee = v
    } else if (body.basis === 'PERCENT') {
      const cost = parseRupees(body.estimatedCost)
      if (cost === null || cost <= BigInt(0)) return errorResponse('Enter the estimated construction cost in rupees, more than 0', 400)
      const bp = parsePercentBp(body.percent)
      if (bp === null) return errorResponse('Enter the fee percentage, more than 0 and at most 100, up to 2 decimals', 400)
      basis = 'PERCENT'; percentBp = bp; estimatedCost = cost; fee = percentOf(cost, bp)
      if (fee <= BigInt(0)) return errorResponse('That percentage of that cost is less than one paisa', 400)
    } else {
      return errorResponse("basis must be 'PER_SQFT', 'FIXED' or 'PERCENT'", 400)
    }

    const done = await withProjectPaymentsLock(g.project.id, (tx) =>
      createPaymentPlan(tx, g.project.id, g.payload.userId, { basis, fee, percentBp, estimatedCost, area, gstBp, stages }))
    if (!done) return errorResponse('This project already has a fee. Record a fee change instead.', 409)
    return successResponse<PaymentsSummary>(await loadPaymentsSummary(g.project.id), 201)
  } catch (error) {
    console.error('[POST /api/projects/[id]/payments]', error)
    if (isBusyError(error)) return errorResponse(BUSY_MESSAGE, 503)
    return errorResponse('An unexpected error occurred', 500)
  }
}
