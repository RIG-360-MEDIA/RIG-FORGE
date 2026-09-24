import { type NextRequest, NextResponse } from 'next/server'

import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { isNasEnabled } from '@/lib/nas/client'
import { getOrgId } from '@/lib/tenant-context'
import { isBylawsIndexingEnabled } from '@/lib/rag/index-bylaws-file'
import { embedQuery } from '@/lib/rag/embeddings'
import { searchChunks, BYLAWS_COLLECTION } from '@/lib/rag/qdrant'

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
    const limit = typeof body?.limit === 'number' ? Math.min(Math.max(body.limit, 1), 20) : 8

    const vector = await embedQuery(query)
    const hits = await searchChunks(getOrgId(), vector, limit, BYLAWS_COLLECTION)

    return successResponse({
      query,
      matches: hits.map((h) => ({
        server: h.server, path: h.path, fileName: h.fileName,
        score: Math.round(h.score * 1000) / 1000, excerpt: h.text,
      })),
    })
  } catch (error) {
    console.error('[POST /api/nas/bylaws/search]', error)
    return errorResponse(error instanceof Error ? error.message : 'Server error', 500)
  }
}
