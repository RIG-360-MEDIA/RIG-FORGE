/**
 * FORGE Route Protection Middleware
 *
 * Runs in the Edge runtime — cannot use Node.js modules (e.g. jsonwebtoken).
 * JWT signature is verified using the Web Crypto API (HMAC-SHA256).
 *
 * Rules:
 *  - /dashboard/* requires a valid JWT + isOnboarding === false
 *  - /pending    requires a valid JWT + isOnboarding === true
 *  - Everything else is public
 */

import { type NextRequest, NextResponse } from 'next/server'

const COOKIE_NAME = 'forge-token'

// ─── JWT Payload shape (Edge-local, no lib/types import) ─────────────────────

interface EdgeJWTClaims {
  userId: string
  email: string
  role: string
  isOnboarding: boolean
  mustChangePassword: boolean
  isExternal?: boolean
  iat?: number
  exp?: number
}

// ─── Base64url decode (Web API — available in Edge) ───────────────────────────

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    '='
  )
  return atob(padded)
}

// ─── HMAC-SHA256 JWT verification using Web Crypto ───────────────────────────

async function verifyJWT(token: string): Promise<EdgeJWTClaims | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  try {
    const claims = JSON.parse(base64UrlDecode(parts[1])) as EdgeJWTClaims

    if (
      claims.exp !== undefined &&
      Math.floor(Date.now() / 1000) > claims.exp
    ) {
      return null
    }

    const secret = process.env.JWT_SECRET
    if (!secret) return null

    const encoder = new TextEncoder()
    const signingInput = `${parts[0]}.${parts[1]}`

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )

    const rawSignature = base64UrlDecode(parts[2])
    const signatureBytes = new Uint8Array(rawSignature.length)
    for (let i = 0; i < rawSignature.length; i++) {
      signatureBytes[i] = rawSignature.charCodeAt(i)
    }

    const isValid = await crypto.subtle.verify(
      'HMAC',
      cryptoKey,
      signatureBytes,
      encoder.encode(signingInput)
    )

    return isValid ? claims : null
  } catch {
    return null
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl
  const token = request.cookies.get(COOKIE_NAME)?.value ?? null

  const isPending = pathname === '/pending'
  const isDashboard = pathname.startsWith('/dashboard')

  // ── No token → protected routes send to login ─────────────────────────────
  if (!token) {
    if (isDashboard || isPending) {
      return NextResponse.redirect(new URL('/login', request.url))
    }
    return NextResponse.next()
  }

  const claims = await verifyJWT(token)

  // ── Invalid / expired token ────────────────────────────────────────────────
  if (!claims) {
    if (isDashboard || isPending) {
      const response = NextResponse.redirect(new URL('/login', request.url))
      response.cookies.delete(COOKIE_NAME)
      return response
    }
    return NextResponse.next()
  }

  // ── Pending (onboarding) user trying to access dashboard ───────────────────
  if (claims.isOnboarding && isDashboard) {
    return NextResponse.redirect(new URL('/pending', request.url))
  }

  // ── Approved user on /pending → send to dashboard ──────────────────────────
  if (!claims.isOnboarding && isPending) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  // ── Must-change-password guard ─────────────────────────────────────────────
  // Force the user to /dashboard/change-password until they set a new password.
  const isChangePasswordPage = pathname === '/dashboard/change-password'
  if (claims.mustChangePassword && isDashboard && !isChangePasswordPage) {
    return NextResponse.redirect(new URL('/dashboard/change-password', request.url))
  }

  // ── External / client users are locked to their projects ───────────────────
  // They may only reach the projects area (+ their own profile / password).
  // Any other dashboard page redirects to /dashboard/projects.
  if (claims.isExternal && isDashboard) {
    const allowed =
      pathname === '/dashboard/projects' ||
      pathname.startsWith('/dashboard/projects/') ||
      pathname === '/dashboard/profile' ||
      isChangePasswordPage
    if (!allowed) {
      return NextResponse.redirect(new URL('/dashboard/projects', request.url))
    }
  }

  return NextResponse.next()
}

// ─── Matcher ─────────────────────────────────────────────────────────────────
// Only protect dashboard and pending. Landing (/) and login (/login) are always public.

export const config = {
  matcher: ['/dashboard/:path*', '/pending'],
}
