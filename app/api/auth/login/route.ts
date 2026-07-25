import { type NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { comparePassword, signToken, COOKIE_NAME } from '@/lib/auth'
import { resolveCapabilities } from '@/lib/permissions'
import { getOrgBranding } from '@/lib/org-branding'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { istDateOnly } from '@/lib/date-ist'
import type { AuthUser, ApiResponse } from '@/lib/types'

const COOKIE_MAX_AGE = 60 * 60 * 24 * 7

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<AuthUser> | ApiResponse<never>>> {
  try {
    let body: unknown
    try { body = await request.json() } catch { return errorResponse('Request body must be valid JSON', 400) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('Request body must be a JSON object', 400)
    const { email, password } = body as Record<string, unknown>
    if (!email || typeof email !== 'string' || email.trim().length === 0) return errorResponse('email is required', 400)
    if (!password || typeof password !== 'string' || password.length === 0) return errorResponse('password is required', 400)

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: { customRole: { select: { permissions: true, isExternal: true } } },
    })
    if (!user) return errorResponse('Invalid email or password', 401)
    if (!user.isActive) return errorResponse('Account is deactivated', 403)
    const valid = await comparePassword(password, user.passwordHash)
    if (!valid) return errorResponse('Invalid email or password', 401)

    // Embed capabilities in the token ONLY for users with a custom role, so
    // normal admins/employees keep their legacy (undefined) access shape.
    const capabilities = user.customRole
      ? [...resolveCapabilities(user.role, user.customRole)]
      : undefined
    const isExternal = user.customRole?.isExternal === true

    const token = signToken({ userId: user.id, email: user.email, role: user.role, isOnboarding: user.isOnboarding, mustChangePassword: user.mustChangePassword, organizationId: user.organizationId, capabilities, ...(isExternal && { isExternal: true }) })
    if (!token) return errorResponse('Authentication service unavailable', 503)

    // If approved user: set WORKING + create daily activity.
    // Fire-and-forget: a transient DB blip on these presence writes must NOT
    // fail the whole login response — the user is already authenticated.
    if (!user.isOnboarding) {
      const today = istDateOnly()
      void Promise.all([
        prisma.user.update({ where: { id: user.id }, data: { currentStatus: 'WORKING' } }),
        prisma.dailyActivity.upsert({
          where: { userId_date: { userId: user.id, date: today } },
          update: { wasActive: true, lastSeenAt: new Date() },
          create: { userId: user.id, date: today, wasActive: true, lastSeenAt: new Date() },
        }),
      ]).catch((err: unknown) => {
        const code = (err as { code?: string })?.code ?? 'UNKNOWN'
        console.warn(`[POST /api/auth/login] presence update failed (non-fatal, code=${code})`)
      })
    }

    const branding = await getOrgBranding(user.organizationId)
    const authUser: AuthUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role as AuthUser['role'],
      avatarUrl: user.avatarUrl,
      currentStatus: user.isOnboarding ? 'NOT_WORKING' : 'WORKING',
      isOnboarding: user.isOnboarding,
      mustChangePassword: user.mustChangePassword,
      createdAt: user.createdAt,
      orgName: branding.orgName,
      orgShort: branding.orgShort,
    }

    const response = successResponse(authUser)
    response.cookies.set(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE,
    })
    return response
  } catch (error) {
    console.error('[POST /api/auth/login]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}
