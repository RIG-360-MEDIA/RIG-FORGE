import { prisma } from '@/lib/db'
import { runWithOrg } from '@/lib/tenant-context'
import { sendMessage, type SendAttachment } from '@/lib/assistant/tools/gmail'

// Developer inbox that receives every new issue. Overridable via env so it can
// be changed without a code deploy.
const NOTIFY_TO = process.env.ISSUE_NOTIFY_EMAIL || 'jainkavyakj123@gmail.com'
// Preferred sender: the developer's own connected Google account.
const PREFERRED_SENDER_EMAIL = 'kavya@rigforge.com'

export interface IssueEmailInput {
  id: string
  title: string
  description: string
  reporterName: string
  reporterEmail: string
  organizationId: string
  pageUrl?: string | null
  userAgent?: string | null
  appUrl?: string | null
  image?: SendAttachment | null
}

const GMAIL_SEND_RE = /gmail\.send|gmail\.modify|gmail\.compose|mail\.google\.com/

/**
 * Candidate accounts to send the notification through, best first. Uses a raw
 * query so the org-scope extension does NOT filter it — the sender may live in a
 * different org than the reporter (the Gmail token fetch is keyed by userId,
 * org-agnostic). Only send-capable connections are returned; ordered by the
 * developer's own account first, then most-recently-used (its refresh token is
 * the most likely to still be valid).
 */
async function resolveSenderCandidates(): Promise<Array<{ id: string; org: string }>> {
  const rows = await prisma.$queryRaw<{ id: string; org: string; scopes: string; is_pref: boolean }[]>`
    SELECT u.id, g."organizationId" AS org, g.scopes, (u.email = ${PREFERRED_SENDER_EMAIL}) AS is_pref
    FROM "User" u
    JOIN "GoogleIntegration" g ON g."userId" = u.id
    ORDER BY (u.email = ${PREFERRED_SENDER_EMAIL}) DESC, g."lastUsedAt" DESC NULLS LAST`
  return rows.filter((r) => GMAIL_SEND_RE.test(r.scopes ?? '')).map((r) => ({ id: r.id, org: r.org }))
}

/**
 * Email the developer about a newly filed issue. Best-effort: a failure here must
 * never fail the issue submission, so callers should not await-throw on it.
 */
export async function notifyIssueByEmail(
  input: IssueEmailInput,
): Promise<{ sent: boolean; error?: string }> {
  try {
    const senders = await resolveSenderCandidates()
    if (senders.length === 0) return { sent: false, error: 'no send-capable Google account connected' }

    const body = [
      `A new issue was reported in "${input.organizationId}".`,
      '',
      `Title:       ${input.title}`,
      `Reported by: ${input.reporterName} <${input.reporterEmail}>`,
      input.pageUrl ? `Page:        ${input.pageUrl}` : '',
      input.userAgent ? `Device:      ${input.userAgent}` : '',
      '',
      'Description',
      '-----------',
      input.description,
      '',
      input.appUrl ? `Open issues list: ${input.appUrl}/dashboard/issues` : '',
      `Issue ID: ${input.id}`,
      input.image ? '' : '(no screenshot attached)',
    ]
      .filter((l) => l !== '')
      .join('\n')

    // Try each candidate until one send succeeds — a single account's refresh
    // token may have gone stale, so we fall back to the next healthiest one.
    const errors: string[] = []
    for (const sender of senders) {
      try {
        // Send AS the sender's company. The reporter's request is filtered to
        // the reporter's company, and lookups by unique key are now filtered
        // too (lib/db.ts), so without this a sender in another company would
        // look as if they had never connected Google. sendMessage only reads
        // and updates the sender's own GoogleIntegration row, so the company
        // that row is filed under is the right one to act as.
        await runWithOrg(sender.org, () => sendMessage(sender.id, {
          to: NOTIFY_TO,
          subject: `[Forge issue] ${input.title}`,
          body,
          attachments: input.image ? [input.image] : undefined,
        }))
        return { sent: true }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : 'send failed')
      }
    }
    return { sent: false, error: `all ${senders.length} sender(s) failed: ${errors.join(' | ')}` }
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : 'send failed' }
  }
}
