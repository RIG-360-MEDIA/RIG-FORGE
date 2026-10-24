# Chat Answers from the Bylaws and NAS Documents: Changes (18 Oct 2026)

Branch `feature/nas-rag-content-search` (`c58ac26`, `be77de1`), merged into `main` on 18 Oct with the review fixes in section 11.
Addresses open issue 2 in [`RAG_CHANGES_OCT_2026.md`](RAG_CHANGES_OCT_2026.md) ("Forgie chat does not answer bylaws questions").

---

## Files

| File | Change |
|---|---|
| `lib/rag/answer.ts` | **New.** Routing, query building for follow-ups, retrieval, answer prompt, source list |
| `app/api/assistant/message/route.ts` | New document-answer step before the fast-lanes and the reply cache; NAS read path uses the shared retry helper |
| `app/api/nas/bylaws/answer/route.ts` | **New.** `POST` endpoint for the Bylaws tab: passages + written answer, streamed |
| `components/workspace/BylawsPanel.tsx` | Calls the new endpoint; shows the answer above numbered passage cards |
| `lib/llm/stream.ts` | `temperature` and `maxOutputTokens` options; new `streamPlainAnswer()` helper |
| `scripts/test-rag.ts` | 30 new offline checks |
| `docs/RAG_CHANGES_OCT_2026.md` | Status note under open issue 2 |
| `lib/llm/provider.ts` | New `openai` provider, first in the default order |
| `package.json`, `pnpm-lock.yaml` | New dependency `@ai-sdk/openai` ^3.0.130 |
| `.env.example`, `docs/FORGIE_DEPLOYMENT.md` | `OPENAI_API_KEYS`, `OPENAI_MODEL`, new provider order |

---

## 1. Chat flow (`app/api/assistant/message/route.ts`)

New step, runs right after the rate-limit gate, **before** the NAS filename fast-lane, the people fast-lane, the NAS read path and the reply cache:

1. `prepareDocumentAnswer()`: only for the NAS-owning org, and only when the bylaws or NAS index is configured.
   - Decides the source with `ragSourceFor()` (`bylaws`, `nas` or none).
   - If none, but the previous assistant turn was a document search and this message is a follow-up, uses the same source.
   - Builds the search text with `searchQueryFor()` and runs `retrieve()`.
   - Returns null (normal path continues) when the message is not a document question, the search throws, or the NAS search finds nothing.
2. `streamDocumentAnswer()`:
   - No passages (bylaws): fixed "not found" message, no LLM call.
   - Otherwise one LLM call **with no tools**: temperature 0.2, max 1200 output tokens.
   - Provider order: `local` moved to the back, unless `RAG_ANSWER_LOCAL_FIRST=true`.
   - If no provider answers, the top 3 passages are shown instead.
   - Appends the source list.
3. The reply is saved with `toolCalls: [{ name: 'bylaws_search' | 'nas_semantic_search', args: { query } }]`. The next turn reads this to detect follow-ups.
4. These replies are **not** written to the reply cache.

Other changes in the route:
- The NAS read path (`tryNasReadIntent`) now uses `streamPlainAnswer()` in place of its own retry loop.
- Bug fix: the "couldn't read it just now" message was saved but never sent to the client. It is now sent.

---

## 2. Routing rules (`lib/rag/answer.ts`)

**Never routed:** messages starting with an action verb (create, add, assign, schedule, send, email, update, delete, upload, ...).

**Bylaws**, any of:
- a bylaws word: bylaw / byelaw, NBC, national building code, building code, zoning, ordinance, government order, master plan, fire exit/escape/safety/NOC, plinth, mumty, open space, and Hindi equivalents;
- a specific topic from `query-match.ts`: FAR, setback, ground coverage, staircase, basement, ventilation;
- an ambiguous topic (parking, height, road) together with a use, a plot area / height / road width, or a rule word (minimum, maximum, required, permissible, norms, rules, न्यूनतम, अधिकतम, ...). Questions starting with "where" are excluded.

**NAS documents:**
- needs a document word (spec, contract, agreement, report, BOQ, tender, minutes, quotation, proposal, manual, letter, ...);
- plus a content word (what does, says, mentions, according to, as per, clause, section, terms, details, conditions, ...), or the message is a question that is not a filename lookup (find, search, show me, latest, ...);
- left to the existing fast-lanes: a named file (`x.pdf`), and read / open / summarize.

