'use client'

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Poppins } from 'next/font/google'

import type { ApiResponse } from '@/lib/types'
import {
  roman, rupeeFigure, rupeesInWords, shortRef, totalRate,
  type ProposalContent, type ProposalSettingsData, type ProposalView,
} from '@/lib/proposal-types'

// A proposal as a printable A4 document in the firm's letterhead style
// (modelled on Trijya Design Studio's 2026 proposals). "Download PDF" opens
// the browser's print dialog; choose "Save as PDF". The saved file is named
// like their own: "81 - Mr. K C Singhal - Resort Proposal".

const poppins = Poppins({ subsets: ['latin'], weight: ['300', '400', '500', '600', '700'], display: 'swap' })

type Payload = { proposal: ProposalView; settings: ProposalSettingsData; projectName: string }

const RED = '#B3261E'
const GOLD = '#E0A93B'

const MONTH_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
const monthsText = (n: number) => `${MONTH_WORDS[n] ?? n} (${n}) month${n === 1 ? '' : 's'}`
const longDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
const rs = (n: number) => `Rs. ${rupeeFigure(n)}/-`
const spaced = (s: string) => s.toUpperCase().split(' ').map((w) => w.split('').join(' ')).join('  ')
/** A JS string as a CSS string: "<" escaped, and line breaks as CSS "\A" (shown with white-space: pre). */
const cssString = (s: string) => JSON.stringify(s).replace(/</g, '\\3C ').replace(/\\n/g, '\\A ')

/** Letter-spaced firm name sized to fit the page width on one line, like the printed letterhead. */
function firmStyle(name: string): CSSProperties {
  const size = Math.max(11, Math.min(19, 400 / Math.max(name.length, 1)))
  return { fontSize: `${size}pt`, letterSpacing: `${size * 0.55}pt`, wordSpacing: `${size * 1.4}pt` }
}

/** The small gold flourish between the two rules under the letterhead. */
function Flourish() {
  return (
    <svg width="58" height="14" viewBox="0 0 58 14" aria-hidden="true">
      <g fill="none" stroke={GOLD} strokeWidth="2.2" strokeLinecap="round">
        <path d="M4 8c4-6 12-6 14-1 1 3-3 5-5 3" /><path d="M10 11c4 2 10 1 13-3" />
        <path d="M54 8c-4-6-12-6-14-1-1 3 3 5 5 3" /><path d="M48 11c-4 2-10 1-13-3" />
      </g>
    </svg>
  )
}

function Section({ letter, title, children }: { letter: string; title: string; children: ReactNode }) {
  return (
    <section className="pp-section">
      <h2 className="pp-h2"><span className="pp-badge">{letter}</span>{title}</h2>
      {children}
    </section>
  )
}

function Numbered({ items, start = 1 }: { items: ReactNode[]; start?: number }) {
  return (
    <ol className="pp-ol">
      {items.map((it, i) => <li key={i}><span className="pp-num">{start + i}.</span><div>{it}</div></li>)}
    </ol>
  )
}

function Roman({ items }: { items: ReactNode[] }) {
  return (
    <ol className="pp-roman">
      {items.map((it, i) => <li key={i}><span className="pp-rnum">{roman(i + 1)}.</span><div>{it}</div></li>)}
    </ol>
  )
}

