# RAG Backlog: Changes Made

**Date:** 4 October 2026
**Branch:** `feature/nas-rag-content-search`
**Commits:**
- `44bdd48` — large-PDF/OCR extraction, background bylaws backfill (C, D, J)
- `ff0a24f` — scoped NAS backfill, stale-index sweep, retry queue, hybrid
  search, `.docx`, multilingual embeddings (E, F, G, H, I, K)
- `80ea127` — this changes doc
- `32a7587` — GitHub Actions workflow wiring all cron routes
- `6a686c3` — TRIJYA-3 connector deploy runbook

This covers every backlog item from `docs/NAS_RAG_REVIEW.md` / `docs/DAKSH_RAG_HANDOFF.md`
that was picked up, plus the two follow-on infra gaps closed after. Items are
labeled C–K to match those docs.

---

## Round 1 — `44bdd48`

### C — Large PDFs (NBC/standards volumes) were skipped

The NBC volumes (~53MB × 10) and `ARCHITECTURAL STANDARDS` files (~122MB × 2)
exceeded `RAG_MAX_FILE_MB` (20) and were recorded `FAILED`, since Render's
free plan (512MB total) can't safely download/parse them.

**Fix:** the NAS connector (`scripts/nas-connector/connector.py`) gained a new
`GET /extract?server=&path=` endpoint that opens the PDF with PyMuPDF and
extracts text itself, on TRIJYA-3 — which isn't memory-constrained the way
Render is. `lib/nas/client.ts` gained `nasExtractText()` to call it, with
retry/backoff on connector 5xx and a safe fallback (404 = connector not
redeployed yet → treated like today's skip, so this ships safely ahead of
TRIJYA-3 being updated).

### D — Scanned PDFs have no selectable text

**Fix:** same `/extract` endpoint — when direct text extraction yields
nothing, it falls back to per-page OCR via `pytesseract`, capped at
`NAS_OCR_MAX_PAGES` (default 60, since OCR is slow and TRIJYA-3 already runs
a local LLM). The result is tagged `method: 'text' | 'ocr'`; an OCR result
surfaces as a visible warning on the tracker row (same mechanism the
existing truncation warning uses), not silently indistinguishable from a
clean extraction.

### J — The backfill ran inside one HTTP request

A full bylaws sweep could run past a single request's time budget, losing
the final report if it timed out.

**Fix:** `POST /api/nas/bylaws/reindex` now returns a `runId` immediately and
runs the scan in a detached background task (same fire-and-forget shape the
upload route already used), persisting progress after each server. New
`BylawsReindexRun` model tracks `RUNNING`/`DONE`/`FAILED` + results. New
`GET /api/nas/bylaws/reindex?runId=...` polls it.

### Files touched (round 1)
`scripts/nas-connector/connector.py`, `scripts/nas-connector/requirements.txt` (new),
`lib/nas/client.ts`, `lib/rag/index-core.ts`, `lib/rag/index-bylaws-file.ts`,
`app/api/nas/bylaws/reindex/route.ts`, `prisma/schema.prisma`, `.env.example`,
`scripts/test-rag.ts`.

---

## Round 2 — `ff0a24f`

### E — Existing NAS files were never content-indexed

Only files uploaded through Forge were indexed; the NAS's ~327k pre-existing
files were untouched. Indexing everything is too much for the free HF/Qdrant
tiers.

**Fix:** new `POST`/`GET /api/nas/reindex` — admin-triggered backfill scoped
to `NAS_INDEX_FOLDERS` (new env var, comma-separated `server:/path` pairs).
Structurally a twin of the bylaws backfill (new `NasReindexRun` model, same
background-job + poll shape). Unset by default — indexes nothing beyond
Forge uploads until an admin opts folders in.

### F — Deleted/renamed NAS files stayed searchable forever

Nothing removed a file's chunks when it disappeared from the NAS, so Forgie
could cite a superseded document indefinitely.

**Fix:** new `POST /api/cron/rag-stale-sweep`. Added a nullable `lastSeenAt`
column to both tracker tables. The sweep confirms presence via a live
listing and bumps `lastSeenAt`; only prunes `INDEXED` rows not seen for
`RAG_STALE_GRACE_HOURS` (default 48h) — **not** a one-shot diff, since a live
NAS crawl is slow and a partial run must not be mistaken for "file is gone."
Bylaws is swept in full; general NAS only within `NAS_INDEX_FOLDERS` (same
scope E indexes) — nothing outside that scope is ever touched.

### K — No retry for failed or crash-interrupted indexing

**Found along the way:** `PENDING` was dead code — nothing ever wrote it. The
only writer (`tracker.save()` in `lib/rag/index-core.ts`) only ever persisted
`INDEXED` or `FAILED`. A Render restart mid-index left **no row at all**, not
a stuck `PENDING` one — so a naive "retry FAILED/PENDING" job would have
missed the actual crash case entirely.

