/**
 * Fetch one file from the NAS and index it — shared by every backfill/retry
 * path (bylaws reindex, the general-NAS reindex, and the retry queue) so the
 * "ask the connector to extract text instead" fallback only lives once.
 * Previously inlined in app/api/nas/bylaws/reindex/route.ts; extracted so E
 * and K don't copy it a third time.
 *
 * The connector is used for two kinds of PDF:
 *  - too large to download into Render's memory (over RAG_MAX_FILE_MB);
 *  - small, but unreadable HERE: scanned (no text layer: needs OCR, which
 *    only the connector can do; most scanned bylaws are a few MB, so without
 *    this they would never get OCR at all), or a PDF the bundled pdf.js
 *    rejects outright (it fails on some producers' files that PyMuPDF on the
 *    connector reads fine).
 */
import { nasFetchBytesStrict, nasExtractText, FileTooLargeError } from '@/lib/nas/client'
import { INDEX_MAX_TEXT } from '@/lib/nas/extract'
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

const isPdf = (path: string) => path.toLowerCase().endsWith('.pdf')

export async function fetchAndIndexFile(opts: FetchAndIndexOpts): Promise<FetchAndIndexOutcome> {
  const { organizationId, server, path, size, indexer } = opts
  const viaConnector = async () => {
    const extracted = await nasExtractText(server, path, INDEX_MAX_TEXT)
    return extracted.ok
      ? { ok: true as const, outcome: await indexer(organizationId, server, path, { text: extracted.text, truncated: extracted.truncated, method: extracted.method }) }
      : { ok: false as const, reason: extracted.reason }
  }
  const mb = (n: number) => (n / 1_048_576).toFixed(1)

  if (size > MAX_INDEX_BYTES) {
    if (isPdf(path)) {
      const r = await viaConnector()
      if (r.ok) return r.outcome
      return {
        status: 'skipped', tooLarge: true,
        reason: `${mb(size)} MB, over the ${(MAX_INDEX_BYTES / 1_048_576).toFixed(0)} MB limit — connector extraction also failed: ${r.reason}`,
      }
    }
    return {
      status: 'skipped', tooLarge: true,
      reason: `${mb(size)} MB, over the ${(MAX_INDEX_BYTES / 1_048_576).toFixed(0)} MB limit (RAG_MAX_FILE_MB)`,
    }
  }

  let outcome: IndexOutcome
  try {
    const bytes = await nasFetchBytesStrict(server, path, MAX_INDEX_BYTES)
    outcome = await indexer(organizationId, server, path, bytes)
  } catch (e) {
    if (e instanceof FileTooLargeError) return { status: 'skipped', tooLarge: true, reason: e.message }
    return { status: 'failed', reason: e instanceof Error ? e.message : 'download failed' }
  }

  // A PDF this server could not read (scanned, or rejected by pdf.js): the
  // indexer already recorded FAILED. Ask the connector; success overwrites
  // that row with INDEXED.
  if (outcome.status === 'failed' && outcome.connector && isPdf(path)) {
    const r = await viaConnector()
    if (r.ok) return r.outcome
    return { status: 'failed', reason: `${outcome.reason}; the connector could not read it either: ${r.reason}` }
  }
  return outcome
}
