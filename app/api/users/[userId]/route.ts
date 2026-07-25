import { type NextRequest, NextResponse } from 'next/server'

import { prisma } from '@/lib/db'
import { authenticateActive, authenticateCapable } from '@/lib/authz'
import { can } from '@/lib/permissions'
import { isAdminRole } from '@/lib/roles'
import { successResponse, errorResponse } from '@/lib/api-helpers'

/**
 * DELETE /api/users/[userId]
 *
 * Soft-deactivates a user (sets isActive = false). Login already rejects
 * inactive users, and all list endpoints filter by isActive: true, so a
 * deactivated user disappears from the platform while their task/ticket
 * history stays intact.
 *
 * Permission matrix (mirrors the existing tempPassword visibility rules):
 *   - ADMIN may remove EMPLOYEE only.
 *   - SUPER_ADMIN may remove EMPLOYEE or ADMIN.
 *   - No one may remove a SUPER_ADMIN.
 *   - No one may remove themselves.
 */
/**
 * PATCH /api/users/[userId]
 *
 * Changes a user's role. Reserved for SUPER_ADMIN — role changes are a
 * privileged, org-shaping action, so an ordinary ADMIN cannot promote/demote.
 *
 * Rules:
 *   - Only SUPER_ADMIN may change roles.
 *   - Allowed target roles: ADMIN or EMPLOYEE (you cannot mint a SUPER_ADMIN here).
 *   - A SUPER_ADMIN account's role cannot be changed via this route.
 *   - You cannot change your own role.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { userId: string } },
): Promise<NextResponse> {
  try {
    // Privileged write: re-validate role from the DB, not the JWT.
    const payload = await authenticateActive(request)
    if (!payload) return errorResponse('Authentication required', 401)

    let body: unknown
    try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }
    const { role, customRoleId } = body as Record<string, unknown>

    const assigningCustomRole = 'customRoleId' in (body as object)

    // Gate by operation:
    //  - Assigning/clearing a custom role is an admin action (admins hand out
    //    the permission sets they build). Assigning an ADMIN-base role is still
    //    reserved for super-admins below (an admin must not mint another admin).
    //  - Changing the coarse base role (Employee <-> Admin) stays SUPER_ADMIN only.
    if (assigningCustomRole) {
      if (!isAdminRole(payload.role)) return errorResponse('Admin access required', 403)
    } else {
      if (payload.role !== 'SUPER_ADMIN') return errorResponse('Only super admins can change base roles', 403)
    }

    if (!assigningCustomRole && role !== 'ADMIN' && role !== 'EMPLOYEE') {
      return errorResponse('Role must be ADMIN or EMPLOYEE', 400)
    }

    const { userId } = params
    if (userId === payload.userId) {
      return errorResponse('You cannot change your own role', 400)
    }

    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, isActive: true, name: true },
    })
    if (!target) return errorResponse('User not found', 404)
    if (!target.isActive) return errorResponse('User is deactivated', 400)

    // A SUPER_ADMIN is untouchable via this route.
    if (target.role === 'SUPER_ADMIN') {
      return errorResponse('Super admin roles cannot be changed here', 403)
    }

    // ── Assign / clear a custom role ──────────────────────────────────────────
    if (assigningCustomRole) {
      if (customRoleId === null) {
        const updated = await prisma.user.update({
          where: { id: userId },
          data: { customRoleId: null },
          select: { id: true, name: true, role: true, customRoleId: true },
        })
        return successResponse(updated)
      }
      if (typeof customRoleId !== 'string') {
        return errorResponse('customRoleId must be a string or null', 400)
      }
      const customRole = await prisma.customRole.findUnique({
        where: { id: customRoleId },
        select: { id: true, baseRole: true },
      })
      if (!customRole) return errorResponse('Custom role not found', 404)

      // An ADMIN-base custom role bumps the target's enum role to ADMIN — that's
      // effectively promotion, so keep it super-admin-only. Regular admins can
      // still assign any EMPLOYEE-base role (any capability subset).
      if (customRole.baseRole === 'ADMIN' && payload.role !== 'SUPER_ADMIN') {
        return errorResponse('Only super admins can assign an admin-level role', 403)
      }

      const updated = await prisma.user.update({
        where: { id: userId },
        // Keep the coarse enum role aligned to the custom role's base so legacy gates match.
        data: { customRoleId: customRole.id, role: customRole.baseRole },
        select: { id: true, name: true, role: true, customRoleId: true },
      })
      return successResponse(updated)
    }

    // ── Direct enum role change (Employee ↔ Admin) ────────────────────────────
    if (target.role === role) {
      return errorResponse(`User is already ${role}`, 400)
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      // A plain enum change clears any custom role to avoid a stale mismatch.
      data: { role: role as 'ADMIN' | 'EMPLOYEE', customRoleId: null },
      select: { id: true, name: true, role: true },
    })

    return successResponse(updated)
  } catch (error) {
    console.error('[PATCH /api/users/[userId]]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { userId: string } },
): Promise<NextResponse> {
  try {
    // Privileged write: re-validate role + capabilities from the DB, not the JWT.
    const payload = await authenticateCapable(request)
    if (!payload) return errorResponse('Authentication required', 401)

    if (!can(payload.capabilities, 'members.manage')) {
      return errorResponse('Only admins can remove members', 403)
    }
    const callerIsSuperAdmin = payload.role === 'SUPER_ADMIN'

    const { userId } = params
    if (userId === payload.userId) {
      return errorResponse('You cannot remove your own account', 400)
    }

    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, isActive: true, name: true },
    })
    if (!target) return errorResponse('User not found', 404)
    if (!target.isActive) return errorResponse('User is already deactivated', 400)

    // SUPER_ADMIN is untouchable.
    if (target.role === 'SUPER_ADMIN') {
      return errorResponse('Super admins cannot be removed', 403)
    }
    // Only SUPER_ADMIN can remove an ADMIN.
    if (target.role === 'ADMIN' && !callerIsSuperAdmin) {
      return errorResponse('Only super admins can remove other admins', 403)
    }

    await prisma.user.update({
      where: { id: userId },
      data: { isActive: false, currentStatus: 'NOT_WORKING' },
    })

    return successResponse({ id: userId, name: target.name })
  } catch (error) {
    console.error('[DELETE /api/users/[userId]]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}
