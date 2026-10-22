/**
 * Same passages, same answer prompt, every provider: writes each provider's
 * answer to a bylaws question side by side, with the production answer
 * (whatever model the live Bylaws tab uses) as the reference, and flags the
 * answer-prompt rules each one breaks. Use it after changing the answer
 * prompt in lib/rag/answer.ts, or a provider's model, before pushing.
 *
 *   npx tsx scripts/bylaws-eval/answer-compare.mts --env=path/to/.env [--providers=groq,gemini,local] [--live] [caseIdRegex]
 *
 * --env reads only the search and provider keys (never DATABASE_URL).
 * --live also fetches the production answer (FORGE_EMAIL / FORGE_PASS).
 * Output: the answers, then a table of rule flags per provider. Read-only.
 */
import fs from 'node:fs'

const KEYS = ['QDRANT_URL', 'QDRANT_API_KEY', 'QDRANT_BYLAWS_COLLECTION', 'TRIJYA_NAS_BASE_URL', 'CF_ACCESS_CLIENT_ID',
  'CF_ACCESS_CLIENT_SECRET', 'HF_EMBEDDING_MODEL', 'HF_EMBEDDING_DIM', 'RAG_MIN_SCORE', 'HF_API_KEY',
  'OPENAI_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_MODEL', 'GROQ_API_KEYS', 'GROQ_MODEL', 'GEMINI_API_KEYS', 'GEMINI_MODEL',
  'LOCAL_LLM_BASE_URL', 'LOCAL_LLM_API_KEY', 'LOCAL_LLM_MODEL', 'CEREBRAS_API_KEYS', 'CEREBRAS_MODEL']
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const envFile = arg('env')
if (envFile) {
  for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && KEYS.includes(m[1]!)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
  }
}
process.env.ASSISTANT_ENABLED = 'true'
process.env.ASSISTANT_PROVIDER_ORDER = 'openai,local,groq,gemini,cerebras'
const ORG = process.env.NAS_ORG_ID || 'trijya'
const BASE = process.env.FORGE_URL || 'https://rig-forge.onrender.com'

type Name = 'openai' | 'local' | 'groq' | 'gemini' | 'cerebras'
const ALL: Name[] = ['openai', 'local', 'groq', 'gemini', 'cerebras']
const providers = (arg('providers') ?? 'groq,gemini,local').split(',').map((s) => s.trim()) as Name[]
const live = process.argv.includes('--live')

export const QUESTIONS = [
  { id: 'far-2000', q: 'What is the FAR for a 2000 sq m residential plot?' },
  { id: 'setback-200', q: 'What is the setback for a 200 sq m residential plot?' },
  { id: 'parking-hospital', q: 'Parking requirement for a hospital' },
  { id: 'hi-coverage-300', q: 'आवासीय भूखंड 300 वर्ग मीटर के लिए ग्राउंड कवरेज कितना है?' },
  { id: 'coverage-comm-500', q: 'Ground coverage for a 500 sq m commercial plot' },
  { id: 'stair-residential', q: 'Minimum width of staircase in a residential building' },
  { id: 'height-road-9', q: 'Maximum building height allowed on a 9 m wide road' },
  { id: 'far-hotel-24', q: 'FAR for a hotel on a 24 m road' },
  { id: 'basement', q: 'How many basements are allowed and what setback is needed for a basement?' },
  { id: 'not-found', q: 'Minimum depth of a swimming pool in a residential society' },
]

const { embedQuery } = await import('../../lib/rag/embeddings')
const q = await import('../../lib/rag/qdrant')
const qm = await import('../../lib/rag/query-match')
const { buildAnswerMessages, cleanCitations } = await import('../../lib/rag/answer')
const { streamPlainAnswer } = await import('../../lib/llm/stream')
type Retrieval = Parameters<typeof buildAnswerMessages>[0]

async function retrieve(query: string): Promise<Retrieval> {
  const vector = await embedQuery(query)
  const { hits, constraints, allMatched } = await q.searchChunksConstrained(ORG, vector, query, 8, q.BYLAWS_COLLECTION)
  return {
    source: 'bylaws', query, allMatched,
    requirement: qm.isConstrained(constraints) ? qm.describeConstraints(constraints) : null,
    passages: (hits as Array<any>).map((h) => ({
      server: h.server, path: h.path, fileName: h.fileName, score: h.score, text: h.text,
      ...(h.matchedRow ? { matchedRow: h.matchedRow } : {}), ...(h.section ? { section: h.section } : {}), ...(h.values ? { values: h.values } : {}),
    })),
  }
}

