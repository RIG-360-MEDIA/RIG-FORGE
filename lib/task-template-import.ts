import * as XLSX from 'xlsx'

/**
 * Reads task templates out of an Excel workbook, one template per sheet, in
 * the browser (the file never leaves the admin's machine until they confirm).
 *
 * Two layouts are understood, both from Trijya's "Project Task Template.xlsx":
 *
 *   1. A task-tool export (Zoho Projects and the like): a header row with a
 *      "Task Name" column. Items are that column; a "Tags", "Task List",
 *      "Category" or "Section" column, when filled, gives the category.
 *   2. A plain numbered list: "1 | Furniture drawings". A row lettered
 *      "A | DESIGN", or an unnumbered heading such as "Electrical TASK" or
 *      "GENERAL TASKS", starts a section, and a section is a category.
 *
 * Items before any section heading get the sheet's own name as their
 * category; the preview lets the admin change every name before importing.
 */

export interface ParsedGroup {
  /** Category the items go under; null = none. */
  category: string | null
  items: string[]
}

export interface ParsedSheet {
  sheet: string
  /** Suggested template name (the sheet name, tidied). */
  name: string
  groups: ParsedGroup[]
}

const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim()

/** Short words that are ordinary English, not acronyms, in an ALL-CAPS heading. */
const SMALL_WORDS = new Set(['A', 'AN', 'AND', 'THE', 'OF', 'ON', 'IN', 'TO', 'OR', 'AT', 'FOR', 'BY', 'ALL', 'NEW', 'OLD'])

/**
 * First letter capital, rest as written. ALL-CAPS headings become sentence
 * case, except short acronyms ("AC", "TV", "POP", "SLD") which stay capitals.
 */
function sentence(s: string): string {
  const t = s === s.toUpperCase()
    ? s.split(/(\s+|[&/,-])/).map((w) => (/^[A-Z]{2,3}$/.test(w) && !SMALL_WORDS.has(w) ? w : w.toLowerCase())).join('')
    : s
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** A task title: no "34." numbering, the broken-encoding character mended, capitalised. */
export function tidyTitle(raw: string): string {
  const s = clean(raw)
    .replace(/^\d{1,3}[.)]\s*/, '')
    // U+FFFD left by a bad encoding: an apostrophe in "Director's", a dash elsewhere.
    .replace(/(\p{L})�(s\b)/gu, "$1'$2")
    .replace(/\s*�\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''
}

/** "INTERIOR DESIGN TASK TEMPLATE" -> "Interior design"; "Electrical TASK" -> "Electrical". */
function tidyHeading(raw: string): string {
  const s = clean(raw).replace(/\b(task\s*template|tasks?|template)\b/gi, '').replace(/\s+/g, ' ').trim()
  return sentence(s || clean(raw))
}

const isNumber = (s: string) => /^\d{1,3}[.)]?$/.test(s)
const isLetter = (s: string) => /^[A-Za-z][.)]?$/.test(s)
/** "Sno", "S.No", "Sr. No." column labels, not content. */
const isSerialLabel = (s: string) => /^(s\.?\s*no\.?|sr\.?\s*(no\.?)?|sl\.?\s*no\.?|#)$/i.test(s)

function parseExport(rows: string[][], headerAt: number, sheetName: string): ParsedGroup[] {
  const header = rows[headerAt]!.map((c) => c.toLowerCase())
  const nameCol = header.findIndex((c) => /^task\s*name$/.test(c))
  const catCol = header.findIndex((c) => /^(tags?|task\s*list|category|section)$/.test(c))
  const groups = new Map<string, string[]>()
  for (const row of rows.slice(headerAt + 1)) {
    const title = tidyTitle(row[nameCol] ?? '')
    if (!title) continue
    const cat = catCol >= 0 ? clean(row[catCol]) : ''
    const key = cat ? sentence(cat) : sentence(sheetName)
    groups.set(key, [...(groups.get(key) ?? []), title])
  }
  return [...groups].map(([category, items]) => ({ category, items }))
}

function parseList(rows: string[][], sheetName: string): ParsedGroup[] {
  const groups: ParsedGroup[] = []
  let current: ParsedGroup | null = null
  const push = (category: string | null) => { current = { category, items: [] }; groups.push(current) }

  for (const row of rows) {
    const cells = row.map(clean)
    const filled = cells.filter(Boolean)
    if (filled.length === 0) continue
    const first = filled[0]!
    const text = filled.length > 1 ? filled.slice(1).join(' ') : first

    if (filled.length > 1 && isLetter(first)) { push(tidyHeading(text)); continue }        // "A | DESIGN"
    if (filled.length > 1 && isNumber(first)) {                                               // "1 | Furniture drawings"
      if (!current) push(sentence(sheetName))
      current!.items.push(tidyTitle(text))
      continue
    }
    // Unnumbered: a heading when it says so ("... TASK", "Sno | ... TEMPLATE")
    // or is written in capitals; otherwise an item (the "general" sheet's
    // items have no numbers).
    const label = filled.length > 1 && isSerialLabel(first) ? text : filled.join(' ')
    if (/\btasks?\b|\btemplate\b/i.test(label) || (label === label.toUpperCase() && /[A-Z]/.test(label) && label.length <= 60)) {
      push(tidyHeading(label))
      continue
    }
    if (!current) push(sentence(sheetName))
    current!.items.push(tidyTitle(label))
  }
  return groups.filter((g) => g.items.length > 0)
}

export function parseTemplateWorkbook(data: ArrayBuffer): ParsedSheet[] {
  const wb = XLSX.read(data, { type: 'array' })
  const out: ParsedSheet[] = []
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName]
    if (!ws) continue
    const rows = (XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) as unknown[][])
      .map((r) => r.map((c) => clean(c)))
    const headerAt = rows.findIndex((r) => r.some((c) => /^task\s*name$/i.test(c)))
    const groups = headerAt >= 0 ? parseExport(rows, headerAt, sheetName) : parseList(rows, sheetName)
    const items = groups.reduce((n, g) => n + g.items.length, 0)
    if (items > 0) out.push({ sheet: sheetName, name: sentence(clean(sheetName)), groups })
  }
  return out
}
