/**
 * "All of it, together" matching for bylaws questions.
 *
 * Vector search ranks passages by the meaning of the whole question, but a
 * question like "FAR for a 2000 sq m plot" has two parts that must BOTH hold
 * for one passage: it is about FAR, and it applies to a 2000 sq m plot. The
 * embedding cannot check the second part: "2000" is just a token to it, and
 * the table row that actually applies says ">1200". So, on top of the vector
 * search, a passage must:
 *   - mention every regulation topic named in the question (FAR, setback,
 *     ground coverage, parking, height, staircase), in English or Hindi, and
 *   - when the question gives a plot area, cover that area: a table row such
 *     as "1000 - 2000", ">1200" or "up to 3000", or the number itself next to
 *     an area unit.
 * Passages that pass are ranked by how exactly they cover the number, then by
 * meaning. Questions that name no topic and no area are not constrained.
 */

export type TopicKey = 'far' | 'setback' | 'coverage' | 'parking' | 'height' | 'stair'

/** Every spelling a topic is written in, in the documents and in questions. */
const TOPICS: Record<TopicKey, { label: string; terms: string[] }> = {
  far: { label: 'FAR', terms: ['far', 'floor area ratio', 'f.a.r', 'एफ.ए.आर', 'एफ0ए0आर0', 'एफएआर', 'फ्लोर एरिया रेशियो'] },
  setback: { label: 'setback', terms: ['setback', 'setbacks', 'set-back', 'set back', 'सेटबैक', 'सैटबैक', 'सेट बैक', 'सेट-बैक'] },
  coverage: { label: 'ground coverage', terms: ['ground coverage', 'coverage', 'भू-आच्छादन', 'भू आच्छादन', 'आच्छादन'] },
  parking: { label: 'parking', terms: ['parking', 'ecs', 'पार्किंग'] },
  height: { label: 'height', terms: ['height', 'ऊँचाई', 'ऊंचाई'] },
  stair: { label: 'staircase', terms: ['stair', 'stairs', 'staircase', 'staircases', 'सीढ़ी', 'सीढी'] },
}

const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const fold = (s: string) => s.toLowerCase().normalize('NFC')
// A whole word or phrase: not inside a longer word, in any script.
const termRes = Object.fromEntries(
  (Object.keys(TOPICS) as TopicKey[]).map((k) => [
    k,
    TOPICS[k].terms.map((w) => new RegExp(`(^|[^\\p{L}\\p{M}])${escapeRe(w)}($|[^\\p{L}\\p{M}])`, 'u')),
  ]),
) as Record<TopicKey, RegExp[]>

export interface QueryConstraints {
  topics: TopicKey[]
  /** Plot area in square metres, when the question gives one. */
  area: number | null
}

const AREA_IN_QUERY = /(\d[\d,]*(?:\.\d+)?)\s*(?:sq\.?\s*m(?:t|tr|eters?|etres?)?\b|sqm\b|square\s*m(?:eters?|etres?)?\b|वर्ग\s*मीटर|वर्गमीटर)/u

export function analyzeQuery(query: string): QueryConstraints {
  const f = fold(query)
  const topics = (Object.keys(TOPICS) as TopicKey[]).filter((k) => termRes[k].some((re) => re.test(f)))
  const m = f.match(AREA_IN_QUERY)
  const area = m ? Number(m[1]!.replace(/,/g, '')) : null
  return { topics, area: area !== null && Number.isFinite(area) && area > 0 ? area : null }
}

export function isConstrained(c: QueryConstraints): boolean {
  return c.topics.length > 0 || c.area !== null
}

export function hasTopic(text: string, key: TopicKey): boolean {
  const f = fold(text)
  return termRes[key].some((re) => re.test(f))
}

