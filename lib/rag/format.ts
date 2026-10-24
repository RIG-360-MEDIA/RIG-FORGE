/**
 * Readable layout for text extracted from bylaws PDFs, for display only (the
 * index and the search keep the text as extracted).
 *
 * PyMuPDF writes a table one cell per line, wraps prose at the PDF's line
 * width, breaks sentences at blank lines ("... 1200 sqmt" / "in plains.")
 * and puts a clause number on its own line above its text. This rebuilds
 * clauses, paragraphs and tables from that, line by line. Pure and
 * dependency-free, so client components use it.
 */

export type PassageBlock =
  /** A paragraph; `clause` is its number ("1.4", "1.6.1") when it has one. */
  | { kind: 'text'; text: string; clause?: string }
  | { kind: 'table'; header: string[]; rows: TableRow[] }

/** A table row: cells, or a group label spanning the table ("Plains", "Hills"). */
export type TableRow = { cells: string[] } | { group: string }

/** Table cells are short; longer lines are prose. */
const CELL_CHARS = 48

/**
 * A cell holding a value: "33.3%", "1.25", "6.0* mt", "1200-1500", ">1200",
 * "Above 1500", "Up to 300", "Nil". Not a label such as "Side-1".
 */
function isValue(cell: string): boolean {
  return /^[<>≤≥~±]?\s*\d/.test(cell) ||
    /^(?:above|below|over|under|up\s*to|upto|less than|more than|exceeding|beyond)\s*[<>]?\s*\d/i.test(cell) ||
    /^(?:nil|n\.?a\.?|-|—|–)$/i.test(cell)
}

