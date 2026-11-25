/**
 * A fee proposal as a real PDF file, made on the server with @react-pdf/renderer,
 * so "Download PDF" saves a file on any computer or phone (no print dialog).
 * The layout follows the on-screen preview (app/print/proposals/[proposalId]):
 * Trijya's letterhead cover letter, then the project brief, scope, fees and
 * terms, with a running header and footer from page 2.
 */
import path from 'node:path'
import type { ReactNode } from 'react'
import { Document, Font, G, Image, Page, Path, StyleSheet, Svg, Text, View, renderToBuffer } from '@react-pdf/renderer'

import {
  roman, rupeeFigure, rupeesInWords, shortRef, totalRate,
  type ProposalContent, type ProposalSettingsData, type ProposalView,
} from '@/lib/proposal-types'

// ─── Fonts ───────────────────────────────────────────────────────────────────

const FONT_DIR = path.join(process.cwd(), 'lib', 'fonts', 'poppins')
let fontsReady = false
function registerFonts() {
  if (fontsReady) return
  Font.register({
    family: 'Poppins',
    fonts: [
      { src: path.join(FONT_DIR, 'Poppins-Light.ttf'), fontWeight: 300 },
      { src: path.join(FONT_DIR, 'Poppins-Regular.ttf'), fontWeight: 400 },
      { src: path.join(FONT_DIR, 'Poppins-Italic.ttf'), fontWeight: 400, fontStyle: 'italic' },
      { src: path.join(FONT_DIR, 'Poppins-Medium.ttf'), fontWeight: 500 },
      { src: path.join(FONT_DIR, 'Poppins-SemiBold.ttf'), fontWeight: 600 },
      { src: path.join(FONT_DIR, 'Poppins-Bold.ttf'), fontWeight: 700 },
    ],
  })
  // Never split words with hyphens (legal text reads badly hyphenated).
  Font.registerHyphenationCallback((word) => [word])
  fontsReady = true
}

// ─── Helpers (same wording as the preview) ──────────────────────────────────

const RED = '#B3261E'
const GOLD = '#E0A93B'
const BEIGE = '#F4F1EA'
const DARK = '#2B2F33'
const MONTH_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
const monthsText = (n: number) => `${MONTH_WORDS[n] ?? n} (${n}) month${n === 1 ? '' : 's'}`
const longDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
const rs = (n: number) => `Rs. ${rupeeFigure(n)}/-`
/** Only PNG and JPEG logos can go into the PDF. */
const pdfImage = (dataUrl: string | null) => (dataUrl && /^data:image\/(png|jpeg);base64,/.test(dataUrl) ? dataUrl : null)

