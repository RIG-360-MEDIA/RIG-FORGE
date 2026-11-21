import type { NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'
import { generateText } from 'ai'

import { prisma } from '@/lib/db'
import { getTokenFromCookies, verifyToken, type TokenPayload } from '@/lib/auth'
import { errorResponse } from '@/lib/api-helpers'
import { canUsePayments } from '@/lib/payments'
import { TX_OPTIONS } from '@/lib/task-categories'
import { isAssistantEnabled, reportRateLimit, selectNextModel } from '@/lib/llm/provider'
import {
  DEFAULT_SANCTION_NOTES, DEFAULT_TERMS, DISCIPLINES, EMPTY_FIRM, SCOPE_LIBRARY,
  buildRefNo, financialYear,
  type Discipline, type FirmDetails, type ProposalContent, type ProposalSettingsData, type ProposalStage,
  type ProposalStatus, type ProposalTerms, type ProposalView,
} from '@/lib/proposal-types'
import { STANDARD_SQFT_SCHEDULE } from '@/lib/payment-types'

// ─── Access ──────────────────────────────────────────────────────────────────

/** Proposals carry fees and bank details: the same people as payments (admins, not external). */
export async function proposalsGuard(request: NextRequest, projectId?: string):
  Promise<{ payload: TokenPayload; project: { id: string; name: string } | null } | { response: Response }> {
  const token = getTokenFromCookies(request)
  if (!token) return { response: errorResponse('Authentication required', 401) }
  const payload = verifyToken(token)
  if (!payload) return { response: errorResponse('Invalid or expired token', 401) }
  if (!canUsePayments(payload)) return { response: errorResponse('Proposals are only for admins', 403) }
  if (!projectId) return { payload, project: null }
  const project = await prisma.project.findFirst({ where: { id: projectId, isActive: true }, select: { id: true, name: true } })
  if (!project) return { response: errorResponse('Project not found', 404) }
  return { payload, project }
}

// ─── Validation helpers ──────────────────────────────────────────────────────

const str = (v: unknown, max: number): string | null => {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') return null
  const t = v.replace(/\r\n/g, '\n').trim()
  return t.length > max ? null : t
}
const strList = (v: unknown, maxItems: number, maxLen: number): string[] | null => {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > maxItems) return null
  const out: string[] = []
  for (const x of v) {
    const t = str(x, maxLen)
    if (t === null) return null
    if (t) out.push(t)
  }
  return out
}
/** A non-negative rupee amount with at most 2 decimals, up to `max`; null when invalid; undefined/'' -> fallback. */
const money = (v: unknown, max: number, fallback: number | null): number | null | 'bad' => {
  if (v === undefined || v === null || v === '') return fallback
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[,\s₹]/g, '')) : NaN
  if (!Number.isFinite(n) || n < 0 || n > max || Math.round(n * 100) !== n * 100 && Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return 'bad'
  return Math.round(n * 100) / 100
}
const intIn = (v: unknown, min: number, max: number, fallback: number | null): number | null | 'bad' => {
  if (v === undefined || v === null || v === '') return fallback
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isInteger(n) && n >= min && n <= max ? n : 'bad'
}

/** No proposal may ever ask for "speed money" or similar (an old offer letter did). */
const FORBIDDEN = /speed\s*money|bribe|facilitation\s*payment|under[-\s]?the[-\s]?table/i
const clean = (list: string[]) => list.filter((x) => !FORBIDDEN.test(x))

/** Two lines that say the same thing ("Back-of-house (BOH) design" / "BOH (back-of-house) design and drawings"). */
const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !['and', 'the', 'are', 'excluded', 'services'].includes(w)))
export function sameLine(a: string, b: string): boolean {
  const x = words(a), y = words(b)
  if (!x.size || !y.size) return false
  let common = 0
  for (const w of x) if (y.has(w)) common++
  return common / Math.min(x.size, y.size) >= 0.75
}
export function addLines(list: string[], extra: string[]): string[] {
  const out = [...list]
  for (const e of extra) if (!out.some((x) => sameLine(x, e))) out.push(e)
  return out
}

