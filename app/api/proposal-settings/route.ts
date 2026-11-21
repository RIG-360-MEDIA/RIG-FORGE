import { type NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/db'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { loadSettings, parseSettings, proposalsGuard } from '@/lib/proposals'
import type { ProposalSettingsData } from '@/lib/proposal-types'

// ─── GET /api/proposal-settings ─────────────────────────────────────────────

/** The company's letterhead, bank details, numbering and standard terms. Admins only. */
export async function GET(request: NextRequest) {
  try {
    const g = await proposalsGuard(request)
    if ('response' in g) return g.response
    return successResponse<{ data: ProposalSettingsData; saved: boolean }>(await loadSettings())
  } catch (error) {
    console.error('[GET /api/proposal-settings]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

// ─── PUT /api/proposal-settings ─────────────────────────────────────────────

/** Replace the settings: { firm, terms }. Proposals already sent keep the copy they were sent with. */
export async function PUT(request: NextRequest) {
  try {
    const g = await proposalsGuard(request)
    if ('response' in g) return g.response
    const parsed = parseSettings(await request.json().catch(() => null))
    if (typeof parsed === 'string') return errorResponse(parsed, 400)
    const data = parsed as unknown as Prisma.InputJsonValue
    const row = await prisma.proposalSettings.findFirst({ select: { id: true } })
    if (row) await prisma.proposalSettings.update({ where: { id: row.id }, data: { data, updatedById: g.payload.userId } })
    else await prisma.proposalSettings.create({ data: { data, updatedById: g.payload.userId } })
    return successResponse<{ data: ProposalSettingsData; saved: boolean }>(await loadSettings())
  } catch (error) {
    console.error('[PUT /api/proposal-settings]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}
