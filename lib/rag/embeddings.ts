/**
 * Text embeddings, from two providers serving the SAME model
 * (BAAI/bge-small-en-v1.5 by default):
 *
 *  1. The NAS connector on TRIJYA-3 (POST /embed; scripts/nas-connector/
 *     rag_embed.py), used first whenever TRIJYA_NAS_BASE_URL is set. It runs
 *     the model's official ONNX export with its published sentence-transformers
 *     settings; checked against vectors the API produced for 128 stored
 *     passages: cosine 1.000000, max difference 3e-7. So results from either
 *     provider can be mixed in one index.
 *  2. Hugging Face's "Inference Providers" router (hf-inference provider), as
 *     the fallback. The free tier has a small monthly allowance: in October
 *     2026 the first bylaws backfill used it up, and from then on every
 *     search failed with HTTP 402 until it reset. That is why the connector
 *     goes first.
 *
 * Kept behind embedTexts()/embedQuery() so callers never know which served it.
 */
const HF_API_KEY = process.env.HF_API_KEY?.trim()
const MODEL = process.env.HF_EMBEDDING_MODEL?.trim() || 'BAAI/bge-small-en-v1.5'
export const EMBEDDING_DIM = Number(process.env.HF_EMBEDDING_DIM ?? 384)

const ENDPOINT = `https://router.huggingface.co/hf-inference/models/${MODEL}`
const BATCH_SIZE = 16

/** The connector's base URL when it should serve embeddings, else null.
 * Read per call (RAG_EMBED_VIA_CONNECTOR=false turns it off). */
function connectorBase(): string | null {
  if ((process.env.RAG_EMBED_VIA_CONNECTOR ?? '').trim().toLowerCase() === 'false') return null
  return process.env.TRIJYA_NAS_BASE_URL?.trim().replace(/\/$/, '') || null
}

export function isEmbeddingConfigured(): boolean {
  return !!HF_API_KEY || !!connectorBase()
}

// HF's feature-extraction response is either already-pooled (number[][], one
// vector per input) or per-token (number[][][]) depending on the model config.
// Mean-pool the latter so callers always get a flat vector per input.
function normalize(raw: unknown, count: number): number[][] {
  const arr = raw as unknown[]
  if (arr.length !== count) throw new Error(`HF embeddings: expected ${count} vectors, got ${arr.length}`)
  const vectors = arr.map((v) => {
    const vec = v as unknown
    if (Array.isArray(vec) && Array.isArray(vec[0])) {
      // token-level embeddings: mean-pool across tokens
      const tokens = vec as number[][]
      const dim = tokens[0]!.length
      const pooled = new Array(dim).fill(0)
      for (const t of tokens) for (let i = 0; i < dim; i++) pooled[i] += t[i]!
      return pooled.map((x) => x / tokens.length)
    }
    return vec as number[]
  })
  // Fail loudly on a size mismatch. Previously this was never checked: changing
  // HF_EMBEDDING_MODEL to e.g. a 768-dim model without also changing
  // HF_EMBEDDING_DIM created the Qdrant collection at 384 and then every write
  // failed, surfacing only as a pile of FAILED rows with an opaque Qdrant error.
  const bad = vectors.find((v) => v.length !== EMBEDDING_DIM)
  if (bad) {
    throw new Error(
      `HF embeddings: model ${MODEL} returned ${bad.length}-dim vectors but HF_EMBEDDING_DIM is ${EMBEDDING_DIM}. ` +
        `Set HF_EMBEDDING_DIM=${bad.length} (and recreate the Qdrant collections) or switch back to a ${EMBEDDING_DIM}-dim model.`,
    )
  }
  return vectors
}