// ─── Firm details and terms ──────────────────────────────────────────────────

/** Saved settings merged over the defaults, so a new field always has a value. */
export function mergeSettings(raw: unknown): ProposalSettingsData {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ProposalSettingsData>
  const firm = { ...EMPTY_FIRM, ...(r.firm ?? {}) } as FirmDetails
  firm.bank = { ...EMPTY_FIRM.bank, ...(r.firm?.bank ?? {}) }
  return { firm, terms: { ...DEFAULT_TERMS, ...(r.terms ?? {}) } }
}

export async function loadSettings(): Promise<{ data: ProposalSettingsData; saved: boolean }> {
  const row = await prisma.proposalSettings.findFirst()
  return { data: mergeSettings(row?.data), saved: !!row }
}

/** Check settings sent by the Firm details form. Returns the clean value or an error message. */
export function parseSettings(body: unknown): ProposalSettingsData | string {
  const b = (body && typeof body === 'object' ? body : {}) as { firm?: Record<string, unknown>; terms?: Record<string, unknown> }
  const f = b.firm ?? {}
  const bank = (f.bank && typeof f.bank === 'object' ? f.bank : {}) as Record<string, unknown>
  const fields: [keyof FirmDetails, number][] = [
    ['name', 120], ['tagline', 200], ['address', 300], ['homeState', 60], ['email', 120], ['phone', 60],
    ['signatoryName', 100], ['signatoryTitle', 100], ['refPrefix', 60], ['chequePayee', 120], ['pan', 20], ['gstin', 20],
  ]
  const firm = { ...EMPTY_FIRM, bank: { ...EMPTY_FIRM.bank } } as FirmDetails
  for (const [k, max] of fields) {
    const v = str(f[k], max)
    if (v === null) return `Firm details: "${k}" must be text of at most ${max} characters`
    ;(firm as unknown as Record<string, unknown>)[k] = v
  }
  for (const [k, max] of [['accountName', 120], ['accountNo', 40], ['bankName', 160], ['ifsc', 20]] as const) {
    const v = str(bank[k], max)
    if (v === null) return `Bank details: "${k}" must be text of at most ${max} characters`
    firm.bank[k] = v
  }
  const serial = intIn(f.nextSerial, 1, 999999, 1)
  if (serial === 'bad' || serial === null) return 'The next reference number must be a whole number from 1 to 999999'
  firm.nextSerial = serial
  if (f.logoDataUrl) {
    if (typeof f.logoDataUrl !== 'string' || !/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(f.logoDataUrl)) {
      return 'The logo must be a PNG, JPEG, WebP or SVG image'
    }
    if (f.logoDataUrl.length > 400_000) return 'The logo must be smaller than about 300 KB'
    firm.logoDataUrl = f.logoDataUrl
  } else firm.logoDataUrl = null

  const t = b.terms ?? {}
  const terms = { ...DEFAULT_TERMS }
  for (const k of ['noDeductions', 'forceMajeure', 'indemnification', 'copyright', 'interpretation', 'arbitration'] as const) {
    const v = str(t[k], 4000)
    if (v === null) return `Terms: "${k}" must be at most 4000 characters`
    if (v) terms[k] = v
  }
  for (const k of ['clientRoles', 'reimbursables'] as const) {
    const v = strList(t[k], 40, 1500)
    if (v === null) return `Terms: "${k}" must be a list of at most 40 items`
    if (v.length) terms[k] = clean(v)
  }
  for (const k of ['noDeductions', 'forceMajeure', 'indemnification', 'copyright', 'interpretation', 'arbitration'] as const) {
    if (FORBIDDEN.test(terms[k])) return 'Terms cannot ask for speed money or similar payments'
  }
  return { firm, terms }
}

// ─── Proposal content ────────────────────────────────────────────────────────

/** The scope line for each discipline in the project brief. */
const BRIEF_LINE: Record<Discipline, string> = {
  Architecture: 'Architecture Design',
  Structural: 'Structural Design',
  'MEP and fire safety': 'Mechanical, Electrical & Plumbing (MEP) Design and Fire Safety',
  Interior: 'Interior Design',
}

