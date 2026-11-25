import { type NextRequest } from 'next/server'

import { prisma } from '@/lib/db'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { getOrgId } from '@/lib/tenant-context'
import { BUSY_MESSAGE, TX_OPTIONS, isBusyError } from '@/lib/task-categories'
import { amountForArea, createPaymentPlan, parseArea, type PlanStage } from '@/lib/payments'
import { proposalsGuard, toViews } from '@/lib/proposals'
import { suggestedProjectName, type ProposalContent, type ProposalView } from '@/lib/proposal-types'

/** Rupees with up to 2 decimals to paise, exactly. */
const toPaise = (rupees: number) => BigInt(Math.round(rupees * 100))
const HTML_TAG_RE = /<[^>]+>/

// ─── POST /api/proposals/[proposalId]/accept ────────────────────────────────

/**
 * The client accepted: { area, landscapeAcres?, projectId? | projectName? }.
 * With projectId the proposal is linked to that existing project; otherwise a
 * new project is created (named projectName, or after the client and site),
 * with the person accepting as its lead. Then the project's payments are set
 * up from the fee table: every stage at its rate per sq ft x the area,
 * landscape (acres x rate per acre) as a fixed stage, GST as quoted. If the
 * project already has a fee, the proposal is still accepted and payments are
 * left as they are.
 */
export async function POST(request: NextRequest, { params }: { params: { proposalId: string } }) {
  try {
    const g = await proposalsGuard(request)
    if ('response' in g) return g.response
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    const area = parseArea(body?.area)
    if (area === null) return errorResponse('Enter the built-up area in sq ft to work out the fee, more than 0', 400)
    let acres: bigint | null = null
    if (body?.landscapeAcres !== undefined && body.landscapeAcres !== null && body.landscapeAcres !== '') {
      acres = parseArea(body.landscapeAcres) // same rule: up to 2 decimals, more than 0
      if (acres === null) return errorResponse('Enter the landscape area in acres, more than 0, or leave it empty', 400)
    }
    const existingId = typeof body?.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : null
    let newName: string | null = null
    if (!existingId && body?.projectName !== undefined && body.projectName !== null && body.projectName !== '') {
      if (typeof body.projectName !== 'string' || !body.projectName.trim() || body.projectName.length > 100) return errorResponse('The project name must be 1 to 100 characters', 400)
      if (HTML_TAG_RE.test(body.projectName)) return errorResponse('The project name must not contain HTML', 400)
      newName = body.projectName.trim()
    }
    const userId = g.payload.userId

    const result = await prisma.$transaction(async (tx) => {
      // One acceptance at a time per proposal; and per project, the same lock as payments.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`proposal-accept:${params.proposalId}`}))`
      const row = await tx.proposal.findFirst({ where: { id: params.proposalId } })
      if (!row) return { error: 'Proposal not found', status: 404 }
      if (row.status === 'ACCEPTED') return { error: 'This proposal is already accepted', status: 409 }
      if (row.status !== 'SENT' && row.status !== 'DRAFT') return { error: 'A declined proposal cannot be accepted; reopen it first', status: 409 }
      const c = row.content as unknown as ProposalContent

      let projectId: string
      let projectCreated = false
      if (existingId) {
        const p = await tx.project.findFirst({ where: { id: existingId, isActive: true }, select: { id: true } })
        if (!p) return { error: 'That project was not found', status: 404 }
        projectId = p.id
      } else {
        // Nested creates are not stamped by the tenant extension: give them the org explicitly.
        const p = await tx.project.create({
          data: {
            name: newName ?? suggestedProjectName(c),
            description: `${c.subject}`.slice(0, 500),
            status: 'ACTIVE', priority: 'MEDIUM', leadId: userId, siteLocation: c.location.slice(0, 200),
            members: { create: [{ userId, organizationId: getOrgId() }] },
            thread: { create: { organizationId: getOrgId() } },
          },
          select: { id: true },
        })
        projectId = p.id
        projectCreated = true
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payments:${projectId}`}))`

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

      const paymentsCreated = await createPaymentPlan(tx, projectId, userId, {
        basis: 'PER_SQFT', fee, percentBp: null, estimatedCost: null, area, gstBp: Math.round(c.fees.gstPercent * 100), stages,
        source: `Proposal ${row.refNo} accepted`,
      })
      await tx.proposal.update({ where: { id: row.id }, data: { status: 'ACCEPTED', acceptedAt: new Date(), sentAt: row.sentAt ?? new Date(), projectId } })
      return { ok: true as const, paymentsCreated, projectId, projectCreated }
    }, TX_OPTIONS)
    if ('error' in result) return errorResponse(result.error as string, result.status as number)
    const fresh = await prisma.proposal.findFirstOrThrow({ where: { id: params.proposalId } })
    return successResponse<{ proposal: ProposalView; paymentsCreated: boolean; projectId: string; projectCreated: boolean }>({
      proposal: (await toViews([fresh]))[0]!, paymentsCreated: result.paymentsCreated, projectId: result.projectId, projectCreated: result.projectCreated,
    })
  } catch (error) {
    console.error('[POST /api/proposals/[proposalId]/accept]', error)
    if (isBusyError(error)) return errorResponse(BUSY_MESSAGE, 503)
    return errorResponse('An unexpected error occurred', 500)
  }
}
