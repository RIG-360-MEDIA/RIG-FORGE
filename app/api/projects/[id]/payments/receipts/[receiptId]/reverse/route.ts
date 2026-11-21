import { type NextRequest } from 'next/server'

import { successResponse, errorResponse } from '@/lib/api-helpers'
import { BUSY_MESSAGE, isBusyError } from '@/lib/task-categories'
import { audit, cleanText, loadPaymentsSummary, paymentsGuard, withProjectPaymentsLock } from '@/lib/payments'
import type { PaymentsSummary } from '@/lib/payment-types'

// ─── POST /api/projects/[id]/payments/receipts/[receiptId]/reverse ──────────

/**
 * Reverse a receipt recorded by mistake: { reason }. The receipt and what it
 * was counted against stay in the history, marked reversed, and stop counting
 * toward every total. A receipt is reversed once; it is never edited or
 * deleted, so the record of what happened cannot be rewritten.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string; receiptId: string } }) {
  try {
    const g = await paymentsGuard(request, params.id)
    if ('response' in g) return g.response
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    const reason = cleanText(body?.reason, 300)
    if (reason === 'too-long') return errorResponse('The reason must be 300 characters or fewer', 400)
    if (!reason || reason.length < 3) return errorResponse('Give a reason for cancelling this entry', 400)

    const result = await withProjectPaymentsLock(g.project.id, async (tx) => {
      const receipt = await tx.paymentReceipt.findFirst({ where: { id: params.receiptId, projectId: g.project.id } })
      if (!receipt) return { error: 'Payment not found', status: 404 }
      if (receipt.reversedAt) return { error: 'This payment entry was already cancelled', status: 409 }
      await tx.paymentReceipt.update({
        where: { id: receipt.id },
        data: { reversedAt: new Date(), reversedById: g.payload.userId, reversalReason: reason },
      })
      await audit(tx, g.project.id, g.payload.userId, 'REVERSE', { receiptId: receipt.id, amount: receipt.amount, reason })
      return { ok: true as const }
    })
    if ('error' in result) return errorResponse(result.error as string, result.status as number)
    return successResponse<PaymentsSummary>(await loadPaymentsSummary(g.project.id))
  } catch (error) {
    console.error('[POST /api/projects/[id]/payments/receipts/[receiptId]/reverse]', error)
    if (isBusyError(error)) return errorResponse(BUSY_MESSAGE, 503)
    return errorResponse('An unexpected error occurred', 500)
  }
}