function disciplinePhrase(ds: Discipline[]): string {
  const arch = ds.includes('Architecture'), int = ds.includes('Interior')
  if (arch && int) return 'Architecture & Interior Design'
  if (arch) return 'Architectural Planning and Design'
  if (int) return 'Interior Design'
  return ds.map((d) => BRIEF_LINE[d]).join(' and ')
}

export interface DraftInput {
  date: string
  client: { salutation: string; name: string; city: string }
  projectType: string
  location: string
  disciplines: Discipline[]
  notes: string
  fees: ProposalContent['fees']
}

/** Parse the New proposal form. */
export function parseDraftInput(body: unknown): DraftInput | string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const c = (b.client && typeof b.client === 'object' ? b.client : {}) as Record<string, unknown>
  const name = str(c.name, 120)
  if (!name) return "Enter the client's name"
  const salutation = str(c.salutation, 30) || 'Sir'
  const city = str(c.city, 80)
  if (city === null) return 'The city must be at most 80 characters'
  const projectType = str(b.projectType, 80)
  if (!projectType) return 'Choose or type the kind of project'
  const location = str(b.location, 120)
  if (!location) return 'Enter where the project is'
  const ds = Array.isArray(b.disciplines) ? b.disciplines.filter((d): d is Discipline => DISCIPLINES.some((x) => x.key === d)) : []
  if (ds.length === 0) return 'Tick at least one discipline'
  const notes = str(b.notes, 2000)
  if (notes === null) return 'Notes must be at most 2000 characters'
  if (FORBIDDEN.test(notes)) return 'Notes cannot ask for speed money or similar payments'
  const date = typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : new Date().toISOString().slice(0, 10)
  const fees = parseFees(b.fees, ds)
  if (typeof fees === 'string') return fees
  return { date, client: { salutation, name, city: city || '' }, projectType, location, disciplines: ds, notes: notes || '', fees }
}

/** Fee section: stages (rupees per sq ft) and the commercial terms. Defaults to Trijya's standard. */
export function parseFees(raw: unknown, ds: Discipline[]): ProposalContent['fees'] | string {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  let stages: ProposalStage[]
  if (Array.isArray(f.stages)) {
    if (f.stages.length === 0 || f.stages.length > 60) return 'The fee table needs 1 to 60 stages'
    stages = []
    for (const s of f.stages as Record<string, unknown>[]) {
      const group = str(s?.group, 60), name = str(s?.name, 160)
      const rate = money(s?.rate, 100000, null)
      if (!group || !name) return 'Every fee stage needs a group and a name'
      if (rate === 'bad' || rate === null || rate <= 0) return `Enter the rate for "${name}" in rupees per sq ft, more than 0`
      stages.push({ group, name, rate })
    }
  } else {
    const groups = new Set<string>(DISCIPLINES.filter((d) => ds.includes(d.key)).map((d) => d.group))
    stages = STANDARD_SQFT_SCHEDULE.filter((s) => groups.has(s.group)).map((s) => ({ ...s }))
  }
  const landscape = money(f.landscapePerAcre, 1e9, 300000)
  const gst = money(f.gstPercent, 100, 18)
  const visits = intIn(f.siteVisitsIncluded, 0, 10000, 50)
  const extra = money(f.extraVisitRate, 1e8, 15000)
  const outstation = money(f.outstationPerDay, 1e8, 25000)
  const valid = intIn(f.offerValidMonths, 1, 24, 1)
  const engage = intIn(f.engagementMonths, 1, 240, 24)
  if ([landscape, gst, visits, extra, outstation, valid, engage].includes('bad')) return 'Check the numbers in the fee section'
  const area = str(f.areaSqft, 30)
  if (area === null) return 'The area is too long'
  const sanction = f.sanctionNotes === undefined ? DEFAULT_SANCTION_NOTES : strList(f.sanctionNotes, 20, 600)
  const exclusions = f.exclusions === undefined ? ['Soil test report'] : strList(f.exclusions, 30, 300)
  if (sanction === null || exclusions === null) return 'Sanction notes and exclusions must be lists of short lines'
  return {
    stages, areaSqft: area,
    landscapePerAcre: landscape as number | null, gstPercent: (gst as number | null) ?? 18,
    sanctionNotes: clean(sanction), siteVisitsIncluded: visits as number | null, extraVisitRate: extra as number | null,
    outstationPerDay: outstation as number | null, exclusions: clean(exclusions),
    offerValidMonths: (valid as number | null) ?? 1, engagementMonths: (engage as number | null) ?? 24,
  }
}

