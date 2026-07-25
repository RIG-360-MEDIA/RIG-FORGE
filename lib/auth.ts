import { type NextRequest } from 'next/server'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

import { setOrgContext } from '@/lib/tenant-context'

export const COOKIE_NAME = 'forge-token'

const BCRYPT_ROUNDS = 12

export interface TokenPayload {
  userId: string
  email: string
  role: string
  isOnboarding: boolean
  mustChangePassword: boolean
  organizationId: string
  /** Present only when the user has an assigned custom role (see lib/permissions.ts tokenCan). */
  capabilities?: string[]
  /** True when the user's custom role is an external/client role (portal-restricted). */
  isExternal?: boolean
}

// Re-exported from the client-safe module so server code can keep importing it
// from '@/lib/auth' while client components import from '@/lib/roles' (avoiding
// pulling node:async_hooks / jsonwebtoken into the browser bundle).
export { isAdminRole } from '@/lib/roles'

/**
 * Allowlist gate for the hidden developer dashboard (/dashboard/dev).
 * Access is NOT tied to role — only emails listed in the DEV_DASHBOARD_EMAILS
 * env var (comma-separated, case-insensitive) can see it. This keeps the
 * dashboard invisible to admins and the owner unless explicitly added.
 */
export function isDeveloperEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const allow = (process.env.DEV_DASHBOARD_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  return allow.includes(email.toLowerCase())
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not configured')
  }
  return secret
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

export async function comparePassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export function signToken(payload: TokenPayload): string | null {
  try {
    return jwt.sign(payload, getJwtSecret(), { expiresIn: '7d' })
  } catch {
    return null
  }
}

/**
 * Mint a short-lived, narrowly-scoped token for the realtime/socket channel.
 * This is what gets handed to client-side JS (via /api/auth/token) — NOT the
 * 7-day session cookie. So an XSS that reads it gets a ~2-minute, socket-only
 * credential that can't be replayed as a session (different shape + scope).
 */
export function signSocketToken(userId: string): string | null {
  try {
    return jwt.sign({ sub: userId, scope: 'socket' }, getJwtSecret(), { expiresIn: '2m' })
  } catch {
    return null
  }
}

/** Verify a socket-scoped token. Returns the userId, or null if invalid. */
export function verifySocketToken(token: string): { userId: string } | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret())
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      (decoded as { scope?: string }).scope === 'socket' &&
      'sub' in decoded
    ) {
      return { userId: String((decoded as { sub: unknown }).sub) }
    }
    return null
  } catch {
    return null
  }
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret())
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      'userId' in decoded &&
      'email' in decoded &&
      'role' in decoded
    ) {
      const p = decoded as TokenPayload
      // Backward-compat: tokens minted before multi-tenancy lack organizationId.
      const organizationId = p.organizationId ?? 'rig360'
      // Bind this request's org so the Prisma org-scope extension can filter
      // every query for the rest of the async execution.
      setOrgContext(organizationId)
      return { ...p, organizationId }
    }
    return null
  } catch {
    return null
  }
}

export function getTokenFromCookies(request: NextRequest): string | null {
  return request.cookies.get(COOKIE_NAME)?.value ?? null
}
