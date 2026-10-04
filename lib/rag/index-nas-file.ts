/**
 * General NAS content indexing: file → text → chunks → embeddings → Qdrant.
 * Called after a successful NAS upload (see app/api/nas/upload) and safe to call
 * again later for a re-index. No-ops when RAG isn't configured (HF_API_KEY /
 * QDRANT_URL unset) so it never blocks an upload.
 *
 * The flow itself lives in ./index-core.ts, shared with the bylaws pipeline.
 */
import { prisma } from '@/lib/db'
import { isEmbeddingConfigured } from './embeddings'
import { isQdrantConfigured, COLLECTION } from './qdrant'
import { indexFile, type IndexOutcome, type PreExtracted, type Tracker } from './index-core'

export function isRagIndexingEnabled(): boolean {
  return isEmbeddingConfigured() && isQdrantConfigured()
}

const tracker: Tracker = {
  find: (key) =>
    prisma.nasIndexedFile.findUnique({
      where: { organizationId_server_path: key },
      select: { status: true, contentHash: true },
    }),
  save: async (key, data) => {
    await prisma.nasIndexedFile.upsert({
      where: { organizationId_server_path: key },
      create: { ...key, ...data },
      update: data,
    })
  },
}

/**
 * Index (or re-index) one NAS file for semantic search. `organizationId` must
 * be passed explicitly rather than read from AsyncLocalStorage — this can run
 * detached from the request that triggered it (see fire-and-forget call site).
 * Pass `preExtracted` instead of `bytes` for a file whose text was already
 * pulled on the NAS connector (large or scanned PDFs — see nasExtractText).
 */
export function indexNasFile(
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
    collection: COLLECTION, tracker, enabled: isRagIndexingEnabled(),
  })
}

/** Write a PENDING row before a fire-and-forget index kicks off, so a crash
 * mid-flight leaves a real row to retry instead of silence — see
 * app/api/cron/rag-retry/route.ts. */
export async function markNasPending(organizationId: string, server: string, path: string): Promise<void> {
  const key = { organizationId, server, path }
  await prisma.nasIndexedFile.upsert({
    where: { organizationId_server_path: key },
    create: { ...key, status: 'PENDING', contentHash: '' },
    // A fresh upload is about to re-index it: its old status is stale either
    // way, and it starts a new retry budget. contentHash is left alone on
    // purpose: index-core only trusts a hash on an INDEXED row, so a PENDING
    // row always re-embeds, never "unchanged" against half-written chunks.
    update: { status: 'PENDING', retryCount: 0, nextRetryAt: null },
  })
}
