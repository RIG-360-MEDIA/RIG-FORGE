/**
 * The bylaws backfill: find the bylaws folder ("/utility data", see
 * lib/nas/bylaws-crawl.ts) on every NAS drive and index every extractable
 * file in it into the bylaws Qdrant collection. Unchanged files are skipped by
 * content hash, so a run only reads new or changed files and can be repeated
 * at any time. Started by an admin (POST /api/nas/bylaws/reindex) and nightly
 * by the bylaws-sync cron; one run at a time per organisation
 * (lib/rag/reindex-runs.ts).
 */
import { nasServers } from '@/lib/nas/client'
import { findBylawsFolder, listFilesRecursiveWithStatus } from '@/lib/nas/bylaws-crawl'
import { isExtractable } from '@/lib/nas/extract'
import { indexBylawsFile } from '@/lib/rag/index-bylaws-file'
import { fetchAndIndexFile } from '@/lib/rag/fetch-and-index'
import { startRun, trackRun } from '@/lib/rag/reindex-runs'

export interface ServerResult {
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

/**
 * Start a backfill in the background, or return the one already running.
 * Call inside the organisation's context (a request, or runWithOrg for a
 * cron): NAS access is checked against it while the run works.
 */
export async function startBylawsBackfill(organizationId: string): Promise<{ runId: string; started: boolean; startedAt: Date }> {
  // One run at a time per org. A run interrupted by a restart no longer
  // blocks this forever (lib/rag/reindex-runs.ts).
  const { run, started } = await startRun('bylaws', organizationId)
  if (started) void runBackfill(run.id, organizationId)
  return { runId: run.id, started, startedAt: run.startedAt }
}
