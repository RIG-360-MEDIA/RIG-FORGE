/**
 * "All of it, together" matching for bylaws questions.
 *
 * Vector search ranks passages by the meaning of the whole question, but a
 * question like "setback for a 200 sq m residential plot" has parts that must
 * ALL hold for the answer: it is about setbacks, for a residential building,
 * on a plot of 200 sq m. The embedding cannot check that: "200" is just a
 * token to it, and the table row that applies says ">150 to 300". The bylaws
 * also print many tables of the same shape one after another (setbacks for
 * residential, commercial, healthcare, educational and industrial plots, all
 * keyed on plot area), so "the passage mentions setback and has a row for
 * 200 sq m" is not enough: the row has to come from the right table.
 *
 * So, on top of the vector search, the answer is a ROW, and for that row:
 *   - the question's value falls in it: plot area ("200 sq m", also sq ft and
 *     gaj, converted), building height ("20 m high") or road width ("18 m
 *     road"), read from a range such as "1000 - 2000", ">1200", "up to 3000",
 *     "1001 से 3000 तक" or "3000 से अधिक", in the column for that kind of value;
 *   - the table it sits in is about every topic in the question (FAR, setback,
 *     ground coverage, parking, height, staircase, basement, road width,
 *     ventilation): the topic is named in the table's own heading, not merely
 *     somewhere in the passage ("Max. coverage after ensuring setbacks" in a
 *     FAR table does not make it a setback table);
 *   - when the question names a use (residential, commercial, hospital,
 *     school, industrial, ...), the nearest use named above the row is that
 *     one.
 * A table often starts in one passage and continues in the next, so the
 * caller passes the passages before and after a hit: the heading may be in
 * an earlier one, the asked row in a later one.
 *
 * Questions with topics or a use but no value are matched per section: the
 * section must name every topic and the use. Questions with none of these are
 * not constrained.
 */

export type TopicKey = 'far' | 'setback' | 'coverage' | 'parking' | 'height' | 'stair' | 'basement' | 'road' | 'ventilation'
export type UseKey = 'residential' | 'group_housing' | 'commercial' | 'healthcare' | 'educational' | 'industrial' | 'hotel' | 'assembly' | 'fuel'
export type DimKey = 'area' | 'height' | 'road'

/** Every spelling a topic is written in, in the documents and in questions. */
const TOPICS: Record<TopicKey, { label: string; terms: string[] }> = {
  far: { label: 'FAR', terms: ['far', 'floor area ratio', 'f.a.r', 'fsi', 'floor space index', 'bfar', 'mfar', 'एफ.ए.आर', 'एफ.एआर', 'एफ0ए0आर0', 'एफ0ए0आए0', 'एफएआर', 'फ्लोर एरिया रेशियो'] },
  setback: { label: 'setback', terms: ['setback', 'setbacks', 'set-back', 'set-backs', 'set back', 'set backs', 'setbac', 'setbak', 'set bak', 'सेटबैक', 'सेटबैक्स', 'सैटबैक', 'सेट बैक', 'सैट बैक', 'सेट-बैक', 'सैट-बैक', 'सेटबेक', 'सैटबेक', 'सेट बेक', 'सैट बेक'] },
  coverage: { label: 'ground coverage', terms: ['ground coverage', 'coverage', 'ground cover', 'भू-आच्छादन', 'भू आच्छादन', 'आच्छादन'] },
  parking: { label: 'parking', terms: ['parking', 'ecs', 'e.c.s', 'car space', 'car spaces', 'पार्किंग', 'पाकिंग', 'ई0सी0एस0'] },
  height: { label: 'height', terms: ['height', 'heights', 'storey', 'storeys', 'stories', 'floors', 'ऊँचाई', 'ऊंचाई', 'मंजिल'] },
  stair: { label: 'staircase', terms: ['stair', 'stairs', 'staircase', 'staircases', 'stairway', 'सीढ़ी', 'सीढी', 'जीना'] },
  basement: { label: 'basement', terms: ['basement', 'basements', 'बेसमेंट', 'तलघर'] },
  road: { label: 'road width', terms: ['road width', 'width of road', 'width of the road', 'approach road', 'means of access', 'road', 'roads', 'मार्ग', 'सड़क'] },
  ventilation: { label: 'ventilation', terms: ['ventilation', 'ventilation shaft', 'shaft', 'संवातन'] },
}

/** Uses (occupancies). `q`: words that name it in a question; `doc`: words
 * that name it in a table heading or row label. Both are whole words. */
const USES: Record<UseKey, { label: string; q: string[]; doc: string[] }> = {
  residential: {
    label: 'residential',
    q: ['residential', 'house', 'houses', 'bungalow', 'villa', 'dwelling', 'flat', 'flats', 'apartment', 'apartments', 'plotted', 'row house', 'row housing', 'semi-detached', 'detached', 'आवासीय', 'मकान', 'घर'],
    doc: ['residential', 'plotted', 'row-housing', 'row housing', 'semi-detached', 'detached', 'single unit', 'single-unit', 'multi-unit', 'multi-units', 'multi units', 'single/multi-units', 'dwelling', 'dwellings', 'आवासीय'],
  },
  group_housing: {
    label: 'group housing',
    q: ['group housing', 'ग्रुप हाउसिंग'],
    doc: ['group housing', 'g. housing', 'ग्रुप हाउसिंग', 'गुप हाउसिंग'],
  },
  commercial: {
    label: 'commercial',
    q: ['commercial', 'shop', 'shops', 'shopping', 'mall', 'malls', 'showroom', 'office', 'offices', 'mixed use', 'व्यवसायिक', 'व्यावसायिक', 'दुकान', 'कार्यालय'],
    doc: ['commercial', 'comm', 'shop', 'shops', 'shopping', 'mall', 'malls', 'office', 'offices', 'office buildings', 'mixed use', 'व्यवसायिक', 'व्यावसायिक', 'ग्यवसायिक', 'यवसायिक', 'कार्यालय', 'दुकान', 'दुकानें'],
  },
  healthcare: {
    label: 'healthcare',
    q: ['hospital', 'hospitals', 'healthcare', 'health care', 'nursing home', 'clinic', 'clinics', 'dispensary', 'medical', 'अस्पताल', 'चिकित्सा'],
    doc: ['healthcare', 'health care', 'hospital', 'hospitals', 'nursing', 'medical', 'dispensary', 'clinic', 'clinics', 'चिकित्सा', 'अस्पताल'],
  },
  educational: {
    label: 'educational',
    q: ['school', 'schools', 'college', 'colleges', 'educational', 'education', 'university', 'universities', 'institute', 'स्कूल', 'विद्यालय', 'शिक्षण', 'शैक्षिक'],
    doc: ['educational', 'education', 'school', 'schools', 'college', 'colleges', 'university', 'universities', 'शिक्षण', 'शैक्षिक', 'विद्यालय', 'स्कूल'],
  },
  industrial: {
    label: 'industrial',
    q: ['industrial', 'industry', 'industries', 'factory', 'factories', 'msme', 'warehouse', 'औद्योगिक', 'उद्योग', 'फैक्ट्री'],
    doc: ['industrial', 'industry', 'industries', 'factory', 'factories', 'msme', 'data centers', 'data centres', 'औद्योगिक', 'उद्योग'],
  },
  hotel: { label: 'hotel', q: ['hotel', 'hotels', 'guest house', 'होटल'], doc: ['hotel', 'hotels', 'guest house', 'होटल'] },
  assembly: {
    label: 'assembly / hall',
    q: ['marriage hall', 'banquet', 'auditorium', 'convention', 'cinema', 'multiplex', 'miniplex', 'सिनेमा'],
    doc: ['marriage hall', 'banquet', 'multipurpose hall', 'auditorium', 'convention', 'cinema', 'multiplex', 'miniplex', 'सभा भवन', 'मल्टीप्लेक्स', 'सिनेमा'],
  },
  fuel: {
    label: 'petrol pump',
    q: ['petrol pump', 'petrol', 'filling station', 'fuel station', 'cng', 'lpg', 'gas godown', 'पेट्रोल'],
    doc: ['petrol', 'filling station', 'lpg', 'gas godown', 'पेट्रोल', 'फिलिंग स्टेशन'],
  },
}
/** A table that applies to every use ("All occupancy buildings with height more than 15 meters"). */
const ANY_USE = /all\s+occupanc(?:y|ies)|all\s+(?:types\s+of\s+)?buildings|all\s+uses|सभी\s+प्रकार\s+के\s+भवन/i