// ── Concurrency limit ─────────────────────────────────────────────────────────
// Indexing is fire-and-forget per upload, so uploading 30 files at once used to
// launch 30 parallel indexing jobs, each hammering HF at the same moment. That
// trips the free tier's rate limit. A small in-process semaphore keeps the
// number of in-flight embedding requests bounded across ALL callers.
const MAX_CONCURRENT = Math.max(1, Number(process.env.HF_MAX_CONCURRENT ?? 2))
let inFlight = 0
const waiters: Array<() => void> = []
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r))
  inFlight++
  try {
    return await fn()
  } finally {
    inFlight--
    waiters.shift()?.()
  }
}

// ── Retries ───────────────────────────────────────────────────────────────────
// Originally only 503 (model cold-loading) was retried, twice. A 429 (rate
// limited) — the failure that bulk uploads actually hit — threw immediately,
// so every one of those files was marked FAILED with no automatic retry.
// Now both are retried with exponential backoff, honouring Retry-After.
const MAX_ATTEMPTS = 6
const RETRYABLE = new Set([429, 502, 503, 504])

function backoffMs(attempt: number, retryAfter: string | null): number {
  const hinted = Number(retryAfter)
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted * 1000, 60_000)
  // 1s, 2s, 4s, 8s, 16s (+ jitter so concurrent callers don't retry in lockstep)
  return Math.min(1000 * 2 ** attempt, 30_000) + Math.floor(Math.random() * 400)
}

type Attempt =
  | { done: true; vectors: number[][] }
  | { done: false; error: string; retryAfter: string | null }

/** One HTTP attempt. Retryable failures are RETURNED (so the caller can sleep
 * outside the concurrency slot); anything else is thrown immediately. */
async function attemptOnce(texts: string[]): Promise<Attempt> {
  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${HF_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: texts, options: { wait_for_model: true } }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    // network blip / timeout — treated like a 5xx
    return { done: false, error: e instanceof Error ? e.message : 'network error', retryAfter: null }
  }
  if (RETRYABLE.has(res.status)) {
    await res.body?.cancel().catch(() => {})
    return { done: false, error: `HTTP ${res.status}`, retryAfter: res.headers.get('retry-after') }
  }
  if (!res.ok) {
    // 400 / 401 / 404 etc. — retrying cannot help, so fail at once with detail.
    const body = await res.text().catch(() => '')
    throw new Error(`HF embeddings failed (${res.status}): ${body.slice(0, 200)}`)
  }
  return { done: true, vectors: normalize(await res.json(), texts.length) }
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!HF_API_KEY) throw new Error(connectorBase() ? 'the NAS connector could not embed and HF_API_KEY is not configured' : 'HF_API_KEY is not configured')
  let lastError = ''
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Hold a concurrency slot ONLY for the request itself, never for the
    // backoff sleep. Holding it across the sleep meant a rate-limit storm
    // parked every slot in a 30-second sleep, and an interactive search
    // (embedQuery) queued behind bulk indexing waited the whole time.
    const result = await withSlot(() => attemptOnce(texts))
    if (result.done) return result.vectors
    lastError = result.error
    if (attempt < MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, backoffMs(attempt, result.retryAfter)))
    }
  }
  // Recorded as the file's FAILED reason, so say plainly that it WAS retried.
  throw new Error(`HF embeddings failed after ${MAX_ATTEMPTS} attempts (last: ${lastError}) — likely rate limited; re-run to retry`)
}

/**
 * Text prefixes the model was trained with. The E5 family (e.g.
 * intfloat/multilingual-e5-large, the multilingual option for Hindi bylaws)
 * expects every input to start with "query: " or "passage: "; without them
 * retrieval quality drops, and the scores shift, so RAG_MIN_SCORE calibrated
 * one way is wrong the other way. Applied automatically for E5 models;
 * HF_QUERY_PREFIX / HF_PASSAGE_PREFIX override (set both to "" to disable).
 * The "-instruct" E5 variants use a different query format, so they are not
 * auto-detected: configure them explicitly. BGE models are left alone on
 * purpose: their optional query prefix made separation WORSE in calibration
 * (see docs/NAS_RAG_REVIEW.md, fix 9).
 *
 * Changing the model or these prefixes changes every vector: re-index both
 * collections and re-calibrate RAG_MIN_SCORE.
 */
