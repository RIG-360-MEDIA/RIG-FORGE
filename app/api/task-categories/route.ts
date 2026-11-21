import { type NextRequest } from 'next/server'

import { prisma } from '@/lib/db'
import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { CATEGORY_SELECT, MAX_CATEGORY_NAME, canManageProjectTasks, cleanCategoryName, findOrCreateCategory } from '@/lib/task-categories'
import type { TaskCategorySummary } from '@/lib/types'

// ─── GET /api/task-categories ────────────────────────────────────────────────

/**
 * The company's task categories, in their display order. Any signed-in user:
 * the Tasks tab shows them to everyone on a project. ?all=1 includes archived
 * ones (for the admin "Manage categories" list).
 */
export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)

    const all = request.nextUrl.searchParams.get('all') === '1'
    const rows = await prisma.taskCategory.findMany({
      where: all ? {} : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: CATEGORY_SELECT,
    })
    return successResponse<TaskCategorySummary[]>(rows)
  } catch (error) {
    console.error('[GET /api/task-categories]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

// ─── POST /api/task-categories ───────────────────────────────────────────────

/**
 * Add a category: { name, projectId? }. Admins anywhere; a project lead when
 * adding from inside a project they lead. A name that already exists (in any
 * letter case) returns that category instead of failing, and an archived one
 * with that name is brought back, so "add Electrical" always ends with an
 * Electrical category to file the task under.
 */
export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)

    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    const name = cleanCategoryName(body?.name)
    if (!name) return errorResponse('name is required', 400)
    if (name.length > MAX_CATEGORY_NAME) return errorResponse(`name must be ${MAX_CATEGORY_NAME} characters or fewer`, 400)

    if (!(await canManageProjectTasks(payload, body?.projectId))) {
      return errorResponse('Only admins or the project lead can add categories', 403)
    }

    const { category, created } = await findOrCreateCategory(name)
    return successResponse<TaskCategorySummary>(category, created ? 201 : 200)
  } catch (error) {
    console.error('[POST /api/task-categories]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}
