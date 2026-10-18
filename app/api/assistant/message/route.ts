/**
 * POST /api/assistant/message
 *
 * Send a message to Forgie. Body:
 *   { conversationId?: string, content: string }
 *
 * Returns a streaming NDJSON response (Content-Type: application/x-ndjson).
 * Frames the client should expect, one per line:
 *
 *   {"type":"start","conversationId":"..."}            // first, always
 *   {"type":"text","delta":"..."}                       // token chunks
 *   {"type":"done","provider":"...","model":"...",     // terminal,
 *      "pendingActions":[...],"latencyMs":N, ...}        //   with metadata
 *
 * Special cases that still produce a streaming response:
 *   - Cache hit:        one "text" frame with the cached reply + done frame
 *   - Rate limit hit:   one "text" frame with the friendly limit message
 *   - All providers exhausted: one "text" frame with canned message + done
 *   - Auth failure:     HTTP 401 (not streamed)
 *   - Validation error: HTTP 400 (not streamed)
 *
 * Keeps the client code simple — it always reads NDJSON.
 */

import { type NextRequest } from 'next/server'
import type { ModelMessage } from 'ai'
import type { Role } from '@prisma/client'

import { prisma } from '@/lib/db'
import { getTokenFromCookies, verifyToken } from '@/lib/auth'
import { errorResponse } from '@/lib/api-helpers'
import { isAssistantEnabled, reportRateLimit, reportProviderExhausted, type ProviderName } from '@/lib/llm/provider'
import { startStream, consumeStream, streamPlainAnswer } from '@/lib/llm/stream'
import { buildSystemPrompt } from '@/lib/assistant/prompts'
import { getOrgId } from '@/lib/tenant-context'
import { getOrgIdentity } from '@/lib/org-branding'
import { buildForgieContext, buildForgieContextLite, renderContextBlock } from '@/lib/assistant/context'
import { tryRuleAnswer, classifyFast, matchHelp, matchGreeting, normalize } from '@/lib/assistant/rules'
import { reserveRateLimit, recordUsage } from '@/lib/assistant/rate-limit'
import { lookupCache, storeCache, maybeSweepCache } from '@/lib/assistant/cache'
import { isCacheableResponse } from '@/lib/assistant/cache-guard'
import { buildAllToolsAsync, selectRelevantTools, usesIntegrationTools, TOOL_USE_GUIDANCE } from '@/lib/assistant/ai-sdk-tools'
import { signActionToken } from '@/lib/assistant/action-token'
import { tryNasFastLane, tryNasReadIntent } from '@/lib/nas/fastlane'
import { tryPeopleFastLane } from '@/lib/people/fastlane'
import { isNasEnabled } from '@/lib/nas/client'
import { isBylawsIndexingEnabled } from '@/lib/rag/index-bylaws-file'
import { isRagIndexingEnabled } from '@/lib/rag/index-nas-file'
import {
  ANSWER_MAX_OUTPUT_TOKENS, RAG_TOOL, answerProviders, buildAnswerMessages, isFollowUp, notFoundMessage, questionForAnswer, ragSourceFor, retrieve,
  searchQueryFor, sourcesFooter,
  type RagRetrieval, type RagSource,
} from '@/lib/rag/answer'

const MAX_HISTORY_MESSAGES = 10

export async function POST(request: NextRequest) {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const token = getTokenFromCookies(request)
  if (!token) return errorResponse('Authentication required', 401)
  const claims = verifyToken(token)
  if (!claims) return errorResponse('Invalid or expired session', 401)

  // ── 1b. Feature flag ─────────────────────────────────────────────────────
  if (!isAssistantEnabled()) {
    return errorResponse(
      'The assistant is not configured. Ask an admin to enable Forgie.',
      503,
    )
  }

  // ── 2. Parse body ────────────────────────────────────────────────────────
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse('Request body must be valid JSON', 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('Request body must be a JSON object', 400)
  }
  const { conversationId: convIdRaw, content: contentRaw } = body as Record<string, unknown>
  if (typeof contentRaw !== 'string' || contentRaw.trim().length === 0) {
    return errorResponse('content is required', 400)
  }
  if (contentRaw.length > 4000) {
    return errorResponse('content must not exceed 4000 characters', 400)
  }
  const content = contentRaw.trim()
  const conversationId = typeof convIdRaw === 'string' && convIdRaw.length > 0 ? convIdRaw : null

  // ── 3. User load ─────────────────────────────────────────────────────────
  const user = await prisma.user.findUnique({
    where: { id: claims.userId },
    select: { id: true, name: true, role: true, isActive: true },
  })
  if (!user || !user.isActive) return errorResponse('User not found or inactive', 404)

  // ── 4. Rate limit (soft) — reserve a slot atomically before generating ───
  const rl = await reserveRateLimit(user.id)

  // ── 5. Load or create conversation ───────────────────────────────────────
  let conversation = conversationId
    ? await prisma.assistantConversation.findFirst({
        where: { id: conversationId, userId: user.id },
      })
    : null

  if (!conversation) {
    conversation = await prisma.assistantConversation.create({ data: { userId: user.id } })
  }

  // ── 6. Save user message ─────────────────────────────────────────────────
  await prisma.assistantMessage.create({
    data: { conversationId: conversation.id, role: 'USER', content },
  })

  // ─── Build a streaming response ──────────────────────────────────────────
  // From this point on, errors are sent as NDJSON 'error' frames; we never
  // throw out of the stream once it's running.

  const stream = buildResponseStream({
    user,
    conversationId: conversation.id,
    content,
    rateLimit: rl,
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',  // disable nginx-style buffering if any
    },
  })
}

