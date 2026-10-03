import { type NextRequest, NextResponse } from 'next/server'

import { successResponse, errorResponse } from '@/lib/api-helpers'
import { isCronAuthorized } from '@/lib/cron'
import { prisma } from '@/lib/db'
import { nasList } from '@/lib/nas/client'
import { indexBylawsFile } from '@/lib/rag/index-bylaws-file'
import { indexNasFile } from '@/lib/rag/index-nas-file'
import { fetchAndIndexFile } from '@/lib/rag/fetch-and-index'
import { runWithOrg } from '@/lib/tenant-context'

const BATCH_SIZE = Math.max(1, Number(process.env.RAG_RETRY_BATCH_SIZE ?? 20))
// A PENDING row this old was written right before a fire-and-forget index
// started (see markNasPending/markBylawsPending) — if it's still PENDING
// this long, the process that was supposed to finish it almost certainly
// crashed or restarted. Retry it. Anything younger is probably just mid-flight.
const STUCK_PENDING_MS = 10 * 60 * 1000

interface TrackedRow { organizationId: string; server: string; path: string }
interface Tally { attempted: number; indexed: number; unchanged: number; skipped: number; failed: number; gone: number }

async function retryRow(row: TrackedRow, indexer: typeof indexNasFile, tally: Tally): Promise<void> {
  tally.attempted++
  const name = row.path.split('/').filter(Boolean).pop() || row.path
  const dir = row.path.slice(0, row.path.length - name.length) || '/'

  let size: number | null = null
  try {
    const { items } = await nasList(row.server, dir)
    size = items.find((i) => i.name === name && !i.isDir)?.size ?? null
  } catch {
    size = null // connector unreachable, dir gone, etc. — treat like "couldn't confirm", skip this round
  }
  // File isn't there any more (or its directory is gone) — not this route's
  // job to decide that means "delete the index entry"; the stale sweep
  // (app/api/cron/rag-stale-sweep) owns that, with its own grace window.
  if (size === null) { tally.gone++; return }

  const outcome = await fetchAndIndexFile({
    organizationId: row.organizationId, server: row.server, path: row.path, size, indexer,
  })
  if (outcome.status === 'indexed') tally.indexed++
  else if (outcome.status === 'unchanged') tally.unchanged++
  else if (outcome.status === 'skipped') tally.skipped++
  else tally.failed++
}

// POST /api/cron/rag-retry — retries FAILED rows (HF rate-limited, Qdrant
// briefly down, etc.) and PENDING rows stuck past STUCK_PENDING_MS (a Render
// restart mid-index, which otherwise never gets retried automatically) in
// BOTH tracker tables. Call periodically from an external scheduler, same as
// the other app/api/cron/* routes.
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isCronAuthorized(request)) return errorResponse('Unauthorized', 401)
  try {
    // NAS access is gated to the 'trijya' org (see lib/nas/client.ts); there
    // is no request/session here to carry that context, so set it explicitly
    // — every real tracker row belongs to trijya in practice (NAS is
    // trijya-only), the schema defaults are just generic boilerplate.
    const result = await runWithOrg('trijya', async () => {
      const stuckBefore = new Date(Date.now() - STUCK_PENDING_MS)

      const nasRows = await prisma.nasIndexedFile.findMany({
        where: { OR: [{ status: 'FAILED' }, { status: 'PENDING', updatedAt: { lt: stuckBefore } }] },
        orderBy: { updatedAt: 'asc' },
        take: BATCH_SIZE,
      })
      const nas: Tally = { attempted: 0, indexed: 0, unchanged: 0, skipped: 0, failed: 0, gone: 0 }
      for (const row of nasRows) await retryRow(row, indexNasFile, nas)

      const bylawsRows = await prisma.bylawsIndexedFile.findMany({
        where: { OR: [{ status: 'FAILED' }, { status: 'PENDING', updatedAt: { lt: stuckBefore } }] },
        orderBy: { updatedAt: 'asc' },
        take: BATCH_SIZE,
      })
      const bylaws: Tally = { attempted: 0, indexed: 0, unchanged: 0, skipped: 0, failed: 0, gone: 0 }
      for (const row of bylawsRows) await retryRow(row, indexBylawsFile, bylaws)

      return { nas, bylaws }
    })

    return successResponse(result)
  } catch (error) {
    console.error('[cron/rag-retry]', error)
    return errorResponse('Retry sweep failed', 500)
  }
}