/** The standard wording, used when no AI provider answers and as the shape the AI fills in. */
export function standardText(input: DraftInput, firmName: string) {
  const type = input.projectType.trim()
  const lower = type.toLowerCase()
  return {
    subject: `Proposal and Terms of Engagement for ${disciplinePhrase(input.disciplines).replace('Architecture & Interior Design', 'Architectural Planning, Design and Interior Design')} Consultancy for the Proposed ${type} at ${input.location}`,
    intro: [
      `With reference to our recent discussion regarding the design consultancy for your esteemed ${lower} project located at ${input.location}, we are pleased to submit our proposal, along with the general commercial and legal terms governing our professional engagement.`,
      'We look forward to a fruitful collaboration and your continued co-operation, and assure you of the highest quality of professional service throughout the project.',
      'Thanking you for the opportunity.',
    ].join('\n\n'),
    briefTitle: `${type} ${disciplinePhrase(input.disciplines)} Consultancy`,
    scopeSummary: input.disciplines.map((d) => BRIEF_LINE[d]),
    scope: input.disciplines.map((d) => ({ discipline: d, items: [...(SCOPE_LIBRARY[d] ?? [])] })),
    closing: `Thank you for the trust placed in ${firmName || 'us'}. We look forward to working together on this prestigious ${lower} project.`,
  }
}

type DraftText = ReturnType<typeof standardText> & { exclusions?: string[] }

/** Pull the first JSON object out of a model reply (models sometimes wrap it in prose or fences). */
function firstJson(text: string): unknown {
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return null }
}

/** Keep only well-formed, sensible fields from the AI; anything missing falls back to the standard text. */
function mergeAi(ai: unknown, base: DraftText, ds: Discipline[]): DraftText {
  // Plain hyphens and quotes: models like non-breaking hyphens, which the letterhead font lacks.
  const plain = (v: unknown): unknown => typeof v === 'string'
    ? v.replace(/[‐‑‒–]/g, (m) => (m === '–' ? '–' : '-')).replace(/ /g, ' ')
    : Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v
  ai = plain(ai)
  const a = (ai && typeof ai === 'object' ? ai : {}) as Record<string, unknown>
  const s = (k: string, max: number, fb: string) => {
    const v = a[k]
    return typeof v === 'string' && v.trim().length > 10 && v.length <= max && !FORBIDDEN.test(v) ? v.trim() : fb
  }
  const scope = ds.map((d) => {
    const found = Array.isArray(a.scope) ? (a.scope as Record<string, unknown>[]).find((x) => typeof x?.discipline === 'string' && x.discipline.toLowerCase().startsWith(d.toLowerCase().slice(0, 5))) : undefined
    const items = Array.isArray(found?.items) ? clean((found!.items as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 3 && x.length <= 300).map((x) => x.trim())) : []
    return { discipline: d, items: items.length >= 3 && items.length <= 22 ? items : base.scope.find((x) => x.discipline === d)!.items }
  })
  const summary = Array.isArray(a.scopeSummary) ? clean((a.scopeSummary as unknown[]).filter((x): x is string => typeof x === 'string' && x.length <= 200)) : []
  const exclusions = Array.isArray(a.exclusions) ? clean((a.exclusions as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 2 && x.length <= 300).map((x) => x.trim())).slice(0, 12) : undefined
  return {
    subject: s('subject', 300, base.subject),
    intro: s('intro', 3000, base.intro),
    briefTitle: s('briefTitle', 160, base.briefTitle),
    scopeSummary: summary.length >= 1 && summary.length <= 8 ? summary : base.scopeSummary,
    scope,
    closing: s('closing', 600, base.closing),
    exclusions,
  }
}

