/**
 * POST /api/cron/standup-digest
 *
 * Cron-driven. Run at ~9am IST daily.
 * Generates today's standup digest for each company (one row per company per
 * IST day) and persists it to StandupDigest. Visible on /dashboard as a card,
 * and sent to each active member of that company in their Forgie chat.
 *
 * Idempotent: same-day re-runs replace the existing row (upsert).
 */

import { type NextRequest } from 'next/server'

import { prisma } from '@/lib/db'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { forEachActiveOrg, isCronAuthorized } from '@/lib/cron'
import { istDateOnly } from '@/lib/date-ist'
import { buildStandupMetrics, generateStandupDigest } from '@/lib/assistant/standup-digest'
import { forgieDmToUser } from '@/lib/chat/service'

export async function POST(request: NextRequest) {
  if (!isCronAuthorized(request)) return errorResponse('Unauthorized', 401)

  const today = istDateOnly()

  const results = await forEachActiveOrg(async (org) => {
    // Everything below runs inside this company's tenant context, so the
    // metrics, the members and the digest row are all this company's only.
    const members = await prisma.user.findMany({ where: { isActive: true }, select: { id: true } })
    if (members.length === 0) return { skipped: 'no active members' }

    const metrics = await buildStandupMetrics()
    const digest = await generateStandupDigest(metrics, org.name)
    if (!digest) throw new Error('Failed to generate digest (all LLM providers exhausted)')

    const row = await prisma.standupDigest.upsert({
      where: { organizationId_date: { organizationId: org.id, date: today } },
      create: {
        organizationId: org.id,
        date: today,
        summary: digest,
        metrics: metrics as unknown as object,
      },
      update: {
        summary: digest,
        metrics: metrics as unknown as object,
        generatedAt: new Date(),
      },
    })

    // Deliver the digest into each active member's Forgie chat.
    const delivered = await Promise.allSettled(
      members.map((u) => forgieDmToUser(u.id, `Today's standup digest\n\n${digest}`)),
    )
    return {
      digestId: row.id,
      length: digest.length,
      forgieChatsNotified: delivered.filter((r) => r.status === 'fulfilled').length,
    }
  })

  return successResponse({ date: today, orgs: results })
}
