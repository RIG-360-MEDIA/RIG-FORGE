import { type NextRequest, NextResponse } from 'next/server'

import { prisma } from '@/lib/db'
import { runWithOrg, withoutOrgScope } from '@/lib/tenant-context'
import { resolveCapabilities, can } from '@/lib/permissions'
import { sendPushToUsers } from '@/lib/push/send'
import { successResponse } from '@/lib/api-helpers'
import type { ApiResponse } from '@/lib/types'

// ─── POST /api/auth/forgot-password ──────────────────────────────────────────
// Public (no session). A user who forgot their password asks for a reset; the
// people in THEIR company who are allowed to reset it get an in-app
// notification (and a web push) linking to the member's profile, where the
// existing RESET PASSWORD action issues a temporary password.
//
// There is no email service, so no reset links are sent.
//
// Every request gets the same 200 response, whether or not the account exists,
// is inactive, is rate limited or nobody can reset it. The actual work runs
// after the response is sent, so response timing does not reveal it either.
//
// Who is notified mirrors app/api/admin/users/[id]/reset-password/route.ts and
// the "Password Management" card in components/people/MemberSlideOver.tsx, so
// every recipient can actually act on the notification:
//   - target SUPER_ADMIN -> nobody (the reset route refuses SUPER_ADMIN targets)
//   - target ADMIN       -> SUPER_ADMINs only (an ADMIN cannot reset an ADMIN,
//                           and the card is hidden from non-super-admins)
//   - target EMPLOYEE    -> anyone whose resolved capabilities include both
//                           members.reset_password (the reset route) and
//                           members.view (needed to open the member slide-over)
// Recipients are active, approved (not onboarding), internal (not an external
// client role) users of the target's own company, never the requester.

const RESPONSE_MESSAGE =
  "If that email belongs to an account, your company's administrators have been notified. They will reset your password and give you a temporary one."

const NOTIFICATION_TITLE = 'Password reset requested'
const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000
const MAX_EMAIL_LENGTH = 254
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ─── In-memory rate limits ───────────────────────────────────────────────────
// Per process. Good enough to stop a single client hammering the endpoint; the
// DB de-dupe below stops repeated notifications across restarts / instances.

interface Bucket { count: number; resetAt: number }

const IP_LIMIT = 5
const IP_WINDOW_MS = 15 * 60 * 1000
const EMAIL_LIMIT = 3
const EMAIL_WINDOW_MS = 60 * 60 * 1000
const MAX_BUCKETS = 10_000

const ipBuckets = new Map<string, Bucket>()
const emailBuckets = new Map<string, Bucket>()
let lastPruneAt = 0

function prune(now: number): void {
  if (now - lastPruneAt < 60_000 && ipBuckets.size + emailBuckets.size < MAX_BUCKETS) return
  lastPruneAt = now
  for (const map of [ipBuckets, emailBuckets]) {
    map.forEach((b, k) => { if (b.resetAt <= now) map.delete(k) })
    // Hard cap so a flood of distinct keys cannot grow memory without bound.
    if (map.size > MAX_BUCKETS) map.clear()
  }
}

/** Counts this hit; returns false when the key is over its limit. */
function hit(map: Map<string, Bucket>, key: string, limit: number, windowMs: number, now: number): boolean {
  const b = map.get(key)
  if (!b || b.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  b.count += 1
  return b.count <= limit
}

function clientIp(request: NextRequest): string {
  const fwd = request.headers.get('x-forwarded-for')
  if (fwd) {
    const first = fwd.split(',')[0]?.trim()
    if (first) return first
  }
  return request.headers.get('x-real-ip')?.trim() || request.ip || 'unknown'
}

/** Redacted form for server logs: first character + domain. */
function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  return `${email[0]}***${email.slice(at)}`
}

function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return null
  if (!EMAIL_RE.test(email)) return null
  return email
}

// ─── Core work (runs after the response) ─────────────────────────────────────

