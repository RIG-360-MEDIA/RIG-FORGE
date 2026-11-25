/**
 * The year of a bylaws document, so answers come from the latest bylaws: a
 * 2022 G.O. over the bylaw it amends, the 2025 bylaws over the 2008 ones.
 *
 * The index stores no dates, so the year is read, in order, from:
 * 1. the file name ("UP Building Bylaws 2025.pdf", "G-O-07-01-2022.pdf",
 *    "Draftbuildingrules8092017.pdf", a "20250416..." download timestamp);
 * 2. the innermost folder with a year ("Master Plan D.Dun 2025/");
 * 3. the document's first passage (its title page): the latest year printed
 *    there, e.g. "उपविधि 2011 (संशोधित 2023)" is 2023, "as amended up to".
 * Only years from 1950 to this year count: a "Master Plan 2041" is a horizon,
 * not a date. Null when none is found: such a document is never assumed to
 * be the latest.
 */

const MIN_YEAR = 1950

const plausible = (y: number) => y >= MIN_YEAR && y <= new Date().getFullYear()

/** Devanagari digits (२०२३) as ASCII (2023). */
function asciiDigits(s: string): string {
  return s.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966))
}

/** Years written in a name: alone (2025), at the end of a date run
 * ("8092017", "732023" for SP 73:2023), or a leading yyyymmdd timestamp. */
function yearsInName(name: string): number[] {
  const n = asciiDigits(name)
  const out: number[] = []
  for (const m of n.matchAll(/(?<!\d)(?:\d{2,4})?((?:19|20)\d{2})(?!\d)/g)) out.push(Number(m[1]))
  const stamp = /(?<!\d)((?:19|20)\d{2})(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{4,}/.exec(n)
  if (stamp) out.push(Number(stamp[1]))
  return out.filter(plausible)
}

/** The latest year in a file or folder name, or null. */
export function yearInName(name: string): number | null {
  const ys = yearsInName(name)
  return ys.length ? Math.max(...ys) : null
}

/** How much of the first passage is read: the title page, not the body
 * (which cites old Acts and older orders). */
const HEAD_CHARS = 1500

/** The latest year printed on a document's title page, or null. */
export function yearInText(text: string): number | null {
  const t = asciiDigits(text.slice(0, HEAD_CHARS))
  // Not a measurement: "2000 sq m", "1950 मीटर", "2000 वर्गमीटर", "2000%".
  const year = /(?<![\d.,])((?:19|20)\d{2})(?![\d.,]\d)(?!\s*(?:sq|square|sqm|sqmt|m\b|mt|mtr|meter|metre|mm|cm|ha\b|hectare|acre|%|वर्ग|मी|हे|एकड़))/giu
  const ys = [...t.matchAll(year)].map((m) => Number(m[1])).filter(plausible)
  return ys.length ? Math.max(...ys) : null
}

/** The year of the document at `path`; `head` is its first passage, when known. */
export function documentYear(path: string, head?: string): number | null {
  const parts = path.split('/').filter(Boolean)
  const fromName = yearInName(parts[parts.length - 1] ?? '')
  if (fromName) return fromName
  for (let i = parts.length - 2; i >= 0; i--) {
    const fromFolder = yearInName(parts[i]!)
    if (fromFolder) return fromFolder
  }
  return head ? yearInText(head) : null
}