**Fix:** `markNasPending`/`markBylawsPending` now write a real `PENDING` row
*before* the upload route's fire-and-forget index call starts, closing that
gap. New `POST /api/cron/rag-retry` retries `FAILED` rows and `PENDING` rows
stuck past 10 minutes, capped at `RAG_RETRY_BATCH_SIZE` (default 20) per run.

### H — Paraphrased queries ranked poorly

Vector-only search let exact-keyword near-misses outrank the actual answer
to a paraphrased question (a documented limitation: this model's
relevant/irrelevant score ranges overlap).

**Investigated and rejected:** Qdrant's `MatchText` filter is a boolean
AND-gate, not a blended score; true fused ranking (sparse vectors + BM25 +
RRF) needs a new point schema and a full re-index — disproportionate to the
problem.

**Fix shipped instead:** `searchChunksHybrid()` (`lib/rag/qdrant.ts`) fetches
a larger vector-scored candidate pool, boosts candidates sharing query
keywords (`RAG_KEYWORD_BOOST_WEIGHT`, default 0.15), re-sorts, returns
`limit`. The re-ranking step (`rerankByKeyword`) is a separately exported
pure function, unit-tested without a live Qdrant. Wired into all three
search call sites: `bylaws_search`, `nas_semantic_search`, and
`POST /api/nas/bylaws/search`. Each result now also carries
`matchType: 'vector' | 'hybrid'`.

### I — `.docx` wasn't extracted

**Fix:** added `mammoth`. Confirmed it needs none of `pdf-parse`'s
bundler-workaround trick (plain `import mammoth from 'mammoth'` builds
fine). Wired into both `extractText` (preview) and `extractForIndex`
(indexing) in `lib/nas/extract.ts`.

### G — English-only embeddings (Hindi bylaws unsupported)

**The model assumed from training knowledge turned out to be wrong when
tested live.** `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`
— and every other candidate expected to be a 384-dim drop-in
(`multilingual-e5-small`, `multilingual-e5-base`, `bge-m3`, `LaBSE`,
`distiluse-base-multilingual-cased-v2`, `use-cmlm-multilingual`) — is **not
actually served by HuggingFace's `hf-inference` provider for
feature-extraction today**. Each either 404s or returns a
`SentenceSimilarityPipeline` error, meaning HF hosts it for a different
pipeline than embedding generation.

The one multilingual model that actually works: **`intfloat/multilingual-e5-large`**
— but it's **1024-dim, not 384**, so adopting it is a real Qdrant collection
resize, not the assumed free lunch.

