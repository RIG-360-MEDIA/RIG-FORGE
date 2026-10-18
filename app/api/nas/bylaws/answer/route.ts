import { type NextRequest } from 'next/server'

import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { errorResponse } from '@/lib/api-helpers'
import { isNasEnabled } from '@/lib/nas/client'
import { getOrgId } from '@/lib/tenant-context'
import { getOrgIdentity } from '@/lib/org-branding'
import { isAssistantEnabled } from '@/lib/llm/provider'
import { streamPlainAnswer } from '@/lib/llm/stream'
import { isBylawsIndexingEnabled } from '@/lib/rag/index-bylaws-file'
import { ANSWER_MAX_OUTPUT_TOKENS, answerProviders, buildAnswerMessages, retrieve } from '@/lib/rag/answer'

export const runtime = 'nodejs'

// POST /api/nas/bylaws/answer — the Bylaws tab. Searches the bylaws index with
// the whole question (same search as /api/nas/bylaws/search), then writes an
// answer from the passages found. NDJSON, one frame per line:
//
//   {"type":"matches","requirement":...,"allMatched":...,"matches":[...]}   first
//   {"type":"text","delta":"..."}                                          the answer, as it is written
//   {"type":"done","provider":...,"model":...}                             last
//
// Without an LLM (ASSISTANT_ENABLED off) or with no passages, only matches +
// done are sent: the tab then shows the passages alone, as before.
export async function POST(request: NextRequest): Promise<Response> {
  const token = getTokenFromCookies(request)
  if (!token) return errorResponse('Authentication required', 401)
  if (!verifyToken(token)) return errorResponse('Invalid or expired session', 401)
  if (!isNasEnabled()) return errorResponse('Bylaws search is not available', 403)
  if (!isBylawsIndexingEnabled()) return errorResponse('Bylaws search is not configured for this deployment', 503)

  const body = await request.json().catch(() => null)
  const query = typeof body?.query === 'string' ? body.query.trim() : ''
  if (!query) return errorResponse('query is required', 400)
  if (query.length > 1000) return errorResponse('query must not exceed 1000 characters', 400)

  let retrieval
  try {
    retrieval = await retrieve('bylaws', query)
  } catch (error) {
    // Detail server-side only: Qdrant/embedding errors can include internal URLs.
    console.error('[POST /api/nas/bylaws/answer]', error)
    return errorResponse('Bylaws search failed. Please try again.', 500)
  }
  const orgId = getOrgId()

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (frame: object) => controller.enqueue(encoder.encode(JSON.stringify(frame) + '\n'))
      try {
        write({
          type: 'matches',
          requirement: retrieval.requirement,
          allMatched: retrieval.allMatched,
          matches: retrieval.passages.map((p) => ({ ...p, score: Math.round(p.score * 1000) / 1000, excerpt: p.text, text: undefined })),
        })
        let meta = null
        if (retrieval.passages.length > 0 && isAssistantEnabled()) {
          const brand = await getOrgIdentity(orgId)
          const messages = buildAnswerMessages(retrieval, query, [], brand.appName)
          // Cloud first, as in chat; see streamDocumentAnswer in app/api/assistant/message/route.ts.
          ;({ meta } = await streamPlainAnswer(messages, { ...answerProviders(), temperature: 0.2, maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS }, (delta) => write({ type: 'text', delta })))
        }
        write({ type: 'done', provider: meta?.provider ?? null, model: meta?.model ?? null })
      } catch (error) {
        console.error('[POST /api/nas/bylaws/answer] stream:', error)
        try { write({ type: 'error', error: 'Could not write an answer. The passages above are still from the bylaws.' }) } catch { /* closed */ }
      } finally {
        try { controller.close() } catch { /* idempotent */ }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
