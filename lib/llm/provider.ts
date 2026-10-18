/**
 * Multi-provider LLM with key pools + cross-provider fallback.
 *
 * The picture:
 *   - Each provider (openai, groq, gemini, cerebras) has a POOL of API keys.
 *   - Within a provider, keys are rotated round-robin.
 *   - When a key returns 429 (rate-limited), it's marked cooling-down
 *     for COOLDOWN_MS. Other keys in the pool keep serving.
 *   - When ALL keys in a provider are cooling down OR an unrelated error
 *     blocks the provider, requests fall through to the NEXT provider in
 *     ASSISTANT_PROVIDER_ORDER.
 *   - If every provider fails, the caller gets a canned response.
 *
 * Add more keys later by appending to OPENAI_API_KEYS / GROQ_API_KEYS /
 * GEMINI_API_KEYS / CEREBRAS_API_KEYS in .env (comma-separated). No code
 * change needed.
 */

import { createOpenAI } from '@ai-sdk/openai'
import { createGroq } from '@ai-sdk/groq'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'

export type ProviderName = 'openai' | 'local' | 'groq' | 'gemini' | 'cerebras'

const COOLDOWN_MS = 60_000  // mark a key cool for 60s after a 429

interface KeyState {
  key: string
  cooldownUntil: number  // epoch ms; 0 = available
}

interface ProviderPool {
  name: ProviderName
  keys: KeyState[]
  cursor: number  // round-robin pointer
  model: string
  buildModel: (apiKey: string, modelName: string) => LanguageModel
}

// ─── Env parsing ─────────────────────────────────────────────────────────────

function parseKeyList(envValue: string | undefined): string[] {
  if (!envValue) return []
  return envValue
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
}

// ─── Pool initialization ─────────────────────────────────────────────────────

let pools: Map<ProviderName, ProviderPool> | null = null

function initPools(): Map<ProviderName, ProviderPool> {
  const map = new Map<ProviderName, ProviderPool>()

  // ── Local self-hosted LLM (vLLM on TRIJYA-3, OpenAI-compatible) ──
  // The fast, private, unlimited primary. Enabled by pointing LOCAL_LLM_BASE_URL
  // at the vLLM server (e.g. http://100.86.39.4:8000/v1). vLLM doesn't require a
  // real API key; LOCAL_LLM_API_KEY defaults to a placeholder. When the GPU box
  // is offline/preempted the call errors and the router falls through to the
  // cloud providers automatically — no code path is a hard dependency on it.
  const localBaseURL = process.env.LOCAL_LLM_BASE_URL?.trim()
  if (localBaseURL) {
    const localKey = process.env.LOCAL_LLM_API_KEY?.trim() || 'sk-local'
    // Hard cap on a local call so a hung/unreachable box (e.g. Ollama down but
    // the machine still up → the port silently drops packets) fails FAST and the
    // router falls through to the cloud, instead of hanging ~20s. Local warm
    // generations finish in <2s, so this headroom never truncates a real reply.
    // 12s was too tight: Ollama serves one GPU, so concurrent turns QUEUE and
    // legitimately take >12s — the abort then produced empty replies under load
    // (measured 3/5 empty at 5 concurrent). A down box still fails fast because
    // the Cloudflare tunnel 502s immediately, so this longer budget only
    // affects genuinely-queued work.
    const localTimeoutMs = Number(process.env.LOCAL_LLM_TIMEOUT_MS ?? 25_000)
    // When the box is fronted by a Cloudflare Tunnel behind Access, Render must
    // present a service token so Cloudflare's edge lets the request through.
    // Absent (e.g. direct Tailscale in local dev) → no headers, unchanged.
    const cfAccessId = process.env.CF_ACCESS_CLIENT_ID?.trim()
    const cfAccessSecret = process.env.CF_ACCESS_CLIENT_SECRET?.trim()
    const localFetch: typeof fetch = (input, init) => {
      const signals = [init?.signal, AbortSignal.timeout(localTimeoutMs)].filter(Boolean) as AbortSignal[]
      const headers = new Headers(init?.headers)
      if (cfAccessId && cfAccessSecret) {
        headers.set('CF-Access-Client-Id', cfAccessId)
        headers.set('CF-Access-Client-Secret', cfAccessSecret)
      }
      return fetch(input, { ...init, headers, signal: AbortSignal.any(signals) })
    }
    map.set('local', {
      name: 'local',
      keys: [{ key: localKey, cooldownUntil: 0 }],
      cursor: 0,
      model: process.env.LOCAL_LLM_MODEL ?? 'forgie',
      buildModel: (apiKey, modelName) =>
        createOpenAICompatible({
          name: 'local',
          apiKey,
          baseURL: localBaseURL,
          fetch: localFetch,
        })(modelName),
    })
  }

  // ── OpenAI ── the official provider, not the OpenAI-compatible one: it
  // knows which models are reasoning models (gpt-5 family) and drops the
  // settings they reject, such as temperature, instead of failing the call.
  // OPENAI_API_KEY (one key, OpenAI's own convention) is accepted too.
  const openaiKeys = parseKeyList(process.env.OPENAI_API_KEYS || process.env.OPENAI_API_KEY)
  if (openaiKeys.length > 0) {
    map.set('openai', {
      name: 'openai',
      keys: openaiKeys.map((key) => ({ key, cooldownUntil: 0 })),
      cursor: 0,
      model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
      buildModel: (apiKey, modelName) => createOpenAI({ apiKey })(modelName),
    })
  }

  const groqKeys = parseKeyList(process.env.GROQ_API_KEYS)
  if (groqKeys.length > 0) {
    map.set('groq', {
      name: 'groq',
      keys: groqKeys.map((key) => ({ key, cooldownUntil: 0 })),
      cursor: 0,
      model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
      buildModel: (apiKey, modelName) => createGroq({ apiKey })(modelName),
    })
  }

  const geminiKeys = parseKeyList(process.env.GEMINI_API_KEYS)
  if (geminiKeys.length > 0) {
    map.set('gemini', {
      name: 'gemini',
      keys: geminiKeys.map((key) => ({ key, cooldownUntil: 0 })),
      cursor: 0,
      model: process.env.GEMINI_MODEL ?? 'gemini-1.5-flash',
      buildModel: (apiKey, modelName) => createGoogleGenerativeAI({ apiKey })(modelName),
    })
  }

  const cerebrasKeys = parseKeyList(process.env.CEREBRAS_API_KEYS)
  if (cerebrasKeys.length > 0) {
    map.set('cerebras', {
      name: 'cerebras',
      keys: cerebrasKeys.map((key) => ({ key, cooldownUntil: 0 })),
      cursor: 0,
      model: process.env.CEREBRAS_MODEL ?? 'llama-3.3-70b',
      buildModel: (apiKey, modelName) =>
        createOpenAICompatible({
          name: 'cerebras',
          apiKey,
          baseURL: 'https://api.cerebras.ai/v1',
        })(modelName),
    })
  }

  return map
}

