import { type NextRequest, NextResponse } from 'next/server'

import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { isNasEnabled } from '@/lib/nas/client'
import { getOrgId } from '@/lib/tenant-context'
import { isBylawsIndexingEnabled } from '@/lib/rag/index-bylaws-file'
import { embedQuery } from '@/lib/rag/embeddings'
import { searchChunksHybrid, BYLAWS_COLLECTION } from '@/lib/rag/qdrant'

export const runtime = 'nodejs'

// POST /api/nas/bylaws/search — any authenticated user on the bylaws-owning
// org. Direct semantic search over the bylaws index, independent of the
// Forgie chatbot/LLM (works even when ASSISTANT_ENABLED=false) — same
// underlying pipeline the bylaws_search assistant tool uses.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    if (!verifyToken(token)) return errorResponse('Invalid or expired session', 401)
    if (!isNasEnabled()) return errorResponse('Bylaws search is not available', 403)
    if (!isBylawsIndexingEnabled()) return errorResponse('Bylaws search is not configured for this deployment', 503)

    const body = await request.json().catch(() => null)
    const query = typeof body?.query === 'string' ? body.query.trim() : ''
    if (!query) return errorResponse('query is required', 400)
    if (query.length > 1000) return errorResponse('query must not exceed 1000 characters', 400)
    // Number.isFinite rejects NaN/Infinity (typeof NaN === 'number', so the old
    // check let NaN straight through to Qdrant), and Math.floor stops a
    // fractional limit such as 2.7 being sent as-is.
    const limit = typeof body?.limit === 'number' && Number.isFinite(body.limit)
      ? Math.min(Math.max(Math.floor(body.limit), 1), 20)
      : 8

    const vector = await embedQuery(query)
    const hits = await searchChunksHybrid(getOrgId(), vector, query, limit, BYLAWS_COLLECTION)

    return successResponse({
      query,
      matches: hits.map((h) => ({
        server: h.server, path: h.path, fileName: h.fileName,
        score: Math.round(h.score * 1000) / 1000, matchType: h.matchType, excerpt: h.text,
      })),
    })
  } catch (error) {
    // Log the detail server-side only. The raw message used to be returned to
    // the browser, and Qdrant/HF errors can include the internal service URL.
    console.error('[POST /api/nas/bylaws/search]', error)
    return errorResponse('Bylaws search failed. Please try again.', 500)
  }
}
