/**
 * Text embeddings via Hugging Face's "Inference Providers" router, using the
 * hf-inference provider (their own serverless infra — the successor to the
 * old standalone api-inference.huggingface.co, which is decommissioned).
 * Default model is a sentence-transformers model (BAAI/bge-small-en-v1.5),
 * for which the feature-extraction endpoint already returns one pooled
 * vector per input — no manual mean-pooling needed. Kept provider-agnostic
 * behind embedTexts() so swapping providers later only touches this file.
 */
const HF_API_KEY = process.env.HF_API_KEY?.trim()
const MODEL = process.env.HF_EMBEDDING_MODEL?.trim() || 'BAAI/bge-small-en-v1.5'
export const EMBEDDING_DIM = Number(process.env.HF_EMBEDDING_DIM ?? 384)

const ENDPOINT = `https://router.huggingface.co/hf-inference/models/${MODEL}`
const BATCH_SIZE = 16

export function isEmbeddingConfigured(): boolean {
  return !!HF_API_KEY
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
  if (!HF_API_KEY) throw new Error('HF_API_KEY is not configured')
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

/** Embed multiple texts, batching requests to stay within HF payload limits. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    out.push(...(await embedBatch(batch)))
  }
  return out
}

/** Embed a single query string. */
export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await embedTexts([text])
  if (!vec) throw new Error('HF embeddings returned no vector')
  return vec
}
