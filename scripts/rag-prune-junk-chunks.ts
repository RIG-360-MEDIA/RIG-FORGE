/**
 * One-off: remove near-empty chunks (number tables, stray headers, ",2016")
 * that were indexed before index-core started skipping them. Uses the SAME
 * rule as indexing (hasEnoughText in lib/rag/chunk.ts), so it deletes exactly
 * what a re-index would no longer write.
 *
 *   npx tsx scripts/rag-prune-junk-chunks.ts                 dry run: count + samples
 *   npx tsx scripts/rag-prune-junk-chunks.ts --delete        actually delete
 *   options: --collection <name> (default trijya_bylaws_e5), --env <path to .env>
 *
 * Talks to Qdrant over REST with QDRANT_URL / QDRANT_API_KEY, read from the
 * environment or from the .env file (default: the repo root's .env).
 *
 * Leaves gaps in chunkIndex for the affected files. That is harmless: search
 * does not use the index, and the next re-index of a file renumbers its chunks
 * from 0 and prunes everything past the new count. The tracker's chunkCount
 * for those files stays at the old number until then.
 */
import fs from 'node:fs'

import { hasEnoughText, letterCount, MIN_CHUNK_LETTERS } from '../lib/rag/chunk'

const args = process.argv.slice(2)
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const DELETE = args.includes('--delete')
const COLLECTION = opt('--collection') ?? 'trijya_bylaws_e5'

function loadEnv(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {}
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)).filter((m): m is RegExpMatchArray => !!m)
    .map((m) => [m[1]!, m[2]!.trim().replace(/^(["'])(.*)\1$/, '$2')]))
}
const fileEnv = loadEnv(opt('--env') ?? '.env')
const URL_ = (process.env.QDRANT_URL ?? fileEnv.QDRANT_URL ?? '').replace(/\/$/, '')
const KEY = process.env.QDRANT_API_KEY ?? fileEnv.QDRANT_API_KEY ?? ''
if (!URL_) { console.error('QDRANT_URL is not set (environment or .env)'); process.exit(1) }

async function qdrant(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${URL_}/collections/${COLLECTION}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'api-key': KEY, 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`Qdrant ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()).result
}

interface Junk { id: string | number; path: string; chunkIndex: number; letters: number; text: string }

async function main() {
  const info = await qdrant('')
  const total: number = info.points_count
  console.log(`${COLLECTION}: ${total} points; rule: fewer than ${MIN_CHUNK_LETTERS} letters (RAG_MIN_CHUNK_LETTERS)`)

  const junk: Junk[] = []
  let offset: unknown = null, seen = 0
  do {
    const page = await qdrant('/points/scroll', { limit: 1000, offset, with_payload: ['path', 'chunkIndex', 'text'], with_vector: false })
    for (const p of page.points) {
      seen++
      const text = String(p.payload?.text ?? '')
      if (!hasEnoughText(text)) junk.push({ id: p.id, path: p.payload.path, chunkIndex: p.payload.chunkIndex, letters: letterCount(text), text })
    }
    offset = page.next_page_offset
  } while (offset !== null && offset !== undefined)

  const byFile = new Map<string, number>()
  for (const j of junk) byFile.set(j.path, (byFile.get(j.path) ?? 0) + 1)
  console.log(`\nscanned ${seen}; near-empty: ${junk.length} (${((100 * junk.length) / Math.max(1, seen)).toFixed(2)}%) in ${byFile.size} files`)
  for (const [path, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${path}`)
  console.log('\nsamples:')
  for (const j of junk.filter((_, i) => i % Math.max(1, Math.floor(junk.length / 15)) === 0).slice(0, 15)) {
    console.log(`  [${j.letters} letters] ${JSON.stringify(j.text.replace(/\s+/g, ' ').slice(0, 90))}`)
  }

  if (!DELETE) { console.log('\nDRY RUN, nothing deleted. Re-run with --delete to remove these points.'); return }

  for (let i = 0; i < junk.length; i += 500) {
    await qdrant('/points/delete?wait=true', { points: junk.slice(i, i + 500).map((j) => j.id) })
  }
  const after = await qdrant('')
  console.log(`\nDELETED ${junk.length}. ${COLLECTION} now has ${after.points_count} points (was ${total}).`)
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
