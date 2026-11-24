/**
 * End-to-end test of the Bylaws tab's State dropdown against a fake Qdrant
 * and a fake embedding connector, through the real Qdrant client:
 *
 *   npx tsx scripts/test-bylaws-state.ts
 *
 * The fake index holds Uttarakhand (MDDA), Uttar Pradesh and national (NBC)
 * documents, and a second organisation's copy of the Uttarakhand bylaws. The
 * Uttar Pradesh passages score HIGHER than the Uttarakhand ones, so any
 * search path that forgets the state filter (table-row search, plain search,
 * the English re-search for a Hindi question, the "closest passages"
 * fallback) lets them in and fails a check here. The fake applies Qdrant's
 * filter rules (match value / match any / range) to every request.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))

let pass = 0, fail = 0
const check = (label: string, cond: boolean, detail = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
}

const UK = '/utility data/By_Laws/MDDA UTTARAKHAND/MDDA Compiled_byelaws_uttarakhand.pdf'
const UK_GO = '/utility data/By_Laws/MDDA UTTARAKHAND/G-O-07-01-2022.pdf'
const UP = '/utility data/By_Laws/UTTAR PRADESH/UP Building Bylaws 2025.pdf'
const NBC = '/utility data/By_Laws/NBCs/NBC 2016 VOL1.pdf'

const setbackTable = (heading: string, rows: string) =>
  `${heading}\nMinimum setbacks shall be as follows:\n\nPlot area (sq m)\nFront\nRear\nSide-1\nSide-2\n${rows}`

interface Point { id: string; org: string; path: string; chunkIndex: number; score: number; text: string }
const points: Point[] = []
const add = (org: string, p: string, chunkIndex: number, score: number, text: string) =>
  points.push({ id: `${points.length}`, org, path: p, chunkIndex, score, text })

// Uttarakhand: the commercial setback table (7.5 / 3.0 / 3.0 / -).
add('trijya', UK, 0, 0.83, 'Mussoorie Dehradun Development Authority building bye-laws. Chapter 1 definitions.')
add('trijya', UK, 1, 0.86, setbackTable('Commercial / office buildings', 'up to 600\n7.5\n3.0\n3.0\n-\n600-1000\n8.0\n3.0\n3.0\n-'))
add('trijya', UK, 2, 0.84, 'Basement: a basement may be permitted up to the setback lines, with ventilation and fire safety.')
add('trijya', UK_GO, 0, 0.82, 'Government order on compounding of buildings in Uttarakhand.')
// Uttar Pradesh: the same questions, scored higher, different figures.
add('trijya', UP, 0, 0.90, 'Uttar Pradesh building bye-laws 2025. Chapter 1.')
add('trijya', UP, 1, 0.93, setbackTable('Commercial buildings', 'up to 600\n4.5\n3.0\n1.5\n1.5\n600-1000\n6.0\n3.0\n3.0\n3.0'))
add('trijya', UP, 2, 0.92, 'Basement: basements are permitted below the whole plot in Uttar Pradesh.')
// National.
add('trijya', NBC, 0, 0.85, 'National Building Code of India 2016, Volume 1.')
add('trijya', NBC, 1, 0.88, setbackTable('Mercantile (commercial) buildings', 'up to 600\n6.0\n3.0\n3.0\n3.0\n600-1000\n6.0\n4.5\n3.0\n3.0'))
add('trijya', NBC, 2, 0.87, 'Basement: the basement shall be ventilated; fire safety per Part 4.')
// BIS model regulations: Uttarakhand's copy, a state with only its copy
// (Manipur) and the national master. Scored above MDDA, so any search that
// lets the model in with Uttarakhand chosen fails.
const BIS = '/utility data/By_Laws/BIS STANDARDIZED REGULATIONS 2023'
const BIS_UK = `${BIS}/States/Uttarakhand/20240115-Uttarakhand-Final-Standardized-Development-and-Building-Regulations.pdf`
const BIS_MN = `${BIS}/States/Manipur/20240115-Manipur-Final-Standardized-Development-and-Building-Regulations.pdf`
const BIS_MASTER = `${BIS}/National Master Document/SP-732023-Standardized-Development-and-Building-Regulations-2023.pdf`
for (const p of [BIS_UK, BIS_MN, BIS_MASTER]) {
  add('trijya', p, 0, 0.9, 'Standardized Development and Building Regulations 2023, Bureau of Indian Standards.')
  add('trijya', p, 1, 0.91, setbackTable('Mercantile / commercial', 'up to 600\n4.5\n3.0\n3.0\n3.0\n600-1000\n6.0\n3.0\n3.0\n3.0'))
  add('trijya', p, 2, 0.9, 'Basement: permitted within the setback lines (BIS model).')
}
// Another organisation's copy of the Uttarakhand bylaws, scored highest of all.
add('other-org', UK, 0, 0.99, 'Other organisation: Mussoorie Dehradun bye-laws.')
add('other-org', UK, 1, 0.99, setbackTable('Commercial / office buildings', 'up to 600\n9.9\n9.9\n9.9\n9.9'))

type Cond = { key: string; match?: { value?: unknown; any?: unknown[] }; range?: { gte?: number } }
const field = (p: Point, key: string): unknown =>
  key === 'organizationId' ? p.org : key === 'path' ? p.path : key === 'chunkIndex' ? p.chunkIndex : key === 'server' ? 'WD' : undefined
const passes = (p: Point, filter?: { must?: Cond[] }) => (filter?.must ?? []).every((c) => {
  const v = field(p, c.key)
  if (c.match && 'value' in c.match) return v === c.match.value
  if (c.match && 'any' in c.match) return (c.match.any ?? []).includes(v)
  if (c.range) return typeof v === 'number' && (c.range.gte === undefined || v >= c.range.gte)
  throw new Error(`fake qdrant: unsupported condition ${JSON.stringify(c)}`)
})
const payload = (p: Point) => ({ organizationId: p.org, server: 'WD', path: p.path, fileName: p.path.split('/').pop(), chunkIndex: p.chunkIndex, text: p.text })

const searches: Array<{ must?: Cond[] }> = []
let scrolls = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const j = body ? JSON.parse(body) : {}
    const url = req.url ?? ''
    const send = (result: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result, status: 'ok', time: 0 })) }
    if (url === '/embed') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ vectors: (j.texts as string[]).map(() => [1, 0, 0, 0]) }))
    }
    if (/\/exists$/.test(url)) return send({ exists: true })
    if (/\/index$/.test(url)) return send({ operation_id: 0, status: 'completed' })
    if (/\/points\/search$/.test(url)) {
      searches.push(j.filter)
      const hits = points.filter((p) => passes(p, j.filter) && p.score >= (j.score_threshold ?? 0))
        .sort((a, b) => b.score - a.score).slice(0, j.limit)
      return send(hits.map((p) => ({ id: p.id, version: 0, score: p.score, payload: payload(p) })))
    }
    if (/\/points\/scroll$/.test(url)) {
      scrolls++
      const hits = points.filter((p) => passes(p, j.filter))
      return send({ points: hits.map((p) => ({ id: p.id, payload: { path: p.path } })), next_page_offset: null })
    }
    if (/\/points$/.test(url)) return send([]) // retrieve by id: no neighbours in this fake
    res.statusCode = 404
    res.end(JSON.stringify({ status: { error: `fake qdrant: no route ${req.method} ${url}` } }))
  })
})

async function main() {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // Read when the modules load, so set before importing them.
  Object.assign(process.env, {
    QDRANT_URL: base, QDRANT_API_KEY: '', QDRANT_BYLAWS_COLLECTION: 'trijya_bylaws',
    TRIJYA_NAS_BASE_URL: base, HF_EMBEDDING_DIM: '4', HF_EMBEDDING_MODEL: 'test-model', RAG_MIN_SCORE: '0.8',
    CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '',
  })
  const { runWithOrg } = await import('../lib/tenant-context')
  const ans = await import('../lib/rag/answer')
  const regions = await import('../lib/rag/regions')
  const inOrg = <T>(org: string, fn: () => Promise<T>) => runWithOrg(org, fn)
  // With Uttarakhand chosen: its own documents only. Not the NBC, not the BIS copies.
  const allowed = new Set([UK, UK_GO])
  const where = (p: { path: string }) => regions.stateOfPath(p.path) ?? 'national'

  console.log('\n## States offered')
  const states = await inOrg('trijya', () => ans.bylawsStates())
  check('dropdown lists Manipur (BIS copy only), Uttar Pradesh and Uttarakhand', JSON.stringify(states) === '["Manipur","Uttar Pradesh","Uttarakhand"]', JSON.stringify(states))
  const own = await inOrg('trijya', () => ans.bylawsStatesWithOwnDocuments())
  check('only Uttar Pradesh and Uttarakhand have bylaws of their own', JSON.stringify(own) === '["Uttar Pradesh","Uttarakhand"]', JSON.stringify(own))
  const otherStates = await inOrg('nobody', () => ans.bylawsStates())
  check('an organisation with no documents gets no states', otherStates.length === 0, JSON.stringify(otherStates))
  const scrollsBefore = scrolls
  await inOrg('trijya', () => ans.bylawsStates())
  check('the document list is cached (no second scroll within 10 min)', scrolls === scrollsBefore, `${scrolls - scrollsBefore} extra scrolls`)

  const questions = [
    { q: 'setback for 500 sq m commercial plot', kind: 'table row' },
    { q: 'basement rules', kind: 'plain search' },
    { q: '500 वर्ग मीटर व्यावसायिक भूखंड के लिए सेट बैक', kind: 'Hindi + English re-search' },
    { q: 'setback for 50000 sq m commercial plot', kind: 'no row covers it: closest passages' },
  ]
  for (const { q, kind } of questions) {
    console.log(`\n## ${kind}: "${q}"`)
    searches.length = 0
    const scoped = await inOrg('trijya', () => ans.retrieve('bylaws', q, 8, { state: 'Uttarakhand' }))
    console.log(`   with Uttarakhand: ${scoped.passages.map((p) => `${where(p)}:${p.chunkIndex}`).join(', ') || '(none)'}${scoped.allMatched ? '' : ' (closest only)'}`)
    const leaked = scoped.passages.filter((p) => !allowed.has(p.path))
    check('no Uttar Pradesh, NBC or BIS passage with Uttarakhand chosen', leaked.length === 0, leaked.map((p) => p.path).join(', '))
    check('every search with Uttarakhand chosen was limited to its own two documents',
      searches.every((f) => (f?.must ?? []).some((c) => c.key === 'path' && JSON.stringify([...(c.match?.any ?? [])].sort()) === JSON.stringify([UK, UK_GO].sort()))),
      JSON.stringify(searches.map((f) => (f?.must ?? []).find((c) => c.key === 'path')?.match?.any)))
    check('every Qdrant search carried the state filter', searches.length > 0 && searches.every((f) => (f?.must ?? []).some((c) => c.key === 'path' && Array.isArray(c.match?.any))), `${searches.length} searches`)
    check('every Qdrant search carried the organisation filter', searches.every((f) => (f?.must ?? []).some((c) => c.key === 'organizationId' && c.match?.value === 'trijya')))
    check('no other organisation\'s passage', scoped.passages.every((p) => !p.text.startsWith('Other organisation') && !p.text.includes('9.9')))
    if (scoped.passages.length) check('an Uttarakhand passage comes first', where(scoped.passages[0]!) === 'Uttarakhand', where(scoped.passages[0]!))
    const all = await inOrg('trijya', () => ans.retrieve('bylaws', q, 8))
    console.log(`   all states:       ${all.passages.map((p) => `${where(p)}:${p.chunkIndex}`).join(', ') || '(none)'}`)
    check('without a state, Uttar Pradesh is searched too (the fake really has it)', all.passages.some((p) => p.path === UP))
    // The never-"not found" second search must keep the state too.
    const wider = await inOrg('trijya', () => ans.widerRetrieval({ ...scoped, passages: [] })())
    check('the wider second search keeps the state: no Uttar Pradesh passage', wider.state === 'Uttarakhand' && wider.passages.every((p) => allowed.has(p.path)), wider.passages.filter((p) => !allowed.has(p.path)).map((p) => p.path).join(', '))
  }

  console.log('\n## The 500 sq m commercial answer')
  const r = await inOrg('trijya', () => ans.retrieve('bylaws', 'setback for 500 sq m commercial plot', 8, { state: 'Uttarakhand' }))
  const top = r.passages[0]
  check('top passage is the MDDA commercial table, row up to 600: 7.5 / 3.0 / 3.0', !!top && top.path === UK && /7\.5/.test(`${top.values ?? ''} ${top.matchedRow ?? ''}`), top ? `${top.fileName}: ${top.values ?? top.matchedRow}` : 'none')
  const prompt = String(ans.buildAnswerMessages(r, 'setback for 500 sq m commercial plot', [], 'Forge')[0]!.content)
  check('prompt names the state and labels each passage', /chose the state Uttarakhand/.test(prompt) && prompt.includes('(Uttarakhand bylaws)') && !prompt.includes('UP Building Bylaws'))

  console.log('\n## Other organisation')
  const foreign = await inOrg('other-org', () => ans.retrieve('bylaws', 'setback for 500 sq m commercial plot', 8, { state: 'Uttarakhand' }))
  check('another organisation sees only its own passages', foreign.passages.length > 0 && foreign.passages.every((p) => p.text.includes('9.9') || p.text.startsWith('Other organisation')), foreign.passages.map((p) => p.text.slice(0, 30)).join(' | '))
  const stranger = await inOrg('nobody', () => ans.retrieve('bylaws', 'setback for 500 sq m commercial plot', 8, { state: 'Uttarakhand' }))
  check('an organisation with no documents gets nothing (an empty scope never widens to everything)', stranger.passages.length === 0, String(stranger.passages.length))
  searches.length = 0
  const manipur = await inOrg('trijya', () => ans.retrieve('bylaws', 'setback for 500 sq m commercial plot', 8, { state: 'Manipur' }))
  check('Manipur (only a BIS copy) gets no passages: not its BIS copy, not the NBC, not another state', manipur.passages.length === 0, manipur.passages.map((p) => p.path).join(', '))
  check('  and no Qdrant search was sent for it (an empty scope is never sent as "all")', searches.length === 0, `${searches.length} searches`)

  console.log('\n## Central tab: central documents only')
  const centralAllowed = new Set([NBC, BIS_MASTER])
  for (const q of ['setback for 500 sq m commercial plot', 'basement rules', '500 वर्ग मीटर व्यावसायिक भूखंड के लिए सेट बैक']) {
    searches.length = 0
    const c = await inOrg('trijya', () => ans.retrieve('bylaws', q, 8, { area: 'central' }))
    const out = c.passages.filter((p) => !centralAllowed.has(p.path))
    check(`central "${q.slice(0, 30)}": only NBC and the BIS master (no MDDA, UP or BIS state copy)`, c.passages.length > 0 && out.length === 0, out.map((p) => p.path).join(', ') || `${c.passages.length} passages`)
    check('  every Qdrant search was limited to the central documents',
      searches.length > 0 && searches.every((f) => (f?.must ?? []).some((cnd) => cnd.key === 'path' && JSON.stringify([...(cnd.match?.any ?? [])].sort()) === JSON.stringify([...centralAllowed].sort()))))
    const cw = await inOrg('trijya', () => ans.widerRetrieval(c)())
    check('  the wider second search stays central', cw.area === 'central' && cw.passages.every((p) => centralAllowed.has(p.path)), cw.passages.filter((p) => !centralAllowed.has(p.path)).map((p) => p.path).join(', '))
  }
  const cdocs = await inOrg('trijya', () => ans.centralDocuments())
  check('the Central tab lists exactly the documents it searches', JSON.stringify([...cdocs].sort()) === JSON.stringify([...centralAllowed].sort()), JSON.stringify(cdocs))
  const otherCentral = await inOrg('other-org', () => ans.retrieve('bylaws', 'setback for 500 sq m commercial plot', 8, { area: 'central' }))
  check('another organisation with no central documents gets nothing from Trijya\'s', otherCentral.passages.length === 0, otherCentral.passages.map((p) => p.path).join(', '))

  console.log('\n## Bylaws tab, All states: state documents only')
  const stateAllowed = new Set([UK, UK_GO, UP])
  for (const q of ['setback for 500 sq m commercial plot', 'basement rules']) {
    searches.length = 0
    const a = await inOrg('trijya', () => ans.retrieve('bylaws', q, 8, { area: 'all-states' }))
    const out = a.passages.filter((p) => !stateAllowed.has(p.path))
    check(`all states "${q}": MDDA and UP only, no NBC or BIS`, a.passages.length > 0 && out.length === 0, out.map((p) => p.path).join(', '))
    check('  every Qdrant search was limited to the state documents',
      searches.length > 0 && searches.every((f) => (f?.must ?? []).some((cnd) => cnd.key === 'path' && JSON.stringify([...(cnd.match?.any ?? [])].sort()) === JSON.stringify([...stateAllowed].sort()))))
  }
  const chat = await inOrg('trijya', () => ans.retrieve('bylaws', 'basement rules', 8))
  check('the chat (no state, no area) still searches state and central documents', chat.passages.some((p) => p.path === NBC) && chat.passages.some((p) => p.path === UP))

  console.log('\n## Load: 50 questions at once')
  const t0 = Date.now()
  const many = await Promise.all(Array.from({ length: 50 }, (_, i) =>
    inOrg(i % 5 === 0 ? 'other-org' : 'trijya', () => ans.retrieve('bylaws', `setback for ${300 + i * 10} sq m commercial plot`, 8, { state: 'Uttarakhand' }))
      .then((x) => ({ org: i % 5 === 0 ? 'other-org' : 'trijya', x }))))
  const crossed = many.filter(({ org, x }) => x.passages.some((p) => (org === 'trijya') === (p.text.includes('9.9') || p.text.startsWith('Other organisation')) || !allowed.has(p.path)))
  check('50 concurrent questions from two organisations: none crosses organisation or state', crossed.length === 0, `${crossed.length} crossed, ${Date.now() - t0} ms`)
  // Central, one state and all states at once: none takes another's documents.
  const mixed = await Promise.all(Array.from({ length: 60 }, (_, i) => {
    const opts = i % 3 === 0 ? { area: 'central' as const } : i % 3 === 1 ? { state: 'Uttarakhand' } : { area: 'all-states' as const }
    const ok = i % 3 === 0 ? centralAllowed : i % 3 === 1 ? allowed : stateAllowed
    return inOrg('trijya', () => ans.retrieve('bylaws', `setback for ${300 + i * 10} sq m commercial plot`, 8, opts)).then((x) => x.passages.filter((p) => !ok.has(p.path)).length)
  }))
  check('60 concurrent Central / Uttarakhand / All states questions: none takes another tab\'s documents', mixed.every((n) => n === 0), `${mixed.filter((n) => n > 0).length} leaked`)

  server.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
}
main().catch((e) => { console.error('HARNESS CRASHED:', e); server.close(); process.exit(1) })