// ─── Stream builder ──────────────────────────────────────────────────────────

interface BuildArgs {
  user: { id: string; name: string; role: string }
  conversationId: string
  content: string
  rateLimit: { allowed: boolean; limit: number; resetInMinutes: number }
}

function buildResponseStream(args: BuildArgs): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const write = (controller: ReadableStreamDefaultController<Uint8Array>, frame: object) => {
    controller.enqueue(encoder.encode(JSON.stringify(frame) + '\n'))
  }

  return new ReadableStream({
    async start(controller) {
      try {
        // First frame: stream metadata
        write(controller, { type: 'start', conversationId: args.conversationId })

        // ── Rate-limit gate ────────────────────────────────────────────────
        if (!args.rateLimit.allowed) {
          const msg = `You've hit your hourly message limit (${args.rateLimit.limit}). Resets in about ${args.rateLimit.resetInMinutes} minute(s). Take a break.`
          write(controller, { type: 'text', delta: msg })
          write(controller, {
            type: 'done',
            provider: null,
            model: null,
            fallback: true,
            latencyMs: 0,
            pendingActions: [],
            toolsUsed: [],
          })
          // Persist assistant message
          await persistAssistant(args.conversationId, msg, {
            provider: null,
            fallback: true,
          })
          controller.close()
          return
        }

        const priorCount = await prisma.assistantMessage.count({
          where: { conversationId: args.conversationId, role: { in: ['USER', 'ASSISTANT'] } },
        })

        // ── Answers from the bylaws and NAS documents (pre-cache) ──────────
        // Questions about the bylaws or what a document says: search the index
        // with the whole message, then have the model answer from the passages
        // found, with no tools. Runs before the filename fast-lane (which
        // would treat "find the parking rules in the bylaws" as a filename)
        // and before the cache, so the answer always reflects the index.
        const docs = await prepareDocumentAnswer(args.conversationId, args.content)
        if (docs) {
          const answered = await streamDocumentAnswer(docs, (d) => write(controller, { type: 'text', delta: d }))
          write(controller, {
            type: 'done', provider: answered.provider ?? 'rag', model: answered.model ?? 'rag',
            fallback: false, latencyMs: answered.latencyMs, pendingActions: [], toolsUsed: [RAG_TOOL[docs.retrieval.source]],
          })
          await persistAssistant(args.conversationId, answered.text, {
            provider: answered.provider ?? 'rag',
            model: answered.model ?? 'rag',
            inputTokens: answered.inputTokens,
            outputTokens: answered.outputTokens,
            latencyMs: answered.latencyMs,
            toolCalls: [{
              name: RAG_TOOL[docs.retrieval.source],
              args: { query: docs.retrieval.query },
              result: { passages: docs.retrieval.passages.length, allMatched: docs.retrieval.allMatched },
              errored: false,
            }],
          })
          await maybeAutoTitle(args.conversationId, args.content, priorCount)
          controller.close()
          return
        }

        // ── NAS search fast-lane (pre-LLM, pre-cache) ──────────────────────
        // "find <term> on the NAS" answers straight from the connector's
        // filename index in ~ms, no LLM. Runs before the cache so file results
        // are always fresh. Only fires for the NAS-owning org and clear
        // file-search phrasing; anything else returns null.
        const nasFast = await tryNasFastLane(args.content)
        if (nasFast) {
          write(controller, { type: 'text', delta: nasFast })
          write(controller, {
            type: 'done', provider: 'nas', model: 'nas-index',
            fallback: false, latencyMs: 0, pendingActions: [], toolsUsed: ['nas_search'],
          })
          await persistAssistant(args.conversationId, nasFast, { provider: 'nas', model: 'nas-index' })
          await maybeAutoTitle(args.conversationId, args.content, priorCount)
          controller.close()
          return
        }

        // ── People lookup fast-lane ────────────────────────────────────────
        // "search X in contacts" / "X's number" → answer from the team
        // directory instantly, INCLUDING the phone (the LLM path kept omitting
        // it, or failing outright). Contact fields stay admin-only via RBAC.
        const peopleFast = await tryPeopleFastLane(args.content, {
          userId: args.user.id,
          role: args.user.role as Role,
        })
        if (peopleFast) {
          write(controller, { type: 'text', delta: peopleFast })
          write(controller, {
            type: 'done', provider: 'rule', model: 'directory',
            fallback: false, latencyMs: 0, pendingActions: [], toolsUsed: ['list_members'],
          })
          await persistAssistant(args.conversationId, peopleFast, { provider: 'rule', model: 'directory' })
          await maybeAutoTitle(args.conversationId, args.content, priorCount)
          controller.close()
          return
        }

        // ── NAS read fast-path (single no-tools LLM call over file text) ───
        // "read/summarize <file>" → resolve + extract the file here, then answer
        // in ONE generation with no tools. Avoids the slow/fragile agentic
        // tool loop; local-first so it's fast and reliable.
        const nasRead = await tryNasReadIntent(args.content)
        if (nasRead) {
          const sys =
            `You are Forgie. Answer the user's question about the file "${nasRead.name}" ` +
            `(on the ${nasRead.server} NAS) using ONLY the content below. Be concise and ` +
            `specific; if the content doesn't contain the answer, say so plainly.\n\n` +
            `--- CONTENT OF ${nasRead.name} ---\n${nasRead.text}`
          const readMessages: ModelMessage[] = [
            { role: 'system', content: sys },
            { role: 'user', content: args.content },
          ]
          const read = await streamPlainAnswer(readMessages, {}, (d) => write(controller, { type: 'text', delta: d }))
          let readText = read.text
          const readMeta = read.meta
          if (!readText.trim()) {
            readText = `I found ${nasRead.name} on the ${nasRead.server} NAS but couldn't read it just now.`
            write(controller, { type: 'text', delta: readText })
          }
          const link = `\n\n[Download ${nasRead.name}](/api/nas/download?server=${encodeURIComponent(nasRead.server)}&path=${encodeURIComponent(nasRead.path)})`
          write(controller, { type: 'text', delta: link })
          readText += link
          write(controller, {
            type: 'done', provider: readMeta?.provider ?? 'nas', model: readMeta?.model ?? 'nas-read',
            fallback: false, latencyMs: 0, pendingActions: [], toolsUsed: ['nas_read'],
          })
          await persistAssistant(args.conversationId, readText, { provider: readMeta?.provider ?? 'nas', model: 'nas-read' })
          await maybeAutoTitle(args.conversationId, args.content, priorCount)
          controller.close()
          return
        }

        // ── Cache check (only on fresh conversations) ──────────────────────
        if (priorCount <= 1) {
          const cached = await lookupCache({
            userId: args.user.id,
            role: args.user.role,
            query: args.content,
          })
          if (cached) {
            write(controller, { type: 'text', delta: cached.response })
            write(controller, {
              type: 'done',
              provider: 'cache',
              model: 'cache',
              fallback: false,
              latencyMs: 0,
              pendingActions: [],
              toolsUsed: [],
              cached: true,
            })
            await persistAssistant(args.conversationId, cached.response, {
              provider: 'cache',
              model: 'cache',
            })
            await maybeAutoTitle(args.conversationId, args.content, priorCount)
            controller.close()
            return
          }
        }

        // ── Ultra-fast lane (PRE-context) ──────────────────────────────────
        // "help"/capabilities need no data and a bare greeting needs only the
        // caller's own tasks (1 query), so answer these BEFORE the full
        // multi-query context build. Keeps "hi" / "what can you do" in the
        // tens-of-ms range instead of paying for the projects + tickets + org
        // snapshot fetch. Anything uncertain → null → normal path below.
        const fastIntent = classifyFast(args.content)
        if (fastIntent) {
          const fastAnswer =
            fastIntent === 'help'
              ? matchHelp(normalize(args.content))
              : matchGreeting(
                  normalize(args.content),
                  await buildForgieContextLite({
                    userId: args.user.id,
                    userName: args.user.name,
                    userRole: args.user.role,
                  }),
                )
          if (fastAnswer) {
            write(controller, { type: 'text', delta: fastAnswer })
            write(controller, {
              type: 'done',
              provider: 'rule',
              model: 'rule',
              fallback: false,
              latencyMs: 0,
              pendingActions: [],
              toolsUsed: [],
            })
            await persistAssistant(args.conversationId, fastAnswer, { provider: 'rule', model: 'rule' })
            await maybeAutoTitle(args.conversationId, args.content, priorCount)
            controller.close()
            return
          }
        }

        // ── Build context + prompt ─────────────────────────────────────────
        const forgieCtx = await buildForgieContext({
          userId: args.user.id,
          userName: args.user.name,
          userRole: args.user.role,
        })

        // ── Rule-first fast lane (Phase 1) ─────────────────────────────────
        // Deterministically answer common, safe, read-only questions straight
        // from the context — no LLM. High precision: anything uncertain returns
        // null and falls through to the model below.
        const ruleAnswer = tryRuleAnswer(args.content, forgieCtx)
        if (ruleAnswer) {
          write(controller, { type: 'text', delta: ruleAnswer })
          write(controller, {
            type: 'done',
            provider: 'rule',
            model: 'rule',
            fallback: false,
            latencyMs: 0,
            pendingActions: [],
            toolsUsed: [],
          })
          await persistAssistant(args.conversationId, ruleAnswer, { provider: 'rule', model: 'rule' })
          await maybeAutoTitle(args.conversationId, args.content, priorCount)
          controller.close()
          return
        }

        const brand = await getOrgIdentity(getOrgId())
        const systemPrompt = [
          buildSystemPrompt({
            id: args.user.id,
            name: args.user.name,
            role: args.user.role as Role,
            projectCount: forgieCtx.myProjects.length,
            openTaskCount: forgieCtx.myTasks.filter((t) => t.status !== 'DONE').length,
            overdueTaskCount: forgieCtx.myTasks.filter((t) => t.isOverdue).length,
          }, brand),
          '',
          renderContextBlock(forgieCtx),
          '',
          TOOL_USE_GUIDANCE,
        ].join('\n')

        // ── Load conversation history ──────────────────────────────────────
        const history = await prisma.assistantMessage.findMany({
          where: {
            conversationId: args.conversationId,
            role: { in: ['USER', 'ASSISTANT'] },
          },
          orderBy: { createdAt: 'desc' },
          take: MAX_HISTORY_MESSAGES,
          select: { role: true, content: true },
        })
        history.reverse()

        const messages: ModelMessage[] = [
          { role: 'system', content: systemPrompt },
          ...history.map((m) => ({
            role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
            content: m.content,
          })),
        ]

        // ── Stream! ────────────────────────────────────────────────────────
        const allTools = await buildAllToolsAsync({
          userId: args.user.id,
          role: args.user.role,
        })
        // Trim to the tool groups relevant to this message — core tools always
        // stay; integration groups (GitHub/Calendar/Gmail/Drive/WhatsApp) only
        // when mentioned. Cuts the re-sent input payload roughly in half for the
        // common case, which is the main latency lever for tool-path queries.
        const tools = selectRelevantTools(allTools, args.content)
        // Provider routing for this turn:
        //  • Integration-tool reads (nas_search, gh_list, gcal_list, …) need a
        //    reliable search-then-summarize continuation — only the cloud models
        //    do this well. Groq hangs the continuation; the small local models
        //    leak/empty it. So push BOTH local and groq to the back → Gemini/
        //    Cerebras serve these.
        //  • Plain write/action verbs (create/assign/…) are terminal proposals
        //    the local model handles fine; just keep Groq (continuation-hang)
        //    off the front.
        //  • Everything else (chat) keeps the fast local model first.
        const isActionVerb =
          /\b(create|add|make|new|raise|open|schedule|book|invite|send|email|mail|dm|ping|message|notify|assign|reassign|update|change|edit|rename|set|move|mark|resolve|close|complete|archive|promote|demote|remove|delete|start a call|call|leave)\b/i.test(
            args.content,
          )
        const deprioritize: ProviderName[] = usesIntegrationTools(tools)
          ? ['local', 'groq']
          : isActionVerb
            ? ['groq']
            : []

        // streamText() never throws synchronously — the actual API call (and
        // any 429 / auth / network error) surfaces when the textStream is
        // iterated. If a provider's keys are exhausted, the iterator throws
        // BEFORE any text is written. In that case we mark the key cooled
        // down and retry with the next available provider, up to a budget.
        // Once we've streamed any text to the client, we commit — bailing
        // mid-response would be jarring.
        let fullText = ''
        let metadata: Awaited<ReturnType<typeof consumeStream>> | null = null
        // MUST exceed the TOTAL number of API keys across all providers, or a
        // provider whose keys all fail the same way (e.g. Groq's 12k TPM 413)
        // consumes the budget before the next provider (Gemini) is ever reached
        // — silently breaking cross-provider fallback. 11 keys today (1 local +
        // 5 groq + 5 gemini); 16 leaves margin.
        const STREAM_ATTEMPT_BUDGET = 16
        const failureLog: Array<{ provider: string; reason: string }> = []

        for (let attempt = 0; attempt < STREAM_ATTEMPT_BUDGET; attempt++) {
          const start = await startStream(messages, { tools, deprioritize })

          if (!start.success) {
            // All providers exhausted (synchronously). Fall through to the
            // graceful error path below.
            failureLog.push({ provider: 'none', reason: start.reason })
            break
          }

          try {
            metadata = await consumeStream(start, (delta) => {
              fullText += delta
              write(controller, { type: 'text', delta })
            })
            // Empty output with no tool call = the model produced nothing usable
            // (small local models occasionally stall on the big tool prompt).
            // Nothing was streamed to the client yet, so treat it as a soft
            // failure and try the NEXT provider rather than surfacing a nudge.
            const producedNothing =
              fullText.trim().length === 0 && (metadata.toolCalls?.length ?? 0) === 0
            if (producedNothing) {
              failureLog.push({ provider: start.provider, reason: 'empty_output' })
              reportRateLimit(start.provider, start.apiKey)
              metadata = null
              continue
            }
            // Success — stream completed with usable content.
            break
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            failureLog.push({ provider: start.provider, reason: reason.slice(0, 160) })
            console.warn(
              `[message-stream] ${start.provider} key ...${start.apiKey.slice(-6)} ` +
              `errored ${fullText ? `after ${fullText.length} chars — committing partial response` : 'before any text — retrying'}: ${reason.slice(0, 200)}`,
            )

            // Provider-wide failures can't be fixed by another key — cool the
            // WHOLE provider and jump to the next. Two cases:
            //  • 413 "request too large" / TPM cap (shared across keys), and
            //  • a stall to the request-timeout (abort): under load the provider
            //    is unresponsive and its OTHER keys stall too, so retrying them
            //    just burns another full timeout (seen: 2×45s). Skip straight to
            //    the next provider instead.
            // A plain 429 on one key is NOT provider-wide — cool just that key.
            if (/request too large|tokens per minute|context length|too many tokens|\b413\b/i.test(reason)) {
              reportProviderExhausted(start.provider)
            } else if (/abort|timed?\s?out|timeout|ETIMEDOUT/i.test(reason)) {
              reportProviderExhausted(start.provider)
            } else {
              reportRateLimit(start.provider, start.apiKey)
            }

            if (fullText.length > 0) {
              // Some content already shown to the user — don't restart from
              // scratch and double-send. Commit what we have.
              break
            }
            // Otherwise retry with the next available provider/key.
            continue
          }
        }

        // If every attempt failed before producing any text, emit a graceful
        // fallback message so the user sees SOMETHING instead of an empty
        // response bubble.
        if (!metadata && fullText.length === 0) {
          const lastReason = failureLog[failureLog.length - 1]?.reason ?? 'all_attempts_exhausted'
          const fallbackMsg = pickFallbackMessage(lastReason)
          write(controller, { type: 'text', delta: fallbackMsg })
          write(controller, {
            type: 'done',
            provider: null,
            model: null,
            fallback: true,
            latencyMs: 0,
            pendingActions: [],
            toolsUsed: [],
          })
          await persistAssistant(args.conversationId, fallbackMsg, {
            provider: null,
            fallback: true,
          })
          console.error(
            `[message-stream] all ${failureLog.length} attempts failed:`,
            failureLog,
          )
          controller.close()
          return
        }

        // ── Compute pending actions from tool calls ────────────────────────
        // Llama 3.3 occasionally emits the same propose_* tool call multiple
        // times in one response. Dedupe by (action + canonicalized args) so
        // the user only sees one confirmation card per actually-distinct
        // proposal.
        const seenFingerprints = new Set<string>()
        const pendingActions = (metadata?.toolCalls ?? [])
          .filter((c) => c.name.startsWith('propose_') && !c.errored)
          .map((c) => {
            const r = c.result as { proposed?: boolean; action?: string; args?: Record<string, unknown> } | null
            if (!r || !r.action || !r.args) return null
            // Stable-stringify by sorting object keys so { a, b } == { b, a }
            const fingerprint = `${r.action}|${JSON.stringify(r.args, Object.keys(r.args).sort())}`
            if (seenFingerprints.has(fingerprint)) return null
            seenFingerprints.add(fingerprint)
            return {
              actionId: `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
              action: r.action,
              args: r.args,
              // HMAC binding so /actions/execute can verify this exact action +
              // args was proposed by the server for this user (anti-tamper /
              // anti-forge). See lib/assistant/action-token.ts.
              token: signActionToken({ userId: args.user.id, action: r.action, args: r.args }),
              label: buildActionLabel(r.action, r.args, forgieCtx),
            }
          })
          .filter((p): p is NonNullable<typeof p> => p !== null)

        // ── Safety net: never leave an empty bubble ────────────────────────
        // If the model streamed no text AND proposed no action card (can
        // happen when it gets confused mid-reasoning), emit a gentle nudge
        // so the user isn't staring at a blank response.
        if (fullText.trim().length === 0 && pendingActions.length === 0) {
          write(controller, { type: 'text', delta: NUDGE_MESSAGE })
          fullText = NUDGE_MESSAGE
        }

        // ── Persist assistant message ──────────────────────────────────────
        await persistAssistant(args.conversationId, fullText, {
          provider: metadata?.provider ?? null,
          model: metadata?.model ?? null,
          inputTokens: metadata?.inputTokens,
          outputTokens: metadata?.outputTokens,
          latencyMs: metadata?.latencyMs,
          toolCalls: metadata?.toolCalls,
        })

        // ── Auto-title on first exchange ───────────────────────────────────
        await maybeAutoTitle(args.conversationId, args.content, priorCount)

        // ── Cache + usage (best-effort, non-blocking) ──────────────────────
        // Don't cache replies that proposed actions: a cache hit replays
        // text only (pendingActions: []), so the confirmation card would
        // silently vanish on replay.
        // Only cache genuine successful model answers. Excludes fallbacks/nudges
        // and empty/very-short replies via isCacheableResponse — otherwise a
        // transient failure gets cached and replayed (provider=cache) for the TTL.
        // Never cache a reply the model cut off at the output cap either
        // (finishReason "length"): replaying half a sentence for the whole TTL
        // is worse than asking the model again.
        if (
          priorCount <= 1 &&
          metadata?.provider &&
          metadata.finishReason !== 'length' &&
          pendingActions.length === 0 &&
          isCacheableResponse(fullText)
        ) {
          void storeCache({
            userId: args.user.id,
            role: args.user.role,
            query: args.content,
            response: fullText,
          }).catch(() => {})
        }
        if (metadata?.provider) {
          void recordUsage({
            userId: args.user.id,
            provider: metadata.provider,
            inputTokens: metadata.inputTokens ?? 0,
            outputTokens: metadata.outputTokens ?? 0,
          }).catch(() => {})
        }
        void maybeSweepCache()

        // ── Done frame ─────────────────────────────────────────────────────
        write(controller, {
          type: 'done',
          provider: metadata?.provider ?? null,
          model: metadata?.model ?? null,
          fallback: false,
          latencyMs: metadata?.latencyMs ?? null,
          pendingActions,
          toolsUsed: metadata?.toolCalls.map((c) => c.name) ?? [],
        })
        controller.close()
      } catch (err) {
        console.error('[POST /api/assistant/message] stream init error:', err)
        try {
          write(controller, {
            type: 'error',
            error: 'Forgie hit a snag. Try again in a moment.',
          })
        } catch { /* controller may be closed */ }
        try { controller.close() } catch { /* idempotent */ }
      }
    },
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface DocumentAnswerPlan {
  retrieval: RagRetrieval
  /** The question for the model: the message, plus the merged question for a follow-up. */
  question: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
}

/**
 * Decide whether this message is answered from the documents, and if so run
 * the search. A follow-up to such an answer ("and for commercial?") stays in
 * the same index and inherits what it leaves out from the previous question.
 * Null: not a document question, or the search failed (the normal path then
 * answers, and can still call the search tools itself).
 */
async function prepareDocumentAnswer(conversationId: string, content: string): Promise<DocumentAnswerPlan | null> {
  if (!isNasEnabled()) return null
  const available = { bylaws: isBylawsIndexingEnabled(), nas: isRagIndexingEnabled() }
  if (!available.bylaws && !available.nas) return null

  // Newest first; [0] is the message being answered, saved in step 6.
  const recent = await prisma.assistantMessage.findMany({
    where: { conversationId, role: { in: ['USER', 'ASSISTANT'] } },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { role: true, content: true, toolCalls: true },
  })
  const earlier = recent.slice(1)
  const previous = previousDocumentSearch(earlier[0]?.toolCalls)

  let source = ragSourceFor(content, available)
  const followUp = previous !== null && available[previous.source] && isFollowUp(content)
  if (!source && followUp) source = previous.source
  if (!source) return null

  const query = searchQueryFor(source, content, followUp && previous.source === source ? previous.query : null)
  let retrieval: RagRetrieval
  try {
    retrieval = await retrieve(source, query)
  } catch (e) {
    console.warn(`[docs-answer] ${source} search failed, using the normal path:`, e instanceof Error ? e.message : e)
    return null
  }
  // Nothing inside the NAS documents: the normal path may still find the file by name.
  if (retrieval.passages.length === 0 && source === 'nas') return null

  const history = earlier
    .slice(0, 4)
    .reverse()
    .map((m) => ({ role: m.role === 'USER' ? ('user' as const) : ('assistant' as const), content: m.content }))
  return { retrieval, history, question: questionForAnswer(content, query) }
}

/** The search a previous assistant turn ran, from its stored tool calls. */
function previousDocumentSearch(toolCalls: unknown): { source: RagSource; query: string } | null {
  if (!Array.isArray(toolCalls)) return null
  for (const c of toolCalls as Array<{ name?: unknown; args?: { query?: unknown } }>) {
    const source = (Object.keys(RAG_TOOL) as RagSource[]).find((s) => RAG_TOOL[s] === c?.name)
    if (source && typeof c.args?.query === 'string') return { source, query: c.args.query }
  }
  return null
}

/**
 * Write the answer from the retrieved passages, then the list of documents
 * it cited. Never empty: with no passages it says nothing was found, and if
 * no model answers it shows the best passages themselves.
 *
 * The answer goes to the cloud providers first, like the agentic path does
 * for NAS tools, because the small local model answers these badly. Set
 * RAG_ANSWER_LOCAL_FIRST=true to keep document text on the local model when
 * it is available (docs/RAG_CHANGES_OCT_2026.md, open issue 3).
 */
async function streamDocumentAnswer(
  plan: DocumentAnswerPlan,
  emit: (delta: string) => void,
): Promise<{ text: string; provider: string | null; model: string | null; inputTokens: number | null; outputTokens: number | null; latencyMs: number }> {
  const t0 = Date.now()
  const r = plan.retrieval
  const none = { provider: null, model: null, inputTokens: null, outputTokens: null }
  if (r.passages.length === 0) {
    const msg = notFoundMessage(r)
    emit(msg)
    return { text: msg, ...none, latencyMs: Date.now() - t0 }
  }

  const brand = await getOrgIdentity(getOrgId())
  const messages = buildAnswerMessages(r, plan.question, plan.history, brand.appName)
  const { text, meta } = await streamPlainAnswer(messages, { ...answerProviders(), temperature: 0.2, maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS }, emit)

  let answer = text
  if (!answer.trim()) {
    // No provider answered: show the passages that would have been used.
    answer = 'I found these in the documents but could not write up an answer just now:\n\n' +
      r.passages.slice(0, 3).map((p, i) => `[${i + 1}] ${p.values ?? p.matchedRow ?? p.text.slice(0, 300)}`).join('\n\n')
    emit(answer)
  }
  const footer = sourcesFooter(answer, r.passages)
  emit(footer)
  return {
    text: answer + footer,
    provider: meta?.provider ?? null,
    model: meta?.model ?? null,
    inputTokens: meta?.inputTokens ?? null,
    outputTokens: meta?.outputTokens ?? null,
    latencyMs: Date.now() - t0,
  }
}

/**
 * Title a conversation after its first exchange. priorCount includes the
 * user message saved in step 6, so a fresh conversation has priorCount === 1
 * (same convention as the lookupCache gate).
 */
async function maybeAutoTitle(
  conversationId: string,
  content: string,
  priorCount: number,
): Promise<void> {
  if (priorCount > 1) return
  const autoTitle = content.length > 60 ? content.slice(0, 57) + '...' : content
  await prisma.assistantConversation
    .update({ where: { id: conversationId }, data: { title: autoTitle } })
    .catch(() => {})
}

async function persistAssistant(
  conversationId: string,
  content: string,
  meta: {
    provider?: string | null
    model?: string | null
    inputTokens?: number | null
    outputTokens?: number | null
    latencyMs?: number | null
    fallback?: boolean
    toolCalls?: unknown
  },
) {
  await prisma.assistantMessage
    .create({
      data: {
        conversationId,
        role: 'ASSISTANT',
        content,
        provider: meta.provider ?? null,
        model: meta.model ?? null,
        inputTokens: meta.inputTokens ?? null,
        outputTokens: meta.outputTokens ?? null,
        latencyMs: meta.latencyMs ?? null,
        toolCalls: meta.toolCalls
          ? (meta.toolCalls as object)
          : undefined,
      },
    })
    .catch((err) => {
      console.warn('[persistAssistant] failed:', err)
    })
}

// Shown when the model streamed no text and proposed no action card.
const NUDGE_MESSAGE =
  "Sorry — I didn't manage to put together a reply for that one. Mind rephrasing, or giving me a little more detail?"

function pickFallbackMessage(reason: string): string {
  switch (reason) {
    case 'all_keys_cooling_down':
    case 'all_attempts_exhausted':
      return "I'm getting a lot of traffic right now. Give me a moment and try again — should be back to normal shortly."
    case 'assistant_disabled':
      return 'Forgie is currently disabled. Ask an admin to enable it.'
    default:
      return 'Hit a snag with all my upstream providers. Try again in a minute.'
  }
}

function buildActionLabel(
  action: string,
  args: Record<string, unknown>,
  ctx: { myProjects: Array<{ id: string; name: string }> },
): string {
  const projectName = typeof args.projectId === 'string'
    ? ctx.myProjects.find((p) => p.id === args.projectId)?.name ?? args.projectId
    : undefined

  switch (action) {
    case 'create_task': {
      const title = typeof args.title === 'string' ? args.title : 'New task'
      const due = typeof args.dueDate === 'string' ? ` (due ${args.dueDate.slice(0, 10)})` : ''
      const priority = typeof args.priority === 'string' && args.priority !== 'MEDIUM'
        ? ` · ${args.priority}` : ''
      return `Create task "${title}" in ${projectName ?? 'project'}${due}${priority}`
    }
    case 'create_ticket': {
      const title = typeof args.title === 'string' ? args.title : 'New ticket'
      return `Raise ticket "${title}" in ${projectName ?? 'project'}`
    }
    case 'update_task_status': {
      const status = typeof args.newStatus === 'string' ? args.newStatus : '?'
      return `Mark task as ${status}`
    }
    case 'gh_create_repo': {
      const name = typeof args.name === 'string' ? args.name : 'new-repo'
      const visibility = args.private === false ? 'public' : 'private'
      return `Create GitHub repo "${name}" (${visibility})`
    }
    case 'gh_create_issue': {
      const title = typeof args.title === 'string' ? args.title : 'New issue'
      const repo = typeof args.repo === 'string' ? args.repo : 'repo'
      return `File GitHub issue "${title}" on ${repo}`
    }
    case 'gcal_create_event': {
      const title = typeof args.title === 'string' ? args.title : 'New meeting'
      const start = typeof args.start === 'string' ? formatWhen(args.start) : ''
      const attendeeCount = Array.isArray(args.attendees) ? args.attendees.length : 0
      const withWho = attendeeCount > 0 ? ` with ${attendeeCount} attendee${attendeeCount === 1 ? '' : 's'}` : ''
      return `Schedule "${title}"${start ? ` ${start}` : ''}${withWho}`
    }
    case 'gcal_cancel_event': {
      return `Cancel calendar event`
    }
    case 'gmail_send': {
      const to = typeof args.to === 'string' ? args.to : ''
      const subj = typeof args.subject === 'string' ? args.subject : '(no subject)'
      const recipients = to.split(',').map((s) => s.trim()).filter(Boolean)
      const recipientLabel = recipients.length === 1
        ? recipients[0]
        : `${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`
      return `Send email "${subj}" to ${recipientLabel}`
    }
    case 'drive_create_folder': {
      const name = typeof args.name === 'string' ? args.name : 'New folder'
      return `Create Drive folder "${name}"`
    }
    case 'drive_create_doc': {
      const name = typeof args.name === 'string' ? args.name : 'New file'
      const format = args.format === 'gdoc' ? 'Google Doc' : 'text file'
      return `Create ${format} "${name}" in Drive`
    }
    case 'create_project': {
      const name = typeof args.name === 'string' ? args.name : 'New project'
      const memberCount = Array.isArray(args.memberIds) ? args.memberIds.length : 0
      const extras = memberCount > 0 ? ` + ${memberCount} member${memberCount === 1 ? '' : 's'}` : ''
      return `Create project "${name}" (lead + you${extras})`
    }
    case 'add_project_member': {
      return `Add member to ${projectName ?? 'project'}`
    }
    case 'set_project_lead': {
      return `Change lead of ${projectName ?? 'project'}`
    }
    case 'update_project': {
      const fields: string[] = []
      if (typeof args.name === 'string') fields.push('name')
      if (args.description !== undefined) fields.push('description')
      if (typeof args.status === 'string') fields.push(`status → ${args.status}`)
      if (typeof args.priority === 'string') fields.push(`priority → ${args.priority}`)
      if (args.deadline !== undefined) fields.push('deadline')
      if (typeof args.newLeadId === 'string') fields.push('lead')
      const what = fields.length > 0 ? fields.join(', ') : 'details'
      return `Update ${projectName ?? 'project'} (${what})`
    }
    case 'archive_project': {
      return `Archive ${projectName ?? 'project'}`
    }
    default:
      return action
  }
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}
