/**
 * Fetch one file from the NAS and index it — shared by every backfill/retry
 * path (bylaws reindex, the general-NAS reindex, and the retry queue) so the
 * "oversized PDF -> ask the connector to extract text instead" fallback only
 * lives once. Previously inlined in app/api/nas/bylaws/reindex/route.ts;
 * extracted so E and K don't copy it a third time.
 */
import { nasFetchBytesStrict, nasExtractText, FileTooLargeError } from '@/lib/nas/client'
import { MAX_INDEX_BYTES, type IndexOutcome, type PreExtracted } from './index-core'

export interface FetchAndIndexOpts {
  organizationId: string
  server: string
  /** Full path on that server, as returned by the NAS listing. */
  path: string
  /** Size from the listing — checked BEFORE downloading, same as the
   * original bylaws route: a 245 MB file should never be fully buffered
   * just to discover it's too large. */
  size: number
  indexer: (organizationId: string, server: string, path: string, bytesOrText: Buffer | PreExtracted) => Promise<IndexOutcome>
}

/** Same as IndexOutcome's 'skipped' case, but tagged `tooLarge` so callers
 * can tally it separately (e.g. `skippedTooLarge` vs `skippedNotExtractable`)
 * without resorting to matching on the reason string. */
export type FetchAndIndexOutcome = IndexOutcome | { status: 'skipped'; reason: string; tooLarge: true }

export async function fetchAndIndexFile(opts: FetchAndIndexOpts): Promise<FetchAndIndexOutcome> {
  const { organizationId, server, path, size, indexer } = opts

  if (size > MAX_INDEX_BYTES) {
    if (path.toLowerCase().endsWith('.pdf')) {
      const extracted = await nasExtractText(server, path)
      if (extracted.ok) {
        return indexer(organizationId, server, path, {
          text: extracted.text, truncated: extracted.truncated, method: extracted.method,
        })
      }
      return {
        status: 'skipped', tooLarge: true,
        reason: `${(size / 1_048_576).toFixed(1)} MB, over the ${(MAX_INDEX_BYTES / 1_048_576).toFixed(0)} MB limit — connector extraction also failed: ${extracted.reason}`,
      }
    }
    return {
      status: 'skipped', tooLarge: true,
      reason: `${(size / 1_048_576).toFixed(1)} MB, over the ${(MAX_INDEX_BYTES / 1_048_576).toFixed(0)} MB limit (RAG_MAX_FILE_MB)`,
    }
  }

  try {
    const bytes = await nasFetchBytesStrict(server, path, MAX_INDEX_BYTES)
    return await indexer(organizationId, server, path, bytes)
  } catch (e) {
    if (e instanceof FileTooLargeError) return { status: 'skipped', tooLarge: true, reason: e.message }
    return { status: 'failed', reason: e instanceof Error ? e.message : 'download failed' }
  }
}