/**
 * Write the project-specific wording with AI: subject, cover letter, brief,
 * scope of work per discipline, project-specific exclusions and closing.
 * Fees, numbers and legal terms never come from the AI. Falls back to the
 * standard text when no provider answers or the reply is not usable.
 */
export async function draftWording(input: DraftInput, firmName: string): Promise<DraftText & { draftedBy: string }> {
  const base = standardText(input, firmName)
  if (!isAssistantEnabled()) return { ...base, draftedBy: 'Standard text (AI is switched off)' }

  const system = [
    `You write the project-specific wording of a fee proposal for ${firmName || 'an Indian architecture practice'}, an architecture, interior, vastu, landscape and planning studio in India.`,
    'Reply with ONLY a JSON object, no other text, with these keys:',
    '{"subject": string, "intro": string, "briefTitle": string, "scopeSummary": string[], "scope": [{"discipline": string, "items": string[]}], "exclusions": string[], "closing": string}',
    'Rules:',
    '- Formal Indian business English, like the example. Short, precise lines.',
    '- "intro": the cover letter body, 2 or 3 short paragraphs separated by a blank line, ending with a line thanking the client for the opportunity.',
    '- "scope": one entry per discipline given, in the same order, using the given discipline names. These are contract deliverables: START from the example items for that discipline and keep every one that applies (reword lightly to fit the project), then add up to 5 items specific to this project and the notes. Short noun phrases. At most 18 items per discipline.',
    '- "exclusions": ONLY things the notes explicitly say are excluded, as short noun phrases (for example "BOH (back-of-house) design and drawings"). If the notes exclude nothing, use an empty list. Never add exclusions of your own.',
    '- Never mention fees, rates, money, taxes, payment, timelines, penalties or legal terms: those are added separately.',
    '- Never invent facts about the client, the site, areas or numbers that are not in the input.',
    '- Never mention speed money, facilitation payments or anything similar.',
  ].join('\n')
  const user = JSON.stringify({
    input: {
      client: `${input.client.name}${input.client.city ? `, ${input.client.city}` : ''}`,
      projectType: input.projectType, location: input.location, disciplines: input.disciplines, notes: input.notes || '(none)',
    },
    example: { ...base, scope: base.scope },
  })

  // A provider that fails (wrong model, bad key, timeout) is skipped for the
  // rest of this request rather than tried once per key.
  const failed = new Set<Parameters<typeof reportRateLimit>[0]>()
  for (let attempt = 0; attempt < 6; attempt++) {
    const sel = selectNextModel({ deprioritize: ['local'], exclude: [...failed] })
    if (!sel) break
    try {
      const r = await generateText({
        model: sel.model, system, messages: [{ role: 'user', content: user }],
        temperature: 0.3, maxOutputTokens: 2500, abortSignal: AbortSignal.timeout(60_000),
      })
      const parsed = firstJson(r.text)
      if (!parsed) { console.warn(`[proposals] ${sel.provider} reply was not JSON`); failed.add(sel.provider); continue }
      const merged = mergeAi(parsed, base, input.disciplines)
      return { ...merged, draftedBy: `AI (${sel.provider}, ${sel.modelName})` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[proposals] ${sel.provider} failed: ${msg.slice(0, 200)}`)
      if (/rate|429|quota/i.test(msg)) reportRateLimit(sel.provider, sel.apiKey)
      else failed.add(sel.provider)
    }
  }
  return { ...base, draftedBy: 'Standard text (no AI provider answered)' }
}

/** Build the full proposal content from the form and the drafted wording. */
export function buildContent(input: DraftInput, text: DraftText & { draftedBy: string }): ProposalContent {
  const exclusions = addLines(input.fees.exclusions, text.exclusions ?? [])
  return {
    date: input.date, client: input.client, projectType: input.projectType, location: input.location,
    disciplines: input.disciplines, subject: text.subject, intro: text.intro,
    brief: { title: text.briefTitle, scopeSummary: text.scopeSummary }, scope: text.scope,
    fees: { ...input.fees, exclusions }, closing: text.closing, draftedBy: text.draftedBy, notes: input.notes,
  }
}

/** Check an edited proposal sent back by the editor. Firm details and terms are not editable here. */
export function parseContent(raw: unknown, prev: ProposalContent): ProposalContent | string {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const c = (b.client && typeof b.client === 'object' ? b.client : {}) as Record<string, unknown>
  const brief = (b.brief && typeof b.brief === 'object' ? b.brief : {}) as Record<string, unknown>
  const name = str(c.name, 120), salutation = str(c.salutation, 30), city = str(c.city, 80)
  const subject = str(b.subject, 300), intro = str(b.intro, 4000), closing = str(b.closing, 800)
  const projectType = str(b.projectType, 80), location = str(b.location, 120), title = str(brief.title, 160)
  if ([name, salutation, city, subject, intro, closing, projectType, location, title].some((x) => x === null)) return 'Some text is too long'
  if (!name || !subject) return 'The client name and the subject cannot be empty'
  const summary = strList(brief.scopeSummary, 10, 200)
  if (summary === null) return 'The scope summary must be a short list'
  if (!Array.isArray(b.scope) || b.scope.length > 8) return 'The scope of work is not valid'
  const scope: ProposalContent['scope'] = []
  for (const s of b.scope as Record<string, unknown>[]) {
    const discipline = str(s?.discipline, 80), items = strList(s?.items, 40, 400)
    if (!discipline || items === null) return 'Every scope section needs a heading and at most 40 lines'
    scope.push({ discipline, items: clean(items) })
  }
  const fees = parseFees(b.fees, prev.disciplines)
  if (typeof fees === 'string') return fees
  const date = typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : prev.date
  for (const t of [subject!, intro!, closing!]) if (FORBIDDEN.test(t)) return 'A proposal cannot ask for speed money or similar payments'
  return {
    ...prev, date, client: { name, salutation: salutation || 'Sir', city: city || '' },
    projectType: projectType || prev.projectType, location: location || prev.location,
    subject: subject!, intro: intro!, brief: { title: title || prev.brief.title, scopeSummary: summary },
    scope, fees, closing: closing!,
  }
}

// ─── Reference numbers ───────────────────────────────────────────────────────

type Tx = Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

/**
 * Give the next reference number and create the proposal, one at a time per
 * company (a lock), so two admins never get the same number. The serial is
 * the larger of Firm details' "next number" and one past the highest used.
 */
export function createWithNextSerial(orgId: string, fn: (tx: Tx, serial: number, refNo: string) => Promise<string>, date: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`proposal-serial:${orgId}`}))`
    const row = await tx.proposalSettings.findFirst()
    const settings = mergeSettings(row?.data)
    const top = await tx.proposal.aggregate({ _max: { serial: true } })
    const serial = Math.max(settings.firm.nextSerial, (top._max.serial ?? 0) + 1)
    const refNo = buildRefNo(settings.firm.refPrefix, serial, financialYear(date))
    const id = await fn(tx, serial, refNo)
    const next = { ...settings, firm: { ...settings.firm, nextSerial: serial + 1 } }
    if (row) await tx.proposalSettings.update({ where: { id: row.id }, data: { data: next as unknown as Prisma.InputJsonValue } })
    return id
  }, TX_OPTIONS)
}

// ─── Views ───────────────────────────────────────────────────────────────────

type ProposalRow = {
  id: string; projectId: string; serial: number; refNo: string; status: string; content: Prisma.JsonValue
  createdById: string; createdAt: Date; updatedAt: Date; sentAt: Date | null; acceptedAt: Date | null
}

export async function toViews(rows: ProposalRow[]): Promise<ProposalView[]> {
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, name: true } })
  return rows.map((r) => ({
    id: r.id, projectId: r.projectId, serial: r.serial, refNo: r.refNo, status: r.status as ProposalStatus,
    content: r.content as unknown as ProposalContent,
    createdByName: users.find((u) => u.id === r.createdById)?.name ?? 'Someone',
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    sentAt: r.sentAt?.toISOString() ?? null, acceptedAt: r.acceptedAt?.toISOString() ?? null,
  }))
}

export type { ProposalTerms }
