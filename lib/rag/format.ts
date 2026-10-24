/**
 * Readable layout for text extracted from bylaws PDFs, for display only (the
 * index and the search keep the text as extracted).
 *
 * PyMuPDF writes a table one cell per line, separates blocks with blank lines
 * that also fall inside sentences ("... 1200 sqmt" / "in plains."), and puts
 * a clause number on its own line above its title. This rebuilds paragraphs
 * and tables from that. Pure and dependency-free, so client components use it.
 */

export type PassageBlock =
  | { kind: 'text'; text: string }
  | { kind: 'table'; header: string[]; rows: TableRow[] }

/** A table row: cells, or a group label spanning the table ("Plains", "Hills"). */
export type TableRow = { cells: string[] } | { group: string }

/** Table cells are short; longer lines are prose. */
const CELL_CHARS = 48

/** "33.3%", "1.25", "6.0* mt", "1200-1500", ">1200", "Nil". Not "Side-1". */
function isValue(cell: string): boolean {
  return /^[<>≤≥~±]?\s*\d/.test(cell) || /^(?:nil|n\.?a\.?|-|—|–)$/i.test(cell)
}

/** A clause number alone on its line: "1.4", "3.2.2.1", "(ii)". */
const CLAUSE_NO = /^(?:\d{1,2}(?:\.\d{1,2}){0,4}\.?|\((?:[ivx]+|[a-z])\))$/i

/**
 * The cells of a block as a table: column headings (the labels before the
 * first value), then rows. A label followed by exactly one row of values is
 * a row heading; followed by several rows' worth, it is a group label above
 * them. Null when the cells do not fall into rows of one width.
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
  // A label over several rows ("Plains" above three plot sizes) is a group:
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

/** Lines that are all short and include values look like table cells. */
function looksTabular(lines: string[]): boolean {
  return lines.length >= 4 && lines.every((l) => l.length <= CELL_CHARS) && lines.filter(isValue).length >= 2
}

export function formatPassage(raw: string): PassageBlock[] {
  const blocks = raw
    .replace(/\r/g, '')
    .split(/\n[ \t]*\n+/)
    .map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean))
    .filter((b) => b.length > 0)

  // Rejoin what the blank lines split: a clause number with its title, and a
  // sentence that runs on into a block starting in lower case ("in plains.").
  const merged: string[][] = []
  for (const block of blocks) {
    const prev = merged[merged.length - 1]
    const prevLast = prev?.[prev.length - 1] ?? ''
    if (prev && prev.length === 1 && CLAUSE_NO.test(prevLast)) {
      merged[merged.length - 1] = [`${prevLast} ${block[0]}`, ...block.slice(1)]
    } else if (prev && /^[a-z(]/.test(block[0]!) && !/[.:;!?]$/.test(prevLast) && !looksTabular(prev)) {
      prev[prev.length - 1] = `${prevLast} ${block[0]}`
      prev.push(...block.slice(1))
    } else {
      merged.push([...block])
    }
  }

  // Consecutive tabular blocks are one table: headings and each group are
  // often separated by blank lines.
  const out: PassageBlock[] = []
  let cells: string[] = []
  const flush = () => {
    if (!cells.length) return
    const table = asTable(cells)
    out.push(table ? { kind: 'table', ...table } : { kind: 'text', text: cells.join('\n') })
    cells = []
  }
  for (const block of merged) {
    const short = block.every((l) => l.length <= CELL_CHARS)
    const continues = cells.length > 0 && (block.some(isValue) || block.length === 1)
    if (short && (looksTabular(block) || continues)) {
      cells.push(...block)
      continue
    }
    // Short label lines just before a table are its headings.
    if (short && block.length >= 2 && !block.some(isValue)) {
      flush()
      cells.push(...block)
      continue
    }
    flush()
    out.push({ kind: 'text', text: block.join('\n') })
  }
  flush()
  return out
}
