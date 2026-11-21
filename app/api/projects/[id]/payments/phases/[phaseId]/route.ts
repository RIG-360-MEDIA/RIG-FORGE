import { type NextRequest } from 'next/server'

import { successResponse, errorResponse } from '@/lib/api-helpers'
import { BUSY_MESSAGE, isBusyError } from '@/lib/task-categories'
import {
  allocatedByPhase, amountForArea, audit, cleanText, loadPaymentsSummary, parseDay, parseRupees, paymentsGuard, percentOf,
  withProjectPaymentsLock,
} from '@/lib/payments'
import type { PaymentsSummary } from '@/lib/payment-types'

// ─── PATCH /api/projects/[id]/payments/phases/[phaseId] ──────────────────────

/**
 * Change a phase: { name?, amount?, dueDate? (null clears), note?, sortOrder?,
 * isActive? }. The amount can never go below what has already been received
 * against the phase, and a phase with money counted against it cannot be
 * archived (reverse or that money stays visible). Every change is logged.
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string; phaseId: string } }) {
  try {
    const g = await paymentsGuard(request, params.id)
    if ('response' in g) return g.response
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return errorResponse('Request body must be an object', 400)

    const result = await withProjectPaymentsLock(g.project.id, async (tx) => {
      const phase = await tx.paymentPhase.findFirst({ where: { id: params.phaseId, projectId: g.project.id } })
      if (!phase) return { error: 'Stage not found', status: 404 }
      const received = (await allocatedByPhase(tx, g.project.id)).get(phase.id) ?? BigInt(0)
      const plan = await tx.paymentPlan.findFirst({ where: { projectId: g.project.id }, select: { gstBp: true, areaCentiSqft: true } })
      const gstBp = plan?.gstBp ?? 0
      const tooLow = (amount: bigint) => amount + percentOf(amount, gstBp) < received

      const data: {
        name?: string; groupName?: string | null; amount?: bigint; ratePerSqft?: bigint; dueDate?: Date | null
        note?: string | null; sortOrder?: number; isActive?: boolean
      } = {}
      const changes: Record<string, unknown> = {}
      if ('group' in body) {
        const group = cleanText(body.group, 60)
        if (group === 'too-long') return { error: 'The group name must be 60 characters or fewer', status: 400 }
        if (group !== phase.groupName) { data.groupName = group; changes.group = { from: phase.groupName, to: group } }
      }
      if ('rate' in body) {
        if (phase.ratePerSqft === null || !plan?.areaCentiSqft) return { error: 'This stage is a fixed amount; change its amount instead', status: 400 }
        const rate = parseRupees(body.rate)
        if (rate === null || rate <= BigInt(0)) return { error: 'Enter the rate in rupees per sq ft, more than 0', status: 400 }
        const amount = amountForArea(rate, plan.areaCentiSqft)
        if (tooLow(amount)) return { error: `${phase.name} has already been paid more than that. It cannot be set below what was paid.`, status: 400 }
        if (rate !== phase.ratePerSqft) { data.ratePerSqft = rate; data.amount = amount; changes.rate = { from: phase.ratePerSqft, to: rate } }
      }
      if ('name' in body) {
        const name = cleanText(body.name, 100)
        if (name === 'too-long') return { error: 'The stage name must be 100 characters or fewer', status: 400 }
        if (!name) return { error: 'The stage needs a name', status: 400 }
        if (name !== phase.name) { data.name = name; changes.name = { from: phase.name, to: name } }
      }
      if ('amount' in body) {
        if (phase.ratePerSqft !== null) return { error: 'This stage follows the area; change its rate per sq ft instead', status: 400 }
        const amount = parseRupees(body.amount)
        if (amount === null || amount <= BigInt(0)) return { error: 'Enter the stage amount in rupees, more than 0', status: 400 }
        if (tooLow(amount)) return { error: `${phase.name} has already been paid more than that. It cannot be set below what was paid.`, status: 400 }
        if (amount !== phase.amount) { data.amount = amount; changes.amount = { from: phase.amount, to: amount } }
      }
      if ('dueDate' in body) {
        const due = body.dueDate === null || body.dueDate === '' ? null : parseDay(body.dueDate)
        if (body.dueDate && !due) return { error: 'The due date is not a valid date', status: 400 }
        if ((due?.getTime() ?? null) !== (phase.dueDate?.getTime() ?? null)) { data.dueDate = due; changes.dueDate = { from: phase.dueDate, to: due } }
      }
      if ('note' in body) {
        const note = cleanText(body.note, 300)
        if (note === 'too-long') return { error: 'The note must be 300 characters or fewer', status: 400 }
        if (note !== phase.note) { data.note = note; changes.note = true }
      }
      if ('sortOrder' in body) {
        if (!Number.isInteger(body.sortOrder)) return { error: 'sortOrder must be a whole number', status: 400 }
        if (body.sortOrder !== phase.sortOrder) { data.sortOrder = body.sortOrder as number; changes.order = true }
      }
      let action = 'PHASE_EDIT'
      if ('isActive' in body) {
        if (typeof body.isActive !== 'boolean') return { error: 'isActive must be true or false', status: 400 }
        if (!body.isActive && phase.isActive) {
          if (received > BigInt(0)) return { error: `${phase.name} has payments linked to it, so it cannot be removed.`, status: 400 }
          data.isActive = false; action = 'PHASE_ARCHIVE'
        } else if (body.isActive && !phase.isActive) {
          data.isActive = true; action = 'PHASE_RESTORE'
        }
      }
      if (Object.keys(data).length === 0) return { ok: true as const }

      await tx.paymentPhase.update({ where: { id: phase.id }, data })
      // Reordering alone is not worth a history line.
      if (action !== 'PHASE_EDIT' || Object.keys(changes).some((k) => k !== 'order')) {
        await audit(tx, g.project.id, g.payload.userId, action, { name: data.name ?? phase.name, changes })
      }
      return { ok: true as const }
    })
    if ('error' in result) return errorResponse(result.error as string, result.status as number)
    return successResponse<PaymentsSummary>(await loadPaymentsSummary(g.project.id))
  } catch (error) {
    console.error('[PATCH /api/projects/[id]/payments/phases/[phaseId]]', error)
    if (isBusyError(error)) return errorResponse(BUSY_MESSAGE, 503)
    return errorResponse('An unexpected error occurred', 500)
  }
}