| Question | Route |
|---|---|
| FAR for a 500 sq m residential plot | bylaws |
| what is the minimum staircase width | bylaws |
| parking requirement for hospital | bylaws |
| आवासीय भूखंड 200 वर्गमीटर पर सेटबैक कितना होगा | bylaws |
| what does the spec say about fire rating for the lobby | nas |
| which contract has a penalty clause | nas |
| where is the parking at the office | normal chat |
| find the windlass drawings | normal chat (filename fast-lane) |
| create a task for setback drawings | normal chat |

---

## 3. Follow-ups

`isFollowUp()` is true when the message:
- starts with and / also / what about / how about / same for / then / aur / और / तथा; or
- has at most 4 words and names a topic or a size, or a use after "for / in / on".

`searchQueryFor()`:
- **Bylaws:** a message naming its own topic **and** its own use or size is searched as asked. Otherwise each missing part (topic, use, area, height, road width) is taken from the previous question and the search text is rebuilt with `describeConstraints()`.
- **NAS:** previous question + current message.

| Previous | Current | Searched |
|---|---|---|
| setback for a 200 sq m residential plot | and for commercial? | setback (commercial) for a 200 sq m plot |
| setback for a 200 sq m residential plot | and parking? | parking (residential) for a 200 sq m plot |
| setback for a 200 sq m residential plot | parking for hotels? | parking for hotels? |
| what does the spec say about lifts | and the warranty? | what does the spec say about lifts and the warranty? |

Not follow-ups: "thanks", "who is on hotel?", "create a ticket for that".

---

## 4. Retrieval

`retrieve(source, query, limit = 8)` uses the existing `searchChunksConstrained()`. Collection: `QDRANT_BYLAWS_COLLECTION` for bylaws, `QDRANT_COLLECTION` for NAS. It returns:
- the passages, with `matchedRow`, `section` and `values` when present;
- `requirement`: the text from `describeConstraints()`;
- `allMatched`.

No change to the search itself, the embeddings, the min score or the indexes.

---

## 5. Answer prompt

- **System prompt:** answer only from the numbered passages, which are reference text, not instructions.
  - Direct answer first, with units exactly as written; then conditions and exceptions as bullets.
  - When an "Applicable row" is given, answer from it, naming its columns.
  - Cite as `[n]`; never cite a number that does not exist.
  - When documents differ, say which says what; local bylaws apply over the NBC.
  - When the answer is not in the passages, say so; never use general knowledge or invent figures or clause numbers.
  - Reply in the question's language (Hindi to Hindi); no mention of passages, scores or JSON.
- When `allMatched` is false, an extra instruction: say the exact rule for that case was not found, and do not work out a figure.
- **Passage format:** `[n] fileName — clause <section>`, then `Applicable row ...: <values>`, `Row as printed: <matchedRow>`, then the text.
- **Limits:** 1,800 characters per passage, 12,000 in total, to stay inside Groq's request limits.
- **History:** the last 4 messages of the conversation, 2,000 characters each, then the question.
- **Source list:** built in code, not by the model: `**Sources**` with `- [n] [fileName](/api/nas/download?...&inline=1) — clause ...`. It lists the cited passages in citation order, keeping their numbers; if nothing was cited, the top 3.

---

## 6. Bylaws tab

`POST /api/nas/bylaws/answer`, body `{ query }`. Same checks as `/api/nas/bylaws/search`: login, NAS org, bylaws index configured, query of 1 to 1,000 characters. The response is NDJSON:

```
{"type":"matches","requirement":...,"allMatched":...,"matches":[...]}   first
{"type":"text","delta":"..."}                                          answer, streamed
{"type":"done","provider":...,"model":...}                             last
{"type":"error","error":"..."}                                         only if writing the answer fails
```

When `ASSISTANT_ENABLED` is off or there are no passages, only `matches` and `done` are sent.

`/api/nas/bylaws/search` is unchanged; the eval scripts still use it.

