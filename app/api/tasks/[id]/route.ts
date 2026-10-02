import { type NextRequest, NextResponse } from 'next/server'
import type { Priority, TaskStatus } from '@prisma/client'

import { prisma } from '@/lib/db'
import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { tokenCan } from '@/lib/permissions'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { canBeAssigned } from '@/lib/projects'
import { buildTaskSummary, parseTaskPoints, priorityForPoints, VALID_TASK_POINTS } from '@/lib/tasks'

const VALID_TASK_STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'DONE']
const VALID_PRIORITIES: Priority[]      = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

// ─── Shared loader ────────────────────────────────────────────────────────────

type LoadedTask = {
  id: string
  projectId: string
  assigneeId: string | null
  status: TaskStatus
  // Both loaded so the payment rule can be evaluated against the task's final
  // state when a PATCH changes only one of points or priority.
  priority: Priority
  points: number | null
  // Both dates are loaded so a PATCH touching only ONE of them can still be
  // validated against the stored value of the other (start <= due).
  startDate: Date | null
  dueDate: Date | null
  project: { leadId: string | null }
}

async function loadTask(id: string): Promise<LoadedTask | null> {
  return prisma.task.findFirst({
    where: { id, isActive: true },
    select: {
      id: true,
      projectId: true,
      assigneeId: true,
      status: true,
      priority: true,
      points: true,
      startDate: true,
      dueDate: true,
      project: { select: { leadId: true } },
    },
  })
}

// ─── PATCH /api/tasks/[id] ────────────────────────────────────────────────────

