/**
 * Generates the team's morning standup digest.
 *
 * Aggregates yesterday's activity across the whole org, then asks the
 * LLM to write a concise narrative summary in Forgie's voice. The cron
 * job persists it as a StandupDigest row visible on /dashboard.
 */

import { prisma } from '@/lib/db'
import { generate } from '@/lib/llm/generate'
import { istDateOnly, istDayRangeFromKey } from '@/lib/date-ist'

export interface StandupMetrics {
  dateFrom: string
  dateTo: string
  totals: {
    tasksClosed: number
    ticketsRaised: number
    ticketsAccepted: number
    ticketsResolved: number
    daysActive: number  // count of distinct users who had any activity yesterday
  }
  topActiveProjects: Array<{
    projectId: string
    name: string
    tasksClosed: number
    threadMessages: number
  }>
  todaysDeadlines: Array<{ taskId: string; title: string; projectName: string; assigneeName: string | null }>
  staleTickets: Array<{ ticketId: string; title: string; projectName: string; ageHours: number }>
  quietProjects: Array<{ projectId: string; name: string; daysSinceActivity: number }>
}

export async function buildStandupMetrics(): Promise<StandupMetrics> {
  const now = new Date()
  // Day boundaries anchored to the IST calendar day (see lib/date-ist.ts), so
  // "yesterday's work" and "today's deadlines" match the team's day, not UTC.
  const todayKey = istDateOnly(now)
  const { start: today0, end: tomorrow0 } = istDayRangeFromKey(todayKey)
  const yesterday0 = new Date(today0.getTime() - 24 * 60 * 60 * 1000)

  // ── Yesterday totals ─────────────────────────────────────────────────────
  const [
    tasksClosed,
    ticketsRaised,
    ticketsAccepted,
    ticketsResolved,
    activeUsers,
  ] = await Promise.all([
    prisma.task.count({
      where: { status: 'DONE', completedAt: { gte: yesterday0, lt: today0 } },
    }),
    prisma.ticket.count({
      where: { createdAt: { gte: yesterday0, lt: today0 } },
    }),
    prisma.ticket.count({
      where: { acceptedAt: { gte: yesterday0, lt: today0 } },
    }),
    prisma.ticket.count({
      where: { status: 'COMPLETED', completedAt: { gte: yesterday0, lt: today0 } },
    }),
    prisma.dailyActivity.count({
      where: { wasActive: true, date: yesterday0 },
    }),
  ])

  // ── Top active projects yesterday ────────────────────────────────────────
  const closedTasksByProject = await prisma.task.groupBy({
    by: ['projectId'],
    where: { status: 'DONE', completedAt: { gte: yesterday0, lt: today0 } },
    _count: { _all: true },
    orderBy: { _count: { projectId: 'desc' } },
    take: 5,
  })

  const threadMessagesByProject = await prisma.threadMessage.groupBy({
    by: ['projectThreadId'],
    where: { createdAt: { gte: yesterday0, lt: today0 }, projectThreadId: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { projectThreadId: 'desc' } },
    take: 10,
  })

  // Resolve project IDs for thread groups
  const threadIds = threadMessagesByProject
    .map((r) => r.projectThreadId)
    .filter((id): id is string => id !== null)

  const threads = await prisma.projectThread.findMany({
    where: { id: { in: threadIds } },
    select: { id: true, projectId: true },
  })
  const threadToProject = new Map(threads.map((t) => [t.id, t.projectId]))

  // Merge into a per-project rollup
  const projectActivity = new Map<string, { tasksClosed: number; threadMessages: number }>()
  for (const row of closedTasksByProject) {
    const entry = projectActivity.get(row.projectId) ?? { tasksClosed: 0, threadMessages: 0 }
    entry.tasksClosed = row._count._all
    projectActivity.set(row.projectId, entry)
  }
  for (const row of threadMessagesByProject) {
    const projectId = threadToProject.get(row.projectThreadId ?? '')
    if (!projectId) continue
    const entry = projectActivity.get(projectId) ?? { tasksClosed: 0, threadMessages: 0 }
    entry.threadMessages = row._count._all
    projectActivity.set(projectId, entry)
  }

  const topProjectIds = Array.from(projectActivity.keys()).slice(0, 5)
  const projectsInfo = await prisma.project.findMany({
    where: { id: { in: topProjectIds } },
    select: { id: true, name: true },
  })
  const projectNameMap = new Map(projectsInfo.map((p) => [p.id, p.name]))

  const topActiveProjects: StandupMetrics['topActiveProjects'] = topProjectIds.map((id) => ({
    projectId: id,
    name: projectNameMap.get(id) ?? 'Unknown',
    tasksClosed: projectActivity.get(id)?.tasksClosed ?? 0,
    threadMessages: projectActivity.get(id)?.threadMessages ?? 0,
  }))

  // ── Today's deadlines ────────────────────────────────────────────────────
  const todayTasks = await prisma.task.findMany({
    where: {
      isActive: true,
      status: { not: 'DONE' },
      dueDate: { gte: today0, lt: tomorrow0 },
    },
    take: 10,
    select: {
      id: true,
      title: true,
      project: { select: { name: true } },
      assignee: { select: { name: true } },
    },
  })

  // ── Stale tickets (open >24h) ────────────────────────────────────────────
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const staleTickets = await prisma.ticket.findMany({
    where: { status: 'OPEN', createdAt: { lt: oneDayAgo } },
    take: 10,
    select: {
      id: true,
      title: true,
      createdAt: true,
      project: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  // ── Quiet projects (no thread activity in 5+ days, but active status) ────
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)
  const activeProjects = await prisma.project.findMany({
    where: { isActive: true, status: 'ACTIVE' },
    select: {
      id: true,
      name: true,
      thread: {
        select: {
          messages: {
            take: 1,
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          },
        },
      },
    },
  })

  const quietProjects = activeProjects
    .map((p) => {
      const last = p.thread?.messages[0]?.createdAt
      if (!last) return { projectId: p.id, name: p.name, daysSinceActivity: 999 }
      const days = Math.floor((now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24))
      return { projectId: p.id, name: p.name, daysSinceActivity: days }
    })
    .filter((p) => p.daysSinceActivity >= 5)
    .sort((a, b) => b.daysSinceActivity - a.daysSinceActivity)
    .slice(0, 5)

  return {
    dateFrom: new Date(todayKey.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    dateTo: todayKey.toISOString().slice(0, 10),
    totals: {
      tasksClosed,
      ticketsRaised,
      ticketsAccepted,
      ticketsResolved,
      daysActive: activeUsers,
    },
    topActiveProjects,
    todaysDeadlines: todayTasks.map((t) => ({
      taskId: t.id,
      title: t.title,
      projectName: t.project.name,
      assigneeName: t.assignee?.name ?? null,
    })),
    staleTickets: staleTickets.map((t) => ({
      ticketId: t.id,
      title: t.title,
      projectName: t.project.name,
      ageHours: Math.floor((now.getTime() - t.createdAt.getTime()) / (1000 * 60 * 60)),
    })),
    quietProjects,
  }
}

// The company is named per run: the digest is generated for each company
// separately (see app/api/cron/standup-digest).
const standupSystem = (company: string) => `You are Forgie, writing the team's morning standup digest for ${company}.

Write it in 4-7 short paragraphs. Tone is Forgie's — concise, lightly
witty, confident. Like a sharp coworker giving the team a 60-second
brief over coffee.

Structure (don't use these labels; just hit them naturally):
- Open with one sentence on overall vibe (numbers tell the story).
- Yesterday's wins — what shipped, what got resolved.
- Today's deadlines — what's due, who owns it.
- Watch-items — stale tickets, quiet projects, anything worth nudging.
- Close with one line: question, observation, or call-to-action.

Rules:
- 350 words max. Shorter is better.
- Markdown OK but minimal. Use bold for names/projects sparingly.
- No bullet lists; this is a narrative.
- Don't editorialize about people's character. Stick to observable
  work behavior.
- Don't invent — only use the metrics provided.
- If yesterday was quiet (no tasks closed, etc.), say so honestly and
  briefly. Don't pad.

Return ONLY the digest text. No headers, no commentary about the prompt.`

export async function generateStandupDigest(
  metrics: StandupMetrics,
  company = 'the company',
): Promise<string | null> {
  const userPrompt = `Yesterday's data for the team standup digest:

${JSON.stringify(metrics, null, 2)}

Write the digest now.`

  const result = await generate([
    { role: 'system', content: standupSystem(company) },
    { role: 'user', content: userPrompt },
  ])

  if (result.fallback || !result.text.trim()) return null
  return result.text.trim()
}