/** A clause number alone on its line: "1.4", "3.2.2.1", "1.". */
const CLAUSE_ALONE = /^(\d{1,2}(?:\.\d{1,2}){0,4})\.?$/
/** A clause number starting a line of text: "1.6.1 Minimum 10% ...", "1. Origin ...". */
const CLAUSE_LEAD = /^(\d{1,2}(?:\.\d{1,2}){0,4})\.?\s+(?=[A-Z(\p{Script=Devanagari}])/u

/**
 * Whether `cur` can follow clause `prev`: its first child (1.6 → 1.6.1), or
 * the next number at its level or a level above (1.4 → 1.5, 1.6.2 → 1.7).
 * Values look like clause numbers ("1.25", "4.5 mt"); real clauses come in
 * sequence, which is how they are told apart.
 */
function follows(prev: string | null, cur: string): boolean {
  if (!prev) return true
  const p = prev.split('.').map(Number)
  const c = cur.split('.').map(Number)
  const same = (n: number) => c.slice(0, n).every((x, i) => x === p[i])
  if (c.length === p.length + 1 && same(p.length) && c[c.length - 1] === 1) return true
  return c.length <= p.length && same(c.length - 1) && c[c.length - 1] === p[c.length - 1]! + 1
}

/**
 * The cells of a run as a table: column headings (the labels before the
 * first value), then rows. Null when the cells do not fall into rows of one
 * width.
 */
function asTable(cells: string[]): { header: string[]; rows: TableRow[] } | null {
  let h = 0
  while (h < cells.length && !isValue(cells[h]!)) h++
  if (h === cells.length) return null
  // The labels before the first value are the column headings, except that
  // the last one may be the first row's label ("Plain", "Plains"): try both.
  for (const k of [h - 1, h]) {
    if (k < 2) continue
    const table = rowsUnder(cells.slice(0, k), cells.slice(k))
    if (table) return table
  }
  return null
}

function rowsUnder(header: string[], rest: string[]): { header: string[]; rows: TableRow[] } | null {
  const k = header.length
  // The rest as runs: an optional label, then its values.
  const runs: Array<{ label: string | null; values: string[] }> = []
  for (const cell of rest) {
    const last = runs[runs.length - 1]
    if (!isValue(cell)) runs.push({ label: cell, values: [] })
    else if (last) last.values.push(cell)
    else runs.push({ label: null, values: [cell] })
  }
  // A label over several rows ("Plains" above two plot sizes) is a group:
  // then every label in this table is one, even over a single row.
  const grouped = runs.some((r) => r.label !== null && r.values.length >= 2 * k && r.values.length % k === 0)

  const rows: TableRow[] = []
  let labelled = false
  for (const run of runs) {
    const n = run.values.length
    if (run.label !== null && !grouped && (n === k || n === k - 1)) {
      // "Plain 33.3% 1.25" under "Max. Ground Coverage, Max FAR": the label
      // is the row heading; when n === k the header needs a blank first column.
      rows.push({ cells: [run.label, ...run.values] })
      if (n === k) labelled = true
    } else if (n > 0 && n % k === 0) {
      if (run.label !== null) rows.push({ group: run.label })
      for (let i = 0; i < n; i += k) rows.push({ cells: run.values.slice(i, i + k) })
    } else if (run.label !== null && n === 0) {
      rows.push({ group: run.label })
    } else {
      return null
    }
  }
  if (!rows.some((r) => 'cells' in r)) return null
  return { header: labelled ? ['', ...header] : header, rows }
}

interface Line {
  text: string
  clause?: string
  /** A blank line came before it. */
  gap: boolean
}

/** Lines with each lone clause number moved onto the line it numbers. */
function clauseLines(raw: string): Line[] {
  const all = raw.replace(/\r/g, '').split('\n').map((x) => x.trim())
  const out: Line[] = []
  let gap = false
  let last: string | null = null
  for (let i = 0; i < all.length; i++) {
    const l = all[i]!
    if (!l) { gap = true; continue }
    // "1.4" alone, numbering the next line of text (not a value in a table:
    // "1.25" above "Hills" does not follow clause 1.4).
    const alone = CLAUSE_ALONE.exec(l)
    const next = all.slice(i + 1).find((x) => x.length > 0) ?? ''
    if (alone && follows(last, alone[1]!) && next && !isValue(next) && /^[A-Z(\p{Script=Devanagari}]/u.test(next)) {
      let j = i + 1
      while (!all[j]) j++
      out.push({ text: all[j]!, clause: alone[1]!, gap })
      last = alone[1]!
      i = j
      gap = false
      continue
    }
    const lead = CLAUSE_LEAD.exec(l)
    if (lead && follows(last, lead[1]!)) {
      out.push({ text: l.slice(lead[0].length), clause: lead[1]!, gap })
      last = lead[1]!
    } else {
      out.push({ text: l, gap })
    }
    gap = false
  }
  return out
}

/** Short, unnumbered lines that may be table cells. */
const isCell = (l: Line) => !l.clause && l.text.length <= CELL_CHARS

export function formatPassage(raw: string): PassageBlock[] {
  const lines = clauseLines(raw)
  const out: PassageBlock[] = []
  let para: Line[] = []

  const flushPara = () => {
    if (!para.length) return
    const first = para[0]!
    const text = para.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim()
    out.push({ kind: 'text', text, ...(first.clause ? { clause: first.clause } : {}) })
    para = []
  }

  for (let i = 0; i < lines.length;) {
    // A run of short unnumbered lines with values in it: try it as a table.
    if (isCell(lines[i]!)) {
      let j = i
      while (j < lines.length && isCell(lines[j]!)) j++
      const run = lines.slice(i, j)
      const values = run.filter((l) => isValue(l.text)).length
      const table = run.length >= 4 && values >= 2 ? asTable(run.map((l) => l.text)) : null
      if (table) {
        flushPara()
        out.push({ kind: 'table', ...table })
        i = j
        continue
      }
    }
    const line = lines[i]!
    // A new paragraph at a clause number, after a sentence ends, or after a
    // blank line unless the sentence runs on ("1200 sqmt" / "in plains.").
    const prev = para[para.length - 1]
    const ended = !prev || /[.:;!?]$/.test(prev.text)
    const runsOn = prev && !ended && /^[a-z(]/.test(line.text)
    if (line.clause || (para.length && ended) || (line.gap && !runsOn)) flushPara()
    para.push(line)
    i++
  }
  flushPara()

  // A passage starting mid-sentence ("n Terminal Points.") is marked as cut.
  const first = out[0]
  if (first?.kind === 'text' && !first.clause && /^[a-z]/.test(first.text)) first.text = `…${first.text}`
  return out
}
