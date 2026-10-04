import { type NextRequest, NextResponse } from 'next/server'

import { successResponse, errorResponse } from '@/lib/api-helpers'
import { isCronAuthorized } from '@/lib/cron'
import { prisma } from '@/lib/db'
import { isNasEnabled, nasOrgId, nasServers } from '@/lib/nas/client'
import { findBylawsFolder, listFilesRecursiveWithStatus } from '@/lib/nas/bylaws-crawl'
import { parseIndexFolders, INDEX_FOLDER_MAX_FILES } from '@/lib/nas/index-folders'
import { isRagIndexingEnabled } from '@/lib/rag/index-nas-file'
import { pruneStaleChunks, BYLAWS_COLLECTION, COLLECTION } from '@/lib/rag/qdrant'
import { runWithOrg } from '@/lib/tenant-context'

// A file not seen on a live listing for this long is pruned. Set well above
// the sweep's own run interval (daily) so one slow or failed crawl can't cause
// a false prune — see the lastSeenAt field in prisma/schema.prisma.
const graceHours = Number(process.env.RAG_STALE_GRACE_HOURS)
const GRACE_MS = (Number.isFinite(graceHours) && graceHours >= 1 ? graceHours : 48) * 3_600_000
const BYLAWS_MAX_FILES = 2000
// Postgres caps one statement at 32,767 parameters; stay far below it.
const IN_CHUNK = 5000

interface SweepTally {
  scopesChecked: number
  filesConfirmed: number
  pruned: number
  /** Scopes whose listing hit the file cap: nothing is pruned in those, since
   * a file that was not reached is not known to be gone. */
  incompleteScopes: string[]
  /** Scopes whose listing errored (connector down, folder unreadable): skipped
   * this run, nothing pruned in them; other scopes are unaffected. */
  failedScopes: Array<{ scope: string; error: string }>
}

type Table = 'bylaws' | 'nas'

async function confirmSeen(table: Table, organizationId: string, server: string, paths: string[], now: Date): Promise<number> {
  let n = 0
  for (let i = 0; i < paths.length; i += IN_CHUNK) {
    const where = { organizationId, server, status: 'INDEXED' as const, path: { in: paths.slice(i, i + IN_CHUNK) } }
    const data = { lastSeenAt: now }
    const { count } = table === 'bylaws'
      ? await prisma.bylawsIndexedFile.updateMany({ where, data })
      : await prisma.nasIndexedFile.updateMany({ where, data })
    n += count
  }
  return n
}

async function pruneUnseen(table: Table, organizationId: string, server: string, pathPrefix: string | null, cutoff: Date): Promise<number> {
  const where = {
    organizationId, server, status: 'INDEXED' as const,
    ...(pathPrefix && { path: { startsWith: pathPrefix } }),
    OR: [{ lastSeenAt: { lt: cutoff } }, { lastSeenAt: null, updatedAt: { lt: cutoff } }],
  }
  const stale = table === 'bylaws'
    ? await prisma.bylawsIndexedFile.findMany({ where, select: { id: true, path: true } })
    : await prisma.nasIndexedFile.findMany({ where, select: { id: true, path: true } })
  let pruned = 0
  for (const row of stale) {
    try {
      // Chunks first: if Qdrant is down, keep the row so the chunks are not
      // orphaned; the next sweep tries again.
      await pruneStaleChunks(organizationId, server, row.path, 0, table === 'bylaws' ? BYLAWS_COLLECTION : COLLECTION)
    } catch {
      continue
    }
    if (table === 'bylaws') await prisma.bylawsIndexedFile.deleteMany({ where: { id: row.id, organizationId } })
    else await prisma.nasIndexedFile.deleteMany({ where: { id: row.id, organizationId } })
    pruned++
  }
  return pruned
}

/** Prefix that only matches paths INSIDE the folder: "/A" must not match "/AB/x". */
const insideFolder = (folder: string) => folder.replace(/\/+$/, '') + '/'

