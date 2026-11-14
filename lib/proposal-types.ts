/**
 * Fee proposals: shapes and defaults shared by the server and the browser
 * (no server imports). Modelled on Trijya Design Studio's proposals: a cover
 * letter, project brief, scope of work by discipline, professional fees
 * (rate per sq ft with stages by discipline, GST extra), and standard terms
 * of engagement under the Council of Architecture.
 */

export type ProposalStatus = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'DECLINED'

export const PROPOSAL_STATUS_TEXT: Record<ProposalStatus, string> = {
  DRAFT: 'Draft', SENT: 'Sent', ACCEPTED: 'Accepted', DECLINED: 'Declined',
}

/** The disciplines a proposal can cover, and the payment group each one's stages go in. */
export const DISCIPLINES = [
  { key: 'Architecture', group: 'Architecture design' },
  { key: 'Structural', group: 'Structural design' },
  { key: 'MEP and fire safety', group: 'MEP design' },
  { key: 'Interior', group: 'Interior design' },
] as const
export type Discipline = typeof DISCIPLINES[number]['key']

export const PROJECT_TYPES = [
  'Resort', 'Hotel', 'Cottages', 'Residence', 'Villa', 'Group housing', 'Commercial building', 'Office',
  'Institutional building', 'School', 'Hospital', 'Temple', 'Interior fit-out',
]

export interface ProposalStage {
  group: string
  name: string
  /** Rupees per sq ft, up to 2 decimals. */
  rate: number
}

export interface FirmDetails {
  name: string
  /** "ARCHITECTURE | VASTU | INTERIOR | LANDSCAPE | PLANNING" */
  tagline: string
  address: string
  /** Home state, for the out-of-state visit charge ("Uttarakhand"). */
  homeState: string
  email: string
  phone: string
  signatoryName: string
  signatoryTitle: string
  /** Reference number before the serial: "TDS/Offer/DD/Arch" gives "TDS/Offer/DD/Arch/81/2026-27". */
  refPrefix: string
  /** The serial the next proposal gets. */
  nextSerial: number
  chequePayee: string
  bank: { accountName: string; accountNo: string; bankName: string; ifsc: string }
  pan: string
  gstin: string
  /** Small PNG/JPEG/SVG as a data: URL, shown on the cover page. */
  logoDataUrl: string | null
}

export interface ProposalTerms {
  noDeductions: string
  clientRoles: string[]
  forceMajeure: string
  reimbursables: string[]
  indemnification: string
  copyright: string
  interpretation: string
  arbitration: string
}

export interface ProposalSettingsData {
  firm: FirmDetails
  terms: ProposalTerms
}

export interface ProposalContent {
  /** YYYY-MM-DD */
  date: string
  client: { salutation: string; name: string; city: string }
  projectType: string
  location: string
  disciplines: Discipline[]
  subject: string
  /** Cover letter body; paragraphs separated by a blank line. */
  intro: string
  brief: { title: string; scopeSummary: string[] }
  scope: { discipline: string; items: string[] }[]
  fees: {
    stages: ProposalStage[]
    /** Built-up area if known (sq ft, as typed); the letter quotes per sq ft either way. */
    areaSqft: string
    /** Rupees per acre; 0 or null = no landscape line. */
    landscapePerAcre: number | null
    gstPercent: number
    sanctionNotes: string[]
    siteVisitsIncluded: number | null
    extraVisitRate: number | null
    outstationPerDay: number | null
    exclusions: string[]
    offerValidMonths: number
    engagementMonths: number
  }
  closing: string
  /** Notes for the AI (not printed). */
  notes?: string
  /** Who drafted the wording (AI provider, or the standard text when AI was unavailable). */
  draftedBy?: string
  /** Firm details and terms frozen when the proposal is sent, so later edits to Firm details do not change it. */
  firm?: FirmDetails
  terms?: ProposalTerms
}

