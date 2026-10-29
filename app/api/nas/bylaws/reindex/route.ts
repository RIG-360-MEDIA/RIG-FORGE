import { type NextRequest, NextResponse } from 'next/server'

import { isAdminRole } from '@/lib/auth'
import { authenticateActive } from '@/lib/authz'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { getOrgId } from '@/lib/tenant-context'
import { isNasEnabled } from '@/lib/nas/client'
import { isBylawsIndexingEnabled } from '@/lib/rag/index-bylaws-file'
import { startBylawsBackfill } from '@/lib/rag/bylaws-backfill'
import { getRun, runView } from '@/lib/rag/reindex-runs'

export const runtime = 'nodejs'

// POST /api/nas/bylaws/reindex — admin-only. Finds the bylaws folder
// ("utility data/By_Laws" at the root of a NAS share) on every drive and
// (re)indexes every extractable file into the separate bylaws Qdrant
// collection. Safe to re-run any time — unchanged files are skipped by
// content hash, so a run that is interrupted can simply be started again.
//
// Runs in the background: the whole sweep (hundreds of files, some fetched
// via slow connector-side OCR) can run well past a single request's budget.
// This returns a runId immediately; poll GET with that runId for progress
// and the final per-server results.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = await authenticateActive(request)
    if (!payload) return errorResponse('Authentication required', 401)
    if (!isAdminRole(payload.role)) return errorResponse('Admin access required', 403)
    if (!isNasEnabled()) return errorResponse('NAS is not available', 403)
    if (!isBylawsIndexingEnabled()) return errorResponse('Bylaws content search is not configured (HF_API_KEY/QDRANT_URL unset)', 503)

    const organizationId = getOrgId()

    const { runId, started, startedAt } = await startBylawsBackfill(organizationId)
    return successResponse({ runId, status: 'running', startedAt }, started ? 202 : 200)
  } catch (error) {
    console.error('[POST /api/nas/bylaws/reindex]', error)
    return errorResponse('Server error', 500)
  }
}

// GET /api/nas/bylaws/reindex?runId=... — admin-only. Poll a backfill run's
// progress/result. Omit runId for the most recent run.
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = await authenticateActive(request)
    if (!payload) return errorResponse('Authentication required', 401)
    if (!isAdminRole(payload.role)) return errorResponse('Admin access required', 403)
    // Same switch as POST: until RAG is configured there is nothing to report
    // (and the run table may not exist yet on this database).
    if (!isBylawsIndexingEnabled()) return errorResponse('Bylaws content search is not configured (HF_API_KEY/QDRANT_URL unset)', 503)

    const organizationId = getOrgId()
    const runId = request.nextUrl.searchParams.get('runId')

    const run = await getRun('bylaws', organizationId, runId)
    if (!run) return errorResponse('Run not found', 404)
    return successResponse(runView(run))
  } catch (error) {
    console.error('[GET /api/nas/bylaws/reindex]', error)
    return errorResponse('Server error', 500)
  }
}
