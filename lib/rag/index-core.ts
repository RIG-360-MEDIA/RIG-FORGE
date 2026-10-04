/**
 * Shared ingestion core for BOTH RAG pipelines (general NAS + Trijya bylaws):
 * file bytes → text → chunks → embeddings → Qdrant, plus status tracking.
 *
 * The two pipelines were originally two copies of the same flow, "kept in sync
 * deliberately" by hand. Every fix below touches every step, so they now share
 * this one implementation and differ only in the collection and tracking table
 * passed in — which still lets the bylaws pipeline diverge later (e.g. its own
 * chunk size) through options rather than a second copy that can drift.
 */
import { createHash } from 'crypto'

import { extractForIndex, isExtractable, INDEX_MAX_TEXT } from '@/lib/nas/extract'
import { chunkText } from './chunk'
import { embedTexts } from './embeddings'
import { pruneStaleChunks, upsertChunks } from './qdrant'

/** Files larger than this are skipped (and recorded as FAILED with the reason)
 * instead of being parsed. render.yaml runs Forge on the FREE plan — 512 MB for
 * the whole app — and PDF parsing holds the file plus a multiple of it in
 * memory, so a large PDF could crash the server for every user. Raise this on
 * a bigger instance. */
export const MAX_INDEX_BYTES = Number(process.env.RAG_MAX_FILE_MB ?? 20) * 1_048_576

export type IndexOutcome =
  | { status: 'indexed'; chunks: number; warning?: string }
  | { status: 'unchanged' }
  | { status: 'skipped'; reason: string }
  /** `scanned`: the PDF has no text layer; worth sending to the connector for OCR. */
  | { status: 'failed'; reason: string; scanned?: true }

interface Key { organizationId: string; server: string; path: string }

/** Minimal tracking-table operations, implemented per pipeline. */
export interface Tracker {
  find(key: Key): Promise<{ status: string; contentHash: string } | null>
  save(key: Key, data: {
    status: 'INDEXED' | 'FAILED'
    contentHash: string
    chunkCount: number
    error: string | null
    indexedAt: Date | null
    /** Sent only with INDEXED: a success clears the retry backoff (see
     * app/api/cron/rag-retry). A failure leaves it to the retry route, which
     * owns the attempt count. */
    retryCount?: number
    nextRetryAt?: Date | null
  }): Promise<void>
}

/** Text already extracted elsewhere (the NAS connector, for a PDF too large
 * to fetch as raw bytes into Render's memory) — bypasses the byte-size check
 * and extractForIndex entirely. `method` records how it was obtained; "ocr"
 * surfaces as a tracker warning, same as the existing truncation warning. */
export interface PreExtracted {
  text: string
  truncated: boolean
  method: 'text' | 'ocr'
}

export interface IndexJob extends Key {
  bytes?: Buffer
  preExtracted?: PreExtracted
  collection: string
  tracker: Tracker
  enabled: boolean
}

function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() || path
}

export async function indexFile(job: IndexJob): Promise<IndexOutcome> {
  const { organizationId, server, path, bytes, preExtracted, collection, tracker } = job
  const key: Key = { organizationId, server, path }
  const name = fileName(path)

  if (!job.enabled) return { status: 'skipped', reason: 'content indexing is not configured' }
  if (!isExtractable(name)) return { status: 'skipped', reason: 'file type not supported for content indexing' }

  // Record a failure so it is VISIBLE in the tracking table. Previously some
  // failures were swallowed and others were stored as if they had succeeded.
  const fail = async (reason: string, contentHash = '', scanned = false): Promise<IndexOutcome> => {
    await tracker
      .save(key, { status: 'FAILED', contentHash, chunkCount: 0, error: reason.slice(0, 500), indexedAt: null })
      .catch(() => {}) // best-effort — never throw out of ingestion
    return scanned ? { status: 'failed', reason, scanned: true } : { status: 'failed', reason }
  }

  try {
    let extracted: { text: string; truncated: boolean }
    let ocrUsed = false

    if (preExtracted) {
      // Same cap as local extraction (RAG_MAX_TEXT_CHARS): text from the
      // connector must not bypass the bound on embedding time and cost.
      const over = preExtracted.text.length > INDEX_MAX_TEXT
      extracted = { text: over ? preExtracted.text.slice(0, INDEX_MAX_TEXT) : preExtracted.text, truncated: preExtracted.truncated || over }
      ocrUsed = preExtracted.method === 'ocr'
    } else {
      if (!bytes) return await fail('no file bytes or pre-extracted text provided')
      if (bytes.length > MAX_INDEX_BYTES) {
        return await fail(`file is ${(bytes.length / 1_048_576).toFixed(1)} MB, over the ${(MAX_INDEX_BYTES / 1_048_576).toFixed(0)} MB indexing limit`)
      }
      const result = await extractForIndex(name, bytes)
      if (!result.ok) {
        // The file as it is NOW cannot be read. Remove anything indexed from an
        // older, readable version so stale content stops being searchable.
        await pruneStaleChunks(organizationId, server, path, 0, collection).catch(() => {})
        return await fail(result.reason, '', result.scanned === true)
      }
      extracted = result
    }

    const contentHash = createHash('sha256').update(extracted.text).digest('hex')
    const existing = await tracker.find(key)
    if (existing?.status === 'INDEXED' && existing.contentHash === contentHash) return { status: 'unchanged' }

    const chunks = chunkText(extracted.text)
    const vectors = await embedTexts(chunks.map((c) => c.text))

    // Upsert FIRST: deterministic point ids mean the new chunks overwrite the
    // old ones in place. Only then trim the tail left by a longer old version.
    // (The old order — delete everything, then upsert — lost the file's chunks
    // entirely if the upsert failed, and left a window with nothing searchable.)
    await upsertChunks(
      chunks.map((c, i) => ({
        organizationId, server, path, fileName: name,
        chunkIndex: c.index, text: c.text, vector: vectors[i]!,
      })),
      collection,
    )
    await pruneStaleChunks(organizationId, server, path, chunks.length, collection)

    // A non-null `error` on an INDEXED row is a WARNING, used to make partial
    // indexing visible instead of silent — that silence is what hid the old
    // 12,000-character cap.
    const warnings: string[] = []
    if (extracted.truncated) warnings.push(`only the first ${extracted.text.length.toLocaleString('en-US')} characters were indexed (RAG_MAX_TEXT_CHARS)`)
    if (ocrUsed) warnings.push('text was recovered via OCR (connector) — may contain recognition errors')
    const warning = warnings.length ? warnings.join('; ') : undefined
    await tracker.save(key, {
      status: 'INDEXED', contentHash, chunkCount: chunks.length, error: warning ?? null, indexedAt: new Date(),
      retryCount: 0, nextRetryAt: null,
    })
    return { status: 'indexed', chunks: chunks.length, ...(warning && { warning }) }
  } catch (e) {
    return await fail(e instanceof Error ? e.message : 'indexing failed')
  }
}
