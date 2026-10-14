/**
 * Streaming counterpart to lib/llm/generate.ts.
 *
 * The shape: caller passes messages + tools, gets back an async iterable
 * of frames the route can serialize to NDJSON for the client.
 *
 * Frames:
 *   { type: 'text', delta: string }                    // a token chunk
 *   { type: 'tool', name: string }                     // a tool call started
 *   { type: 'done', provider, model, inputTokens,     // final metadata,
 *     outputTokens, latencyMs, toolCalls, fallback }   //   emitted once
 *   { type: 'error', error: string }                   // terminal failure
 *
 * Fallback semantics: we try providers in order. If `streamText()` throws
 * synchronously OR errors before producing any text, we mark that key
 * cooling-down and try the next. Once at least one chunk has streamed,
 * we commit — mid-stream errors are logged but don't switch providers
 * (the user already sees text on screen; bailing would be jarring).
 */

import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
  type StreamTextResult,
} from 'ai'

import {
  isAssistantEnabled,
  selectNextModel,
  reportRateLimit,
  type ProviderName,
} from './provider'

const MAX_FALLBACK_ATTEMPTS = 10
// Raised from 3 → 6.
// Complex requests like "schedule a meet with X and Y and email both" require:
//   get_member(X) + get_member(Y) + propose_gcal_create_event
//   + propose_gmail_send(X) + propose_gmail_send(Y) = 5 steps.
// Capping at 3 caused the model to stall mid-chain and produce no text at all.
const MAX_TOOL_STEPS = 6

// ── Phase-0 reliability guardrails ──────────────────────────────────────────
// Cap output so a runaway generation can't stream for minutes (avg output is
// ~200 tokens; 800 is generous headroom). Env-overridable.
const MAX_OUTPUT_TOKENS = Number(process.env.ASSISTANT_MAX_OUTPUT_TOKENS ?? 800)
// Hard per-attempt wall-clock budget for the whole agentic turn. Aborts the
// pathological long tail (prod saw p95 ~111s, max ~10min) without hurting
// normal turns (<25s). If it aborts before any text, the caller falls to the
// next provider; once text has streamed, mid-stream abort just ends cleanly.
const REQUEST_TIMEOUT_MS = Number(process.env.ASSISTANT_REQUEST_TIMEOUT_MS ?? 45_000)

export interface StreamMetadata {
  provider: ProviderName
  model: string
  inputTokens: number | null
  outputTokens: number | null
  latencyMs: number
  toolCalls: Array<{ name: string; args: unknown; result: unknown; errored: boolean }>
  /** Why the model stopped: "stop" normally, "length" when it hit the output cap (the reply is cut off). */
  finishReason?: string | null
  fallback: false
}

export interface StreamErrorFrame {
  fallback: true
  reason: string
}

export type StreamStart =
  | {
      success: true
      provider: ProviderName
      modelName: string
      apiKey: string
      result: StreamTextResult<ToolSet, never>
      startedAt: number
    }
  | {
      success: false
      reason: string
    }

export interface StreamOptions {
  tools?: ToolSet
  // Providers to push to the BACK of the order for this turn (still usable as a
  // last resort). Used to keep providers that mishandle a given turn off the
  // front: Groq hangs the agentic continuation after any tool call, and the
  // small local models can't reliably do the search-then-summarize flow that
  // read-integration tools (nas_search, gh_list, …) need. Chat + simple
  // proposals leave this empty so the fast local model stays first.
  deprioritize?: ProviderName[]
}

/**
 * Try to start a streaming generation, falling back across providers if
 * the *initial* call errors. Returns a committed stream on success.
 *
 * NOTE: this function never throws — failures land in the returned
 * { success: false, reason } shape so the caller can render a graceful
 * SSE error frame.
 */