let cookie = ''
async function liveAnswer(query: string): Promise<{ text: string; model: string; ms: number }> {
  if (!cookie) {
    const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.FORGE_EMAIL, password: process.env.FORGE_PASS }) })
    cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  }
  const t0 = Date.now()
  const res = await fetch(`${BASE}/api/nas/bylaws/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(150_000) })
  let text = '', model = '?'
  for (const l of (await res.text()).split('\n')) {
    if (!l.trim()) continue
    const f = JSON.parse(l)
    if (f.type === 'text') text += f.delta
    if (f.type === 'done') model = `${f.provider}/${f.model}`
  }
  return { text, model, ms: Date.now() - t0 }
}

/** The answer-prompt rules a reply can be checked for mechanically. */
export function flags(question: string, answer: string, nPassages: number): string[] {
  const out: string[] = []
  const hasNumber = /\d/.test(question.replace(/\d+\s*(st|nd|rd|th)\b/g, ''))
  if (!answer.trim()) return ['EMPTY']
  if (/【/.test(answer)) out.push('odd-brackets')
  for (const m of answer.matchAll(/\[(\d{1,2})\]/g)) if (Number(m[1]) > nPassages) { out.push(`cites-[${m[1]}]`); break }
  if (!/\[\d{1,2}\]|【\d/.test(answer)) out.push('no-citations')
  if (/not (provided|detailed|specified|mentioned|given|stated|shown|available)|no other [^.]*\b(appear|given|stated|provided)|partial text|(?:are|is) not (?:included|listed)|दिया नहीं|नहीं दिया|उपलब्ध नहीं/i.test(answer)
    && !/not found in the documents|documents do not|bylaws do not/i.test(answer)) out.push('filler')
  if (!hasNumber && /\bassum|for example,? (?:a|an) \d|e\.g\.,? (?:a|an) \d|suppose/i.test(answer)) out.push('invented-example')
  if (/\b(refers to|is defined as|means the|the standard [a-z ]*ratio|the upper limit|the maximum allowed floor area)\b/i.test(answer)) out.push('explains-term')
  const paras = answer.trim().split(/\n\s*\n/)
  if (/^\s*(\*\*)?(in summary|summary|overall|thus|therefore|in short|to summari[sz]e|इसलिए|सारांश)/i.test(paras[paras.length - 1] ?? '')) out.push('closing-summary')
  if (/\p{Script=Devanagari}/u.test(question) !== /\p{Script=Devanagari}/u.test(answer.replace(/\[[^\]]*\]/g, ''))) out.push('wrong-language')
  return out
}

const filt = process.argv.slice(2).find((a) => !a.startsWith('-'))
const rows: string[] = []
for (const item of QUESTIONS) {
  if (filt && !new RegExp(filt).test(item.id)) continue
  const r = await retrieve(item.q)
  console.log(`\n${'#'.repeat(100)}\n# ${item.id}: ${item.q}\n# ${r.passages.length} passages, requirement=${r.requirement ?? '-'}, allMatched=${r.allMatched}`)
  const cells: string[] = []
  if (live) {
    const a = await liveAnswer(item.q)
    const f = flags(item.q, a.text, r.passages.length)
    console.log(`\n=== LIVE ${a.model} ${a.ms}ms ${a.text.split(/\s+/).length}w ${f.join(' ') || 'ok'}\n${a.text}`)
    cells.push(`live:${f.join('+') || 'ok'}`)
  }
  for (const p of providers) {
    const messages = buildAnswerMessages(r, item.q, [], 'Trijya')
    const t0 = Date.now()
    const { text: raw, meta } = await streamPlainAnswer(messages,
      { exclude: ALL.filter((x) => x !== p), temperature: 0.2, maxOutputTokens: 4000 }, () => {})
    const text = cleanCitations(raw)
    const f = flags(item.q, text, r.passages.length)
    console.log(`\n=== ${p} ${meta?.model ?? '(failed)'} ${Date.now() - t0}ms ${text.split(/\s+/).length}w ${f.join(' ') || 'ok'}\n${text}`)
    cells.push(`${p}:${f.join('+') || 'ok'}`)
  }
  rows.push(`${item.id.padEnd(18)} ${cells.join('  ')}`)
}
console.log(`\n${'='.repeat(100)}\nRULE FLAGS\n${rows.join('\n')}`)
