import { type NextRequest, NextResponse } from 'next/server'

import { prisma } from '@/lib/db'
import { isAdminRole } from '@/lib/auth'
import { authenticateActive } from '@/lib/authz'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { areValidCapabilities } from '@/lib/permissions'

/**
 * GET /api/admin/roles — list this org's custom roles (any admin may view).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = await authenticateActive(request)
    if (!payload || !isAdminRole(payload.role)) return errorResponse('Admin access required', 403)

    const roles = await prisma.customRole.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        baseRole: true,
        permissions: true,
        isExternal: true,
        _count: { select: { users: true } },
      },
    })
    return successResponse(roles.map((r) => ({ ...r, userCount: r._count.users, _count: undefined })))
  } catch (error) {
    console.error('[GET /api/admin/roles]', error)
    return errorResponse('Server error', 500)
  }
}

/**
 * POST /api/admin/roles — create a custom role. Admins & super-admins.
 * Body: { name, baseRole?: 'ADMIN' | 'EMPLOYEE', permissions: string[] }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = await authenticateActive(request)
    if (!payload) return errorResponse('Authentication required', 401)
    if (!isAdminRole(payload.role)) return errorResponse('Admin access required', 403)

    let body: unknown
    try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }
    const { name, baseRole, permissions, isExternal } = body as Record<string, unknown>

    if (!name || typeof name !== 'string' || name.trim().length < 2)
      return errorResponse('Role name is required (min 2 chars)', 400)
    const base = baseRole === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE'
    if (!areValidCapabilities(permissions))
      return errorResponse('permissions must be an array of valid capability keys', 400)

    const trimmed = name.trim()
    const existing = await prisma.customRole.findFirst({ where: { name: trimmed } })
    if (existing) return errorResponse('A role with that name already exists', 409)

    const role = await prisma.customRole.create({
      data: { name: trimmed, baseRole: base, permissions: permissions as string[], isExternal: isExternal === true },
      select: { id: true, name: true, baseRole: true, permissions: true, isExternal: true },
    })
    return successResponse(role, 201)
  } catch (error) {
    console.error('[POST /api/admin/roles]', error)
    return errorResponse('Server error', 500)
  }
}
