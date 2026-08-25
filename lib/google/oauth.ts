/**
 * Google OAuth helper.
 *
 * Centralizes:
 *   - The OAuth2 client builder (client ID + secret + redirect URI)
 *   - Connect URL generation (PKCE-style state parameter to prevent CSRF)
 *   - Token exchange after callback
 *   - Auto-refresh of access tokens that are about to expire
 *
 * The scopes we request match what Forgie's calendar tools need:
 *   - calendar.events    read + write events on the user's primary calendar
 *   - calendar.freebusy  used by find_free_time
 *   - openid email       so we can record which Google account they connected
 */

import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { randomBytes } from 'crypto'

import { prisma } from '@/lib/db'
import { encryptSecret, decryptSecret } from '@/lib/secret-box'

// Refresh access tokens this many ms before they expire.
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000  // 5 minutes

// Thrown when a stored Google token can no longer be refreshed (revoked /
// belongs to a different OAuth client). Callers should surface a "reconnect
// Google" prompt rather than a 500.
export const GOOGLE_REAUTH_REQUIRED = 'GOOGLE_REAUTH_REQUIRED'
export function isGoogleReauthError(e: unknown): boolean {
  return e instanceof Error && e.message === GOOGLE_REAUTH_REQUIRED
}

// NOTE: We deliberately avoid Google's RESTRICTED scopes (gmail.readonly,
// drive.readonly) — those trigger an annual paid CASA security assessment on
// publish. Every scope below is at most SENSITIVE, so publishing to Production
// needs only Google's (free) standard OAuth verification, no CASA.
//   - gmail.metadata  → headers + snippets (NOT full bodies)
//   - drive.metadata.readonly → list/search file metadata (NOT file contents)
// The tradeoff (no full email-body read, no Drive file-content read) is handled
// gracefully in lib/assistant/tools/gmail.ts + gdrive.ts.
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  // Calendar (P7)
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
  // Gmail (P8) — send + metadata-only read (sensitive, not restricted)
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.metadata',
  // Drive (P8) — drive.file = only files the app creates; drive.metadata.readonly
  // = list/search metadata of all files (sensitive, not restricted — no content read)
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  // Contacts (People API) — read-only. Sensitive scope (not restricted → no CASA).
  'https://www.googleapis.com/auth/contacts.readonly',
  // "Other contacts" = auto-collected from mail. Most accounts keep everyone
  // here (zero SAVED contacts), so without this Contacts shows empty. Sensitive.
  'https://www.googleapis.com/auth/contacts.other.readonly',
] as const

// Per-feature scope checks so we can gate tools per user when their stored
// integration was authorized BEFORE these scopes existed (legacy connections).
export function scopesIncludeGmail(scopes: string): boolean {
  // gmail.readonly kept for legacy connections authorized before the downgrade.
  return (
    scopes.includes('gmail.send') ||
    scopes.includes('gmail.metadata') ||
    scopes.includes('gmail.readonly')
  )
}
export function scopesIncludeDrive(scopes: string): boolean {
  // drive.readonly kept for legacy connections authorized before the downgrade.
  return (
    scopes.includes('drive.file') ||
    scopes.includes('drive.metadata.readonly') ||
    scopes.includes('drive.readonly')
  )
}
export function scopesIncludeCalendar(scopes: string): boolean {
  return scopes.includes('calendar.events') || scopes.includes('calendar.freebusy')
}
export function scopesIncludeContacts(scopes: string): boolean {
  return scopes.includes('contacts.readonly') || scopes.includes('contacts')
}

export function isGoogleConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REDIRECT_URI,
  )
}

export function buildOAuth2Client(): OAuth2Client {
  if (!isGoogleConfigured()) {
    throw new Error(
      'Google OAuth not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in env.',
    )
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  )
}

/**
 * Generate the consent-screen URL the user is redirected to. The state
 * token is a random nonce that the callback must echo back to prevent
 * CSRF attacks where someone tricks a logged-in user into connecting an
 * attacker's Google account.
 */
export function buildConnectUrl(stateToken: string): string {
  const client = buildOAuth2Client()
  return client.generateAuthUrl({
    access_type: 'offline',       // request a refresh token, not just access
    prompt: 'consent',            // force the consent screen so refresh_token is always returned
    scope: [...GOOGLE_SCOPES],
    state: stateToken,
  })
}

export function makeStateToken(): string {
  return randomBytes(24).toString('hex')
}

/**
 * Exchange the OAuth code from the callback for tokens, plus pull the
 * user's Google email so we can show "Connected as X" in the UI.
 */
