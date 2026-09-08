import { type NextRequest } from 'next/server'

import { prisma } from '@/lib/db'
import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { tokenCan } from '@/lib/permissions'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { fetchProjectDetail } from '@/lib/projects'
import { excludeHiddenUsersWhere } from '@/lib/hidden-users'

// ─── Route params ─────────────────────────────────────────────────────────────

interface RouteContext {
  params: { id: string }
}

// ─── GET /api/projects/[id]/members ──────────────────────────────────────────

/**
 * List members of a project.
 * Auth: any authenticated user who is an admin OR a member of the project.
 * Returns: Array of { userId, name, avatarUrl }.
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)

    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)

    const { id: projectId } = params

    const project = await prisma.project.findUnique({
      where: { id: projectId, isActive: true },
      select: { id: true },
    })
    if (!project) return errorResponse('Project not found', 404)

    if (!tokenCan(payload, 'projects.view_all')) {
      const membership = await prisma.projectMember.findUnique({
        where: { userId_projectId: { userId: payload.userId, projectId } },
        select: { id: true },
      })
      if (!membership) return errorResponse('Project not found', 404)
    }

    const members = await prisma.projectMember.findMany({
      where: { projectId },
      orderBy: { joinedAt: 'asc' },
      select: {
        user: {
          select: { id: true, name: true, avatarUrl: true, isActive: true },
        },
      },
    })

    const result = members
      .filter((m) => m.user.isActive)
      .map((m) => ({
        userId: m.user.id,
        name: m.user.name,
        avatarUrl: m.user.avatarUrl,
      }))

    // Opt-in, so the roster this endpoint normally returns is unchanged for
    // every existing caller. The task assignee picker asks for this because a
    // super admin can be given a task on any project without being added to it
    // (see canBeAssigned in lib/projects.ts) — without them here, the picker
    // would not offer the one person the team most needs to send questions to.
    if (request.nextUrl.searchParams.get('includeSuperAdmins') === '1') {
      const already = new Set(result.map((m) => m.userId))
      const supers = await prisma.user.findMany({
        where: { role: 'SUPER_ADMIN', isActive: true, ...excludeHiddenUsersWhere() },
        select: { id: true, name: true, avatarUrl: true },
        orderBy: { name: 'asc' },
      })
      for (const s of supers) {
        if (!already.has(s.id)) {
          result.push({ userId: s.id, name: s.name, avatarUrl: s.avatarUrl })
        }
      }
    }

    return successResponse(result)
  } catch (error) {
    console.error('[GET /api/projects/[id]/members]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

// ─── POST /api/projects/[id]/members ─────────────────────────────────────────

/**
 * Add one or more members to a project.
 * Invalid userIds (not found or inactive) are silently skipped.
 * Already-members are silently skipped via skipDuplicates.
 * Auth: ADMIN only.
 * Returns: Updated ProjectDetail.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)

    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)

    if (!tokenCan(payload, 'projects.manage')) {
      return errorResponse('Only admins can add members to projects', 403)
    }

    const { id: projectId } = params

    // ── Verify project exists ──────────────────────────────────────────────
    const project = await prisma.project.findUnique({
      where: { id: projectId, isActive: true },
      select: { id: true },
    })
    if (!project) return errorResponse('Project not found', 404)

    // ── Parse body ─────────────────────────────────────────────────────────
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('Invalid JSON body', 400)
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return errorResponse('Request body must be an object', 400)
    }

    const data = body as Record<string, unknown>

    if (!Array.isArray(data.userIds) || data.userIds.length === 0) {
      return errorResponse('userIds must be a non-empty array', 400)
    }

    const userIds = (data.userIds as unknown[]).filter(
      (id): id is string => typeof id === 'string',
    )

    if (userIds.length === 0) {
      return errorResponse('userIds must contain valid string IDs', 400)
    }

    // ── Resolve valid, active users ────────────────────────────────────────
    const validUsers = await prisma.user.findMany({
      where: { id: { in: userIds }, isActive: true },
      select: { id: true },
    })

    if (validUsers.length > 0) {
      await prisma.projectMember.createMany({
        data: validUsers.map((u) => ({
          userId: u.id,
          projectId,
        })),
        skipDuplicates: true,
      })
    }

    // ── Return updated detail ──────────────────────────────────────────────
    const detail = await fetchProjectDetail(projectId)
    if (!detail) return errorResponse('Failed to retrieve updated project', 500)

    return successResponse(detail)
  } catch (error) {
    console.error('[POST /api/projects/[id]/members]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}