function getPools(): Map<ProviderName, ProviderPool> {
  if (!pools) pools = initPools()
  return pools
}

// ─── Public helpers ──────────────────────────────────────────────────────────

export function isAssistantEnabled(): boolean {
  if (process.env.ASSISTANT_ENABLED !== 'true') return false
  return getPools().size > 0
}

export function getProviderOrder(): ProviderName[] {
  // OpenAI first when it has keys, then local, then the other cloud fallbacks.
  // A provider without keys is skipped, so the default order is safe anywhere.
  const raw = process.env.ASSISTANT_PROVIDER_ORDER ?? 'openai,local,groq,gemini,cerebras'
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ProviderName => s === 'openai' || s === 'local' || s === 'groq' || s === 'gemini' || s === 'cerebras')
}

// Pick the next available key in a pool. Returns null if all are cooling down.
function pickKey(pool: ProviderPool): KeyState | null {
  const now = Date.now()
  for (let i = 0; i < pool.keys.length; i++) {
    const idx = (pool.cursor + i) % pool.keys.length
    const k = pool.keys[idx]
    if (k && k.cooldownUntil <= now) {
      pool.cursor = (idx + 1) % pool.keys.length  // advance for next caller
      return k
    }
  }
  return null
}

function markKeyRateLimited(pool: ProviderPool, key: string): void {
  const k = pool.keys.find((x) => x.key === key)
  if (k) k.cooldownUntil = Date.now() + COOLDOWN_MS
}

// ─── Pick a model for the next request ───────────────────────────────────────
// Returns the constructed LanguageModel + metadata about who served it.
// Caller is responsible for catching errors and calling onError() so we
// can mark keys as rate-limited.

export interface SelectedModel {
  model: LanguageModel
  provider: ProviderName
  modelName: string
  apiKey: string
}

export function selectNextModel(opts?: { deprioritize?: ProviderName[]; exclude?: ProviderName[] }): SelectedModel | null {
  let order = getProviderOrder()
  // Leave some providers out entirely, e.g. the small local model for answers
  // about regulations, where a wrong figure is worse than no written answer.
  if (opts?.exclude?.length) {
    const skip = new Set(opts.exclude)
    order = order.filter((p) => !skip.has(p))
  }
  // Move certain providers to the back without dropping them (still a last
  // resort). Used to keep Groq off the tool-calling path — Groq streams the
  // first tool step fine but hangs the agentic CONTINUATION (feeding the tool
  // result back) until the request timeout, so tool turns prefer local/Gemini.
  if (opts?.deprioritize?.length) {
    const demote = new Set(opts.deprioritize)
    order = [...order.filter((p) => !demote.has(p)), ...order.filter((p) => demote.has(p))]
  }
  const map = getPools()

  for (const providerName of order) {
    const pool = map.get(providerName)
    if (!pool) continue
    const key = pickKey(pool)
    if (!key) continue  // all keys in this provider are cooling down — try next
    return {
      model: pool.buildModel(key.key, pool.model),
      provider: pool.name,
      modelName: pool.model,
      apiKey: key.key,
    }
  }
  return null  // nothing available right now
}

// ─── Error reporting from caller ─────────────────────────────────────────────
// The route layer should call this when a model invocation 429s.

export function reportRateLimit(provider: ProviderName, apiKey: string): void {
  const pool = getPools().get(provider)
  if (pool) markKeyRateLimited(pool, apiKey)
}

/**
 * Cool DOWN an entire provider (all its keys) for one cooldown window. Use for
 * provider-wide failures that another key can't fix — e.g. Groq's "request too
 * large" 413 (every key shares the same per-model TPM cap). Without this the
 * router wastes an attempt per key and can burn its whole budget before
 * reaching the next provider.
 */
export function reportProviderExhausted(provider: ProviderName): void {
  const pool = getPools().get(provider)
  if (!pool) return
  const until = Date.now() + COOLDOWN_MS
  for (const k of pool.keys) k.cooldownUntil = until
}

// ─── Diagnostics (for admin debug UI later) ──────────────────────────────────

export function getPoolStatus() {
  const map = getPools()
  const now = Date.now()
  return Array.from(map.values()).map((pool) => ({
    provider: pool.name,
    model: pool.model,
    keyCount: pool.keys.length,
    availableKeys: pool.keys.filter((k) => k.cooldownUntil <= now).length,
    coolingDownKeys: pool.keys.filter((k) => k.cooldownUntil > now).length,
  }))
}