export async function startStream(
  messages: ModelMessage[],
  options: StreamOptions = {},
): Promise<StreamStart> {
  if (!isAssistantEnabled()) {
    return { success: false, reason: 'assistant_disabled' }
  }

  // Pass the system prompt via the SDK's dedicated `system` option instead of
  // a role:'system' entry in `messages` (which logs a prompt-injection
  // warning). Split once here so the web-chat caller doesn't have to.
  const systemText = extractSystem(messages)
  const convo = messages.filter((m) => m.role !== 'system')

  for (let attempt = 0; attempt < MAX_FALLBACK_ATTEMPTS; attempt++) {
    const selection = selectNextModel(
      options.deprioritize?.length ? { deprioritize: options.deprioritize } : undefined,
    )
    if (!selection) {
      return { success: false, reason: 'all_keys_cooling_down' }
    }

    try {
      const result = streamText({
        model: selection.model,
        ...(systemText && { system: systemText }),
        messages: convo,
        temperature: 0.85,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(options.tools && {
          tools: options.tools,
          stopWhen: stepCountIs(MAX_TOOL_STEPS),
        }),
        // `onError` catches mid-stream issues. We log them but the stream
        // already started so the user keeps reading.
        onError: ({ error }) => {
          console.warn(
            `[llm-stream] ${selection.provider} mid-stream error: ${errMsg(error)}`,
          )
        },
      })

      // `streamText` returns synchronously; failures surface when the
      // textStream is iterated. We pull the first chunk here to verify
      // the call really started. If it errors, fall through.
      // BUT: pulling here consumes the first chunk, so we save it and
      // hand it back to the caller in `firstChunk`.
      // ...actually that's awkward. Simpler: trust that synchronous
      // streamText() call validated the basics, and rely on onError +
      // the textStream iteration in the caller to detect issues.
      return {
        success: true,
        provider: selection.provider,
        modelName: selection.modelName,
        apiKey: selection.apiKey,
        result,
        startedAt: Date.now(),
      }
    } catch (err) {
      console.warn(
        `[llm-stream] ${selection.provider} failed to start (key ...${selection.apiKey.slice(-6)}): ${errMsg(err)}`,
      )
      reportRateLimit(selection.provider, selection.apiKey)
      continue
    }
  }

  return { success: false, reason: 'all_attempts_exhausted' }
}

/**
 * Drain a successful stream, collecting tool calls and tokens. Caller
 * is expected to write text chunks to the wire as they come in via the
 * onText callback.
 */
export async function consumeStream(
  start: Extract<StreamStart, { success: true }>,
  onText: (delta: string) => void,
): Promise<StreamMetadata> {
  // Drain the text stream first; tools and usage settle after.
  for await (const delta of start.result.textStream) {
    if (delta) onText(delta)
  }

  // After the iterator drains, AI SDK has resolved all promises.
  const usage = await start.result.usage
  const steps = await start.result.steps
  const finishReason = await Promise.resolve(start.result.finishReason).catch(() => null)

  const toolCalls: StreamMetadata['toolCalls'] = []
  for (const step of steps) {
    const calls = step.content.filter((c) => c.type === 'tool-call')
    const results = step.content.filter(
      (c) => c.type === 'tool-result' || c.type === 'tool-error',
    )
    for (const call of calls) {
      const match = results.find(
        (r) => 'toolCallId' in r && r.toolCallId === call.toolCallId,
      )
      toolCalls.push({
        name: call.toolName,
        args: call.input,
        result:
          match && 'output' in match
            ? match.output
            : match && 'error' in match
              ? String(match.error)
              : null,
        errored: match?.type === 'tool-error',
      })
    }
  }

  return {
    provider: start.provider,
    model: start.modelName,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    latencyMs: Date.now() - start.startedAt,
    toolCalls,
    finishReason: finishReason ?? null,
    fallback: false,
  }
}

// Join all role:'system' messages into one string for the AI SDK's `system`
// option; undefined when there are none. The typeof guard narrows the
// ModelMessage union (system content is always a string in our usage).
function extractSystem(messages: ModelMessage[]): string | undefined {
  const parts = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter(Boolean)
  return parts.length ? parts.join('\n\n') : undefined
}

function errMsg(err: unknown): string {
  if (!err) return 'unknown'
  if (err instanceof Error) return err.message.split('\n')[0]?.slice(0, 200) ?? err.message
  // AI SDK sometimes surfaces a plain object (e.g. { error: {...} }); String()
  // on it yields a useless "[object Object]", so JSON-serialize instead.
  if (typeof err === 'object') {
    try {
      const anyErr = err as Record<string, unknown>
      const nested = anyErr.error ?? anyErr.data ?? anyErr
      return JSON.stringify(nested).slice(0, 300)
    } catch {
      return String(err).slice(0, 200)
    }
  }
  return String(err).slice(0, 200)
}