async function processRequest(email: string): Promise<void> {
  // The request is unauthenticated, so there is no company context yet. Email
  // is unique across every company, so look it up globally (read-only, and
  // nothing from it is returned to the caller).
  const target = await withoutOrgScope(() =>
    prisma.user.findUnique({
      where: { email },
      select: { id: true, organizationId: true },
    }),
  )
  if (!target) {
    console.info(`[forgot-password] no account for ${maskEmail(email)}`)
    return
  }

  // Everything else runs inside the target's own company. Every query is
  // awaited inside the callback: Prisma queries are lazy and would otherwise
  // execute after this context has ended.
  await runWithOrg(target.organizationId, async () => {
    const orgId = target.organizationId

    const user = await prisma.user.findFirst({
      where: { id: target.id, organizationId: orgId },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    })
    if (!user) return
    if (!user.isActive) {
      console.info(`[forgot-password] ignored: account ${user.id} is deactivated`)
      return
    }
    if (user.role === 'SUPER_ADMIN') {
      console.warn(
        `[forgot-password] reset requested for SUPER_ADMIN ${user.id} (org ${orgId}); nobody can reset this account via the admin UI, no notification sent`,
      )
      return
    }

    const candidates = await prisma.user.findMany({
      where: {
        organizationId: orgId,
        id: { not: user.id },
        isActive: true,
        isOnboarding: false,
        ...(user.role === 'ADMIN' ? { role: 'SUPER_ADMIN' as const } : {}),
      },
      select: {
        id: true,
        role: true,
        customRole: { select: { permissions: true, isExternal: true } },
      },
    })

    const recipientIds = candidates
      .filter((c) => {
        if (c.customRole?.isExternal) return false
        const caps = resolveCapabilities(c.role, c.customRole)
        if (!can(caps, 'members.reset_password') || !can(caps, 'members.view')) return false
        // Mirrors the reset route: an ADMIN cannot reset another ADMIN.
        if (user.role === 'ADMIN' && c.role !== 'SUPER_ADMIN') return false
        return true
      })
      .map((c) => c.id)

    if (recipientIds.length === 0) {
      console.warn(
        `[forgot-password] reset requested for ${user.role} ${user.id} (org ${orgId}) but nobody in that company can reset it`,
      )
      return
    }

    const linkTo = `/dashboard/people?member=${encodeURIComponent(user.id)}`

    // De-dupe: skip recipients who already have an unread copy of this request
    // from the last 6 hours.
    const existing = await prisma.notification.findMany({
      where: {
        organizationId: orgId,
        userId: { in: recipientIds },
        title: NOTIFICATION_TITLE,
        linkTo,
        read: false,
        createdAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
      },
      select: { userId: true },
    })
    const alreadyNotified = new Set(existing.map((n) => n.userId))
    const toNotify = recipientIds.filter((id) => !alreadyNotified.has(id))

    if (toNotify.length === 0) {
      console.info(`[forgot-password] duplicate request for ${user.id} within 6h; recipients already notified`)
      return
    }

    const body = `${user.name} (${user.email}) asked for a password reset from the login page.`

    await prisma.notification.createMany({
      data: toNotify.map((userId) => ({
        organizationId: orgId,
        userId,
        type: 'ADMIN_MESSAGE' as const,
        title: NOTIFICATION_TITLE,
        body,
        linkTo,
      })),
    })

    console.info(`[forgot-password] notified ${toNotify.length} recipient(s) in org ${orgId} for user ${user.id}`)

    // Push is best-effort. Started inside this org context so its subscription
    // lookup is scoped to the right company; failures are logged, never thrown.
    void sendPushToUsers(toNotify, {
      title: NOTIFICATION_TITLE,
      body,
      url: linkTo,
      tag: `forgot-password-${user.id}`,
    }).catch((err: unknown) => {
      console.warn('[forgot-password] push failed (non-fatal)', (err as Error)?.message ?? err)
    })
  })
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<{ message: string }>>> {
  const response = successResponse({ message: RESPONSE_MESSAGE })

  try {
    let raw: unknown
    try { raw = await request.json() } catch { return response }
    const email = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? normaliseEmail((raw as Record<string, unknown>).email)
      : null
    if (!email) return response

    const now = Date.now()
    prune(now)
    const ip = clientIp(request)
    const ipOk = hit(ipBuckets, ip, IP_LIMIT, IP_WINDOW_MS, now)
    const emailOk = hit(emailBuckets, email, EMAIL_LIMIT, EMAIL_WINDOW_MS, now)
    if (!ipOk || !emailOk) {
      console.warn(`[forgot-password] rate limited (${!ipOk ? 'ip' : 'email'}) ip=${ip} email=${maskEmail(email)}`)
      return response
    }

    // Not awaited: the response must not depend on whether the account exists.
    void processRequest(email).catch((err: unknown) => {
      console.error('[forgot-password] processing failed', err)
    })
  } catch (error) {
    console.error('[POST /api/auth/forgot-password]', error)
  }

  return response
}