const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const fold = (s: string) => s.toLowerCase().normalize('NFC')
/** Same text (case kept: headings are found by their capitals), dashes and minus as "-", whitespace as one space. */
const flat = (s: string) => s.normalize('NFC').replace(/[–—−]/g, '-').replace(/\s+/g, ' ')
// A whole word or phrase: not inside a longer word, in any script.
const wordRe = (w: string, flags = 'iu') => new RegExp(`(?<![\\p{L}\\p{M}])${escapeRe(w)}(?![\\p{L}\\p{M}])`, flags)
const anyWordRe = (ws: string[], flags = 'giu') =>
  new RegExp(`(?<![\\p{L}\\p{M}])(?:${[...ws].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![\\p{L}\\p{M}])`, flags)

const TOPIC_KEYS = Object.keys(TOPICS) as TopicKey[]
const USE_KEYS = Object.keys(USES) as UseKey[]
const topicRes = Object.fromEntries(TOPIC_KEYS.map((k) => [k, TOPICS[k].terms.map((w) => wordRe(w))])) as Record<TopicKey, RegExp[]>
const topicAnyRe = Object.fromEntries(TOPIC_KEYS.map((k) => [k, anyWordRe(TOPICS[k].terms)])) as Record<TopicKey, RegExp>
const useQRes = Object.fromEntries(USE_KEYS.map((k) => [k, anyWordRe(USES[k].q, 'iu')])) as Record<UseKey, RegExp>
const useDocRes = Object.fromEntries(USE_KEYS.map((k) => [k, anyWordRe(USES[k].doc)])) as Record<UseKey, RegExp>

// ---------------------------------------------------------------------------
// The question
// ---------------------------------------------------------------------------

export interface QueryConstraints {
  topics: TopicKey[]
  uses: UseKey[]
  /** Plot area in square metres, when the question gives one (converted from sq ft / sq yd / acres). */
  area: number | null
  /** The area as asked, when it was not in square metres ("2,000 sq ft"). */
  areaAsAsked: string | null
  /** Building height in metres ("a 20 m high building"). */
  height: number | null
  /** Road width in metres ("on an 18 m road"). */
  road: number | null
  /** The words the question used for its use ("shopping mall", "hospital"). */
  useWords: string[]
  /** The question's other content words, to choose between lines that both fit. */
  words: string[]
}

const NUMQ = String.raw`(\d[\d,]*(?:\.\d+)?)`
const AREA_UNITS: Array<{ re: string; factor: number; unit: string }> = [
  { re: String.raw`sq\.?\s*f(?:ee)?t\.?|sqft|square\s*f(?:ee|oo)t|ft2|ft²|वर्ग\s*फ(?:ी|ु)ट`, factor: 0.09290304, unit: 'sq ft' },
  { re: String.raw`sq\.?\s*y(?:ar)?ds?\.?|square\s*yards?|gaj|gaz|गज`, factor: 0.83612736, unit: 'sq yd' },
  { re: String.raw`sq\.?\s*m(?:t|tr|eters?|etres?)?\.?|sqm|square\s*m(?:eters?|etres?)?|m2|m²|वर्ग\s*मीटर|वर्गमीटर|वर्ग\s*मी\.?`, factor: 1, unit: 'sq m' },
  { re: String.raw`acres?|एकड़`, factor: 4046.8564, unit: 'acre' },
  { re: String.raw`hectares?|हेक्टेयर`, factor: 10000, unit: 'hectare' },
]
const LEN = String.raw`(?:m|mt|mtr|mtrs|meters?|metres?|मीटर)`
const HEIGHT_IN_QUERY = [
  new RegExp(String.raw`${NUMQ}\s*-?\s*${LEN}\.?\s*(?:high|tall|height|in height|ऊँचा|ऊंचा|ऊँचे|ऊंचे|ऊँचाई|ऊंचाई)(?![\p{L}\p{M}])`, 'u'),
  new RegExp(String.raw`(?:height|ऊँचाई|ऊंचाई)\s*(?:of|is|=|:|upto|up to|की)?\s*(?:about\s*)?${NUMQ}\s*-?\s*${LEN}?(?![\p{L}\p{M}\d])`, 'u'),
]
const ROAD_IN_QUERY = [
  new RegExp(String.raw`${NUMQ}\s*-?\s*(${LEN}|ft|feet|फीट)?\.?\s*(?:wide\s*)?(?:road|street|marg|मार्ग|सड़क|रोड)`, 'u'),
  new RegExp(String.raw`(?:road|street)\s*(?:width|wide)?\s*(?:of|is|=|:)?\s*${NUMQ}\s*-?\s*(${LEN}|ft|feet)(?![\p{L}\p{M}])`, 'u'),
]

const QUESTION_WORDS = new Set(['what', 'which', 'when', 'where', 'shall', 'should', 'must', 'have', 'does', 'that', 'this', 'with', 'from', 'than', 'many', 'much', 'required', 'requirement', 'allowed', 'permissible', 'needed', 'rules', 'rule', 'find', 'show', 'tell', 'about', 'bylaws', 'bylaw', 'byelaws', 'लिए', 'होगा', 'होगी', 'कितना', 'कितनी', 'क्या'])

