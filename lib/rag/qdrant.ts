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

import { cleanPassage } from './chunk'
import { EMBEDDING_DIM, embedQuery } from './embeddings'
import { analyzeQuery, describeConstraints, documentPriority, isConstrained, matchPassage, mightMatch, rank, type QueryConstraints } from './query-match'

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
    const u = new URL(QDRANT_URL)
    const port = u.port ? undefined : null
    // Qdrant can also be the one on TRIJYA-3, reached through the NAS
    // connector (QDRANT_URL=https://<nas host>/qdrant). Then the path is the
    // client's prefix, and the request must carry the same Cloudflare Access
    // service token as every other connector call, or Cloudflare rejects it.
    const prefix = u.pathname.replace(/\/+$/, '') || undefined
    const nasHost = (() => { try { return new URL(process.env.TRIJYA_NAS_BASE_URL ?? '').host } catch { return '' } })()
    const cfId = process.env.CF_ACCESS_CLIENT_ID, cfSecret = process.env.CF_ACCESS_CLIENT_SECRET
    const headers = u.host === nasHost && cfId && cfSecret
      ? { 'CF-Access-Client-Id': cfId, 'CF-Access-Client-Secret': cfSecret }
      : undefined
    client = new QdrantClient({
      url: `${u.protocol}//${u.host}`, apiKey: QDRANT_API_KEY, port, prefix, headers,
      // The version handshake is one more round trip on every cold start, and
      // its only effect is a console warning.
      checkCompatibility: false,
    })
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

/** Qdrant answers 404 when the collection itself does not exist. */
function isMissingCollection(e: unknown): boolean {
  return (e as { status?: number } | null)?.status === 404
}

/**
 * Run an operation against a collection, recreating the collection once if it
 * vanished while the app was running. ensureCollection() remembers a collection
 * it has set up, so without this a collection dropped by hand, or wiped when a
 * free Qdrant Cloud cluster is reset after inactivity, made every index and
 * search fail with "Not Found" until the server restarted.
 */
