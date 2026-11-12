import { type NextRequest } from 'next/server'

import { successResponse, errorResponse } from '@/lib/api-helpers'
import { BUSY_MESSAGE, isBusyError } from '@/lib/task-categories'
import {
  audit, cleanText, currentFee, loadPaymentsSummary, parseDay, parsePercentBp, parseRupees, paymentsGuard, percentOf,
  withProjectPaymentsLock,
} from '@/lib/payments'
import type { PaymentsSummary } from '@/lib/payment-types'

// ─── POST /api/projects/[id]/payments/phases ─────────────────────────────────

/**
 * Add a billing phase: { name, amount } or { name, percent } (of the current
 * fee), plus optional { dueDate: 'YYYY-MM-DD', note }. New phases go last.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const g = await paymentsGuard(request, params.id)
    if ('response' in g) return g.response
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return errorResponse('Request body must be an object', 400)

    const name = cleanText(body.name, 100)
    if (name === 'too-long') return errorResponse('The phase name must be 100 characters or fewer', 400)
    if (!name) return errorResponse('Give the phase a name', 400)
    const note = cleanText(body.note, 300)
    if (note === 'too-long') return errorResponse('The note must be 300 characters or fewer', 400)
    let dueDate: Date | null = null
    if (body.dueDate) {
      dueDate = parseDay(body.dueDate)
      if (!dueDate) return errorResponse('The due date is not a valid date', 400)
    }

    const result = await withProjectPaymentsLock(g.project.id, async (tx) => {
      const plan = await tx.paymentPlan.findFirst({ where: { projectId: g.project.id }, select: { id: true } })
      if (!plan) return { error: 'Set up the fee first' }
      let amount: bigint | null
      if (body.percent !== undefined && body.percent !== '' && body.percent !== null) {
        const bp = parsePercentBp(body.percent)
        if (bp === null) return { error: 'Enter the percentage of the fee, more than 0 and at most 100' }
        amount = percentOf((await currentFee(tx, plan.id)).fee, bp)
      } else {
        amount = parseRupees(body.amount)
      }
      if (amount === null || amount <= BigInt(0)) return { error: 'Enter the phase amount in rupees (or a % of the fee), more than 0' }

      const last = await tx.paymentPhase.aggregate({ where: { projectId: g.project.id }, _max: { sortOrder: true } })
      await tx.paymentPhase.create({
        data: { projectId: g.project.id, name, amount, dueDate, note, sortOrder: (last._max.sortOrder ?? -1) + 1 },
      })
      await audit(tx, g.project.id, g.payload.userId, 'PHASE_ADD', { name, amount, dueDate })
      return { ok: true as const }
    })
    if ('error' in result) return errorResponse(result.error as string, 400)
    return successResponse<PaymentsSummary>(await loadPaymentsSummary(g.project.id), 201)
  } catch (error) {
    console.error('[POST /api/projects/[id]/payments/phases]', error)
    if (isBusyError(error)) return errorResponse(BUSY_MESSAGE, 503)
    return errorResponse('An unexpected error occurred', 500)
  }
}
