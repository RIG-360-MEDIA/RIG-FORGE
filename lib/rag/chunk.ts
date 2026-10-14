/**
 * Plain-text chunker for RAG ingestion. Splits on paragraph boundaries first
 * (keeps related sentences together) and only falls back to a hard character
 * split for single paragraphs longer than the target size (e.g. minified
 * spreadsheet CSV dumps). Adjacent chunks overlap so a fact split across a
 * chunk boundary is still findable from either side.
 */
const TARGET_CHARS = 1200
const OVERLAP_CHARS = 150

export interface TextChunk {
  index: number
  text: string
}

export function chunkText(text: string, targetChars = TARGET_CHARS, overlapChars = OVERLAP_CHARS): TextChunk[] {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (!clean) return []

  // Guard the hard-split step below. If overlap >= target the step is <= 0, the
  // loop never advances, and it allocates until the whole process runs out of
  // memory — a synchronous loop, so it would take the web server down for every
  // user. Clamp both so the step is always at least 1.
  targetChars = Math.max(1, Math.floor(targetChars))
  overlapChars = Math.min(Math.max(0, Math.floor(overlapChars)), targetChars - 1)

  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  const pieces: string[] = []
  for (const p of paragraphs) {
    if (p.length <= targetChars) {
      pieces.push(p)
      continue
    }
    for (let i = 0; i < p.length; i += targetChars - overlapChars) {
      pieces.push(p.slice(i, i + targetChars))
    }
  }

  const chunks: TextChunk[] = []
  let buf = ''
  for (const piece of pieces) {
    const candidate = buf ? `${buf}\n\n${piece}` : piece
    if (candidate.length > targetChars && buf) {
      chunks.push({ index: chunks.length, text: buf })
      const tail = buf.slice(Math.max(0, buf.length - overlapChars))
      buf = `${tail}\n\n${piece}`
    } else {
      buf = candidate
    }
  }
  if (buf.trim()) chunks.push({ index: chunks.length, text: buf.trim() })

  return chunks
}

/**
 * Chunks with fewer letters than this are not indexed. PDF table extraction
 * leaves chunks that are almost nothing but digits and punctuation (",2016",
 * "(Ss)", columns of unit conversions). Their embeddings sit close to the
 * centre of the vector space, so on multilingual-e5-large they score 0.81-0.82
 * against ANY query, even nonsense, which is above the min-score floor and
 * close to real hits (0.84-0.90). Nobody can usefully read them as a citation.
 *
 * 40 was picked from the 21,050 chunks of trijya_bylaws_e5 (14 Oct 2026):
 * every chunk under 40 letters was a number table, a page header or a
 * fragment, while the shortest real Devanagari passage had 82 letters. Letters
 * are counted in any script, including combining marks (Devanagari vowel
 * signs are \p{M}, not \p{L}), so Hindi text is not under-counted.
 */
export const MIN_CHUNK_LETTERS = Number(process.env.RAG_MIN_CHUNK_LETTERS ?? 40)

export function letterCount(text: string): number {
  return text.match(/[\p{L}\p{M}]/gu)?.length ?? 0
}

export function hasEnoughText(text: string, minLetters = MIN_CHUNK_LETTERS): boolean {
  return letterCount(text) >= minLetters
}

/**
 * Drops near-empty chunks and renumbers the rest from 0. Renumbering keeps
 * indexes contiguous, so pruneStaleChunks(…, kept.length) still removes every
 * point from an older version of the file, including old junk chunks.
 */
export function substantiveChunks(chunks: TextChunk[], minLetters = MIN_CHUNK_LETTERS): { kept: TextChunk[]; skipped: number } {
  const kept = chunks.filter((c) => hasEnoughText(c.text, minLetters)).map((c, index) => ({ index, text: c.text }))
  return { kept, skipped: chunks.length - kept.length }
}