`BylawsPanel.tsx`:
- reads the stream and shows the passages as soon as they arrive, then the answer, rendered as markdown, above them;
- numbers the passage cards `[1]`, `[2]`, ... to match the citations;
- a newer search or "clear" stops an older one from writing into the panel.

---

## 7. `lib/llm/stream.ts`

- `StreamOptions` gains `temperature` (default 0.85, as before) and `maxOutputTokens` (default `ASSISTANT_MAX_OUTPUT_TOKENS`, as before).
- `streamPlainAnswer(messages, options, emit)`: one no-tools generation with up to 8 attempts across providers.
  - Moves to the next provider when one fails or returns no text before anything was shown.
  - Keeps partial text once something has been streamed.
  - Request-too-large errors cool the whole provider; other errors cool only that key.
  - Used by the chat document answers, the NAS read path and the Bylaws tab.

---

## 8. New setting

| Variable | Default | Effect |
|---|---|---|
| `RAG_ANSWER_LOCAL_FIRST` | unset (false) | `true` keeps the normal provider order (local model first) for document answers. Unset: Groq, Gemini, Cerebras, then local. Decides whether bylaws/document text goes to cloud providers (open issue 3). |

---

## 9. OpenAI as the chat model (`lib/llm/provider.ts`)

- New provider `openai`, built with the official `@ai-sdk/openai` package (Responses API). Unlike the OpenAI-compatible client, it drops settings that reasoning models (gpt-5 family) reject, such as temperature, instead of failing the call.
- Same key pool as the other providers: comma-separated `OPENAI_API_KEYS`, round-robin, 60 s cooldown on a failed key.
- Model: `OPENAI_MODEL`, default `gpt-4.1-mini`.
- Default `ASSISTANT_PROVIDER_ORDER` is now `openai,local,groq,gemini,cerebras`. A provider without keys is skipped.
- OpenAI is never pushed to the back: tool questions push back local + Groq, document answers push back local, so OpenAI answers all of them first.
- If OpenAI fails (bad key, rate limit, outage), the next provider answers, as before.

| Variable | Default | Effect |
|---|---|---|
| `OPENAI_API_KEYS` (or `OPENAI_API_KEY`) | unset | OpenAI keys, comma-separated. Unset: OpenAI is not used. |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Any OpenAI chat model id |
| `ASSISTANT_PROVIDER_ORDER` | `openai,local,groq,gemini,cerebras` | **Render sets this explicitly**, so it must be changed there to put `openai` first |

Checked offline with a fake key and a stubbed `fetch`:
- order: `openai,local,groq,gemini,cerebras`; first pick `openai / gpt-4.1-mini`, also when local + Groq are pushed back;
- the request goes to `https://api.openai.com/v1/responses` with temperature 0.2 and max 1200 output tokens;
- on a 401 the call moves on to Groq.

Live check (18 Oct): one request through `streamPlainAnswer()` answered by `openai / gpt-4.1-mini` in 3.2 s.

## 10. Testing

- `npx tsc --noEmit`: passes (after `npx prisma generate` for the schema on `main`).
- `npx tsx scripts/test-rag.ts`: 180 passed, 2 failed. The 2 failures (chunker "overlap == target" / "overlap > target") also fail on unmodified `main`.
- New checks cover:
  - the routing cases above, and that nothing is routed when the index is off;
  - follow-up detection and query merging;
  - passage numbering, the length limits and the "not found together" instruction in the prompt;
  - message order;
  - the source list format, citation order, and the top-3 fallback.
- **Not tested against the live index.** The local `.env` points at a Qdrant on `localhost:6336`, which was not running, and the HuggingFace embedding fallback is out of credits (402). To test: run with the production Qdrant and connector settings, then ask in chat "What is the FAR for a 500 sq m residential plot?" followed by "and for commercial?", and compare with the Bylaws tab.

## 11. Review at merge (18 Oct)

Merged into `main` after review and a test against the production index. The design is kept as written; these were changed on top of it, each with checks in `scripts/test-rag.ts` (202 pass).

**Lockfile.** `pnpm-lock.yaml` had `@ai-sdk/openai` with specifier `^3` while `package.json` says `^3.0.130`. A frozen install (pnpm 9, as on Render) failed with `ERR_PNPM_OUTDATED_LOCKFILE`. Only that line was changed.

