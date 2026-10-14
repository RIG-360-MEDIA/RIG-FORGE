/**
 * GET /api/auth/google/status
 *
 * Returns whether the caller has Google connected, and if so, which
 * account. Used by the Profile page to show "Connected as X" or the
 * "Connect Google" button.
 */

import { type NextRequest } from 'next/server'

import { prisma } from '@/lib/db'
import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { isGoogleConfigured, getAuthorizedClient, GOOGLE_REAUTH_REQUIRED } from '@/lib/google/oauth'

export async function GET(request: NextRequest) {
  const token = getTokenFromCookies(request)
  if (!token) return errorResponse('Authentication required', 401)
  const claims = verifyToken(token)
  if (!claims) return errorResponse('Invalid or expired session', 401)

  const configured = isGoogleConfigured()

  if (!configured) {
    return successResponse({
      configured: false,
      connected: false,
      email: null,
      connectedAt: null,
    })
  }

  const integ = await prisma.googleIntegration.findUnique({
    where: { userId: claims.userId },
    select: { email: true, connectedAt: true, scopes: true },
  })

  // A stored connection is not necessarily a working one: Google can kill the
  // refresh token (the user revoked access, or the OAuth app is still in
  // "Testing", where every token dies after 7 days). Check it the same way
  // every Google feature does, so this page stops saying "Connected" while
  // Mail, Drive and Forgie say "reconnect". The check only calls Google when
  // the access token is about to expire; other failures (network, Google 5xx)
  // are not treated as disconnected.
  let needsReconnect = false
  if (integ) {
    try {
      await getAuthorizedClient(claims.userId)
    } catch (e) {
      needsReconnect = e instanceof Error && e.message === GOOGLE_REAUTH_REQUIRED
    }
  }

  const scopes = integ?.scopes ?? ''
  return successResponse({
    configured: true,
    connected: integ !== null && !needsReconnect,
    needsReconnect,
    email: integ?.email ?? null,
    connectedAt: integ?.connectedAt ?? null,
    features: {
      calendar: scopes.includes('calendar.events') || scopes.includes('calendar.freebusy'),
      gmail:
        scopes.includes('gmail.send') ||
        scopes.includes('gmail.metadata') ||
        scopes.includes('gmail.readonly'),
      drive:
        scopes.includes('drive.file') ||
        scopes.includes('drive.metadata.readonly') ||
        scopes.includes('drive.readonly'),
      contacts: scopes.includes('contacts.readonly') || scopes.includes('contacts'),
    },
  })
}
