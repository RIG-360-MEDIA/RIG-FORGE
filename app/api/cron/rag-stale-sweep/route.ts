import { type NextRequest, NextResponse } from 'next/server'

import { successResponse, errorResponse } from '@/lib/api-helpers'
import { isCronAuthorized } from '@/lib/cron'
import { prisma } from '@/lib/db'
import { nasServers } from '@/lib/nas/client'
import { findBylawsFolder, listFilesRecursive } from '@/lib/nas/bylaws-crawl'
import { parseIndexFolders, INDEX_FOLDER_MAX_FILES } from '@/lib/nas/index-folders'
import { pruneStaleChunks, BYLAWS_COLLECTION, COLLECTION } from '@/lib/rag/qdrant'
import { runWithOrg } from '@/lib/tenant-context'

// A file not seen on a live listing for this long is pruned. Set well above
// the sweep's own run interval (whatever the external scheduler uses) so one
// slow/partial crawl can't cause a false prune — see the file-level warning
// in prisma/schema.prisma's lastSeenAt field.
const GRACE_MS = Math.max(1, Number(process.env.RAG_STALE_GRACE_HOURS ?? 48)) * 3_600_000

interface SweepTally { scopesChecked: number; filesConfirmed: number; pruned: number }

async function pruneStale(
  organizationId: string,
  server: string,
  rows: Array<{ id: string; path: string }>,
  collection: string,
  deleteRow: (id: string) => Promise<unknown>,
): Promise<number> {
  for (const row of rows) {
    await pruneStaleChunks(organizationId, server, row.path, 0, collection).catch(() => {})
    await deleteRow(row.id).catch(() => {})
  }
  return rows.length
}

async function sweepBylaws(organizationId: string): Promise<SweepTally> {
  const tally: SweepTally = { scopesChecked: 0, filesConfirmed: 0, pruned: 0 }
  const now = new Date()
  const cutoff = new Date(now.getTime() - GRACE_MS)
  const verifiedServers: string[] = []

  for (const s of await nasServers()) {
    const folder = await findBylawsFolder(s.label)
    if (!folder) continue // couldn't confirm the folder this run — don't touch this server's rows at all
    const files = await listFilesRecursive(s.label, folder)
    verifiedServers.push(s.label)
    const livePaths = files.map((f) => f.path)
    if (livePaths.length > 0) {
      const { count } = await prisma.bylawsIndexedFile.updateMany({
        where: { organizationId, server: s.label, status: 'INDEXED', path: { in: livePaths } },
        data: { lastSeenAt: now },
      })
      tally.filesConfirmed += count
    }
  }
  tally.scopesChecked = verifiedServers.length

  for (const server of verifiedServers) {
    const stale = await prisma.bylawsIndexedFile.findMany({
      where: {
        organizationId, server, status: 'INDEXED',
        OR: [{ lastSeenAt: { lt: cutoff } }, { lastSeenAt: null, updatedAt: { lt: cutoff } }],
      },
      select: { id: true, path: true },
    })
    tally.pruned += await pruneStale(organizationId, server, stale, BYLAWS_COLLECTION, (id) => prisma.bylawsIndexedFile.delete({ where: { id } }))
  }
  return tally
}

async function sweepNas(organizationId: string): Promise<SweepTally> {
  const tally: SweepTally = { scopesChecked: 0, filesConfirmed: 0, pruned: 0 }
  const now = new Date()
  const cutoff = new Date(now.getTime() - GRACE_MS)
  const scopes = parseIndexFolders() // only configured folders are ever swept — see lib/nas/index-folders.ts

  for (const scope of scopes) {
    const files = await listFilesRecursive(scope.server, scope.path, INDEX_FOLDER_MAX_FILES)
    const livePaths = files.map((f) => f.path)
    if (livePaths.length > 0) {
      const { count } = await prisma.nasIndexedFile.updateMany({
        where: { organizationId, server: scope.server, status: 'INDEXED', path: { in: livePaths } },
        data: { lastSeenAt: now },
      })
      tally.filesConfirmed += count
    }
  }
  tally.scopesChecked = scopes.length

  for (const scope of scopes) {
    const stale = await prisma.nasIndexedFile.findMany({
      where: {
        organizationId, server: scope.server, status: 'INDEXED',
        path: { startsWith: scope.path },
        OR: [{ lastSeenAt: { lt: cutoff } }, { lastSeenAt: null, updatedAt: { lt: cutoff } }],
      },
      select: { id: true, path: true },
    })
    tally.pruned += await pruneStale(organizationId, scope.server, stale, COLLECTION, (id) => prisma.nasIndexedFile.delete({ where: { id } }))
  }
  return tally
}

// POST /api/cron/rag-stale-sweep — files deleted/renamed on the NAS stay
// searchable forever otherwise (nothing else removes their Qdrant chunks).
// Mark-and-sweep with a grace window, not a one-shot diff: a live crawl is
// "hundreds of round-trips" for a large tree, so a run that's slow or caps
// out at INDEX_FOLDER_MAX_FILES must not treat "not seen THIS run" as gone —
// only "not seen for RAG_STALE_GRACE_HOURS" is. Bylaws is swept in full
// (its folder is small and auto-discovered); general NAS is swept only
// within NAS_INDEX_FOLDERS (same scope app/api/nas/reindex backfills) — a
// file outside that scope was never indexed by the bulk backfill, so it's
// never considered for pruning here either; only a stale re-UPLOAD through
// Forge could leave one of those behind, and that case isn't handled here.
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isCronAuthorized(request)) return errorResponse('Unauthorized', 401)
  try {
    const result = await runWithOrg('trijya', async () => {
      // Every real tracker row belongs to 'trijya' in practice — NAS access
      // itself is gated to that org (see lib/nas/client.ts's isNasEnabled).
      const organizationId = 'trijya'
      const bylaws = await sweepBylaws(organizationId)
      const nas = await sweepNas(organizationId)
      return { bylaws, nas }
    })
    return successResponse(result)
  } catch (error) {
    console.error('[cron/rag-stale-sweep]', error)
    return errorResponse('Stale sweep failed', 500)
  }
}
