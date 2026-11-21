import { type NextRequest } from 'next/server'

import { successResponse, errorResponse } from '@/lib/api-helpers'
import { BUSY_MESSAGE, isBusyError } from '@/lib/task-categories'
import {
  allocatedByPhase, amountForArea, areaText, audit, cleanText, currentFee, loadPaymentsSummary, parseArea, parseRupees,
  paymentsGuard, percentOf, withProjectPaymentsLock,
} from '@/lib/payments'
import type { PaymentsSummary } from '@/lib/payment-types'

// ─── POST /api/projects/[id]/payments/fee-changes ────────────────────────────

/**
 * Change the fee, with a reason, as a new entry (the agreed fee is never
 * overwritten):
 *   { kind: 'VARIATION' | 'CORRECTION', amountDelta, reason }  add or remove an amount
 *   { kind: 'COST_REVISION', estimatedCost, reason }            PERCENT plans: new cost
 *       estimate; the fee moves by the percentage of the difference.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const g = await paymentsGuard(request, params.id)
    if ('response' in g) return g.response
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return errorResponse('Request body must be an object', 400)

    const reason = cleanText(body.reason, 300)
    if (reason === 'too-long') return errorResponse('The reason must be 300 characters or fewer', 400)
    if (!reason || reason.length < 3) return errorResponse('Give a reason for the fee change', 400)
    const kind = body.kind
    if (kind !== 'VARIATION' && kind !== 'CORRECTION' && kind !== 'COST_REVISION' && kind !== 'AREA_REVISION') {
      return errorResponse("kind must be 'VARIATION', 'CORRECTION', 'COST_REVISION' or 'AREA_REVISION'", 400)
    }

    const result = await withProjectPaymentsLock(g.project.id, async (tx) => {
      const plan = await tx.paymentPlan.findFirst({ where: { projectId: g.project.id } })
      if (!plan) return { error: 'Set up the fee first', status: 400 }

      // A per sq ft fee is its stages, so it changes by area (every rate stage
      // follows) or by adding a stage, not by a typed amount.
      if (plan.basis === 'PER_SQFT') {
        if (kind !== 'AREA_REVISION') return { error: 'This fee is per sq ft: revise the area, or add a stage for extra work', status: 400 }
        const area = parseArea(body.area)
        if (area === null) return { error: 'Enter the new built-up area in sq ft, more than 0', status: 400 }
        if (plan.areaCentiSqft !== null && area === plan.areaCentiSqft) return { error: 'That is the current area; nothing changes', status: 400 }
        const phases = await tx.paymentPhase.findMany({ where: { projectId: g.project.id, ratePerSqft: { not: null } } })
        const received = await allocatedByPhase(tx, g.project.id)
        let delta = BigInt(0)
        for (const p of phases) {
          const amount = amountForArea(p.ratePerSqft!, area)
          const got = received.get(p.id) ?? BigInt(0)
          if (amount + percentOf(amount, plan.gstBp) < got) {
            return { error: `${p.name} has already been paid more than it would come to at this area`, status: 400 }
          }
          if (amount <= BigInt(0)) return { error: `${p.name} would come to less than one paisa at this area`, status: 400 }
          if (p.isActive) delta += amount - p.amount
          await tx.paymentPhase.update({ where: { id: p.id }, data: { amount } })
        }
        await tx.paymentPlan.update({ where: { id: plan.id }, data: { areaCentiSqft: area } })
        await tx.paymentFeeChange.create({
          data: { planId: plan.id, kind, amountDelta: delta, areaCentiSqft: area, reason, createdById: g.payload.userId },
        })
        await audit(tx, g.project.id, g.payload.userId, 'AREA_REVISION', {
          areaFrom: plan.areaCentiSqft === null ? 'none' : areaText(plan.areaCentiSqft), areaTo: areaText(area), amountDelta: delta, reason,
        })
        return { ok: true as const }
      }
      if (kind === 'AREA_REVISION') return { error: 'An area revision is only for a fee set per sq ft', status: 400 }

      const { fee, estimatedCost } = await currentFee(tx, plan.id)

      let delta: bigint
      let newCost: bigint | null = null
      if (kind === 'COST_REVISION') {
        if (plan.basis !== 'PERCENT' || plan.percentBp === null) return { error: 'A cost revision is only for a fee set as a % of construction cost', status: 400 }
        const cost = parseRupees(body.estimatedCost)
        if (cost === null || cost <= BigInt(0)) return { error: 'Enter the new estimated construction cost in rupees, more than 0', status: 400 }
        if (estimatedCost !== null && cost === estimatedCost) return { error: 'That is the current estimate; nothing changes', status: 400 }
        // Move the fee by the change in the percentage part only, so any
        // variations added on top are kept.
        delta = percentOf(cost, plan.percentBp) - percentOf(estimatedCost ?? BigInt(0), plan.percentBp)
        newCost = cost
      } else {
        const v = parseRupees(body.amountDelta, { signed: true })
        if (v === null || v === BigInt(0)) return { error: 'Enter the amount to add (or a negative amount to reduce the fee), not 0', status: 400 }
        delta = v
      }
      if (fee + delta < BigInt(0)) return { error: 'The fee cannot go below 0', status: 400 }

      await tx.paymentFeeChange.create({
        data: { planId: plan.id, kind, amountDelta: delta, estimatedCost: newCost, reason, createdById: g.payload.userId },
      })
      await audit(tx, g.project.id, g.payload.userId, 'FEE_CHANGE', { kind, amountDelta: delta, feeAfter: fee + delta, estimatedCost: newCost, reason })
      return { ok: true as const }
    })
    if ('error' in result) return errorResponse(result.error as string, result.status as number)
    return successResponse<PaymentsSummary>(await loadPaymentsSummary(g.project.id), 201)
  } catch (error) {
    console.error('[POST /api/projects/[id]/payments/fee-changes]', error)
    if (isBusyError(error)) return errorResponse(BUSY_MESSAGE, 503)
    return errorResponse('An unexpected error occurred', 500)
  }
}
