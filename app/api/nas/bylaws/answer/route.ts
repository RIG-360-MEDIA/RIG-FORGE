import { type NextRequest } from 'next/server'

import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { errorResponse } from '@/lib/api-helpers'
import { isNasEnabled } from '@/lib/nas/client'
import { getOrgId } from '@/lib/tenant-context'
import { getOrgIdentity } from '@/lib/org-branding'
import { isAssistantEnabled } from '@/lib/llm/provider'
import { isBylawsIndexingEnabled } from '@/lib/rag/index-bylaws-file'
import { type RagRetrieval, answerNeverNotFound, answerReferences, bylawsStates, retrieve, widerRetrieval } from '@/lib/rag/answer'

export const runtime = 'nodejs'

// POST /api/nas/bylaws/answer — the Bylaws and Central tabs. Searches the bylaws index with
// the whole question (same search as /api/nas/bylaws/search), then writes an
// answer from the passages found. NDJSON, one frame per line:
//
//   {"type":"matches","requirement":...,"allMatched":...,"matches":[...]}   first
//   {"type":"general"}                                                     the passages do not answer: hide them
//   {"type":"status","text":"..."}                                         what is happening before text arrives
//   {"type":"text","delta":"..."}                                          the answer (cross-checked), as it is written
//   {"type":"sources","sources":[{n,fileName,section,quote,pdfUrl,sourceUrl}]}  the documents it cited
//   {"type":"done","provider":...,"model":...}                             last
//
// When neither this search nor a wider second one answers the question, the
// answer is written without the documents ("general" frame first). Without
// an LLM (ASSISTANT_ENABLED off) only matches + done are sent.
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
  // Which documents (lib/rag/regions.ts), never mixed:
  // - area "central" (the Central tab): the central documents only;
  // - state (the Bylaws tab's State dropdown): that state's own documents
  //   only, no central ones, no BIS model copies;
  // - neither (the Bylaws tab, "All states"): every state's, no central ones.
  if (body?.area !== undefined && body.area !== 'central') return errorResponse('area must be "central"', 400)
  const area = body?.area === 'central' ? ('central' as const) : undefined
  const state = !area && typeof body?.state === 'string' && body.state.trim() ? body.state.trim() : undefined

  let retrieval
  try {
    if (state && !(await bylawsStates()).includes(state)) return errorResponse('No bylaws are indexed for that state', 400)
    retrieval = await retrieve('bylaws', query, 8, state ? { state } : { area: area ?? 'all-states' })
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
        write({ type: 'matches', ...matchesFrame(retrieval) })
        let meta = null
        if (isAssistantEnabled()) {
          const brand = await getOrgIdentity(orgId)
          const out = await answerNeverNotFound({
            first: retrieval,
            second: widerRetrieval(retrieval),
            question: query,
            history: [],
            orgName: brand.appName,
            emit: (delta) => write({ type: 'text', delta }),
            // The wider search's passages, which its answer's citations refer to.
            onSecond: (r) => write({ type: 'matches', ...matchesFrame(r) }),
            onGeneral: () => write({ type: 'general' }),
            // "Reading the bylaws…", "Cross-checking the answer against the latest bylaws…".
            onStatus: (text) => write({ type: 'status', text }),
          })
          meta = out.meta
          // Written from the documents: the ones it cited, with their exact
          // lines, clause and page. Never sent for an answer written without them.
          if (out.retrieval && out.text.trim()) {
            write({ type: 'sources', sources: answerReferences(out.text, out.retrieval.passages, 'bylaws') })
          }
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

function matchesFrame(r: RagRetrieval) {
  return {
    requirement: r.requirement,
    allMatched: r.allMatched,
    state: r.state ?? null,
    area: r.area ?? null,
    matches: r.passages.map((p) => ({ ...p, score: Math.round(p.score * 1000) / 1000, excerpt: p.text, text: undefined })),
  }
}
