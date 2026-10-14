/**
 * GET /api/assistant/standup-digest
 *
 * Returns today's standup digest if one exists, else the most recent.
 * Used by the dashboard standup card.
 */

import { type NextRequest } from 'next/server'

import { prisma } from '@/lib/db'
import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { istDateOnly } from '@/lib/date-ist'
import { getOrgId } from '@/lib/tenant-context'

export async function GET(request: NextRequest) {
  const token = getTokenFromCookies(request)
  if (!token) return errorResponse('Authentication required', 401)
  const claims = verifyToken(token)
  if (!claims) return errorResponse('Invalid or expired session', 401)

  // Keyed to the IST day, the same key the cron writes.
  const today = istDateOnly()

  const todays = await prisma.standupDigest.findUnique({
    where: { organizationId_date: { organizationId: getOrgId(), date: today } },
    select: { id: true, date: true, summary: true, generatedAt: true },
  })
  if (todays) {
    return successResponse({ digest: todays, isToday: true })
  }

  const latest = await prisma.standupDigest.findFirst({
    orderBy: { date: 'desc' },
    select: { id: true, date: true, summary: true, generatedAt: true },
  })
  return successResponse({ digest: latest, isToday: false })
}