async function withCollection<T>(collection: string, op: () => Promise<T>): Promise<T> {
  await ensureCollection(collection)
  try {
    return await op()
  } catch (e) {
    if (!isMissingCollection(e)) throw e
    collectionReady.delete(collection)
    await ensureCollection(collection)
    return op()
  }
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

/** Points per upsert request. Qdrant rejects a request body over 32 MB; at
 * 384 dims plus ~1.2 KB of text a point is ~5 KB of JSON, so a whole large
 * document (5,000+ chunks) in one request gets close to that. 256 points is
 * ~1.3 MB, comfortably under it at any dimension we use (1024 for e5-large). */
const UPSERT_BATCH = 256

export async function upsertChunks(
  chunks: Array<ChunkPayload & { vector: number[] }>,
  collection: string = COLLECTION,
): Promise<void> {
  // In order, one batch at a time. Point ids are deterministic, so if a later
  // batch fails, re-indexing the file simply overwrites what was written.
  for (let i = 0; i < chunks.length; i += UPSERT_BATCH) {
    const batch = chunks.slice(i, i + UPSERT_BATCH)
    await withCollection(collection, () => getClient().upsert(collection, {
      wait: true,
      points: batch.map((chunk) => ({
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
    }))
  }
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
  await withCollection(collection, () => getClient().delete(collection, {
    wait: true,
    filter: {
      must: [
        { key: 'organizationId', match: { value: organizationId } },
        { key: 'server', match: { value: server } },
        { key: 'path', match: { value: path } },
        { key: 'chunkIndex', range: { gte: keepCount } },
      ],
    },
  }))
}

/**
 * One passage, by where it is: (server, path, chunkIndex). Point ids are
 * deterministic, so this is a single lookup. The id includes the
 * organisation, and the payload's organisation is checked again, so a
 * passage of another organisation is never returned. Null when not indexed.
 */
export async function getPassage(
  organizationId: string,
  server: string,
  path: string,
  chunkIndex: number,
  collection: string = COLLECTION,
): Promise<ChunkPayload | null> {
  const pts = await withCollection(collection, () => getClient().retrieve(collection, {
    ids: [pointId(organizationId, server, path, chunkIndex)],
    with_payload: true,
    with_vector: false,
  }))
  const pl = pts[0]?.payload as unknown as ChunkPayload | undefined
  if (!pl || pl.organizationId !== organizationId) return null
  return { ...pl, text: cleanPassage(pl.text ?? '') }
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
 *
 * multilingual-e5-large (set RAG_MIN_SCORE=0.82 on Render), calibrated on
 * 14 Oct 2026 against trijya_bylaws_e5 after near-empty chunks were removed,
 * with 22 relevant and 18 irrelevant English/Hindi queries. Top-1 scores:
 * relevant 0.843-0.900 (English) and 0.838-0.890 (Hindi); irrelevant
 * 0.732-0.831. At 0.82, 16 of 18 irrelevant queries return nothing and every
 * relevant one keeps at least 6 of 8 hits; 0.83 cuts relevant queries down
 * to 3 hits, and at 0.84 one Hindi query returns nothing.
 */
const MIN_SCORE = Number(process.env.RAG_MIN_SCORE ?? 0.5)

export async function searchChunks(
  organizationId: string,
  vector: number[],
  limit = 8,
  collection: string = COLLECTION,
  minScore: number = MIN_SCORE,
): Promise<ChunkSearchHit[]> {
  const res = await withCollection(collection, () => getClient().search(collection, {
    vector,
    limit,
    filter: { must: [{ key: 'organizationId', match: { value: organizationId } }] },
    with_payload: true,
    score_threshold: minScore,
  }))
  return res.map((r) => {
    const p = r.payload as unknown as ChunkPayload
    return { ...p, text: cleanPassage(p.text ?? ''), score: r.score }
  })
}

export interface HybridChunkSearchHit extends ChunkSearchHit {
  matchType: 'vector' | 'hybrid'
}

/** How much a keyword match can boost a passage's rank, relative to cosine
 * score (both roughly 0-1 scale). Additive re-rank, not a replacement for
 * the vector score — see searchChunksHybrid. */
const KEYWORD_BOOST_WEIGHT = Number(process.env.RAG_KEYWORD_BOOST_WEIGHT ?? 0.15)

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'what', 'how', 'must', 'shall',
  // Common Hindi function words long enough to pass the length filter.
  'लिए', 'होगा', 'होगी', 'होंगे', 'करना', 'किया', 'गया', 'कितनी', 'कितना', 'क्या', 'कैसे', 'चाहिए', 'वाले', 'वाली',
])

/** Lower-cased, Unicode-normalised text. Comparing NFC on both sides keeps a
 * Devanagari word typed one way matching the same word stored another way. */
const fold = (text: string) => text.normalize('NFC').toLowerCase()

/** Word tokens in any script. Letters (\p{L}), combining marks (\p{M}, e.g.
 * Devanagari vowel signs, without which Hindi words split mid-word) and
 * digits. The old /[a-z0-9]+/ dropped every Hindi word, so a Hindi query
 * never got a keyword boost. */
function keywordTokens(text: string): string[] {
  return Array.from(new Set(fold(text).match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])).filter((t) => t.length > 2 && !STOPWORDS.has(t))
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
    const haystack = fold(c.text)
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

export interface ConstrainedSearchHit extends HybridChunkSearchHit {
  /** The table row / figure that made the passage apply (e.g. "> 1200 ... 1.25 2.0"). */
  matchedRow?: string
  /** The clause the row is in, e.g. "3.2.4.1 Residential – Plotted Development". */
  section?: string
  /** The row read against its column labels, e.g. "Front 3 m, Rear 1.5 m, Side-1 0 m, Side-2 0 m". */
  values?: string
}

export interface ConstrainedSearchResult {
  hits: ConstrainedSearchHit[]
  constraints: QueryConstraints
  /** False when no passage met every part of the question: `hits` are then
   * the closest passages by meaning, and the caller must say so. */
  allMatched: boolean
}

/** How far below MIN_SCORE the candidate pool reaches when the question is
 * constrained. The topic + area checks are a much stronger relevance test
 * than the score floor, and the passage that actually applies (a table row)
 * often scores a little lower than prose that merely talks about the topic. */
const CONSTRAINED_POOL_MARGIN = Number(process.env.RAG_CONSTRAINED_MARGIN ?? 0.04)
const CONSTRAINED_POOL_SIZE = 200

/** Passages read before a hit for its table's heading. Two: a long table
 * (setbacks by building height runs over three passages) has its heading two
 * passages up. */
const CONTEXT_PASSAGES = 2
/** Hits (best first) whose NEXT passage is also read: a table that starts
 * in a hit often has the asked row in the next passage ("Office Buildings"
 * in the parking table), which may not score into the pool itself. */
const FOLLOWING_FOR_TOP = 60

const passageKey = (server: string, path: string, chunkIndex: number) => `${server}\u0000${path}\u0000${chunkIndex}`

/**
 * The passages around each hit in the same document. A table often starts
 * in one passage and continues in the next; its heading (which use, which
 * topic, which column holds the plot area) is then only in an earlier one,
 * and its other rows in a later one. Point ids are deterministic, so they
 * are fetched by id in one request (an id past the end of a document simply
 * returns nothing). Best effort: on failure hits are matched on their own text.
 */
async function neighbourPassages(
  organizationId: string,
  hits: ChunkSearchHit[],
  collection: string,
): Promise<Map<string, ChunkPayload>> {
  const out = new Map<string, ChunkPayload>()
  const ids = new Set<string>()
  hits.forEach((h, i) => {
    for (let b = 1; b <= CONTEXT_PASSAGES && h.chunkIndex - b >= 0; b++) ids.add(pointId(organizationId, h.server, h.path, h.chunkIndex - b))
    if (i < FOLLOWING_FOR_TOP) ids.add(pointId(organizationId, h.server, h.path, h.chunkIndex + 1))
  })
  if (!ids.size) return out
  try {
    const pts = await withCollection(collection, () => getClient().retrieve(collection, { ids: [...ids], with_payload: true, with_vector: false }))
    for (const p of pts) {
      const pl = p.payload as unknown as ChunkPayload
      out.set(passageKey(pl.server, pl.path, pl.chunkIndex), { ...pl, text: cleanPassage(pl.text ?? '') })
    }
  } catch (e) {
    console.warn('[rag] previous passages not fetched:', (e as Error).message)
  }
  return out
}

/**
 * Search where every part of the question must hold for the SAME table row:
 * the regulation topics it names (FAR, setback, ...), the use (residential,
 * commercial, ...) and the plot area / building height / road width it gives.
 * See lib/rag/query-match.ts. Questions without such parts behave exactly like
 * searchChunksHybrid.
 */
export async function searchChunksConstrained(
  organizationId: string,
  vector: number[],
  queryText: string,
  limit = 8,
  collection: string = COLLECTION,
): Promise<ConstrainedSearchResult> {
  const constraints = analyzeQuery(queryText)
  if (!isConstrained(constraints)) {
    return { hits: await searchChunksHybrid(organizationId, vector, queryText, limit, collection), constraints, allMatched: true }
  }
  let pool = await searchChunks(organizationId, vector, CONSTRAINED_POOL_SIZE, collection, MIN_SCORE - CONSTRAINED_POOL_MARGIN)
  // A question in Hindi scores English table passages lower than Hindi
  // prose, so the English tables that answer it can miss the pool. Search
  // again with the same parts in English ("FAR for a 500 sq m plot") and
  // merge, keeping each passage's better score.
  if (/\p{Script=Devanagari}/u.test(queryText)) {
    try {
      const english = await embedQuery(describeConstraints(constraints))
      const more = await searchChunks(organizationId, english, CONSTRAINED_POOL_SIZE, collection, MIN_SCORE - CONSTRAINED_POOL_MARGIN)
      const byKey = new Map(pool.map((h) => [passageKey(h.server, h.path, h.chunkIndex), h]))
      for (const h of more) {
        const k = passageKey(h.server, h.path, h.chunkIndex)
        const had = byKey.get(k)
        if (!had || had.score < h.score) byKey.set(k, h)
      }
      pool = [...byKey.values()].sort((a, b) => b.score - a.score)
    } catch (e) {
      console.warn('[rag] English re-search failed:', (e as Error).message)
    }
  }
  const candidates = pool.filter((h) => mightMatch(h.text, constraints))
  const around = await neighbourPassages(organizationId, candidates, collection)
  const passing: Array<ChunkSearchHit & { order: number; tieBreak: number; matchedRow?: string; section?: string; values?: string }> = []
  for (const hit of candidates) {
    const prev: ChunkPayload[] = []
    for (let b = CONTEXT_PASSAGES; b >= 1; b--) {
      const p = around.get(passageKey(hit.server, hit.path, hit.chunkIndex - b))
      if (p) prev.push(p)
    }
    const next = around.get(passageKey(hit.server, hit.path, hit.chunkIndex + 1))
    const m = matchPassage(hit.text, constraints, prev.map((p) => p.text), next?.text ?? '')
    if (!m) continue
    // The row is in another passage of the same table: show that passage,
    // which has the row, with this hit's score.
    const shown = !m.shift ? hit : m.shift > 0 ? next ?? hit : prev[prev.length + m.shift] ?? hit
    passing.push({ ...hit, ...shown, score: hit.score, order: rank(m), tieBreak: m.tieBreak ?? 0, matchedRow: m.row, section: m.section, values: m.values })
  }
  if (passing.length > 0) {
    // The best kind of match first (the asked use, then an exact table row,
    // then a residential table when no use was asked), then meaning + keywords.
    const ranked = rerankByKeyword(passing, queryText, passing.length)
    ranked.sort((a, b) => b.order - a.order || documentPriority(b.fileName) - documentPriority(a.fileName) || a.tieBreak - b.tieBreak)
    // The same row is often in two passages (overlap, or a table split
    // across them): show it once.
    const seen = new Set<string>()
    const unique = ranked.filter((h) => {
      const key = h.matchedRow ? `${h.fileName}\u0000${h.matchedRow.replace(/\s+/g, ' ').toLowerCase()}` : `${h.path}\u0000${h.chunkIndex}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return {
      hits: unique.slice(0, limit).map(({ order: _o, tieBreak: _t, ...h }) => ({ ...h, matchType: 'hybrid' as const })),
      constraints,
      allMatched: true,
    }
  }
  // Nothing meets every part: return the closest passages by meaning (still
  // above the normal floor), flagged so the caller says so instead of
  // presenting them as the answer.
  const closest = rerankByKeyword(pool.filter((h) => h.score >= MIN_SCORE), queryText, limit)
  return { hits: closest, constraints, allMatched: false }
}
