/**
 * Is extracted text real language, or garbage from a broken PDF text layer?
 *
 * Some PDFs have a text layer that extracts as nonsense: a legacy Hindi typing
 * font (Kruti Dev style: the Hindi comes out as Latin gibberish), or glyphs
 * with no character map (":5!6.!-7;99=*1..#"). Indexing that wastes the index
 * and can never match a question. Measured on every passage of Trijya's
 * bylaws index (October 2026): normal documents have 0-14% unreadable
 * passages (tables, title pages), broken ones 40-100% (the two NBC "digital"
 * editions 95%, the compiled bye-laws book 87%).
 *
 * Kept identical to _readable() in scripts/nas-connector/connector.py, which
 * makes the same call page by page and OCRs the unreadable pages.
 */
const STOPWORDS = new Set(
  ('the of and to in a is for be shall with by on as or at from that this are which an not any such its it ' +
    'have has been may all other than per under into within where each above below').split(' '),
)

export function readableText(t: string): boolean {
  const nonsp = t.replace(/\s/g, '')
  if (nonsp.length < 20) return false // empty or near-empty: a scanned page
  const latin = (t.match(/[A-Za-z]/g) || []).length
  const deva = (t.match(/[ऀ-ॿ]/g) || []).length
  if (deva / Math.max(1, latin + deva) >= 0.2) return true // Unicode Hindi
  const words = t.toLowerCase().match(/[a-z]+/g) || []
  const stop = words.filter((w) => STOPWORDS.has(w)).length / Math.max(1, words.length)
  return (latin + deva) / nonsp.length >= 0.5 && stop >= 0.08
}

/** A document is treated as unreadable when at least this share of it is. */
export const UNREADABLE_DOC_SHARE = 0.3

/** Share of ~1,500-character windows of `text` that are not readable. */
export function unreadableShare(text: string, window = 1500): number {
  const parts: string[] = []
  for (let i = 0; i < text.length; i += window) parts.push(text.slice(i, i + window))
  if (parts.length === 0) return 1
  return parts.filter((p) => !readableText(p)).length / parts.length
}
