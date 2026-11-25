import { type NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/db'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { BUSY_MESSAGE, isBusyError } from '@/lib/task-categories'
import {
  buildContent, createWithNextSerial, draftWording, loadSettings, parseDraftInput, proposalsGuard, toViews,
} from '@/lib/proposals'
import type { ProposalView } from '@/lib/proposal-types'

// Fee proposals live in Workspace, not inside a project: a proposal goes to a
// client first, and the project is created (or picked) when the client accepts.

// ─── GET /api/proposals ─────────────────────────────────────────────────────

/** The company's proposals, newest first. Admins only. */
export async function GET(request: NextRequest) {
  try {
    const g = await proposalsGuard(request)
    if ('response' in g) return g.response
    const rows = await prisma.proposal.findMany({ orderBy: [{ createdAt: 'desc' }], take: 500 })
    return successResponse<ProposalView[]>(await toViews(rows))
  } catch (error) {
    console.error('[GET /api/proposals]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

// ─── POST /api/proposals ────────────────────────────────────────────────────

/**
 * Draft a new proposal: { client: { salutation, name, city }, projectType,
 * location, disciplines[], notes, date?, fees? }. The AI writes the
 * project-specific wording (subject, letter, brief, scope, exclusions); fees
 * and terms come from the form and Firm details, never from the AI. The
 * proposal gets the next reference number of its financial year and starts
 * as a draft.
 */
export async function POST(request: NextRequest) {
  try {
    const g = await proposalsGuard(request)
    if ('response' in g) return g.response
    const input = parseDraftInput(await request.json().catch(() => null))
    if (typeof input === 'string') return errorResponse(input, 400)

    const { data: settings } = await loadSettings()
    // The AI call can take a while; it runs before the numbering lock is taken.
    const text = await draftWording(input, settings.firm.name)
    const content = buildContent(input, text)

    const id = await createWithNextSerial(g.payload.organizationId, async (tx, serial, refNo, fy) => {
      const row = await tx.proposal.create({
        data: { fy, serial, refNo, content: content as unknown as Prisma.InputJsonValue, createdById: g.payload.userId },
        select: { id: true },
      })
      return row.id
    }, input.date)
    const row = await prisma.proposal.findFirstOrThrow({ where: { id } })
    return successResponse<ProposalView>((await toViews([row]))[0]!, 201)
  } catch (error) {
    console.error('[POST /api/proposals]', error)
    if (isBusyError(error)) return errorResponse(BUSY_MESSAGE, 503)
    return errorResponse('An unexpected error occurred', 500)
  }
}