export function inputPrefixes(model = MODEL): { query: string; passage: string } {
  const q = process.env.HF_QUERY_PREFIX
  const p = process.env.HF_PASSAGE_PREFIX
  if (q !== undefined || p !== undefined) return { query: q ?? '', passage: p ?? '' }
  if (/(^|\/)(multilingual-)?e5-(small|base|large)(-v2)?$/i.test(model)) return { query: 'query: ', passage: 'passage: ' }
  return { query: '', passage: '' }
}
const PREFIX = inputPrefixes()

// ── Connector (primary) ──────────────────────────────────────────────────────
// Larger batches than the API: each request crosses the Cloudflare tunnel, and
// 64 passages take well under a second on TRIJYA-3's CPU.
const CONNECTOR_BATCH = 64
const CONNECTOR_TIMEOUT_MS = 90_000 // under Cloudflare's ~100 s request cap
// After a failure the connector is skipped for a while, so a box that is down
// costs one timeout, not one per batch. A refusal that will not fix itself
// soon (wrong model, endpoint missing) pauses it longer.
const PAUSE_MS = 60_000
const LONG_PAUSE_MS = 10 * 60_000
let connectorPausedUntil = 0

/** For tests: forget a previous connector failure. */
export function resetEmbeddingConnectorPause(): void {
  connectorPausedUntil = 0
}

function pauseConnector(ms: number, why: string): void {
  if (Date.now() >= connectorPausedUntil) {
    console.warn(`[embeddings] connector unavailable (${why}); using the HuggingFace API for the next ${Math.round(ms / 60_000)} min`)
  }
  connectorPausedUntil = Date.now() + ms
}

function connectorHeaders(): Record<string, string> {
  const id = process.env.CF_ACCESS_CLIENT_ID?.trim()
  const secret = process.env.CF_ACCESS_CLIENT_SECRET?.trim()
  return id && secret ? { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret } : {}
}

/** Vectors from the connector, or null if it could not provide them (the
 * caller then uses the API). Never throws. */
async function embedViaConnector(base: string, texts: string[]): Promise<number[][] | null> {
  if (Date.now() < connectorPausedUntil) return null
  try {
    const res = await withSlot(() => fetch(`${base}/embed`, {
      method: 'POST',
      headers: { ...connectorHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, texts }),
      signal: AbortSignal.timeout(CONNECTOR_TIMEOUT_MS),
    }))
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      pauseConnector([400, 404, 405, 501].includes(res.status) ? LONG_PAUSE_MS : PAUSE_MS, `HTTP ${res.status} ${body.slice(0, 120)}`)
      return null
    }
    const j = (await res.json()) as { vectors?: unknown }
    return normalize(j.vectors ?? [], texts.length) // also checks count and dimension
  } catch (e) {
    pauseConnector(PAUSE_MS, e instanceof Error ? e.message : 'request failed')
    return null
  }
}

async function embedViaApi(texts: string[]): Promise<number[][]> {
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += BATCH_SIZE) out.push(...(await embedBatch(texts.slice(i, i + BATCH_SIZE))))
  return out
}

async function embedRaw(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const base = connectorBase()
  if (!base) return embedViaApi(texts)
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += CONNECTOR_BATCH) {
    const batch = texts.slice(i, i + CONNECTOR_BATCH)
    out.push(...((await embedViaConnector(base, batch)) ?? (await embedViaApi(batch))))
  }
  return out
}

/** Embed document passages (for indexing), batching requests to stay within
 * HF payload limits. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  return embedRaw(PREFIX.passage ? texts.map((t) => PREFIX.passage + t) : texts)
}

/** Embed a single search query. */
export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await embedRaw([PREFIX.query + text])
  if (!vec) throw new Error('HF embeddings returned no vector')
  return vec
}