export async function exchangeCodeForTokens(code: string): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt: Date
  scope: string
  email: string
}> {
  const client = buildOAuth2Client()
  const { tokens } = await client.getToken(code)
  if (!tokens.access_token) throw new Error('Google did not return an access token')
  if (!tokens.refresh_token) {
    throw new Error(
      'No refresh token returned. User probably already authorized — revoke at https://myaccount.google.com/permissions and try again.',
    )
  }

  client.setCredentials(tokens)
  const oauth2 = google.oauth2({ version: 'v2', auth: client })
  const me = await oauth2.userinfo.get()
  const email = me.data.email
  if (!email) throw new Error('Could not read connected Google email')

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600 * 1000),
    scope: tokens.scope ?? GOOGLE_SCOPES.join(' '),
    email,
  }
}

/**
 * Return an OAuth2Client authorized as the given user. If the access
 * token is close to expiring, refresh it first and persist the new one.
 *
 * Throws if the user hasn't connected Google, or if their refresh token
 * has been revoked.
 */
export async function getAuthorizedClient(userId: string): Promise<OAuth2Client> {
  const integ = await prisma.googleIntegration.findUnique({ where: { userId } })
  if (!integ) {
    throw new Error('User has not connected Google. They need to go to Profile → Connect Google.')
  }

  const client = buildOAuth2Client()
  client.setCredentials({
    access_token: decryptSecret(integ.accessToken),
    refresh_token: decryptSecret(integ.refreshToken),
    expiry_date: integ.expiresAt.getTime(),
  })

  // If close to expiry, force a refresh and persist
  const msUntilExpiry = integ.expiresAt.getTime() - Date.now()
  if (msUntilExpiry < REFRESH_THRESHOLD_MS) {
    let credentials
    try {
      ;({ credentials } = await client.refreshAccessToken())
    } catch (err) {
      // Refresh token revoked / invalid (e.g. user removed access, or token
      // belongs to a different OAuth client) → surface a clean "reconnect"
      // signal instead of a raw 500.
      const msg = err instanceof Error ? err.message : String(err)
      if (/invalid_grant|invalid_token|unauthorized|invalid_client/i.test(msg)) {
        // These mean very different things and have been indistinguishable in
        // the logs, which made the recurring "Google keeps disconnecting"
        // reports hard to pin down:
        //   invalid_grant  → this user's refresh token is dead. Common causes:
        //                    they revoked access, or the OAuth consent screen
        //                    is still in "Testing", where Google expires every
        //                    refresh token after 7 days.
        //   invalid_client → OUR credentials are wrong. Affects everyone, and
        //                    no amount of reconnecting will help.
        const kind = /invalid_client/i.test(msg)
          ? 'invalid_client (server OAuth credentials are wrong — affects ALL users)'
          : /invalid_grant/i.test(msg)
            ? 'invalid_grant (this user must reconnect; if this recurs weekly, check the OAuth app is Published, not in Testing)'
            : 'unauthorized'
        console.warn(`[google] refresh failed for user ${userId}: ${kind}`)
        throw new Error(GOOGLE_REAUTH_REQUIRED)
      }
      console.error(`[google] refresh failed for user ${userId} with an unexpected error:`, err)
      throw err
    }
    if (credentials.access_token) {
      const newExpiry = new Date(credentials.expiry_date ?? Date.now() + 3600 * 1000)
      await prisma.googleIntegration.update({
        where: { userId },
        data: {
          accessToken: encryptSecret(credentials.access_token) ?? credentials.access_token,
          expiresAt: newExpiry,
          // refresh_token only returned if rotated; preserve old one otherwise
          ...(credentials.refresh_token && {
            refreshToken: encryptSecret(credentials.refresh_token) ?? credentials.refresh_token,
          }),
          lastUsedAt: new Date(),
        },
      })
      client.setCredentials(credentials)
    }
  } else {
    // Just stamp lastUsedAt
    await prisma.googleIntegration
      .update({ where: { userId }, data: { lastUsedAt: new Date() } })
      .catch(() => {})
  }

  return client
}

/**
 * Revoke and delete a user's Google connection.
 */
export async function disconnectGoogle(userId: string): Promise<void> {
  const integ = await prisma.googleIntegration.findUnique({ where: { userId } })
  if (!integ) return

  // Best-effort revoke at Google's end
  try {
    const client = buildOAuth2Client()
    client.setCredentials({ refresh_token: decryptSecret(integ.refreshToken) })
    await client.revokeCredentials()
  } catch (err) {
    // Already revoked at Google's end? Whatever — still remove our record.
    console.warn('[google] revoke failed (continuing):', err)
  }

  await prisma.googleIntegration.delete({ where: { userId } })
}
