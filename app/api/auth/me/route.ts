import { type NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyToken, getTokenFromCookies } from '@/lib/auth'
import { resolveCapabilities } from '@/lib/permissions'
import { getOrgBranding } from '@/lib/org-branding'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import type { AuthUser, ApiResponse } from '@/lib/types'

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<AuthUser> | ApiResponse<never>>> {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Not authenticated', 401)

    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { customRole: { select: { name: true, permissions: true, isExternal: true } } },
    })
    if (!user) return errorResponse('User not found', 404)

    const branding = await getOrgBranding(user.organizationId)
    const authUser: AuthUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role as AuthUser['role'],
      avatarUrl: user.avatarUrl,
      currentStatus: user.currentStatus as 'WORKING' | 'NOT_WORKING',
      isOnboarding: user.isOnboarding,
      mustChangePassword: user.mustChangePassword,
      createdAt: user.createdAt,
      // Only send capabilities for custom-role users (keeps legacy shape otherwise).
      capabilities: user.customRole ? [...resolveCapabilities(user.role, user.customRole)] : undefined,
      customRoleName: user.customRole?.name ?? null,
      isExternal: user.customRole?.isExternal === true,
      orgName: branding.orgName,
      orgShort: branding.orgShort,
    }

    return successResponse(authUser)
  } catch (error) {
    console.error('[GET /api/auth/me]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}
