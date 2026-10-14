import { type NextRequest } from 'next/server'

import { prisma } from '@/lib/db'
import { getTokenFromCookies, verifyToken, isAdminRole } from '@/lib/auth'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import type { MessageResponse } from '@/lib/types'

interface RouteContext {
  params: { projectId: string }
}

interface ThreadApiData {
  threadId: string | null
  messages: MessageResponse[]
  nextCursor: string | null
  total: number
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

function mapMessage(msg: {
  id: string
  content: string
  visibility: string
  fileUrl: string | null
  fileName: string | null
  fileType: string | null
  createdAt: Date
  updatedAt: Date
  author: { id: string; name: string; avatarUrl: string | null; role: string }
  projectThreadId: string | null
}): MessageResponse {
  return {
    id: msg.id,
    content: msg.content,
    authorId: msg.author.id,
    authorName: msg.author.name,
    authorAvatar: msg.author.avatarUrl,
    authorRole: msg.author.role,
    threadType: 'project',
    threadId: msg.projectThreadId ?? '',
    createdAt: msg.createdAt,
    updatedAt: msg.updatedAt,
    edited: msg.createdAt.getTime() !== msg.updatedAt.getTime(),
    visibility: msg.visibility as 'TEAM' | 'LEAD_ADMIN',
    fileUrl: msg.fileUrl,
    fileName: msg.fileName,
    fileType: msg.fileType,
  }
}

// ─── GET /api/threads/project/[projectId] ──────────────────────────────────────
// Returns messages the viewer is allowed to see.
// LEAD_ADMIN messages are filtered out for regular members.

export async function GET(
  request: NextRequest,
  { params }: RouteContext,
) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)

    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)

    const projectId = params.projectId

    // Ensure project exists and user can see it (member or admin)
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        isActive: true,
        ...(!isAdminRole(payload.role)
          ? { members: { some: { userId: payload.userId } } }
          : {}),
      },
      select: { id: true, leadId: true },
    })
    if (!project) return errorResponse('Project not found', 404)

    // Determine if this viewer can see ALL LEAD_ADMIN messages
    // (admins and this project's lead only — not every lead)
    const canSeeAllPrivate =
      isAdminRole(payload.role) || project.leadId === payload.userId

    const { searchParams } = request.nextUrl
    const limit = Math.min(
      Math.max(parseInt(searchParams.get('limit') ?? '50', 10), 1),
      100,
    )
    const cursor = searchParams.get('cursor') ?? undefined

    const thread = await prisma.projectThread.findUnique({
      where: { projectId },
      select: { id: true },
    })

    if (!thread) {
      return successResponse<ThreadApiData>({
        threadId: null,
        messages: [],
        nextCursor: null,
        total: 0,
      })
    }

    // Build where clause:
    // - Admin / this project's lead → see everything
    // - Regular members → see TEAM messages + their own LEAD_ADMIN messages
    const where = canSeeAllPrivate
      ? { projectThreadId: thread.id }
      : {
          projectThreadId: thread.id,
          OR: [
            { visibility: 'TEAM' as const },
            { visibility: 'LEAD_ADMIN' as const, authorId: payload.userId },
          ],
        }

    const total = await prisma.threadMessage.count({ where })

    const msgs = await prisma.threadMessage.findMany({
      where,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      take: limit + 1,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        content: true,
        visibility: true,
        fileUrl: true,
        fileName: true,
        fileType: true,
        createdAt: true,
        updatedAt: true,
        projectThreadId: true,
        author: { select: { id: true, name: true, avatarUrl: true, role: true } },
      },
    })

    const hasMore = msgs.length > limit
    const page = hasMore ? msgs.slice(0, limit) : msgs
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null

    return successResponse<ThreadApiData>({
      threadId: thread.id,
      messages: page.map((m) => mapMessage(m)),
      nextCursor,
      total,
    })
  } catch (error) {
    console.error('[GET /api/threads/project/[projectId]]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}

// ─── Notification helper ──────────────────────────────────────────────────────

async function dispatchUpdateNotifications(
  projectId: string,
  projectName: string,
  senderId: string,
  senderName: string,
  content: string,
  visibility: 'TEAM' | 'LEAD_ADMIN',
  leadId: string | null,
): Promise<void> {
  // Short preview — first 80 chars, no newlines
  const preview = content.replace(/\s+/g, ' ').slice(0, 80) + (content.length > 80 ? '…' : '')
  const link    = `/dashboard/projects/${projectId}?tab=updates`

  if (visibility === 'TEAM') {
    // ── Notify every project member except the sender ──────────────────
    const members = await prisma.projectMember.findMany({
      where: { projectId, userId: { not: senderId } },
      select: { userId: true },
    })
    if (members.length === 0) return

    await prisma.notification.createMany({
      data: members.map(({ userId }) => ({
        userId,
        type:   'PROJECT_UPDATE' as const,
        title:  `New update in ${projectName}`,
        body:   `${senderName}: "${preview}"`,
        linkTo: link,
      })),
      skipDuplicates: true,
    })
  } else {
    // ── LEAD_ADMIN: notify this project's lead + all system admins ─────
    // Collect recipient IDs (excluding the sender)
    const recipientIds = new Set<string>()

    // Project lead
    if (leadId && leadId !== senderId) recipientIds.add(leadId)

    // All system admins who are active (excluding sender)
    const admins = await prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, isActive: true, id: { not: senderId } },
      select: { id: true },
    })
    for (const a of admins) recipientIds.add(a.id)

    if (recipientIds.size === 0) return

    await prisma.notification.createMany({
      data: [...recipientIds].map((userId) => ({
        userId,
        type:   'PROJECT_UPDATE' as const,
        title:  `Private message in ${projectName}`,
        body:   `${senderName} sent a private message — tap to view`,
        linkTo: link,
      })),
      skipDuplicates: true,
    })
  }
}

