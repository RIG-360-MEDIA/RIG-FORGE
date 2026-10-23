import { type NextRequest } from 'next/server'
import type { Prisma, Priority, TaskStatus } from '@prisma/client'

import { prisma } from '@/lib/db'
import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { canBeAssigned } from '@/lib/projects'
import { canManageProjectTasks } from '@/lib/task-categories'
import { buildTaskSummary, parseTaskCategory, TASK_SUMMARY_INCLUDE } from '@/lib/tasks'
import { notifyTasksAssigned } from '@/lib/task-notify'
import type { TaskSummary } from '@/lib/types'

const VALID_TASK_STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'DONE']
const VALID_PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
/** Most tasks one paste can add, and most rows one bulk edit can change. */
const MAX_CREATE = 200
const MAX_UPDATE = 500

/** '' or null clears; an ISO date string sets; anything else is invalid. */
function parseDate(raw: unknown): Date | null | 'invalid' {
  if (raw === null || raw === '') return null
  if (typeof raw !== 'string') return 'invalid'
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? 'invalid' : d
}

// ─── POST /api/tasks/bulk ────────────────────────────────────────────────────

/**
 * Add many tasks to one project at once, e.g. lines pasted from a BOQ, Excel
 * or WhatsApp: { projectId, titles: string[], categoryId?, assigneeId?,
 * priority?, dueDate? }. Every task gets the same category and, when given,
 * the same assignee, priority and due date. Blank lines are skipped and list
 * bullets ("-", "1.", "•") are stripped. Admins and the project lead only.
 */