export function analyzeQuery(query: string): QueryConstraints {
  let f = fold(query)
  let area: number | null = null, areaAsAsked: string | null = null
  for (const u of AREA_UNITS) {
    const m = new RegExp(`${NUMQ}\\s*(?:${u.re})(?![\\p{L}\\p{M}])`, 'u').exec(f)
    if (!m) continue
    const v = Number(m[1]!.replace(/,/g, ''))
    if (Number.isFinite(v) && v > 0) {
      area = Math.round(v * u.factor * 100) / 100
      if (u.factor !== 1) areaAsAsked = `${v.toLocaleString('en-IN')} ${u.unit}`
      f = f.slice(0, m.index) + ' '.repeat(m[0].length) + f.slice(m.index + m[0].length)
      break
    }
  }
  let road: number | null = null
  for (const re of ROAD_IN_QUERY) {
    const m = re.exec(f)
    if (!m) continue
    const v = Number(m[1]!.replace(/,/g, '')) * (/ft|feet|फीट/.test(m[2] ?? '') ? 0.3048 : 1)
    if (Number.isFinite(v) && v > 0 && v < 200) {
      road = Math.round(v * 10) / 10
      f = f.slice(0, m.index) + ' '.repeat(m[0].length) + f.slice(m.index + m[0].length)
      break
    }
  }
  let height: number | null = null
  for (const re of HEIGHT_IN_QUERY) {
    const m = re.exec(f)
    if (!m) continue
    const v = Number(m[1]!.replace(/,/g, ''))
    if (Number.isFinite(v) && v > 0 && v < 1000) {
      height = v
      f = f.slice(0, m.index) + ' '.repeat(m[0].length) + f.slice(m.index + m[0].length)
      break
    }
  }
  let topics = TOPIC_KEYS.filter((k) => topicRes[k].some((re) => re.test(f)))
  // The word that introduced a value is not a topic of its own: "a building
  // of height 40 m" asks about the 40 m row, not about height rules.
  if (height !== null) topics = topics.filter((k) => k !== 'height')
  if (road !== null) topics = topics.filter((k) => k !== 'road')
  let uses = USE_KEYS.filter((k) => useQRes[k].test(f))
  // "group housing" is a residential use, named more precisely.
  if (uses.includes('group_housing')) uses = uses.filter((k) => k !== 'residential')
  // "petrol pump" also as "petrol" and "pump": a table may say "Petrol filling station".
  const useWords = [...new Set(uses
    .flatMap((k) => [...f.matchAll(anyWordRe(USES[k].q))].map((m) => m[0]))
    .flatMap((w) => [w, ...w.split(/\s+/).filter((x) => x.length >= 4 && x !== w)]))]
  const words = [...new Set(fold(query).match(/[\p{L}\p{M}]{4,}/gu) ?? [])].filter((w) => !QUESTION_WORDS.has(w))
  // A Hindi question is also answered by the English bylaws, which name the
  // use in English: its main English word counts as the question's own too.
  if (/\p{Script=Devanagari}/u.test(query)) {
    for (const k of uses) {
      const en = USES[k].q[0]!
      for (const w of [en, ...en.split(/\s+/).filter((x) => x.length >= 4 && x !== en)]) if (!useWords.includes(w)) useWords.push(w)
    }
  }
  return { topics, uses, area, areaAsAsked, height, road, useWords, words }
}

export function isConstrained(c: QueryConstraints): boolean {
  return c.topics.length > 0 || c.uses.length > 0 || c.area !== null || c.height !== null || c.road !== null
}

function hasDims(c: QueryConstraints): boolean {
  return c.area !== null || c.height !== null || c.road !== null
}

