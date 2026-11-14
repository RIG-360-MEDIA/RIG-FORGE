import { type NextRequest } from 'next/server'

import { successResponse, errorResponse } from '@/lib/api-helpers'
import { BUSY_MESSAGE, isBusyError } from '@/lib/task-categories'
import {
  PAYMENT_MODE_VALUES, audit, checkAllocations, cleanText, loadPaymentsSummary, parseDay, parseRupees, paymentsGuard,
  withProjectPaymentsLock,
} from '@/lib/payments'
import { formatInr, type PaymentMode, type PaymentsSummary } from '@/lib/payment-types'

// ─── POST /api/projects/[id]/payments/receipts ───────────────────────────────

/**
 * Record money received: { receivedOn: 'YYYY-MM-DD', amount, mode,
 * tds?, reference?, payer?, note?, allocations?: [{ phaseId, amount }],
 * confirmDuplicate? }. What is not counted against a phase stays on account.
 *
 * A receipt with the same amount and the same reference, or the same amount
 * on the same day, as one already recorded (and not reversed) is refused with
 * 409 code DUPLICATE unless confirmDuplicate is true: two people entering
 * the same cheque is the most likely mistake.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const g = await paymentsGuard(request, params.id)
    if ('response' in g) return g.response
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return errorResponse('Request body must be an object', 400)

    const receivedOn = parseDay(body.receivedOn)
    if (!receivedOn) return errorResponse('Enter the date the payment was received', 400)
    const tomorrow = new Date(); tomorrow.setUTCHours(0, 0, 0, 0); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    if (receivedOn > tomorrow) return errorResponse('The received date cannot be in the future', 400)
    if (receivedOn.getUTCFullYear() < 2000) return errorResponse('The received date is too far in the past', 400)
    const amount = parseRupees(body.amount)
    if (amount === null || amount <= BigInt(0)) return errorResponse('Enter the amount received in rupees, more than 0', 400)
    // TDS the client deducted: optional, counts as paid on top of the money.
    let tds = BigInt(0)
    if (body.tds !== undefined && body.tds !== null && body.tds !== '') {
      const v = parseRupees(body.tds)
      if (v === null) return errorResponse('Enter the TDS deducted in rupees, or leave it empty', 400)
      if (v > amount * BigInt(4)) return errorResponse('The TDS looks too large for this payment; check the amounts', 400)
      tds = v
    }
    if (!PAYMENT_MODE_VALUES.includes(body.mode as PaymentMode)) return errorResponse('Choose how it was paid', 400)
    const reference = cleanText(body.reference, 100)
    const payer = cleanText(body.payer, 100)
    const note = cleanText(body.note, 500)
    if (reference === 'too-long' || payer === 'too-long' || note === 'too-long') {
      return errorResponse('Reference and payer must be 100 characters or fewer, the note 500', 400)
    }

    const result = await withProjectPaymentsLock(g.project.id, async (tx) => {
      if (!(await tx.paymentPlan.findFirst({ where: { projectId: g.project.id }, select: { id: true } }))) {
        return { error: 'Set up the fee first', status: 400 }
      }
      if (body.confirmDuplicate !== true) {
        const same = await tx.paymentReceipt.findFirst({
          where: {
            projectId: g.project.id, reversedAt: null, amount,
            OR: [{ receivedOn }, ...(reference ? [{ reference: { equals: reference, mode: 'insensitive' as const } }] : [])],
          },
          select: { receivedOn: true, reference: true },
        })
        if (same) {
          return {
            error: `A payment of ${formatInr(Number(amount))} ${same.reference && reference && same.reference.toLowerCase() === reference.toLowerCase() ? `with reference ${same.reference}` : `on ${same.receivedOn.toISOString().slice(0, 10)}`} is already recorded. Record it again only if it is a separate payment.`,
            status: 409, code: 'DUPLICATE',
          }
        }
      }
      const checked = await checkAllocations(tx, g.project.id, body.allocations, amount + tds)
      if ('error' in checked) return { error: checked.error, status: 400 }

      const receipt = await tx.paymentReceipt.create({
        data: { projectId: g.project.id, receivedOn, amount, tds, mode: body.mode as string, reference, payer, note, createdById: g.payload.userId },
      })
      if (checked.rows.length) {
        await tx.paymentAllocation.createMany({
          data: checked.rows.map((r) => ({ receiptId: receipt.id, phaseId: r.phaseId, amount: r.amount, createdById: g.payload.userId })),
        })
      }
      await audit(tx, g.project.id, g.payload.userId, 'RECEIPT', {
        receiptId: receipt.id, amount, tds, mode: body.mode, reference, receivedOn, allocated: checked.total, onAccount: amount + tds - checked.total,
      })
      return { ok: true as const }
    })
    if ('error' in result) {
      if (result.code === 'DUPLICATE') {
        return Response.json({ data: null, error: result.error, code: 'DUPLICATE' }, { status: 409 })
      }
      return errorResponse(result.error as string, result.status as number)
    }
    return successResponse<PaymentsSummary>(await loadPaymentsSummary(g.project.id), 201)
  } catch (error) {
    console.error('[POST /api/projects/[id]/payments/receipts]', error)
    if (isBusyError(error)) return errorResponse(BUSY_MESSAGE, 503)
    return errorResponse('An unexpected error occurred', 500)
  }
}