export interface ProposalView {
  id: string
  projectId: string
  serial: number
  refNo: string
  status: ProposalStatus
  content: ProposalContent
  createdByName: string
  createdAt: string
  updatedAt: string
  sentAt: string | null
  acceptedAt: string | null
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const EMPTY_FIRM: FirmDetails = {
  name: '', tagline: '', address: '', homeState: '', email: '', phone: '', signatoryName: '', signatoryTitle: 'Principal Architect',
  refPrefix: 'Offer', nextSerial: 1, chequePayee: '',
  bank: { accountName: '', accountNo: '', bankName: '', ifsc: '' }, pan: '', gstin: '', logoDataUrl: null,
}

/** Standard terms of engagement, as in Trijya's 2026 proposals (editable in Firm details). */
export const DEFAULT_TERMS: ProposalTerms = {
  noDeductions: 'No deductions shall be made from the fee of the Architect on account of penalty, liquidated damages, part rates or other sums withheld from payment or recovered from contractors/suppliers.',
  clientRoles: [
    'To provide detailed requirements of the project.',
    'To provide the design brief, look-and-feel visuals and reference images required for the project.',
    'To provide property lease/ownership documents.',
    'To provide a site plan (preferably as a soft copy in AutoCAD format), to a suitable scale, showing boundaries, contours at suitable intervals, existing physical features including roads, paths, trees, existing structures, existing service and utility lines, and lines to which the proposed services can be connected. Where such information is not readily available, the Client shall arrange for the survey/collection of necessary information and bear its cost.',
    'To furnish reports on soil conditions and tests as required by the Architect, or pay for their preparation.',
    'To furnish specific conditions, statutory requirements, codes of practice, schedule of rates, etc., desired to be followed.',
    'To pay all fees, levies, security deposits and expenses in respect of statutory sanction.',
    'To give effect to the professional advice of the Architect and make no changes to the drawings and documents without the consent of the Architect.',
    "To honour the Architect's bills within one week of submission.",
    "To appoint a Construction Manager (Clerk of Works/Site Supervisor, or a Construction Management Agency in case of a large and complex project) as per the Architect's advice.",
    "To visit the Architect's office, if required, for meetings related to design discussions, appointment of contractors and consultants, and conferences among the contractors, consultants and the Client.",
  ],
  forceMajeure: 'Force Majeure means and includes an act of God and/or any act beyond the reasonable control of the Parties and/or not attributable to the Client, including but not limited to fire, flood, earthquake, tsunami, volcanic activity, windstorm or other natural disaster; any act of a sovereign including but not limited to war, invasion, act of foreign enemies, hostilities (whether war be declared or not), civil war, rebellion, revolution, terrorist act or insurrection; riot, commotion, disorder, extended strike or lockout; outbreak of epidemic or pandemic, lockdown, etc., that may result in closure, suspension or incapacitation of operations at the project site as declared by the Government through its directions, circulars or notifications in the Gazette. The Parties shall not be liable to perform their obligations during such Force Majeure period; however, we shall provide and hand over to the Client all work completed up to that date.',
  reimbursables: [
    'Hospitality and travel expenses are additional to this fee and shall be borne by the Client at actuals.',
    'Cost of presentation models, computer simulations (walk-throughs), presentation drawings, etc., prepared at the instance of the Client for purposes other than the design and execution of the project.',
  ],
  indemnification: "In the event that a claim or suit is brought against the Architect or the Consultants by any third party for damages arising from personal injury or property damage caused wholly by the Client, the Client shall indemnify the Architect and fully reimburse any loss, damage or expenses, including attorney's fees, which the Architect may incur in connection therewith. The Client shall also indemnify and hold the Architect harmless from any statutory breaches, regulatory delays, force majeure events, or misrepresentation of property/title.",
  copyright: "Architectural design is the intellectual property of the Architect. The drawings, specifications, documents and models, as instruments of service, are the property of the Architect whether or not the project for which they are made is executed. The Client shall retain copies of the Architect's models, drawings, specifications and other documents for information and use in connection with the project. These shall not be used for any other project by the Client, the Architect or any other person, except for repetition decided mutually on commercially agreeable terms.",
  interpretation: 'In case of any ambiguity or difficulty in the interpretation of the Conditions of Engagement and Scale of Charges/Fees, the interpretation of the Council of Architecture shall be final and binding on the Architect and the Client.',
  arbitration: 'All disputes or differences which may arise between the Client and the Architect under the Conditions of Engagement and Scale of Charges/Fees, with regard to the meaning or interpretation or any matter or thing done or to be done in pursuance hereof, shall be referred for arbitration to the Council of Architecture. The arbitrator shall be appointed by the President, Council of Architecture. The arbitration shall be conducted as per the provisions of the Arbitration and Conciliation Act, 1996. The decision and award of the arbitrator shall be final and binding on the Architect and the Client.',
}

export const DEFAULT_SANCTION_NOTES = [
  'Coordination, facilitation and liaisoning are included in the scope; however, the liaisoning fee will be charged separately.',
  'Completion certificate and as-built drawings are excluded from the scope.',
  'Legal fees, statutory deposits and liaison charges are excluded from the scope and shall be borne by the Client at actuals, wherever required.',
  "The Architect's role shall be advisory and facilitative only.",
]

/** Scope of work items by discipline, from Trijya's proposals; the AI adapts these to the project. */
export const SCOPE_LIBRARY: Record<string, string[]> = {
  Architecture: [
    'Preparation of design brief and conceptual layouts',
    'Conceptual architectural plans',
    'Working drawings for architectural plans',
    'Elevations of all sides',
    '3D views of buildings',
    'Furniture layout plan',
    'Detailed electrical and illumination design for exterior and interior',
    'Selection sheet of materials and products',
    'Sanction drawings, prepared and submitted to the Authority',
  ],
  Structural: [
    'Structural design and analysis',
    'Foundation structure drawings',
    'Complete set of structural working drawings',
  ],
  'MEP and fire safety': [
    'Sanitary, plumbing, drainage, water supply and sewerage design',
    'Electrical, electronic and communication systems design',
    'Heating, ventilation and air conditioning (HVAC)',
    'Firefighting design',
    'Integration of all engineering services',
  ],
  Interior: [
    "Preparation of design brief and conceptual design as per the Client's requirements",
    'Interior design drawings',
    'All wall elevations, compositions and colours',
    'All furnishing combinations, wall panelling, false ceiling design and drawings',
    'Colour compositions along with interior perspective views (excluding smaller areas such as toilets, dressing rooms, small lobbies, etc.)',
    'Furniture selections and recommendations',
    'Toilet wall compositions for tiles',
    'Detailed electrical and illumination design as per the finalised interior',
    'Detailed flooring design (wherever required) and drawings',
    'Selection sheet of materials and products',
  ],
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Indian financial year of a date: November 2026 -> "2026-27", February 2027 -> "2026-27". */
export function financialYear(isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number)
  const start = m! >= 4 ? y! : y! - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

/** "TDS/Offer/DD/Arch" + 81 + "2026-27" -> "TDS/Offer/DD/Arch/81/2026-27". */
export function buildRefNo(prefix: string, serial: number, fy: string): string {
  return [prefix.trim().replace(/\/+$/, ''), String(serial), fy].filter(Boolean).join('/')
}

/** The short form used in page footers: first part of the prefix + serial + year ("TDS/81/2026-27"). */
export function shortRef(refNo: string): string {
  const parts = refNo.split('/')
  return parts.length > 3 ? [parts[0], ...parts.slice(-2)].join('/') : refNo
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function under1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100
  const rest = r < 20 ? ONES[r]! : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` ${ONES[r % 10]}` : ''}`
  return [h ? `${ONES[h]} Hundred` : '', rest].filter(Boolean).join(' ')
}

/** Whole rupees in words, Indian system: 300000 -> "Three Lakh", 125 -> "One Hundred Twenty Five". */
export function rupeesInWords(n: number): string {
  n = Math.floor(Math.abs(n))
  if (n === 0) return 'Zero'
  const crore = Math.floor(n / 10000000), lakh = Math.floor(n / 100000) % 100, thousand = Math.floor(n / 1000) % 100
  return [
    crore ? `${rupeesInWords(crore)} Crore` : '',
    lakh ? `${under1000(lakh)} Lakh` : '',
    thousand ? `${under1000(thousand)} Thousand` : '',
    under1000(n % 1000),
  ].filter(Boolean).join(' ')
}

/** 300000 -> "3,00,000" (Indian grouping), 12.5 -> "12.50". */
export function rupeeFigure(n: number, decimals = Number.isInteger(n) ? 0 : 2): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** Sum of the stage rates, rupees per sq ft, exact to the paisa. */
export function totalRate(stages: ProposalStage[]): number {
  return Math.round(stages.reduce((s, x) => s + Math.round(x.rate * 100), 0)) / 100
}

/** Roman numerals for sub-lists (i, ii, iii...). */
export function roman(n: number): string {
  const map: [number, string][] = [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
  let out = ''
  for (const [v, s] of map) while (n >= v) { out += s; n -= v }
  return out
}
