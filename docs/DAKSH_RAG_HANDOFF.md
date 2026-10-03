# NAS + Bylaws Search: Status and Handoff for Daksh

**Date:** 3 October 2026
**Your branch:** `feature/nas-rag-content-search`, now merged into `main`
**Read with:** [`NAS_RAG_REVIEW.md`](NAS_RAG_REVIEW.md) (2 October). It explains every
fix in detail. This document covers what has happened since, the current state, and
everything still open.

---

## 1. Summary

- **Your design is unchanged.** Qdrant stays as the vector store. We looked at
  pgvector and decided against it: your system stays exactly as you built it.
- **A Qdrant Cloud cluster now exists**, and your code works against it live.
  Everything that could only be checked by reading code on 2 October has now been
  run for real and passes.
- **Your branch is merged into `main`.** It is deployed but **switched off**. It
  turns on once the Render settings are added and production is on the new
  database (section 5).
- **The search is still empty.** No file has been indexed for real yet. The bylaws
  backfill runs once the switch-on steps are done.

---

## 2. Everything changed in your code

Your two commits were `5331cd3` (6 Aug) and `e80fa38` (24 Sep). After that:

| Commit | Date | What |
|---|---|---|
| `b803db2` | 2 Oct | Merged `main` into your branch. One conflict, in `TENANT_MODELS` in `lib/db.ts`: both sides added names to the same line. Resolved by keeping both. |
| `775e152` | 2 Oct | Bug fixes. Full detail in `NAS_RAG_REVIEW.md`. One line each below. |
| `4e25c63` | 2 Oct | `docs/NAS_RAG_REVIEW.md` and the regression suite `scripts/test-rag.ts`. |
| (this doc) | 3 Oct | This handoff. **No code changes on 3 October.** |

### The fixes in `775e152`

| # | Problem | Fix | Severity |
|---|---|---|---|
| 1 | Bylaws folder never found: `Trijya Projects` is the SMB share name, not a folder, so 0 of 10 real paths matched | That segment is now optional; also accepts `Bye-Laws` / `Byelaws` | High |
| 2 | Files cut at 8 MB, which corrupts PDFs, and the whole file was loaded into memory first | New `nasFetchBytesStrict` streams with a byte limit and refuses oversized files instead of cutting them | High |
| 3 | Only the first 12,000 characters of each document were indexed | New `extractForIndex()`, up to 1,000,000 characters | High |
| 4 | Extraction error messages were embedded as if they were document text | Failures are recorded as `FAILED` with the reason | High |
| 5 | HuggingFace 429 not retried; unlimited parallel requests | Retries with backoff; at most 2 requests at once, without starving live searches | High |
| 6 | Wrong vector size gave an unclear Qdrant error | Clear error naming the setting to change | Medium |
| 7 | Re-indexing deleted a file's chunks first, so a failure lost the file | Upsert first, then remove only the leftover tail (`pruneStaleChunks`) | Medium |
| 8 | No payload indexes, so every filter scanned the whole collection | Indexes on `organizationId`, `server`, `path`, `chunkIndex` | Medium |
| 9 | No minimum relevance score, so unrelated passages got cited | `RAG_MIN_SCORE`, default 0.50, calibrated on real scores | Medium |
| 10 | Backfill counted failed files as indexed | Indexers return a real outcome; the route reports each category | Medium |
| 11 | `chunkText` could loop forever; search route leaked error text and accepted `NaN` limits | Guarded and sanitised | Low |

Structure change: the two indexers were hand-synced copies. The shared flow now
lives once, in `lib/rag/index-core.ts`. The exported function signatures did not
change.

---

## 3. What happened since 2 October

### Qdrant Cloud cluster

- Created on Qdrant Cloud: GCP `australia-southeast1`, Qdrant 1.19.1.
- **The URL and API key will be shared with you separately.** They are not in
  this repository and must never be committed.
- The cluster is **empty**. Your code creates `nas_documents` and
  `trijya_bylaws` itself, on the first index.

### Database move

- Production is moving to a new Supabase project.
- Your `NasIndexedFile` and `BylawsIndexedFile` tables and the `NasIndexStatus`
  enum have been **created in the new database**, generated from your Prisma
  schema. Both tables are empty.
- The **old database does not have them.** That is why indexing must wait for
  the database switch (section 5).
- pgvector happens to be installed in the new database. It is **not used** by
  your system.

### Company filtering change in `lib/db.ts` (coming soon, affects you)

We found and fixed a leak: lookups by ID (`findUnique`, `update`, `delete`,
`upsert`) were not filtered by company, so one company could read another's
records by ID. The fix, on branch `fix/scope-unique-lookups` and deploying next,
filters those lookups by the signed-in user's company.

