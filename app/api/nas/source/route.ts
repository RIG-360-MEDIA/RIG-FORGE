import { type NextRequest, NextResponse } from 'next/server'

import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { isNasEnabled, nasLocate } from '@/lib/nas/client'
import { getOrgId } from '@/lib/tenant-context'
import { isRagIndexingEnabled } from '@/lib/rag/index-nas-file'
import { BYLAWS_COLLECTION, COLLECTION, getPassage } from '@/lib/rag/qdrant'
import { downloadUrl } from '@/lib/rag/answer'
import { quotePhrases } from '@/lib/rag/highlight'

export const runtime = 'nodejs'

/** Snippets of the passage the connector looks for on each PDF page. */
const MAX_ANCHORS = 8
const ANCHOR_CHARS = 80

/**
 * Exact snippets to find the passage's page by: the key lines first (they
 * are what the user wants to see), then lines spread across the passage, so
 * a passage that runs over a page break is still placed on the page holding
 * most of it.
 */
function anchorsFor(passage: string, keyLines: string): string[] {
  const lines = passage.split('\n').map((l) => l.trim()).filter((l) => l.length >= 25)
  const step = Math.max(1, Math.floor(lines.length / 5))
  const spread = lines.filter((_, i) => i % step === 0)
  const all = [...quotePhrases(keyLines), ...spread].map((a) => a.slice(0, ANCHOR_CHARS).trim()).filter((a) => a.length >= 12)
  return [...new Set(all)].slice(0, MAX_ANCHORS)
}

// GET /api/nas/source?c=bylaws|nas&s=<server>&p=<path>&i=<chunkIndex>&k=<key lines>
// — the source view behind a chat answer's "Show passage and page" link: the
// passage the answer was taken from (looked up by its position, org-scoped),
// and the PDF page it is on, found by the connector's /locate. Page fields are
// null when the page cannot be found (scanned page, not a PDF, connector down).
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    if (!verifyToken(token)) return errorResponse('Invalid or expired session', 401)
    if (!isNasEnabled()) return errorResponse('NAS is not available', 403)
    if (!isRagIndexingEnabled()) return errorResponse('Content search is not configured for this deployment', 503)

    const q = new URL(request.url).searchParams
    const collection = q.get('c') === 'bylaws' ? BYLAWS_COLLECTION : q.get('c') === 'nas' ? COLLECTION : null
    const server = q.get('s')?.trim() ?? ''
    const path = q.get('p')?.trim() ?? ''
    const chunkIndex = Number(q.get('i'))
    const keyLines = (q.get('k') ?? '').slice(0, 1000)
    if (!collection || !server || !path || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
      return errorResponse('c, s, p and i are required', 400)
    }

    const passage = await getPassage(getOrgId(), server, path, chunkIndex, collection)
    if (!passage) return errorResponse('This passage is no longer in the index. The document may have been re-indexed or removed.', 404)

    const located = /\.pdf$/i.test(path) ? await nasLocate(server, path, anchorsFor(passage.text, keyLines)) : null
    const page = located?.page ?? null
    const pdfUrl = downloadUrl({ server, path })
    return successResponse({
      server,
      path,
      fileName: passage.fileName,
      chunkIndex,
      keyLines,
      passage: passage.text,
      page,
      pageCount: located?.pageCount ?? null,
      pageText: page ? located?.pageText ?? null : null,
      pageReason: page ? null
        : !/\.pdf$/i.test(path) ? 'Pages exist only for PDFs.'
        : located?.reason ?? 'The file server could not be reached to find the page.',
      pdfUrl: page ? `${pdfUrl}#page=${page}` : pdfUrl,
    })
  } catch (error) {
    // Detail server-side only: Qdrant/connector errors can include internal URLs.
    console.error('[GET /api/nas/source]', error)
    return errorResponse('Could not load this source. Please try again.', 500)
  }
}
