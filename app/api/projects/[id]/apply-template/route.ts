import { type NextRequest } from 'next/server'

import { prisma } from '@/lib/db'
import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { canManageProjectTasks } from '@/lib/task-categories'
import { applyTemplate } from '@/lib/task-templates'

// ─── POST /api/projects/[id]/apply-template ──────────────────────────────────

/**
 * Add a template's items to this project's Task List, unassigned:
 * { templateId, itemIds? } (itemIds = only the items ticked; all when
 * omitted). Items already in the project are skipped. Admins and the
 * project lead. Returns { added: TaskSummary[], skipped }.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)

    const project = await prisma.project.findFirst({ where: { id: params.id, isActive: true }, select: { id: true } })
    if (!project) return errorResponse('Project not found', 404)
    if (!(await canManageProjectTasks(payload, project.id))) {
      return errorResponse('Only admins or the project lead can add a template to a project', 403)
    }

    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    const templateId = typeof body?.templateId === 'string' ? body.templateId : ''
    if (!templateId) return errorResponse('templateId is required', 400)
    let itemIds: string[] | undefined
    if (body?.itemIds !== undefined) {
      if (!Array.isArray(body.itemIds) || body.itemIds.some((x) => typeof x !== 'string')) return errorResponse('itemIds must be a list of ids', 400)
      itemIds = body.itemIds as string[]
    }

    const result = await applyTemplate(project.id, templateId, itemIds)
    if ('error' in result) return errorResponse(result.error, 400)
    return successResponse(result, 201)
  } catch (error) {
    console.error('[POST /api/projects/[id]/apply-template]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}
