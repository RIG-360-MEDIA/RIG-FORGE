import { type NextRequest, NextResponse } from 'next/server'

import { isAdminRole } from '@/lib/auth'
import { authenticateActive } from '@/lib/authz'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { prisma } from '@/lib/db'
import { getOrgId } from '@/lib/tenant-context'
import { isNasEnabled, nasServers, nasFetchBytesStrict, nasExtractText, FileTooLargeError } from '@/lib/nas/client'
import { findBylawsFolder, listFilesRecursive } from '@/lib/nas/bylaws-crawl'
import { isExtractable } from '@/lib/nas/extract'
import { indexBylawsFile, isBylawsIndexingEnabled } from '@/lib/rag/index-bylaws-file'
import { MAX_INDEX_BYTES } from '@/lib/rag/index-core'

export const runtime = 'nodejs'

interface ServerResult {
  server: string
  folder: string
  filesFound: number
  indexed: number
  unchanged: number
  skippedNotExtractable: number
  skippedTooLarge: number
  failed: number
  /** First few failures with their reasons, so an admin can see WHY. */
  failures: Array<{ path: string; reason: string }>
}

async function runBackfill(runId: string, organizationId: string): Promise<void> {
  try {
    const servers = await nasServers()
    const results: ServerResult[] = []

    for (const s of servers) {
      const folder = await findBylawsFolder(s.label)
      if (!folder) continue

      const files = await listFilesRecursive(s.label, folder)
      const result: ServerResult = {
        server: s.label, folder, filesFound: files.length,
        indexed: 0, unchanged: 0, skippedNotExtractable: 0, skippedTooLarge: 0, failed: 0, failures: [],
      }
      const noteFailure = (path: string, reason: string) => {
        result.failed++
        if (result.failures.length < 20) result.failures.push({ path, reason })
      }

      for (const file of files) {
        const name = file.path.split('/').filter(Boolean).pop() || file.path
        if (!isExtractable(name)) {
          result.skippedNotExtractable++
          continue
        }
        // Decide from the LISTED size, before downloading. The old route
        // downloaded every file in full — a 245 MB PDF on a 512 MB instance —
        // and then cut it at 8 MB, which corrupts a PDF beyond parsing.
        if (file.size > MAX_INDEX_BYTES) {
          // Large PDFs don't have to stay unindexed: ask the connector (on
          // TRIJYA-3, not memory-constrained like Render) to extract the text
          // itself, OCR-ing scanned pages, and send text instead of bytes.
          if (name.toLowerCase().endsWith('.pdf')) {
            const extracted = await nasExtractText(s.label, file.path)
            if (extracted.ok) {
              const outcome = await indexBylawsFile(organizationId, s.label, file.path, {
                text: extracted.text, truncated: extracted.truncated, method: extracted.method,
              })
              if (outcome.status === 'indexed') result.indexed++
              else if (outcome.status === 'unchanged') result.unchanged++
              else if (outcome.status === 'skipped') result.skippedNotExtractable++
              else noteFailure(file.path, outcome.reason)
              continue
            }
            // Connector extraction failed (not yet deployed, OCR found
            // nothing, etc.) — fall through to the existing too-large record,
            // with the connector's reason appended for visibility.
            result.skippedTooLarge++
            if (result.failures.length < 20) {
              result.failures.push({ path: file.path, reason: `${(file.size / 1_048_576).toFixed(1)} MB, over the ${(MAX_INDEX_BYTES / 1_048_576).toFixed(0)} MB limit — connector extraction also failed: ${extracted.reason}` })
            }
            continue
          }
          result.skippedTooLarge++
          if (result.failures.length < 20) {
            result.failures.push({ path: file.path, reason: `${(file.size / 1_048_576).toFixed(1)} MB, over the ${(MAX_INDEX_BYTES / 1_048_576).toFixed(0)} MB limit (RAG_MAX_FILE_MB)` })
          }
          continue
        }
        try {
          const bytes = await nasFetchBytesStrict(s.label, file.path, MAX_INDEX_BYTES)
          // indexBylawsFile never throws — it reports what happened. The old
          // route counted every call as "indexed", even ones that had failed.
          const outcome = await indexBylawsFile(organizationId, s.label, file.path, bytes)
          if (outcome.status === 'indexed') result.indexed++
          else if (outcome.status === 'unchanged') result.unchanged++
          else if (outcome.status === 'skipped') result.skippedNotExtractable++
          else noteFailure(file.path, outcome.reason)
        } catch (e) {
          if (e instanceof FileTooLargeError) result.skippedTooLarge++
          else noteFailure(file.path, e instanceof Error ? e.message : 'download failed')
        }
      }
      results.push(result)

      // Persist after each server so a mid-run poll sees real progress
      // instead of nothing until the whole backfill finishes.
      await prisma.bylawsReindexRun.update({ where: { id: runId }, data: { results } }).catch(() => {})
    }

    await prisma.bylawsReindexRun.update({
      where: { id: runId },
      data: { status: 'DONE', finishedAt: new Date(), results },
    })
  } catch (error) {
    console.error('[bylaws-reindex]', error)
    await prisma.bylawsReindexRun.update({
      where: { id: runId },
      data: { status: 'FAILED', finishedAt: new Date(), error: error instanceof Error ? error.message : 'backfill failed' },
    }).catch(() => {})
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

    const inProgress = await prisma.bylawsReindexRun.findFirst({
      where: { organizationId, status: 'RUNNING' },
      orderBy: { startedAt: 'desc' },
    })
    if (inProgress) {
      return successResponse({ runId: inProgress.id, status: 'running', startedAt: inProgress.startedAt })
    }

    const run = await prisma.bylawsReindexRun.create({ data: { organizationId } })
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

    const run = runId
      ? await prisma.bylawsReindexRun.findUnique({ where: { id: runId } })
      : await prisma.bylawsReindexRun.findFirst({ where: { organizationId }, orderBy: { startedAt: 'desc' } })

    if (!run || run.organizationId !== organizationId) return errorResponse('Run not found', 404)

    return successResponse({
      runId: run.id,
      status: run.status.toLowerCase(),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      results: run.results ?? [],
      error: run.error,
    })
  } catch (error) {
    console.error('[GET /api/nas/bylaws/reindex]', error)
    return errorResponse('Server error', 500)
  }
}