export function describeConstraints(c: QueryConstraints): string {
  const parts = c.topics.map((k) => TOPICS[k].label)
  if (c.area !== null) parts.push(`a ${c.area.toLocaleString('en-IN')} sq m plot`)
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

const AREA_CONTEXT = /(sq\.?\s*m|sqm|sq\.?\s*mt|square\s*met|plot\s*(area|size)|वर्ग\s*मीटर|वर्गमीटर|भूखण्ड|भूखंड)/i
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`
const toNum = (x: string) => Number(x.replace(/,/g, ''))
// "2016-2020", "26-08-2019": years and dates are not area ranges.
const dateLike = (a: number, b: number) =>
  (a >= 1900 && a <= 2100 && b >= 1900 && b <= 2100) || (b >= 1900 && b <= 2100 && a <= 31) || (a <= 31 && b <= 12)

export interface AreaMatch {
  /** The range or figure that covers the area, as written ("> 1000 - 2000"). */
  row: string
  /** 3: a range or table row covering the area; 2: the area written next to a unit. */
  quality: 2 | 3
}

/** Does this passage give a rule that applies to a plot of `n` sq m? */
export function coversArea(text: string, n: number): AreaMatch | null {
  const t = text.replace(/[–—−]/g, '-').replace(/\s+/g, ' ')
  if (!AREA_CONTEXT.test(t)) return null
  let mm: RegExpExecArray | null

  const between = new RegExp(String.raw`(=?>=?|≥|>)?\s*${NUM}\s*(?:-|to)\s*${NUM}(?![\d-])`, 'gi')
  while ((mm = between.exec(t))) {
    const a = toNum(mm[2]!), b = toNum(mm[3]!)
    if (!(b > a) || dateLike(a, b) || b > n * 10) continue
    const exclusive = !!mm[1] && mm[1].includes('>') && !mm[1].includes('=')
    if ((exclusive ? n > a : n >= a) && n <= b) return { row: mm[0].trim(), quality: 3 }
  }

  // Open-ended rows (">1200", "more than 3000") cover n only when it is the
  // highest such threshold below n in the passage (the table's last row that
  // applies), and a plausible plot size rather than a height or a road width.
  const above = new RegExp(String.raw`(?:(=?>=?|≥|>)|more than|above|exceeding)\s*${NUM}(?!\s*(?:-|to)\s*\d)(?![\d.])`, 'gi')
  const thresholds: number[] = []
  while ((mm = above.exec(t))) thresholds.push(toNum(mm[2]!))
  const below = thresholds.filter((a) => a < n && a >= n / 5)
  if (below.length) {
    const top = Math.max(...below)
    if (!thresholds.some((a) => a > top && a <= n)) return { row: `>${top}`, quality: 3 }
  }

  const upto = new RegExp(String.raw`(?:up ?to|upto|<=|≤|less than|not exceeding)\s*${NUM}`, 'gi')
  while ((mm = upto.exec(t))) {
    const b = toNum(mm[1]!)
    if (n <= b && b <= n * 2) return { row: mm[0].trim(), quality: 3 }
  }

  if (new RegExp(String.raw`(^|[^\d.,])${n}\s*(sq|square|वर्ग)`, 'i').test(t)) return { row: `${n} sq m`, quality: 2 }
  return null
}

/** The text of the matching row, for display ("> 1200 Max. coverage ... 1.25 2.0"). */
export function rowSnippet(text: string, row: string, max = 110): string {
  const t = text.replace(/[–—−]/g, '-').replace(/\s+/g, ' ')
  let i: number
  const open = row.match(/^>(\d[\d,.]*)$/)
  if (open) {
    // The open-ended row itself (">1200 ..."), not the same number inside an
    // earlier row (">500 to1200").
    const m = new RegExp(String.raw`(?:=?>=?|≥|more than|above|exceeding)\s*${escapeRe(open[1]!)}(?![\d.])(?!\s*(?:-|to)\s*\d)`, 'i').exec(t)
    i = m ? m.index : -1
  } else {
    i = t.indexOf(row)
  }
  if (i < 0) return row
  // Back up to the comparison sign written before the number, if any.
  while (i > 0 && /[>=≥]/.test(t[i - 1]!)) i--
  const rest = t.slice(i, i + max)
  // Stop where the next table row starts (">300 - 1000 ...", "=>1000 ...",
  // "4. Above 12000 ...", "Up to 150 ..."), or where a new sentence or clause
  // ("Note:", "3.2.2.2 Residential") begins.
  const next = rest.slice(3).search(/\s(?:\d{1,2}\.\s+)?(?:=?>=?|≥|above|up ?to|upto|more than)\s*\d|\s(?:note|notes)\b|\s\d+\.\d+\.\d+(?:\.\d+)*\s/i)
  return (next >= 0 ? rest.slice(0, next + 3) : rest).trim()
}

export interface ConstrainedHit {
  quality: 0 | 2 | 3
  row?: string
}

/** Apply the constraints to one passage: null when it fails any of them. */
export function matchPassage(text: string, c: QueryConstraints): ConstrainedHit | null {
  if (!c.topics.every((k) => hasTopic(text, k))) return null
  if (c.area === null) return { quality: 0 }
  const m = coversArea(text, c.area)
  return m ? { quality: m.quality, row: rowSnippet(text, m.row) } : null
}
