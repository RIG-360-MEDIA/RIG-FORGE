import { type NextRequest } from 'next/server'

import { Prisma } from '@prisma/client'

import { prisma } from '@/lib/db'
import { getOrgId } from '@/lib/tenant-context'
import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { tokenCan } from '@/lib/permissions'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { fetchProjectDetail, fetchProjectSummary } from '@/lib/projects'
import type { ProjectSummary, PaginatedResponse, ApiResponse, ProjectDetail, ProjectLink } from '@/lib/types'

// ─── GET /api/projects ────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
): Promise<ReturnType<typeof successResponse<PaginatedResponse<ProjectSummary>>> | ReturnType<typeof errorResponse>> {
  try {
    // ── 1. Auth ───────────────────────────────────────────────────────────────
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)

    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired session', 401)

    // ── 2. Query params ───────────────────────────────────────────────────────
    const { searchParams } = request.nextUrl
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') ?? '20', 10), 1), 100)
    const cursor = searchParams.get('cursor') ?? undefined
    const search = searchParams.get('search')?.trim() ?? ''
    const status = searchParams.get('status') ?? ''
    const priority = searchParams.get('priority') ?? ''

    // ── 3. Build where clause ─────────────────────────────────────────────────
    // ADMIN: all active projects
    // EMPLOYEE: only projects where they have a ProjectMember record
    const where: Prisma.ProjectWhereInput = {
      isActive: true,
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
        ],
      }),
      ...(status && { status: status as never }),
      ...(priority && { priority: priority as never }),
      // External/client users are ALWAYS limited to projects they're a member of,
      // regardless of any capability — they only see what admins add them to.
      ...((payload.isExternal || !tokenCan(payload, 'projects.view_all')) && {
        members: { some: { userId: payload.userId } },
      }),
    }

    // ── 4. Count total (unaffected by cursor) ─────────────────────────────────
    const total = await prisma.project.count({ where })

    // ── 5. Fetch page ─────────────────────────────────────────────────────────
    const projects = await prisma.project.findMany({
      where,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      take: limit + 1,
      orderBy: { createdAt: 'desc' },
      include: {
        tasks: {
          where: { isActive: true },
          select: { status: true },
        },
        members: {
          take: 5,
          orderBy: { joinedAt: 'asc' },
          select: {
            user: {
              select: { id: true, name: true, avatarUrl: true, role: true },
            },
          },
        },
        _count: { select: { members: true } },
        lead: { select: { name: true } },
      },
    })

    // ── 6. Determine next cursor ───────────────────────────────────────────────
    const hasMore = projects.length > limit
    const page = hasMore ? projects.slice(0, limit) : projects
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null

    // ── 7. Map to ProjectSummary ───────────────────────────────────────────────
    const items: ProjectSummary[] = page.map((p) => {
      const totalTasks = p.tasks.length
      const doneTasks = p.tasks.filter((t) => t.status === 'DONE').length
      const rawLinks = p.links
      const links: ProjectLink[] = Array.isArray(rawLinks)
        ? (rawLinks as unknown as ProjectLink[])
        : []
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        status: p.status,
        priority: p.priority,
        deadline: p.deadline,
        leadId: p.leadId,
        leadName: p.lead?.name ?? null,
        links,
        totalTasks,
        doneTasks,
        memberCount: p._count.members,
        members: p.members.map((m) => ({
          id: m.user.id,
          name: m.user.name,
          avatarUrl: m.user.avatarUrl,
          role: m.user.role,
        })),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      }
    })

    const data: PaginatedResponse<ProjectSummary> = { items, nextCursor, total }
    return successResponse(data)
  } catch (error) {
    console.error('[GET /api/projects]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

// ─── POST /api/projects ───────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
): Promise<ReturnType<typeof successResponse<ProjectDetail>> | ReturnType<typeof errorResponse>> {
  try {
    // ── 1. Auth — admin only ──────────────────────────────────────────────────
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)

    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired session', 401)

    if (!tokenCan(payload, 'projects.manage')) return errorResponse('Admin access required', 403)

    // ── 2. Parse body ─────────────────────────────────────────────────────────
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('Request body must be valid JSON', 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return errorResponse('Request body must be a JSON object', 400)
    }

    const { name, description, status, priority, deadline, leadId, links } =
      body as Record<string, unknown>

    // ── 3. Validate required fields ───────────────────────────────────────────
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return errorResponse('name is required', 400)
    }
    if (name.length > 100) {
      return errorResponse('name must not exceed 100 characters', 400)
    }
    if (typeof description === 'string' && description.length > 500) {
      return errorResponse('description must not exceed 500 characters', 400)
    }

    // Reject HTML/script tags in name and description (BUG-002)
    const HTML_TAG_RE = /<[^>]+>/i
    if (HTML_TAG_RE.test(name)) {
      return errorResponse('Project name must not contain HTML or script tags', 400)
    }
    if (typeof description === 'string' && HTML_TAG_RE.test(description)) {
      return errorResponse('Project description must not contain HTML or script tags', 400)
    }

    if (!leadId || typeof leadId !== 'string' || leadId.trim().length === 0) {
      return errorResponse('leadId is required', 400)
    }

    // Verify lead user exists
    const leadUser = await prisma.user.findUnique({
      where: { id: leadId, isActive: true },
      select: { id: true },
    })
    if (!leadUser) return errorResponse('leadId must reference a valid active user', 400)

    const validStatuses = ['ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED']
    const validPriorities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

    const resolvedStatus =
      typeof status === 'string' && validStatuses.includes(status) ? status : 'ACTIVE'

    const resolvedPriority =
      typeof priority === 'string' && validPriorities.includes(priority) ? priority : 'MEDIUM'

    const resolvedDeadline =
      typeof deadline === 'string' && deadline.length > 0 ? new Date(deadline) : null

    if (resolvedDeadline !== null && isNaN(resolvedDeadline.getTime())) {
      return errorResponse('deadline must be a valid ISO date string', 400)
    }

    // Validate links (optional, max 5)
    let resolvedLinks: ProjectLink[] = []
    if (links !== undefined) {
      if (!Array.isArray(links)) {
        return errorResponse('links must be an array', 400)
      }
      if (links.length > 5) {
        return errorResponse('links must not exceed 5 items', 400)
      }
      for (const link of links) {
        if (
          !link ||
          typeof link !== 'object' ||
          typeof (link as Record<string, unknown>).label !== 'string' ||
          typeof (link as Record<string, unknown>).url !== 'string'
        ) {
          return errorResponse('each link must have a label and url string', 400)
        }
      }
      resolvedLinks = links as ProjectLink[]
    }

    // ── 4. Create project + auto-add lead as member + create ProjectThread ────
    const project = await prisma.project.create({
      data: {
        name: name.trim(),
        description: typeof description === 'string' ? description.trim() : null,
        status: resolvedStatus as never,
        priority: resolvedPriority as never,
        deadline: resolvedDeadline,
        leadId: leadId.trim(),
        links: resolvedLinks as never,
        // NOTE: nested creates are NOT touched by the org-scope extension
        // (lib/db.ts only injects organizationId on top-level ops). Without an
        // explicit value they fall back to the column default ("rig360"), which
        // mis-stamps every non-rig360 tenant's lead membership + thread. Stamp
        // them with the caller's org so scoped reads (counts, lists, assignee
        // dropdowns) see them.
        members: {
          create: { userId: leadId.trim(), organizationId: getOrgId() },
        },
        thread: {
          create: { organizationId: getOrgId() },
        },
      },
    })

    // ── 5. Return full ProjectDetail ──────────────────────────────────────────
    const detail = await fetchProjectDetail(project.id)
    if (!detail) return errorResponse('Failed to retrieve created project', 500)

    return successResponse(detail, 201)
  } catch (error) {
    console.error('[POST /api/projects]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}
