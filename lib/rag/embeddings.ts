/**
 * Text embeddings via the Hugging Face Inference API. Default model is a
 * sentence-transformers model (BAAI/bge-small-en-v1.5), for which HF's
 * feature-extraction endpoint already returns one pooled vector per input —
 * no manual mean-pooling needed. Kept provider-agnostic behind embedTexts()
 * so swapping providers later only touches this file.
 */
const HF_API_KEY = process.env.HF_API_KEY?.trim()
const MODEL = process.env.HF_EMBEDDING_MODEL?.trim() || 'BAAI/bge-small-en-v1.5'
export const EMBEDDING_DIM = Number(process.env.HF_EMBEDDING_DIM ?? 384)

const ENDPOINT = `https://api-inference.huggingface.co/models/${MODEL}`
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
  return arr.map((v) => {
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
}

async function embedBatch(texts: string[], attempt = 0): Promise<number[][]> {
  if (!HF_API_KEY) throw new Error('HF_API_KEY is not configured')
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HF_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inputs: texts, options: { wait_for_model: true } }),
    signal: AbortSignal.timeout(30_000),
  })

  if (res.status === 503 && attempt < 2) {
    // model is cold-loading on HF's side — brief backoff, then retry
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
    return embedBatch(texts, attempt + 1)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HF embeddings failed (${res.status}): ${body.slice(0, 200)}`)
  }
  const json = await res.json()
  return normalize(json, texts.length)
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