const listJoin = (parts: string[]) =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`

/** "an 800 sq m plot", "an 18 m road", "a 200 sq m plot": as the number is read aloud. */
const article = (n: number) => {
  const d = String(Math.round(n))
  return /^8/.test(d) || /^(?:11|18)$/.test(d) || /^(?:11|18)\d{3}$/.test(d) ? 'an' : 'a'
}

/** "setback (residential) for a 200 sq m plot", "FAR (commercial) for an 18 m road". */
export function describeConstraints(c: QueryConstraints): string {
  const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 1 })
  const dims: string[] = []
  if (c.area !== null) dims.push(c.areaAsAsked ? `${article(Number(c.areaAsAsked.replace(/[^\d.]/g, '')))} ${c.areaAsAsked} (${fmt(c.area)} sq m) plot` : `${article(c.area)} ${fmt(c.area)} sq m plot`)
  if (c.height !== null) dims.push(`${article(c.height)} ${fmt(c.height)} m high building`)
  if (c.road !== null) dims.push(`${article(c.road)} ${fmt(c.road)} m road`)
  const topics = listJoin(c.topics.map((k) => TOPICS[k].label))
  const uses = listJoin(c.uses.map((k) => USES[k].label))
  let s = topics
  if (uses) s = s ? `${s} (${uses})` : uses
  if (dims.length) s = s ? `${s} for ${dims.join(' on ')}` : dims.join(' on ')
  return s
}

// ---------------------------------------------------------------------------
// The passage: sections, value tokens, column labels
// ---------------------------------------------------------------------------

/** A numbered clause ("3.2.4.1 Residential ...") or a Hindi lettered one
 * ("(स)- शिक्षण संस्थायें"), where a new table or rule starts. A clause number
 * written as a reference ("as per paragraph 3.2.4.9") is not a heading. */
const HEADING = /(?<![\d.\p{L}])(?:\d{1,2}\.\d{1,2}\.\d{1,2}(?:\.\d{1,2})*\.?\s+(?=[A-Z\p{Script=Devanagari}(])|\((?:अ|ब|स|द|य|र|ल|व|क|ख|ग|घ)\)\s*-?\s*(?=\p{Script=Devanagari}))/gu
/** A two-level clause ("7.21 Ropeway Terminal Buildings", "5.3 OPEN SPACES"):
 * only before two capitalised words, since "1.5 Unrestricted" and "2.0 Note:"
 * are table values, not headings. */
// "2.0", "6.50", "0.60" are values (a clause number does not end in 0), and
// the title's first word has at least three letters ("6.50 Ao एवं" is OCR).
const HEADING2 = /(?<![\d.\p{L}])[1-9]\d?\.\d?[1-9]\.?\s+(?=(?:[A-Z][\p{L}'’/-]{2,}|[A-Z]{3,})[\s:,]+[A-Z(\p{Script=Devanagari}])/gu
const NOT_A_TITLE = /^\s*(?:unrestricted|note|notes|no|nil|yes|max|min|not|na|n\.a|plain|plains|hills?|built|non)\b/i
const REFERENCE_BEFORE = /(?:paragraph|para\.?|paras|clause|section|sections|chapter|table|refer|per|of|in|see|under|and|to|with|from|by)\s*$/i

interface Section { start: number; label: string }

function findSections(t: string): Section[] {
  const out: Section[] = []
  for (const re of [HEADING, HEADING2]) {
    for (const m of t.matchAll(re)) {
      if (REFERENCE_BEFORE.test(t.slice(Math.max(0, m.index! - 14), m.index!))) continue
      if (re === HEADING2) {
        if (NOT_A_TITLE.test(t.slice(m.index! + m[0].length, m.index! + m[0].length + 14))) continue
        if (/\d\s*$/.test(t.slice(Math.max(0, m.index! - 3), m.index!))) continue // "5.25 1.5 Unrestricted": a value after a value
      }
      out.push({ start: m.index!, label: sectionLabel(t.slice(m.index!, m.index! + 160)) })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

function sectionLabel(s: string): string {
  const cut = s.slice(6).search(/\s(?:plot area|plot size|sl\.|s\. ?no|use types?|use occupancies|building height \(|under |the |for |in |all |parameter|proposed|min\.|minimum|\(i\)|\(1\)|भूखण्ड का|भू-खण्ड का|भूखंड का)/i)
  const t = (cut >= 0 ? s.slice(0, cut + 6) : s.slice(0, 90)).trim()
  return t.replace(/\s+[-–]?\s*$/, '')
}

/** The kind of value a column holds, named in a table heading. */
const DIM_MARKERS: Array<{ dim: DimKey; re: RegExp }> = [
  { dim: 'area', re: /plot\s*(?:area|size)|area of (?:the )?(?:plot|dwelling)|dwelling unit \(sq|carpet area|plot size in sqm|size of (?:the )?plot|भू-?\s?खण्ड\s*का\s*क्षेत्रफल|भूखंड\s*का\s*क्षेत्रफल|क्षेत्रफल\s*\(?वर्ग/giu },
  { dim: 'height', re: /building height|height of (?:the )?building|height\s*\((?:in\s*)?m|भवन की ऊँचाई|भवन की ऊंचाई/giu },
  { dim: 'road', re: /road width|width of (?:the )?road|road\s*\(m\)|मार्ग\s*की\s*चौड़ाई|मार्ग\s*चौड़ाई/giu },
]

/** Phrases that mention a topic without the table being about it. */
const NOT_ABOUT = [
  /(?:after|by|while|on)\s+(?:ensuring|leaving|providing|maintaining|leaving out)\s+(?:the\s+)?(?:minimum\s+)?(?:required\s+)?(?:mandatory\s+)?set-?\s?backs?/giu,
]

type Kind = 'between' | 'above' | 'upto' | 'exact'
interface Token {
  s: number; e: number; text: string
  lo: number; hi: number; loInc: boolean; hiInc: boolean
  kind: Kind
  unit: 'area' | 'len' | null
}

const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`
const HI_AREA = String.raw`(?:\s*(?:वर्ग\s*मीटर|वर्गमीटर|वर्गगीटर|वर्ग\s*मी\.?))?`
const toNum = (x: string) => Number(x.replace(/,/g, ''))
// "2016-2020", "26-08-2019": years and dates are not ranges.
const dateLike = (a: number, b: number) =>
  (a >= 1900 && a <= 2100 && b >= 1900 && b <= 2100) || (b >= 1900 && b <= 2100 && a <= 31)

const TOKEN_RES: Array<{ kind: Kind; re: RegExp; read: (m: RegExpExecArray) => Omit<Token, 's' | 'e' | 'text' | 'kind' | 'unit'> | null }> = [
  // Hindi: "1001 से 3000 तक", "1001 वर्गमीटर से 3000 वर्गमीटर तक"
  { kind: 'between', re: new RegExp(String.raw`${NUM}${HI_AREA}\s*से\s*${NUM}${HI_AREA}\s*तक`, 'gu'),
    read: (m) => ({ lo: toNum(m[1]!), hi: toNum(m[2]!), loInc: true, hiInc: true }) },
  // Hindi: "35000 से अधिक"
  { kind: 'above', re: new RegExp(String.raw`${NUM}${HI_AREA}\s*से\s*(?:अधिक|ज्यादा|ऊपर)`, 'gu'),
    read: (m) => ({ lo: toNum(m[1]!), hi: Infinity, loInc: false, hiInc: false }) },
  // ">300 - 1000", "=>100 – 300", ">500 to1200", "1000 -2000"
  { kind: 'between', re: new RegExp(String.raw`(=?>=?|≥|>)?\s*${NUM}\s*(?:-|to|upto)\s*${NUM}(?![\d-]|\.\d)`, 'giu'),
    read: (m) => {
      const lo = toNum(m[2]!), hi = toNum(m[3]!)
      // "0-1000": tables write "up to 1000"; a range from zero is an OCR fragment.
      if (!(hi > lo) || lo === 0 || dateLike(lo, hi)) return null
      return { lo, hi, loInc: !(m[1] && m[1].includes('>') && !m[1].includes('=')), hiInc: true }
    } },
  // Hindi: "1000 तक", "100 वर्गमीटर तक" (not the second half of "से ... तक")
  { kind: 'upto', re: new RegExp(String.raw`(?<!से\s{0,3})(?<!से)${NUM}${HI_AREA}\s*तक`, 'gu'),
    read: (m) => ({ lo: 0, hi: toNum(m[1]!), loInc: true, hiInc: true }) },
  // ">1200", "more than 3000", "above 300 square meters"
  { kind: 'above', re: new RegExp(String.raw`(?:(=?>=?|≥|>)|(?<![\p{L}])(?:more than|above|exceeding|over)(?![\p{L}]))\s*${NUM}(?!\s*(?:-|to)\s*\d)(?!\d|\.\d)`, 'giu'),
    read: (m) => ({ lo: toNum(m[2]!), hi: Infinity, loInc: !!m[1] && (m[1].includes('=') || m[1] === '≥'), hiInc: false }) },
  // "up to 150", "less than 300", "<= 50"
  { kind: 'upto', re: new RegExp(String.raw`((?<![\p{L}])(?:up ?to|upto|less than|below|not exceeding|not more than)(?![\p{L}])|<\s*=|=<|≤|<)\s*${NUM}`, 'giu'),
    read: (m) => ({ lo: 0, hi: toNum(m[2]!), loInc: true, hiInc: !/less than|below|^<$/.test(m[1]!) }) },
  // "200 sq m" written as a figure in prose
  { kind: 'exact', re: new RegExp(String.raw`(?<![\d.,])${NUM}\s*(?:sq|square|वर्ग)`, 'giu'),
    read: (m) => ({ lo: toNum(m[1]!), hi: toNum(m[1]!), loInc: true, hiInc: true }) },
]

