import { type NextRequest } from 'next/server'

import { prisma } from '@/lib/db'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { BUSY_MESSAGE, isBusyError } from '@/lib/task-categories'
import { amountForArea, createPaymentPlan, parseArea, withProjectPaymentsLock, type PlanStage } from '@/lib/payments'
import { proposalsGuard, toViews } from '@/lib/proposals'
import type { ProposalContent, ProposalView } from '@/lib/proposal-types'

/** Rupees with up to 2 decimals to paise, exactly. */
const toPaise = (rupees: number) => BigInt(Math.round(rupees * 100))

// ─── POST /api/projects/[id]/proposals/[proposalId]/accept ──────────────────

/**
 * The client accepted: { area, landscapeAcres? }. Marks the proposal
 * accepted and sets up the project's payments from its fee table: every
 * stage at its rate per sq ft x the area, landscape (acres x rate per acre)
 * as a fixed stage, GST as quoted. If the project already has a fee, the
 * proposal is still marked accepted and payments are left as they are.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string; proposalId: string } }) {
  try {
    const g = await proposalsGuard(request, params.id)
    if ('response' in g) return g.response
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    const area = parseArea(body?.area)
    if (area === null) return errorResponse('Enter the built-up area in sq ft to work out the fee, more than 0', 400)
    let acres: bigint | null = null
    if (body?.landscapeAcres !== undefined && body.landscapeAcres !== null && body.landscapeAcres !== '') {
      acres = parseArea(body.landscapeAcres) // same rule: up to 2 decimals, more than 0
      if (acres === null) return errorResponse('Enter the landscape area in acres, more than 0, or leave it empty', 400)
    }
    const projectId = g.project!.id

    const result = await withProjectPaymentsLock(projectId, async (tx) => {
      const row = await tx.proposal.findFirst({ where: { id: params.proposalId, projectId } })
      if (!row) return { error: 'Proposal not found', status: 404 }
      if (row.status === 'ACCEPTED') return { error: 'This proposal is already accepted', status: 409 }
      if (row.status !== 'SENT' && row.status !== 'DRAFT') return { error: 'A declined proposal cannot be accepted; reopen it first', status: 409 }
      const c = row.content as unknown as ProposalContent

      const stages: PlanStage[] = c.fees.stages.map((s) => {
        const rate = toPaise(s.rate)
        return { groupName: s.group, name: s.name, ratePerSqft: rate, amount: amountForArea(rate, area) }
      })
      if (acres !== null && c.fees.landscapePerAcre) {
        const amount = (toPaise(c.fees.landscapePerAcre) * acres + BigInt(50)) / BigInt(100)
        stages.push({ groupName: 'Landscape', name: `Landscape design (${Number(acres) / 100} acres)`, ratePerSqft: null, amount })
      }
      if (stages.some((s) => s.amount <= BigInt(0))) return { error: 'At this area some stages come to less than one paisa', status: 400 }
      const fee = stages.reduce((s, x) => s + x.amount, BigInt(0))

      const created = await createPaymentPlan(tx, projectId, g.payload.userId, {
        basis: 'PER_SQFT', fee, percentBp: null, estimatedCost: null, area, gstBp: Math.round(c.fees.gstPercent * 100), stages,
        source: `Proposal ${row.refNo} accepted`,
      })
      await tx.proposal.update({ where: { id: row.id }, data: { status: 'ACCEPTED', acceptedAt: new Date(), sentAt: row.sentAt ?? new Date() } })
      return { ok: true as const, paymentsCreated: created }
    })
    if ('error' in result) return errorResponse(result.error as string, result.status as number)
    const fresh = await prisma.proposal.findFirstOrThrow({ where: { id: params.proposalId } })
    return successResponse<{ proposal: ProposalView; paymentsCreated: boolean }>({ proposal: (await toViews([fresh]))[0]!, paymentsCreated: result.paymentsCreated })
  } catch (error) {
    console.error('[POST /api/projects/[id]/proposals/[proposalId]/accept]', error)
    if (isBusyError(error)) return errorResponse(BUSY_MESSAGE, 503)
    return errorResponse('An unexpected error occurred', 500)
  }
}