**Your code is not affected:**
- Your trackers pass `organizationId` explicitly inside the unique key.
- Every Qdrant query already filters on `organizationId`.

Keep doing exactly that. **Any new raw SQL or Qdrant query must include the
company explicitly.** Neither goes through the Prisma extension, so neither is
filtered automatically.

---

## 4. Verification run on 3 October

| Check | Result |
|---|---|
| `scripts/test-rag.ts` (offline suite) | 35 / 35 |
| Live: your unmodified code, real HuggingFace embeddings, real Qdrant Cloud, temporary collections (deleted afterwards) | 9 / 9 |
| Live: the three fixes not run on 2 Oct (7, 8, 9), which was P0 item B | 7 / 7 |
| `tsc --noEmit` | Clean |
| `next build` | Succeeds |

What the live runs proved:

- **Search quality:** "minimum front setback for a large plot" found the right
  bylaw first, with a score of 0.85.
- **Company isolation:** rig360 searches never return Trijya chunks, and Trijya
  searches never return rig360 chunks.
- **Two separate stores:** the NAS and bylaws collections are independent.
- **Re-indexing:**
  - The same file overwrites in place, with no duplicates.
  - A shorter version (5 chunks, then 2) removes the 3 extra chunks and leaves
    other files untouched.
- **Collection setup:** collections are created at 384 dimensions, cosine, with
  all four payload indexes.
- **Junk filter:** an unrelated query ("chocolate cake recipe") returns 0
  passages, while a related one returns 5.
- **Speed:** embedding plus storing 6 small files took about 7 seconds.

**P0 item B from the 2 October document is closed.**

---

## 5. Getting it switched on

| Step | Who | State |
|---|---|---|
| Qdrant Cloud cluster | Kavya | Done |
| Tables in the new database | Us | Done |
| Merge into `main` | Us | Done (3 Oct); deployed but switched off |
| Production switched to the new database | Kavya + us | **Pending** |
| Render settings on the `rig-forge` service: `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION`, `QDRANT_BYLAWS_COLLECTION`, `HF_API_KEY`, `HF_EMBEDDING_MODEL`, `HF_EMBEDDING_DIM` | Kavya | **Pending** |
| First bylaws backfill: `POST /api/nas/bylaws/reindex` as an admin, then check the `failed` list | Us | **Pending** |
| Test `bylaws_search` and `nas_semantic_search` from Forgie | Us, then you | **Pending** |

**Why deploying now is safe:**
- With the Render settings missing, every indexing and search path is switched
  off.
- If indexing fails for any reason, uploads still succeed. It runs
  fire-and-forget, and its errors are caught.

**Do not add the Render settings before the database switch.** If you do, every
upload tries to write to tables the old database does not have. Uploads would
still work, but every file would fail to index.

---

## 6. Open issues in the system

Nothing below is fixed. Priorities are our suggestion; tell us if you see it
differently. The letters match `NAS_RAG_REVIEW.md`.

### P1: make the bylaws actually searchable

**C. Large PDFs are skipped.**
- With `RAG_MAX_FILE_MB=20`, which is sized for Render's 512 MB, these are
  skipped and recorded as `FAILED`:
  - the 10 NBC volumes (about 53 MB each)
  - the 2 `ARCHITECTURAL STANDARDS` files (about 122 MB each)
- That is most of the 830 MB bylaws folder.
- **Recommended:** extract the text on the connector on TRIJYA-3 (for example
  with `pdftotext`), and have Forge fetch text instead of PDF bytes.
- *Done when:* the NBC volumes are indexed and Render's memory stays well below
  its limit.

**D. Scanned PDFs have no text.**
- They are recorded as `FAILED: PDF has no selectable text (likely scanned
  images; needs OCR)`.
- Count them after the first backfill, and add OCR if there are many. Doing it on
  the connector keeps the load off Render.
- *Done when:* scans are searchable, or we have agreed they don't need to be.

### P2: coverage and quality

**E. Existing NAS files are not content-indexed.**
- Only files uploaded through Forge after go-live are indexed.
- Most of the roughly 327,000 files arrive over SMB, so `nas_semantic_search`
  covers very little.
- Please propose a scope, for example certain folders or document types. Indexing
  everything is likely too much for the free HuggingFace and Qdrant tiers.

**F. Deleted or renamed files stay searchable.**
- Nothing removes their chunks, so Forgie could cite a superseded regulation.
- Fix: a periodic sweep that compares the index against the folder listing.

**G. Hindi bylaws.**
- `bge-small-en-v1.5` is English-only, and at least one bylaw is a Hindi
  government order.
- A multilingual 384-dimension model avoids recreating the collections. Any model
  change still needs a full re-index and a re-calibration of `RAG_MIN_SCORE`.

**H. Paraphrased questions rank poorly.**
- Example: "how far from the road must a house be built" ranked height rules
  above the setback rules that actually answer it.