function Document({ p, s }: { p: ProposalView; s: ProposalSettingsData }) {
  const c: ProposalContent = p.content
  const { firm, terms } = s
  const f = c.fees
  const total = totalRate(f.stages)
  const groups = [...new Set(f.stages.map((x) => x.group))]
  const runningTitle = `Proposal | ${c.projectType} at ${c.location.split(',')[0]} | ${c.client.name}`
  const footerRef = `Ref. ${shortRef(p.refNo)}`
  const contact = [firm.address, firm.email].filter(Boolean).join('  |  ')
  const letters = 'ABCDEFGHIJKLMNOP'.split('')
  let li = 0
  const next = () => letters[li++]!

  const feeItems: ReactNode[] = [
    <>For the above scope of work, a design fee of <b>{rs(total)} per sq ft</b> (Rupees {rupeesInWords(total)}{Number.isInteger(total) ? '' : ` and ${Math.round((total % 1) * 100)} paise`} only per sq ft) shall be charged.</>,
  ]
  const area = Number((f.areaSqft || '').replace(/[,\s]/g, ''))
  if (area > 0) {
    const fee = Math.round(total * area)
    feeItems.push(<>For the built-up area of about {rupeeFigure(area)} sq ft, the design fee comes to <b>{rs(fee)}</b> (Rupees {rupeesInWords(fee)} only); the final fee shall be as per the actual built-up area.</>)
  }
  if (f.landscapePerAcre) feeItems.push(<>Landscape design fee shall be charged separately at <b>{rs(f.landscapePerAcre)} per acre</b> (Rupees {rupeesInWords(f.landscapePerAcre)} only per acre).</>)
  if (f.gstPercent > 0) feeItems.push(<>The above fee excludes all taxes such as GST (@ {f.gstPercent}%), which shall be payable by the Client over and above the professional fee with each stage of payment.</>)
  if (f.sanctionNotes.length) feeItems.push(<>Sanction drawings are included in the scope of work, limited to preparation and submission to the Authority. Please note:<Roman items={f.sanctionNotes.map((n) => n.replace(/\b(included|excluded)\b/, '<<$1>>').split(/<<|>>/).map((part, i) => (part === 'included' || part === 'excluded' ? <b key={i}>{part}</b> : part)))} /></>)
  feeItems.push(
    <>
      The fee shall be payable on achievement of the following milestones:
      <table className="pp-fee">
        <thead><tr><th style={{ width: '10%' }}>NO.</th><th>PAYMENT STAGE</th><th style={{ width: '20%', textAlign: 'right' }}>FEE (₹ / SQ FT)</th></tr></thead>
        <tbody>
          {groups.map((g) => {
            const rows = f.stages.filter((x) => x.group === g)
            return [
              <tr key={`${g}-h`} className="pp-group"><td colSpan={3}>{g.toUpperCase()}</td></tr>,
              ...rows.map((r, i) => <tr key={`${g}-${i}`}><td>{i + 1}</td><td>{r.name}</td><td className="pp-r">{r.rate.toFixed(2)}</td></tr>),
              <tr key={`${g}-t`} className="pp-sub"><td /><td className="pp-r">Total – {g}</td><td className="pp-r">{totalRate(rows).toFixed(2)}</td></tr>,
            ]
          })}
          <tr className="pp-grand"><td /><td className="pp-r">OVERALL FEE TOTAL</td><td className="pp-r">₹ {total.toFixed(2)}</td></tr>
        </tbody>
      </table>
      <p className="pp-words">In words: Rupees {rupeesInWords(total)} only per sq ft{f.gstPercent > 0 ? ', exclusive of GST' : ''}.</p>
    </>,
  )
  if (firm.chequePayee) feeItems.push(<>Cheques shall be issued in favour of <b>&apos;{firm.chequePayee}&apos;</b>.</>)
  if (firm.bank.accountNo) {
    feeItems.push(
      <>
        Banking details:
        <table className="pp-bank"><tbody>
          {([['Account Name', firm.bank.accountName], ['Account No.', firm.bank.accountNo], ['Bank', firm.bank.bankName], ['IFSC Code', firm.bank.ifsc], ['PAN', firm.pan], ['GSTIN', firm.gstin]] as const)
            .filter(([, v]) => v).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}
        </tbody></table>
      </>,
    )
  }
  feeItems.push(<>This offer is valid for a period of {monthsText(f.offerValidMonths)} from the date of receipt.</>)
  if (terms.noDeductions) feeItems.push(<>{terms.noDeductions}</>)
  if (f.exclusions.length) feeItems.push(<><b>Exclusions from scope of work:</b><Roman items={f.exclusions} /></>)
  if (f.siteVisitsIncluded) {
    feeItems.push(<><b>Site visits:</b><Roman items={[
      `The fee includes a maximum of ${f.siteVisitsIncluded} site visits until completion of the project.`,
      ...(f.extraVisitRate ? [`Visits beyond this shall be charged at ${rs(f.extraVisitRate)} per visit.`] : []),
    ]} /></>)
  }

  const reimbursables = [
    ...(f.outstationPerDay ? [`Any visit outside ${firm.homeState ? `the state of ${firm.homeState}` : 'the home state of the Architect'} necessary in connection with the execution of work and the performance of duties related to the project shall be charged at ${rs(f.outstationPerDay)} per day.`] : []),
    ...terms.reimbursables,
  ]

  const signature = (
    <div className="pp-sign">
      <p>Yours truly,</p>
      <p><b>For {firm.name.toUpperCase() || 'THE ARCHITECT'}</b></p>
      <p className="pp-signname"><b>{firm.signatoryName}</b></p>
      <p className="pp-muted">{firm.signatoryTitle}</p>
    </div>
  )

  return (
    <>
      <style>{`
        @page { size: A4; margin: 24mm 17mm 25mm 17mm;
          @top-left { content: ${cssString((firm.name || ' ').toUpperCase())}; font: 400 9.5pt ${poppins.style.fontFamily}; letter-spacing: 0.32em; color: #222; width: 95mm; vertical-align: bottom; padding-bottom: 3mm; border-bottom: 0.6pt solid #ddd; }
          @top-right { content: ${cssString(runningTitle)}; font: 300 7.5pt ${poppins.style.fontFamily}; color: #666; text-align: right; vertical-align: bottom; padding-bottom: 3mm; border-bottom: 0.6pt solid #ddd; }
          @bottom-left { content: ${cssString(footerRef)}; font: 300 6.5pt ${poppins.style.fontFamily}; color: #666; width: 34mm; white-space: nowrap; vertical-align: top; padding-top: 3mm; border-top: 0.6pt solid #ddd; }
          @bottom-center { content: ${cssString(`This is a digitally generated document and does not require a signature.
${contact}`)}; white-space: pre; font: 300 6.3pt ${poppins.style.fontFamily}; color: #666; text-align: center; vertical-align: top; padding-top: 3mm; border-top: 0.6pt solid #ddd; }
          @bottom-right { content: "Page " counter(page); font: 300 6.5pt ${poppins.style.fontFamily}; color: #666; width: 20mm; text-align: right; vertical-align: top; padding-top: 3mm; border-top: 0.6pt solid #ddd; }
        }
        @page :first { margin: 12mm 17mm 10mm 17mm;
          @top-left { content: none; border: 0; } @top-right { content: none; border: 0; }
          @bottom-left { content: none; border: 0; } @bottom-center { content: none; border: 0; } @bottom-right { content: none; border: 0; }
        }
        * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
        body { background: #e9e7e3; margin: 0; }
        .pp-doc { font-family: ${poppins.style.fontFamily}; color: #222; font-size: 9.6pt; line-height: 1.55; background: #fff; width: 210mm; margin: 0 auto; padding: 14mm 17mm; }
        .pp-doc p { margin: 0 0 2.4mm; }
        .pp-cover { min-height: 268mm; display: flex; flex-direction: column; }
        .pp-letterhead { text-align: center; }
        .pp-firm { font-weight: 400; color: #111; white-space: nowrap; text-transform: uppercase; }
        .pp-rule { display: flex; align-items: center; gap: 3mm; margin: 2mm 0 0; }
        .pp-rule::before, .pp-rule::after { content: ''; flex: 1; border-top: 0.7pt solid #555; }
        .pp-rule svg { display: block; }
        .pp-refline { display: flex; justify-content: space-between; margin-top: 16mm; padding-bottom: 2mm; border-bottom: 0.6pt solid #ccc; font-size: 9pt; }
        .pp-to { margin-top: 5mm; }
        .pp-subject { display: flex; gap: 8mm; align-items: center; background: #F4F1EA; border-left: 1.2mm solid ${GOLD}; padding: 3.5mm 5mm; margin: 5mm 0; }
        .pp-subject small { color: ${RED}; font-weight: 600; font-size: 7.5pt; letter-spacing: 0.05em; }
        .pp-subject b { font-size: 10pt; line-height: 1.45; }
        .pp-body p { text-align: justify; }
        .pp-sign { margin-top: 6mm; } .pp-sign p { margin: 0; } .pp-signname { margin-top: 9mm !important; }
        .pp-muted { color: #666; }
        .pp-coverfoot { margin-top: auto; text-align: center; font-size: 8.5pt; }
        .pp-coverfoot img { width: 34mm; height: auto; display: block; margin: 0 auto 5mm; }
        .pp-tagline { letter-spacing: 0.03em; padding-bottom: 1.5mm; border-bottom: 0.7pt solid #555; }
        .pp-addr { margin-top: 1.5mm; line-height: 1.35; }
        .pp-break { break-before: page; }
        .pp-kicker { color: ${RED}; font-size: 8pt; font-weight: 500; letter-spacing: 0.04em; margin: 0 0 1mm !important; }
        .pp-h1 { font-size: 16pt; font-weight: 700; margin: 0 0 3mm; padding-bottom: 2mm; border-bottom: 1pt solid ${GOLD}; }
        .pp-brief { width: 100%; border-collapse: collapse; background: #F4F1EA; margin-bottom: 6mm; }
        .pp-brief td { padding: 2.4mm 4mm; border-bottom: 0.6pt solid #e2ddd2; vertical-align: top; }
        .pp-brief td:first-child { width: 28%; color: #666; font-size: 8pt; letter-spacing: 0.04em; }
        .pp-section { margin: 5mm 0 2mm; }
        .pp-h2 { display: flex; align-items: center; gap: 3mm; font-size: 10pt; font-weight: 700; margin: 0 0 3mm; padding-bottom: 1.5mm; border-bottom: 0.6pt solid #ccc; break-after: avoid; }
        .pp-badge { display: inline-flex; align-items: center; justify-content: center; width: 7mm; height: 7mm; background: ${RED}; color: #fff; font-size: 9pt; }
        .pp-disc { color: ${RED}; font-weight: 500; margin: 3mm 0 1.5mm !important; }
        .pp-ol, .pp-roman { list-style: none; margin: 0 0 2mm; padding: 0; }
        .pp-ol > li { display: flex; gap: 2.5mm; margin: 0 0 2mm 6mm; text-align: justify; }
        .pp-ol > li:has(.pp-bank), .pp-ol > li:has(.pp-roman) { break-inside: avoid; }
        .pp-num { color: ${RED}; font-weight: 500; min-width: 5mm; }
        .pp-ol > li > div { flex: 1; }
        .pp-roman > li { display: flex; gap: 2mm; margin: 1mm 0 1mm 4mm; }
        .pp-rnum { color: #777; min-width: 7mm; text-align: right; }
        .pp-roman.pp-scope > li { margin-left: 12mm; }
        .pp-fee { width: 100%; border-collapse: collapse; margin: 3mm 0 1mm; font-size: 8.8pt; break-inside: auto; }
        .pp-fee tr { break-inside: avoid; }
        .pp-fee th { background: #2B2F33; color: #fff; text-align: left; font-weight: 600; padding: 2mm 3mm; font-size: 8pt; }
        .pp-fee td { padding: 1.6mm 3mm; border-bottom: 0.5pt solid #e6e6e6; }
        .pp-fee .pp-group td { background: #F4F1EA; color: ${RED}; font-weight: 700; font-size: 8pt; }
        .pp-fee .pp-sub td { font-weight: 600; border-top: 0.8pt solid #333; border-bottom: 0; }
        .pp-fee .pp-grand td { background: #2B2F33; color: #fff; font-weight: 700; }
        .pp-r { text-align: right; }
        .pp-words { text-align: right; font-style: italic; color: #555; font-size: 8.5pt; }
        .pp-bank { border-collapse: collapse; background: #F4F1EA; border-left: 1mm solid ${GOLD}; margin: 2mm 0; width: 92%; font-size: 8.8pt; }
        .pp-bank td { padding: 1.2mm 4mm; } .pp-bank td:first-child { color: #666; width: 30%; }
        .pp-fm { border-left: 0.8mm solid #ccc; padding: 1mm 0 1mm 4mm; color: #555; font-size: 8.4pt; text-align: justify; margin: 3mm 0; }
        .pp-end { margin-top: 6mm; }
        .pp-toolbar { position: sticky; top: 0; z-index: 10; display: flex; gap: 12px; align-items: center; justify-content: center; padding: 10px; background: #222; color: #eee; font: 13px system-ui, sans-serif; }
        .pp-toolbar button { background: #EA580C; color: #fff; border: 0; padding: 8px 16px; border-radius: 6px; font-weight: 600; cursor: pointer; }
        .pp-words { break-before: avoid; }
        @media print {
          html, body { background: #fff !important; }
          .pp-shell { background: #fff !important; }
          .pp-toolbar { display: none; }
          .pp-doc { width: auto; margin: 0; padding: 0; }
          .pp-cover { min-height: 274mm; }
        }
      `}</style>

      <div className="pp-doc">
        {/* Page 1: cover letter */}
        <div className="pp-cover">
          <div className="pp-letterhead">
            <div className="pp-firm" style={firmStyle(firm.name || 'Firm name')}>{firm.name || 'Firm name'}</div>
            <div className="pp-rule"><Flourish /></div>
          </div>
          <div className="pp-refline"><span><b>Ref. No.:</b> {p.refNo}</span><span><b>Date:</b> {longDate(c.date)}</span></div>
          <div className="pp-to">
            <p style={{ margin: 0 }}>To,</p>
            <p style={{ margin: 0 }}><b>{c.client.name}</b></p>
            {c.client.city && <p>{c.client.city}</p>}
          </div>
          <div className="pp-subject"><small>SUBJECT</small><b>{c.subject}</b></div>
          <div className="pp-body">
            <p>Dear {c.client.salutation},</p>
            {c.intro.split(/\n\s*\n/).map((para, i) => <p key={i}>{para}</p>)}
          </div>
          {signature}
          <div className="pp-coverfoot">
            {firm.logoDataUrl && <img src={firm.logoDataUrl} alt="" />}
            {firm.tagline && <div className="pp-tagline">{firm.tagline}</div>}
            <div className="pp-addr">{firm.address}{firm.email && <><br />e-mail : {firm.email}</>}{firm.phone && <> | {firm.phone}</>}</div>
          </div>
        </div>

        {/* Project brief and scope */}
        <div className="pp-break">
          <p className="pp-kicker">PROJECT BRIEF</p>
          <h1 className="pp-h1">{c.brief.title}</h1>
          <table className="pp-brief"><tbody>
            <tr><td>PROJECT</td><td><b>{c.projectType}</b>{c.disciplines.length ? ` – ${c.brief.scopeSummary.slice(0, 2).join(' and ')}` : ''}</td></tr>
            <tr><td>LOCATION</td><td>{c.location}</td></tr>
            <tr><td>CLIENT</td><td>{c.client.name}</td></tr>
            <tr><td>SCOPE</td><td>{c.brief.scopeSummary.map((x, i) => <div key={i}>{i + 1}.&nbsp; {x}</div>)}</td></tr>
          </tbody></table>

          <Section letter={next()} title="SCOPE OF WORK">
            <p>We will provide the following services for the {c.projectType.toLowerCase()} project:</p>
            {c.scope.map((s, i) => (
              <div key={s.discipline}>
                <p className="pp-disc">{i + 1}.&nbsp; {s.discipline}</p>
                <ol className="pp-roman pp-scope">{s.items.map((it, j) => <li key={j}><span className="pp-rnum">{roman(j + 1)}.</span><div>{it}</div></li>)}</ol>
              </div>
            ))}
          </Section>

          <Section letter={next()} title="PROFESSIONAL FEES"><Numbered items={feeItems} /></Section>

          <Section letter={next()} title="CLIENT'S ROLE AND RESPONSIBILITIES">
            <p>The Client shall discharge all obligations connected with the project and the engagement of the Architect as follows:</p>
            <Numbered items={terms.clientRoles} />
          </Section>

          <Section letter={next()} title="TERM OF ENGAGEMENT">
            <p><b>{c.fees.engagementMonths} months from the date of appointment.</b></p>
            <p>If the project duration extends beyond the above period due to force majeure conditions (as defined below) or for reasons not attributable to us, additional fees shall be payable by the Client on mutually acceptable terms.</p>
            <div className="pp-fm"><b>Force Majeure</b> {terms.forceMajeure.replace(/^Force Majeure\s*/i, '')}</div>
          </Section>

          {reimbursables.length > 0 && <Section letter={next()} title="REIMBURSABLE EXPENSES"><Numbered items={reimbursables} /></Section>}
          <Section letter={next()} title="INDEMNIFICATION"><p style={{ textAlign: 'justify' }}>{terms.indemnification}</p></Section>
          <Section letter={next()} title="OWNERSHIP OF COPYRIGHT"><p style={{ textAlign: 'justify' }}>{terms.copyright}</p></Section>
          <Section letter={next()} title="INTERPRETATION"><p style={{ textAlign: 'justify' }}>{terms.interpretation}</p></Section>
          <Section letter={next()} title="ARBITRATION"><p style={{ textAlign: 'justify' }}>{terms.arbitration}</p></Section>

          <div className="pp-end">
            <p style={{ textAlign: 'justify' }}>{c.closing}</p>
            {signature}
          </div>
        </div>
      </div>
    </>
  )
}

