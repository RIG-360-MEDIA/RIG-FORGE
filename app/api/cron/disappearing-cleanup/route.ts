/**
 * POST /api/cron/disappearing-cleanup
 *
 * Cron-driven. Hard-deletes chat messages older than each conversation's
 * disappearing-messages TTL, in every company. Until now disappearing only
 * HID messages on read (listMessages cutoff); this removes them from the
 * server for real, including their stored photos, files and voice notes.
 *
 * Idempotent — re-running just deletes whatever is now past the TTL.
 */
import { type NextRequest } from 'next/server'

import { prisma } from '@/lib/db'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { forEachActiveOrg, isCronAuthorized } from '@/lib/cron'
import { deleteObject, keyFromProxyPath } from '@/lib/storage/r2'

export async function POST(request: NextRequest) {
  if (!isCronAuthorized(request)) return errorResponse('Unauthorized', 401)
  const results = await forEachActiveOrg(cleanOrg)
  const failed = results.filter((r) => r.error)
  if (failed.length === results.length && results.length > 0) return errorResponse('Cleanup failed', 500)
  return successResponse({ orgs: results })
}

async function cleanOrg() {
  const convos = await prisma.conversation.findMany({
    where: { disappearingSeconds: { not: null } },
    select: { id: true, disappearingSeconds: true },
  })
  let deleted = 0
  let filesDeleted = 0
  for (const c of convos) {
    if (!c.disappearingSeconds) continue
    const cutoff = new Date(Date.now() - c.disappearingSeconds * 1000)
    // Collect media keys first so we can free their R2 objects after the rows go.
    const expiring = await prisma.chatMessage.findMany({
      where: { conversationId: c.id, createdAt: { lt: cutoff }, type: { in: ['IMAGE', 'FILE', 'AUDIO'] } },
      select: { content: true },
    })
    // Cascades to reactions/stars; reply links SetNull.
    const r = await prisma.chatMessage.deleteMany({
      where: { conversationId: c.id, createdAt: { lt: cutoff } },
    })
    deleted += r.count
    // Awaited: the request must not end before the stored files are freed,
    // or they are orphaned (their message rows are already gone).
    const keys = expiring.map((m) => keyFromProxyPath(m.content)).filter((k): k is string => !!k)
    await Promise.allSettled(keys.map((k) => deleteObject(k)))
    filesDeleted += keys.length
  }
  return { conversationsScanned: convos.length, messagesDeleted: deleted, filesDeleted }
}
