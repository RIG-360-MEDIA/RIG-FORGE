/**
 * Qdrant wrapper for RAG chunk indices. Multi-tenant via an `organizationId`
 * payload field filtered on every query — mirrors the org-scoping pattern
 * lib/db.ts enforces for Postgres, since Qdrant has no equivalent of that
 * Prisma extension to fall back on.
 *
 * Supports multiple independent collections (e.g. the general NAS index and
 * the separate Trijya bylaws index) — every function takes an optional
 * `collection` override and defaults to the general-purpose one.
 */
import { createHash } from 'crypto'
import { QdrantClient } from '@qdrant/js-client-rest'

import { EMBEDDING_DIM } from './embeddings'

const QDRANT_URL = process.env.QDRANT_URL?.trim()
const QDRANT_API_KEY = process.env.QDRANT_API_KEY?.trim() || undefined // "" (local/no-auth) must not become a real header
export const COLLECTION = process.env.QDRANT_COLLECTION?.trim() || 'nas_documents'
export const BYLAWS_COLLECTION = process.env.QDRANT_BYLAWS_COLLECTION?.trim() || 'trijya_bylaws'

export function isQdrantConfigured(): boolean {
  return !!QDRANT_URL
}

let client: QdrantClient | null = null
function getClient(): QdrantClient {
  if (!QDRANT_URL) throw new Error('QDRANT_URL is not configured')
  if (!client) {
    // The client defaults to :6333 whenever the URL string has no explicit
    // port — wrong for Qdrant Cloud, whose cluster URLs serve HTTPS on the
    // implicit 443 and have no port in them. Passing `port: null` here
    // (distinct from omitting it, which falls back to the 6333 default)
    // stops it from appending one.
    const port = new URL(QDRANT_URL).port ? undefined : null
    client = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY, port })
  }
  return client
}

const collectionReady = new Map<string, Promise<void>>()
export function ensureCollection(collection: string = COLLECTION): Promise<void> {
  let ready = collectionReady.get(collection)
  if (!ready) {
    ready = (async () => {
      const c = getClient()
      const { exists } = await c.collectionExists(collection)
      if (!exists) {
        await c.createCollection(collection, {
          vectors: { size: EMBEDDING_DIM, distance: 'Cosine' },
        })
      }
    })().catch((e) => {
      collectionReady.delete(collection) // allow retry on next call
      throw e
    })
    collectionReady.set(collection, ready)
  }
  return ready
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

export async function upsertChunks(
  chunks: Array<ChunkPayload & { vector: number[] }>,
  collection: string = COLLECTION,
): Promise<void> {
  if (chunks.length === 0) return
  await ensureCollection(collection)
  const c = getClient()
  await c.upsert(collection, {
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
export async function deleteFileChunks(
  organizationId: string,
  server: string,
  path: string,
  collection: string = COLLECTION,
): Promise<void> {
  await ensureCollection(collection)
  const c = getClient()
  await c.delete(collection, {
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

export async function searchChunks(
  organizationId: string,
  vector: number[],
  limit = 8,
  collection: string = COLLECTION,
): Promise<ChunkSearchHit[]> {
  await ensureCollection(collection)
  const c = getClient()
  const res = await c.search(collection, {
    vector,
    limit,
    filter: { must: [{ key: 'organizationId', match: { value: organizationId } }] },
    with_payload: true,
  })
  return res.map((r) => ({ ...(r.payload as unknown as ChunkPayload), score: r.score }))
}