**Calibrated live** against the real HF API with a small English+Hindi
relevant/near-miss/irrelevant passage set (same method as the original 0.50
calibration in `docs/NAS_RAG_REVIEW.md` §9): this model's cosine scores run
much higher overall (irrelevant passages scored 0.70–0.78, higher than
`bge-small-en-v1.5`'s own relevant range), so `RAG_MIN_SCORE` needs to come
up to **~0.80** for it — the highest cutoff keeping all relevant/near-miss
while dropping all irrelevant in the test sample.

**Proved the actual point of the feature works:** a Hindi query finds an
English-indexed passage and vice versa (cross-lingual retrieval), not just
same-language Hindi support.

**Scope of what changed:** flipped in **local `.env` only** (both local
Qdrant collections were empty, so nothing was lost recreating them at
1024-dim). **Not changed in any production config** — no code change was
needed to make the switch *possible* (`HF_EMBEDDING_MODEL`/`HF_EMBEDDING_DIM`
were already fully parameterized); switching the real deployment is a config
decision for whoever has Render access, plus a full re-index afterward.

### Shared groundwork

New `lib/rag/fetch-and-index.ts` — extracts the "fetch a file from the NAS,
falling back to connector-side extraction for oversized PDFs" logic that was
inlined in the bylaws backfill, so E's backfill and K's retry queue don't
duplicate it a third time. The bylaws route was refactored to use it too
(behavior-preserving).

New `lib/nas/index-folders.ts` — parses `NAS_INDEX_FOLDERS`, shared by E's
backfill and F's general-NAS sweep so they always cover the exact same scope.

### Files touched (round 2)
`prisma/schema.prisma` (`lastSeenAt`, `NasReindexRun`), `lib/rag/fetch-and-index.ts` (new),
`lib/nas/index-folders.ts` (new), `lib/rag/index-nas-file.ts`, `lib/rag/index-bylaws-file.ts`,
`app/api/nas/bylaws/reindex/route.ts` (refactored to use the shared helper),
`app/api/nas/reindex/route.ts` (new), `app/api/cron/rag-stale-sweep/route.ts` (new),
`app/api/cron/rag-retry/route.ts` (new), `app/api/nas/upload/route.ts`,
`lib/rag/qdrant.ts` (`searchChunksHybrid`, `rerankByKeyword`),
`app/api/nas/bylaws/search/route.ts`, `lib/assistant/tools/bylaws.ts`, `lib/assistant/tools/nas.ts`,
`lib/nas/extract.ts` (`.docx`), `package.json`/`pnpm-lock.yaml` (`mammoth`),
`.env.example`, local `.env`, `docs/DAKSH_RAG_HANDOFF.md` (§10 addendum), `scripts/test-rag.ts`.

---

## Verification performed

- `npx tsc --noEmit` and `npx next build` clean after every change, both
  rounds — including confirming the three new routes (`/api/nas/reindex`,
  `/api/cron/rag-retry`, `/api/cron/rag-stale-sweep`) appear in the build
  output.
- `npx tsx scripts/test-rag.ts`: **49 passed**, plus 2 pre-existing,
  environment-specific failures in the chunker's subprocess probe
  (confirmed present before any of this work too, via `git stash` — not a
  regression).
- Live, against the real local Qdrant + HuggingFace + Postgres (disposable
  collections/rows, cleaned up after, never written into `nas_documents` /
  `trijya_bylaws`):
  - RAG indexing/search round-trip for both the bytes path and the new
    `preExtracted` (connector text/OCR) path, org isolation, re-index
    pruning.
  - `BylawsReindexRun` / background-job state transitions.
  - `fetchAndIndexFile`'s branch selection and the retry-queue /
    stale-sweep query logic (seeded rows in known states, ran the actual
    Prisma queries the routes use, asserted on results).
  - The multilingual switch end-to-end: English passage, Hindi passage, an
    irrelevant passage; English query, Hindi query, and a **cross-lingual**
    Hindi-query-finds-English-passage case; confirmed `RAG_MIN_SCORE=0.80`
    filters the irrelevant passage from both languages.
- `pnpm db:push` applied to the local dev database (`forge_db_dev`) — not to
  any production database (no access from this environment).

---

## Round 3 — infra follow-ups (`32a7587`, `6a686c3`)

Two gaps surfaced while summarizing the above, both closed as far as this
environment is able to:

### Cron scheduling was never wired, for ANY cron route

Found that nothing triggers any `app/api/cron/*` route in production, not
just the two added this session — the 4 pre-existing ones
(`daily-log-drafts`, `standup-digest`, `project-health`,
`disappearing-cleanup`) were never scheduled either. `.github/workflows/`
only had a `/health` keepalive ping. Already flagged in `SECURITY_TODO.md`
("confirm it's configured, or the jobs silently never fire") and described
as a TODO in `docs/FORGIE_DEPLOYMENT.md` (Option B), but never actually added.

**Fix:** new `.github/workflows/forgie-crons.yml` — one scheduled workflow
triggering all six routes, matched by their exact cron string via
`github.event.schedule` (same pattern the deployment doc already
documented), plus a `workflow_dispatch` input to manually trigger any one of
them for testing. Schedules: the 3 pre-existing routes keep their documented
times, `disappearing-cleanup` every 4 hours, `rag-stale-sweep` daily
(its grace window is 48h, so it doesn't need to run often), `rag-retry`
every 15 minutes (just past its own 10-minute "stuck" threshold).

**Needs one manual step this environment can't do:** add `CRON_SECRET` as a
GitHub repository secret (Settings → Secrets and variables → Actions),
matching the `CRON_SECRET` env var already set on Render. Without it every
run in this workflow fails auth harmlessly (it just won't reach the app).

### TRIJYA-3 connector still needs a human to deploy it

Confirmed there's no SSH/VPN path to TRIJYA-3 from this environment
(`TRIJYA_NAS_BASE_URL` is unset locally, no SSH config entry, no
`cloudflared` installed), and no deploy script or service file exists
anywhere in this repo for the connector — it's a fully manual process today.

**Fix:** wrote `docs/TRIJYA_CONNECTOR_DEPLOY.md` — a step-by-step runbook
for whoever has access to the box: pull the code, `pip install -r
requirements.txt` (adds `pymupdf`/`pytesseract`, new this session) + the
system `tesseract-ocr` binary, restart however the connector is currently
run, smoke-test `/extract` against a real oversized bylaws PDF, then run the
actual backfill. No code change was needed to make this safe to deploy
whenever — `nasExtractText` already treats a 404 on `/extract` as
"not available yet."

## Not done — needs infra access this environment doesn't have

- **TRIJYA-3 connector redeploy.** A runbook now exists
  (`docs/TRIJYA_CONNECTOR_DEPLOY.md`), but someone with access to the box
  still has to actually run it.
- **Production database migration.** `BylawsReindexRun`, `NasReindexRun`, and
  the new `lastSeenAt` columns only exist in the local dev database. They
  need the same manual creation in production Postgres that
  `NasIndexedFile`/`BylawsIndexedFile` already got.
- **The `CRON_SECRET` GitHub repository secret.** The workflow that uses it
  is written and pushed; the secret itself has to be added via the GitHub
  web UI (Settings → Secrets and variables → Actions).
- **Production embedding model switch (G).** Local `.env` only. Switching the
  real deployment to `intfloat/multilingual-e5-large` needs the same env
  vars set on Render, plus a full re-index afterward.
