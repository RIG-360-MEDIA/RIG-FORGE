/**
 * Shapes the Payments API returns. Client-safe (no server imports). Every
 * amount is whole paise as a number (exact up to about Rs 90 lakh crore);
 * format with formatInr().
 */

export type FeeBasis = 'FIXED' | 'PERCENT' | 'PER_SQFT'
export type FeeChangeKind = 'INITIAL' | 'VARIATION' | 'COST_REVISION' | 'CORRECTION' | 'AREA_REVISION'
export type PaymentMode = 'BANK' | 'UPI' | 'CHEQUE' | 'CASH' | 'OTHER'
export type PhaseStatus = 'UNPAID' | 'PART_PAID' | 'PAID'

export const PAYMENT_MODES: { value: PaymentMode; label: string }[] = [
  { value: 'BANK', label: 'Bank transfer' },
  { value: 'UPI', label: 'UPI' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'CASH', label: 'Cash' },
  { value: 'OTHER', label: 'Other' },
]

export const FEE_CHANGE_LABELS: Record<FeeChangeKind, string> = {
  INITIAL: 'Agreed fee',
  VARIATION: 'Variation',
  COST_REVISION: 'Cost estimate revised',
  CORRECTION: 'Correction',
  AREA_REVISION: 'Area revised',
}

export interface FeeChangeView {
  id: string
  kind: FeeChangeKind
  amountDelta: number
  estimatedCost: number | null
  /** PER_SQFT: the area after this change, in hundredths of a sq ft. */
  areaCentiSqft: number | null
  reason: string
  createdAt: string
  createdByName: string
}

export interface PhaseView {
  id: string
  /** Discipline ("Architecture design"); null = ungrouped. */
  group: string | null
  name: string
  /** Fee for the stage before GST. */
  amount: number
  /** PER_SQFT rate stages: paise per sq ft (the amount follows the area). */
  ratePerSqft: number | null
  /** GST on the amount. */
  gst: number
  /** amount + gst: what the client pays for this stage. */
  gross: number
  /** Paid towards gross (money received plus TDS, linked to this stage). */
  received: number
  /** gross - received. */
  balance: number
  dueDate: string | null
  note: string | null
  sortOrder: number
  isActive: boolean
  status: PhaseStatus
  overdue: boolean
}

export interface ReceiptView {
  id: string
  receivedOn: string
  /** Money received. */
  amount: number
  /** TDS the client deducted; counts as paid on top of the money received. */
  tds: number
  mode: PaymentMode
  reference: string | null
  payer: string | null
  note: string | null
  createdAt: string
  createdByName: string
  allocations: { id: string; phaseId: string; phaseName: string; amount: number; createdAt: string }[]
  allocated: number
  onAccount: number
  reversed: { at: string; byName: string; reason: string } | null
}

export interface PaymentsSummary {
  plan: {
    basis: FeeBasis
    percentBp: number | null
    /** PER_SQFT: area in hundredths of a sq ft. */
    areaCentiSqft: number | null
    /** PER_SQFT: sum of the rates of the active rate stages, paise per sq ft. */
    ratePerSqft: number | null
    gstBp: number
    createdAt: string
  } | null
  fee: { current: number; estimatedCost: number | null; changes: FeeChangeView[] }
  phases: PhaseView[]
  receipts: ReceiptView[]
  totals: {
    /** The fee before GST. */
    fee: number
    /** GST on the fee. */
    gst: number
    /** fee + gst: what the client pays in all. */
    payable: number
    /** TDS deducted by the client (receipts not reversed). */
    tds: number
    /** received + tds: everything that counts as paid. */
    credited: number
    /** Sum of active phases. */
    phasesTotal: number
    /** All money received (receipts not reversed). */
    received: number
    /** Received and counted against phases. */
    allocated: number
    /** Paid (money + TDS) but not yet linked to any stage (advances). */
    onAccount: number
    /** payable - credited; negative means the client has paid more. */
    outstanding: number
  }
  warnings: string[]
  history: { id: string; action: string; summary: string; userName: string; createdAt: string }[]
}

