/**
 * Server-side client for the Trijya NAS connector (Python+pysmb service on
 * TRIJYA-3, fronted by the Cloudflare Tunnel at TRIJYA_NAS_BASE_URL and gated
 * by the same Cloudflare Access service token as the local LLM).
 *
 * NAS access is a per-org capability — only the org that owns the NAS (Trijya)
 * gets it. Enablement = TRIJYA_NAS_BASE_URL set AND current org === NAS_ORG_ID
 * (default 'trijya'). Everything here is server-only.
 */
import { getOrgId } from '@/lib/tenant-context'

const BASE = process.env.TRIJYA_NAS_BASE_URL?.trim().replace(/\/$/, '')
const NAS_ORG_ID = process.env.NAS_ORG_ID?.trim() || 'trijya'
const TIMEOUT_MS = Number(process.env.NAS_TIMEOUT_MS ?? 25_000)

/** The one org that owns the NAS. Background jobs (crons) have no request to
 * take an org from, so they run as this org explicitly. */
export function nasOrgId(): string {
  return NAS_ORG_ID
}

/** True when the NAS connector is configured AND the caller's org owns it. */
export function isNasEnabled(): boolean {
  return !!BASE && getOrgId() === NAS_ORG_ID
}

function accessHeaders(): Record<string, string> {
  const id = process.env.CF_ACCESS_CLIENT_ID?.trim()
  const secret = process.env.CF_ACCESS_CLIENT_SECRET?.trim()
  return id && secret
    ? { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret }
    : {}
}

function assertEnabled() {
  if (!BASE) throw new Error('NAS is not configured')
  if (!isNasEnabled()) throw new Error('NAS is not available for this organization')
}

async function nasFetch(path: string, init: RequestInit = {}): Promise<Response> {
  assertEnabled()
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...accessHeaders(), ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  })
  return res
}

export interface NasEntry {
  name: string
  isDir: boolean
  size: number
  mtime: number
}

export interface NasServer {
  label: string
}

// The server list is static config — cache it briefly so hot paths (the NAS
// fast-lane) don't spend a tunnel round-trip fetching it every time.
let serversCache: { at: number; servers: NasServer[] } | null = null

export async function nasServers(): Promise<NasServer[]> {
  if (serversCache && Date.now() - serversCache.at < 300_000) return serversCache.servers
  const r = await nasFetch('/servers')
  if (!r.ok) throw new Error(`NAS servers failed (${r.status})`)
  const j = (await r.json()) as { servers: NasServer[] }
  const servers = j.servers ?? []
  serversCache = { at: Date.now(), servers }
  return servers
}

export async function nasList(server: string, path = '/'): Promise<{ path: string; items: NasEntry[] }> {
  const r = await nasFetch(`/list?server=${encodeURIComponent(server)}&path=${encodeURIComponent(path)}`)
  if (!r.ok) throw new Error(`NAS list failed (${r.status})`)
  return (await r.json()) as { path: string; items: NasEntry[] }
}

export interface NasSearchHit {
  name: string
  path: string
  isDir: boolean
  size: number
  /** unix seconds; powers "latest / newest" and date sorting */
  mtime?: number
}

export type NasSort = 'relevance' | 'latest' | 'oldest' | 'largest' | 'name'

export async function nasSearch(
  server: string,
  q: string,
  opts: { path?: string; limit?: number; sort?: NasSort; since?: number } = {},
): Promise<{ results: NasSearchHit[]; truncated: boolean }> {
  const params = new URLSearchParams({ server, q, path: opts.path ?? '/', limit: String(opts.limit ?? 40) })
  if (opts.sort && opts.sort !== 'relevance') params.set('sort', opts.sort)
  if (opts.since) params.set('since', String(opts.since))
  const r = await nasFetch(`/search?${params.toString()}`)
  if (!r.ok) throw new Error(`NAS search failed (${r.status})`)
  const j = (await r.json()) as { results: NasSearchHit[]; truncated: boolean }
  return { results: j.results ?? [], truncated: !!j.truncated }
}

export interface NasSemanticHit {
  name: string
  path: string
  score: number
}

/** Meaning-based search over the connector's embedding index (nomic-embed-text).
 * Returns [] gracefully if the semantic index isn't ready (503) so callers can
 * fall back to keyword search. */
export async function nasSemantic(server: string, q: string, k = 15): Promise<NasSemanticHit[]> {
  try {
    const r = await nasFetch(`/semantic?server=${encodeURIComponent(server)}&q=${encodeURIComponent(q)}&k=${k}`)
    if (!r.ok) return []
    const j = (await r.json()) as { results: NasSemanticHit[] }
    return j.results ?? []
  } catch {
    return []
  }
}

/** Proxy a file download from the NAS. Returns the upstream Response so the
 * route can stream it straight to the client without buffering in memory. */
export async function nasDownload(server: string, path: string): Promise<Response> {
  return nasFetch(
    `/download?server=${encodeURIComponent(server)}&path=${encodeURIComponent(path)}`,
    // downloads can be large; give them their own longer budget
    { signal: AbortSignal.timeout(Number(process.env.NAS_DOWNLOAD_TIMEOUT_MS ?? 120_000)) },
  )
}

/** Token-gated download: fetch a file WITHOUT the org-session check, for the
 * public share-link route (a valid signed token is the authorization). Only
 * call after verifyShareToken() has passed. */
