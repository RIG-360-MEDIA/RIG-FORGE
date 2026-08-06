/**
 * Qdrant wrapper for the NAS RAG chunk index. One collection, multi-tenant via
 * an `organizationId` payload field filtered on every query — mirrors the
 * org-scoping pattern lib/db.ts enforces for Postgres, since Qdrant has no
 * equivalent of that Prisma extension to fall back on.
 */
import { createHash } from 'crypto'
import { QdrantClient } from '@qdrant/js-client-rest'

import { EMBEDDING_DIM } from './embeddings'

const QDRANT_URL = process.env.QDRANT_URL?.trim()
const QDRANT_API_KEY = process.env.QDRANT_API_KEY?.trim()
export const COLLECTION = process.env.QDRANT_COLLECTION?.trim() || 'nas_documents'

export function isQdrantConfigured(): boolean {
  return !!QDRANT_URL
}

let client: QdrantClient | null = null
function getClient(): QdrantClient {
  if (!QDRANT_URL) throw new Error('QDRANT_URL is not configured')
  if (!client) client = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY })
  return client
}

let collectionReady: Promise<void> | null = null
export function ensureCollection(): Promise<void> {
  if (!collectionReady) {
    collectionReady = (async () => {
      const c = getClient()
      const { exists } = await c.collectionExists(COLLECTION)
      if (!exists) {
        await c.createCollection(COLLECTION, {
          vectors: { size: EMBEDDING_DIM, distance: 'Cosine' },
        })
      }
    })().catch((e) => {
      collectionReady = null // allow retry on next call
      throw e
    })
  }
  return collectionReady
}

/** Deterministic point id so re-indexing the same chunk overwrites in place. */
function pointId(organizationId: string, server: string, path: string, chunkIndex: number): string {
  const hash = createHash('sha256').update(`${organizationId}:${server}:${path}:${chunkIndex}`).digest('hex')
  return [hash.slice(0, 8), hash.slice(8, 12), hash.slice(12, 16), hash.slice(16, 20), hash.slice(20, 32)].join('-')
}

export interface ChunkPayload {
  organizationId: string
  server: string
  path: string
  fileName: string
  chunkIndex: number
  text: string
}

export async function upsertChunks(chunks: Array<ChunkPayload & { vector: number[] }>): Promise<void> {
  if (chunks.length === 0) return
  await ensureCollection()
  const c = getClient()
  await c.upsert(COLLECTION, {
    wait: true,
    points: chunks.map((chunk) => ({
      id: pointId(chunk.organizationId, chunk.server, chunk.path, chunk.chunkIndex),
      vector: chunk.vector,
      payload: {
        organizationId: chunk.organizationId,
        server: chunk.server,
        path: chunk.path,
        fileName: chunk.fileName,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
      },
    })),
  })
}

/** Delete every indexed chunk for a file — call before re-upserting so a
 * shrunk file doesn't leave orphaned chunks from its previous, longer version. */
export async function deleteFileChunks(organizationId: string, server: string, path: string): Promise<void> {
  await ensureCollection()
  const c = getClient()
  await c.delete(COLLECTION, {
    wait: true,
    filter: {
      must: [
        { key: 'organizationId', match: { value: organizationId } },
        { key: 'server', match: { value: server } },
        { key: 'path', match: { value: path } },
      ],
    },
  })
}

export interface ChunkSearchHit extends ChunkPayload {
  score: number
}

export async function searchChunks(organizationId: string, vector: number[], limit = 8): Promise<ChunkSearchHit[]> {
  await ensureCollection()
  const c = getClient()
  const res = await c.search(COLLECTION, {
    vector,
    limit,
    filter: { must: [{ key: 'organizationId', match: { value: organizationId } }] },
    with_payload: true,
  })
  return res.map((r) => ({ ...(r.payload as unknown as ChunkPayload), score: r.score }))
}
