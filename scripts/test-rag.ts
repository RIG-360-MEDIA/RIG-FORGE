/**
 * Regression suite for the NAS + bylaws RAG pipeline, grouped by the fixes made
 * in commit 775e152. See docs/NAS_RAG_REVIEW.md for what each fix is and why.
 *
 * Two kinds of check:
 *  - Most reproduce a defect found in review, and would fail against the code
 *    before that commit (several by crashing, as the functions they test did
 *    not exist yet).
 *  - Checks worded "still", "unchanged" or "also" are REGRESSION GUARDS: they
 *    pin down behaviour that was already correct, so the fixes are proven not
 *    to have broken it (e.g. the nas_read preview keeping its 12,000 cap).
 *
 *   npx tsx scripts/test-rag.ts            (run from the repo root)
 *
 * Needs NO network, Qdrant or HuggingFace account: the HF and NAS-connector
 * HTTP calls are replaced with in-process fakes, and Qdrant is deliberately
 * left unconfigured. Everything else runs the real code.
 *
 * NOT covered here (needs a live Qdrant): the upsert-then-prune ordering, the
 * payload indexes, and score_threshold. Exercise those against a real cluster.
 */
process.env.HF_API_KEY = 'test-key-not-real'
process.env.HF_EMBEDDING_DIM = '384'
process.env.HF_MAX_CONCURRENT = '2'
process.env.RAG_MAX_FILE_MB = '1'          // small, so the size guard is testable
delete process.env.QDRANT_URL               // Qdrant unreachable on purpose here
// The NAS client reads its URL at MODULE LOAD, so it must be set before any
// import that pulls it in (bylaws-crawl does).
process.env.TRIJYA_NAS_BASE_URL = 'http://fake-connector'
process.env.NAS_ORG_ID = 'trijya'

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
// NAS calls are only allowed for the trijya org; outside a request the org
// context defaults to rig360, so run NAS calls inside an explicit trijya context.
import { runWithOrg } from '../lib/tenant-context'
const asTrijya = <T>(fn: () => Promise<T>) => runWithOrg('trijya', fn)

let pass = 0, fail = 0
const check = (label: string, cond: boolean, detail = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
}
const realFetch = globalThis.fetch