- Relevant and irrelevant scores overlap (worst relevant 0.517, best irrelevant
  0.561), so the minimum score is only a junk filter.
- A hybrid search (keyword plus vector) would help.

**I. `.docx` is not extracted.**
- It needs a new dependency, for example `mammoth`.
- Low priority: there are no `.docx` files in the bylaws folder today.

**J. The backfill runs inside one HTTP request.**
- It is safe: re-running skips unchanged files.
- But if the request times out, the admin never sees the final result. A
  background job plus a status endpoint would be cleaner.

**K. No queue for upload-triggered indexing.** (New since 2 Oct.)
- If Render restarts while a file is being indexed, that file stays unindexed
  until someone re-runs the index. Nothing retries it automatically.
- A small queue, or a periodic retry of `PENDING` and `FAILED` rows, would fix it.

**L. Depends on free outside services.** (New since 2 Oct.)
- HuggingFace's free inference API has rate limits and slow first requests after
  idle time.
- The Qdrant Cloud free tier has limits on size and on idle clusters. Check what
  happens to an idle free cluster on their current terms, so the index doesn't
  silently disappear.

### Small

**M. `BylawsIndexedFile` defaults to `"trijya"`.** Every other table defaults to
`"rig360"`. We are keeping it, since bylaws are Trijya-only. It is the same
misfiling risk if another company ever uses that table.

### For awareness, not in your code

See section "Other issues found" in `NAS_RAG_REVIEW.md` for detail.

- **TRIJYA-3 is overloaded** (Ollama `qwen3:14b`). The old filename search index
  is empty (0 of 327,067 files), and Forgie answers through Gemini at 10–30 s.
- **`nas_read` still cuts files at 8 MB**, so large PDFs fail to read in Forgie.
- **Forgie misses some file searches.** "find byelaws" never searched, because the
  fast lane needs a file-type word.
- **Keyword search misses spelling variants:** "bylaws" does not match "by laws".
- **Short, truncated Hindi answers can be cached** for 5 minutes.
- **`next build` can fail on a Google Fonts hiccup.** A retry fixes it.

---

## 7. Questions for you

None of these were answered since 2 October:

1. How did `Trijya Projects` end up in the path you tested with? Is the bylaws
   folder laid out the same way on every drive?
2. Does your local Qdrant (`localhost:6336`) hold anything worth keeping? We
   assume not: the cloud cluster starts empty and gets re-indexed.
3. Are the Ollama models `qwen3-nl`, `gpt-oss-nl` and `forgie` on TRIJYA-3 yours?
   Is anything of yours running long jobs there?
4. Did you intend `nas_semantic_search` to cover files already on the NAS (E)?
5. Roughly how many bylaws are Hindi, and how many are scans? That decides
   whether D or G comes first.

---

## 8. What we need back from you

- Your review of `775e152`: agree, disagree, or changes. The biggest change is
  the `index-core.ts` refactor.
- Answers to the 5 questions.
- Which of C to L you will take, and in what order.
- Anything you need from us to do them: access, credentials, decisions,
  infrastructure. Please list it explicitly.

---

## 9. Working on it

- **Branch from `main` now,** not from your old branch. It has everything.
- **Run the offline suite** (no network needed):

  ```bash
  npx tsx scripts/test-rag.ts
  ```

  Expected result: `35 passed, 0 failed`.
- **For live tests,** use a temporary collection name (for example
  `_selftest_<name>`) and delete it afterwards. Never write test data into
  `nas_documents` or `trijya_bylaws`.
- **Testing anything company-related locally:** use a production build
  (`next build`, then `next start`). The dev server (`next dev`) ignores company
  separation.
- **Never commit keys.** The HuggingFace key and the Qdrant key were both shared
  in chat. Both will be rotated after go-live, and you will get the new ones
  separately.

---

## 10. Addendum — 4 October 2026: C/D/J shipped, E/F/G/H/I/K this round

C (large-PDF connector extraction), D (OCR fallback) and J (background
backfill) shipped on this branch (commit `44bdd48`). This addendum covers the
rest of the backlog from section 6: E, F, G, H, I and K. The offline suite
(`npx tsx scripts/test-rag.ts`) now has more cases than the `35 passed, 0
failed` quoted above — expect **49 passed**, plus 2 known-unrelated failures
in the chunker's subprocess probe (an environment quirk with spawning `tsx`
as a child process, confirmed present before any of this round's changes too
— not a regression).

**E — general-NAS backfill, scoped.** New `POST`/`GET /api/nas/reindex`,
structurally identical to the bylaws backfill but iterating `NAS_INDEX_FOLDERS`
(a new env var — comma-separated `server:/path` pairs) instead of
auto-discovering a folder. Indexing the whole NAS is still not attempted —
you opt specific folders in. Tracked via a new `NasReindexRun` model, a twin
of `BylawsReindexRun`.

