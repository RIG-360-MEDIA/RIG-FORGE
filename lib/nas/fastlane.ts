/**
 * NAS search fast-lane — answers "find/search <term> on the NAS" straight from
 * the connector's filename index (single-digit ms), no LLM. High precision:
 * defers to the LLM (returns null) on anything ambiguous, long, or without a
 * concrete search term. Only runs when NAS is enabled for the org (Trijya).
 */
import { isNasEnabled, nasServers, nasSearch, nasSemantic, nasFetchBytes } from './client'
import { extractText, isExtractable } from './extract'

const VERB = /\b(find|search|locate|look for|looking for|show me|do we have|is there|are there|where is|where are|pull up|get me)\b/i
// Bylaws in any spelling (bylaws, by laws, by_laws, bye-laws, byelaws) are
// documents too: "find the byelaws" is a file request even without "pdf".
// Not a bare "by law", so "find what is required by law" stays with the LLM.
const NOUN = /\b(nas|file|files|folder|folders|drawing|drawings|dwg|revit|document|documents|pdf|blueprint|floor ?plan|elevation|render|renders|drive|server|bylaws?|byelaws?|by[ _-]laws|bye[ _-]laws?)\b/i
// An explicit NAS/server mention is strong enough intent to search even without
// a verb ("elevation drawings on the nas", "BOQ files on the server").
const NAS_EXPLICIT = /\b(nas|on (the )?server|from (the )?server|on (the )?drive)\b/i
// Action intent belongs to the LLM/UI, not the read-only search lane.
const WRITE = /\b(upload|delete|remove|move|rename|create|add|save|put|copy|share|send)\b/i
// "latest / newest / most recent <thing>" → sort newest-first by modified date.
const LATEST = /\b(latest|newest|most recent|recent|last|current)\b/i
// Words to strip so the remainder is the actual search term.
const STOP =
  /\b(can|could|would|will|you|u|please|pls|plz|kindly|able|find|search|locate|look|for|looking|show|me|do|we|have|has|is|are|there|where|the|a|an|any|all|some|on|in|from|of|about|our|my|whats|what|it|to|related|named|name|call|called|regarding|with|and|or|nas|file|files|folder|folders|drawing|drawings|dwg|revit|document|documents|pdf|pdfs|blueprint|render|renders|drive|server|latest|recent)\b/gi

