/**
 * POST /api/cron/daily-log-drafts
 *
 * Cron-driven. Run at ~6pm IST daily.
 *
 * For every active employee, in every company, who:
 *   - has activity today AND
 *   - hasn't already submitted a daily log for today AND
 *   - doesn't already have a draft for today
 *
 * we draft their daily log via the LLM and persist it as a DailyLogDraft.
 * The user sees it in their dashboard (or via notification) and approves
 * with one tap.
 *
 * Returns per company: { processed, drafted, skipped, errors, unfinished }.
 *
 * Idempotent: re-runs on the same day skip users who already have a
 * draft, so accidentally triggering twice doesn't double-draft. That is also
 * how a run cut short by its time budget is finished: run it again.
 */

import { type NextRequest } from 'next/server'

import { prisma } from '@/lib/db'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { forEachActiveOrg, isCronAuthorized } from '@/lib/cron'
import { istDateOnly } from '@/lib/date-ist'
import {
  collectActivity,
  draftLogForActivity,
} from '@/lib/assistant/daily-log-draft'
import { forgieDmToUser } from '@/lib/chat/service'

// One LLM call per person. Drafting a few at a time keeps a whole company
// well inside the scheduler's 10-minute request limit; the budget stops new
// drafts before that limit is reached (whoever is left is reported, and a
// re-run picks them up).
const CONCURRENCY = 3
const TIME_BUDGET_MS = 8 * 60 * 1000

interface Counters {
  processed: number
  drafted: number
  skipped: number
  errors: number
  unfinished: number
  errorDetails: string[]
}

export async function POST(request: NextRequest) {
  if (!isCronAuthorized(request)) return errorResponse('Unauthorized', 401)

  const dateOnly = istDateOnly()
  const deadline = Date.now() + TIME_BUDGET_MS

  const results = await forEachActiveOrg(async (org) => {
    // All employees + admins of THIS company: active, onboarded, not in
    // must-change-password.
    const users = await prisma.user.findMany({
      where: {
        isActive: true,
        isOnboarding: false,
        mustChangePassword: false,
      },
      select: { id: true, name: true },
    })

    const counters: Counters = { processed: 0, drafted: 0, skipped: 0, errors: 0, unfinished: 0, errorDetails: [] }

    const draftOne = async (user: { id: string; name: string }) => {
      counters.processed += 1
      try {
        // Skip if already submitted today
        const existingLog = await prisma.dailyLog.findUnique({
          where: { userId_date: { userId: user.id, date: dateOnly } },
          select: { id: true },
        })
        if (existingLog) {
          counters.skipped += 1
          return
        }

        // Skip if already drafted today
        const existingDraft = await prisma.dailyLogDraft.findUnique({
          where: { userId_date: { userId: user.id, date: dateOnly } },
          select: { id: true },
        })
        if (existingDraft) {
          counters.skipped += 1
          return
        }

        // Collect activity — skip if nothing observed
        const activity = await collectActivity(user.id, dateOnly)
        if (!activity) {
          counters.skipped += 1
          return
        }

        const { summary } = await draftLogForActivity(user.name, activity, org.name)
        if (!summary) {
          counters.errors += 1
          counters.errorDetails.push(`${user.name}: LLM returned empty draft`)
          return
        }

        await prisma.dailyLogDraft.create({
          data: {
            userId: user.id,
            date: dateOnly,
            draftSummary: summary,
            evidence: activity as unknown as object,
          },
        })

        // In-app notification so they see it
        await prisma.notification
          .create({
            data: {
              userId: user.id,
              type: 'ADMIN_MESSAGE',
              title: 'Daily log drafted',
              body: 'Forgie drafted your daily log from what you did today. Open the dashboard to approve or edit.',
              linkTo: '/dashboard',
            },
          })
          .catch(() => {})

        // Nudge them in their Forgie chat too.
        await forgieDmToUser(
          user.id,
          'I drafted your daily log for today from your activity. Review and approve it on your dashboard.',
        ).catch(() => {})

        counters.drafted += 1
      } catch (err) {
        counters.errors += 1
        counters.errorDetails.push(`${user.name}: ${err instanceof Error ? err.message : 'unknown'}`)
      }
    }

    // Small worker pool over the user list, stopping at the time budget.
    let next = 0
    const worker = async () => {
      while (next < users.length) {
        if (Date.now() > deadline) return
        const user = users[next++]!
        await draftOne(user)
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    counters.unfinished = users.length - next
    return counters
  })

  return successResponse({ date: dateOnly, orgs: results })
}
