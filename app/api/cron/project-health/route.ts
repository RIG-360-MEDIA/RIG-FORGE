/**
 * POST /api/cron/project-health
 *
 * Cron-driven. Run daily.
 *
 * Scans every active project of every company, computes a health score using
 * the existing get_project_health tool, and creates an in-app notification
 * (one per stressed project) for that company's admins + the project lead.
 * Threshold is conservative: only alerts on projects scoring below 50/100.
 *
 * Idempotent within a day: we skip projects we already alerted on today.
 */

import { type NextRequest } from 'next/server'

import { prisma } from '@/lib/db'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { forEachActiveOrg, isCronAuthorized } from '@/lib/cron'
import { istDateOnly, istDayRangeFromKey } from '@/lib/date-ist'
import { getProjectHealth } from '@/lib/assistant/tools/projects'

const HEALTH_THRESHOLD = 50  // projects below this score get an alert

export async function POST(request: NextRequest) {
  if (!isCronAuthorized(request)) return errorResponse('Unauthorized', 401)

  // Dedupe window = the IST calendar day (see lib/date-ist.ts), so "already
  // alerted today" tracks the team's day rather than the UTC server clock.
  const { start: today0, end: tomorrow0 } = istDayRangeFromKey(istDateOnly())

  // Each company runs inside its own tenant context, so projects, admins and
  // the de-dupe check below only ever see that company's rows.
  const results = await forEachActiveOrg(() => scanOrg(today0, tomorrow0))
  return successResponse({ orgs: results })
}

async function scanOrg(today0: Date, tomorrow0: Date) {
  // Find all active projects
  const projects = await prisma.project.findMany({
    where: { isActive: true, status: 'ACTIVE' },
    select: { id: true, name: true, leadId: true },
  })

  // We act as a super-admin for the health computation (sees everything)
  const adminCaller = { userId: 'system-cron', role: 'SUPER_ADMIN' }

  const counters = {
    scanned: 0,
    alerted: 0,
    skippedAlreadyNotified: 0,
    healthy: 0,
    errors: 0,
  }

  // Get all current admins once — they receive every alert
  const admins = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, isActive: true },
    select: { id: true },
  })
  const adminIds = admins.map((a) => a.id)

  for (const project of projects) {
    counters.scanned += 1

    try {
      const health = await getProjectHealth(adminCaller, project.id)
      if (!health) continue

      if (health.score >= HEALTH_THRESHOLD) {
        counters.healthy += 1
        continue
      }

      // Skip if we already notified about this project today
      const alreadyAlerted = await prisma.notification.findFirst({
        where: {
          type: 'PROJECT_UPDATE',
          linkTo: `/dashboard/projects/${project.id}`,
          title: { startsWith: 'Project health' },
          createdAt: { gte: today0, lt: tomorrow0 },
        },
        select: { id: true },
      })
      if (alreadyAlerted) {
        counters.skippedAlreadyNotified += 1
        continue
      }

      // Build the alert body — concise, factual
      const signals: string[] = []
      if (health.signals.overdueTasks > 0) {
        signals.push(`${health.signals.overdueTasks} overdue task${health.signals.overdueTasks === 1 ? '' : 's'}`)
      }
      if (health.signals.openTickets > 3) {
        signals.push(`${health.signals.openTickets} open tickets`)
      }
      if (health.signals.daysSinceLastActivity !== null && health.signals.daysSinceLastActivity > 5) {
        signals.push(`${health.signals.daysSinceLastActivity}d quiet`)
      }
      if (health.signals.recentTasksClosed === 0) {
        signals.push('no recent closes')
      }
      const signalText = signals.length > 0 ? signals.join(' · ') : 'velocity stalled'

      // Notify all admins + project lead (dedupe with Set)
      const recipientIds = new Set<string>(adminIds)
      if (project.leadId) recipientIds.add(project.leadId)
      if (recipientIds.size === 0) continue

      await prisma.notification.createMany({
        data: Array.from(recipientIds).map((userId) => ({
          userId,
          type: 'PROJECT_UPDATE' as const,
          title: `Project health: ${project.name}`,
          body: `Score ${health.score}/100 — ${signalText}. Worth a check-in.`,
          linkTo: `/dashboard/projects/${project.id}`,
        })),
        skipDuplicates: true,
      })

      counters.alerted += 1
    } catch (err) {
      counters.errors += 1
      console.warn(`[cron/project-health] ${project.name}:`, err)
    }
  }

  return counters
}