export async function tryNasFastLane(raw: string): Promise<string | null> {
  if (!isNasEnabled()) return null
  const c = (raw ?? '').trim()
  if (!c || c.length > 140) return null // long/complex → let the LLM handle it
  if (WRITE.test(c)) return null // upload/delete/etc → not the read-only lane
  if (READ_VERB.test(c)) return null // "read/summarize …" → the read fast-path handles it
  if (!NOUN.test(c)) return null
  if (!VERB.test(c) && !NAS_EXPLICIT.test(c)) return null // need a verb OR explicit NAS

  // "latest/newest survey drawings" → newest-first. Detect BEFORE stripping
  // (STOP removes these words from the search term itself).
  const wantsLatest = LATEST.test(c)

  const term = c
    .toLowerCase()
    .replace(STOP, ' ')
    .replace(/[^\p{L}\p{N}\s._-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (term.length < 3) return null // no concrete term → defer to the LLM

  try {
    const servers = await nasServers()
    // Search every NAS concurrently (servers cached) — one round-trip, not N.
    const perServer = await Promise.all(
      servers.map((s) =>
        nasSearch(s.label, term, { limit: 15, sort: wantsLatest ? 'latest' : 'relevance' })
          .then((r) => r.results.map((h) => ({ server: s.label, ...h })))
          .catch(() => []),
      ),
    )
    let hits = perServer.flat().slice(0, 40)
    // Merging drives breaks per-drive ordering — re-sort across both.
    if (wantsLatest) hits.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))

    // No exact filename match → try MEANING-based (embedding) search, still no
    // LLM. Catches "hotel elevations" matching "GROUND FLOOR PLAN" etc.
    let semantic = false
    if (hits.length === 0) {
      const perServerSem = await Promise.all(
        servers.map((s) =>
          nasSemantic(s.label, term, 12)
            .then((rs) => rs.map((h) => ({ server: s.label, name: h.name, path: h.path, isDir: false, size: 0 })))
            .catch(() => []),
        ),
      )
      hits = perServerSem.flat().slice(0, 24)
      semantic = hits.length > 0
    }

    if (hits.length === 0) {
      return `I searched the NAS for “${term}” but didn't find any matching files. Try a different keyword, or browse them in Workspace → Files.`
    }

    const files = hits.filter((h) => !h.isDir).slice(0, 12)
    const dirs = hits.filter((h) => h.isDir).slice(0, 5)
    const fmtDate = (m?: number) =>
      m ? new Date(m * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : null
    const lines: string[] = [
      `Found ${hits.length} match${hits.length === 1 ? '' : 'es'} for “${term}” on the NAS${
        semantic ? ' (by meaning)' : ''
      }${wantsLatest ? ' — newest first' : ''}:`,
    ]
    for (const f of files) {
      const url = `/api/nas/download?server=${encodeURIComponent(f.server)}&path=${encodeURIComponent(f.path)}`
      const d = fmtDate(f.mtime)
      lines.push(`• [${f.name}](${url}) — _${f.server}_${d ? ` · ${d}` : ''} ${f.path}`)
    }
    for (const d of dirs) {
      lines.push(`• Folder: ${d.name} — _${d.server}_ ${d.path}`)
    }
    if (hits.length > files.length + dirs.length) {
      lines.push(`…and more. Open Workspace → Files to browse everything.`)
    }
    return lines.join('\n')
  } catch {
    return null // connector hiccup → fall through to the LLM path
  }
}

// ── NAS read fast-path ───────────────────────────────────────────────────────
// "read/summarize <file> on the NAS" → resolve the file from the index, extract
// its text here, and hand it back so the route can answer in ONE no-tools LLM
// call (fast + reliable — small models summarize text fine; they only choke on
// agentic tool-calling). Returns null when there's no clear file to read.
const READ_VERB = /\b(read|open|summar\w*|what.?s in|what does|whats in|tell me about|explain|contents? of|go through|review|check)\b/i

function extractFileHint(c: string): string | null {
  // Prefer an explicit filename token (contiguous, has an extension) — must NOT
  // swallow preceding words ("read the print.pdf" → "print.pdf", not the phrase).
  const named = c.match(/([\w.()\-]+\.(?:pdf|txt|csv|md|xlsx?|docx?|json|log|xml))\b/i)
  if (named) return named[1].trim()
  // Else strip intent/stop words and use the remainder as a name hint.
  const term = c
    .toLowerCase()
    .replace(READ_VERB, ' ')
    .replace(/\b(the|a|an|on|in|from|of|nas|file|files|drive|server|please|me|about|for|contents?|whats?|is|there|what)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s._-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return term.length >= 3 ? term : null
}

export interface NasReadHit {
  name: string
  server: string
  path: string
  text: string
}

const READ_NOUN = /\b(nas|file|files|folder|drawing|dwg|document|pdf|xlsx?|docx?|spreadsheet|drive|server|report|spec|specs|boq|sheet)\b/i

export async function tryNasReadIntent(raw: string): Promise<NasReadHit | null> {
  if (!isNasEnabled()) return null
  const c = (raw ?? '').trim()
  if (!c || c.length > 200 || !READ_VERB.test(c)) return null
  // Require a file noun or an explicit filename so generic "summarize …" turns
  // don't needlessly hit the NAS.
  if (!READ_NOUN.test(c) && !/\.\w{2,4}\b/.test(c)) return null
  const hint = extractFileHint(c)
  if (!hint) return null

  try {
    const servers = await nasServers()
    const found = (
      await Promise.all(
        servers.map((s) =>
          nasSearch(s.label, hint, { limit: 8 })
            .then((r) => r.results.filter((x) => !x.isDir).map((h) => ({ server: s.label, ...h })))
            .catch(() => []),
        ),
      )
    ).flat()
    if (!found.length) return null

    // Prefer an exact filename match, then any extractable file, then first.
    const lower = hint.toLowerCase()
    const best =
      found.find((f) => f.name.toLowerCase() === lower) ||
      found.find((f) => isExtractable(f.name)) ||
      found[0]
    if (!best || !isExtractable(best.name)) return null // e.g. a .dwg — can't read

    const buf = await nasFetchBytes(best.server, best.path)
    const text = await extractText(best.name, buf)
    return { name: best.name, server: best.server, path: best.path, text }
  } catch {
    return null
  }
}