**Routing** (`ragSourceFor`). Every chat message of the NAS company passes through it before anything else. On 20 everyday messages it sent 12 to the bylaws or the NAS index, e.g.:
- "how far along is the Kudal project?" ("far" read as FAR);
- "we had a setback on the IT park site"; "what is the insurance coverage for the site workers";
- "can we go to the site tomorrow" (`g\.?o\.?` matched "go");
- "what files did Anjana upload today", "what are my notes for today".

Now:
- **FAR** routes only in capitals or spelt out ("floor area ratio"), or with a size ("far 2000 sqm").
- **Other topics** need a use, a size, a rule word or a bylaws word.
- **Messages about work** (tasks, status, progress, "who is working on", ...) are not routed unless they name the bylaws or give a size.
- **"G.O."** needs its dots; "ECS" counts as a bylaws word.
- **General document words** (files, documents, notes, letters) route only with a content question ("what does the document say about ..."), and never for who uploaded or sent something.

Result: 0 of the 20 everyday messages routed; all 77 real questions of `scripts/bylaws-eval/cases.mjs` route to the bylaws; the 4 nonsense ones do not.

**Answers cut off.** With `maxOutputTokens: 1200`, 4 of 12 real answers stopped mid-sentence: Gemini Flash spends 200 to 900 tokens reasoning first and they count against the limit. Now `ANSWER_MAX_OUTPUT_TOKENS` (4000; `RAG_ANSWER_MAX_OUTPUT_TOKENS`), used by the chat and the Bylaws tab.

**Follow-ups answered about the previous question.** "and for commercial?" was searched correctly ("setback (commercial) for a 200 sq m plot") but the model got only "and for commercial?" and answered about residential plots. The model now gets the merged question too (`questionForAnswer`), and the prompt says to answer only the latest question.

**Reference books as rules.** "parking for a shopping mall" listed Time-Saver Standards' "3 to 9 car spaces per 1,000 sq ft" next to the bylaw. Passages are now labelled with their kind (`documentPriority`): design reference books "guidance, not a rule", the model bye-laws "not in force", the NBC. The prompt says never to present guidance as the requirement.

**Tested against the production index** (bylaws through Gemini as in production; NAS documents through the local model only). 12 of 12 answers had the right figures and were complete:
- setback for 200 sq m residential; follow-ups "and for commercial?" and "and parking?";
- FAR for 2000 sq m; minimum staircase width; hospital on 1500 sq m; building height 40 m;
- FAR for shops on an 18 m road; parking for a shopping mall; group housing height;
- Hindi setback for 200 sq m (answered in Hindi);
- hospital FAR on a 2000 sq m plot (correctly says the exact rule is not in the bylaws);
- "what does the BOQ say about flooring rates".

Latency: 7 to 14 s per answer, mostly Gemini's reasoning.