// ─── POST /api/threads/project/[projectId] ─────────────────────────────────────
// Creates a new message. Accepts visibility, fileUrl, fileName, fileType.
// Fires per-recipient notifications after saving.

export async function POST(
  request: NextRequest,
  { params }: RouteContext,
) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)

    const payload = verifyToken(token)
    if (!payload) return errorResponse('Invalid or expired token', 401)

    const projectId = params.projectId

    // Ensure project exists and user can see it (member or admin)
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        isActive: true,
        ...(!isAdminRole(payload.role)
          ? { members: { some: { userId: payload.userId } } }
          : {}),
      },
      select: { id: true, name: true, leadId: true },
    })
    if (!project) return errorResponse('Project not found', 404)

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('Request body must be valid JSON', 400)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return errorResponse('Request body must be a JSON object', 400)
    }

    const {
      content,
      visibility: rawVisibility,
      fileUrl,
      fileName,
      fileType,
    } = body as Record<string, unknown>

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return errorResponse('content is required', 400)
    }
    if ((content as string).length > 4000) {
      return errorResponse('content must not exceed 4000 characters', 400)
    }

    // Validate and default visibility
    const visibility: 'TEAM' | 'LEAD_ADMIN' =
      rawVisibility === 'LEAD_ADMIN' ? 'LEAD_ADMIN' : 'TEAM'

    // Validate optional file fields
    const safeFileUrl  = typeof fileUrl  === 'string' && fileUrl.trim()  ? fileUrl.trim()  : null
    const safeFileName = typeof fileName === 'string' && fileName.trim() ? fileName.trim() : null
    const safeFileType = safeFileUrl ? (typeof fileType === 'string' ? fileType.trim() : 'link') : null

    // Create or find thread
    let thread = await prisma.projectThread.findUnique({
      where: { projectId },
      select: { id: true },
    })
    if (!thread) {
      thread = await prisma.projectThread.create({
        data: { projectId },
        select: { id: true },
      })
    }

    const message = await prisma.threadMessage.create({
      data: {
        content: (content as string).trim(),
        authorId: payload.userId,
        projectThreadId: thread.id,
        visibility,
        fileUrl:  safeFileUrl,
        fileName: safeFileName,
        fileType: safeFileType,
      },
      select: {
        id: true,
        content: true,
        visibility: true,
        fileUrl: true,
        fileName: true,
        fileType: true,
        createdAt: true,
        updatedAt: true,
        projectThreadId: true,
        author: { select: { id: true, name: true, avatarUrl: true, role: true } },
      },
    })

    // Fire notifications in background — don't block the response
    void dispatchUpdateNotifications(
      projectId,
      project.name,
      payload.userId,
      message.author.name,
      message.content,
      visibility,
      project.leadId,
    ).catch((err) => console.error('[notifications] dispatchUpdateNotifications failed', err))

    const mapped = mapMessage(message)
    return successResponse<MessageResponse>(mapped, 201)
  } catch (error) {
    console.error('[POST /api/threads/project/[projectId]]', error)
    return errorResponse('An unexpected error occurred', 500)
  }
}
