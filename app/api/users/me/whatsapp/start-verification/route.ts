/**
 * POST /api/users/me/whatsapp/start-verification
 *
 * Body: { number: string }
 *
 * Sends a 6-digit OTP to the given WhatsApp number via the bridge and stores a
 * bcrypt hash of it (10-min expiry) against the caller. The number is held as
 * `waPendingNumber` and is NOT promoted to the resolvable `whatsappNumber`
 * until the code is confirmed at /verify — so an unverified number never
 * receives Forgie and nobody can claim someone else's number.
 *
 * Calling again with the same/different number resends (rate-limited to once
 * per 60s).
 */

import { type NextRequest } from 'next/server'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'

import { prisma } from '@/lib/db'
import { withoutOrgScope } from '@/lib/tenant-context'
import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { normalizeWhatsappNumber, maskWhatsappNumber } from '@/lib/whatsapp/number'
import { isWhatsAppEnabled, sendWhatsappMessage } from '@/lib/whatsapp/bridge'
import { getOrgBranding } from '@/lib/org-branding'

const CODE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000 // 60 seconds

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    const claims = verifyToken(token)
    if (!claims) return errorResponse('Invalid or expired session', 401)

    if (!isWhatsAppEnabled()) {
      return errorResponse('WhatsApp is not available right now. Try again later.', 503)
    }

    const body = (await request.json().catch(() => ({}))) as { number?: unknown }
    if (typeof body.number !== 'string' || body.number.trim() === '') {
      return errorResponse('WhatsApp number is required', 400)
    }

    let normalized: string | null
    try {
      normalized = normalizeWhatsappNumber(body.number)
    } catch (err) {
      return errorResponse(err instanceof Error ? err.message : 'Invalid WhatsApp number', 400)
    }
    if (!normalized) return errorResponse('WhatsApp number is required', 400)

    // The number must map to exactly one user. Block if another account already
    // owns it (verified or not — we compare against the resolvable column).
    // WhatsApp numbers are unique across EVERY company (inbound messages must
    // resolve to exactly one user), so this check must be global — a company-
    // filtered one let a number already used elsewhere through, and the save
    // then failed on the unique index. Only a yes/no comes back.
    const clash = await withoutOrgScope(() => prisma.user.findFirst({
      where: { whatsappNumber: normalized, id: { not: claims.userId } },
      select: { id: true },
    }))
    if (clash) {
      return errorResponse('That WhatsApp number is already linked to another account.', 409)
    }

    // Resend cooldown
    const me = await prisma.user.findUnique({
      where: { id: claims.userId },
      select: { waVerifyLastSentAt: true },
    })
    if (me?.waVerifyLastSentAt) {
      const elapsed = Date.now() - me.waVerifyLastSentAt.getTime()
      if (elapsed < RESEND_COOLDOWN_MS) {
        const wait = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000)
        return errorResponse(`Please wait ${wait}s before requesting another code.`, 429)
      }
    }

    // Generate + deliver the code BEFORE persisting, so we never store a code
    // we couldn't actually send.
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
    const { orgName } = await getOrgBranding(claims.organizationId)
    const message =
      `Your ${orgName} verification code is ${code}. It expires in 10 minutes. ` +
      `If you didn't request this, you can ignore this message.`

    try {
      await sendWhatsappMessage({ to: normalized, message })
    } catch (err) {
      console.error('[wa start-verification] send failed:', err)
      return errorResponse(
        'Could not send the code to that number. Check it and try again.',
        502,
      )
    }

    const codeHash = await bcrypt.hash(code, 10)
    const now = new Date()
    await prisma.user.update({
      where: { id: claims.userId },
      data: {
        waPendingNumber: normalized,
        waVerifyCodeHash: codeHash,
        waVerifyExpiresAt: new Date(now.getTime() + CODE_TTL_MS),
        waVerifyAttempts: 0,
        waVerifyLastSentAt: now,
      },
    })

    return successResponse({
      sent: true,
      maskedNumber: maskWhatsappNumber(normalized),
      expiresInSeconds: Math.floor(CODE_TTL_MS / 1000),
    })
  } catch (error) {
    console.error('[POST /api/users/me/whatsapp/start-verification]', error)
    return errorResponse('Server error', 500)
  }
}
