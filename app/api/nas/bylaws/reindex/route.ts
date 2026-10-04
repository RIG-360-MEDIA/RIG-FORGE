import { type NextRequest, NextResponse } from 'next/server'

import { isAdminRole } from '@/lib/auth'
import { authenticateActive } from '@/lib/authz'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { getOrgId } from '@/lib/tenant-context'
import { isNasEnabled, nasServers } from '@/lib/nas/client'
import { findBylawsFolder, listFilesRecursiveWithStatus } from '@/lib/nas/bylaws-crawl'
import { isExtractable } from '@/lib/nas/extract'
import { indexBylawsFile, isBylawsIndexingEnabled } from '@/lib/rag/index-bylaws-file'
import { fetchAndIndexFile } from '@/lib/rag/fetch-and-index'
import { getRun, runView, startRun, trackRun } from '@/lib/rag/reindex-runs'

export const runtime = 'nodejs'

interface ServerResult {
  server: string
  folder: string
  filesFound: number
  /** False when the file cap stopped the listing: some files were not reached. */
  listingComplete: boolean
  indexed: number
  unchanged: number
  skippedNotExtractable: number
  skippedTooLarge: number
  failed: number
  /** First few failures with their reasons, so an admin can see WHY. */
  failures: Array<{ path: string; reason: string }>
}

async function runBackfill(runId: string, organizationId: string): Promise<void> {
  // Heart-beats while the job runs; cancelled() turns true if this run was
  // taken over as interrupted (see lib/rag/reindex-runs.ts), and then we stop.
  const run = trackRun('bylaws', runId, organizationId)
  try {
    const servers = await nasServers()
    const results: ServerResult[] = []

    for (const s of servers) {
      const folder = await findBylawsFolder(s.label)
      if (!folder) continue

      const { files, complete } = await listFilesRecursiveWithStatus(s.label, folder)
      const result: ServerResult = {
        server: s.label, folder, filesFound: files.length, listingComplete: complete,
        indexed: 0, unchanged: 0, skippedNotExtractable: 0, skippedTooLarge: 0, failed: 0, failures: [],
      }
      const noteFailure = (path: string, reason: string) => {
        result.failed++
        if (result.failures.length < 20) result.failures.push({ path, reason })
      }

      for (const file of files) {
        if (run.cancelled()) { run.stop(); return }
        const name = file.path.split('/').filter(Boolean).pop() || file.path
        if (!isExtractable(name)) {
          result.skippedNotExtractable++
          continue
        }
        // fetchAndIndexFile decides from the LISTED size, before downloading
        // (the old route downloaded every file in full — a 245 MB PDF on a
        // 512 MB instance — and then cut it at 8 MB, which corrupts a PDF
        // beyond parsing), and for an oversized PDF asks the connector (on
        // TRIJYA-3, not memory-constrained like Render) to extract the text
        // itself, OCR-ing scanned pages, instead of giving up outright.
        const outcome = await fetchAndIndexFile({
          organizationId, server: s.label, path: file.path, size: file.size, indexer: indexBylawsFile,
        })
        if (outcome.status === 'indexed') result.indexed++
        else if (outcome.status === 'unchanged') result.unchanged++
        else if (outcome.status === 'skipped' && 'tooLarge' in outcome) {
          result.skippedTooLarge++
          if (result.failures.length < 20) result.failures.push({ path: file.path, reason: outcome.reason })
        } else if (outcome.status === 'skipped') result.skippedNotExtractable++
        else noteFailure(file.path, outcome.reason)
      }
      results.push(result)

      // Persist after each server so a mid-run poll sees real progress
      // instead of nothing until the whole backfill finishes.
      await run.progress(results)
    }

    await run.finish('DONE', { results })
  } catch (error) {
    console.error('[bylaws-reindex]', error)
    await run.finish('FAILED', { error: error instanceof Error ? error.message : 'backfill failed' })
  }
}

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

    // One run at a time per org. A run interrupted by a restart no longer
    // blocks this forever (lib/rag/reindex-runs.ts).
    const { run, started } = await startRun('bylaws', organizationId)
    if (!started) return successResponse({ runId: run.id, status: 'running', startedAt: run.startedAt })
    void runBackfill(run.id, organizationId)

    return successResponse({ runId: run.id, status: 'running', startedAt: run.startedAt }, 202)
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
