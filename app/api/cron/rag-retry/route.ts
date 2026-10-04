import { type NextRequest, NextResponse } from 'next/server'

import { successResponse, errorResponse } from '@/lib/api-helpers'
import { isCronAuthorized } from '@/lib/cron'
import { isNasEnabled, nasOrgId } from '@/lib/nas/client'
import { isRagIndexingEnabled } from '@/lib/rag/index-nas-file'
import { runRetryQueue } from '@/lib/rag/retry-queue'
import { runWithOrg } from '@/lib/tenant-context'

// POST /api/cron/rag-retry — retries FAILED rows (HF rate-limited, Qdrant
// briefly down, etc.) and PENDING rows whose indexing was interrupted (a
// Render restart mid-index) in BOTH tracker tables, with backoff. All the
// rules live in lib/rag/retry-queue.ts. Called every 15 minutes by the
// GitHub Actions workflow (.github/workflows/forgie-crons.yml).
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isCronAuthorized(request)) return errorResponse('Unauthorized', 401)
  // Switched off cleanly until RAG is configured: no database or NAS calls at
  // all, so the schedule can run before the feature is set up.
  if (!isRagIndexingEnabled()) return successResponse({ skipped: 'RAG indexing is not configured' })
  try {
    // NAS access is gated to one org and a cron has no request to carry it,
    // so run as that org explicitly.
    const result = await runWithOrg(nasOrgId(), async () => {
      if (!isNasEnabled()) return { skipped: 'NAS is not configured' }
      return runRetryQueue()
    })
    return successResponse(result)
  } catch (error) {
    console.error('[cron/rag-retry]', error)
    return errorResponse('Retry sweep failed', 500)
  }
}
