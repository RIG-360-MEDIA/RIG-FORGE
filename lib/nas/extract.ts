/**
 * Shared NAS file → text extraction (used by the Forgie nas_read tool and the
 * NAS read fast-path). Supports plain text, spreadsheets, and PDFs. Binary
 * formats (CAD, images) return a short note instead of throwing.
 */
import * as XLSX from 'xlsx'

const TEXTY = new Set(['txt', 'csv', 'md', 'log', 'json', 'xml', 'svg', 'ini', 'yaml', 'yml', 'tsv', 'rtf'])
export const EXTRACTABLE = new Set([...TEXTY, 'pdf', 'xlsx', 'xls'])
const MAX_TEXT = 12_000

export function fileExt(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

export function isExtractable(name: string): boolean {
  return EXTRACTABLE.has(fileExt(name))
}

export async function extractText(name: string, buf: Buffer): Promise<string> {
  const x = fileExt(name)
  if (TEXTY.has(x)) return buf.toString('utf8').slice(0, MAX_TEXT)
  if (x === 'pdf') {
    try {
      // Import the lib entry directly — the package index runs a debug block
      // that reads a test file when it thinks it's the main module, which
      // throws under a bundler.
      const mod = await import('pdf-parse/lib/pdf-parse.js')
      const pdfParse = (mod.default ?? mod) as (b: Buffer) => Promise<{ text: string }>
      const data = await pdfParse(buf)
      const t = (data.text || '').replace(/\n{3,}/g, '\n\n').trim()
      return t ? t.slice(0, MAX_TEXT) : '(this PDF has no selectable text — likely a scanned drawing/image; download it to view)'
    } catch (e) {
      return `(could not extract text from PDF ${name}: ${e instanceof Error ? e.message.slice(0, 80) : 'error'})`
    }
  }
  if (x === 'xlsx' || x === 'xls') {
    try {
      const wb = XLSX.read(buf, { type: 'buffer' })
      let out = ''
      for (const s of wb.SheetNames.slice(0, 5)) {
        out += `# Sheet: ${s}\n` + XLSX.utils.sheet_to_csv(wb.Sheets[s]!).slice(0, 4000) + '\n\n'
      }
      return out.slice(0, MAX_TEXT) || '(empty spreadsheet)'
    } catch {
      return `(could not parse spreadsheet ${name})`
    }
  }
  return `(binary ${x || 'file'}, ${buf.length} bytes — text extraction for this type isn't supported yet; download it to view)`
}

// ─── Extraction for content INDEXING ─────────────────────────────────────────
//
// extractText above is built for a PREVIEW shown to the LLM, and two of its
// choices are wrong for indexing, which originally reused it:
//
//  1. It caps text at 12,000 characters. A long statutory PDF keeps only its
//     first few pages, and the rest is never searchable — with no signal.
//  2. On failure it RETURNS a human-readable sentence such as "(could not
//     extract text from PDF …)". The indexer cannot tell that apart from real
//     content, so it embedded the error message and marked the file INDEXED.
//
// extractForIndex uses a far larger cap and reports failure as a structured
// result, so a failed file is recorded as FAILED with the real reason.

/** Upper bound on indexed characters per file (~300 pages of dense text).
 * Bounded so one enormous file cannot dominate embedding time and cost. */
const INDEX_MAX_TEXT = Number(process.env.RAG_MAX_TEXT_CHARS ?? 1_000_000)

export type IndexExtraction =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; reason: string }

export async function extractForIndex(name: string, buf: Buffer): Promise<IndexExtraction> {
  const x = fileExt(name)
  const cap = (t: string): IndexExtraction => {
    const clean = t.replace(/\n{3,}/g, '\n\n').trim()
    if (!clean) return { ok: false, reason: 'no extractable text' }
    return { ok: true, text: clean.slice(0, INDEX_MAX_TEXT), truncated: clean.length > INDEX_MAX_TEXT }
  }

  if (TEXTY.has(x)) return cap(buf.toString('utf8'))

  if (x === 'pdf') {
    let data: { text: string }
    try {
      const mod = await import('pdf-parse/lib/pdf-parse.js')
      const pdfParse = (mod.default ?? mod) as (b: Buffer) => Promise<{ text: string }>
      data = await pdfParse(buf)
    } catch (e) {
      return { ok: false, reason: `PDF could not be parsed: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}` }
    }
    const result = cap(data.text || '')
    // A PDF that parses but yields no text is almost always a scan (images of
    // pages). Name that explicitly — it is common for government bylaws and is
    // fixable later with OCR, unlike a corrupt file.
    if (!result.ok) return { ok: false, reason: 'PDF has no selectable text (likely scanned images; needs OCR)' }
    return result
  }

  if (x === 'xlsx' || x === 'xls') {
    try {
      const wb = XLSX.read(buf, { type: 'buffer' })
      // Every sheet, in full — the preview's 5-sheet / 4,000-char limits drop data.
      const out = wb.SheetNames.map((s) => `# Sheet: ${s}\n` + XLSX.utils.sheet_to_csv(wb.Sheets[s]!)).join('\n\n')
      return cap(out)
    } catch (e) {
      return { ok: false, reason: `spreadsheet could not be parsed: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}` }
    }
  }

  return { ok: false, reason: `.${x || 'unknown'} files are not supported for content indexing` }
}
