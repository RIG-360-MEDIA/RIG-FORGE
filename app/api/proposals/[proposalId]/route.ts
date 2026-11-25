import { type NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/db'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import {
  addLines, buildContent, draftWording, findProposal, loadSettings, parseContent, proposalsGuard, settingsFor, toViews,
  type DraftInput,
} from '@/lib/proposals'
import type { ProposalContent, ProposalSettingsData, ProposalStatus, ProposalView } from '@/lib/proposal-types'

interface Ctx { params: { proposalId: string } }

// ─── GET ─────────────────────────────────────────────────────────────────────

/** One proposal, with the firm details and terms to print it with (its frozen copy once sent). */
export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    const g = await proposalsGuard(request)
    if ('response' in g) return g.response
    const row = await findProposal(params.proposalId)
    if (!row) return errorResponse('Proposal not found', 404)
    const view = (await toViews([row]))[0]!
    return successResponse<{ proposal: ProposalView; settings: ProposalSettingsData }>({ proposal: view, settings: await settingsFor(view.content) })
  } catch (error) {
    console.error('[GET /api/proposals/[proposalId]]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

// ─── PATCH ───────────────────────────────────────────────────────────────────

/**
 * { content }           save edits (drafts only)
 * { redraft: true }     rewrite the wording with AI from the same inputs (drafts only)
 * { status: 'SENT' }    mark as sent: the firm details and terms are frozen into it
 * { status: 'DRAFT' }   reopen a sent or declined proposal for changes
 * { status: 'DECLINED' }
 * Accepting is POST .../accept (it also creates or links the project and its payments).
 */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    const g = await proposalsGuard(request)
    if ('response' in g) return g.response
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return errorResponse('Request body must be an object', 400)
    const row = await findProposal(params.proposalId)
    if (!row) return errorResponse('Proposal not found', 404)
    const status = row.status as ProposalStatus
    const content = row.content as unknown as ProposalContent
    const data: Prisma.ProposalUpdateInput = {}

    if ('content' in body) {
      if (status !== 'DRAFT') return errorResponse('Only a draft can be edited. Reopen it as a draft first.', 409)
      const next = parseContent(body.content, content)
      if (typeof next === 'string') return errorResponse(next, 400)
      data.content = next as unknown as Prisma.InputJsonValue
    } else if (body.redraft === true) {
      if (status !== 'DRAFT') return errorResponse('Only a draft can be rewritten', 409)
      const { data: settings } = await loadSettings()
      const input: DraftInput = {
        date: content.date, client: content.client, projectType: content.projectType, location: content.location,
        disciplines: content.disciplines, notes: typeof body.notes === 'string' ? body.notes.slice(0, 2000) : content.notes ?? '',
        fees: { ...content.fees, exclusions: [] },
      }
      const text = await draftWording(input, settings.firm.name)
      const fresh = buildContent(input, text)
      // Keep the fees exactly as edited; only the wording and AI exclusions change.
      const exclusions = addLines(content.fees.exclusions, text.exclusions ?? [])
      data.content = { ...fresh, fees: { ...content.fees, exclusions } } as unknown as Prisma.InputJsonValue
    } else if (body.status === 'SENT') {
      if (status !== 'DRAFT') return errorResponse('Only a draft can be marked as sent', 409)
      const { data: settings } = await loadSettings()
      data.status = 'SENT'; data.sentAt = new Date()
      data.content = { ...content, firm: settings.firm, terms: settings.terms } as unknown as Prisma.InputJsonValue
    } else if (body.status === 'DRAFT') {
      if (status !== 'SENT' && status !== 'DECLINED') return errorResponse('Only a sent or declined proposal can be reopened', 409)
      const { firm: _f, terms: _t, ...rest } = content
      data.status = 'DRAFT'; data.sentAt = null
      data.content = rest as unknown as Prisma.InputJsonValue
    } else if (body.status === 'DECLINED') {
      if (status !== 'SENT') return errorResponse('Only a sent proposal can be marked declined', 409)
      data.status = 'DECLINED'
    } else {
      return errorResponse('Nothing to change', 400)
    }

    // Only change it if nobody else changed it meanwhile.
    const done = await prisma.proposal.updateMany({ where: { id: row.id, status: row.status, updatedAt: row.updatedAt }, data: data as Prisma.ProposalUpdateManyMutationInput })
    if (done.count === 0) return errorResponse('Someone else changed this proposal just now. Reload and try again.', 409)
    const fresh = await prisma.proposal.findFirstOrThrow({ where: { id: row.id } })
    return successResponse<ProposalView>((await toViews([fresh]))[0]!)
  } catch (error) {
    console.error('[PATCH /api/proposals/[proposalId]]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

/** Delete a draft that was never sent. Its reference number is not reused. */
export async function DELETE(request: NextRequest, { params }: Ctx) {
  try {
    const g = await proposalsGuard(request)
    if ('response' in g) return g.response
    const done = await prisma.proposal.deleteMany({ where: { id: params.proposalId, status: 'DRAFT' } })
    if (done.count === 0) return errorResponse('Only a draft can be deleted', 409)
    return successResponse<{ id: string }>({ id: params.proposalId })
  } catch (error) {
    console.error('[DELETE /api/proposals/[proposalId]]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}
