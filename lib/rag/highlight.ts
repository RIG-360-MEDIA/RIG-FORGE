/**
 * Finding quoted document text inside a passage or a page, for highlighting.
 * Pure and dependency-free, so client components can use it too.
 *
 * Text extracted from PDFs breaks and spaces lines unpredictably (a table row
 * is often split over two lines), so matching ignores how whitespace falls.
 */

/** Separator between the separate lines of a key-lines quote. */
export const QUOTE_GAP = ' … '

/** Blank-line runs from PDF extraction collapsed, so the text reads as text. */
export function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Where `phrase` is printed in `text`, with any whitespace between its words. */
export function findSpan(text: string, phrase: string | undefined): [number, number] | null {
  const parts = phrase?.trim().split(/\s+/).filter(Boolean)
  if (!parts?.length) return null
  const m = new RegExp(parts.map(escapeRe).join('\\s+'), 'iu').exec(text)
  return m ? [m.index, m.index + m[0].length] : null
}

/**
 * Every phrase found in `text`, as sorted non-overlapping [start, end) spans.
 * A key-lines quote is several phrases joined by QUOTE_GAP: pass them split.
 */
export function findSpans(text: string, phrases: string[]): Array<[number, number]> {
  const spans = phrases
    .map((p) => findSpan(text, p))
    .filter((s): s is [number, number] => s !== null)
    .sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = []
  for (const s of spans) {
    const last = out[out.length - 1]
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1])
    else out.push([s[0], s[1]])
  }
  return out
}

/** The phrases of a key-lines quote, without the ellipses that join them. */
export function quotePhrases(quote: string): string[] {
  return quote.split(QUOTE_GAP).map((p) => p.replace(/^…|…$/g, '').trim()).filter((p) => p.length > 0)
}

/** `text` cut into plain and marked pieces, for rendering. */
export function splitMarked(text: string, spans: Array<[number, number]>): Array<{ text: string; marked: boolean }> {
  const out: Array<{ text: string; marked: boolean }> = []
  let at = 0
  for (const [a, b] of spans) {
    if (a > at) out.push({ text: text.slice(at, a), marked: false })
    out.push({ text: text.slice(a, b), marked: true })
    at = b
  }
  if (at < text.length) out.push({ text: text.slice(at), marked: false })
  return out
}
