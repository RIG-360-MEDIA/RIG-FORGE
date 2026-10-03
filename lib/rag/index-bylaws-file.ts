/**
 * Ingestion for the Trijya bylaws RAG — a separate pipeline from the general
 * NAS index (own Qdrant collection, own tracking table) so bylaws answers are
 * never diluted by unrelated drawings and specs.
 *
 * Shares its flow with the general indexer via ./index-core.ts; the separation
 * is in WHERE results are stored, not in a second copy of the logic.
 */
import { prisma } from '@/lib/db'
import { isEmbeddingConfigured } from './embeddings'
import { isQdrantConfigured, BYLAWS_COLLECTION } from './qdrant'
import { indexFile, type IndexOutcome, type PreExtracted, type Tracker } from './index-core'

export function isBylawsIndexingEnabled(): boolean {
  return isEmbeddingConfigured() && isQdrantConfigured()
}

const tracker: Tracker = {
  find: (key) =>
    prisma.bylawsIndexedFile.findUnique({
      where: { organizationId_server_path: key },
      select: { status: true, contentHash: true },
    }),
  save: async (key, data) => {
    await prisma.bylawsIndexedFile.upsert({
      where: { organizationId_server_path: key },
      create: { ...key, ...data },
      update: data,
    })
  },
}

/** Index (or re-index) one bylaws file. Returns what happened, so callers such
 * as the backfill route can report real outcomes instead of assuming success.
 * Pass `preExtracted` instead of `bytes` for a file whose text was already
 * pulled on the NAS connector (large or scanned PDFs — see nasExtractText). */
export function indexBylawsFile(
  organizationId: string,
  server: string,
  path: string,
  bytesOrText: Buffer | PreExtracted,
): Promise<IndexOutcome> {
  const isPreExtracted = !Buffer.isBuffer(bytesOrText)
  return indexFile({
    organizationId, server, path,
    bytes: isPreExtracted ? undefined : bytesOrText,
    preExtracted: isPreExtracted ? bytesOrText : undefined,
    collection: BYLAWS_COLLECTION, tracker, enabled: isBylawsIndexingEnabled(),
  })
}
