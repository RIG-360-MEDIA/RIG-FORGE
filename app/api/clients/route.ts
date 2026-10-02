import { type NextRequest } from 'next/server'

import { Prisma } from '@prisma/client'

import { prisma } from '@/lib/db'
import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { tokenCan } from '@/lib/permissions'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import type { ClientSummary } from '@/lib/types'

const HTML_TAG_RE = /<[^>]+>/i

// ─── GET /api/clients?search=&limit= ──────────────────────────────────────────
// Every signed-in user may READ clients — the project list and detail pages show
// the client name, so gating reads would blank it out for employees. Writes are
// gated on projects.manage below.
export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired session', 401)

    const { searchParams } = request.nextUrl
    const search = searchParams.get('search')?.trim() ?? ''
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') ?? '50', 10), 1), 100)

    const where: Prisma.ClientWhereInput = {
      isActive: true,
      ...(search && { name: { contains: search, mode: 'insensitive' } }),
    }

    const clients = await prisma.client.findMany({
      where,
      take: limit,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        contactEmail: true,
        contactPhone: true,
        _count: { select: { projects: true } },
      },
    })

    const items: ClientSummary[] = clients.map((c) => ({
      id: c.id,
      name: c.name,
      contactEmail: c.contactEmail,
      contactPhone: c.contactPhone,
      projectCount: c._count.projects,
    }))

    return successResponse({ items })
  } catch (error) {
    console.error('[GET /api/clients]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

// ─── POST /api/clients ────────────────────────────────────────────────────────
// Body: { name, contactEmail?, contactPhone?, googleContactId? }
//
// Used by the inline "create client" in the project modals, so it stays small.
// Names are unique per org (@@unique([organizationId, name])) — a duplicate
// returns 409 WITH the existing client so the picker can just select it instead
// of making the user retype.
export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired session', 401)

    if (!tokenCan(payload, 'projects.manage')) {
      return errorResponse('Admin access required', 403)
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('Request body must be valid JSON', 400)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return errorResponse('Request body must be a JSON object', 400)
    }

    const { name, contactEmail, contactPhone, googleContactId } = body as Record<string, unknown>

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return errorResponse('name is required', 400)
    }
    const cleanName = name.trim()
    if (cleanName.length > 100) {
      return errorResponse('name must not exceed 100 characters', 400)
    }
    // Same rule the project routes apply to name/description.
    if (HTML_TAG_RE.test(cleanName)) {
      return errorResponse('Client name must not contain HTML or script tags', 400)
    }
    if (contactEmail !== undefined && contactEmail !== null && typeof contactEmail !== 'string') {
      return errorResponse('contactEmail must be a string', 400)
    }
    if (contactPhone !== undefined && contactPhone !== null && typeof contactPhone !== 'string') {
      return errorResponse('contactPhone must be a string', 400)
    }

    try {
      const created = await prisma.client.create({
        data: {
          name: cleanName,
          contactEmail: typeof contactEmail === 'string' && contactEmail.trim() ? contactEmail.trim() : null,
          contactPhone: typeof contactPhone === 'string' && contactPhone.trim() ? contactPhone.trim() : null,
          googleContactId:
            typeof googleContactId === 'string' && googleContactId.trim() ? googleContactId.trim() : null,
        },
        select: { id: true, name: true, contactEmail: true, contactPhone: true },
      })
      return successResponse({ client: { ...created, projectCount: 0 } satisfies ClientSummary }, 201)
    } catch (err) {
      // Unique violation on (organizationId, name) — hand back the existing row.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await prisma.client.findFirst({
          where: { name: cleanName, isActive: true },
          select: { id: true, name: true, contactEmail: true, contactPhone: true },
        })
        if (existing) {
          return successResponse({ client: { ...existing, projectCount: 0 } satisfies ClientSummary }, 200)
        }
        return errorResponse('A client with that name already exists', 409)
      }
      throw err
    }
  } catch (error) {
    console.error('[POST /api/clients]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}
