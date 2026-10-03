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
      // Payload indexes on every field we filter by. Without them every
      // filtered search and delete is a scan of the whole collection, and
      // filtered vector search can return fewer results than asked for. The
      // chunkIndex range index is also what makes pruneStaleChunks efficient.
      // Idempotent: creating an index that already exists is harmless, so this
      // also upgrades collections created before these were added.
      await Promise.all([
        c.createPayloadIndex(collection, { field_name: 'organizationId', field_schema: 'keyword', wait: true }),
        c.createPayloadIndex(collection, { field_name: 'server', field_schema: 'keyword', wait: true }),
        c.createPayloadIndex(collection, { field_name: 'path', field_schema: 'keyword', wait: true }),
        c.createPayloadIndex(collection, { field_name: 'chunkIndex', field_schema: 'integer', wait: true }),
      ].map((p) => p.catch(() => {})))
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

/**
 * Delete chunks left over from a LONGER previous version of a file: everything
 * with chunkIndex >= keepCount.
 *
 * Replaces the old delete-everything-then-upsert sequence, which had two
 * problems: if the upsert failed after the delete, the file's chunks were gone
 * for good; and between the two calls the file was briefly unsearchable.
 * Point ids are deterministic per (org, server, path, chunkIndex), so upserting
 * the new chunks overwrites the old ones in place — only the tail beyond the
 * new length needs removing, and that is done AFTER the upsert succeeds.
 */
export async function pruneStaleChunks(
  organizationId: string,
  server: string,
  path: string,
  keepCount: number,
  collection: string = COLLECTION,
): Promise<void> {
  await ensureCollection(collection)
  await getClient().delete(collection, {
    wait: true,
    filter: {
      must: [
        { key: 'organizationId', match: { value: organizationId } },
        { key: 'server', match: { value: server } },
        { key: 'path', match: { value: path } },
        { key: 'chunkIndex', range: { gte: keepCount } },
      ],
    },
  })
}

export interface ChunkSearchHit extends ChunkPayload {
  score: number
}

/**
 * Minimum cosine similarity for a passage to be returned at all. Without one,
 * search always returns `limit` passages however unrelated, and the assistant
 * will confidently cite irrelevant text.
 *
 * Calibrated on 2026-10-02 against real bge-small-en-v1.5 embeddings using
 * bylaw-style passages: at 0.50, 9 of 9 relevant passages were kept and 10 of
 * 12 irrelevant ones dropped; at 0.55 relevant answers start being lost. This
 * model's relevant and irrelevant score ranges OVERLAP, so this is a junk
 * filter, not a guarantee — it removes the clearly unrelated tail.
 * Re-calibrate if HF_EMBEDDING_MODEL changes.
 */
const MIN_SCORE = Number(process.env.RAG_MIN_SCORE ?? 0.5)

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
    score_threshold: MIN_SCORE,
  })
  return res.map((r) => ({ ...(r.payload as unknown as ChunkPayload), score: r.score }))
}

export interface HybridChunkSearchHit extends ChunkSearchHit {
  matchType: 'vector' | 'hybrid'
}

/** How much a keyword match can boost a passage's rank, relative to cosine
 * score (both roughly 0-1 scale). Additive re-rank, not a replacement for
 * the vector score — see searchChunksHybrid. */
const KEYWORD_BOOST_WEIGHT = Number(process.env.RAG_KEYWORD_BOOST_WEIGHT ?? 0.15)

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'what', 'how', 'must', 'shall'])

function keywordTokens(text: string): string[] {
  return Array.from(new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])).filter((t) => t.length > 2 && !STOPWORDS.has(t))
}

/**
 * Pure re-ranking step, split out from searchChunksHybrid so it's testable
 * on a synthetic candidate array without a live Qdrant (see scripts/test-rag.ts).
 * Boosts candidates sharing query keywords, re-sorts, truncates to `limit`.
 */
export function rerankByKeyword<T extends { score: number; text: string }>(
  candidates: T[],
  queryText: string,
  limit: number,
): Array<T & { matchType: 'vector' | 'hybrid' }> {
  const queryTokens = keywordTokens(queryText)
  if (queryTokens.length === 0 || candidates.length === 0) {
    return candidates.slice(0, limit).map((c) => ({ ...c, matchType: 'vector' as const }))
  }

  const scored = candidates.map((c) => {
    const haystack = c.text.toLowerCase()
    const matched = queryTokens.filter((t) => haystack.includes(t)).length
    const keywordScore = matched / queryTokens.length
    return { hit: c, keywordScore, combined: c.score + KEYWORD_BOOST_WEIGHT * keywordScore }
  })
  scored.sort((a, b) => b.combined - a.combined)

  return scored.slice(0, limit).map((s) => ({ ...s.hit, matchType: s.keywordScore > 0 ? ('hybrid' as const) : ('vector' as const) }))
}

/**
 * Vector search, then re-ranked with a keyword-overlap boost.
 *
 * Qdrant's MatchText filter is a boolean AND-gate, not a blended score, and
 * genuine fused ranking (sparse + dense vectors, RRF) needs new point fields
 * and a BM25 embedder — a real re-index, not a tweak. This is the lighter
 * fix for the documented problem (paraphrases ranking below exact-keyword
 * near-misses, since bge-small-en-v1.5's relevant/irrelevant score ranges
 * overlap): fetch a larger vector-scored candidate pool (still MIN_SCORE-
 * filtered — that junk filter is unchanged), boost candidates that share
 * query keywords, re-sort, and return `limit`.
 */
export async function searchChunksHybrid(
  organizationId: string,
  vector: number[],
  queryText: string,
  limit = 8,
  collection: string = COLLECTION,
): Promise<HybridChunkSearchHit[]> {
  const candidates = await searchChunks(organizationId, vector, limit * 4, collection)
  return rerankByKeyword(candidates, queryText, limit)
}
