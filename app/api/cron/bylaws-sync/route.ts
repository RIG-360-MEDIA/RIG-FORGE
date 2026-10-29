import { type NextRequest, NextResponse } from 'next/server'

import { successResponse, errorResponse } from '@/lib/api-helpers'
import { isCronAuthorized } from '@/lib/cron'
import { isNasEnabled, nasOrgId } from '@/lib/nas/client'
import { isBylawsIndexingEnabled } from '@/lib/rag/index-bylaws-file'
import { startBylawsBackfill } from '@/lib/rag/bylaws-backfill'
import { runWithOrg } from '@/lib/tenant-context'

// POST /api/cron/bylaws-sync — nightly: indexes new and changed files in the
// bylaws folder ("/utility data/By_Laws", lib/nas/bylaws-crawl.ts). Nothing else picks
// up a file copied straight onto the NAS: the TRIJYA-3 whole-NAS indexer
// leaves this folder to the bylaws pipeline, and before this cron only an
// admin's manual backfill read it, which is how the MDDA UTTARAKHAND bylaws
// went unindexed. Unchanged files are skipped by content hash, so a night
// with nothing new reads nothing. Starts the run and returns its id; progress
// is at GET /api/nas/bylaws/reindex. Called by .github/workflows/forgie-crons.yml.
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isCronAuthorized(request)) return errorResponse('Unauthorized', 401)
  // Switched off cleanly until RAG is configured: no database or NAS calls.
  if (!isBylawsIndexingEnabled()) return successResponse({ skipped: 'Bylaws indexing is not configured' })
  try {
    // NAS access is gated to one org and a cron has no request to carry it,
    // so run as that org explicitly. The run keeps this context after the
    // response is sent.
    const result = await runWithOrg(nasOrgId(), async () => {
      if (!isNasEnabled()) return { skipped: 'NAS is not configured' }
      const { runId, started, startedAt } = await startBylawsBackfill(nasOrgId())
      return { runId, status: started ? 'started' : 'already running', startedAt }
    })
    return successResponse(result)
  } catch (error) {
    console.error('[cron/bylaws-sync]', error)
    return errorResponse('Bylaws sync failed to start', 500)
  }
}
