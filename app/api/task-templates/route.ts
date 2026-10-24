import { type NextRequest } from 'next/server'

import { prisma } from '@/lib/db'
import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { tokenCan } from '@/lib/permissions'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { MAX_TEMPLATE_NAME, resolveTemplateItems } from '@/lib/task-templates'
import type { TaskTemplateSummary } from '@/lib/types'

// ─── GET /api/task-templates ─────────────────────────────────────────────────

/**
 * The company's task templates with their size and categories, for the
 * template page and the "Add from template" and new-project pickers. Any
 * signed-in internal user (leads apply them); ?all=1 includes archived ones.
 */
export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)
    if (payload.isExternal) return errorResponse('Not available', 403)

    const all = request.nextUrl.searchParams.get('all') === '1'
    const rows = await prisma.taskTemplate.findMany({
      where: all ? {} : { isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, description: true, isActive: true,
        items: { orderBy: { sortOrder: 'asc' }, select: { category: { select: { name: true } } } },
      },
    })
    const out: TaskTemplateSummary[] = rows.map((t) => ({
      id: t.id, name: t.name, description: t.description, isActive: t.isActive,
      itemCount: t.items.length,
      categories: [...new Set(t.items.map((i) => i.category?.name ?? 'No category'))],
    }))
    return successResponse(out)
  } catch (error) {
    console.error('[GET /api/task-templates]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

// ─── POST /api/task-templates ────────────────────────────────────────────────

/**
 * Create a template: { name, description?, items: [{ title, categoryId? |
 * categoryName? }] }. Admins only (tasks.manage). Items given by category
 * name (an Excel import) are filed under that company category, which is
 * created if it does not exist yet.
 */
export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)
    if (!tokenCan(payload, 'tasks.manage')) return errorResponse('Only admins can create task templates', 403)

    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    const name = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : ''
    if (!name) return errorResponse('name is required', 400)
    if (name.length > MAX_TEMPLATE_NAME) return errorResponse(`name must be ${MAX_TEMPLATE_NAME} characters or fewer`, 400)
    const description = typeof body?.description === 'string' ? body.description.trim() || null : null

    const resolved = await resolveTemplateItems(body?.items ?? [])
    if ('error' in resolved) return errorResponse(resolved.error, 400)

    // Top-level creates (not a nested items.create) so the org-scope
    // extension stamps every row with the caller's company.
    const created = await prisma.$transaction(async (tx) => {
      const t = await tx.taskTemplate.create({ data: { name, description }, select: { id: true } })
      // One insert: a 73-item sheet one row at a time overran the 5 s transaction limit.
      await tx.taskTemplateItem.createMany({
        data: resolved.items.map((item, i) => ({ templateId: t.id, title: item.title, categoryId: item.categoryId, sortOrder: i })),
      })
      return t
    })
    return successResponse({ id: created.id, itemCount: resolved.items.length }, 201)
  } catch (error) {
    console.error('[POST /api/task-templates]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}