**After the first live deploy (same day).** In production the answers were slow (up to 100 s) or written by the local 3B model, which misread "a >12 - 24 m road" as "12 - 24 m from the road". Checked each provider's keys directly:
- **Groq:** `GROQ_MODEL=llama-3.3-70b-versatile` no longer exists on Groq (it offers `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, ...), and key 2 of 5 is invalid. Every Groq call fails.
- **Gemini:** key 1 of 5 is out of quota; the others answered "Say OK" in 29 to 53 s that day.
- **Cerebras:** every key now returns "Payment Required".

Changes on top:
- **No local model for regulation answers.** `answerProviders()` leaves the local model out of document answers. A new `exclude` option in `selectNextModel` / `startStream` makes that possible. With no cloud model, the passages are shown instead. `RAG_ANSWER_LOCAL_FIRST=true` still keeps answers on the local model.
- **Reply language set in code:** Hindi only for a question written in Devanagari. `gpt-oss` answered English questions in Hindi when the passages were Hindi.
- **`【1】` citations** (as `gpt-oss` writes them) count like `[1]` for the source list.

With `GROQ_MODEL=openai/gpt-oss-120b`, the 12 production-index questions: 11 with the expected figures, 2 to 5 s each. Gemini: 12 of 12, 7 to 25 s.

**Found while testing, not caused by this branch:** the production Groq settings fail on every call: one key is invalid, and the others answer "model `llama-3.3-70b-versatile` does not exist or you do not have access to it". Every cloud answer falls through to Gemini. Check the keys and the model id on Render.

**Still Kavya's decision** (`RAG_CHANGES_OCT_2026.md` issue 3): document answers go to the cloud providers first. For NAS documents that means company file text goes to Gemini, or to OpenAI once its key and `openai` in `ASSISTANT_PROVIDER_ORDER` are set on Render. `RAG_ANSWER_LOCAL_FIRST=true` keeps them on the local model.

---

## 12. Exact source text: key lines, whole passage, full page (24 Oct)

Each source under a chat answer now shows the exact words the answer came from, so it can be checked against the document without searching hundreds of pages.

**In the chat** (`sourcesFooter()` in `lib/rag/answer.ts`), under each cited source:
- a quote of the **key lines**, copied verbatim from the passage by `keyLines()`, never from the answer:
  - the matched table row (rejoined when the PDF split it over two lines);
  - that table's column-heading line and the clause heading;
  - other lines holding at least two of the figures, or a figure and two words, from the answer's sentences that cite this source.
  Lines appear in document order, separate places are joined by ` … `, and the quote is at most 400 characters.
- a **Show passage and page** link to the source view.

Example:
```
- [1] Bylaws_160425.pdf — clause 3.2.2.1 Residential – Plotted Development …
  > 3.2.2.1 Residential – Plotted Development … Sl. Plot Size (sqm) … Base FAR Max. FAR … 4 >1200 1.25 2.0
  Show passage and page
```

**Source view** `/dashboard/source?c=bylaws|nas&s=<server>&p=<path>&i=<chunkIndex>&k=<key lines>` (`app/dashboard/source/page.tsx`, API `GET /api/nas/source`):
- the key lines, the **whole passage** with them highlighted, and the **full PDF page** it is on, also highlighted;
- an **Open PDF at page N** button (`#page=N`, which Chrome's PDF viewer honours);
- the passage is loaded by its id, `getPassage()` in `lib/rag/qdrant.ts`. The id includes the organisation, and the payload's organisation is checked again.
- When the page cannot be found, the view shows the passage and says why: a scanned page that was OCR'd at index time (no text layer to match), a Word or Excel file, or the connector unreachable or not yet updated.

**Bylaws tab:** each passage card has a **Show page in the PDF** link to the same view.

**Connector** (`scripts/nas-connector/connector.py`): new `POST /locate` `{server, path, anchors}`.
- It reads the PDF's pages with PyMuPDF and returns the page containing the most anchors, with that page's text (12,000 characters at most), matching without regard to whitespace or case.
- The page texts of the last 4 documents (`NAS_LOCATE_CACHE_DOCS`) are cached by size and modification time.
- It never errors for a document problem: it returns `{page: null, reason}` instead.
- Forge calls it through `nasLocate()` in `lib/nas/client.ts` (90 s, `NAS_LOCATE_TIMEOUT_MS`). A 404 from an older connector gives no page, not a failure.
- **Needs a connector restart on TRIJYA-3** (`TRIJYA_CONNECTOR_DEPLOY.md`). There are no new Python dependencies. Until the restart, the view shows the key lines and the passage, without the page.

**Shared:** `lib/rag/highlight.ts` (whitespace-tolerant phrase finding, used by the chat, the source view and the Bylaws tab) and `components/workspace/MarkedText.tsx`. `RagPassage` now carries `chunkIndex`. Links escape `(` and `)`, so a file name like `Bylaws (2016).pdf` no longer ends a markdown link early. Chat quotes render as plain document text (no italics or quote marks).

**Tested:**
- `scripts/test-rag.ts`: 222 pass, plus the 2 known chunker failures. New checks cover the key lines (row, headings, verbatim, order, length, fallbacks), the footer format, the escaping of `(` and `)`, and `nasLocate` returning null on a 404.
- `/locate` was run against a generated 3-page PDF with the connector's NAS connection stubbed:
  - the FAR row split over two lines was found on page 2;
  - text not in the PDF, a Word file, too-short anchors and an unreachable NAS each returned a reason;
  - four lookups downloaded the file once.
- The footer markdown was rendered through the chat's ReactMarkdown setup.
- **Not yet tested** against the production index and TRIJYA-3.
