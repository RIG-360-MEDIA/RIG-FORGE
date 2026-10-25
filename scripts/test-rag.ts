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
// TRIJYA_NAS_BASE_URL is set above, which would send embeddings to the
// connector first; the API-based checks below expect the API, and the
// connector checks switch this on themselves.
process.env.RAG_EMBED_VIA_CONNECTOR = 'false'
// Extraction jobs are polled; keep the fake connector's polling fast.
process.env.NAS_EXTRACT_POLL_MS = '5'
process.env.NAS_EXTRACT_TIMEOUT_MS = '200'

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
  const { extractForIndex, extractText, isExtractable } = await import('../lib/nas/extract')
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
  const noQdrant = await indexFile({ ...base, path: '/utility data/By_Laws/ok.txt', bytes: Buffer.from('A real bylaw clause about front and side setbacks for plots.') })
  check('Qdrant unreachable -> "failed", not silently "indexed"', noQdrant.status === 'failed' && /QDRANT_URL/.test(noQdrant.reason),
    noQdrant.status === 'failed' ? noQdrant.reason.slice(0, 60) : noQdrant.status)
  globalThis.fetch = realFetch

  // ── Near-empty chunks are not indexed ─────────────────────────────────────
  // On multilingual-e5-large, chunks like ",2016", "(Ss)" or a column of
  // numbers scored 0.81-0.82 against ANY query (even "xyzzy quantum banana
  // spaceship"), above RAG_MIN_SCORE and close to real hits.
  console.log('\n## Near-empty chunks (number tables, stray headers) are not indexed')
  const { hasEnoughText, letterCount, substantiveChunks, MIN_CHUNK_LETTERS } = await import('../lib/rag/chunk')
  check('default threshold is 40 letters', MIN_CHUNK_LETTERS === 40, String(MIN_CHUNK_LETTERS))
  // Real junk texts from trijya_bylaws_e5 (14 Oct 2026).
  const junkTexts = [',2016', '(Ss)', '9.38 \n14.20 \n15.00 \n15.00 \n1  200 \n2.22 \n4.02 \n6.28 \n8.99 \n13.61',
    'Clear Design Sky\n\n(Clause B-1.1)\n\n07\n\n(8)\n\n08\n\n9)\n\n0.9\n\n(10)\n\n1.0\n\n(11)\n\n1\n\n(12)\n\n12\n\n(13)\n\n13\n\n(14)\n\n14\n\n(15)\n\n15\n\n(16)\n\n16\n\n(17)\n\nदा',
    '1496.77 1 503.22 \n1509.67 1516.13 1 522.58 \n1529.03 1 535.48 \n1541.93 \n240 \n1548.38 1554.84']
  check('junk chunks (",2016", "(Ss)", number tables) are rejected', junkTexts.every((t) => !hasEnoughText(t)), junkTexts.map(letterCount).join(','))
  check('a real English clause is kept', hasEnoughText('The minimum front setback for residential plots shall be 3.0 metres.'))
  // Devanagari vowel signs are combining marks (\p{M}), not letters (\p{L}).
  // Counting only \p{L} would under-count Hindi by about a third.
  check('Devanagari vowel signs count as letters (की = 2)', letterCount('की') === 2, String(letterCount('की')))
  const hindiClause = 'भवन की अधिकतम ऊंचाई बारह मीटर होगी तथा सेटबैक तीन मीटर रखा जाएगा।'
  check('a short real Hindi clause is kept', hasEnoughText(hindiClause), `${letterCount(hindiClause)} letters, ${(hindiClause.match(/\p{L}/gu) ?? []).length} without marks`)
  check('digits and punctuation do not count', letterCount('12.5 m, (ii) 4,500 sq.m — 30%') === 6, String(letterCount('12.5 m, (ii) 4,500 sq.m — 30%')))
  check('RAG_MIN_CHUNK_LETTERS can be overridden per call', hasEnoughText('Short heading here', 10) && !hasEnoughText('Short heading here', 40))
  const mixedChunks = substantiveChunks([{ index: 0, text: hindiClause }, { index: 1, text: ',2016' }, { index: 2, text: '(Ss)' }, { index: 3, text: 'The minimum front setback for residential plots shall be 3.0 metres.' }])
  check('junk dropped and the rest renumbered 0..n-1 (so pruneStaleChunks(n) still trims old points)',
    mixedChunks.skipped === 2 && mixedChunks.kept.map((c) => c.index).join() === '0,1' && mixedChunks.kept[1]!.text.startsWith('The minimum'), JSON.stringify(mixedChunks.kept.map((c) => c.index)))
  const allJunk = substantiveChunks([{ index: 0, text: ',2016' }])
  check('a file of nothing but junk yields no chunks (and is counted as skipped)', allJunk.kept.length === 0 && allJunk.skipped === 1)

  // End to end through indexFile: a long single-paragraph number table is
  // hard-split into pure-number chunks; none of them may reach the embedder.
  const realPara = 'Front setback for residential plots between 250 and 500 square metres shall be 4.5 metres. '.repeat(12).trim()
  const table = Array.from({ length: 700 }, (_, i) => (i * 1.37).toFixed(2)).join(' \n')
  const tailPara = 'Parking shall be provided at one equivalent car space for every 100 square metres of built-up area.'
  const tableDoc = `${realPara}\n\n${table}\n\n${tailPara}`
  const rawChunks = chunkText(tableDoc)
  const embedded: string[] = []
  globalThis.fetch = (async (_u: unknown, init: any) => {
    const inputs: string[] = JSON.parse(init.body).inputs
    embedded.push(...inputs)
    return new Response(JSON.stringify(inputs.map(() => vec())), { status: 200 })
  }) as typeof fetch
  await indexFile({ ...base, path: '/utility data/By_Laws/table.txt', bytes: Buffer.from(tableDoc) })
  globalThis.fetch = realFetch
  check('indexFile embeds no near-empty chunk', embedded.length > 0 && embedded.every((t) => letterCount(t) >= 40),
    `${rawChunks.length} chunks, ${embedded.length} embedded, min ${Math.min(...embedded.map(letterCount))} letters`)
  check('  at least one pure-number chunk was dropped', rawChunks.some((c) => !hasEnoughText(c.text)) && embedded.length < rawChunks.length)
  check('  the real text on both sides of the table is still embedded', embedded.some((t) => t.includes('Front setback')) && embedded.some((t) => t.includes('Parking shall')))

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
    preExtracted: { text: 'Recovered via OCR: the front setback shall be 4.5 metres for residential plots.', truncated: false, method: 'ocr' },
  })
  check('OCR-recovered preExtracted text takes the same path, not reported as "needs OCR" again',
    ocrOutcome.status === 'failed' && /QDRANT_URL/.test(ocrOutcome.reason), ocrOutcome.status === 'failed' ? ocrOutcome.reason.slice(0, 50) : ocrOutcome.status)
  globalThis.fetch = realFetch

  console.log('\n## nasExtractText — job-based: start, poll, and every way it can go wrong')
  // Fake connector for the job protocol: POST /extract/jobs starts (or joins)
  // a job, GET /extract/jobs/{id} reports it. `script` lists the replies in order.
  let extractCalls: string[] = []
  const connector = (script: Array<() => Response>) => {
    let i = 0
    return (async (u: unknown, init?: RequestInit) => {
      extractCalls.push(`${init?.method ?? 'GET'} ${new URL(String(u)).pathname}`)
      const next = script[Math.min(i++, script.length - 1)]!
      return next()
    }) as typeof fetch
  }
  const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
  const job = (state: string, result?: unknown) => json({ id: 'j1', state, ...(result !== undefined && { result }) })

  extractCalls = []
  globalThis.fetch = connector([() => new Response('', { status: 503 })])
  const startGaveUp = await asTrijya(() => client.nasExtractText('WD', '/big.pdf'))
  check('start: 503 retried 3 times, then a readable failure (never a thrown exception)',
    !startGaveUp.ok && /after 3 attempts/.test(startGaveUp.reason) && extractCalls.length === 3, `${extractCalls.length} calls`)

  extractCalls = []
  globalThis.fetch = connector([json({ detail: 'Not Found' }, 404)])
  const oldConnector = await asTrijya(() => client.nasExtractText('WD', '/big.pdf'))
  check('connector without job support (404): clear "update the connector" reason, no retries',
    !oldConnector.ok && /update the connector/.test(oldConnector.reason) && extractCalls.length === 1)

  extractCalls = []
  globalThis.fetch = connector([job('done', { ok: false, reason: 'PDF could not be opened: FileDataError' })])
  const reported = await asTrijya(() => client.nasExtractText('WD', '/bad.pdf'))
  check('a connector-reported failure passes straight through, one request',
    !reported.ok && /could not be opened/.test(reported.reason) && extractCalls.length === 1)

  extractCalls = []
  globalThis.fetch = connector([job('queued'), job('running'), job('done', { ok: true, text: 'Extracted text.', method: 'ocr', truncated: true })])
  const polled = await asTrijya(() => client.nasExtractText('WD', '/scan.pdf'))
  check('queued -> running -> done: polled with short requests, result returned',
    polled.ok && polled.text === 'Extracted text.' && polled.method === 'ocr' && polled.truncated === true
      && extractCalls.join() === 'POST /extract/jobs,GET /extract/jobs/j1,GET /extract/jobs/j1', extractCalls.join())

  extractCalls = []
  globalThis.fetch = connector([json({ ok: true, text: 'old-style direct reply', method: 'text', truncated: false })])
  const malformed = await asTrijya(() => client.nasExtractText('WD', '/x.pdf'))
  check('a reply that is not a job fails FAST (no polling until the deadline)',
    !malformed.ok && /unexpected reply/.test(malformed.reason) && extractCalls.length === 1)

  extractCalls = []
  globalThis.fetch = connector([job('queued'), () => new Response('{"id":"j1","state":"do', { status: 200 }), job('done', { ok: true, text: 'Big OCR text.', method: 'ocr', truncated: false })])
  const cutOff = await asTrijya(() => client.nasExtractText('WD', '/big-scan.pdf'))
  check('a final reply cut off mid-download is fetched again, not reported as failed', cutOff.ok && cutOff.text === 'Big OCR text.' && extractCalls.length === 3, extractCalls.join())

  extractCalls = []
  globalThis.fetch = connector([job('running'), json({ detail: 'no such extraction job' }, 404)])
  const lost = await asTrijya(() => client.nasExtractText('WD', '/x.pdf'))
  check('job vanished (connector restarted): reported, a later retry starts again', !lost.ok && /was lost/.test(lost.reason))

  extractCalls = []
  globalThis.fetch = connector([job('running')])
  const slow = await asTrijya(() => client.nasExtractText('WD', '/huge-scan.pdf'))
  check('still running at the deadline: gives up with "a later retry will pick up the result"',
    !slow.ok && /still running/.test(slow.reason), `${extractCalls.length} calls`)

  extractCalls = []
  globalThis.fetch = connector([job('running'), () => new Response('', { status: 502 })])
  const flaky = await asTrijya(() => client.nasExtractText('WD', '/x.pdf'))
  check('5 failed polls in a row: stops with "lost contact"', !flaky.ok && /lost contact/.test(flaky.reason) && extractCalls.length === 6, `${extractCalls.length} calls`)
  globalThis.fetch = realFetch

  // ── fetchAndIndexFile — branch selection (K/E/F's shared helper) ──────────
  console.log('\n## fetchAndIndexFile — size-based branch selection, and OCR for small scans')
  const { fetchAndIndexFile } = await import('../lib/rag/fetch-and-index')
  const fakeIndexerCalls: Array<{ bytesOrText: unknown }> = []
  let indexerReplies: Array<Record<string, unknown>> = []
  const fakeIndexer = async (_org: string, _server: string, _path: string, bytesOrText: unknown) => {
    fakeIndexerCalls.push({ bytesOrText })
    return (indexerReplies.shift() ?? { status: 'indexed', chunks: 1 }) as { status: 'indexed'; chunks: number }
  }
  const bytesReply = () => new Response(new Uint8Array(10), { status: 200, headers: { 'content-length': '10' } })

  fakeIndexerCalls.length = 0
  globalThis.fetch = (async () => bytesReply()) as typeof fetch
  const smallFile = await asTrijya(() => fetchAndIndexFile({ organizationId: 'trijya', server: 'WD', path: '/small.txt', size: 10, indexer: fakeIndexer }))
  check('under the size limit -> fetches bytes, calls the indexer with a Buffer', smallFile.status === 'indexed' && Buffer.isBuffer(fakeIndexerCalls[0]?.bytesOrText))

  fakeIndexerCalls.length = 0
  const bigNonPdf = await asTrijya(() => fetchAndIndexFile({ organizationId: 'trijya', server: 'WD', path: '/big.docx', size: 5_000_000, indexer: fakeIndexer }))
  check('over the limit, not a PDF -> skipped as too large, indexer never called', bigNonPdf.status === 'skipped' && 'tooLarge' in bigNonPdf && fakeIndexerCalls.length === 0, bigNonPdf.status)

  fakeIndexerCalls.length = 0
  globalThis.fetch = connector([job('done', { ok: true, text: 'extracted text', method: 'text', truncated: false })])
  const bigPdfOk = await asTrijya(() => fetchAndIndexFile({ organizationId: 'trijya', server: 'WD', path: '/big.pdf', size: 5_000_000, indexer: fakeIndexer }))
  check('over the limit, PDF, connector extraction succeeds -> indexer called with preExtracted text (no bytes fetched)',
    bigPdfOk.status === 'indexed' && !Buffer.isBuffer(fakeIndexerCalls[0]?.bytesOrText) && (fakeIndexerCalls[0]?.bytesOrText as { text: string })?.text === 'extracted text')

  fakeIndexerCalls.length = 0
  globalThis.fetch = connector([job('done', { ok: false, reason: 'pymupdf missing' })])
  const bigPdfFail = await asTrijya(() => fetchAndIndexFile({ organizationId: 'trijya', server: 'WD', path: '/big.pdf', size: 5_000_000, indexer: fakeIndexer }))
  check('over the limit, PDF, connector extraction fails -> falls back to skippedTooLarge, reason mentions why',
    bigPdfFail.status === 'skipped' && 'tooLarge' in bigPdfFail && /pymupdf missing/.test(bigPdfFail.reason) && fakeIndexerCalls.length === 0)

  // A small scanned PDF: parses here but has no text, so only the connector can OCR it.
  fakeIndexerCalls.length = 0
  indexerReplies = [{ status: 'failed', reason: 'PDF has no selectable text (likely scanned images; needs OCR)', connector: true }]
  let step = 0
  globalThis.fetch = (async () => (step++ === 0 ? bytesReply() : job('done', { ok: true, text: 'setback 4.5 m', method: 'ocr', truncated: false })())) as typeof fetch
  const smallScan = await asTrijya(() => fetchAndIndexFile({ organizationId: 'trijya', server: 'WD', path: '/scan.pdf', size: 10, indexer: fakeIndexer }))
  const second = fakeIndexerCalls[1]?.bytesOrText as { text?: string; method?: string } | undefined
  check('small scanned PDF -> sent to the connector for OCR, then indexed from the OCR text',
    smallScan.status === 'indexed' && fakeIndexerCalls.length === 2 && second?.method === 'ocr' && second.text === 'setback 4.5 m')

  fakeIndexerCalls.length = 0
  indexerReplies = [{ status: 'failed', reason: 'PDF could not be parsed: bad XRef entry', connector: true }]
  step = 0
  globalThis.fetch = (async () => (step++ === 0 ? bytesReply() : job('done', { ok: true, text: 'read by PyMuPDF', method: 'text', truncated: false })())) as typeof fetch
  const unparseable = await asTrijya(() => fetchAndIndexFile({ organizationId: 'trijya', server: 'WD', path: '/odd-producer.pdf', size: 10, indexer: fakeIndexer }))
  check('a PDF the local parser rejects -> read by the connector instead, then indexed',
    unparseable.status === 'indexed' && (fakeIndexerCalls[1]?.bytesOrText as { text?: string })?.text === 'read by PyMuPDF')
  const localBad = await (await import('../lib/nas/extract')).extractForIndex('x.pdf', Buffer.from('%PDF-1.4 garbage'))
  check('local PDF parse failure is flagged for the connector', !localBad.ok && localBad.connector === true)

  fakeIndexerCalls.length = 0
  indexerReplies = [{ status: 'failed', reason: 'Qdrant is not configured (QDRANT_URL)' }]
  globalThis.fetch = (async () => bytesReply()) as typeof fetch
  const corruptSmall = await asTrijya(() => fetchAndIndexFile({ organizationId: 'trijya', server: 'WD', path: '/corrupt.pdf', size: 10, indexer: fakeIndexer }))
  check('a failure that is not about reading the PDF (e.g. Qdrant down) is NOT sent to the connector', corruptSmall.status === 'failed' && fakeIndexerCalls.length === 1)

  fakeIndexerCalls.length = 0
  indexerReplies = [{ status: 'failed', reason: 'PDF has no selectable text (likely scanned images; needs OCR)', connector: true }]
  step = 0
  globalThis.fetch = (async () => (step++ === 0 ? bytesReply() : job('done', { ok: false, reason: 'OCR found no readable text on this PDF' })())) as typeof fetch
  const scanFail = await asTrijya(() => fetchAndIndexFile({ organizationId: 'trijya', server: 'WD', path: '/blank-scan.pdf', size: 10, indexer: fakeIndexer }))
  check('scan the connector cannot read either -> failed, reason names both', scanFail.status === 'failed' && /needs OCR/.test(scanFail.reason) && /OCR found no readable text/.test(scanFail.reason))
  globalThis.fetch = realFetch

  // ── searchChunksHybrid's re-ranking — pure, no live Qdrant needed ─────────
  console.log('\n## rerankByKeyword — keyword boost on a synthetic candidate set')
  const { rerankByKeyword } = await import('../lib/rag/qdrant')
  const synthetic = [
    { score: 0.60, text: 'Clause 40: Maximum building height for a residential zone is 15 metres.', path: 'height.txt' },
    { score: 0.55, text: 'Clause 12: The minimum front setback from the road boundary shall be 4.5 metres.', path: 'setback.txt' },
    { score: 0.52, text: 'Clause 7: Parking shall be provided at one space per 50 square metres.', path: 'parking.txt' },
  ]
  const noOverlap = rerankByKeyword(synthetic, 'zzz qqq xyz', 3)
  check('no keyword overlap -> pure vector order preserved, matchType "vector"', noOverlap.map((h) => h.path).join(',') === 'height.txt,setback.txt,parking.txt' && noOverlap.every((h) => h.matchType === 'vector'))
  const boosted = rerankByKeyword(synthetic, 'setback road boundary', 3)
  check('keyword-matching passage (lower cosine score) is boosted above a pure-vector match', boosted[0]!.path === 'setback.txt', boosted.map((h) => `${h.path}:${h.matchType}`).join(', '))
  const truncated = rerankByKeyword(synthetic, 'setback', 1)
  check('still truncates to `limit` after re-ranking', truncated.length === 1 && truncated[0]!.path === 'setback.txt')

  // ── Review fixes (round 4) — the pure parts; the database parts were
  // tested live against Postgres, see docs/RAG_BACKLOG_CHANGES.md ──────────
  console.log('\n## Round 4 — keyword boost works for Hindi too')
  const hindi = [
    { score: 0.60, text: 'अधिकतम भवन ऊंचाई 15 मीटर होगी।', path: 'height-hi.txt' },
    { score: 0.55, text: 'सड़क सीमा से न्यूनतम अग्र सेटबैक 6 मीटर होगा।', path: 'setback-hi.txt' },
  ]
  const hiBoost = rerankByKeyword(hindi, 'सड़क सेटबैक', 2)
  check('a Hindi query boosts the Hindi passage that shares its words (was ignored: /[a-z0-9]+/ dropped all Hindi)',
    hiBoost[0]!.path === 'setback-hi.txt' && hiBoost[0]!.matchType === 'hybrid', hiBoost.map((h) => `${h.path}:${h.matchType}`).join(', '))
  const decomposed = 'सड़क'.normalize('NFD')
  check('Unicode normalisation: the same word typed in decomposed form still matches',
    rerankByKeyword(hindi, `${decomposed} सेटबैक`, 2)[0]!.path === 'setback-hi.txt')
  check('English re-ranking unchanged', rerankByKeyword(synthetic, 'setback road boundary', 3)[0]!.path === 'setback.txt')

  console.log('\n## Round 4 — E5 input prefixes')
  const { inputPrefixes } = await import('../lib/rag/embeddings')
  check('multilingual-e5-large gets "query: " / "passage: "',
    JSON.stringify(inputPrefixes('intfloat/multilingual-e5-large')) === JSON.stringify({ query: 'query: ', passage: 'passage: ' }))
  check('bge-small (the production model) still gets no prefix',
    JSON.stringify(inputPrefixes('BAAI/bge-small-en-v1.5')) === JSON.stringify({ query: '', passage: '' }))
  check('-instruct E5 variants are not auto-prefixed (different query format)',
    inputPrefixes('intfloat/multilingual-e5-large-instruct').query === '')
  let sentInputs: string[] = []
  globalThis.fetch = (async (_u: unknown, init: any) => {
    sentInputs = JSON.parse(init.body).inputs
    return new Response(JSON.stringify(sentInputs.map(() => vec())), { status: 200 })
  }) as typeof fetch
  await embedQuery('front setback')
  check('with the default model, a query is sent exactly as typed', sentInputs[0] === 'front setback', JSON.stringify(sentInputs))
  globalThis.fetch = realFetch

  console.log('\n## Round 4 — retry backoff and stale backfill runs')
  const { retryDelayMs } = await import('../lib/rag/retry-queue')
  check('retry backoff: 15 min, 1 h, 4 h, 16 h, then capped at 24 h',
    [1, 2, 3, 4, 5, 10].map((n) => retryDelayMs(n) / 60_000).join() === '15,60,240,960,1440,1440')
  const { isStale, runView, RUN_STALE_MS } = await import('../lib/rag/reindex-runs')
  const now = Date.now()
  const runRow = (status: 'RUNNING' | 'DONE', ageMs: number) => ({
    id: 'r', organizationId: 'trijya', status, startedAt: new Date(now - ageMs), finishedAt: null,
    heartbeatAt: new Date(now - ageMs), results: null, error: null,
  })
  check('a RUNNING run with a recent heartbeat is live', !isStale(runRow('RUNNING', 30_000), now))
  check('a RUNNING run silent past the stale window is interrupted', isStale(runRow('RUNNING', RUN_STALE_MS + 1000), now))
  check('a finished run is never "stale"', !isStale(runRow('DONE', 10 * RUN_STALE_MS), now))
  check('the admin sees an interrupted run as "interrupted", with what to do', runView(runRow('RUNNING', RUN_STALE_MS + 1000)).status === 'interrupted'
    && /Start the backfill again/.test(String(runView(runRow('RUNNING', RUN_STALE_MS + 1000)).error)))

  console.log('\n## Round 4 — the crawl reports whether it reached the end')
  const { listFilesRecursiveWithStatus } = await import('../lib/nas/bylaws-crawl')
  const crawlTree: Record<string, Array<{ name: string; isDir: boolean; size: number }>> = {
    '/A': [{ name: '1.txt', isDir: false, size: 1 }, { name: 'sub', isDir: true, size: 0 }],
    '/A/sub': [{ name: '2.txt', isDir: false, size: 1 }, { name: '3.txt', isDir: false, size: 1 }],
  }
  globalThis.fetch = (async (u: unknown) => {
    const p = new URL(String(u)).searchParams.get('path')!
    return new Response(JSON.stringify({ path: p, items: (crawlTree[p] ?? []).map((i) => ({ ...i, mtime: 0 })) }), { status: 200 })
  }) as typeof fetch
  const whole = await asTrijya(() => listFilesRecursiveWithStatus('WD', '/A', 10))
  check('small folder: every file, complete', whole.complete && whole.files.length === 3)
  const capped = await asTrijya(() => listFilesRecursiveWithStatus('WD', '/A', 2))
  check('over the cap: exactly the cap returned and complete=false (so nothing gets pruned)', !capped.complete && capped.files.length === 2)
  const exact = await asTrijya(() => listFilesRecursiveWithStatus('WD', '/A/sub', 2))
  check('exactly at the cap with nothing left to visit: still complete', exact.complete && exact.files.length === 2)
  globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof fetch
  let crawlThrew = false
  try { await asTrijya(() => listFilesRecursiveWithStatus('WD', '/A', 10)) } catch { crawlThrew = true }
  check('a listing error throws (never a silently partial list)', crawlThrew)
  globalThis.fetch = realFetch

  // ── Embeddings: NAS connector first, HuggingFace API as the fallback ──────
  console.log('\n## Embeddings — connector first, API fallback')
  {
    const emb = await import('../lib/rag/embeddings')
    process.env.RAG_EMBED_VIA_CONNECTOR = 'true'
    const calls: Array<{ host: string; n: number }> = []
    let connectorReply: (texts: string[]) => Response = (texts) =>
      new Response(JSON.stringify({ model: 'BAAI/bge-small-en-v1.5', dim: 384, vectors: texts.map(() => vec()) }), { status: 200 })
    globalThis.fetch = (async (u: unknown, init: any) => {
      const url = String(u), body = JSON.parse(init.body)
      if (url.endsWith('/embed')) { calls.push({ host: 'connector', n: body.texts.length }); return connectorReply(body.texts) }
      calls.push({ host: 'api', n: body.inputs.length })
      return new Response(JSON.stringify(body.inputs.map(() => vec())), { status: 200 })
    }) as typeof fetch

    emb.resetEmbeddingConnectorPause(); calls.length = 0
    const v100 = await emb.embedTexts(Array.from({ length: 100 }, (_, i) => `passage ${i}`))
    check('100 passages: 2 connector requests (64 + 36), the API never called',
      v100.length === 100 && calls.map((c) => `${c.host}:${c.n}`).join() === 'connector:64,connector:36', calls.map((c) => `${c.host}:${c.n}`).join())

    let sentModel = ''
    connectorReply = (texts) => new Response(JSON.stringify({ vectors: texts.map(() => vec()) }), { status: 200 })
    const realFetch2 = globalThis.fetch
    globalThis.fetch = (async (u: unknown, init: any) => { if (String(u).endsWith('/embed')) sentModel = JSON.parse(init.body).model; return realFetch2(u as string, init) }) as typeof fetch
    await emb.embedQuery('front setback')
    check('the connector is told which model Forge expects', sentModel === 'BAAI/bge-small-en-v1.5', sentModel)
    globalThis.fetch = realFetch2

    emb.resetEmbeddingConnectorPause(); calls.length = 0
    connectorReply = () => new Response('busy', { status: 503 })
    const fb = await emb.embedTexts(Array.from({ length: 20 }, (_, i) => `p${i}`))
    check('connector error: that batch goes to the API instead (in API-sized batches)',
      fb.length === 20 && calls.map((c) => `${c.host}:${c.n}`).join() === 'connector:20,api:16,api:4', calls.map((c) => `${c.host}:${c.n}`).join())
    calls.length = 0
    await emb.embedQuery('q')
    check('...and the connector is skipped for a while, not retried on every request', calls.map((c) => c.host).join() === 'api')

    emb.resetEmbeddingConnectorPause(); calls.length = 0
    connectorReply = () => new Response('this connector serves X, not Y', { status: 400 })
    await emb.embedQuery('q')
    check('wrong model on the connector: refused, API used', calls.map((c) => c.host).join() === 'connector,api')

    emb.resetEmbeddingConnectorPause(); calls.length = 0
    connectorReply = (texts) => new Response(JSON.stringify({ vectors: texts.map(() => vec(768)) }), { status: 200 })
    const dimSafe = await emb.embedQuery('q')
    check('wrong-sized vectors from the connector are never used', dimSafe.length === 384 && calls.map((c) => c.host).join() === 'connector,api')

    emb.resetEmbeddingConnectorPause(); calls.length = 0
    process.env.RAG_EMBED_VIA_CONNECTOR = 'false'
    await emb.embedQuery('q')
    check('RAG_EMBED_VIA_CONNECTOR=false: API only', calls.map((c) => c.host).join() === 'api')
    emb.resetEmbeddingConnectorPause()
    globalThis.fetch = realFetch
  }

  // ── Broken text layers (legacy Hindi fonts, glyphs with no character map) ─
  console.log('\n## Readability — garbage text layers are not indexed as text')
  {
    const { readableText, unreadableShare, UNREADABLE_DOC_SHARE } = await import('../lib/nas/readability')
    // Real samples from Trijya's bylaws index, October 2026.
    const english = 'The minimum front setback for plots above 500 square metres shall be 6 metres from the road boundary, and the side setback shall be 3 metres.'
    const kruti = "rqrg gi qqr RtRrg glB-fr-{ur, i6{rg I , ffirtrtilug I flfFqtwr, sfrrwq5 | ft'lTrq, trsrq{ rqrg gi qqr RtRrg"
    const glyphs = ':5!6.!-7;\n99=*1..#"9a9<1#9"/,0#.9352=,"#9/=901#976,339",-9:#9>/3!0!/-#.\n/-901#9/50#29/2901#9!--#29=,"#9/=901#9'
    const hindi = '500 वर्ग मीटर से अधिक के आवासीय भूखंडों के लिए सड़क सीमा से न्यूनतम अग्र सेटबैक 6 मीटर होगा।'
    check('English text is readable', readableText(english))
    check('Unicode Hindi is readable', readableText(hindi))
    check('legacy Hindi font text (Kruti Dev style) is NOT readable', !readableText(kruti))
    check('glyph codes with no character map are NOT readable', !readableText(glyphs))
    check('an empty / near-empty page is NOT readable (a scan)', !readableText('  \n 12 \n'))
    const normalDoc = Array.from({ length: 9 }, () => english.repeat(11)).join('\n') + kruti.repeat(14)
    const brokenDoc = Array.from({ length: 6 }, () => kruti.repeat(14)).join('\n') + english.repeat(11)
    check('a normal document with one bad section stays below the threshold', unreadableShare(normalDoc) < UNREADABLE_DOC_SHARE, unreadableShare(normalDoc).toFixed(2))
    check('a mostly-garbage document is over it', unreadableShare(brokenDoc) >= UNREADABLE_DOC_SHARE, unreadableShare(brokenDoc).toFixed(2))

    // The connector's "mixed" result and its note come through to the indexer.
    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ id: 'j9', state: 'done', result: { ok: true, text: 'Recovered text.', method: 'mixed', truncated: false, note: "800 of 1100 pages unreadable and not OCR'd (NAS_OCR_MAX_PAGES=300); left out" } }), { status: 200 }) }) as typeof fetch
    const mixed = await asTrijya(() => client.nasExtractText('WD', '/nbc-digital.pdf'))
    check('connector "mixed" (some pages OCR\'d) is treated as OCR, and its note is kept',
      mixed.ok && mixed.method === 'ocr' && /800 of 1100 pages/.test(mixed.note ?? ''), JSON.stringify(mixed).slice(0, 120))
    globalThis.fetch = realFetch
  }

  // ── .docx extraction (feature I) ──────────────────────────────────────────
  console.log('\n## .docx extraction')
  const mammothMod = await import('mammoth')
  check('mammoth loads under tsx without a pdf-parse-style bundler workaround', typeof mammothMod.default.extractRawText === 'function')
  check('.docx is now in EXTRACTABLE (isExtractable picks it up for free)', isExtractable('plan.docx'))
  const notActuallyDocx = await extractForIndex('plan.docx', Buffer.from('not a real zip/docx'))
  check('garbage bytes reported as a FAILURE, not embedded as content (same pattern as the PDF branch)', !notActuallyDocx.ok, notActuallyDocx.ok ? `returned text: ${notActuallyDocx.text.slice(0, 40)}` : notActuallyDocx.reason)
  const stillMd = await extractForIndex('readme.md', Buffer.from('# hi'))
  check('adding .docx did not affect other extensions', stillMd.ok && stillMd.text.includes('# hi'))

  // ── Whole-question matching: topic AND plot area (query-match.ts) ─────────
  console.log('\n## Whole-question matching (topic + plot area, all required)')
  {
    const qm = await import('../lib/rag/query-match')
    const a1 = qm.analyzeQuery('FAR for 2000 sq meter plot')
    check('"FAR for 2000 sq meter plot" -> topic FAR and area 2000', a1.topics.join() === 'far' && a1.area === 2000, JSON.stringify(a1))
    const a2 = qm.analyzeQuery('2000 वर्गमीटर भूखंड का एफ.ए.आर.')
    check('the same question in Hindi -> FAR and 2000', a2.topics.join() === 'far' && a2.area === 2000, JSON.stringify(a2))
    const a3 = qm.analyzeQuery('setback and parking for a 1,500 sqm plot')
    check('two topics and a comma number are all required', a3.topics.join() === 'setback,parking' && a3.area === 1500, JSON.stringify(a3))
    check('a plain question is not constrained', !qm.isConstrained(qm.analyzeQuery('what does the bylaw say about green buildings')))

    // Real passages from trijya_bylaws_e5 (202504161857302632Bylaws_160425.pdf).
    const farTable = '4.1.6 Ground Coverage and FAR The ground coverage and FAR of the buildings shall be as follows: Plot Area (sqm) Ground Coverage (%) Base FAR Max. Permissible FAR ≥40 to 150 Max. coverage after ensuring setbacks 2.00 2.0 >150 to 300 Max. coverage after ensuring setbacks 1.80 2.0 >300 to 500 Max. coverage after ensuring setbacks 1.75 2.0 >500 to1200 Max. coverage after ensuring setbacks 1.50 2.0 >1200 Max. coverage after ensuring setbacks 1.25 2.0'
    const r2000 = qm.matchPassage(farTable, a1)
    check('FAR table: a 2000 sq m plot falls in the open ">1200" row', r2000?.quality === 3 && /^>\s*1200 Max\. coverage.*1\.25 2\.0/.test(r2000?.row ?? ''), JSON.stringify(r2000))
    const r400 = qm.matchPassage(farTable, qm.analyzeQuery('FAR for 400 sqm plot'))
    check('FAR table: a 400 sq m plot falls in ">300 to 500", not a wider row', /^>300 to 500/.test(r400?.row ?? ''), JSON.stringify(r400))
    const setbackTable = 'Plot Area (sqm) Setback (meter) Front Rear Side-1 Side-2 =>100 – 300 3 1.5 0 0 >300 – 1000 4.5 3 3 0 >1000 – 2000 6 3 3 3'
    const s200 = qm.matchPassage(setbackTable, qm.analyzeQuery('setback rules for 200 sq meter plot'))
    check('setback table: 200 sq m -> the "=>100 - 300" row (3 m front, 1.5 m rear)', /=>100 - 300 3 1\.5/.test(s200?.row ?? ''), JSON.stringify(s200))
    check('setback table is NOT a match for a FAR question (both parts are required)', qm.matchPassage(setbackTable, a1) === null)
    check('FAR prose without a covering row is NOT a match for "FAR for 2000 sq m"',
      qm.matchPassage('Base FAR shall be as given in the Master Plan for each land use. Plot area (sqm) is the net area.', a1) === null)
    check('years are not area ranges ("2016-2020")', qm.coversArea('Plot area (sqm) amended 2016-2020 by G.O.', 2018) === null)
    check('dates are not area ranges ("26-08-2019")', qm.coversArea('Plot size order dated 26-08-2019', 20) === null)
    check('a height threshold (">15 m") does not cover a 200 sq m plot',
      qm.coversArea('Plot Area (sqm) for buildings >15 meter height, setback 5', 200) === null)
    check('">1200" is not used when a higher threshold below the area exists (">1500" for 2000)',
      qm.coversArea('Plot size (sqm) >1200 FAR 1.25 >1500 FAR 1.20', 2000)?.row === '>1500')
  }

  // ── The row must come from the right table (query-match.ts, Oct 2026) ────
  console.log('\n## Whole-question matching: right table, use, height / road width, Hindi ranges')
  {
    const qm = await import('../lib/rag/query-match')
    const { cleanPassage } = await import('../lib/rag/chunk')
    // Real text, 202504161857302632Bylaws_160425.pdf: the residential table and
    // the healthcare table have the same shape; 200 sq m is in a row of both.
    const residential = '3.2.4.1 Residential – Plotted Development (Single/Multi-units up to 15-meter height) Under plotted development, for all single/multi-units less than 300 square meters plot size, three floors with stilts up to 15 meter is allowed. The set-back shall be as follows: Plot Area (sqm) Setback (meter) Front Rear Side-1 Side-2 (a) Row-housing Up to 150 1 0 0 0 >150 to 300 3 1.5 0 0 >300 to 500 3 3 0 0 (b) Semi-detached >500 to 1200 4.5 4.5 1.5 0 (c) Detached >1200 6 6 1.5 1.5 Note-1: Construction shall be permitted on 40 percent of the rear setback.'
    const healthcare = '3.2.4.5 Community Facilities – Healthcare buildings height up to 15-meters Plot Area (sqm) Setback (meter) Front Rear Side-1 Side-2 =>100 – 300 3 1.5 0 0 >300 – 1000 4.5 3 3 0 >1000 – 2000 6 3 3 3'
    const farTable = '3.2.2.1 Residential – Plotted Development including EWS/ LIG/ Affordable Housing Sl. Use Types Ground Coverage (%) Plot Area (sq.m.) Base FAR Max. FAR 1 Plotted Development – Single Unit/Multi-Unit (Built-up/Non-Built-up) Max. coverage after ensuring setbacks Up to 150 2.0 2.0 >150 to 300 1.8 2.0 >300 to 500 1.75 2.0 >500 to 1200 1.5 2.0 >1200 1.25 2.0 Note: Maximum Permissible FAR (MFAR) is calculated as per Chapter-9.'

    const resQ = qm.analyzeQuery('setback for a 200 sq m residential plot')
    check('"residential" is a use, 200 is the plot area', resQ.uses.join() === 'residential' && resQ.area === 200, JSON.stringify(resQ))
    const r = qm.matchPassage(residential, resQ)
    check('residential table: the ">150 to 300" row', /^>150 to 300 3 1\.5 0 0$/.test(r?.row ?? ''), JSON.stringify(r))
    check('  read out against its columns', r?.values === 'Front 3 m, Rear 1.5 m, Side-1 0 m, Side-2 0 m', r?.values)
    check('  and labelled with its clause', /^3\.2\.4\.1 Residential/.test(r?.section ?? ''), r?.section)
    check('healthcare table is NOT an answer to a residential question (same row shape)', qm.matchPassage(healthcare, resQ) === null)
    const hosp = qm.matchPassage(healthcare, qm.analyzeQuery('setback for a hospital on 1500 sqm plot'))
    check('but it is for a hospital: ">1000 - 2000"', /^>1000 - 2000 6 3 3 3/.test(hosp?.row ?? ''), JSON.stringify(hosp))
    check('"Max. coverage after ensuring setbacks" does not make a FAR table a setback table',
      qm.matchPassage(farTable, qm.analyzeQuery('setback for a 200 sq m plot')) === null)
    const far = qm.matchPassage(farTable, qm.analyzeQuery('FAR for 2000 sq m plot'))
    check('FAR table, 2000 sq m: ">1200 1.25 2.0", stopping before the note', far?.row === '>1200 1.25 2.0' && far?.values === 'Base FAR 1.25, Max. FAR 2.0', JSON.stringify(far))
    check('a ground coverage question does not get the row read out as FAR',
      qm.matchPassage(farTable, qm.analyzeQuery('ground coverage for 400 sq m plot'))?.values === undefined)

    // A table split over two passages: heading in the one before.
    const head = 'shall be as follows. 3.2.4.9 All occupancy buildings with height more than 15 meters For use occupancies with building height more than 15m, the minimum setback requirement shall be as follows. Building Height (in meters) Front (m) Rear (m) Side-1 (m) Side-2 (m) >15 – 17.5 5 5 5 5 >17.5 - 21 6 6 6 6'
    const rest = '>21 - 27 7 7 7 7 >27 - 33 8 8 8 8 >33 - 39 9 9 9 9 >39 - 45 10 10 10 10 >45 - 51 11 11 11 11 >51 15 12 12 12 Note-1: For buildings situated on two roads'
    const h40q = qm.analyzeQuery('setbacks for building height 40 meters')
    check('"building height 40 meters" is a height of 40, not a topic', h40q.height === 40 && !h40q.topics.includes('height') && h40q.topics.join() === 'setback', JSON.stringify(h40q))
    check('without the passage before, the rows have no heading: no match', qm.matchPassage(rest, h40q) === null)
    const h40 = qm.matchPassage(rest, h40q, [head])
    check('with it: ">39 - 45 10 10 10 10"', /^>39 - 45 10 10 10 10$/.test(h40?.row ?? '') && h40?.shift === 0, JSON.stringify(h40))
    check('the last row keeps its last value before "Note-1"', qm.matchPassage(rest, qm.analyzeQuery('setback for a 60 m high building'), [head])?.row === '>51 15 12 12 12')
    const fromBefore = qm.matchPassage(rest, qm.analyzeQuery('setback for a 20 m high building'), [head])
    check('a row of the same table in the passage before is found, and says where it is', /^>17\.5 - 21 6 6 6 6/.test(fromBefore?.row ?? '') && fromBefore?.shift === -1, JSON.stringify(fromBefore))

    // Road width, with rows for several uses in one table.
    const roadTable = '3.2.2.3 Commercial – Shops / Convenience Shopping / Other Commercial Sl. Use Types Ground Coverage (%) Road Width (m) Base FAR Max. FAR 3(a) Shops / Convenience Shopping / Commercial Units (Built-up) Max. coverage after ensuring setbacks Up to 12m 1.5 2.1 >12 – 24m 1.5 3 >24 – 45m 1.5 5 >45m 1.5 Unrestricted 4(a) Commercial Complex (Built-up) Max. coverage after ensuring setbacks =>18 – 24m 2 4 >24 – 45m 2 7'
    const shopQ = qm.analyzeQuery('FAR for shops on an 18 m road')
    check('"18 m road" is a road width', shopQ.road === 18 && shopQ.area === null && shopQ.topics.join() === 'far', JSON.stringify(shopQ))
    check('the row under "Shops", not the narrower one under "Commercial Complex"', /^>12 - 24m 1\.5 3/.test(qm.matchPassage(roadTable, shopQ)?.row ?? ''))

    // Units, Hindi ranges, what is not a value.
    check('2,000 sq ft is converted (185.8 sq m)', qm.analyzeQuery('setback for 2,000 sq ft plot').area === 185.81)
    check('150 gaj is converted (125.4 sq m)', Math.round(qm.analyzeQuery('setback for 150 gaj plot').area ?? 0) === 125)
    const hindiTable = '(स)-शिक्षण संस्थायें /चिकित्सा भूखण्ड का क्षेत्रफल सेट बैक (मीटर में) 1000 तक 6.0 4.5 1001 से 3000 तक 7.5 4.5 3001 से 8000 तक 9.0 6.0 35000 से अधिक 18.0 6.0'
    check('Hindi "1001 से 3000 तक" covers 2000', /^1001 से 3000 तक/.test(qm.matchPassage(hindiTable, qm.analyzeQuery('स्कूल के लिए 2000 वर्गमीटर भूखंड पर सेट बैक'))?.row ?? ''))
    check('Hindi "35000 से अधिक" covers 40000', /^35000 से अधिक/.test(qm.coversArea('भूखण्ड का क्षेत्रफल (वर्गमीटर में) 3001 से 8000 तक 9.0 35000 से अधिक 18.0', 40000)?.row ?? ''))
    check('"up to 50 percent" is a share, not a road width',
      qm.matchPassage('3.3.4.9 Podium Parking (ii) The minimum width of the road shall be 12 meters. (vi) Open space may be permitted on podium up to 50 percent.', qm.analyzeQuery('height limit on 12 m road')) === null)
    check('a sentence with a range is not a table row ("100 -300 sqm, the permissible FAR is 1.75.")',
      qm.matchPassage('3.2.2 Ground Coverage and Floor Area Ratio (FAR) For example, for plot size 100 -300 sqm, the permissible FAR is 1.75.', qm.analyzeQuery('FAR for 200 sq m plot'))?.quality === 2)

    // A question with no value: the line that states the rule for the asked use.
    const parking = '3.3.4.3 Parking standards (2) Commercial Sl. Commercial Use Type Parking Requirements in ECS/ unit area 1 Shops / Convenient Shopping / Commercial Units 1 / 100 sqm of floor area 2 Commercial Complex 2 / 100 sqm of floor area 3 Shopping mall 3 / 100 sqm of floor area 4 Hotels 2 / 100 sqm of floor area'
    const mall = qm.matchPassage(parking, qm.analyzeQuery('parking for a shopping mall'))
    check('"parking for a shopping mall": the "Shopping mall 3 / 100 sqm" line', /^3 Shopping mall 3 \/ 100 sqm of floor area$/.test(mall?.row ?? '') && mall?.quality === 2, JSON.stringify(mall))

    check('reference books rank after the bylaws and the NBC',
      qm.documentPriority('202504161857302632Bylaws_160425.pdf') > qm.documentPriority('NBC_Vol1.pdf') &&
      qm.documentPriority('NBC_Vol1.pdf') > qm.documentPriority('NBC_MBBL.pdf') &&
      qm.documentPriority('NBC_MBBL.pdf') > qm.documentPriority('Time-saver Standards for Building Types.pdf'))

    // The overlap that chunkText writes twice into a hard-split paragraph.
    const t = 'quirement shall be as follows. Building Height (in meters) Front (m) Rear (m)'
    check('cleanPassage drops the doubled overlap', cleanPassage(`${t}\n\n${t} >21 - 27 7 7 7 7`) === `${t} >21 - 27 7 7 7 7`)
    check('cleanPassage leaves ordinary text alone', cleanPassage(residential) === residential)
  }

  // ── Retrieve-then-answer: which questions are searched, and with what ─────
  console.log('\n## Chat answers from the documents (lib/rag/answer.ts)')
  {
    const ans = await import('../lib/rag/answer')
    const both = { bylaws: true, nas: true }
    const routed = (q: string) => ans.ragSourceFor(q, both)
    for (const q of [
      'FAR for a 500 sq m residential plot', 'what is the minimum staircase width', 'parking requirement for hospital',
      'what does the NBC say about fire exits', 'आवासीय भूखंड 200 वर्गमीटर पर सेटबैक कितना होगा', 'What are the setback rules?',
    ]) check(`bylaws question is searched: "${q}"`, routed(q) === 'bylaws', String(routed(q)))
    for (const q of ['what does the spec say about fire rating for the lobby', 'which contract has a penalty clause', 'what are the payment terms in the agreement with ABC'])
      check(`document question is searched: "${q}"`, routed(q) === 'nas', String(routed(q)))
    for (const q of [
      'what tasks are due this week', 'create a task for setback drawings', 'find the windlass drawings', 'where is the parking at the office',
      'what is the road project status', 'find the BOQ files', 'read the spec.pdf', 'summarize the tender document', 'hi',
    ]) check(`not a document question: "${q}"`, routed(q) === null, String(routed(q)))
    // Every chat message of the NAS company passes through the router first:
    // everyday uses of "far", "setback", "coverage", "basement", "go" and
    // "files" must reach the normal chat path.
    for (const q of [
      'how far along is the Kudal project?', 'so far what has been done on the Imperial Hotel?',
      'we had a setback on the IT park site, who is handling it', 'what is the insurance coverage for the site workers',
      'should I go ahead with the elevation drawings', 'can we go to the site tomorrow', 'what files did Anjana upload today',
      'which files are in the Kudal folder', 'what are my notes for today', 'who is working on the basement waterproofing task',
      'what is the status of the basement work at Deulwadi', 'what letters did we send to the client this week',
    ]) check(`everyday chat is not routed: "${q}"`, routed(q) === null, String(routed(q)))
    // Asking for the bylaws FILES is the filename fast-lane's job (list with links).
    for (const q of ['find the byelaws', 'where are the by laws files', 'find parking bylaws pdf', 'show me the bylaws folder'])
      check(`a request for the bylaws files is not routed: "${q}"`, routed(q) === null, String(routed(q)))
    for (const q of ['far 2000 sqm', 'area of one ECS in basement parking', 'what is the FAR for 2000 sq m plot', 'as per G.O. what is the setback',
      'find the parking rules in the bylaws', 'find setback rules for 200sq meter plot?', 'search the bylaws for minimum staircase width'])
      check(`still a bylaws question: "${q}"`, routed(q) === 'bylaws', String(routed(q)))
    check('a bylaws question goes to the normal path when the bylaws index is off',
      ans.ragSourceFor('FAR for a 500 sq m residential plot', { bylaws: false, nas: true }) === null)

    // The model gets the merged question for a follow-up, not just "and for commercial?".
    check('a follow-up is put to the model with the merged question',
      ans.questionForAnswer('and for commercial?', 'setback (commercial) for a 200 sq m plot') === 'and for commercial?\n(That is: setback (commercial) for a 200 sq m plot)')
    check('a standalone question is put to the model as asked', ans.questionForAnswer('FAR for 2000 sq m', 'FAR for 2000 sq m') === 'FAR for 2000 sq m')
    check('answers have room for Gemini\'s reasoning plus a long answer (not 1,200 tokens)', ans.ANSWER_MAX_OUTPUT_TOKENS >= 3000)
    const kinds = ans.renderPassages([
      { server: 'WD', path: '/a', fileName: 'Time-saver Standards for Building Types.pdf', chunkIndex: 0, score: 0.8, text: '3 to 9 car spaces per 1000 sq ft' },
      { server: 'WD', path: '/b', fileName: '202504161857302632Bylaws_160425.pdf', chunkIndex: 0, score: 0.8, text: 'Shopping mall 3 / 100 sqm' },
    ])
    // Citations written 【1】 (gpt-oss) count like [1] for the source list.
    const two = [
      { server: 'WD', path: '/a', fileName: 'a.pdf', chunkIndex: 0, score: 0.8, text: 'x' },
      { server: 'WD', path: '/b', fileName: 'b.pdf', chunkIndex: 0, score: 0.8, text: 'y' },
    ]
    check('【2】 citations are read like [2]', ans.citedPassages('FAR is 2.0【2】', two as never)[0]?.fileName === 'b.pdf')
    // The reply language is set by the question's script, not left to the model.
    const r0 = { source: 'bylaws' as const, query: 'q', passages: [], requirement: null, allMatched: true }
    const sysFor = (q: string) => String(ans.buildAnswerMessages(r0, q, [], 'X')[0]!.content)
    check('an English question is answered in English', /Reply in English/.test(sysFor('FAR for 2000 sq m plot')) && !/Reply in Hindi/.test(sysFor('FAR for 2000 sq m plot')))
    check('a Hindi question is answered in Hindi', /Reply in Hindi/.test(sysFor('200 वर्ग मीटर भूखंड का सेटबैक')))
    // The worked example only when the question gives a plot area to work it on.
    check('a question with a plot area gets a worked example', /show the arithmetic for the plot area/.test(sysFor('FAR for 2000 sq m plot')))
    check('a question without one is told not to assume an area', /Worked example: leave this part out/.test(sysFor('Parking requirement for a hospital'))
      && !/show the arithmetic/.test(sysFor('FAR for a hotel on a 24 m road')))
    check('the prompt carries one example answer, marked as invented', /EXAMPLE of the shape only[\s\S]*END OF EXAMPLE/.test(sysFor('FAR for 2000 sq m plot')))
    check('【n】 citations are shown as [n]', ans.cleanCitations('FAR 2.0【1】【4】.') === 'FAR 2.0[1][4].')
    // The small local model does not write regulation answers unless asked to.
    const keepLocal = process.env.RAG_ANSWER_LOCAL_FIRST
    delete process.env.RAG_ANSWER_LOCAL_FIRST
    check('document answers leave out the local model by default', JSON.stringify(ans.answerProviders()) === '{"exclude":["local"]}')
    process.env.RAG_ANSWER_LOCAL_FIRST = 'true'
    check('RAG_ANSWER_LOCAL_FIRST=true allows it', !ans.answerProviders().exclude)
    if (keepLocal === undefined) delete process.env.RAG_ANSWER_LOCAL_FIRST; else process.env.RAG_ANSWER_LOCAL_FIRST = keepLocal
    check('a reference-book passage is marked as guidance, a bylaw passage is not',
      /\[1\] Time-saver[^\n]*guidance, not a rule/.test(kinds) && /\[2\] 202504161857302632Bylaws_160425\.pdf\n/.test(kinds), kinds.slice(0, 200))

    for (const q of ['and for commercial?', 'what about 500 sq m?', 'aur hotel ke liye?', 'parking for hotels?', 'for commercial?'])
      check(`follow-up: "${q}"`, ans.isFollowUp(q))
    for (const q of ['thanks', 'who is on hotel?', 'create a ticket for that', 'what is the minimum staircase width'])
      check(`not a follow-up: "${q}"`, !ans.isFollowUp(q))
    const prev = 'setback for a 200 sq m residential plot'
    check('follow-up keeps the topic and plot size, swaps the use',
      ans.searchQueryFor('bylaws', 'and for commercial?', prev) === 'setback (commercial) for a 200 sq m plot', ans.searchQueryFor('bylaws', 'and for commercial?', prev))
    check('follow-up keeps the use and plot size, swaps the topic',
      ans.searchQueryFor('bylaws', 'and parking?', prev) === 'parking (residential) for a 200 sq m plot', ans.searchQueryFor('bylaws', 'and parking?', prev))
    check('a question with its own topic and use is searched as asked',
      ans.searchQueryFor('bylaws', 'parking for hotels?', prev) === 'parking for hotels?')
    check('document follow-up searches both questions',
      ans.searchQueryFor('nas', 'and the warranty?', 'what does the spec say about lifts') === 'what does the spec say about lifts and the warranty?')

    const passages = [
      { server: 'WD', path: '/By_Laws/a.pdf', fileName: 'a.pdf', chunkIndex: 7, score: 0.9, text: 'FAR table', section: '3.2.2 FAR', values: 'FAR 1.75' },
      { server: 'WD', path: '/By_Laws/b.pdf', fileName: 'b.pdf', chunkIndex: 0, score: 0.88, text: 'x'.repeat(5000) },
      { server: 'WD', path: '/By_Laws/c b.pdf', fileName: 'c b.pdf', chunkIndex: 12, score: 0.86, text: 'parking requirements are 2 ECS per 100 sqm' },
    ]
    const r = { source: 'bylaws' as const, query: 'FAR', passages, requirement: 'FAR for a 200 sq m plot', allMatched: false }
    const msgs = ans.buildAnswerMessages(r, 'FAR for 200 sq m?', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], 'Trijya')
    const sys = String(msgs[0]?.content)
    check('prompt numbers the passages and gives the applicable row', sys.includes('[1] a.pdf — clause 3.2.2 FAR') && sys.includes('Applicable row, read against its column labels: FAR 1.75'))
    check('prompt cuts a long passage', !sys.includes('x'.repeat(2000)) && sys.includes('x'.repeat(1800)))
    check('prompt says the exact rule was not found when not every part matched', sys.includes('no passage covers FAR for a 200 sq m plot together'))
    check('the conversation and then the question follow the prompt', msgs.length === 4 && msgs[3]?.role === 'user' && msgs[3]?.content === 'FAR for 200 sq m?')
    const footer = ans.sourcesFooter('FAR is 1.75 [3][1], also [1]; not [9]', passages, 'bylaws')
    check('sources list the cited passages, in citation order, with their numbers',
      /\*\*Sources\*\*\n- \[3\] \[c b\.pdf\]\(\/api\/nas\/download\?server=WD&path=%2FBy_Laws%2Fc%20b\.pdf&inline=1\)\n/.test(footer) &&
      footer.indexOf('- [3]') < footer.indexOf('- [1] [a.pdf](/api/nas/download?server=WD&path=%2FBy_Laws%2Fa.pdf&inline=1) — clause 3.2.2 FAR'), footer)
    check('each source links to its exact line, paragraph and page (shown as dropdowns in the chat)',
      footer.includes('  [Show exact line, paragraph and page](/dashboard/source?c=bylaws&s=WD&p=%2FBy_Laws%2Fc%20b.pdf&i=12&k=parking%20requirements%20are%202%20ECS%20per%20100%20sqm)') &&
      !footer.includes('  > '), footer)
    check('parentheses in a path cannot end a markdown link early',
      ans.downloadUrl({ server: 'WD', path: '/Bylaws (2016.pdf' }) === '/api/nas/download?server=WD&path=%2FBylaws%20%282016.pdf&inline=1')

    // Key lines: the exact lines of the passage the answer used.
    const farPassage = {
      matchedRow: '>1200 1.25 2.0',
      section: '3.2.2.1 Residential – Plotted Development including EWS/ LIG/ Affordable Housing',
      text: 'tive Example:\nFor example, for a plot size of 100 square meters, permissible FAR is 2.0 and for plot size 100 -300\nsqm, the permissible FAR is 1.75.\n\n\n46\n\nThe ground coverage and FAR for various use occupancies shall be as follows.\n3.2.2.1 Residential – Plotted Development including EWS/ LIG/ Affordable Housing\nSl. Plot Size (sqm) Max. coverage after ensuring setbacks Base FAR Max. FAR\n3 >300 - 1200 1.5 2.0\n4 >1200 1.25\n2.0',
    }
    const farAnswer = '**The answer:** For a 2,000 sq m residential plot, Base FAR is 1.25 and Max FAR is 2.0 [1].\n\n**Worked example:** 2,000 × 1.25 = 2,500 sq m [1].'
    const kl = ans.keyLines(farAnswer, 1, farPassage)
    const { quotePhrases, findSpan } = await import('../lib/rag/highlight')
    check('key lines include the matched table row, split over two lines', kl.includes('4 >1200 1.25') && kl.includes('2.0'), kl)
    check('key lines are copied from the passage, never from the answer',
      quotePhrases(kl).every((ph) => findSpan(farPassage.text, ph) !== null) && !kl.includes('2,500'), kl)
    check('key lines quote the clause, the column headings and the row, in document order',
      kl === '3.2.2.1 Residential – Plotted Development including EWS/ LIG/ Affordable Housing Sl. Plot Size (sqm) Max. coverage after ensuring setbacks Base FAR Max. FAR … 4 >1200 1.25 2.0', kl)
    check('key lines stay short', kl.length <= 401, String(kl.length))
    check('key lines leave out the unrelated lines (the stray page number, the 100 sqm example)', !/(^| )46( |$)/.test(kl) && !kl.includes('100 square meters'), kl)
    check('key lines fall back to the row when the answer cites nothing from it',
      ans.keyLines('no figures here', 1, { text: 'zzz', matchedRow: '>1200 1.25 2.0' }) === '>1200 1.25 2.0')
    check('key lines fall back to the start of the passage', ans.keyLines('nothing', 1, { text: 'a'.repeat(300) }).endsWith('…'))
    // One-cell-per-line tables (as PyMuPDF extracts them) shown as tables.
    const { formatPassage } = await import('../lib/rag/format')
    const cellText = '1.3\n\nThe Minimum Plot Size shall be 850 sqmt in hill and 1200 sqmt\n\nin plains.\n\n1.4\n\nMaximum Ground Coverage and FAR shall be as follows:\n\nMax. Ground Coverage\nMax FAR\nPlain\n33.3%\n1.25\nHills\n35%\n1.0*\n\n1.5\n\nSletback: Minimum setbacks shall be as follows:\n\nPlot Size (Sqmt)\nFront\nRear\nSide-1\nSide-2\n\nPlains\n1200-1500\n6.0* mt\n4.5 mt\n4.5 mt\n4.5 mt\n1500-3000\n9.0 mt\n6.0 mt\n6.0 mt\n6.0 mt\n\nHills\n850-1200\n4.5 mt\n3.0 mt\n3.0 mt\n3.0 mt'
    const blocks = formatPassage(cellText)
    const tables = blocks.filter((b) => b.kind === 'table')
    check('a sentence split by a blank line is rejoined, with its clause number',
      JSON.stringify(blocks[0]) === JSON.stringify({ kind: 'text', text: 'The Minimum Plot Size shall be 850 sqmt in hill and 1200 sqmt in plains.', clause: '1.3' }), JSON.stringify(blocks[0]))
    // The same bylaw as printed in production: no blank lines around the
    // tables, clause numbers on their own lines, "Above 1500" plot sizes.
    const dense = formatPassage('n Terminal Points.\n1.4\nMaximum Ground Coverage and FAR shall be as follows:\n\nMax. Ground Coverage\nMax FAR\nPlain\n33.3%\n1.25\nHills\n35%\n1.0*\n1.5\nSletback: Minimum setbacks shall be as follows:\n\nPlot Size (Sqmt)\nFront\nRear\nSide-1\nSide-2\nPlains\n1200-1500\n6.0* mt\n4.5 mt\n4.5 mt\n3.5 mt\nAbove 1500\n7.0* mt\n4.5 mt\n5.0* mt\n4.5 mt\nHills\n850-1200\n5.0* mt\n3.0* mt\n4.5 mt\n3.0* mt\n1.6\nOpen Area :\n1.6.1 Minimum 10% of the total site area shall be developmed as or\nganized landscaped area.')
    check('clause numbers come in sequence, so values like 1.25 and 4.5 mt are not taken for clauses',
      dense.filter((b) => b.kind === 'text' && b.clause).map((b) => (b as { clause: string }).clause).join(' ') === '1.4 1.5 1.6 1.6.1', JSON.stringify(dense.map((b) => b.kind === 'text' ? b.clause ?? '-' : 'T')))
    check('tables without blank lines around them are rebuilt; "Above 1500" is a plot size, not a label',
      dense.filter((b) => b.kind === 'table').length === 2 &&
      JSON.stringify((dense.filter((b) => b.kind === 'table')[1] as { rows: unknown[] }).rows.slice(0, 3)) ===
        JSON.stringify([{ group: 'Plains' }, { cells: ['1200-1500', '6.0* mt', '4.5 mt', '4.5 mt', '3.5 mt'] }, { cells: ['Above 1500', '7.0* mt', '4.5 mt', '5.0* mt', '4.5 mt'] }]),
      JSON.stringify(dense.filter((b) => b.kind === 'table')))
    check('a passage cut mid-word is marked with an ellipsis, and wrapped lines are joined',
      dense[0]?.kind === 'text' && dense[0].text === '…n Terminal Points.' &&
      dense.some((b) => b.kind === 'text' && b.clause === '1.6.1' && b.text.endsWith('as or ganized landscaped area.')))
    check('a one-cell-per-line table with row headings is rebuilt (FAR: Plain / Hills)',
      JSON.stringify(tables[0]) === JSON.stringify({ kind: 'table', header: ['', 'Max. Ground Coverage', 'Max FAR'], rows: [{ cells: ['Plain', '33.3%', '1.25'] }, { cells: ['Hills', '35%', '1.0*'] }] }), JSON.stringify(tables[0]))
    check('a table with group labels is rebuilt (setbacks: Plains / Hills groups)',
      tables[1]?.kind === 'table' && tables[1].header.join('|') === 'Plot Size (Sqmt)|Front|Rear|Side-1|Side-2' &&
      JSON.stringify(tables[1].rows) === JSON.stringify([{ group: 'Plains' }, { cells: ['1200-1500', '6.0* mt', '4.5 mt', '4.5 mt', '4.5 mt'] }, { cells: ['1500-3000', '9.0 mt', '6.0 mt', '6.0 mt', '6.0 mt'] }, { group: 'Hills' }, { cells: ['850-1200', '4.5 mt', '3.0 mt', '3.0 mt', '3.0 mt'] }]), JSON.stringify(tables[1]))
    check('prose and tables that do not fall into rows are left as text',
      formatPassage('Chapter 3\nDefinitions\n\nIn these bye-laws, unless the context otherwise requires.').every((b) => b.kind === 'text') &&
      formatPassage(farPassage.text).every((b) => b.kind === 'text'))
    const setbackKl = ans.keyLines('In the plains the setbacks are front 9.0 m, rear 6.0 m [1].', 1,
      { text: cellText, matchedRow: '1500-3000 9.0 mt 6.0 mt 6.0 mt 6.0 mt', section: '1.5 Sletback: Minimum setbacks shall be as follows:' })
    check('key lines of a one-cell-per-line table keep the whole row and its column headings',
      setbackKl.includes('Plot Size (Sqmt) Front Rear Side-1 Side-2') && setbackKl.endsWith('1500-3000 9.0 mt 6.0 mt 6.0 mt 6.0 mt'), setbackKl)
    const nasLocate = (await import('../lib/nas/client')).nasLocate
    globalThis.fetch = (async () => new Response('Not Found', { status: 404 })) as typeof fetch
    check('page lookup is skipped (null) when the connector has no /locate yet', (await asTrijya(() => nasLocate('WD', '/x.pdf', ['some anchor text']))) === null)
    globalThis.fetch = realFetch
    check('sources fall back to the top three when nothing is cited', ans.citedPassages('no citations', passages).length === 3)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
}
main().catch((e) => { console.error('HARNESS CRASHED:', e); process.exit(1) })
