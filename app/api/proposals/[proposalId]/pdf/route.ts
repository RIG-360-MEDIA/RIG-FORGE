import { type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { findProposal, proposalsGuard, settingsFor, toViews } from '@/lib/proposals'
import { renderProposalPdf } from '@/lib/proposal-pdf'
import { proposalFileName } from '@/lib/proposal-types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─── GET /api/proposals/[proposalId]/pdf ────────────────────────────────────

/**
 * The proposal as a PDF file, named like Trijya's own ("81 - Mr. K C Singhal -
 * Resort Proposal.pdf"). Sent as a download, so it saves on any computer or
 * phone without a print dialog. ?inline=1 opens it in the browser instead.
 */
export async function GET(request: NextRequest, { params }: { params: { proposalId: string } }) {
  try {
    const g = await proposalsGuard(request)
    if ('response' in g) return g.response
    const row = await findProposal(params.proposalId)
    if (!row) return errorResponse('Proposal not found', 404)
    const view = (await toViews([row]))[0]!
    const pdf = await renderProposalPdf(view, await settingsFor(view.content))
    const name = proposalFileName(view)
    const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'")
    const disposition = request.nextUrl.searchParams.get('inline') === '1' ? 'inline' : 'attachment'
    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Content-Length': String(pdf.length),
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    console.error('[GET /api/proposals/[proposalId]/pdf]', error)
    return errorResponse('Could not make the PDF. Please try again.', 500)
  }
}
