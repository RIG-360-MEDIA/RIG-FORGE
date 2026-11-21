import { type NextRequest } from 'next/server'

import { prisma } from '@/lib/db'
import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { tokenCan } from '@/lib/permissions'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { CATEGORY_SELECT, MAX_CATEGORY_NAME, cleanCategoryName } from '@/lib/task-categories'
import type { TaskCategorySummary } from '@/lib/types'

// ─── PATCH /api/task-categories/[id] ─────────────────────────────────────────

/**
 * Rename, reorder or archive a category: { name?, sortOrder?, isActive? }.
 * Admins only (tasks.manage): categories are shared by every project, so a
 * rename shows everywhere. Archiving keeps the category on tasks that use it
 * and only hides it from pickers; there is no hard delete.
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)
    if (payload.isExternal || !tokenCan(payload, 'tasks.manage')) return errorResponse('Only admins can change task categories', 403)

    const category = await prisma.taskCategory.findFirst({ where: { id: params.id }, select: { id: true } })
    if (!category) return errorResponse('Category not found', 404)

    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return errorResponse('Request body must be an object', 400)

    const update: { name?: string; sortOrder?: number; isActive?: boolean } = {}
    if ('name' in body) {
      const name = cleanCategoryName(body.name)
      if (!name) return errorResponse('name must not be empty', 400)
      if (name.length > MAX_CATEGORY_NAME) return errorResponse(`name must be ${MAX_CATEGORY_NAME} characters or fewer`, 400)
      const clash = await prisma.taskCategory.findFirst({
        where: { name: { equals: name, mode: 'insensitive' }, id: { not: category.id } },
        select: { id: true },
      })
      if (clash) return errorResponse(`A category named "${name}" already exists`, 409)
      update.name = name
    }
    if ('sortOrder' in body) {
      if (!Number.isInteger(body.sortOrder)) return errorResponse('sortOrder must be a whole number', 400)
      update.sortOrder = body.sortOrder as number
    }
    if ('isActive' in body) {
      if (typeof body.isActive !== 'boolean') return errorResponse('isActive must be true or false', 400)
      update.isActive = body.isActive
    }
    if (Object.keys(update).length === 0) return errorResponse('No editable fields provided', 400)

    const saved = await prisma.taskCategory.update({ where: { id: category.id }, data: update, select: CATEGORY_SELECT })
    return successResponse<TaskCategorySummary>(saved)
  } catch (error) {
    console.error('[PATCH /api/task-categories/[id]]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}