/** "₹1,50,000" (Indian grouping); paise shown only when there are any. */
export function formatInr(paise: number): string {
  const rupees = paise / 100
  const hasPaise = paise % 100 !== 0
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR',
    minimumFractionDigits: hasPaise ? 2 : 0, maximumFractionDigits: 2,
  }).format(rupees)
}

/**
 * What a person typed in a rupee box ("1,50,000", "2500.5") to paise, by the
 * same rules as the server (lib/payments.ts parseRupees), so totals shown
 * while typing match what will be saved. null when not a valid amount.
 */
export function rupeesToPaise(text: string, { signed = false } = {}): number | null {
  const m = text.replace(/[,\s₹]/g, '').match(/^(-)?(\d{1,13})(?:\.(\d{1,2}))?$/)
  if (!m || (m[1] && !signed)) return null
  const paise = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0') || '0')
  return m[1] ? -paise : paise
}

/** Paise to an editable rupee string with Indian commas ("1,50,000" or "2,500.50"); rupeesToPaise reads it back. */
export function paiseToRupeesText(paise: number): string {
  const sign = paise < 0 ? "-" : ""
  const abs = Math.abs(paise)
  const whole = Math.floor(abs / 100).toLocaleString("en-IN")
  const frac = abs % 100
  return sign + whole + (frac ? `.${String(frac).padStart(2, "0")}` : "")
}

/** Basis points to "7.5%". */
export function formatPercentBp(bp: number): string {
  return `${(bp / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`
}

/** Hundredths of a sq ft to "12,500 sq ft" / "5,140.82 sq ft". */
export function formatArea(centi: number): string {
  return `${(centi / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })} sq ft`
}

/** "12,500" or "5140.82" (sq ft) to hundredths, as the server parses it. null when not valid or 0. */
export function areaToCenti(text: string): number | null {
  const m = text.replace(/[,\s]/g, '').replace(/sq\.?ft$/i, '').match(/^(\d{1,9})(?:\.(\d{1,2}))?$/)
  if (!m) return null
  const v = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0')
  return v > 0 ? v : null
}

/** rate (paise per sq ft) x area (hundredths of a sq ft), rounded half up, in paise. Same as the server. */
export function amountForArea(ratePaise: number, areaCenti: number): number {
  return Math.floor((ratePaise * areaCenti + 50) / 100)
}

/** GST on an amount, rounded half up. Same as the server (percentOf). */
export function gstOn(amount: number, bp: number): number {
  return Math.floor((amount * bp + 5000) / 10000)
}

export interface StandardStage { group: string; name: string; rate: number }

/**
 * The payment schedule from Trijya's current proposal (Rs 100 per sq ft):
 * stages grouped by discipline, each a rate in rupees per sq ft. Offered when
 * a fee is set up per sq ft; every line can be changed or dropped.
 */
export const STANDARD_SQFT_SCHEDULE: StandardStage[] = [
  { group: 'Architecture design', name: 'Advance, with Letter of Appointment', rate: 10 },
  { group: 'Architecture design', name: 'At start of preparation of sanction drawings', rate: 5 },
  { group: 'Architecture design', name: 'On submission of sanction drawings to the Authority', rate: 5 },
  { group: 'Architecture design', name: 'On finalisation of architectural layout plans', rate: 10 },
  { group: 'Architecture design', name: 'On finalisation of exterior 3D views', rate: 5 },
  { group: 'Architecture design', name: 'On submission of architectural drawings', rate: 5 },
  { group: 'Structural design', name: 'On submission of foundation structure drawings', rate: 5 },
  { group: 'Structural design', name: 'On submission of complete set of structural drawings', rate: 5 },
  { group: 'MEP design', name: 'Services: plumbing drawings', rate: 5 },
  { group: 'MEP design', name: 'Services: electrical, HVAC, security and fire drawings', rate: 5 },
  { group: 'Interior design', name: 'On submission of interior views package', rate: 25 },
  { group: 'Interior design', name: 'On submission of detailed interior working drawings package', rate: 10 },
  { group: 'Interior design', name: 'On completion', rate: 5 },
]
