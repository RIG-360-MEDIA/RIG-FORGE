import { type NextRequest } from 'next/server'
import type { Prisma, Priority, TaskStatus } from '@prisma/client'

import { prisma } from '@/lib/db'
import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { tokenCan } from '@/lib/permissions'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { isMemberOfProject } from '@/lib/projects'
import { buildTaskSummary, parseTaskPoints, priorityForPoints, VALID_TASK_POINTS } from '@/lib/tasks'
import type { PaginatedResponse, TaskSummary } from '@/lib/types'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

const VALID_TASK_STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'DONE']
const VALID_PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

function parseLimit(raw: string | null): number {
  const n = parseInt(raw ?? String(DEFAULT_LIMIT), 10)
  if (Number.isNaN(n)) return DEFAULT_LIMIT
  return Math.min(Math.max(1, n), MAX_LIMIT)
}

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)

    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)

    const { searchParams } = request.nextUrl
    const projectId = searchParams.get('projectId') ?? undefined
    const assigneeId = searchParams.get('assigneeId') ?? undefined
    const statusParam = searchParams.get('status') ?? undefined
    const priorityParam = searchParams.get('priority') ?? undefined
    const cursor = searchParams.get('cursor') ?? undefined
    const limit = parseLimit(searchParams.get('limit'))

    if (payload.role === 'EMPLOYEE' && !projectId) {
      return errorResponse('projectId is required', 400)
    }
    if (payload.role === 'EMPLOYEE' && projectId) {
      const allowed = await isMemberOfProject(payload.userId, projectId)
      if (!allowed) return errorResponse('You do not have access to this project', 403)
    }

    if (statusParam && !VALID_TASK_STATUSES.includes(statusParam as TaskStatus)) {
      return errorResponse(`status must be one of: ${VALID_TASK_STATUSES.join(', ')}`, 400)
    }
    if (priorityParam && !VALID_PRIORITIES.includes(priorityParam as Priority)) {
      return errorResponse(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`, 400)
    }

    const where: Prisma.TaskWhereInput = {
      isActive: true,
      ...(projectId ? { projectId } : {}),
      ...(assigneeId ? { assigneeId } : {}),
      ...(statusParam ? { status: statusParam as TaskStatus } : {}),
      ...(priorityParam ? { priority: priorityParam as Priority } : {}),
    }

    const total = await prisma.task.count({ where })
    const raw = await prisma.task.findMany({
      where,
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        project: { select: { name: true } },
        assignee: { select: { name: true, avatarUrl: true } },
      },
    })

    const hasNext = raw.length > limit
    const page = hasNext ? raw.slice(0, limit) : raw
    const nextCursor = hasNext ? (page[page.length - 1]?.id ?? null) : null
    const items: TaskSummary[] = page.map((t) => buildTaskSummary(t))

    const response: PaginatedResponse<TaskSummary> = { items, nextCursor, total }
    return successResponse(response)
  } catch (error) {
    console.error('[GET /api/tasks]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)

    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('Invalid JSON body', 400)
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return errorResponse('Request body must be an object', 400)
    }

    const data = body as Record<string, unknown>
    const titleRaw = data.title
    if (typeof titleRaw !== 'string' || titleRaw.trim().length === 0) {
      return errorResponse('title is required', 400)
    }
    const title = titleRaw.trim()
    if (title.length > 200) return errorResponse('title must be 200 characters or fewer', 400)

    const projectId = typeof data.projectId === 'string' ? data.projectId : ''
    if (!projectId) return errorResponse('projectId is required', 400)

    const project = await prisma.project.findFirst({
      where: { id: projectId, isActive: true },
      select: { id: true, leadId: true },
    })
    if (!project) return errorResponse('Project not found', 400)

    // Only admin/super_admin or this project's lead can create tasks.
    const isAdmin = tokenCan(payload, 'tasks.manage')
    const isLead  = project.leadId === payload.userId
    if (!isAdmin && !isLead) {
      return errorResponse('Only admins or the project lead can create tasks', 403)
    }

    let status: TaskStatus = 'TODO'
    if (typeof data.status === 'string') {
      if (!VALID_TASK_STATUSES.includes(data.status as TaskStatus)) {
        return errorResponse(`status must be one of: ${VALID_TASK_STATUSES.join(', ')}`, 400)
      }
      status = data.status as TaskStatus
    }

    let priority: Priority = 'MEDIUM'
    if (typeof data.priority === 'string') {
      if (!VALID_PRIORITIES.includes(data.priority as Priority)) {
        return errorResponse(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`, 400)
      }
      priority = data.priority as Priority
    }

    const points = parseTaskPoints(data.points)
    if (points === 'invalid') {
      return errorResponse(`points must be one of: ${VALID_TASK_POINTS.join(', ')}`, 400)
    }
    // A payment-related task is raised to at least HIGH automatically.
    priority = priorityForPoints(points ?? null, priority)

    let assigneeId: string | null = null
    if (typeof data.assigneeId === 'string') {
      const membership = await prisma.projectMember.findUnique({
        where: { userId_projectId: { userId: data.assigneeId, projectId } },
        include: { user: { select: { isActive: true } } },
      })
      if (!membership || !membership.user.isActive) {
        return errorResponse('assignee must be an active member of the project', 400)
      }
      assigneeId = data.assigneeId
    }

    let dueDate: Date | null = null
    if (typeof data.dueDate === 'string' && data.dueDate.length > 0) {
      const parsed = new Date(data.dueDate)
      if (Number.isNaN(parsed.getTime())) return errorResponse('dueDate is not a valid date', 400)
      dueDate = parsed
    }

    let startDate: Date | null = null
    if (typeof data.startDate === 'string' && data.startDate.length > 0) {
      const parsed = new Date(data.startDate)
      if (Number.isNaN(parsed.getTime())) return errorResponse('startDate is not a valid date', 400)
      startDate = parsed
    }

    // Ordering is enforced here, not in the DB — Postgres has no CHECK for it
    // and Prisma can't express one. Both routes that write these fields must
    // repeat this (see PATCH in ./[id]/route.ts).
    if (startDate && dueDate && startDate > dueDate) {
      return errorResponse('startDate must be on or before dueDate', 400)
    }

    const completedAt = status === 'DONE' ? new Date() : null

    const created = await prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          title,
          description: typeof data.description === 'string' ? data.description : null,
          // Optional. Trim to null so a blank or whitespace-only box is stored
          // as "no expected output", matching how PATCH already treats it.
          expectedOutput:
            typeof data.expectedOutput === 'string' ? data.expectedOutput.trim() || null : null,
          status,
          priority,
          points: points ?? null,
          projectId,
          assigneeId,
          startDate,
          dueDate,
          completedAt,
        },
      })
      return task
    })

    const full = await prisma.task.findUniqueOrThrow({
      where: { id: created.id },
      include: {
        project: { select: { name: true } },
        assignee: { select: { name: true, avatarUrl: true } },
      },
    })

    return successResponse(buildTaskSummary(full), 201)
  } catch (error) {
    console.error('[POST /api/tasks]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}
