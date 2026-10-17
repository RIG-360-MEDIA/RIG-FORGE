/**
 * Runs the bylaws test pack (cases.mjs) through THIS checkout's search code
 * (lib/rag/qdrant.ts searchChunksConstrained) against a real Qdrant and
 * embedding service. Use it after changing lib/rag/query-match.ts or
 * qdrant.ts, before pushing. Read-only: search and retrieve calls only.
 *
 *   npx tsx scripts/bylaws-eval/run-local.mts [--env=path/to/.env] [caseIdRegex] [-v]
 *
 * Needs the same settings as production: QDRANT_URL, QDRANT_API_KEY,
 * QDRANT_BYLAWS_COLLECTION, HF_EMBEDDING_MODEL, HF_EMBEDDING_DIM,
 * RAG_MIN_SCORE, and for TRIJYA-3 (embeddings and Qdrant through the NAS
 * connector) TRIJYA_NAS_BASE_URL, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET.
 * --env reads only those keys from a file (never DATABASE_URL: no database is
 * touched). Query vectors are cached in .bylaws-eval-cache.json (gitignored;
 * delete it after changing the embedding model).
 */
import fs from 'node:fs'
import path from 'node:path'

const KEYS = ['QDRANT_URL', 'QDRANT_API_KEY', 'QDRANT_BYLAWS_COLLECTION', 'TRIJYA_NAS_BASE_URL', 'CF_ACCESS_CLIENT_ID',
  'CF_ACCESS_CLIENT_SECRET', 'HF_EMBEDDING_MODEL', 'HF_EMBEDDING_DIM', 'RAG_MIN_SCORE', 'HF_API_KEY']
const envArg = process.argv.find((a) => a.startsWith('--env='))
if (envArg) {
  for (const l of fs.readFileSync(envArg.slice(6), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && KEYS.includes(m[1]!)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
  }
}
const ORG = process.env.NAS_ORG_ID || 'trijya'
const norm = (s: string) => s.replace(/[–—−]/g, '-').replace(/\s+/g, ' ')

const { CASES } = await import('./cases.mjs')
const { embedQuery } = await import('../../lib/rag/embeddings')
const q = await import('../../lib/rag/qdrant')
const qm = await import('../../lib/rag/query-match')

const cacheFile = path.join(process.cwd(), '.bylaws-eval-cache.json')
const cache: Record<string, number[]> = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {}
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const filt = args[0] ? new RegExp(args[0]) : null
const verbose = process.argv.includes('-v')

let pass = 0, n = 0
const fails: string[] = []
for (const c of CASES as Array<any>) {
  if (filt && !filt.test(c.id)) continue
  n++
  if (!cache[c.q]) { cache[c.q] = await embedQuery(c.q); fs.writeFileSync(cacheFile, JSON.stringify(cache)) }
  const t0 = Date.now()
  const r = await q.searchChunksConstrained(ORG, cache[c.q]!, c.q, 8, q.BYLAWS_COLLECTION)
  const ms = Date.now() - t0
  const hits = r.hits as Array<any>
  const ok = c.review ? true : c.none ? hits.length === 0
    : hits.slice(0, c.top).some((h) => c.expect.some((e: any) => (!e.file || e.file.test(h.fileName)) && e.row.test(norm(h.matchedRow || h.text || ''))))
  if (ok) pass++; else fails.push(c.id)
  const req = qm.isConstrained(r.constraints) ? qm.describeConstraints(r.constraints) : '-'
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.id.padEnd(16)} ${String(ms).padStart(5)}ms [${req}] allMatched=${r.allMatched} "${c.q}"`)
  if (!ok || verbose || c.review) {
    for (const h of hits.slice(0, Math.max(3, c.top || 0))) {
      console.log(`      ${h.score.toFixed(3)} ${h.fileName.slice(0, 28).padEnd(28)} #${h.chunkIndex} ${h.section ? `{${h.section.slice(0, 60)}} ` : ''}${h.matchedRow ? `ROW[${norm(h.matchedRow)}]` : norm(h.text).slice(0, 110)}${h.values ? `  => ${h.values}` : ''}`)
    }
  }
}
console.log(`\n${pass}/${n} passed${fails.length ? `; failed: ${fails.join(', ')}` : ''}`)
process.exitCode = fails.length ? 1 : 0
