import { type NextRequest } from 'next/server'

import { successResponse, errorResponse } from '@/lib/api-helpers'
import { BUSY_MESSAGE, isBusyError } from '@/lib/task-categories'
import { audit, checkAllocations, loadPaymentsSummary, paymentsGuard, withProjectPaymentsLock } from '@/lib/payments'
import type { PaymentsSummary } from '@/lib/payment-types'

// ─── POST /api/projects/[id]/payments/receipts/[receiptId]/allocate ─────────

/**
 * Count money that is on account (received but not yet against any phase)
 * against phases: { allocations: [{ phaseId, amount }] }. Only the part of
 * the receipt still on account can be used; earlier allocations never change.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string; receiptId: string } }) {
  try {
    const g = await paymentsGuard(request, params.id)
    if ('response' in g) return g.response
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body || !Array.isArray(body.allocations) || body.allocations.length === 0) {
      return errorResponse('Choose at least one phase and amount', 400)
    }

    const result = await withProjectPaymentsLock(g.project.id, async (tx) => {
      const receipt = await tx.paymentReceipt.findFirst({
        where: { id: params.receiptId, projectId: g.project.id },
        include: { allocations: { select: { amount: true } } },
      })
      if (!receipt) return { error: 'Payment not found', status: 404 }
      if (receipt.reversedAt) return { error: 'This payment was reversed', status: 409 }
      const onAccount = receipt.amount - receipt.allocations.reduce((s, a) => s + a.amount, BigInt(0))
      if (onAccount <= BigInt(0)) return { error: 'All of this payment is already counted against phases', status: 409 }
      const checked = await checkAllocations(tx, g.project.id, body.allocations, onAccount)
      if ('error' in checked) return { error: checked.error, status: 400 }
      await tx.paymentAllocation.createMany({
        data: checked.rows.map((r) => ({ receiptId: receipt.id, phaseId: r.phaseId, amount: r.amount, createdById: g.payload.userId })),
      })
      await audit(tx, g.project.id, g.payload.userId, 'ALLOCATE', { receiptId: receipt.id, total: checked.total })
      return { ok: true as const }
    })
    if ('error' in result) return errorResponse(result.error as string, result.status as number)
    return successResponse<PaymentsSummary>(await loadPaymentsSummary(g.project.id))
  } catch (error) {
    console.error('[POST /api/projects/[id]/payments/receipts/[receiptId]/allocate]', error)
    if (isBusyError(error)) return errorResponse(BUSY_MESSAGE, 503)
    return errorResponse('An unexpected error occurred', 500)
  }
}
