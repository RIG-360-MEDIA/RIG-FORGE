import { type NextRequest, NextResponse } from 'next/server'

import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { successResponse, errorResponse } from '@/lib/api-helpers'
import { isNasEnabled } from '@/lib/nas/client'
import { isBylawsIndexingEnabled } from '@/lib/rag/index-bylaws-file'
import { bylawsStates, bylawsStatesWithOwnDocuments } from '@/lib/rag/answer'

export const runtime = 'nodejs'

// GET /api/nas/bylaws/states — the states that have bylaws documents in the
// index (from their folders under By_Laws, lib/rag/regions.ts), for the
// Bylaws tab's State dropdown.
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const token = getTokenFromCookies(request)
    if (!token) return errorResponse('Authentication required', 401)
    if (!verifyToken(token)) return errorResponse('Invalid or expired session', 401)
    if (!isNasEnabled()) return errorResponse('Bylaws search is not available', 403)
    if (!isBylawsIndexingEnabled()) return errorResponse('Bylaws search is not configured for this deployment', 503)
    // withBylaws: the states with bylaws of their own, not only a BIS model
    // copy. Only these are answered from documents when chosen.
    const [states, withBylaws] = await Promise.all([bylawsStates(), bylawsStatesWithOwnDocuments()])
    return successResponse({ states, withBylaws })
  } catch (error) {
    console.error('[GET /api/nas/bylaws/states]', error)
    return errorResponse('Could not list the states. Please try again.', 500)
  }
}
