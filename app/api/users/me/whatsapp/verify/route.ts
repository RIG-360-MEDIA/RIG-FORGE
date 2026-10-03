/**
 * POST /api/users/me/whatsapp/verify
 *
 * Body: { code: string }
 *
 * Confirms the OTP sent by /start-verification. On success the pending number
 * is promoted to the resolvable `whatsappNumber` and `whatsappVerified` is set.
 * Caps wrong attempts and honours code expiry.
 */

import { type NextRequest } from 'next/server'
import bcrypt from 'bcryptjs'

import { prisma } from '@/lib/db'
import { withoutOrgScope } from '@/lib/tenant-context'
import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { successResponse, errorResponse } from '@/lib/api-helpers'

const MAX_ATTEMPTS = 5

export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    const claims = verifyToken(token)
    if (!claims) return errorResponse('Invalid or expired session', 401)

    const body = (await request.json().catch(() => ({}))) as { code?: unknown }
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    if (!/^\d{6}$/.test(code)) {
      return errorResponse('Enter the 6-digit code.', 400)
    }

    const me = await prisma.user.findUnique({
      where: { id: claims.userId },
      select: {
        waPendingNumber: true,
        waVerifyCodeHash: true,
        waVerifyExpiresAt: true,
        waVerifyAttempts: true,
      },
    })

    if (!me?.waPendingNumber || !me.waVerifyCodeHash || !me.waVerifyExpiresAt) {
      return errorResponse('No verification in progress. Request a new code.', 400)
    }

    if (Date.now() > me.waVerifyExpiresAt.getTime()) {
      await prisma.user.update({
        where: { id: claims.userId },
        data: { waVerifyCodeHash: null, waVerifyExpiresAt: null },
      })
      return errorResponse('That code has expired. Request a new one.', 400)
    }

    if (me.waVerifyAttempts >= MAX_ATTEMPTS) {
      return errorResponse('Too many incorrect attempts. Request a new code.', 429)
    }

    const ok = await bcrypt.compare(code, me.waVerifyCodeHash)
    if (!ok) {
      const attempts = me.waVerifyAttempts + 1
      await prisma.user.update({
        where: { id: claims.userId },
        data: { waVerifyAttempts: attempts },
      })
      const left = MAX_ATTEMPTS - attempts
      return errorResponse(
        left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many incorrect attempts. Request a new code.',
        400,
      )
    }

    // Final uniqueness guard in case someone verified the same number meanwhile.
    // WhatsApp numbers are unique across EVERY company (inbound messages must
    // resolve to exactly one user), so this check must be global — a company-
    // filtered one let a number already used elsewhere through, and the save
    // then failed on the unique index. Only a yes/no comes back.
    const clash = await withoutOrgScope(() => prisma.user.findFirst({
      where: { whatsappNumber: me.waPendingNumber, id: { not: claims.userId } },
      select: { id: true },
    }))
    if (clash) {
      return errorResponse('That WhatsApp number is already linked to another account.', 409)
    }

    try {
      await prisma.user.update({
        where: { id: claims.userId },
        data: {
          whatsappNumber: me.waPendingNumber,
          whatsappVerified: true,
          waPendingNumber: null,
          waVerifyCodeHash: null,
          waVerifyExpiresAt: null,
          waVerifyAttempts: 0,
          waVerifyLastSentAt: null,
        },
      })
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        return errorResponse('That WhatsApp number is already linked to another account.', 409)
      }
      throw err
    }

    return successResponse({ verified: true, whatsappNumber: me.waPendingNumber })
  } catch (error) {
    console.error('[POST /api/users/me/whatsapp/verify]', error)
    return errorResponse('Server error', 500)
  }
}
