/**
 * Auto-draft a user's daily log from observed activity.
 *
 * Gathers everything they did today (tasks closed, tickets accepted/
 * resolved, comments posted, threads contributed to) and runs a tight
 * LLM call to draft their daily-log entry in their voice. Cron job
 * persists the draft as a DailyLogDraft for them to approve in the
 * morning.
 */

import { prisma } from '@/lib/db'
import { generate } from '@/lib/llm/generate'
import { istDayRangeFromKey } from '@/lib/date-ist'

export interface ActivityEvidence {
  tasksClosed: Array<{ id: string; title: string; projectName: string; completedAt: string }>
  ticketsAccepted: Array<{ id: string; title: string; projectName: string }>
  ticketsCompleted: Array<{ id: string; title: string; projectName: string }>
  threadMessages: Array<{
    projectName: string | null
    taskTitle: string | null
    content: string
    createdAt: string
  }>
}

/**
 * Returns null if the user had no observable activity today.
 */
export async function collectActivity(
  userId: string,
  dateOnly: Date,
): Promise<ActivityEvidence | null> {
  // Match the IST calendar day this draft is keyed to (the dateOnly key is an
  // istDateOnly value), not a UTC-midnight window.
  const { start: startOfDay, end: endOfDay } = istDayRangeFromKey(dateOnly)

  const [tasksClosed, ticketsAccepted, ticketsCompleted, threadMessages] = await Promise.all([
    prisma.task.findMany({
      where: {
        assigneeId: userId,
        status: 'DONE',
        completedAt: { gte: startOfDay, lt: endOfDay },
      },
      select: {
        id: true,
        title: true,
        completedAt: true,
        project: { select: { name: true } },
      },
    }),
    prisma.ticket.findMany({
      where: {
        helperId: userId,
        acceptedAt: { gte: startOfDay, lt: endOfDay },
      },
      select: { id: true, title: true, project: { select: { name: true } } },
    }),
    prisma.ticket.findMany({
      where: {
        helperId: userId,
        status: 'COMPLETED',
        completedAt: { gte: startOfDay, lt: endOfDay },
      },
      select: { id: true, title: true, project: { select: { name: true } } },
    }),
    prisma.threadMessage.findMany({
      where: {
        authorId: userId,
        createdAt: { gte: startOfDay, lt: endOfDay },
      },
      take: 30,
      select: {
        content: true,
        createdAt: true,
        projectThread: { select: { project: { select: { name: true } } } },
        taskThread: { select: { task: { select: { title: true } } } },
      },
    }),
  ])

  const total =
    tasksClosed.length +
    ticketsAccepted.length +
    ticketsCompleted.length +
    threadMessages.length
  if (total === 0) return null

  return {
    tasksClosed: tasksClosed.map((t) => ({
      id: t.id,
      title: t.title,
      projectName: t.project.name,
      completedAt: (t.completedAt ?? new Date()).toISOString(),
    })),
    ticketsAccepted: ticketsAccepted.map((t) => ({
      id: t.id,
      title: t.title,
      projectName: t.project.name,
    })),
    ticketsCompleted: ticketsCompleted.map((t) => ({
      id: t.id,
      title: t.title,
      projectName: t.project.name,
    })),
    threadMessages: threadMessages.map((m) => ({
      projectName: m.projectThread?.project.name ?? null,
      taskTitle: m.taskThread?.task.title ?? null,
      content: m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content,
      createdAt: m.createdAt.toISOString(),
    })),
  }
}

// The company is named per run (the cron drafts for each company separately).
const draftSystem = (company: string) => `You draft daily work-log entries for people at ${company}.
The user did real work today; your job is to summarize
it in their voice as a short, factual daily-log entry.

Strict rules:
- 2 to 4 sentences MAX. No bullets. No markdown.
- First person ("I shipped X..."), past tense.
- Concrete. Reference task and project names where they help.
- Don't invent. Only summarize what's in the activity data below.
- Don't editorialize ("It was a productive day!"). Just say what
  happened.
- Don't include emojis, sign-offs, or hashtags.

Return ONLY the daily-log text. No headers, no commentary.`

export async function draftLogForActivity(
  userName: string,
  activity: ActivityEvidence,
  company = 'their company',
): Promise<{ summary: string | null; provider: string | null }> {
  const userPrompt = [
    `Activity for ${userName} today:`,
    '',
    activity.tasksClosed.length > 0
      ? `Closed tasks:\n${activity.tasksClosed.map((t) => `  • "${t.title}" (${t.projectName})`).join('\n')}`
      : null,
    activity.ticketsAccepted.length > 0
      ? `Tickets accepted (helping someone):\n${activity.ticketsAccepted.map((t) => `  • "${t.title}" (${t.projectName})`).join('\n')}`
      : null,
    activity.ticketsCompleted.length > 0
      ? `Tickets resolved:\n${activity.ticketsCompleted.map((t) => `  • "${t.title}" (${t.projectName})`).join('\n')}`
      : null,
    activity.threadMessages.length > 0
      ? `Thread contributions (${activity.threadMessages.length} messages):\n${activity.threadMessages
          .slice(0, 5)
          .map((m) => {
            const where = m.projectName
              ? `in ${m.projectName}`
              : m.taskTitle
                ? `on task "${m.taskTitle}"`
                : ''
            return `  • ${where}: ${m.content.slice(0, 100)}`
          })
          .join('\n')}`
      : null,
    '',
    'Draft the daily-log entry in their voice (2-4 sentences, first person, past tense).',
  ]
    .filter(Boolean)
    .join('\n')

  const result = await generate([
    { role: 'system', content: draftSystem(company) },
    { role: 'user', content: userPrompt },
  ])

  if (result.fallback || !result.text.trim()) {
    return { summary: null, provider: null }
  }
  return { summary: result.text.trim(), provider: result.provider }
}
