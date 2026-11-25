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
const UK_OLD = '/utility data/By_Laws/MDDA UTTARAKHAND/MDDA Building Bye-laws 2011.pdf'
const UK_DRAFT = '/utility data/By_Laws/MDDA UTTARAKHAND/DRAFT.pdf'
const UP = '/utility data/By_Laws/UTTAR PRADESH/UP Building Bylaws 2025.pdf'
const NBC = '/utility data/By_Laws/NBCs/NBC 2016 VOL1.pdf'

const setbackTable = (heading: string, rows: string) =>
  `${heading}\nMinimum setbacks shall be as follows:\n\nPlot area (sq m)\nFront\nRear\nSide-1\nSide-2\n${rows}`

interface Point { id: string; org: string; path: string; chunkIndex: number; score: number; text: string }
const points: Point[] = []
const add = (org: string, p: string, chunkIndex: number, score: number, text: string) =>
  points.push({ id: `${points.length}`, org, path: p, chunkIndex, score, text })

// Uttarakhand: the commercial setback table (7.5 / 3.0 / 3.0 / -). Its file
// name has no year; its title page gives 2023.
add('trijya', UK, 0, 0.83, 'Mussoorie Dehradun Development Authority building bye-laws 2016 (as amended up to 2023). Chapter 1 definitions.')
add('trijya', UK, 1, 0.86, setbackTable('Commercial / office buildings', 'up to 600\n7.5\n3.0\n3.0\n-\n600-1000\n8.0\n3.0\n3.0\n-'))
add('trijya', UK, 2, 0.84, 'Basement: a basement may be permitted up to the setback lines, with ventilation and fire safety.')
add('trijya', UK_GO, 0, 0.82, 'Government order on compounding of buildings in Uttarakhand.')
// The Dehradun residential question ("FAR, setbacks and coverage for a
// 200sqm residential plot in dehradun plains"): MDDA's residential FAR and
// coverage table (real extracted text: 150-250 sq m plains 65% / FAR 1.70)
// and a residential setback table are separate tables, and a DRAFT.pdf
// holds all three in one row, scored highest. That draft alone answered it.
const MDDA_RES_FAR = '(i) \nआवासीय \nक्र0 सं0 \nउपयोग समूह \n( भूखण्ड क्षेत्रफल  \nवर्गमीटर में ) \nमैदानी क्षेत्र \nपर्वतीय क्षेत्र \nअधिकतम भू- \nआच्छादनः \nअनुमन्य \nएफ0ए0आर0\n# ग्रीन बिल्डिंग \nहेतु प्राप्त रेटिंग \nके आधार पर देय \nअतिरिक्त \nएफ0ए0आर0 \nअधिकतम भू- \nआच्छादन : \n (%  में)  \nअनुमन्य \nएफ0ए0आर0 \na \nप्लाटेड \n \n1- > 75-150 तक \n70 \n1.80 \n- \n75 \n1.80 \n2-\n>150- 250 तक \n65\n1.70\n-\n70\n1.60\n3- >250- 350 तक \n60 \n1.60 \n- \n65 \n1.50 \n'
add('trijya', UK, 3, 0.84, MDDA_RES_FAR)
add('trijya', UK, 4, 0.84, setbackTable('Residential plotted development', 'up to 150\n2.0\n1.0\n-\n-\n150-250\n3.0\n1.5\n-\n-\n250-350\n3.5\n2.0\n1.5\n-'))
add('trijya', UK_DRAFT, 0, 0.9, 'DRAFT building bye-laws for consultation.')
add('trijya', UK_DRAFT, 1, 0.95, 'Residential plotted development\nPlot area (sq m)\nGround coverage (%)\nFAR\nFront setback (m)\nup to 200\n75\n2.25\n1.20\n200-300\n70\n2.0\n1.80')
// An older Uttarakhand edition (2011): the same table with older figures,
// scored HIGHER than the current one, so only the year can put it second.
add('trijya', UK_OLD, 0, 0.8, 'MDDA building bye-laws 2011.')
add('trijya', UK_OLD, 1, 0.87, setbackTable('Commercial / office buildings', 'up to 600\n6.0\n2.0\n2.0\n-\n600-1000\n7.0\n3.0\n3.0\n-'))
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