const AREA_SUFFIX = /^\s*(?:sq\b|sq\.|sqm|square|वर्ग|\(sq)/iu
const LEN_SUFFIX = /^\s*-?\s*(?:m\b|m\)|mt\b|mtr|meters?|metres?|मीटर)(?!\s*(?:sq|square))/iu

function findTokens(t: string): Token[] {
  const taken: Array<[number, number]> = []
  const out: Token[] = []
  for (const { kind, re, read } of TOKEN_RES) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(t))) {
      const s = m.index + (m[0].length - m[0].trimStart().length), e = m.index + m[0].length
      if (taken.some(([a, b]) => s < b && e > a)) continue
      // "Road Width (>12 -24m)", "(Up to 50 beds)": a column or row label.
      if (/\(\s*$/.test(t.slice(Math.max(0, s - 3), s)) && /^\s*(?:m|mt|meters?|sqm|sq\.?\s*m\.?|beds)?\s*\)/i.test(t.slice(e, e + 12))) continue
      const r = read(m)
      if (!r || !Number.isFinite(r.lo)) continue
      const after = t.slice(e, e + 16)
      // "up to 50 percent": a share, not a plot area, height or road width.
      if (/^\s*(?:%|percent|per cent|प्रतिशत)/iu.test(after)) continue
      const unit = AREA_SUFFIX.test(after) || /वर्ग/.test(m[0]) ? 'area' : LEN_SUFFIX.test(after) ? 'len' : null
      if (kind === 'exact' && unit !== 'area') continue
      taken.push([s, e])
      out.push({ s, e, text: t.slice(s, e).trim(), kind, unit, ...r })
    }
  }
  return out.sort((a, b) => a.s - b.s)
}

const covers = (k: Token, v: number) =>
  (k.loInc ? v >= k.lo : v > k.lo) && (k.hiInc ? v <= k.hi : v < k.hi)

/** Which kind of value a token is: from its own unit, else the nearest column heading above it. */
function tokenDim(t: string, k: Token, from: number): DimKey | null {
  const after = t.slice(k.e, k.e + 24)
  if (k.unit === 'area') return 'area'
  if (k.unit === 'len') {
    if (/^[\s-]*(?:m|mt|mtr|meters?|metres?|मीटर)\s*(?:wide\s*)?(?:road|street|width)/iu.test(after)) return 'road'
    if (/^[\s-]*(?:m|mt|mtr|meters?|metres?|मीटर)\.?\s*(?:height|high|tall|ऊँचाई|ऊंचाई)/iu.test(after)) return 'height'
  }
  let best: { dim: DimKey; at: number } | null = null
  const head = t.slice(from, k.s)
  for (const { dim, re } of DIM_MARKERS) {
    re.lastIndex = 0
    for (const m of head.matchAll(re)) if (!best || m.index! > best.at) best = { dim, at: m.index! }
  }
  if (best) return k.unit === 'len' && best.dim === 'area' ? null : best.dim
  return k.unit === 'len' ? null : /sq\.?\s*m|sqm|square\s*met|वर्ग\s*मीटर|वर्गमीटर/i.test(head.slice(-400)) ? 'area' : null
}

/** Topic mentions in t[from, to), with the phrases that only mention a topic
 * in passing left out, and value-column headings ("Building Height (m)")
 * too unless `withColumns`: when a value is matched, that heading names the
 * value's column, not what the table rules on. */