export async function nasDownloadByToken(server: string, path: string): Promise<Response> {
  if (!BASE) throw new Error('NAS is not configured')
  return fetch(
    `${BASE}/download?server=${encodeURIComponent(server)}&path=${encodeURIComponent(path)}`,
    {
      headers: accessHeaders(),
      signal: AbortSignal.timeout(Number(process.env.NAS_DOWNLOAD_TIMEOUT_MS ?? 120_000)),
    },
  )
}

/** Fetch a file's raw bytes (for text extraction by Forgie tools). Capped. */
export async function nasFetchBytes(server: string, path: string, maxBytes = 8_000_000): Promise<Buffer> {
  const r = await nasDownload(server, path)
  if (!r.ok) throw new Error(`NAS download failed (${r.status})`)
  const buf = Buffer.from(await r.arrayBuffer())
  return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf
}

/** Thrown by nasFetchBytesStrict when a file exceeds the size limit. */
export class FileTooLargeError extends Error {
  /** `exact` is false when we stopped reading part-way, so the true size is
   * unknown — only that it is over the limit. Saying "file is 1.0 MB" for a
   * 5 MB file would be wrong, and this text is stored as the FAILED reason. */
  constructor(readonly bytes: number, readonly limit: number, readonly exact = true) {
    const lim = `${(limit / 1_048_576).toFixed(0)} MB indexing limit`
    super(exact
      ? `file is ${(bytes / 1_048_576).toFixed(1)} MB, over the ${lim}`
      : `file is larger than the ${lim} (download stopped at ${(bytes / 1_048_576).toFixed(1)} MB)`)
    this.name = 'FileTooLargeError'
  }
}

/**
 * Download a whole file, REFUSING rather than truncating if it is over
 * `maxBytes`. For content indexing, where a partial file is worse than none.
 *
 * nasFetchBytes above silently cuts files at 8 MB. That is acceptable for a
 * short text preview, but fatal for indexing: a PDF keeps its cross-reference
 * table at the END, so a cut PDF is corrupt and cannot be parsed at all. It
 * also buffers the ENTIRE file before cutting, so its limit never protected
 * memory either — a 245 MB file was fully loaded first.
 *
 * Here the size is checked from Content-Length before the body is read, and
 * the body is streamed with a running count that aborts as soon as the limit
 * is crossed, so an oversized file is never held in memory.
 */
export async function nasFetchBytesStrict(server: string, path: string, maxBytes: number): Promise<Buffer> {
  const r = await nasDownload(server, path)
  if (!r.ok) throw new Error(`NAS download failed (${r.status})`)

  const declared = Number(r.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await r.body?.cancel().catch(() => {})
    throw new FileTooLargeError(declared, maxBytes)
  }
  if (!r.body) return Buffer.from(await r.arrayBuffer())

  const reader = r.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new FileTooLargeError(total, maxBytes, false)
    }
    parts.push(value)
  }
  return Buffer.concat(parts, total)
}

export interface NasExtractResult {
  ok: true
  text: string
  method: 'text' | 'ocr'
  truncated: boolean
}
export interface NasExtractFailure {
  ok: false
  reason: string
}

const EXTRACT_RETRYABLE = new Set([502, 503, 504])
const EXTRACT_MAX_ATTEMPTS = 3

/**
 * Ask the connector to extract a PDF's text itself (PyMuPDF, falling back to
 * OCR for scanned pages) and return text, not bytes. For files too large to
 * safely download and parse on Render (see MAX_INDEX_BYTES in
 * lib/rag/index-core.ts) — the connector runs on TRIJYA-3, which isn't
 * memory-constrained the way Render's free plan is.
 *
 * A 404 means the connector hasn't been redeployed with /extract yet — treat
 * that like any other failure so callers fall back to their existing
 * "too large to index" handling; it's safe to ship this before TRIJYA-3 is
 * updated.
 */
export async function nasExtractText(server: string, path: string): Promise<NasExtractResult | NasExtractFailure> {
  const timeout = Number(process.env.NAS_EXTRACT_TIMEOUT_MS ?? 180_000)
  let lastError = ''
  for (let attempt = 0; attempt < EXTRACT_MAX_ATTEMPTS; attempt++) {
    let r: Response
    try {
      r = await nasFetch(
        `/extract?server=${encodeURIComponent(server)}&path=${encodeURIComponent(path)}`,
        { signal: AbortSignal.timeout(timeout) },
      )
    } catch (e) {
      lastError = e instanceof Error ? e.message : 'network error'
      if (attempt < EXTRACT_MAX_ATTEMPTS - 1) await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt))
      continue
    }
    if (EXTRACT_RETRYABLE.has(r.status)) {
      await r.body?.cancel().catch(() => {})
      lastError = `HTTP ${r.status}`
      if (attempt < EXTRACT_MAX_ATTEMPTS - 1) await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt))
      continue
    }
    if (!r.ok) return { ok: false, reason: `connector extraction failed (${r.status})` }
    return (await r.json()) as NasExtractResult | NasExtractFailure
  }
  return { ok: false, reason: `connector extraction unavailable after ${EXTRACT_MAX_ATTEMPTS} attempts (last: ${lastError})` }
}

export async function nasUpload(server: string, path: string, file: Blob, filename: string): Promise<{ ok: boolean; path: string }> {
  const form = new FormData()
  form.append('file', file, filename)
  const r = await nasFetch(
    `/upload?server=${encodeURIComponent(server)}&path=${encodeURIComponent(path)}`,
    { method: 'POST', body: form, signal: AbortSignal.timeout(Number(process.env.NAS_UPLOAD_TIMEOUT_MS ?? 120_000)) },
  )
  if (!r.ok) throw new Error(`NAS upload failed (${r.status})`)
  return (await r.json()) as { ok: boolean; path: string }
}