/**
 * Edit a task.
 *
 * Permissions:
 *   - Status-only changes  → admin / super_admin / project lead / the task's assignee
 *   - Any other field      → admin / super_admin / project lead
 *
 * Other fields: title, description, expectedOutput, priority, assigneeId,
 * dueDate, status (when accompanied by other fields).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)

    const task = await loadTask(params.id)
    if (!task) return errorResponse('Task not found', 404)

    let body: unknown
    try { body = await request.json() } catch { return errorResponse('Invalid JSON body', 400) }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return errorResponse('Request body must be an object', 400)
    }
    const data = body as Record<string, unknown>

    const isAdmin    = tokenCan(payload, 'tasks.manage')
    const isLead     = task.project.leadId === payload.userId
    const isAssignee = task.assigneeId === payload.userId

    // Decide which keys are present. If the request *only* touches `status`,
    // we use the looser status-change permissions; otherwise the caller must
    // be an admin or the project lead.
    const writableKeys = ['title', 'description', 'expectedOutput', 'priority', 'points',
                          'assigneeId', 'startDate', 'dueDate', 'status'] as const
    const touched = writableKeys.filter((k) => k in data)
    if (touched.length === 0) {
      return errorResponse('No editable fields provided', 400)
    }
    const statusOnly = touched.length === 1 && touched[0] === 'status'

    if (statusOnly) {
      if (!isAdmin && !isLead && !isAssignee) {
        return errorResponse('Only the assignee, project lead, or an admin can change task status', 403)
      }
    } else {
      if (!isAdmin && !isLead) {
        return errorResponse('Only admins or the project lead can edit tasks', 403)
      }
    }

    // ── Build the prisma update payload ────────────────────────────────────
    const update: Record<string, unknown> = {}

    if ('title' in data) {
      if (typeof data.title !== 'string' || data.title.trim().length === 0) {
        return errorResponse('title must be a non-empty string', 400)
      }
      if (data.title.length > 200) return errorResponse('title must be 200 characters or fewer', 400)
      update.title = data.title.trim()
    }

    if ('description' in data) {
      if (data.description !== null && typeof data.description !== 'string') {
        return errorResponse('description must be a string or null', 400)
      }
      update.description = typeof data.description === 'string' ? data.description.trim() : null
    }

    if ('expectedOutput' in data) {
      if (data.expectedOutput !== null && typeof data.expectedOutput !== 'string') {
        return errorResponse('expectedOutput must be a string or null', 400)
      }
      update.expectedOutput = typeof data.expectedOutput === 'string'
        ? data.expectedOutput.trim() || null
        : null
    }

    if ('priority' in data) {
      if (typeof data.priority !== 'string' || !VALID_PRIORITIES.includes(data.priority as Priority)) {
        return errorResponse(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`, 400)
      }
      update.priority = data.priority as Priority
    }

    if ('points' in data) {
      const parsed = parseTaskPoints(data.points)
      if (parsed === 'invalid') {
        return errorResponse(`points must be one of: ${VALID_TASK_POINTS.join(', ')}`, 400)
      }
      update.points = parsed ?? null
    }

    // Keep the payment rule true after any edit. Evaluate against what the task
    // WILL be, not what was sent, so it holds whether the caller changed points,
    // changed priority, or changed something else entirely on a 5-mark task.
    // It only ever raises priority — see priorityForPoints.
    {
      const nextPoints = 'points' in update ? (update.points as number | null) : task.points
      const nextPriority = ('priority' in update ? update.priority : task.priority) as Priority
      const adjusted = priorityForPoints(nextPoints, nextPriority)
      if (adjusted !== nextPriority) update.priority = adjusted
    }

    if ('assigneeId' in data) {
      if (data.assigneeId === null || data.assigneeId === '') {
        update.assigneeId = null
      } else if (typeof data.assigneeId === 'string') {
        // Same rule as task creation: project members, plus super admins
        // anywhere. See canBeAssigned in lib/projects.ts.
        if (!(await canBeAssigned(data.assigneeId, task.projectId))) {
          return errorResponse('assignee must be an active member of the project', 400)
        }
        update.assigneeId = data.assigneeId
      } else {
        return errorResponse('assigneeId must be a user ID or null', 400)
      }
    }

    if ('dueDate' in data) {
      if (data.dueDate === null || data.dueDate === '') {
        update.dueDate = null
      } else if (typeof data.dueDate === 'string') {
        const parsed = new Date(data.dueDate)
        if (Number.isNaN(parsed.getTime())) return errorResponse('dueDate is not a valid date', 400)
        update.dueDate = parsed
      } else {
        return errorResponse('dueDate must be an ISO string or null', 400)
      }
    }

    if ('startDate' in data) {
      if (data.startDate === null || data.startDate === '') {
        update.startDate = null
      } else if (typeof data.startDate === 'string') {
        const parsed = new Date(data.startDate)
        if (Number.isNaN(parsed.getTime())) return errorResponse('startDate is not a valid date', 400)
        update.startDate = parsed
      } else {
        return errorResponse('startDate must be an ISO string or null', 400)
      }
    }

    // Cross-field check. A PATCH may carry only one of the two, so fall back to
    // the stored value for whichever wasn't sent — otherwise setting just one
    // date could quietly produce start > due.
    const nextStart = ('startDate' in data ? update.startDate : task.startDate) as Date | null
    const nextDue = ('dueDate' in data ? update.dueDate : task.dueDate) as Date | null
    if (nextStart && nextDue && nextStart.getTime() > nextDue.getTime()) {
      return errorResponse('startDate must be on or before dueDate', 400)
    }

    if ('status' in data) {
      if (typeof data.status !== 'string' || !VALID_TASK_STATUSES.includes(data.status as TaskStatus)) {
        return errorResponse(`status must be one of: ${VALID_TASK_STATUSES.join(', ')}`, 400)
      }
      const next = data.status as TaskStatus
      update.status = next
      // Maintain completedAt invariant
      if (next === 'DONE' && task.status !== 'DONE') update.completedAt = new Date()
      if (next !== 'DONE' && task.status === 'DONE') update.completedAt = null
    }

    await prisma.task.update({ where: { id: task.id }, data: update })

    const full = await prisma.task.findUniqueOrThrow({
      where: { id: task.id },
      include: {
        project: { select: { name: true } },
        assignee: { select: { name: true, avatarUrl: true } },
      },
    })
    return successResponse(buildTaskSummary(full))
  } catch (error) {
    console.error('[PATCH /api/tasks/[id]]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

// ─── DELETE /api/tasks/[id] ───────────────────────────────────────────────────

/**
 * Soft-delete a task (sets isActive = false). Allowed for admin, super_admin,
 * or the project's lead.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)

    const task = await loadTask(params.id)
    if (!task) return errorResponse('Task not found', 404)

    const isAdmin = tokenCan(payload, 'tasks.manage')
    const isLead  = task.project.leadId === payload.userId
    if (!isAdmin && !isLead) {
      return errorResponse('Only admins or the project lead can delete tasks', 403)
    }

    await prisma.task.update({
      where: { id: task.id },
      data: { isActive: false },
    })

    return successResponse({ id: task.id })
  } catch (error) {
    console.error('[DELETE /api/tasks/[id]]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}
