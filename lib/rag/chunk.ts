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