const s = StyleSheet.create({
  page: { fontFamily: 'Poppins', fontSize: 9.4, lineHeight: 1.55, color: '#222', paddingTop: '24mm', paddingBottom: '26mm', paddingHorizontal: '17mm' },
  cover: { fontFamily: 'Poppins', fontSize: 9.4, lineHeight: 1.55, color: '#222', paddingTop: '12mm', paddingBottom: '10mm', paddingHorizontal: '17mm', flexDirection: 'column' },
  p: { marginBottom: '2.4mm' },
  justify: { textAlign: 'justify' },
  b: { fontWeight: 600 },
  muted: { color: '#666' },
  firm: { textAlign: 'center', color: '#111', fontWeight: 400 },
  rule: { position: 'relative', height: 14, marginTop: '3mm' },
  ruleLine: { position: 'absolute', top: 7, width: '74.5mm', borderTopWidth: 0.7, borderTopColor: '#555' },
  refline: { flexDirection: 'row', justifyContent: 'space-between', marginTop: '16mm', paddingBottom: '2mm', borderBottomWidth: 0.6, borderBottomColor: '#ccc', fontSize: 9 },
  subject: { flexDirection: 'row', alignItems: 'center', backgroundColor: BEIGE, borderLeftWidth: '1.2mm', borderLeftColor: GOLD, paddingVertical: '3.5mm', paddingHorizontal: '5mm', marginVertical: '5mm' },
  subjectLabel: { color: RED, fontWeight: 600, fontSize: 7.5, width: '22mm', letterSpacing: 0.4 },
  subjectText: { flex: 1, fontWeight: 600, fontSize: 10, lineHeight: 1.45 },
  coverFoot: { marginTop: 'auto', alignItems: 'center', fontSize: 8.4 },
  logo: { width: '34mm', marginBottom: '5mm' },
  tagline: { letterSpacing: 0.3, paddingBottom: '1.5mm', borderBottomWidth: 0.7, borderBottomColor: '#555', alignSelf: 'stretch', textAlign: 'center' },
  header: { position: 'absolute', top: '12mm', left: '17mm', right: '17mm', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', paddingBottom: '3mm', borderBottomWidth: 0.6, borderBottomColor: '#ddd' },
  headerFirm: { fontSize: 9.5, letterSpacing: 3, color: '#222' },
  headerTitle: { fontSize: 7.5, fontWeight: 300, color: '#666', maxWidth: '95mm', textAlign: 'right' },
  footerLine: { position: 'absolute', top: '275mm', left: '17mm', right: '17mm', borderTopWidth: 0.6, borderTopColor: '#ddd' },
  footerText: { position: 'absolute', top: '278mm', fontSize: 6.4, fontWeight: 300, color: '#666', lineHeight: 1.45 },
  kicker: { color: RED, fontSize: 8, fontWeight: 500, letterSpacing: 0.3, marginBottom: '1mm' },
  h1: { fontSize: 16, fontWeight: 700, marginBottom: '3mm', paddingBottom: '2mm', borderBottomWidth: 1, borderBottomColor: GOLD, lineHeight: 1.3 },
  brief: { backgroundColor: BEIGE, marginBottom: '6mm' },
  briefRow: { flexDirection: 'row', borderBottomWidth: 0.6, borderBottomColor: '#e2ddd2', paddingVertical: '2.4mm', paddingHorizontal: '4mm' },
  briefKey: { width: '28%', color: '#666', fontSize: 8, letterSpacing: 0.3 },
  h2: { flexDirection: 'row', alignItems: 'center', marginTop: '5mm', marginBottom: '3mm', paddingBottom: '1.5mm', borderBottomWidth: 0.6, borderBottomColor: '#ccc' },
  badge: { width: '7mm', height: '7mm', backgroundColor: RED, color: '#fff', fontSize: 9, fontWeight: 600, textAlign: 'center', paddingTop: '1.2mm', marginRight: '3mm' },
  h2Text: { fontSize: 10, fontWeight: 700 },
  li: { flexDirection: 'row', marginLeft: '6mm', marginBottom: '2mm' },
  num: { color: RED, fontWeight: 500, width: '6mm' },
  liBody: { flex: 1 },
  rli: { flexDirection: 'row', marginLeft: '4mm', marginVertical: '0.8mm' },
  rnum: { color: '#777', width: '8mm', textAlign: 'right', marginRight: '2mm' },
  disc: { color: RED, fontWeight: 500, marginTop: '3mm', marginBottom: '1.5mm' },
  table: { marginTop: '3mm', marginBottom: '1mm', fontSize: 8.6 },
  th: { flexDirection: 'row', backgroundColor: DARK, color: '#fff', fontWeight: 600, fontSize: 7.8, paddingVertical: '2mm', paddingHorizontal: '3mm' },
  tr: { flexDirection: 'row', paddingVertical: '1.5mm', paddingHorizontal: '3mm', borderBottomWidth: 0.5, borderBottomColor: '#e6e6e6' },
  trGroup: { flexDirection: 'row', backgroundColor: BEIGE, color: RED, fontWeight: 700, fontSize: 7.8, paddingVertical: '1.5mm', paddingHorizontal: '3mm' },
  trSub: { flexDirection: 'row', fontWeight: 600, borderTopWidth: 0.8, borderTopColor: '#333', paddingVertical: '1.5mm', paddingHorizontal: '3mm' },
  trGrand: { flexDirection: 'row', backgroundColor: DARK, color: '#fff', fontWeight: 700, paddingVertical: '1.8mm', paddingHorizontal: '3mm' },
  cNo: { width: '10%' }, cName: { flex: 1 }, cRate: { width: '22%', textAlign: 'right' },
  words: { textAlign: 'right', fontStyle: 'italic', color: '#555', fontSize: 8.4 },
  bank: { backgroundColor: BEIGE, borderLeftWidth: '1mm', borderLeftColor: GOLD, marginVertical: '2mm', width: '92%', paddingVertical: '1mm', fontSize: 8.6 },
  bankRow: { flexDirection: 'row', paddingVertical: '0.8mm', paddingHorizontal: '4mm' },
  bankKey: { width: '30%', color: '#666' },
  fm: { borderLeftWidth: '0.8mm', borderLeftColor: '#ccc', paddingVertical: '1mm', paddingLeft: '4mm', color: '#555', fontSize: 8.2, textAlign: 'justify', marginVertical: '3mm' },
})

// ─── Building blocks ─────────────────────────────────────────────────────────

/** The small gold flourish between the two rules under the letterhead. */
function Flourish() {
  return (
    <Svg width={58} height={14} viewBox="0 0 58 14">
      <G fill="none" stroke={GOLD} strokeWidth={2.2} strokeLinecap="round">
        <Path d="M4 8c4-6 12-6 14-1 1 3-3 5-5 3" /><Path d="M10 11c4 2 10 1 13-3" />
        <Path d="M54 8c-4-6-12-6-14-1-1 3 3 5 5 3" /><Path d="M48 11c-4 2-10 1-13-3" />
      </G>
    </Svg>
  )
}

type Item = { node: ReactNode; block?: boolean; keep?: boolean }

/**
 * A lettered section. The heading is kept on the same page as what follows it
 * (its first paragraph, or the first item of a numbered list), so a heading is
 * never left alone at the bottom of a page.
 */
function Section({ letter, title, intro, items, children }: { letter: string; title: string; intro?: ReactNode; items?: Item[]; children?: ReactNode }) {
  const head = (
    <>
      <View style={s.h2}><Text style={s.badge}>{letter}</Text><Text style={s.h2Text}>{title}</Text></View>
      {intro}
    </>
  )
  if (items) return <Numbered items={items} head={head} />
  return <View><View wrap={false}>{head}</View>{children}</View>
}

/** A numbered list: each item is text, or a block (View) when it holds a table. `head` stays with the first item. */
function Numbered({ items, head }: { items: Item[]; head?: ReactNode }) {
  const row = (it: Item, i: number) => (
    // A text item never splits from its number; only a block holding a long table (the fee table) may run onto the next page.
    <View key={i} style={s.li} wrap={!!it.block && !it.keep}>
      <Text style={s.num}>{i + 1}.</Text>
      {it.block ? <View style={s.liBody}>{it.node}</View> : <Text style={[s.liBody, s.justify]}>{it.node}</Text>}
    </View>
  )
  return (
    <View>
      {head && items.length ? <View wrap={false}>{head}{row(items[0]!, 0)}</View> : head}
      {items.map((it, i) => (head && i === 0 ? null : row(it, i)))}
    </View>
  )
}

function Roman({ items, indent = 4 }: { items: ReactNode[]; indent?: number }) {
  return (
    <View>
      {items.map((it, i) => (
        <View key={i} style={[s.rli, { marginLeft: `${indent}mm` }]} wrap={false}>
          <Text style={s.rnum}>{roman(i + 1)}.</Text><Text style={{ flex: 1 }}>{it}</Text>
        </View>
      ))}
    </View>
  )
}

/** "Sanction ... are <b>included</b> ..." with the words included / excluded in bold. */
const boldInEx = (t: string) => t.split(/\b(included|excluded)\b/).map((part, i) => (part === 'included' || part === 'excluded' ? <Text key={i} style={s.b}>{part}</Text> : part))

// ─── The document ────────────────────────────────────────────────────────────

function ProposalDoc({ p, st }: { p: ProposalView; st: ProposalSettingsData }) {
  const c: ProposalContent = p.content
  const { firm, terms } = st
  const f = c.fees
  const total = totalRate(f.stages)
  const groups = [...new Set(f.stages.map((x) => x.group))]
  const runningTitle = `Proposal | ${c.projectType} at ${c.location.split(',')[0]} | ${c.client.name}`
  const contact = [firm.address, firm.email].filter(Boolean).join('  |  ')
  const letters = 'ABCDEFGHIJKLMNOP'.split('')
  let li = 0
  const next = () => letters[li++]!
  const nameSize = Math.max(11, Math.min(19, 400 / Math.max(firm.name.length, 1)))
  const logo = pdfImage(firm.logoDataUrl)

  const feeItems: { node: ReactNode; block?: boolean; keep?: boolean }[] = [
    { node: <>For the above scope of work, a design fee of <Text style={s.b}>{rs(total)} per sq ft</Text> (Rupees {rupeesInWords(total)}{Number.isInteger(total) ? '' : ` and ${Math.round((total % 1) * 100)} paise`} only per sq ft) shall be charged.</> },
  ]
  const area = Number((f.areaSqft || '').replace(/[,\s]/g, ''))
  if (area > 0) {
    const fee = Math.round(total * area)
    feeItems.push({ node: <>For the built-up area of about {rupeeFigure(area)} sq ft, the design fee comes to <Text style={s.b}>{rs(fee)}</Text> (Rupees {rupeesInWords(fee)} only); the final fee shall be as per the actual built-up area.</> })
  }
  if (f.landscapePerAcre) feeItems.push({ node: <>Landscape design fee shall be charged separately at <Text style={s.b}>{rs(f.landscapePerAcre)} per acre</Text> (Rupees {rupeesInWords(f.landscapePerAcre)} only per acre).</> })
  if (f.gstPercent > 0) feeItems.push({ node: <>The above fee excludes all taxes such as GST (@ {f.gstPercent}%), which shall be payable by the Client over and above the professional fee with each stage of payment.</> })
  if (f.sanctionNotes.length) {
    feeItems.push({ block: true, keep: true, node: <><Text>Sanction drawings are included in the scope of work, limited to preparation and submission to the Authority. Please note:</Text><Roman items={f.sanctionNotes.map(boldInEx)} /></> })
  }
  feeItems.push({
    block: true,
    node: (
      <>
        <Text>The fee shall be payable on achievement of the following milestones:</Text>
        <View style={s.table}>
          <View style={s.th}><Text style={s.cNo}>NO.</Text><Text style={s.cName}>PAYMENT STAGE</Text><Text style={s.cRate}>FEE (₹ / SQ FT)</Text></View>
          {groups.map((g) => {
            const rows = f.stages.filter((x) => x.group === g)
            return (
              <View key={g}>
                <View style={s.trGroup} wrap={false} minPresenceAhead={30}><Text>{g.toUpperCase()}</Text></View>
                {rows.map((r, i) => (
                  <View key={i} style={s.tr} wrap={false}><Text style={s.cNo}>{i + 1}</Text><Text style={s.cName}>{r.name}</Text><Text style={s.cRate}>{r.rate.toFixed(2)}</Text></View>
                ))}
                <View style={s.trSub} wrap={false}><Text style={s.cNo} /><Text style={[s.cName, { textAlign: 'right' }]}>Total – {g}</Text><Text style={s.cRate}>{totalRate(rows).toFixed(2)}</Text></View>
              </View>
            )
          })}
          <View style={s.trGrand} wrap={false}><Text style={s.cNo} /><Text style={[s.cName, { textAlign: 'right' }]}>OVERALL FEE TOTAL</Text><Text style={s.cRate}>₹ {total.toFixed(2)}</Text></View>
        </View>
        <Text style={s.words}>In words: Rupees {rupeesInWords(total)} only per sq ft{f.gstPercent > 0 ? ', exclusive of GST' : ''}.</Text>
      </>
    ),
  })
  if (firm.chequePayee) feeItems.push({ node: <>Cheques shall be issued in favour of <Text style={s.b}>&apos;{firm.chequePayee}&apos;</Text>.</> })
  if (firm.bank.accountNo) {
    const rows = ([['Account Name', firm.bank.accountName], ['Account No.', firm.bank.accountNo], ['Bank', firm.bank.bankName], ['IFSC Code', firm.bank.ifsc], ['PAN', firm.pan], ['GSTIN', firm.gstin]] as const).filter(([, v]) => v)
    feeItems.push({
      block: true, keep: true,
      node: <><Text>Banking details:</Text><View style={s.bank}>{rows.map(([k, v]) => <View key={k} style={s.bankRow}><Text style={s.bankKey}>{k}</Text><Text style={{ flex: 1 }}>{v}</Text></View>)}</View></>,
    })
  }
  feeItems.push({ node: <>This offer is valid for a period of {monthsText(f.offerValidMonths)} from the date of receipt.</> })
  if (terms.noDeductions) feeItems.push({ node: terms.noDeductions })
  if (f.exclusions.length) feeItems.push({ block: true, keep: true, node: <><Text style={s.b}>Exclusions from scope of work:</Text><Roman items={f.exclusions} /></> })
  if (f.siteVisitsIncluded) {
    feeItems.push({
      block: true, keep: true,
      node: <><Text style={s.b}>Site visits:</Text><Roman items={[
        `The fee includes a maximum of ${f.siteVisitsIncluded} site visits until completion of the project.`,
        ...(f.extraVisitRate ? [`Visits beyond this shall be charged at ${rs(f.extraVisitRate)} per visit.`] : []),
      ]} /></>,
    })
  }

  const reimbursables = [
    ...(f.outstationPerDay ? [`Any visit outside ${firm.homeState ? `the state of ${firm.homeState}` : 'the home state of the Architect'} necessary in connection with the execution of work and the performance of duties related to the project shall be charged at ${rs(f.outstationPerDay)} per day.`] : []),
    ...terms.reimbursables,
  ]

  const signature = (
    <View style={{ marginTop: '6mm' }} wrap={false}>
      <Text>Yours truly,</Text>
      <Text style={s.b}>For {firm.name.toUpperCase()}</Text>
      <Text style={[s.b, { marginTop: '9mm' }]}>{firm.signatoryName}</Text>
      <Text style={s.muted}>{firm.signatoryTitle}</Text>
    </View>
  )

  return (
    <Document title={`${p.serial} - ${c.client.name} - ${c.projectType} Proposal`} author={firm.name} subject={c.subject} creator="Forge">
      {/* Page 1: the cover letter on the letterhead */}
      <Page size="A4" style={s.cover}>
        <Text style={[s.firm, { fontSize: nameSize, letterSpacing: nameSize * 0.55 }]}>{firm.name.toUpperCase().split(' ').join('  ')}</Text>
        {/* Two rules with the flourish between them, placed exactly (flex rows misalign the drawing). */}
        <View style={s.rule}>
          <View style={[s.ruleLine, { left: 0 }]} />
          <View style={{ position: 'absolute', top: -4, left: '77.8mm' }}><Flourish /></View>
          <View style={[s.ruleLine, { right: 0 }]} />
        </View>
        <View style={s.refline}>
          <Text><Text style={s.b}>Ref. No.:</Text> {p.refNo}</Text>
          <Text><Text style={s.b}>Date:</Text> {longDate(c.date)}</Text>
        </View>
        <View style={{ marginTop: '5mm' }}>
          <Text>To,</Text>
          <Text style={s.b}>{c.client.name}</Text>
          {c.client.city ? <Text>{c.client.city}</Text> : null}
        </View>
        <View style={s.subject}><Text style={s.subjectLabel}>SUBJECT</Text><Text style={s.subjectText}>{c.subject}</Text></View>
        <Text style={s.p}>Dear {c.client.salutation},</Text>
        {c.intro.split(/\n\s*\n/).map((para, i) => <Text key={i} style={[s.p, s.justify]}>{para}</Text>)}
        {signature}
        <View style={s.coverFoot}>
          {logo ? <Image src={logo} style={s.logo} /> : null}
          {firm.tagline ? <Text style={s.tagline}>{firm.tagline}</Text> : null}
          <Text style={{ marginTop: '1.5mm', textAlign: 'center', lineHeight: 1.35 }}>
            {firm.address}{firm.email ? `\ne-mail : ${firm.email}` : ''}{firm.phone ? ` | ${firm.phone}` : ''}
          </Text>
        </View>
      </Page>

      {/* From page 2: brief, scope, fees and terms, with a running header and footer */}
      <Page size="A4" style={s.page}>
        <View style={s.header} fixed>
          <Text style={s.headerFirm}>{firm.name.toUpperCase()}</Text>
          <Text style={s.headerTitle}>{runningTitle}</Text>
        </View>
        {/* Footer: each piece pinned on its own (a fixed row of texts did not render). */}
        <View style={s.footerLine} fixed />
        <Text style={[s.footerText, { left: '17mm', width: '34mm' }]} fixed>Ref. {shortRef(p.refNo)}</Text>
        <Text style={[s.footerText, { left: '52mm', right: '38mm', textAlign: 'center' }]} fixed>{`This is a digitally generated document and does not require a signature.\n${contact}`}</Text>
        <Text style={[s.footerText, { right: '17mm', width: '20mm', textAlign: 'right' }]} fixed render={({ pageNumber }) => `Page ${pageNumber}`} />

        <Text style={s.kicker}>PROJECT BRIEF</Text>
        <Text style={s.h1}>{c.brief.title}</Text>
        <View style={s.brief} wrap={false}>
          <View style={s.briefRow}><Text style={s.briefKey}>PROJECT</Text><Text style={{ flex: 1 }}><Text style={s.b}>{c.projectType}</Text>{c.disciplines.length ? ` – ${c.brief.scopeSummary.slice(0, 2).join(' and ')}` : ''}</Text></View>
          <View style={s.briefRow}><Text style={s.briefKey}>LOCATION</Text><Text style={{ flex: 1 }}>{c.location}</Text></View>
          <View style={s.briefRow}><Text style={s.briefKey}>CLIENT</Text><Text style={{ flex: 1 }}>{c.client.name}</Text></View>
          <View style={[s.briefRow, { borderBottomWidth: 0 }]}><Text style={s.briefKey}>SCOPE</Text><View style={{ flex: 1 }}>{c.brief.scopeSummary.map((x, i) => <Text key={i}>{i + 1}.  {x}</Text>)}</View></View>
        </View>

        <Section letter={next()} title="SCOPE OF WORK" intro={<Text style={s.p}>We will provide the following services for the {c.projectType.toLowerCase()} project:</Text>}>
          {c.scope.map((sc, i) => (
            <View key={sc.discipline}>
              <Text style={s.disc} minPresenceAhead={30}>{i + 1}.  {sc.discipline}</Text>
              <Roman items={sc.items} indent={12} />
            </View>
          ))}
        </Section>

        <Section letter={next()} title="PROFESSIONAL FEES" items={feeItems} />

        <Section letter={next()} title="CLIENT'S ROLE AND RESPONSIBILITIES" items={terms.clientRoles.map((t) => ({ node: t }))}
          intro={<Text style={s.p}>The Client shall discharge all obligations connected with the project and the engagement of the Architect as follows:</Text>} />

        <Section letter={next()} title="TERM OF ENGAGEMENT" intro={<Text style={[s.p, s.b]}>{c.fees.engagementMonths} months from the date of appointment.</Text>}>
          <Text style={[s.p, s.justify]}>If the project duration extends beyond the above period due to force majeure conditions (as defined below) or for reasons not attributable to us, additional fees shall be payable by the Client on mutually acceptable terms.</Text>
          <Text style={s.fm}><Text style={s.b}>Force Majeure </Text>{terms.forceMajeure.replace(/^Force Majeure\s*/i, '')}</Text>
        </Section>

        {reimbursables.length > 0 ? <Section letter={next()} title="REIMBURSABLE EXPENSES" items={reimbursables.map((t) => ({ node: t }))} /> : null}
        <Section letter={next()} title="INDEMNIFICATION" intro={<Text style={s.justify}>{terms.indemnification}</Text>} />
        <Section letter={next()} title="OWNERSHIP OF COPYRIGHT" intro={<Text style={s.justify}>{terms.copyright}</Text>} />
        <Section letter={next()} title="INTERPRETATION" intro={<Text style={s.justify}>{terms.interpretation}</Text>} />
        <Section letter={next()} title="ARBITRATION" intro={<Text style={s.justify}>{terms.arbitration}</Text>} />

        <View style={{ marginTop: '6mm' }} wrap={false}>
          <Text style={s.justify}>{c.closing}</Text>
          {signature}
        </View>
      </Page>
    </Document>
  )
}

/** The proposal as PDF bytes. */
export async function renderProposalPdf(p: ProposalView, settings: ProposalSettingsData): Promise<Buffer> {
  registerFonts()
  return renderToBuffer(<ProposalDoc p={p} st={settings} />)
}