async function main() {
  // ── FIX 1: chunker infinite loop ──────────────────────────────────────────
  console.log('\n## Fix 1 — chunker no longer loops forever')
  const probe = spawnSync(process.execPath, ['--max-old-space-size=256', '--import', 'tsx', '-e',
    `import('./lib/rag/chunk.ts').then(m => { const c = m.chunkText('y'.repeat(5000), 100, 100); console.log('RETURNED', c.length) })`],
    { timeout: 8000, encoding: 'utf8' })
  check('overlap == target returns instead of crashing', /RETURNED \d+/.test(probe.stdout || ''), (probe.stdout || probe.stderr || '').trim().slice(0, 60))
  const probe2 = spawnSync(process.execPath, ['--max-old-space-size=256', '--import', 'tsx', '-e',
    `import('./lib/rag/chunk.ts').then(m => { const c = m.chunkText('y'.repeat(5000), 100, 500); console.log('RETURNED', c.length) })`],
    { timeout: 8000, encoding: 'utf8' })
  check('overlap > target also returns', /RETURNED \d+/.test(probe2.stdout || ''))
  const { chunkText } = await import('../lib/rag/chunk')
  const doc = Array.from({ length: 200 }, (_, i) => `Clause ${i + 1}. Front setback shall be 4.5 metres.`).join('\n\n')
  const ch = chunkText(doc)
  check('default chunking unchanged (last clause still present)', ch.some((c) => c.text.includes('Clause 200.')) && ch.length > 3, `${ch.length} chunks`)

  // ── FIX 2: bylaws folder detection ────────────────────────────────────────
  console.log('\n## Fix 2 — bylaws folder detection against REAL NAS paths')
  const { isBylawsPath } = await import('../lib/nas/bylaws-crawl')
  // The real contents of /utility data/By_Laws on Trijya's WD share, as listed
  // by the NAS connector on 2026-10-02. Before the fix, 0 of these matched.
  const real = [
    '/utility data/By_Laws/ARCHITECTURAL STANDARDS',
    '/utility data/By_Laws/NBCs',
    '/utility data/By_Laws/ZONAL PLANS REGULATIONS',
    '/utility data/By_Laws/202504161857302632Bylaws_160425.pdf',
    '/utility data/By_Laws/Compiled_byelaws_I.pdf',
    '/utility data/By_Laws/ews calculation.pdf',
    '/utility data/By_Laws/G-O-07-01-2022 (1).pdf',
    '/utility data/By_Laws/G.O.V-2-\u09060-2016-60(\u09060)2015.pdf', // \u0906 = Devanagari "aa", then an ASCII 0
    '/utility data/By_Laws/Tourism-policy-2023 (1).pdf',
    '/utility data/By_Laws/WhatsApp Image 2026-09-07 at 11.22.13 AM.jpeg',
  ]
  const hit = real.filter(isBylawsPath).length
  check(`real Trijya paths now match (was 0 of ${real.length})`, hit === real.length, `${hit} of ${real.length}`)
  check('still matches if nested under a "Trijya Projects" folder', isBylawsPath('/Trijya Projects/utility data/By_Laws/a.pdf'))
  for (const v of ['Bye-Laws', 'Bye Laws', 'Byelaws', 'By_Laws', 'Bylaws'])
    check(`accepts "${v}"`, isBylawsPath(`/utility data/${v}/a.pdf`))
  check('still rejects a bylaws folder outside "utility data"', !isBylawsPath('/Anjana/By_Laws/a.pdf'))
  check('still rejects "utility data" itself', !isBylawsPath('/utility data/Parking by laws.pdf'))

  // findBylawsFolder walks the REAL WD root listing (served by a fake connector)
  const tree: Record<string, Array<{ name: string; isDir: boolean }>> = {
    '/': ['01 ARCHITECTURE', 'Anjana', 'NBC2016', 'utility data', 'Viability'].map((name) => ({ name, isDir: true })),
    '/utility data': [{ name: 'By_Laws', isDir: true }, { name: 'Parking by laws.pdf', isDir: false }],
  }
  globalThis.fetch = (async (u: string) => {
    const url = new URL(String(u))
    const items = (tree[url.searchParams.get('path') ?? '/'] ?? []).map((i) => ({ ...i, path: '', size: 0, mtime: 0 }))
    return new Response(JSON.stringify({ items }), { status: 200 })
  }) as typeof fetch
  const crawl = await import('../lib/nas/bylaws-crawl')
  let found: string | null = null
  try { found = await asTrijya(() => crawl.findBylawsFolder('WD')) } catch (e) { found = `ERR ${(e as Error).message}` }
  check('findBylawsFolder finds it on the real WD layout (was null)', found === '/utility data/By_Laws', String(found))
  globalThis.fetch = realFetch

  // ── FIX 3 + 4: extraction for indexing ────────────────────────────────────
  console.log('\n## Fixes 3+4 — indexing extraction: full documents, failures reported')
  const { extractForIndex, extractText } = await import('../lib/nas/extract')
  const big = Array.from({ length: 2000 }, (_, i) => `Section ${i + 1}: Setback, FAR and height rules apply.`).join('\n')
  const full = await extractForIndex('bylaws.txt', Buffer.from(big))
  check('long document indexed in full (was 12,000 chars)', full.ok && full.text.length >= big.length * 0.99,
    full.ok ? `${full.text.length.toLocaleString('en-US')} of ${big.length.toLocaleString('en-US')} chars` : full.reason)
  check('last section of a long document is now indexed', full.ok && full.text.includes('Section 2000:'))
  const corrupt = await extractForIndex('scanned.pdf', Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'))
  check('unreadable PDF reported as a FAILURE, not as content', !corrupt.ok, corrupt.ok ? `returned text: ${corrupt.text.slice(0, 50)}` : corrupt.reason)
  const blank = await extractForIndex('empty.txt', Buffer.from('   \n\n  '))
  check('empty file reported as a failure', !blank.ok, blank.ok ? '' : blank.reason)
  const dwg = await extractForIndex('plan.dwg', Buffer.from('x'))
  check('unsupported type reported as a failure', !dwg.ok)
  const preview = await extractText('bylaws.txt', Buffer.from(big))
  check('nas_read PREVIEW behaviour deliberately unchanged (still 12,000)', preview.length === 12_000, `${preview.length}`)

  // ── FIX 5: strict download (no truncation, no full-buffering) ─────────────
  console.log('\n## Fix 5 — downloads refuse oversized files instead of corrupting them')
  const client = await import('../lib/nas/client')
  const fakeBody = (bytes: number, declare: boolean) => {
    let sent = 0
    const stream = new ReadableStream({
      pull(ctrl) {
        if (sent >= bytes) return ctrl.close()
        const n = Math.min(65536, bytes - sent); sent += n; ctrl.enqueue(new Uint8Array(n))
      },
    })
    const headers: Record<string, string> = declare ? { 'content-length': String(bytes) } : {}
    return { stream, sentRef: () => sent, headers }
  }
  let streamed = 0
  for (const [label, size, declare, limit] of [
    ['under limit, full file returned', 300_000, true, 1_000_000],
    ['over limit (declared) rejected before reading', 5_000_000, true, 1_000_000],
    ['over limit (undeclared) aborted mid-stream', 5_000_000, false, 1_000_000],
  ] as const) {
    const b = fakeBody(size, declare)
    globalThis.fetch = (async () => new Response(b.stream, { status: 200, headers: b.headers })) as typeof fetch
    let got: Buffer | null = null, err: unknown = null
    try { got = await asTrijya(() => client.nasFetchBytesStrict('WD', '/x.pdf', limit)) } catch (e) { err = e }
    streamed = b.sentRef()
    if (size <= limit) check(label, got?.length === size, `${got?.length} bytes (old code would also cut >8 MB files)`)
    else check(label, err instanceof client.FileTooLargeError && streamed < size,
      `${err instanceof Error ? err.message : 'no error'}; read ${(streamed / 1e6).toFixed(2)} of ${(size / 1e6).toFixed(0)} MB`)
  }
  globalThis.fetch = realFetch

  // ── FIX 6 + 7 + 8: embeddings — retries, concurrency cap, dimension check ──
  console.log('\n## Fixes 6-8 — embedding client')
  const { embedTexts, embedQuery } = await import('../lib/rag/embeddings')
  const vec = (d = 384) => Array.from({ length: d }, (_, i) => Math.sin(i))
  let calls = 0, live = 0, peak = 0
  const fake = (h: (n: number, b: any) => { status: number; json?: unknown; headers?: Record<string, string> }, delayMs = 0) => {
    calls = 0; live = 0; peak = 0
    globalThis.fetch = (async (_u: unknown, init: any) => {
      calls++; live++; peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, delayMs))
      live--
      const r = h(calls, JSON.parse(init.body))
      return new Response(r.json !== undefined ? JSON.stringify(r.json) : 'x', { status: r.status, headers: r.headers })
    }) as typeof fetch
  }
  fake((n, b) => (n <= 2 ? { status: 429, headers: { 'retry-after': '1' } } : { status: 200, json: b.inputs.map(() => vec()) }))
  const t0 = Date.now()
  let rl: number[][] | null = null, rlErr = ''
  try { rl = await embedTexts(['x']) } catch (e) { rlErr = (e as Error).message }
  check('429 rate limit is retried and recovers (was: failed immediately)', !!rl && calls === 3, rlErr || `${calls} requests`)
  check('  honours Retry-After (waited ~2 s for two 1 s hints)', Date.now() - t0 >= 1900, `${Date.now() - t0} ms`)

  fake((n, b) => (n === 1 ? { status: 503 } : { status: 200, json: b.inputs.map(() => vec()) }))
  const cold = await embedTexts(['x']).catch(() => null)
  check('503 cold start still retried', !!cold && calls === 2)

  fake(() => ({ status: 429 }))
  let gaveUp = ''
  const tg = Date.now()
  try { await embedTexts(['x']) } catch (e) { gaveUp = (e as Error).message }
  check('gives up with a clear error after repeated 429s', /after 6 attempts/.test(gaveUp), `${gaveUp.slice(0, 70)} (${Math.round((Date.now() - tg) / 1000)} s)`)

  // Starvation: while 2 indexing batches are stuck retrying 429s, a live search
  // query (embedQuery) must still get a slot quickly — the slots are free
  // during the backoff sleeps.
  fake((_n, b) => (b.inputs[0].startsWith('bulk') ? { status: 429 } : { status: 200, json: b.inputs.map(() => vec()) }), 50)
  const storm = Promise.all([embedTexts(['bulk a']), embedTexts(['bulk b'])].map((p) => p.catch(() => null)))
  await new Promise((r) => setTimeout(r, 300)) // let the storm get going
  const ts = Date.now()
  const search = await embedQuery('live user search')
  const searchMs = Date.now() - ts
  check('a live search is NOT starved by an indexing rate-limit storm', search.length === 384 && searchMs < 2000, `answered in ${searchMs} ms while bulk batches back off`)
  await storm

  fake((_n, b) => ({ status: 200, json: b.inputs.map(() => vec()) }), 150)
  await Promise.all(Array.from({ length: 10 }, (_, i) => embedTexts([`text ${i}`])))
  check('10 simultaneous callers capped at HF_MAX_CONCURRENT=2', peak === 2, `peak ${peak} in flight (was unbounded)`)

  fake((_n, b) => ({ status: 200, json: b.inputs.map(() => vec(768)) }))
  let dimErr = ''
  try { await embedQuery('q') } catch (e) { dimErr = (e as Error).message }
  check('wrong vector size rejected with a clear config message', /HF_EMBEDDING_DIM/.test(dimErr), dimErr.slice(0, 90))
  globalThis.fetch = realFetch

  // ── FIX 9 + 10: indexing core — outcomes, size guard, failures recorded ────
  console.log('\n## Fixes 9-10 — indexing core reports real outcomes')
  const { indexFile } = await import('../lib/rag/index-core')
  const saved: Array<{ status: string; error: string | null }> = []
  const tracker = {
    find: async () => null,
    save: async (_k: unknown, d: { status: string; error: string | null }) => { saved.push(d) },
  }
  const base = { organizationId: 'trijya', server: 'WD', collection: 'test', tracker, enabled: true }
  const off = await indexFile({ ...base, enabled: false, path: '/a.pdf', bytes: Buffer.from('x') })
  check('disabled -> "skipped" (not reported as indexed)', off.status === 'skipped')
  const huge = await indexFile({ ...base, path: '/utility data/By_Laws/NBC.pdf', bytes: Buffer.alloc(2 * 1_048_576) })
  check('over-size file -> "failed" with the reason, never parsed', huge.status === 'failed' && /over the 1 MB/.test(huge.reason),
    huge.status === 'failed' ? huge.reason : huge.status)
  check('  and recorded as FAILED in the tracking table', saved.at(-1)?.status === 'FAILED')
  const bad = await indexFile({ ...base, path: '/utility data/By_Laws/scan.pdf', bytes: Buffer.from('%PDF-1.4\n%%EOF') })
  check('unreadable PDF -> "failed" (was: error text embedded, marked INDEXED)', bad.status === 'failed', bad.status === 'failed' ? bad.reason.slice(0, 70) : bad.status)
  check('  recorded FAILED with the real reason', saved.at(-1)?.status === 'FAILED' && !!saved.at(-1)?.error)
  // Make HF succeed, so the only thing missing is Qdrant.
  globalThis.fetch = (async (_u: unknown, init: any) =>
    new Response(JSON.stringify(JSON.parse(init.body).inputs.map(() => vec())), { status: 200 })) as typeof fetch
  const noQdrant = await indexFile({ ...base, path: '/utility data/By_Laws/ok.txt', bytes: Buffer.from('A real bylaw clause about setbacks.') })
  check('Qdrant unreachable -> "failed", not silently "indexed"', noQdrant.status === 'failed' && /QDRANT_URL/.test(noQdrant.reason),
    noQdrant.status === 'failed' ? noQdrant.reason.slice(0, 60) : noQdrant.status)
  globalThis.fetch = realFetch

  // ── Large/scanned PDFs: connector-side extraction (feature C/D) ───────────
  // Qdrant is deliberately unconfigured in this suite (see file header), so a
  // preExtracted job can't reach "indexed" here — it can only prove it skips
  // the byte-size guard and extractForIndex entirely and reaches the SAME
  // Qdrant-not-configured failure the bytes-based path hits (fixes 9-10
  // above), rather than failing on size or extraction. The "indexed, with an
  // OCR warning on the tracker row" result needs a live Qdrant to verify.
  console.log('\n## Connector text extraction — large PDFs + OCR fallback')
  globalThis.fetch = (async (_u: unknown, init: any) =>
    new Response(JSON.stringify(JSON.parse(init.body).inputs.map(() => vec())), { status: 200 })) as typeof fetch
  const preText = await indexFile({
    ...base, path: '/utility data/By_Laws/NBC-vol-1.pdf', // listed size would be ~53 MB, well over MAX_INDEX_BYTES
    preExtracted: { text: 'A real bylaw clause about setbacks and height limits.', truncated: false, method: 'text' },
  })
  check('preExtracted text skips the byte-size guard and extractForIndex entirely',
    preText.status === 'failed' && /QDRANT_URL/.test(preText.reason),
    `${preText.status}: ${preText.status === 'failed' ? preText.reason.slice(0, 50) : ''} (no bytes were ever checked, no "over the 1 MB")`)
  const ocrOutcome = await indexFile({
    ...base, path: '/utility data/By_Laws/scan.pdf',
    preExtracted: { text: 'Recovered via OCR: setback shall be 4.5 metres.', truncated: false, method: 'ocr' },
  })
  check('OCR-recovered preExtracted text takes the same path, not reported as "needs OCR" again',
    ocrOutcome.status === 'failed' && /QDRANT_URL/.test(ocrOutcome.reason), ocrOutcome.status === 'failed' ? ocrOutcome.reason.slice(0, 50) : ocrOutcome.status)
  globalThis.fetch = realFetch

  console.log('\n## nasExtractText — retries connector 5xx, gives up with a clear reason')
  let extractCalls = 0
  globalThis.fetch = (async () => { extractCalls++; return new Response('', { status: 503 }) }) as typeof fetch
  const extractTimer = Date.now()
  const gaveUpExtract = await asTrijya(() => client.nasExtractText('WD', '/big.pdf'))
  check('503 is retried a few times, then fails with a readable reason (not a thrown exception)',
    !gaveUpExtract.ok && /after 3 attempts/.test(gaveUpExtract.ok ? '' : gaveUpExtract.reason) && extractCalls === 3,
    `${extractCalls} attempts in ${Date.now() - extractTimer} ms`)
  extractCalls = 0
  globalThis.fetch = (async () => { extractCalls++; return new Response(JSON.stringify({ ok: false, reason: 'only .pdf is supported by /extract' }), { status: 200 }) }) as typeof fetch
  const notPdf = await asTrijya(() => client.nasExtractText('WD', '/x.docx'))
  check('a connector-reported failure passes straight through, no retry wasted', !notPdf.ok && extractCalls === 1, notPdf.ok ? '' : notPdf.reason)
  extractCalls = 0
  globalThis.fetch = (async () => { extractCalls++; return new Response(JSON.stringify({ ok: true, text: 'Extracted text.', method: 'text', truncated: false }), { status: 200 }) }) as typeof fetch
  const okExtract = await asTrijya(() => client.nasExtractText('WD', '/ok.pdf'))
  check('a successful extraction is returned as-is', okExtract.ok && okExtract.text === 'Extracted text.' && okExtract.method === 'text')
  globalThis.fetch = realFetch

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
}
main().catch((e) => { console.error('HARNESS CRASHED:', e); process.exit(1) })