export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)

    const data = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!data || typeof data !== 'object') return errorResponse('Request body must be an object', 400)

    const projectId = typeof data.projectId === 'string' ? data.projectId : ''
    const project = projectId
      ? await prisma.project.findFirst({ where: { id: projectId, isActive: true }, select: { id: true, name: true } })
      : null
    if (!project) return errorResponse('Project not found', 400)
    if (!(await canManageProjectTasks(payload, projectId))) {
      return errorResponse('Only admins or the project lead can add tasks in bulk', 403)
    }

    if (!Array.isArray(data.titles)) return errorResponse('titles must be a list', 400)
    const titles = data.titles
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.replace(/^\s*(?:[-*•▪◦]|\d{1,3}[.)])\s+/, '').trim())
      .filter(Boolean)
    if (titles.length === 0) return errorResponse('No task titles given', 400)
    if (titles.length > MAX_CREATE) return errorResponse(`At most ${MAX_CREATE} tasks can be added at once`, 400)
    const tooLong = titles.find((t) => t.length > 200)
    if (tooLong) return errorResponse(`Each title must be 200 characters or fewer ("${tooLong.slice(0, 40)}...")`, 400)

    const categoryId = await parseTaskCategory(data.categoryId)
    if (categoryId === 'invalid') return errorResponse('categoryId is not an active task category', 400)

    let assigneeId: string | null = null
    if (typeof data.assigneeId === 'string' && data.assigneeId) {
      if (!(await canBeAssigned(data.assigneeId, projectId))) return errorResponse('assignee must be an active member of the project', 400)
      assigneeId = data.assigneeId
    }
    let priority: Priority = 'MEDIUM'
    if (data.priority !== undefined) {
      if (!VALID_PRIORITIES.includes(data.priority as Priority)) return errorResponse(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`, 400)
      priority = data.priority as Priority
    }
    const dueDate = data.dueDate === undefined ? null : parseDate(data.dueDate)
    if (dueDate === 'invalid') return errorResponse('dueDate is not a valid date', 400)

    // One transaction of plain creates (not createMany) so each row comes back
    // with its id, in the order pasted.
    const created = await prisma.$transaction(
      titles.map((title) => prisma.task.create({
        data: { title, projectId, status: 'TODO', priority, assigneeId, dueDate, categoryId: categoryId ?? null },
        include: TASK_SUMMARY_INCLUDE,
      })),
    )

    if (assigneeId) {
      await notifyTasksAssigned(
        created.map((t) => ({ title: t.title, projectId, projectName: project.name, assigneeId: assigneeId! })),
        { userId: payload.userId },
      )
    }
    return successResponse<TaskSummary[]>(created.map((t) => buildTaskSummary(t)), 201)
  } catch (error) {
    console.error('[POST /api/tasks/bulk]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

// ─── PATCH /api/tasks/bulk ───────────────────────────────────────────────────

/**
 * Change many tasks at once: { taskIds: string[], set: { assigneeId?,
 * dueDate?, priority?, categoryId?, status? } }. The caller must be able to
 * manage the task list of every project the tasks are in (admin, or that
 * project's lead). The same rules as a single edit hold: the assignee must be
 * on each task's project, a due date cannot fall before a task's start date,
 * payment-related tasks (5 marks) stay at least HIGH, and completedAt follows
 * the status. New assignees are notified, once per person per project.
 */
export async function PATCH(request: NextRequest) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)

    const data = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!data || typeof data !== 'object') return errorResponse('Request body must be an object', 400)
    const ids = Array.isArray(data.taskIds) ? [...new Set(data.taskIds.filter((x): x is string => typeof x === 'string'))] : []
    if (ids.length === 0) return errorResponse('taskIds is required', 400)
    if (ids.length > MAX_UPDATE) return errorResponse(`At most ${MAX_UPDATE} tasks can be changed at once`, 400)
    const set = (data.set && typeof data.set === 'object' ? data.set : {}) as Record<string, unknown>

    const tasks = await prisma.task.findMany({
      where: { id: { in: ids }, isActive: true },
      select: { id: true, projectId: true, assigneeId: true, status: true, points: true, startDate: true },
    })
    if (tasks.length !== ids.length) return errorResponse('Some of these tasks no longer exist', 404)

    const projectIds = [...new Set(tasks.map((t) => t.projectId))]
    for (const pid of projectIds) {
      if (!(await canManageProjectTasks(payload, pid))) {
        return errorResponse('Only admins or the project lead can change tasks in bulk', 403)
      }
    }

    const update: Prisma.TaskUpdateManyMutationInput & { assigneeId?: string | null; categoryId?: string | null } = {}

    if ('assigneeId' in set) {
      if (set.assigneeId === null || set.assigneeId === '') {
        update.assigneeId = null
      } else if (typeof set.assigneeId === 'string') {
        for (const pid of projectIds) {
          if (!(await canBeAssigned(set.assigneeId, pid))) {
            return errorResponse('That person is not on every project these tasks are in', 400)
          }
        }
        update.assigneeId = set.assigneeId
      } else {
        return errorResponse('assigneeId must be a user ID or null', 400)
      }
    }
    if ('categoryId' in set) {
      const categoryId = await parseTaskCategory(set.categoryId)
      if (categoryId === 'invalid') return errorResponse('categoryId is not an active task category', 400)
      update.categoryId = categoryId ?? null
    }
    if ('priority' in set) {
      if (!VALID_PRIORITIES.includes(set.priority as Priority)) return errorResponse(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`, 400)
      update.priority = set.priority as Priority
    }
    if ('dueDate' in set) {
      const due = parseDate(set.dueDate)
      if (due === 'invalid') return errorResponse('dueDate is not a valid date', 400)
      if (due) {
        const clash = tasks.filter((t) => t.startDate && t.startDate > due).length
        if (clash) return errorResponse(`${clash} of these tasks start after that due date`, 400)
      }
      update.dueDate = due
    }
    let status: TaskStatus | undefined
    if ('status' in set) {
      if (!VALID_TASK_STATUSES.includes(set.status as TaskStatus)) return errorResponse(`status must be one of: ${VALID_TASK_STATUSES.join(', ')}`, 400)
      status = set.status as TaskStatus
    }
    if (Object.keys(update).length === 0 && !status) return errorResponse('Nothing to change', 400)

    await prisma.$transaction(async (tx) => {
      if (Object.keys(update).length > 0) {
        await tx.task.updateMany({ where: { id: { in: ids } }, data: update })
      }
      // A payment task is never below HIGH (see priorityForPoints).
      if (update.priority === 'LOW' || update.priority === 'MEDIUM') {
        await tx.task.updateMany({ where: { id: { in: ids }, points: 5 }, data: { priority: 'HIGH' } })
      }
      // completedAt follows the status, set only when a task moves into or out of DONE.
      if (status === 'DONE') {
        await tx.task.updateMany({ where: { id: { in: ids }, status: { not: 'DONE' } }, data: { status, completedAt: new Date() } })
      } else if (status) {
        await tx.task.updateMany({ where: { id: { in: ids }, status: 'DONE' }, data: { status, completedAt: null } })
        await tx.task.updateMany({ where: { id: { in: ids }, status: { not: 'DONE' } }, data: { status } })
      }
    })

    const full = await prisma.task.findMany({ where: { id: { in: ids } }, include: TASK_SUMMARY_INCLUDE })
    if (typeof update.assigneeId === 'string') {
      const before = new Map(tasks.map((t) => [t.id, t.assigneeId]))
      const handedOver = full.filter((t) => t.assigneeId && before.get(t.id) !== t.assigneeId)
      await notifyTasksAssigned(
        handedOver.map((t) => ({ title: t.title, projectId: t.projectId, projectName: t.project.name, assigneeId: t.assigneeId! })),
        { userId: payload.userId },
      )
    }
    return successResponse<TaskSummary[]>(full.map((t) => buildTaskSummary(t)))
  } catch (error) {
    console.error('[PATCH /api/tasks/bulk]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}
