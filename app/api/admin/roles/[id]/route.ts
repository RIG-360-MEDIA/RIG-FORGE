import { type NextRequest, NextResponse } from 'next/server'

import { prisma } from '@/lib/db'
import { authenticateActive } from '@/lib/authz'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { areValidCapabilities } from '@/lib/permissions'
import { isAdminRole } from '@/lib/roles'

/**
 * PATCH /api/admin/roles/[id] — edit a custom role. Admins & super-admins.
 * Body: { name?, baseRole?, permissions? }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    const payload = await authenticateActive(request)
    if (!payload) return errorResponse('Authentication required', 401)
    if (!isAdminRole(payload.role)) return errorResponse('Admin access required', 403)

    const existing = await prisma.customRole.findUnique({ where: { id: params.id } })
    if (!existing) return errorResponse('Role not found', 404)

    let body: unknown
    try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }
    const { name, baseRole, permissions, isExternal } = body as Record<string, unknown>

    const data: { name?: string; baseRole?: 'ADMIN' | 'EMPLOYEE'; permissions?: string[]; isExternal?: boolean } = {}
    if (isExternal !== undefined) data.isExternal = isExternal === true

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length < 2)
        return errorResponse('Role name must be at least 2 chars', 400)
      const trimmed = name.trim()
      const clash = await prisma.customRole.findFirst({ where: { name: trimmed, id: { not: params.id } } })
      if (clash) return errorResponse('A role with that name already exists', 409)
      data.name = trimmed
    }
    if (baseRole !== undefined) data.baseRole = baseRole === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE'
    if (permissions !== undefined) {
      if (!areValidCapabilities(permissions))
        return errorResponse('permissions must be an array of valid capability keys', 400)
      data.permissions = permissions
    }

    const updated = await prisma.customRole.update({
      where: { id: params.id },
      data,
      select: { id: true, name: true, baseRole: true, permissions: true, isExternal: true },
    })

    // If baseRole changed, keep assigned users' coarse enum role in sync so legacy gates match.
    if (data.baseRole) {
      await prisma.user.updateMany({
        where: { customRoleId: params.id },
        data: { role: data.baseRole },
      })
    }

    return successResponse(updated)
  } catch (error) {
    console.error('[PATCH /api/admin/roles/[id]]', error)
    return errorResponse('Server error', 500)
  }
}

/**
 * DELETE /api/admin/roles/[id] — delete a custom role. Admins & super-admins.
 * Unassigns it from any users first (their coarse enum role is preserved).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    const payload = await authenticateActive(request)
    if (!payload) return errorResponse('Authentication required', 401)
    if (!isAdminRole(payload.role)) return errorResponse('Admin access required', 403)

    const existing = await prisma.customRole.findUnique({ where: { id: params.id } })
    if (!existing) return errorResponse('Role not found', 404)

    await prisma.user.updateMany({ where: { customRoleId: params.id }, data: { customRoleId: null } })
    await prisma.customRole.delete({ where: { id: params.id } })

    return successResponse({ id: params.id })
  } catch (error) {
    console.error('[DELETE /api/admin/roles/[id]]', error)
    return errorResponse('Server error', 500)
  }
}