async function sweepBylaws(organizationId: string): Promise<SweepTally> {
  const tally: SweepTally = { scopesChecked: 0, filesConfirmed: 0, pruned: 0, incompleteScopes: [], failedScopes: [] }
  const now = new Date()
  const cutoff = new Date(now.getTime() - GRACE_MS)
  const complete: string[] = []

  for (const s of await nasServers()) {
    let folder: string | null = null
    let listing: Awaited<ReturnType<typeof listFilesRecursiveWithStatus>>
    try {
      folder = await findBylawsFolder(s.label)
      if (!folder) continue // couldn't confirm the folder this run — don't touch this server's rows at all
      listing = await listFilesRecursiveWithStatus(s.label, folder, BYLAWS_MAX_FILES)
    } catch (e) {
      tally.failedScopes.push({ scope: `${s.label}:${folder ?? '?'}`, error: e instanceof Error ? e.message : 'listing failed' })
      continue
    }
    const { files, complete: whole } = listing
    tally.filesConfirmed += await confirmSeen('bylaws', organizationId, s.label, files.map((f) => f.path), now)
    tally.scopesChecked++
    if (whole) complete.push(s.label)
    else tally.incompleteScopes.push(`${s.label}:${folder}`)
  }
  for (const server of complete) tally.pruned += await pruneUnseen('bylaws', organizationId, server, null, cutoff)
  return tally
}

async function sweepNas(organizationId: string): Promise<SweepTally> {
  const tally: SweepTally = { scopesChecked: 0, filesConfirmed: 0, pruned: 0, incompleteScopes: [], failedScopes: [] }
  const now = new Date()
  const cutoff = new Date(now.getTime() - GRACE_MS)
  const scopes = parseIndexFolders() // only configured folders are ever swept — see lib/nas/index-folders.ts
  const complete: typeof scopes = []

  for (const scope of scopes) {
    let listing: Awaited<ReturnType<typeof listFilesRecursiveWithStatus>>
    try {
      listing = await listFilesRecursiveWithStatus(scope.server, scope.path, INDEX_FOLDER_MAX_FILES)
    } catch (e) {
      tally.failedScopes.push({ scope: `${scope.server}:${scope.path}`, error: e instanceof Error ? e.message : 'listing failed' })
      continue
    }
    const { files, complete: whole } = listing
    tally.filesConfirmed += await confirmSeen('nas', organizationId, scope.server, files.map((f) => f.path), now)
    tally.scopesChecked++
    if (whole) complete.push(scope)
    else tally.incompleteScopes.push(`${scope.server}:${scope.path}`)
  }
  for (const scope of complete) {
    tally.pruned += await pruneUnseen('nas', organizationId, scope.server, insideFolder(scope.path), cutoff)
  }
  return tally
}

// POST /api/cron/rag-stale-sweep — files deleted/renamed on the NAS stay
// searchable forever otherwise (nothing else removes their Qdrant chunks).
// Mark-and-sweep with a grace window, not a one-shot diff: only "not seen for
// RAG_STALE_GRACE_HOURS" counts as gone. Each scope stands alone: one whose
// listing errors or is cut short by the file cap prunes nothing, and the other
// scopes are swept normally. Bylaws is swept in full; general NAS only
// within NAS_INDEX_FOLDERS (same scope app/api/nas/reindex backfills) — a
// file outside that scope is never considered here.
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isCronAuthorized(request)) return errorResponse('Unauthorized', 401)
  // Switched off cleanly until RAG is configured: no database or NAS calls.
  if (!isRagIndexingEnabled()) return successResponse({ skipped: 'RAG indexing is not configured' })
  try {
    const organizationId = nasOrgId()
    const result = await runWithOrg(organizationId, async () => {
      if (!isNasEnabled()) return { skipped: 'NAS is not configured' }
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