export default function ProposalPrintPage({ params }: { params: { projectId: string; proposalId: string } }) {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${params.projectId}/proposals/${params.proposalId}`, { credentials: 'include' })
        const json = await res.json() as ApiResponse<Payload>
        if (!res.ok || !json.data) { setError(json.error ?? 'Could not load the proposal. Are you signed in as an admin?'); return }
        setData(json.data)
        const c = json.data.proposal.content
        // The PDF's default file name, in Trijya's own style.
        document.title = `${json.data.proposal.serial} - ${c.client.name} - ${c.projectType} Proposal`
      } catch {
        setError('Network error. Please try again.')
      }
    })()
  }, [params.projectId, params.proposalId])

  if (error) return <p style={{ padding: 40, fontFamily: 'system-ui' }}>{error}</p>
  if (!data) return <p style={{ padding: 40, fontFamily: 'system-ui' }}>Loading proposal...</p>
  return (
    <div className={`${poppins.className} pp-shell`} style={{ background: "#e9e7e3", minHeight: "100vh" }}>
      <div className="pp-toolbar">
        <span>{data.proposal.refNo}</span>
        <button type="button" onClick={() => window.print()}>Download PDF</button>
        <span>In the print window choose &quot;Save as PDF&quot;, paper A4.</span>
      </div>
      <Document p={data.proposal} s={data.settings} />
    </div>
  )
}
