import { type NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/db'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { BUSY_MESSAGE, isBusyError } from '@/lib/task-categories'
import {
  buildContent, createWithNextSerial, draftWording, loadSettings, parseDraftInput, proposalsGuard, toViews,
} from '@/lib/proposals'
import type { ProposalView } from '@/lib/proposal-types'

interface Ctx { params: { id: string } }

// ─── GET /api/projects/[id]/proposals ───────────────────────────────────────

/** The project's proposals, newest first. Admins only. */
export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    const g = await proposalsGuard(request, params.id)
    if ('response' in g) return g.response
    const rows = await prisma.proposal.findMany({ where: { projectId: g.project!.id }, orderBy: { createdAt: 'desc' } })
    return successResponse<ProposalView[]>(await toViews(rows))
  } catch (error) {
    console.error('[GET /api/projects/[id]/proposals]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

// ─── POST /api/projects/[id]/proposals ──────────────────────────────────────

/**
 * Draft a new proposal: { client: { salutation, name, city }, projectType,
 * location, disciplines[], notes, date?, fees? }. The AI writes the
 * project-specific wording (subject, letter, brief, scope, exclusions); fees
 * and terms come from the form and Firm details, never from the AI. The
 * proposal gets the next reference number and starts as a draft.
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  try {
    const g = await proposalsGuard(request, params.id)
    if ('response' in g) return g.response
    const input = parseDraftInput(await request.json().catch(() => null))
    if (typeof input === 'string') return errorResponse(input, 400)

    const { data: settings } = await loadSettings()
    // The AI call can take a while; it runs before the numbering lock is taken.
    const text = await draftWording(input, settings.firm.name)
    const content = buildContent(input, text)

    const id = await createWithNextSerial(g.payload.organizationId, async (tx, serial, refNo) => {
      const row = await tx.proposal.create({
        data: { projectId: g.project!.id, serial, refNo, content: content as unknown as Prisma.InputJsonValue, createdById: g.payload.userId },
        select: { id: true },
      })
      return row.id
    }, input.date)
    const row = await prisma.proposal.findFirstOrThrow({ where: { id } })
    return successResponse<ProposalView>((await toViews([row]))[0]!, 201)
  } catch (error) {
    console.error('[POST /api/projects/[id]/proposals]', error)
    if (isBusyError(error)) return errorResponse(BUSY_MESSAGE, 503)
    return errorResponse('An unexpected error occurred', 500)
  }
}