**F — stale-index sweep.** New `POST /api/cron/rag-stale-sweep` (needs the
same external-scheduler wiring as the other `app/api/cron/*` routes — see the
note in section 6/K below, this still isn't actually scheduled anywhere).
Mark-and-sweep, not a one-shot diff: added a nullable `lastSeenAt` column to
both tracker tables, bumped on every file a live crawl actually confirms, and
only prunes `INDEXED` rows not seen for `RAG_STALE_GRACE_HOURS` (default 48h)
— a slow or partial crawl can't cause a false delete. Bylaws is swept in
full; general NAS only within `NAS_INDEX_FOLDERS` (same scope E indexes) —
nothing outside that scope is ever touched, so an ad-hoc Forge upload to some
other folder is unaffected either way.

**K — retry queue.** Found that `PENDING` was dead code — nothing ever wrote
it, so a Render restart mid-index left no row at all, not a stuck `PENDING`
one. Fixed by writing a real `PENDING` row (`markNasPending`/
`markBylawsPending`) *before* the upload route's fire-and-forget index call
starts. New `POST /api/cron/rag-retry` then retries `FAILED` rows and
`PENDING` rows stuck past 10 minutes, capped at `RAG_RETRY_BATCH_SIZE`
(default 20) per run.

**H — hybrid search.** Qdrant's `MatchText` filter turned out to be a boolean
AND-gate, not a blended score, and true fused ranking needs sparse-vector
infra (new point fields, a BM25 embedder, a full re-index). Went with a
lighter fix instead: `searchChunksHybrid` (`lib/rag/qdrant.ts`) fetches a
larger vector-scored candidate pool, boosts results sharing query keywords
(`RAG_KEYWORD_BOOST_WEIGHT`, default 0.15), re-sorts. Wired into all three
call sites (`bylaws_search`, `nas_semantic_search`, the bylaws HTTP search
route) — each result now also carries `matchType: 'vector' | 'hybrid'`.

**I — `.docx` extraction.** Added via `mammoth` (confirmed it needs none of
`pdf-parse`'s bundler workaround — a plain `import mammoth from 'mammoth'`
builds fine).

**G — Hindi/multilingual embeddings: the model recommended on 2 October was
wrong, caught by testing live before writing it down as fact.**
`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` (and every
other "should be a 384-dim drop-in" candidate — `multilingual-e5-small`,
`multilingual-e5-base`, `bge-m3`, `LaBSE`, `distiluse-base-multilingual`,
`use-cmlm-multilingual`) is **not actually served by HF's hf-inference
provider for feature-extraction** right now — each either 404s or returns a
`SentenceSimilarityPipeline` error, meaning HF hosts it for a different
pipeline than embedding generation. The only multilingual model that
actually worked when probed live: **`intfloat/multilingual-e5-large`** —
but it's **1024-dim, not 384**, so switching IS a real Qdrant collection
resize, not the free lunch originally assumed.

Calibrated against the real HF API with a small English+Hindi
relevant/near-miss/irrelevant set (same method as section 9's original
0.50 calibration): this model's cosine scores run much higher overall
(irrelevant passages scored 0.70-0.78, higher than bge-small's own relevant
range), so **`RAG_MIN_SCORE` must come up to ~0.80** for it, not stay at
0.50 — the highest cutoff keeping all relevant/near-miss while dropping all
irrelevant in this sample. Also confirmed the actual point of this feature
works: a Hindi query finds an English-indexed passage and vice versa
(cross-lingual retrieval, not just same-language Hindi support).

Flipped in **local `.env` only** (both local Qdrant collections were empty,
so nothing was lost recreating them at 1024-dim) to prove this end-to-end.
**Not changed in any production config** — switching the real deployment
needs the same `HF_EMBEDDING_MODEL`/`HF_EMBEDDING_DIM`/`RAG_MIN_SCORE` values
set wherever Render's env vars are configured, plus a full re-index
afterward (new vectors aren't comparable to old ones, even where the
dimension happens to match).

**Still not done — needs infra access this round didn't have:**
- TRIJYA-3 still needs the connector redeployed with `pymupdf`/`pytesseract`
  (section 5/C — unchanged since 3 Oct).
- `BylawsReindexRun` and now also `lastSeenAt`/`NasReindexRun` need creating
  in whichever Postgres production actually runs on (only pushed to local
  dev here).
- Nothing currently triggers any `app/api/cron/*` route in production — only
  `.github/workflows/keepalive.yml` exists, and it's a plain `/health` ping,
  not a call to `rag-stale-sweep`/`rag-retry` with `CRON_SECRET`. Flagged in
  `SECURITY_TODO.md` already; still open.
