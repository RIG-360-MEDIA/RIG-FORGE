/**
 * Ingestion orchestration for the Trijya bylaws RAG — deliberately separate
 * from lib/rag/index-nas-file.ts (own Qdrant collection, own tracking table).
 * Mirrors that file's logic; kept as its own module rather than a shared
 * generic so the bylaws pipeline can diverge later (e.g. different chunk
 * size for legal clauses) without touching the general NAS indexer.
 */
import { createHash } from 'crypto'

import { prisma } from '@/lib/db'
import { extractText, isExtractable } from '@/lib/nas/extract'
import { chunkText } from './chunk'
import { embedTexts, isEmbeddingConfigured } from './embeddings'
import { deleteFileChunks, isQdrantConfigured, upsertChunks, BYLAWS_COLLECTION } from './qdrant'

export function isBylawsIndexingEnabled(): boolean {
  return isEmbeddingConfigured() && isQdrantConfigured()
}

function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() || path
}

/** Index (or re-index) one bylaws file. See indexNasFile in index-nas-file.ts
 * for the annotated version of this same flow — kept in sync deliberately. */
export async function indexBylawsFile(
  organizationId: string,
  server: string,
  path: string,
  bytes: Buffer,
): Promise<void> {
  if (!isBylawsIndexingEnabled()) return
  if (!isExtractable(fileName(path))) return

  const name = fileName(path)
  try {
    const text = await extractText(name, bytes)
    const contentHash = createHash('sha256').update(text).digest('hex')

    const existing = await prisma.bylawsIndexedFile.findUnique({
      where: { organizationId_server_path: { organizationId, server, path } },
    })
    if (existing?.status === 'INDEXED' && existing.contentHash === contentHash) return // unchanged

    const chunks = chunkText(text)
    if (chunks.length === 0) {
      if (existing) await deleteFileChunks(organizationId, server, path, BYLAWS_COLLECTION)
      await prisma.bylawsIndexedFile.upsert({
        where: { organizationId_server_path: { organizationId, server, path } },
        create: { organizationId, server, path, contentHash, chunkCount: 0, status: 'INDEXED', indexedAt: new Date() },
        update: { contentHash, chunkCount: 0, status: 'INDEXED', indexedAt: new Date(), error: null },
      })
      return
    }

    const vectors = await embedTexts(chunks.map((c) => c.text))
    await deleteFileChunks(organizationId, server, path, BYLAWS_COLLECTION)
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
      BYLAWS_COLLECTION,
    )

    await prisma.bylawsIndexedFile.upsert({
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
    await prisma.bylawsIndexedFile
      .upsert({
        where: { organizationId_server_path: { organizationId, server, path } },
        create: { organizationId, server, path, contentHash: '', chunkCount: 0, status: 'FAILED', error: message },
        update: { status: 'FAILED', error: message },
      })
      .catch(() => {}) // best-effort status write — never throw out of ingestion
  }
}
