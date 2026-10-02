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

// ─── External / client API allowlist ──────────────────────────────────────────

/**
 * The only /api paths an EXTERNAL (client/supplier) user may reach. Everything
 * else is refused, so adding a route does not silently expose it to clients.
 *
 * A trailing slash means "this subtree only" — `/api/users/me/` lets a client
 * read and edit their OWN profile without opening `/api/users`, which returns
 * the whole staff directory including email addresses.
 *
 * `/api/tasks` is safe to expose: it requires a projectId for EMPLOYEE-base
 * callers (which every external user is) and checks project membership before
 * returning anything.
 */
const EXTERNAL_API_ALLOWLIST = [
  '/api/auth/',          // session, logout, own Google connection status
  '/api/branding',       // white-label org name/colours, needed to render
  '/api/health',
  '/api/heartbeat',
  '/api/projects',       // their portal — list/detail already membership-scoped
  '/api/tasks',          // project-scoped; membership enforced in the route
  '/api/notifications',  // their own notifications only
  '/api/users/me/',      // own profile, password, setup status
  '/api/push/subscribe',
]

/**
 * Prefix match with a segment boundary, so `/api/projects` cannot be satisfied
 * by something like `/api/projects-admin`. Entries ending in `/` match the
 * whole subtree; the rest match the path exactly or as a parent segment.
 */
function isPathAllowed(pathname: string, allowlist: string[]): boolean {
  return allowlist.some((entry) =>
    entry.endsWith('/')
      ? pathname.startsWith(entry)
      : pathname === entry || pathname.startsWith(`${entry}/`),
  )
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl
  const token = request.cookies.get(COOKIE_NAME)?.value ?? null

  const isPending = pathname === '/pending'
  const isDashboard = pathname.startsWith('/dashboard')
  const isApi = pathname.startsWith('/api')

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

  // ── External / client users: API allowlist ─────────────────────────────────
  // Hiding nav and redirecting pages is not access control — the APIs behind
  // them were still answering. A client could read the staff directory, every
  // internal issue, chat, reports and tickets by calling /api directly. Only
  // /api/projects scoped itself. This fails CLOSED: anything not listed is
  // refused, so a new route is private until someone opts it in here.
  if (claims.isExternal && isApi && !isPathAllowed(pathname, EXTERNAL_API_ALLOWLIST)) {
    return NextResponse.json(
      { data: null, error: 'Not available for this account' },
      { status: 403 },
    )
  }

  return NextResponse.next()
}

// ─── Matcher ─────────────────────────────────────────────────────────────────
// Dashboard and pending are protected as before. /api is included so the
// external-user allowlist above can run — without it middleware never sees an
// API request and every route stays open to clients. Requests with no valid
// token fall straight through to the route's own auth, so this changes nothing
// for cron jobs, webhooks and the login flow. Landing (/) and /login stay public.

export const config = {
  matcher: ['/dashboard/:path*', '/pending', '/api/:path*'],
}
