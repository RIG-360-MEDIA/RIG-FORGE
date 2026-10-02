/**
 * GET /api/auth/google/callback?code=...&state=...
 *
 * Google redirects the user here after they consent. We verify the state
 * token, exchange the code for tokens, persist them, then redirect back
 * to the profile page with a success/error indicator.
 */

import { type NextRequest, NextResponse } from 'next/server'
import jwt from 'jsonwebtoken'

import { prisma } from '@/lib/db'
import { exchangeCodeForTokens } from '@/lib/google/oauth'
import { encryptSecret } from '@/lib/secret-box'

interface StateClaims {
  userId: string
  purpose: string
}

function redirectWith(url: string, params: Record<string, string>): NextResponse {
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return NextResponse.redirect(u.toString())
}

// The public origin of the app. On Render (and other proxies) `request.url` is
// the INTERNAL bind (e.g. http://localhost:10000), so a redirect built from it
// sends the browser to a dead localhost. Prefer explicit config: the origin of
// GOOGLE_REDIRECT_URI (always set for OAuth to work) or NEXT_PUBLIC_APP_URL.
function appOrigin(request: NextRequest): string {
  for (const v of [process.env.GOOGLE_REDIRECT_URI, process.env.NEXT_PUBLIC_APP_URL]) {
    if (v) {
      try { return new URL(v).origin } catch { /* ignore malformed */ }
    }
  }
  return new URL(request.url).origin
}

export async function GET(request: NextRequest) {
  const profileUrl = new URL('/dashboard/profile', appOrigin(request)).toString()

  const { searchParams } = request.nextUrl
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  // User clicked "Cancel" on Google's consent screen
  if (error) {
    return redirectWith(profileUrl, { google: 'cancelled' })
  }

  if (!code || !state) {
    return redirectWith(profileUrl, { google: 'error', reason: 'missing-params' })
  }

  // Verify the state token
  const secret = process.env.JWT_SECRET
  if (!secret) {
    return redirectWith(profileUrl, { google: 'error', reason: 'server' })
  }
  let claims: StateClaims
  try {
    const decoded = jwt.verify(state, secret) as Record<string, unknown>
    if (
      typeof decoded.userId !== 'string' ||
      decoded.purpose !== 'google-oauth'
    ) {
      throw new Error('bad state payload')
    }
    claims = { userId: decoded.userId, purpose: 'google-oauth' }
  } catch {
    return redirectWith(profileUrl, { google: 'error', reason: 'state' })
  }

  // Exchange the code for tokens
  let tokens
  try {
    tokens = await exchangeCodeForTokens(code)
  } catch (err) {
    console.error('[google-callback] token exchange failed:', err)
    const reason = err instanceof Error ? err.message.slice(0, 100) : 'unknown'
    return redirectWith(profileUrl, { google: 'error', reason })
  }

  // Persist (upsert — user might be re-connecting with a new account)
  //
  // This route authenticates from the OAuth `state` JWT, not the session
  // cookie, so `verifyToken` never runs and no org context is set for the
  // request. Without the explicit organizationId below, the org-scope
  // extension in lib/db.ts falls back to the @default("rig360") column
  // default and files every tenant's Google connection under rig360 —
  // which is exactly what happened to all four Trijya users.
  try {
    const owner = await prisma.user.findUnique({
      where: { id: claims.userId },
      select: { organizationId: true },
    })
    if (!owner) {
      return redirectWith(profileUrl, { google: 'error', reason: 'unknown-user' })
    }

    await prisma.googleIntegration.upsert({
      where: { userId: claims.userId },
      create: {
        userId: claims.userId,
        organizationId: owner.organizationId,
        email: tokens.email,
        accessToken: encryptSecret(tokens.accessToken) ?? tokens.accessToken,
        refreshToken: encryptSecret(tokens.refreshToken) ?? tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scope,
      },
      update: {
        // Also set on update so reconnecting repairs a row that was already
        // written with the wrong org before this fix.
        organizationId: owner.organizationId,
        email: tokens.email,
        accessToken: encryptSecret(tokens.accessToken) ?? tokens.accessToken,
        refreshToken: encryptSecret(tokens.refreshToken) ?? tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scope,
        connectedAt: new Date(),
      },
    })
  } catch (err) {
    console.error('[google-callback] persistence failed:', err)
    return redirectWith(profileUrl, { google: 'error', reason: 'persistence' })
  }

  return redirectWith(profileUrl, { google: 'connected' })
}