function topicMentions(t: string, from: number, to: number, withColumns = false): Array<{ key: TopicKey; at: number }> {
  let span = t.slice(from, to)
  for (const re of NOT_ABOUT) span = span.replace(re, (x) => ' '.repeat(x.length))
  if (!withColumns) for (const { re } of DIM_MARKERS) span = span.replace(re, (x) => ' '.repeat(x.length))
  const out: Array<{ key: TopicKey; at: number }> = []
  for (const k of TOPIC_KEYS) {
    const re = topicAnyRe[k]
    re.lastIndex = 0
    for (const m of span.matchAll(re)) out.push({ key: k, at: from + m.index! })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** A sentence end (". The", "। "), not an abbreviation ("Max. FAR", "sq.m. Base"). */
function sentenceStarts(t: string, from: number, to: number): number[] {
  const out: number[] = []
  const re = /[.।]\s+(?=[A-Z\p{Script=Devanagari}(])/gu
  re.lastIndex = from
  let m: RegExpExecArray | null
  while ((m = re.exec(t)) && m.index < to) {
    if (t[m.index] === '.') {
      const word = /([\p{L}.]+)$/u.exec(t.slice(Math.max(0, m.index - 8), m.index))?.[1] ?? ''
      if (word.length <= 1 || /^(?:max|min|no|nos|sl|sq|fig|para|viz|etc|mr|dr|st|i\.e|e\.g|m|mt|approx|nbc|vol)$/i.test(word) || /\./.test(word)) continue
      // A full stop right after a figure ("is 1.75. 46 Calculation") is often a
      // decimal point or a page number in OCR'd text: not trusted as a sentence end.
      if (/\d$/.test(t.slice(0, m.index))) continue
    }
    out.push(m.index + m[0].length)
  }
  return out
}

/** The topics the table (or sentence) a value sits in is about: those named
 * in the last sentence before it that names any topic. */
function topicsAbove(t: string, sectionStart: number, pos: number): Set<TopicKey> {
  const ms = topicMentions(t, sectionStart, pos)
  if (!ms.length) return new Set()
  const last = ms[ms.length - 1]!.at
  const starts = sentenceStarts(t, sectionStart, last)
  const from = starts.length ? starts[starts.length - 1]! : sectionStart
  return new Set(ms.filter((m) => m.at >= from).map((m) => m.key))
}

/** How far into a clause its heading runs, for uses it names together
 * ("(स)-शिक्षण संस्थायें /चिकित्सा /सामुदायिक सुविधाएं": schools AND healthcare). */
const HEADING_SPAN = 120

interface UseFound { nearest: UseKey | 'any' | null; heading: Set<UseKey> }

/** The use the nearest row label or heading above `pos` names, and every use
 * the clause heading names. */
function useAbove(t: string, sectionStart: number, pos: number): UseFound {
  const heading = new Set<UseKey>()
  if (ANY_USE.test(t.slice(sectionStart, Math.min(pos, sectionStart + 160)))) return { nearest: 'any', heading }
  const span = t.slice(sectionStart, pos)
  let best: { key: UseKey; at: number } | null = null
  for (const k of USE_KEYS) {
    const re = useDocRes[k]
    re.lastIndex = 0
    for (const m of span.matchAll(re)) {
      if (/non[-\s]?$/i.test(span.slice(Math.max(0, m.index! - 4), m.index!))) continue // "non-residential"
      if (m.index! < HEADING_SPAN) heading.add(k)
      if (!best || m.index! >= best.at) best = { key: k, at: m.index! }
    }
  }
  return { nearest: best?.key ?? null, heading }
}

function useScore(c: QueryConstraints, { nearest, heading }: UseFound): number {
  if (!c.uses.length) return 1
  if (nearest === 'any') return 2
  if (nearest === null) return 1
  const fits = (u: UseKey, x: UseKey) => u === x || (u === 'residential' && x === 'group_housing')
  if (c.uses.some((u) => fits(u, nearest))) return 2
  // The nearest use is one of several the heading names together, and the asked one is among them.
  if (heading.has(nearest) && c.uses.some((u) => [...heading].some((h) => fits(u, h)))) return 2
  return 0
}

// Column labels of common tables, so a row can be read out ("Front 3 m, ...").
const COLUMN_SETS: Array<{ re: RegExp; labels: string[]; unit?: string; topic: TopicKey }> = [
  { re: /front\s*(?:\(m\))?\s*rear\s*(?:\(m\))?\s*side[-\s]?1\s*(?:\(m\))?\s*side[-\s]?2/giu, labels: ['Front', 'Rear', 'Side-1', 'Side-2'], unit: 'm', topic: 'setback' },
  { re: /base\s*far\s*max\.?\s*(?:permissible\s*)?far/giu, labels: ['Base FAR', 'Max. FAR'], topic: 'far' },
  { re: /size of ventilation shaft\s*\(square met(?:er|re)\)\s*minimum width of shaft/giu, labels: ['Shaft area (sq m)', 'Min. width (m)'], topic: 'ventilation' },
]

/** The row's values against the table's column labels, when those columns
 * are what the question asked about (FAR labels are not shown for a ground
 * coverage question, though the same table holds both). */
function readValues(t: string, sectionStart: number, k: Token, row: string, asked: TopicKey[]): string | undefined {
  const after = row.slice(k.text.length)
  const vals = after.match(/(?<![\p{L}\d.])(?:\d+(?:\.\d+)?%?|-)(?![\p{L}\d])/gu) ?? []
  if (!vals.length) return undefined
  let cols: (typeof COLUMN_SETS)[number] | null = null, at = -1
  const head = t.slice(Math.max(sectionStart, k.s - 1500), k.s)
  for (const cs of COLUMN_SETS) {
    cs.re.lastIndex = 0
    for (const m of head.matchAll(cs.re)) if (m.index! > at) { at = m.index!; cols = cs }
  }
  if (!cols || vals.length < cols.labels.length) return undefined
  if (asked.length && !asked.includes(cols.topic)) return undefined
  return cols.labels.map((l, i) => {
    const v = vals[i]!
    return v === '-' ? `${l} none` : `${l} ${v}${cols!.unit ? ` ${cols!.unit}` : ''}`
  }).join(', ')
}

/** The text of a row: from its value to where the next row or sentence starts. */
function rowText(t: string, k: Token, next: number | undefined, max = 110, limit = t.length): string {
  let i = k.s
  while (i > 0 && /[>=≥]/.test(t[i - 1]!)) i--
  let end = Math.min(limit, i + max, next ?? Infinity)
  const rest = t.slice(i, end)
  const stop = rest.slice(k.e - i).search(/\s(?:[Nn]otes?|NOTES?|टिप्पणी)(?![\p{L}])|\s\d+\.\d+\.\d+(?:\.\d+)*\s|\s\(?[a-z]\)\s|\s\d{1,2}(?:\([a-z]\))?\s+(?!Notes?\b)[A-Z][a-z]/u)
  if (stop >= 0) end = Math.min(end, k.e + stop)
  return t.slice(i, end).trim()
}

const isTabular = (row: string, k: Token) => {
  const after = row.slice(k.text.length)
  const words = after.match(/\p{L}{2,}/gu) ?? []
  // "100 -300 sqm, the permissible FAR is 1.75." is a sentence, not a row.
  if (/,\s*\p{L}|(?<![\p{L}])(?:is|are|shall|will|should|may|be|means)(?![\p{L}])/iu.test(after)) return false
  return /\d/.test(after) && words.length <= 6
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface AreaMatch {
  /** The range or figure that covers the value, as written ("> 1000 - 2000"). */
  row: string
  /** 3: a range or table row covering the value; 2: the value written next to a unit. */
  quality: 2 | 3
}

/** Does this passage give a rule that applies to a plot of `n` sq m? (One section, no topic check.) */
export function coversArea(text: string, n: number): AreaMatch | null {
  const t = flat(text)
  const toks = findTokens(t)
  const k = pickCovering(t, toks, 0, t.length, 'area', n)
  return k ? { row: k.text, quality: k.kind === 'exact' ? 2 : 3 } : null
}

/** The token in t[from, to) of kind `dim` that covers v. Table rows before
 * figures in prose; then a closed range ("300 - 500"), the narrowest first;
 * then whichever of an open row (">1200", only when it is the last threshold
 * below v) or an "up to" row is closest to v. Tokens before `from` count only
 * as thresholds. When a table has rows for several uses ("3(a) Shops ...",
 * "4 Commercial Complex ..."), a row whose label, just above it, is in the
 * question's own words (`labelWords`) comes first. */
function pickCovering(t: string, toks: Token[], from: number, to: number, dim: DimKey, v: number, sectionStart = from, labelWords: string[] = []): Token | null {
  const inDim = toks.filter((k) => k.s >= sectionStart && k.s < to && tokenDim(t, k, sectionStart) === dim)
  const own = inDim.filter((k) => k.e > from)
  const thresholds = inDim.filter((k) => k.kind === 'above').map((k) => k.lo)
  const tab = (k: Token) => (k.kind !== 'exact' && isTabular(rowText(t, k, toks.find((x) => x.s >= k.e)?.s), k) ? 0 : 1)
  // An open threshold covers v only as the table's last row below it; in
  // prose ("buildings above 250 sq m ...") only when it is near v.
  const cands = own.filter((k) => covers(k, v) && (k.kind !== 'above' ||
    (!thresholds.some((a) => a > k.lo && a < v) && (tab(k) === 0 || k.lo >= v / 5))))
  if (!cands.length) return null
  const closedness = (k: Token) => (k.kind === 'between' || k.kind === 'exact' ? 0 : 1)
  const slack = (k: Token) => (k.kind === 'above' ? v - k.lo : k.kind === 'upto' ? k.hi - v : k.hi - k.lo)
  const labelRe = labelWords.length
    ? new RegExp(`(?<![\p{L}\p{M}])(?:${labelWords.map(escapeRe).join('|')})(?:s|es)?(?![\p{L}\p{M}])`, 'iu')
    : null
  const labelled = (k: Token) => (labelRe && labelRe.test(t.slice(Math.max(sectionStart, k.s - 200), k.s)) ? 0 : 1)
  return cands.sort((a, b) => tab(a) - tab(b) || labelled(a) - labelled(b) || closedness(a) - closedness(b) || slack(a) - slack(b) || a.s - b.s)[0]!
}

export interface ConstrainedHit {
  /** 3: a table row covering the value; 2: a figure in prose, or a line stating the value for the asked use; 1: a section naming the topics and use; 0: unconstrained. */
  quality: 0 | 1 | 2 | 3
  /** 2: the use named in the question is the one the row is under; 1: no use asked, or none named. */
  useScore: number
  /** The row that answers, as printed. */
  row?: string
  /** The clause the row is in ("3.2.4.1 Residential – Plotted Development ..."). */
  section?: string
  /** The row read out against its column labels ("Front 3 m, Rear 1.5 m, ..."). */
  values?: string
  /** No use was asked and the row is under a residential heading (most plot questions are). */
  residentialDefault?: boolean
  /** The row itself names the asked topic ("≥40 to 150 Max. coverage after ensuring setbacks ..."). */
  rowNamesTopic?: boolean
  /** Which passage holds the row: 0 this one, -1 the one before (where the
   * table started), 1 the one after (where it continues). */
  shift?: number
  /** Between matches that are otherwise equal, lower is better: how loosely
   * the row's range fits the value (">100 - 150" fits 120 better than a
   * garbled "0-1000"), or, with no value asked, fewer of the question's
   * words in the line. */
  tieBreak?: number
}

/**
 * Apply the constraints to one passage. `before` is the passage(s) just
 * before it in the same document, oldest first; `after` the one just after.
 * A table that starts in an earlier passage has its heading there, and one
 * that runs on has more rows in the next: rows of the tables this passage is
 * part of count wherever they are (`shift` says where). Returns the best
 * row, or null when no row (or, without a value in the question, no section)
 * meets every part.
 */
export function matchPassage(text: string, c: QueryConstraints, before: string | string[] = '', after = ''): ConstrainedHit | null {
  if (!isConstrained(c)) return { quality: 0, useScore: 1 }
  const prev = (Array.isArray(before) ? before : [before]).filter(Boolean)
  const parts = [...prev, text, ...(after ? [after] : [])].map(flat)
  const hitIndex = prev.length
  const partStart: number[] = []
  let t = ''
  for (const p of parts) { partStart.push(t.length); t += `${p} ` }
  const offset = partStart[hitIndex]!
  const hitEnd = partStart[hitIndex + 1] ?? t.length
  const partIndex = (pos: number) => {
    let i = 0
    while (i + 1 < partStart.length && partStart[i + 1]! <= pos) i++
    return i
  }
  const shiftOf = (pos: number) => partIndex(pos) - hitIndex
  /** Where the passage holding `pos` starts and ends in t. */
  const partFrom = (pos: number) => partStart[partIndex(pos)]!
  const partEnd = (pos: number) => partStart[partIndex(pos) + 1] ?? t.length
  const sections = findSections(t)
  const sectionAt = (pos: number) => {
    let s: Section | null = null
    for (const x of sections) { if (x.start <= pos) s = x; else break }
    return s
  }
  const startOf = (pos: number) => sectionAt(pos)?.start ?? 0
  const endOf = (ss: number) => sections.find((x) => x.start > ss)?.start ?? t.length
  // The sections this passage is part of: the one it starts in (which may
  // have begun earlier) and those that begin in it. Each may run on into
  // the next passage.
  const starts = [...new Set([startOf(offset), ...sections.filter((x) => x.start >= offset && x.start < hitEnd).map((x) => x.start)])]
  const better = (a: ConstrainedHit, b: ConstrainedHit | null) =>
    !b || rank(a) > rank(b) || (rank(a) === rank(b) && Math.abs(a.shift ?? 0) < Math.abs(b.shift ?? 0))

  if (hasDims(c)) {
    const toks = findTokens(t)
    const dims: Array<[DimKey, number]> = []
    if (c.area !== null) dims.push(['area', c.area])
    if (c.road !== null) dims.push(['road', c.road])
    if (c.height !== null) dims.push(['height', c.height])
    const [dim, v] = dims[0]!
    let best: ConstrainedHit | null = null
    for (const ss of starts) {
      const end = endOf(ss)
      if (end <= offset) continue
      const k = pickCovering(t, toks, ss, end, dim, v, ss, c.useWords)
      if (!k) continue
      // Every other value in the question must be covered in the same section.
      if (dims.slice(1).some(([d, w]) => !pickCovering(t, toks, ss, end, d, w, ss))) continue
      const topics = topicsAbove(t, ss, k.s)
      if (!c.topics.every((x) => topics.has(x))) continue
      const use = useAbove(t, ss, k.s)
      const us = useScore(c, use)
      if (us === 0) continue
      const row = rowText(t, k, toks.find((x) => x.s >= k.e)?.s, 110, partEnd(k.s))
      const hit: ConstrainedHit = {
        quality: k.kind === 'exact' || !isTabular(row, k) || garbled(row) ? 2 : 3,
        useScore: us,
        row,
        section: sectionAt(k.s)?.label,
        values: readValues(t, ss, k, row, c.topics),
        rowNamesTopic: c.topics.length > 0 && c.topics.every((x) => topicRes[x].some((re) => re.test(row))),
        residentialDefault: !c.uses.length && (use.nearest === 'residential' || use.nearest === 'group_housing'),
        shift: shiftOf(k.s),
        tieBreak: (k.kind === 'above' ? v - k.lo : k.kind === 'upto' ? k.hi : k.hi - k.lo) / v,
      }
      if (better(hit, best)) best = hit
    }
    return best
  }

  // No value in the question: a section must name every topic and the use;
  // the line shown is the sentence (or table line) that names the use,
  // preferring one in the question's own words that states the value.
  let best: ConstrainedHit | null = null
  for (const ss of starts) {
    const end = endOf(ss)
    if (end <= offset) continue
    // Here a column heading such as "Max. Building Height (m)" IS the topic.
    const ms = topicMentions(t, ss, end, true)
    if (!c.topics.every((k) => ms.some((m) => m.key === k))) continue
    let row: string | undefined, us = 1, quality: 1 | 2 = 1, shift = 0
    if (c.uses.length) {
      const from = Math.max(ss, offset - 300)
      const find = (re: RegExp) => [...t.slice(from, end).matchAll(re)]
        .map((m) => from + m.index!)
        .filter((at) => !/non[-\s]?$/i.test(t.slice(Math.max(0, at - 4), at)))
      // The question's own words first ("shopping mall" before "commercial"), plurals included.
      const own = c.useWords.length ? find(new RegExp(`(?<![\\p{L}\\p{M}])(?:${c.useWords.map(escapeRe).join('|')})(?:s|es)?(?![\\p{L}\\p{M}])`, 'giu')) : []
      const anchors = own.length ? own : c.uses.flatMap((u) => find(new RegExp(useDocRes[u].source, 'giu')))
      if (!anchors.length && !ANY_USE.test(t.slice(ss, ss + 160))) continue
      us = 2
      if (anchors.length) {
        const lines = anchors.map((at) => ({ at, l: lineAround(t, at, Math.max(ss, partFrom(at)), Math.min(end, partEnd(at))) }))
        const hasTopics = (l: string) => c.topics.every((k) => topicRes[k].some((re) => re.test(l)))
        const answers = (l: string) => valueAfter(l, c.useWords) || (hasTopics(l) && QUANTITY.test(l))
        // The line using most of the question's own words ("Shopping mall" over "Convenient Shopping"),
        // then one that states the value, then one naming the topic, then the most question words.
        const score = ({ l }: { l: string }) => {
          const f = fold(l)
          return c.useWords.filter((w) => f.includes(w)).length * 8 + (answers(l) ? 4 : 0) + (hasTopics(l) ? 2 : 0) +
            c.words.filter((w) => f.includes(w)).length * 0.1
        }
        const pick = lines.reduce((a, b) => (score(b) > score(a) ? b : a))
        row = pick.l
        shift = shiftOf(pick.at)
        // A line in the question's own words that states the value is an answer, not just a mention.
        if (own.length && answers(pick.l) && !garbled(pick.l)) quality = 2
      }
    }
    // A line naming the asked topic first, then the one using more of the question's words.
    const said = row
      ? (c.topics.length && c.topics.every((k) => topicRes[k].some((re) => re.test(row!))) ? 10 : 0) +
        c.words.filter((w) => fold(row!).includes(w)).length
      : 0
    const hit: ConstrainedHit = { quality, useScore: us, row, section: sectionAt(Math.max(ss, offset))?.label, shift, tieBreak: -said }
    if (better(hit, best)) best = hit
  }
  return best
}

/** OCR noise in a row ("65 170 | - | 70 | _160 | 3- |", "ई0सी0एस0 अनुवर्ती wares"):
 * table rules and stray Latin fragments inside Hindi. Such a row may still be
 * the right table, but its figures cannot be read, so a clean row comes first. */
function garbled(row: string): boolean {
  return /[|[\]{}_©®]/.test(row) || (/\p{Script=Devanagari}/u.test(row) && /(?<![\p{L}])[a-z]{3,}(?![\p{L}])/u.test(row))
}

/** A stated quantity: "1.5 ECS per 125 sqm", "3 / 100 sqm", "12 m", "40%" (not "Fig. 10"). */
const QUANTITY = /\d+(?:\.\d+)?\s*-?\s*(?:%|\/|per\b|ecs\b|sq\.?\s*m|sqm|square\s*met|m\b|mt\b|meters?\b|metres?\b|मीटर|प्रतिशत)|no restriction|unrestricted|not (?:permitted|allowed|required)|अनुमन्य नहीं/iu

/** A table line's value right after the name it is for: "Shopping mall 3 / 100 sqm",
 * "Petrol filling station w/o Service Station 3 - - -", "Group Housing No Restriction".
 * Not a figure, table or page number ("Fig. 10"). */
function valueAfter(line: string, words: string[]): boolean {
  const l = fold(line)
  for (const w of words) {
    const i = l.indexOf(w)
    if (i < 0) continue
    const after = l.slice(i + w.length, i + w.length + 45)
    if (/^[^\d]{0,40}?(?<!fig\.?\s?|table\s|page\s|para\s|no\.\s?|chapter\s)\d+(?:\.\d+)?\s*(?:[-–]\s*[-–\d]|\/|per\b|%|ecs|sq|m\b|\d)/u.test(after)) return true
    if (/^[^\d]{0,30}?(?:no restriction|unrestricted|not permitted|not allowed)/.test(after)) return true
  }
  return false
}

/** The sentence or list item holding position `at`; in a table, where
 * there are no sentences, the table line ("3 Shopping mall 3 / 100 sqm of
 * floor area"). */
function lineAround(t: string, at: number, ss: number, end: number): string {
  const starts = [ss, ...sentenceStarts(t, ss, end)]
  for (const m of t.slice(ss, end).matchAll(/\s\((?:[ivx]{1,4}|[a-h]|\d{1,2})\)\s/g)) starts.push(ss + m.index! + 1)
  starts.sort((a, b) => a - b)
  let from = ss, to = end
  for (const s of starts) { if (s <= at) from = s; else { to = s; break } }
  const numbered = (t.slice(from, to).match(/\s\d{1,2}(?:\([a-z]\))?\s+[A-Z]/g) ?? []).length
  if (to - from <= 400 && numbered < 2) return t.slice(from, to).trim()
  // A long run without sentence ends: a table. From the line's number to the next line's.
  let begin = at
  const num = /(?<![\d.]\s?)\s\d{1,2}(?:\([a-z]\))?\s+$/.exec(t.slice(Math.max(from, at - 10), at))
  if (num) begin = Math.max(from, at - 10) + num.index! + 1
  const rest = t.slice(at + 3, Math.min(to, at + 170))
  const stop = rest.search(/\s\d{1,2}(?:\([a-z]\))?\s+[A-Z]|\s\d+\.\d+\.\d+|\s\(\d\)\s/u)
  return t.slice(begin, stop >= 0 ? at + 3 + stop : Math.min(to, at + 170)).trim()
}

/**
 * Which kind of document a passage is from, for ordering matches that are
 * otherwise equal: the state bylaws and government orders that apply (and
 * any document not recognised below) first, then the National Building Code,
 * then the TCPO Model Building Bye-Laws (a model, not in force), then design
 * reference books (Time-Saver Standards, Neufert), which are not rules.
 */
export function documentPriority(fileName: string): number {
  if (/time-?saver|neufert|standards for building types/i.test(fileName)) return 0
  if (/mbbl|model building bye/i.test(fileName)) return 1
  if (/booklet|guide/i.test(fileName)) return 1
  if (/nbc|national building code/i.test(fileName)) return 2
  return 3
}

/** Order of preference between two matches of the same question. */
export function rank(h: ConstrainedHit): number {
  return h.useScore * 100 + h.quality * 10 + (h.rowNamesTopic ? 2 : 0) + (h.residentialDefault ? 1 : 0)
}

/** Cheap check before fetching context: could this passage be part of an
 * answer? (A topic, a use or a covering value appears in it.) */
export function mightMatch(text: string, c: QueryConstraints): boolean {
  if (!isConstrained(c)) return true
  const t = flat(text)
  if (c.topics.some((k) => topicRes[k].some((re) => re.test(t)))) return true
  if (c.uses.some((u) => { const re = useDocRes[u]; re.lastIndex = 0; return re.test(t) })) return true
  const vals = [c.area, c.height, c.road].filter((x): x is number => x !== null)
  return vals.length > 0 && findTokens(t).some((k) => vals.some((v) => covers(k, v)))
}
