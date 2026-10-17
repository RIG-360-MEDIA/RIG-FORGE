/**
 * Runs the bylaws test pack (cases.mjs) against a DEPLOYED site through the
 * Bylaws tab's API (POST /api/nas/bylaws/search), as a Trijya user. Use it
 * after a deploy. Read-only: search requests only.
 *
 *   FORGE_EMAIL=... FORGE_PASS=... node scripts/bylaws-eval/run-live.mjs [caseIdRegex]
 *
 * FORGE_BASE defaults to https://rig-forge.onrender.com. The account must
 * belong to the Trijya company (bylaws are Trijya-only). Also prints latency
 * and how often the FIRST result is a correct one.
 */
const BASE = process.env.FORGE_BASE || 'https://rig-forge.onrender.com'
const { FORGE_EMAIL, FORGE_PASS } = process.env
if (!FORGE_EMAIL || !FORGE_PASS) {
  console.error('Set FORGE_EMAIL and FORGE_PASS (a Trijya account).')
  process.exit(2)
}
const { CASES } = await import('./cases.mjs')
const filt = process.argv[2] ? new RegExp(process.argv[2]) : null
const norm = (s) => s.replace(/[–—−]/g, '-').replace(/\s+/g, ' ')

const l = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: FORGE_EMAIL, password: FORGE_PASS }) })
if (!l.ok) { console.error(`login failed: HTTP ${l.status}`); process.exit(2) }
const cookie = (l.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')

const matches = (c, h) => c.expect.some((e) => (!e.file || e.file.test(h.fileName)) && e.row.test(norm(h.matchedRow || h.excerpt || '')))
let pass = 0, n = 0, graded = 0, first = 0
const fails = [], times = []
for (const c of CASES) {
  if (filt && !filt.test(c.id)) continue
  n++
  const t0 = Date.now()
  const r = await fetch(`${BASE}/api/nas/bylaws/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ query: c.q, limit: 8 }), signal: AbortSignal.timeout(60000) })
  const ms = Date.now() - t0
  times.push(ms)
  const j = await r.json().catch(() => ({}))
  const d = j.data ?? {}
  const hits = d.matches ?? []
  let ok
  if (r.status !== 200) ok = false
  else if (c.review) ok = true
  else if (c.none) ok = hits.length === 0
  else {
    ok = hits.slice(0, c.top).some((h) => matches(c, h))
    graded++
    if (hits[0] && matches(c, hits[0])) first++
  }
  if (ok) pass++; else fails.push(c.id)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.id.padEnd(16)} ${String(ms).padStart(5)}ms HTTP ${r.status} [${d.requirement ?? '-'}] allMatched=${d.allMatched} "${c.q}"${j.error ? ` ERROR ${j.error}` : ''}`)
  if (!ok || c.review) {
    for (const h of hits.slice(0, 3)) console.log(`      ${h.score} ${h.fileName.slice(0, 28)} {${h.section ?? ''}} ${h.matchedRow ?? ''}${h.values ? ` => ${h.values}` : ''}`)
  }
}
times.sort((a, b) => a - b)
console.log(`\n${pass}/${n} passed${fails.length ? `; failed: ${fails.join(', ')}` : ''}`)
console.log(`first result correct: ${first}/${graded}`)
console.log(`latency: median ${times[Math.floor(times.length / 2)]} ms, p90 ${times[Math.floor(times.length * 0.9)]} ms, max ${times.at(-1)} ms`)
process.exitCode = fails.length ? 1 : 0