// A fake OpenAI-compatible model (the "local" provider): which reply it
// gives depends on the prompt: the answer draft, the cross-check, or the
// general (no documents) answer. Each request is recorded.
type Role = 'draft' | 'verify' | 'general'
const llmCalls: Array<{ role: Role; system: string; user: string }> = []
const llm: Record<Role, string | number> = { draft: '', verify: '', general: '' }
const roleOf = (system: string): Role =>
  /you check the draft below/.test(system) ? 'verify' : /from your own knowledge/.test(system) ? 'general' : 'draft'
function llmReply(res: http.ServerResponse, body: { messages: Array<{ role: string; content: unknown }> }) {
  const text = (c: unknown) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? '').join('') : ''
  const system = body.messages.filter((m) => m.role === 'system').map((m) => text(m.content)).join('\n')
  const user = text(body.messages.filter((m) => m.role === 'user').pop()?.content)
  const role = roleOf(system)
  llmCalls.push({ role, system, user })
  const reply = llm[role]
  // A number is an HTTP error status: the provider fails.
  if (typeof reply === 'number') {
    res.statusCode = reply
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ error: { message: 'fake model down', type: 'server_error' } }))
  }
  res.setHeader('content-type', 'text/event-stream')
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'forgie', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  // In pieces of 7 characters, so "NOT_IN_DOCUMENTS" arrives split.
  const parts = reply.match(/[\s\S]{1,7}/g) ?? []
  res.write(chunk({ role: 'assistant', content: '' }, null))
  for (const p of parts) res.write(chunk({ content: p }, null))
  res.write(chunk({}, 'stop'))
  res.end('data: [DONE]\n\n')
}
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const j = body ? JSON.parse(body) : {}
    const url = req.url ?? ''
    const send = (result: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result, status: 'ok', time: 0 })) }
    if (url === '/v1/chat/completions') return llmReply(res, j)
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
      return send({ points: hits.map((p) => ({ id: p.id, payload: { path: p.path, text: p.text } })), next_page_offset: null })
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
    // Answers come from the fake model only: no cloud key is set.
    ASSISTANT_ENABLED: 'true', ASSISTANT_PROVIDER_ORDER: 'local', RAG_ANSWER_LOCAL_FIRST: 'true',
    LOCAL_LLM_BASE_URL: `${base}/v1`, LOCAL_LLM_MODEL: 'forgie',
    OPENAI_API_KEYS: '', OPENAI_API_KEY: '', GROQ_API_KEYS: '', GEMINI_API_KEYS: '', CEREBRAS_API_KEYS: '',
  })
  const { runWithOrg } = await import('../lib/tenant-context')
  const ans = await import('../lib/rag/answer')
  const regions = await import('../lib/rag/regions')
  const inOrg = <T>(org: string, fn: () => Promise<T>) => runWithOrg(org, fn)
  // With Uttarakhand chosen: its own documents only. Not the NBC, not the BIS copies.
  const allowed = new Set([UK, UK_GO, UK_OLD, UK_DRAFT])
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
    check('every search with Uttarakhand chosen was limited to its own four documents',
      searches.every((f) => (f?.must ?? []).some((c) => c.key === 'path' && JSON.stringify([...(c.match?.any ?? [])].sort()) === JSON.stringify([...allowed].sort()))),
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

  console.log('\n## Latest bylaws: years and ranking')
  const rowPaths = r.passages.filter((p) => p.matchedRow || p.values).map((p) => p.path)
  check('the current bylaws (title page: amended up to 2023) rank above the 2011 edition, which scores higher',
    rowPaths[0] === UK && rowPaths.includes(UK_OLD), rowPaths.map((p) => p.split('/').pop()).join(' | '))
  const yearOf = (p: string) => r.passages.find((x) => x.path === p)?.year
  check('each passage carries its year: 2023 from the title page, 2011 from the file name', yearOf(UK) === 2023 && yearOf(UK_OLD) === 2011, `${yearOf(UK)} / ${yearOf(UK_OLD)}`)
  check('the answer prompt shows each year and asks for the latest bylaws',
    prompt.includes('(year 2023)') && prompt.includes('(year 2011)') && /Latest bylaws first/.test(prompt) && /never assumed to be the latest/.test(prompt))

  console.log('\n## Cross-check before the answer is shown (fake model)')
  const nNew = r.passages.findIndex((p) => p.path === UK) + 1
  const nOld = r.passages.findIndex((p) => p.path === UK_OLD) + 1
  const run = async () => {
    const shown: string[] = []
    const statuses: string[] = []
    let general = false
    llmCalls.length = 0
    const out = await inOrg('trijya', () => ans.answerNeverNotFound({
      first: r, second: ans.widerRetrieval(r), question: 'setback for 500 sq m commercial plot', history: [], orgName: 'Forge',
      emit: (d) => shown.push(d), onStatus: (s) => statuses.push(s), onGeneral: () => { general = true },
    }))
    return { out, shown: shown.join(''), statuses, general, roles: llmCalls.map((c) => c.role).join(',') }
  }

  // A: the draft used the 2011 edition; the cross-check corrects it from 2023.
  llm.draft = `**The answer**\nUnder the MDDA Building Bye-laws 2011, the front setback is 6.0 m [${nOld}].`
  llm.verify = [
    '**The answer**',
    `Under the MDDA bylaws (2023), the front setback for a 500 sq m commercial plot is 7.5 m [${nNew}].`,
    '',
    '**By year**',
    '| Document | Year | Front setback | Status |',
    '|---|---|---|---|',
    `| MDDA Compiled_byelaws_uttarakhand.pdf | 2023 | 7.5 m [${nNew}] | Latest: applies |`,
    `| MDDA Building Bye-laws 2011.pdf | 2011 | 6.0 m [${nOld}] | Older edition: superseded |`,
  ].join('\n')
  const a = await run()
  check('only the cross-checked answer is shown; the draft never is', a.shown === llm.verify && !a.shown.includes('Under the MDDA Building Bye-laws 2011'), a.shown)
  check('  one draft, then one cross-check', a.roles === 'draft,verify', a.roles)
  check('  the user is told it is being cross-checked', a.statuses.includes('Cross-checking the answer against the latest bylaws…'), a.statuses.join(' | '))
  const verifyCall = llmCalls.find((c) => c.role === 'verify')?.system ?? ''
  check('  the cross-check is given the draft, the years, the latest year and the state rule',
    verifyCall.includes('Under the MDDA Building Bye-laws 2011, the front setback is 6.0 m') && verifyCall.includes('(year 2023)') && verifyCall.includes('(year 2011)') &&
    verifyCall.includes('The latest year among these passages is 2023') && verifyCall.includes("Only Uttarakhand's own documents were searched"))
  check('  and never a document outside the state', !verifyCall.includes('UP Building Bylaws') && !verifyCall.includes('NBC 2016') && !verifyCall.includes('Standardized'))
  const refs = ans.answerReferences(a.out.text, r.passages, 'bylaws')
  check('  the sources are the 2023 bylaws first, then the 2011 edition, each with its year',
    refs[0]?.path === UK && refs[0]?.year === 2023 && refs[1]?.path === UK_OLD && refs[1]?.year === 2011 && a.out.retrieval === r, JSON.stringify(refs.map((x) => [x.fileName, x.year])))
  check('  both years are shown in the answer, latest first', /\| 2023 \| 7\.5 m[\s\S]*\| 2011 \| 6\.0 m/.test(a.shown), a.shown)
  check('  the drafter and the cross-check are both told to show both years in a By year table',
    /Both years shown/.test(llmCalls.find((x) => x.role === 'draft')?.system ?? '') && /Both years are shown/.test(verifyCall) && /never drop the older document's row/.test(verifyCall))

  // B: the cross-check finds no passage supports an answer, twice: the general answer.
  llm.draft = 'Front setback 6.0 m [1].'
  llm.verify = 'NOT_IN_DOCUMENTS'
  llm.general = 'Commonly, commercial plots of this size need a front setback of about 6 to 7.5 m. Check the current Uttarakhand bylaws before relying on it.'
  const b = await run()
  check('cross-check rejects both drafts: the general answer is shown, nothing of the drafts or the marker',
    b.shown === llm.general && b.general && b.out.retrieval === null && !/NOT_IN|DOCUMENTS|6\.0 m \[1\]/.test(b.shown), `${b.roles} | ${b.shown}`)
  check('  draft, check, wider draft, check, general', b.roles === 'draft,verify,draft,verify,general', b.roles)

  // C: the draft itself says the passages do not answer: no cross-check is run.
  llm.draft = 'NOT_IN_DOCUMENTS'
  const c = await run()
  check('a draft that says "not in the documents" is never checked or shown; the general answer is', c.roles === 'draft,draft,general' && c.shown === llm.general, `${c.roles} | ${c.shown}`)

  // D (last: it puts the fake model's key on cooldown): the cross-check fails.
  llm.draft = `**The answer**\nThe front setback is 7.5 m [${nNew}].`
  llm.verify = 500
  const d = await run()
  check('if the cross-check gets no reply, the draft is shown rather than nothing', d.shown === llm.draft && d.out.text === llm.draft && d.out.retrieval === r, `${d.roles} | ${d.shown}`)

  console.log('\n## "FAR, setbacks and coverage for a 200sqm residential plot in dehradun plains" (the reported question)')
  const dq = 'FAR, setbacks and coverage for a 200sqm residential plot in dehradun plains.'
  const dr = await inOrg('trijya', () => ans.retrieve('bylaws', dq, 8, { state: 'Uttarakhand' }))
  const show = dr.passages.map((p) => `${p.fileName}: ${p.values ?? p.matchedRow ?? p.text.slice(0, 40)}`).join(' | ')
  const farRow = dr.passages.find((p) => p.path === UK && /Plains FAR 1\.70/.test(p.values ?? ''))
  const setbackRow = dr.passages.find((p) => p.path === UK && /150-250/.test(p.matchedRow ?? '') && /3\.0/.test(`${p.values ?? ''} ${p.matchedRow ?? ''}`))
  check('MDDA\'s FAR and coverage row for 150-250 sq m is found: plains coverage 65%, FAR 1.70', !!farRow && /Plains ground coverage 65%/.test(farRow.values ?? ''), show)
  check('MDDA\'s residential setback row for 150-250 sq m is found too (a separate table)', !!setbackRow, show)
  check('every part asked was found (nothing missing)', dr.allMatched && !dr.missing, `${dr.allMatched} ${dr.missing ?? ''}`)
  check('the DRAFT is not used when the bylaws in force give the rows', !dr.passages.some((p) => p.path === UK_DRAFT), show)
  const dPrompt = String(ans.buildAnswerMessages(dr, dq, [], 'Forge')[0]!.content)
  check('the model is given MDDA\'s rows, not the draft\'s 75% / 1.20 m',
    dPrompt.includes('Plains FAR 1.70') && dPrompt.includes('Plains ground coverage 65%') && !/\b75\n2\.25\n1\.20/.test(dPrompt) && !dPrompt.includes('DRAFT.pdf'))
  check('"dehradun plains": the Plains column is THE answer, the two columns are never alternatives',
    /The question is about the plains: where a row gives Plains and Hills figures, the Plains figure is the answer/.test(dPrompt) && /never present the two as alternatives/.test(dPrompt))
  check('hills and unspecified questions are handled too',
    /The question is about the hills/.test(ans.plainsOrHills('setback for a hill area plot')) && /The question is about the hills/.test(ans.plainsOrHills('पर्वतीय क्षेत्र में सेट बैक')) &&
    /does not say which, give both, each labelled/.test(ans.plainsOrHills('FAR for 200 sq m residential')))
  // Without the bylaws in force, the draft is used, and marked as a draft.
  const onlyDraft = ans.renderPassages([{ server: 'WD', path: UK_DRAFT, fileName: 'DRAFT.pdf', chunkIndex: 1, score: 0.9, text: 'x' }], 'Uttarakhand')
  check('a draft is labelled "DRAFT: proposed, not in force" for the model', onlyDraft.includes('DRAFT.pdf (Uttarakhand bylaws) (DRAFT: proposed, not in force)'), onlyDraft)
  // Two of three topics found: the answer covers those two, it is not thrown away.
  const partial = String(ans.buildAnswerMessages({ ...dr, missing: 'setback (residential) for a 200 sq m plot' }, dq, [], 'Forge')[0]!.content)
  check('when one topic has no row, the others are still answered (never all dropped)',
    /none for setback \(residential\) for a 200 sq m plot/.test(partial) && /Answer every part they give, in full/.test(partial) && /Do not reply NOT_IN_DOCUMENTS/.test(partial))

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
  const stateAllowed = new Set([UK, UK_GO, UK_OLD, UK_DRAFT, UP])
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
