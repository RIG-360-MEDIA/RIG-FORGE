import { randomUUID } from 'node:crypto'
import type { Prisma, Priority, TaskStatus } from '@prisma/client'

import { prisma } from '@/lib/db'
import type { TaskSummary } from '@/lib/types'

const MAX_DEPENDENCY_HOPS = 10

/**
 * Task marking. A fixed set, not a free number:
 *   1 — small task
 *   2 — bigger task
 *   5 — payment related
 * Anything else is rejected, so the value stays meaningful for reporting later.
 */
export const VALID_TASK_POINTS = [1, 2, 5] as const

/** Points value that means "payment related". */
export const PAYMENT_POINTS = 5

/**
 * Parse a submitted points value. Returns `undefined` when the caller did not
 * mention points at all (leave the field alone), `null` to clear it, a valid
 * number, or the string 'invalid'.
 */
export function parseTaskPoints(raw: unknown): number | null | undefined | 'invalid' {
  if (raw === undefined) return undefined
  if (raw === null || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(n) || !VALID_TASK_POINTS.includes(n as 1 | 2 | 5)) return 'invalid'
  return n
}

/**
 * A payment-related task (5 marks) must be at least HIGH priority.
 *
 * Deliberately RAISES rather than sets: if someone has already marked the task
 * CRITICAL, forcing it back to HIGH would be a downgrade and would quietly
 * undo their judgement. Anything below HIGH is raised to HIGH.
 */
export function priorityForPoints(points: number | null | undefined, requested: Priority): Priority {
  if (points !== PAYMENT_POINTS) return requested
  return requested === 'CRITICAL' ? 'CRITICAL' : 'HIGH'
}

/**
 * Parse a submitted categoryId. Returns `undefined` when the caller did not
 * mention it (leave the field alone), `null` to clear it, the id of an active
 * category in the caller's company, or 'invalid'. findFirst, so the org-scope
 * extension keeps one company from filing tasks under another's category.
 */
export async function parseTaskCategory(raw: unknown): Promise<string | null | undefined | 'invalid'> {
  if (raw === undefined) return undefined
  if (raw === null || raw === '') return null
  if (typeof raw !== 'string') return 'invalid'
  const found = await prisma.taskCategory.findFirst({ where: { id: raw, isActive: true }, select: { id: true } })
  return found ? found.id : 'invalid'
}

/**
 * Create many tasks in two database round trips instead of four per task
 * (a 20-item template took 26 s one by one against the Tokyo database).
 * Ids are made here so the new rows can be read back in the order given;
 * createMany is stamped with the caller's company by the org-scope
 * extension (createManyAndReturn is not, so it is not used).
 */
export async function createTasks(
  rows: Omit<Prisma.TaskCreateManyInput, 'id'>[],
  db: Pick<typeof prisma, 'task'> = prisma,
): Promise<TaskSummary[]> {
  if (rows.length === 0) return []
  // createdAt a millisecond apart: lists sort ties by it, and one insert
  // would give every row the same time and lose the template's order.
  const base = Date.now()
  const withIds = rows.map((r, i) => ({ ...r, id: randomUUID(), createdAt: new Date(base + i) }))
  await db.task.createMany({ data: withIds })
  const created = await db.task.findMany({ where: { id: { in: withIds.map((r) => r.id) } }, include: TASK_SUMMARY_INCLUDE })
  const byId = new Map(created.map((t) => [t.id, t]))
  return withIds.map((r) => byId.get(r.id)).filter((t): t is NonNullable<typeof t> => !!t).map((t) => buildTaskSummary(t))
}

/** Task row + relations required to build TaskSummary. */
export type TaskForSummary = {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: Priority
  projectId: string
  assigneeId: string | null
  expectedOutput: string | null
  points: number | null
  startDate: Date | null
  dueDate: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
  project: { name: string }
  assignee: { name: string; avatarUrl: string | null } | null
  /** Optional so older call sites that do not include it still compile; they report no category. */
  categoryId?: string | null
  category?: { name: string } | null
}

/** The include every task read needs for buildTaskSummary. */
export const TASK_SUMMARY_INCLUDE = {
  project: { select: { name: true } },
  assignee: { select: { name: true, avatarUrl: true } },
  category: { select: { name: true } },
} as const


/**
 * Maps a Prisma task with project + assignee includes to the public TaskSummary shape.
 */
export function buildTaskSummary(task: TaskForSummary): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    projectId: task.projectId,
    projectName: task.project.name,
    assigneeId: task.assigneeId,
    assigneeName: task.assignee?.name ?? null,
    assigneeAvatar: task.assignee?.avatarUrl ?? null,
    categoryId: task.categoryId ?? null,
    categoryName: task.category?.name ?? null,
    expectedOutput: task.expectedOutput,
    points: task.points,
    startDate: task.startDate,
    dueDate: task.dueDate,
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}
