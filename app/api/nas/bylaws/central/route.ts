import { type NextRequest, NextResponse } from 'next/server'

import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { isNasEnabled } from '@/lib/nas/client'
import { isBylawsIndexingEnabled } from '@/lib/rag/index-bylaws-file'
import { centralDocuments } from '@/lib/rag/answer'

export const runtime = 'nodejs'

// GET /api/nas/bylaws/central — the documents the Central tab searches (the
// central codes: NBC, MBBL, the BIS master, ...; lib/rag/regions.ts
// isCentralDocument), so the tab can show exactly what it covers.
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    if (!verifyToken(token)) return errorResponse('Invalid or expired session', 401)
    if (!isNasEnabled()) return errorResponse('Bylaws search is not available', 403)
    if (!isBylawsIndexingEnabled()) return errorResponse('Bylaws search is not configured for this deployment', 503)
    const documents = (await centralDocuments()).map((path) => ({ path, fileName: path.split('/').pop() ?? path }))
    return successResponse({ documents })
  } catch (error) {
    console.error('[GET /api/nas/bylaws/central]', error)
    return errorResponse('Could not list the central documents. Please try again.', 500)
  }
}
