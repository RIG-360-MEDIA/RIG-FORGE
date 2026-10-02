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
import { indexFile, type IndexOutcome, type Tracker } from './index-core'

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
 */
export function indexNasFile(
  organizationId: string,
  server: string,
  path: string,
  bytes: Buffer,
): Promise<IndexOutcome> {
  return indexFile({
    organizationId, server, path, bytes,
    collection: COLLECTION, tracker, enabled: isRagIndexingEnabled(),
  })
}
