import { type NextRequest } from 'next/server'

import { prisma } from '@/lib/db'
import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { tokenCan } from '@/lib/permissions'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { MAX_TEMPLATE_NAME, loadTemplateDetail, resolveTemplateItems } from '@/lib/task-templates'
import { TX_OPTIONS } from '@/lib/task-categories'

interface Ctx { params: { id: string } }

// ─── GET /api/task-templates/[id] ────────────────────────────────────────────

/** A template with its items in order. Any signed-in internal user. */
export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)
    if (payload.isExternal) return errorResponse('Not available', 403)

    const detail = await loadTemplateDetail(params.id)
    if (!detail) return errorResponse('Template not found', 404)
    return successResponse(detail)
  } catch (error) {
    console.error('[GET /api/task-templates/[id]]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

// ─── PUT /api/task-templates/[id] ────────────────────────────────────────────

/**
 * Save the editor: { name, description?, items: [{ title, categoryId? |
 * categoryName? }] } replaces the template's items in the order given.
 * Admins only. Projects the template was already applied to keep their tasks.
 */
export async function PUT(request: NextRequest, { params }: Ctx) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)
    if (payload.isExternal || !tokenCan(payload, 'tasks.manage')) return errorResponse('Only admins can edit task templates', 403)

    const existing = await prisma.taskTemplate.findFirst({ where: { id: params.id }, select: { id: true } })
    if (!existing) return errorResponse('Template not found', 404)

    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    const name = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : ''
    if (!name) return errorResponse('name is required', 400)
    if (name.length > MAX_TEMPLATE_NAME) return errorResponse(`name must be ${MAX_TEMPLATE_NAME} characters or fewer`, 400)
    const description = typeof body?.description === 'string' ? body.description.trim() || null : null

    const resolved = await resolveTemplateItems(body?.items ?? [])
    if ('error' in resolved) return errorResponse(resolved.error, 400)

    await prisma.$transaction(async (tx) => {
      await tx.taskTemplate.update({ where: { id: existing.id }, data: { name, description } })
      await tx.taskTemplateItem.deleteMany({ where: { templateId: existing.id } })
      await tx.taskTemplateItem.createMany({
        data: resolved.items.map((item, i) => ({ templateId: existing.id, title: item.title, categoryId: item.categoryId, sortOrder: i })),
      })
    }, TX_OPTIONS)
    return successResponse(await loadTemplateDetail(existing.id))
  } catch (error) {
    console.error('[PUT /api/task-templates/[id]]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

// ─── PATCH /api/task-templates/[id] ──────────────────────────────────────────

/** Archive or bring back: { isActive }. Admins only. There is no hard delete. */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)
    if (payload.isExternal || !tokenCan(payload, 'tasks.manage')) return errorResponse('Only admins can archive task templates', 403)

    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (typeof body?.isActive !== 'boolean') return errorResponse('isActive must be true or false', 400)
    const existing = await prisma.taskTemplate.findFirst({ where: { id: params.id }, select: { id: true } })
    if (!existing) return errorResponse('Template not found', 404)

    await prisma.taskTemplate.update({ where: { id: existing.id }, data: { isActive: body.isActive } })
    return successResponse({ id: existing.id, isActive: body.isActive })
  } catch (error) {
    console.error('[PATCH /api/task-templates/[id]]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}
