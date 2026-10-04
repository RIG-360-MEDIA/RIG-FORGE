import { type NextRequest, NextResponse } from 'next/server'

import { isAdminRole } from '@/lib/auth'
import { authenticateActive } from '@/lib/authz'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { getOrgId } from '@/lib/tenant-context'
import { isNasEnabled } from '@/lib/nas/client'
import { listFilesRecursiveWithStatus } from '@/lib/nas/bylaws-crawl'
import { isExtractable } from '@/lib/nas/extract'
import { parseIndexFolders, INDEX_FOLDER_MAX_FILES } from '@/lib/nas/index-folders'
import { indexNasFile, isRagIndexingEnabled } from '@/lib/rag/index-nas-file'
import { fetchAndIndexFile } from '@/lib/rag/fetch-and-index'
import { getRun, runView, startRun, trackRun } from '@/lib/rag/reindex-runs'

export const runtime = 'nodejs'

interface FolderResult {
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
  // Same run tracking as the bylaws backfill (lib/rag/reindex-runs.ts).
  const run = trackRun('nas', runId, organizationId)
  try {
    const folders = parseIndexFolders()
    const results: FolderResult[] = []

    for (const scope of folders) {
      const { files, complete } = await listFilesRecursiveWithStatus(scope.server, scope.path, INDEX_FOLDER_MAX_FILES)
      const result: FolderResult = {
        server: scope.server, folder: scope.path, filesFound: files.length, listingComplete: complete,
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
        const outcome = await fetchAndIndexFile({
          organizationId, server: scope.server, path: file.path, size: file.size, indexer: indexNasFile,
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

      // Persist after each folder so a mid-run poll sees real progress
      // instead of nothing until the whole backfill finishes.
      await run.progress(results)
    }

    await run.finish('DONE', { results })
  } catch (error) {
    console.error('[nas-reindex]', error)
    await run.finish('FAILED', { error: error instanceof Error ? error.message : 'backfill failed' })
  }
}

// POST /api/nas/reindex — admin-only. Content-indexes every extractable file
// under each NAS_INDEX_FOLDERS scope (comma-separated "server:/path" pairs —
// see lib/nas/index-folders.ts). Unlike the bylaws backfill, there's no
// auto-discovered folder here: only files uploaded through Forge are
// content-indexed by default, since the ~327k files already on the NAS are
// too much to index wholesale on the free HF/Qdrant tiers — an admin opts in
// specific folders via that env var first. Safe to re-run any time —
// unchanged files are skipped by content hash.
//
// Runs in the background, same shape as POST /api/nas/bylaws/reindex:
// returns a runId immediately, poll GET with that runId for progress.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = await authenticateActive(request)
    if (!payload) return errorResponse('Authentication required', 401)
    if (!isAdminRole(payload.role)) return errorResponse('Admin access required', 403)
    if (!isNasEnabled()) return errorResponse('NAS is not available', 403)
    if (!isRagIndexingEnabled()) return errorResponse('NAS content search is not configured (HF_API_KEY/QDRANT_URL unset)', 503)

    const folders = parseIndexFolders()
    if (folders.length === 0) return errorResponse('NAS_INDEX_FOLDERS is not set — nothing to index', 400)

    const organizationId = getOrgId()

    const { run, started } = await startRun('nas', organizationId)
    if (!started) return successResponse({ runId: run.id, status: 'running', startedAt: run.startedAt })
    void runBackfill(run.id, organizationId)

    return successResponse({ runId: run.id, status: 'running', startedAt: run.startedAt, folders }, 202)
  } catch (error) {
    console.error('[POST /api/nas/reindex]', error)
    return errorResponse('Server error', 500)
  }
}

// GET /api/nas/reindex?runId=... — admin-only. Poll a backfill run's
// progress/result. Omit runId for the most recent run.
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = await authenticateActive(request)
    if (!payload) return errorResponse('Authentication required', 401)
    if (!isAdminRole(payload.role)) return errorResponse('Admin access required', 403)

    const organizationId = getOrgId()
    const runId = request.nextUrl.searchParams.get('runId')

    const run = await getRun('nas', organizationId, runId)
    if (!run) return errorResponse('Run not found', 404)
    return successResponse(runView(run))
  } catch (error) {
    console.error('[GET /api/nas/reindex]', error)
    return errorResponse('Server error', 500)
  }
}
