/**
 * Ingestion orchestration: NAS file → extracted text → chunks → embeddings →
 * Qdrant. Called after a successful NAS upload (see app/api/nas/upload) and
 * safe to call again later for a re-index. Silently no-ops when RAG isn't
 * configured (HF_API_KEY / QDRANT_URL unset) so it never blocks an upload.
 */
import { createHash } from 'crypto'

import { prisma } from '@/lib/db'
import { extractText, isExtractable } from '@/lib/nas/extract'
import { chunkText } from './chunk'
import { embedTexts, isEmbeddingConfigured } from './embeddings'
import { deleteFileChunks, isQdrantConfigured, upsertChunks } from './qdrant'

export function isRagIndexingEnabled(): boolean {
  return isEmbeddingConfigured() && isQdrantConfigured()
}

function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() || path
}

/**
 * Index (or re-index) one NAS file for semantic search. `organizationId` must
 * be passed explicitly rather than read from AsyncLocalStorage — this can run
 * detached from the request that triggered it (see fire-and-forget call site).
 */
export async function indexNasFile(
  organizationId: string,
  server: string,

  
  path: string,
  bytes: Buffer,
): Promise<void> {
  if (!isRagIndexingEnabled()) return
  if (!isExtractable(fileName(path))) return

  const name = fileName(path)
  try {
    const text = await extractText(name, bytes)
    const contentHash = createHash('sha256').update(text).digest('hex')

    const existing = await prisma.nasIndexedFile.findUnique({
      where: { organizationId_server_path: { organizationId, server, path } },
    })
    if (existing?.status === 'INDEXED' && existing.contentHash === contentHash) return // unchanged

    const chunks = chunkText(text)
    if (chunks.length === 0) {
      // Text shrank to nothing (e.g. file edited to empty) — clear any chunks
      // left over from a previous, non-empty version so stale content doesn't
      // stay searchable.
      if (existing) await deleteFileChunks(organizationId, server, path)
      await prisma.nasIndexedFile.upsert({
        where: { organizationId_server_path: { organizationId, server, path } },
        create: { organizationId, server, path, contentHash, chunkCount: 0, status: 'INDEXED', indexedAt: new Date() },
        update: { contentHash, chunkCount: 0, status: 'INDEXED', indexedAt: new Date(), error: null },
      })
      return
    }

    const vectors = await embedTexts(chunks.map((c) => c.text))
    await deleteFileChunks(organizationId, server, path)
    await upsertChunks(
      chunks.map((c, i) => ({
        organizationId,
        server,
        path,
        fileName: name,
        chunkIndex: c.index,
        text: c.text,
        vector: vectors[i]!,
      })),
    )

    await prisma.nasIndexedFile.upsert({
      where: { organizationId_server_path: { organizationId, server, path } },
      create: {
        organizationId, server, path, contentHash,
        chunkCount: chunks.length, status: 'INDEXED', indexedAt: new Date(),
      },
      update: {
        contentHash, chunkCount: chunks.length, status: 'INDEXED', indexedAt: new Date(), error: null,
      },
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'indexing failed'
    await prisma.nasIndexedFile
      .upsert({
        where: { organizationId_server_path: { organizationId, server, path } },
        create: { organizationId, server, path, contentHash: '', chunkCount: 0, status: 'FAILED', error: message },
        update: { status: 'FAILED', error: message },
      })
      .catch(() => {}) // best-effort status write — never throw out of ingestion
  }
}
