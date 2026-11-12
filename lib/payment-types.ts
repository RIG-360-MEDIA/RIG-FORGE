/**
 * Shapes the Payments API returns. Client-safe (no server imports). Every
 * amount is whole paise as a number (exact up to about Rs 90 lakh crore);
 * format with formatInr().
 */

export type FeeBasis = 'FIXED' | 'PERCENT'
export type FeeChangeKind = 'INITIAL' | 'VARIATION' | 'COST_REVISION' | 'CORRECTION'
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
}

export interface FeeChangeView {
  id: string
  kind: FeeChangeKind
  amountDelta: number
  estimatedCost: number | null
  reason: string
  createdAt: string
  createdByName: string
}

export interface PhaseView {
  id: string
  name: string
  amount: number
  received: number
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
  amount: number
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
  plan: { basis: FeeBasis; percentBp: number | null; createdAt: string } | null
  fee: { current: number; estimatedCost: number | null; changes: FeeChangeView[] }
  phases: PhaseView[]
  receipts: ReceiptView[]
  totals: {
    fee: number
    /** Sum of active phases. */
    phasesTotal: number
    /** All money received (receipts not reversed). */
    received: number
    /** Received and counted against phases. */
    allocated: number
    /** Received but not yet counted against any phase (advances). */
    onAccount: number
    /** Fee minus received; negative means the client has paid more than the fee. */
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
