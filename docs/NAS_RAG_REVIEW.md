# NAS + Bylaws RAG — Review, Fixes and Handoff

**Branch:** `feature/nas-rag-content-search`
**Prepared:** 2 October 2026, for Daksh
**Reviewed commits:** `5331cd3` (6 Aug) and `e80fa38` (24 Sep)
**Fix commit to review:** `775e152`

---

## Summary

Your RAG pipeline is well built. Tenant isolation is done properly everywhere,
the org is passed explicitly into the background indexers, re-indexing is
idempotent, and it switches itself off cleanly when unconfigured. The problems
we found are about assumptions that did not hold on Trijya's real NAS and on
Render, not about code quality.

The most important finding: **as written, the bylaws pipeline could never
index anything on Trijya's NAS.** It looked for a `Trijya Projects` folder
that does not exist as a folder (it is the share name). That, plus several
issues that would have stored wrong data silently, is fixed in `775e152`.

What is left is mostly infrastructure (a Qdrant cluster, database tables,
Render settings) and a set of decisions and follow-up features listed below.

**Please:**
1. Review commit `775e152` and tell us if you disagree with anything.
2. Answer the questions in [Questions for you](#questions-for-you).
3. Pick up the items in [Changes for you to make](#changes-for-you-to-make).

---

## How this was reviewed

So you know how much weight to give each finding:

- Your code was run against the **real NAS**. The bylaws folder listing came from
  the live connector on TRIJYA-3.
- Embeddings were tested against the **real HuggingFace API** using your key.
- Failure modes (rate limits, cold starts, wrong vector sizes, oversized
  downloads) were simulated by replacing the HTTP layer with fakes, because they
  cannot be triggered on demand.
- **Qdrant was not available**, so the parts that talk to Qdrant were checked by
  reading the code and type-checking, **not** by running them. See
  [How to verify](#how-to-verify).

---

## Status at a glance

| Area | State |
|---|---|
| Bylaws folder detection | Fixed — matches 10 of 10 real paths (was 0 of 10) |
| Large files / memory safety | Fixed — oversized files refused, never truncated |
| Whole-document indexing | Fixed — up to ~300 pages (was first 12,000 characters) |
| Failed files stored as content | Fixed — recorded as FAILED with the reason |
| HuggingFace rate limits | Fixed — retried with backoff, concurrency capped |
| Relevance filtering | Added — calibrated minimum score |
| Qdrant cluster | **Blocked** — needs a Qdrant Cloud cluster (Kavya setting up) |
| Production database tables | **Not created yet** |
| Render environment variables | **Not set yet** |
| Bylaws backfill run | **Not run yet** |
| Large NBC / standards PDFs | **Skipped** on the free Render plan — needs a decision |
| Hindi bylaws, scanned PDFs, .docx | **Not supported yet** — needs a decision |

---

## What we changed and why

All in commit `775e152`. 13 files, +564 / -225 lines.

### 1. Bylaws folder was never found — HIGH

**File:** `lib/nas/bylaws-crawl.ts`

`Trijya Projects` is the **name of the SMB share**, not a folder inside it. In
Windows Explorer the share looks like a folder (`\\NAS\Trijya Projects\...`),
but the connector serves paths relative to the share root. So the real path is:

```
/utility data/By_Laws
```

The matcher required `Trijya Projects` as the first path segment. Against the 10
real items in that folder, **0 matched**, and `findBylawsFolder("WD")` returned
`null`. Even with Qdrant configured, the bylaws index would have stayed empty and
`bylaws_search` would always have said "no indexed bylaws passages matched".

**Change:** `Trijya Projects` is now an **optional** leading segment, so it still
works if a drive ever nests the folder that way. `findBylawsFolder` tries the
share root first, then under an optional `Trijya Projects` folder. It also now
accepts the Indian spelling `Bye-Laws` / `Byelaws`, since state statutory
documents are titled "Building Bye-Laws".

### 2. Large files were cut at 8 MB (corrupting PDFs) and fully loaded into memory — HIGH

**Files:** `lib/nas/client.ts`, `app/api/nas/bylaws/reindex/route.ts`

The backfill used `nasFetchBytes`, which defaults to `maxBytes = 8_000_000` and
truncates with `buf.subarray(0, maxBytes)`. Two problems:

- **A truncated PDF is corrupt.** PDFs keep their cross-reference table at the
  **end** of the file, so a cut-off PDF cannot be parsed at all. That then fed
  into problem 4 below.
- **The limit never protected memory.** The whole response was read with
  `r.arrayBuffer()` **before** truncating. The `ARCHITECTURAL STANDARDS` folder
  holds two files totalling 245 MB. Loading one of those on Render's free plan
  (512 MB for the whole app) would very likely crash the server for every user.

**Change:** New `nasFetchBytesStrict(server, path, maxBytes)` **refuses rather
than truncates**. It checks `Content-Length` before reading, then streams the body
with a running byte count and aborts as soon as the limit is crossed, so an
oversized file is never held in memory. The backfill also now skips oversized
files using the **size from the folder listing**, before downloading anything.

`nasFetchBytes` itself is **unchanged**, because the `nas_read` tool uses it. See
[Other issues](#other-issues-found-for-awareness).

### 3. Only the first 12,000 characters of each document were indexed — HIGH

**File:** `lib/nas/extract.ts`

Indexing reused `extractText`, whose `MAX_TEXT = 12_000` exists for the short
preview shown by `nas_read`. A 100,892-character test document kept 12% of its
text. For bylaws, everything after roughly the first four pages of every
document was never searchable, and nothing reported it.

**Change:** New `extractForIndex()` indexes up to `RAG_MAX_TEXT_CHARS` (default
1,000,000, roughly 300 pages). Anything longer is indexed up to the limit and
flagged with a warning instead of being cut silently. It also reads **every**
spreadsheet sheet in full; the preview stopped at 5 sheets and 4,000 characters
each.

`extractText` and `nas_read` are deliberately unchanged.

### 4. Error messages were embedded as document content — HIGH

**Files:** `lib/nas/extract.ts`, `lib/rag/index-core.ts`

When `extractText` fails, it **returns** a sentence such as
`(could not extract text from PDF ...: Invalid root reference)`. The indexer
could not tell that apart from real text, so it chunked it, embedded it, and
marked the file `INDEXED`. Scanned bylaws are common, so the index could fill up
with copies of an error message, which would then match searches.

**Change:** `extractForIndex()` returns a structured result,
`{ ok: true, text } | { ok: false, reason }`. Failures are recorded as `FAILED`
with the real reason. A PDF that parses but has no text layer is reported
specifically as `PDF has no selectable text (likely scanned images; needs OCR)`,
so scans can be found and handled later.

### 5. HuggingFace rate limits were not retried, and uploads were unbounded — HIGH

**File:** `lib/rag/embeddings.ts`

Only `503` (model cold start) was retried. A `429` (rate limited) failed
immediately. Indexing runs fire-and-forget per upload with no queue, so uploading
many files launched that many parallel indexing jobs, which is exactly what
trips the free-tier rate limit. Every one of those files was marked `FAILED`.

**Change:**
- `429`, `502`, `503`, `504` and network errors are retried up to 6 times with
  exponential backoff (1 s, 2 s, 4 s, 8 s, 16 s, plus jitter), honouring the
  `Retry-After` header.
- A semaphore caps in-flight embedding requests across **all** callers
  (`HF_MAX_CONCURRENT`, default 2).
- A slot is held **only for the HTTP request itself, never across a backoff
  sleep.** An earlier version of this fix held the slot through the sleep. A test
  caught that it starved live searches: during a rate-limit storm, a user's
  `bylaws_search` would have waited about 30 seconds behind bulk indexing. In the
  final version, a live search answered in **51 ms** in the middle of that storm.
- Non-retryable errors (`400`, `401`) still fail at once, with the response body.
- The final error says it **was** retried:
  `HF embeddings failed after 6 attempts (last: HTTP 429) — likely rate limited; re-run to retry`.

### 6. A wrong embedding size failed with an unclear error — MED

**File:** `lib/rag/embeddings.ts`

The returned vector length was never checked against `HF_EMBEDDING_DIM`.
Changing `HF_EMBEDDING_MODEL` to, say, a 768-dimension model without also
changing `HF_EMBEDDING_DIM` created the collection at 384 and then failed every
write with an opaque Qdrant error.

**Change:** A size mismatch now throws a message naming both values and the
setting to change.

### 7. Re-indexing could permanently lose a file's chunks — MED

**Files:** `lib/rag/qdrant.ts`, `lib/rag/index-core.ts`

The flow was: delete all of the file's chunks, then upsert the new ones. If the
upsert failed, the file was gone from the index, and between the two calls it
was briefly unsearchable.

**Change:** Your point IDs are deterministic per `(org, server, path,
chunkIndex)`, so upserting the new chunks **overwrites the old ones in place**.
The new order is: upsert first, then `pruneStaleChunks()` removes only the tail
left over from a longer previous version (`chunkIndex >= newCount`).
`deleteFileChunks` is removed, because `pruneStaleChunks(..., 0)` covers it.

> Not yet run against a real Qdrant. Please verify, see below.

### 8. No payload indexes — MED

**File:** `lib/rag/qdrant.ts`

Every filtered search and delete scanned the whole collection, and filtered
vector search can return fewer results than requested without them.

**Change:** `ensureCollection()` now creates payload indexes on
`organizationId`, `server`, `path` (keyword) and `chunkIndex` (integer; needed by
the range filter in fix 7). Creating an index that already exists is harmless, so
existing collections are upgraded automatically.

> Not yet run against a real Qdrant. Please verify.

### 9. No minimum relevance score — MED

**File:** `lib/rag/qdrant.ts`

Search always returned `limit` passages, however unrelated, so the assistant
would confidently cite irrelevant text.

**Change:** `RAG_MIN_SCORE` (default `0.50`) is passed as Qdrant's
`score_threshold`. It was **calibrated against real `bge-small-en-v1.5`
embeddings** using bylaw-style passages labelled relevant, near-miss and
irrelevant:

| Cutoff | Relevant kept | Near-miss kept | Irrelevant kept |
|---|---|---|---|
| 0.40 | 9 / 9 | 9 / 9 | 11 / 12 |
| 0.45 | 9 / 9 | 8 / 9 | 6 / 12 |
| **0.50** | **9 / 9** | **6 / 9** | **2 / 12** |
| 0.55 | 8 / 9 | 4 / 9 | 1 / 12 |
| 0.60 | 6 / 9 | 4 / 9 | 0 / 12 |

`0.50` is the highest cutoff that loses no relevant passage.

Two caveats:
- **This model's relevant and irrelevant score ranges overlap** (worst relevant
  0.517, best irrelevant 0.561), so no cutoff separates them perfectly. Treat it
  as a junk filter, not a guarantee.
- **BGE's documented query prefix** (`Represent this sentence for searching
  relevant passages: `) was tested and made separation slightly **worse**, so it
  is not used.

Re-calibrate if you change the model.

> Not yet run against a real Qdrant. Please verify.

### 10. The backfill reported failures as successes — MED

**Files:** `app/api/nas/bylaws/reindex/route.ts`, `lib/rag/index-core.ts`

`indexBylawsFile` never throws; it catches internally and writes `FAILED`. The
route counted every call as `indexed`, so an admin would see "indexed: 20" when
some of those had failed.

**Change:** The indexers now return an outcome:

```ts
type IndexOutcome =
  | { status: 'indexed'; chunks: number; warning?: string }
  | { status: 'unchanged' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
```

The route reports `indexed`, `unchanged`, `skippedNotExtractable`,
`skippedTooLarge` and `failed`, plus up to 20 failure paths with their reasons.

### 11. Smaller fixes

- **`chunkText` could loop forever** (`lib/rag/chunk.ts`). With
  `overlap >= target`, the step `target - overlap` is 0, so the loop never
  advances and allocates until the process dies. Reproduced: it used about 4 GB
  of heap before crashing. Not reachable with the defaults (1200/150), but it is a
  synchronous loop, so it would take down the server for every user. Both values
  are now clamped.
- **Bylaws search** (`app/api/nas/bylaws/search/route.ts`):
  - `typeof NaN === 'number'`, so a `NaN` limit reached Qdrant unchanged, and so
    did a fractional one like `2.7`. Now `Number.isFinite` and `Math.floor`.
  - Raw error text, which can include internal service URLs, was returned to the
    browser. It is now logged server-side and the client gets a generic message.
  - The query is capped at 1,000 characters.
- **The upload hook** (`app/api/nas/upload/route.ts`) now logs failed outcomes.
  Failures no longer arrive as thrown errors, so they were otherwise only visible
  in the tracking table.

### Structure change

`index-nas-file.ts` and `index-bylaws-file.ts` were line-for-line copies, kept in
sync by hand ("kept in sync deliberately"). Every fix above touches every step of
that flow, so the logic now lives **once** in the new file
`lib/rag/index-core.ts`.

The two original files are now thin wrappers that pass in their own collection
and tracking table. **Their exported function signatures are unchanged**, so no
call site changed. The bylaws pipeline can still diverge later, for example with
a different chunk size for legal clauses, through options to `indexFile()`
rather than a second copy that can drift.

### New optional settings

Documented in `.env.example`. All have defaults.

| Variable | Default | Purpose |
|---|---|---|
| `RAG_MAX_FILE_MB` | `20` | Files above this are skipped and recorded `FAILED` with the reason, not parsed. Sized for Render's free plan. |
| `RAG_MAX_TEXT_CHARS` | `1000000` | Max characters indexed per file. Longer files are flagged. |
| `RAG_MIN_SCORE` | `0.5` | Minimum similarity returned. Re-calibrate if the model changes. |
| `HF_MAX_CONCURRENT` | `2` | Max embedding requests in flight at once. |

---

## What is blocking deployment

In this order. Deploying the code before steps 2 and 3 is safe (indexing stays
switched off), but the feature does nothing until they are done.

1. **A Qdrant cluster Render can reach.** The `.env` you shared had
   `QDRANT_URL=http://localhost:6336`, a Qdrant on your own machine. Neither
   Render nor anyone else can reach that. Kavya is creating a **Qdrant Cloud free
   cluster**; its URL and API key will be shared separately.
2. **Production database tables.** Render runs `prisma generate` only, never a
   migration, so `NasIndexedFile`, `BylawsIndexedFile` and the `NasIndexStatus`
   enum must be created on the production database **before** the code is
   deployed.
3. **Render environment variables:** `HF_API_KEY`, `HF_EMBEDDING_MODEL`,
   `HF_EMBEDDING_DIM`, `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION`,
   `QDRANT_BYLAWS_COLLECTION`, plus any of the tuning settings above.
4. **Merge** `feature/nas-rag-content-search` into `main`. Pushing to `main`
   deploys automatically.
5. **Backfill:** `POST /api/nas/bylaws/reindex` as an admin, then check the
   response's `failed` list.

---

## Changes for you to make

Prioritised. Each has a clear "done when". If you need anything to do these,
tell us; see [What we need back from you](#what-we-need-back-from-you).

### P0 — before shipping

**A. Review commit `775e152`.** Push back on anything you disagree with. The
refactor into `index-core.ts` is the largest change.

**B. Verify the Qdrant-dependent fixes on a real cluster** (fixes 7, 8 and 9 were
not run live):
- Index a file, then re-index a **shorter** version of it, and confirm the extra
  chunks are gone and no others are.
- Confirm the four payload indexes exist after `ensureCollection()`.
- Confirm a clearly unrelated query returns few or no passages.

*Done when:* all three behave as described against the Qdrant Cloud cluster.

### P1 — make the bylaws corpus actually searchable

**C. Index the large PDFs.** The bylaws folder holds 23 files, mostly PDFs,
totalling about 830 MB. With `RAG_MAX_FILE_MB=20`, the `NBCs` volumes (10 files, about 53 MB
each on average) and the `ARCHITECTURAL STANDARDS` files (2 files, about 122 MB
each on average) are **skipped**. They are recorded as `FAILED` with the size
reason. Options:
- **Recommended:** extract text **on the connector** (TRIJYA-3, Python, for example
  `pdftotext` or `pypdf`) and have Forge fetch text instead of PDF bytes. Render
  never holds a large PDF, and the limit stops mattering.
- Or move Render to a larger plan and raise `RAG_MAX_FILE_MB`.

*Done when:* the NBC volumes are indexed without Render's memory climbing near its
limit.

**D. OCR for scanned PDFs.** These are now recorded as
`FAILED: PDF has no selectable text (likely scanned images; needs OCR)`. After the
first backfill, count them. If there are many, add OCR (connector-side again
avoids loading Render).

*Done when:* scanned bylaws are searchable, or we have decided they don't need to be.

### P2 — coverage and quality

**E. Existing NAS files are not content-indexed.** Only files uploaded **through
Forge** after the feature is switched on are indexed. Most of Trijya's ~327,000
files arrived over SMB directly, so `nas_semantic_search` will cover very little
of the NAS. Indexing everything is likely too much for the HuggingFace and Qdrant
free tiers. Propose a scope, for example certain folders or document types only.

**F. Files deleted or renamed on the NAS stay searchable.** Nothing removes their
chunks. For bylaws this means Forgie could cite a **superseded regulation**. A
periodic sweep comparing the index against the folder listing would fix it.

**G. Hindi bylaws.** `bge-small-en-v1.5` is English-only. At least one bylaws file
is a Hindi government order. If Hindi content matters, evaluate a multilingual
model. A 384-dimension one avoids recreating the collections at a new size, but
**any** model change needs a full re-index and a re-calibration of
`RAG_MIN_SCORE`.

**H. Paraphrased questions rank poorly.** During calibration, "how far from the
road must a house be built" ranked the height and floor-area passages **above**
the setback passages that actually answer it. A hybrid search (keyword plus
vector) would help. This is a limitation of a small model, not a bug.

**I. `.docx` is not extracted.** It needs a new dependency (for example `mammoth`).
There are no `.docx` files in the bylaws folder today, so this is low priority.

**J. Run the backfill as a background job.** It currently processes everything
inside one HTTP request. If the request times out, the work continues
server-side and re-running skips unchanged files, so it is safe, but the admin
gets no final result. A job plus a status endpoint would be cleaner.

---

## Other issues found (for awareness)

Found while testing. Some may be yours, some not; please say which you own.

1. **TRIJYA-3 is saturated, which is breaking the old NAS semantic search and the
   local LLM.** On 2 October, load average was about 9.5, and Ollama's own
   `llama-server` runner had been using about 590% CPU for over two hours with
   `qwen3:14b` loaded. A two-word `nomic-embed-text` request returned nothing within
   25 seconds. As a result, the connector's **semantic index for WD holds 0 of
   327,067 files**, and in testing every Forgie question that needed an LLM was
   answered by **Gemini** (10 to 30 seconds), not the local model. We did not
   stop anything.
2. **The old and new semantic search are complementary, not replacements.** The
   old one (connector, `nomic-embed-text`) embeds **folder plus filename** for all
   existing files. Yours embeds **document contents** for indexed files. Your
   branch keeps both, which is right. Please keep it that way.
3. **`nas_read` still truncates at 8 MB.** The same `nasFetchBytes` problem as fix
   2 applies to the existing read tool: any PDF over 8 MB comes back as "could not
   extract text". Pre-existing, outside this branch.
4. **Forgie false negative.** Asked "find byelaws", Forgie replied that no such
   files exist, without searching; `Byelaws.pdf` and `Compiled_byelaws_I.pdf` are
   on the NAS. The NAS fast lane (`lib/nas/fastlane.ts`) only fires when a query
   has a verb **and** a file-type noun (`pdf`, `file`, `drawing`, ...).
   "byelaws" is not one, so it fell through to the LLM, which did not call a tool.
5. **Keyword search misses spelling variants.** Searching "bylaws" does not match
   a file named "Parking by laws for 99 sq. mt. plot area.pdf".
6. **Truncated answers are cached.** A Hindi question returned 39 characters cut
   off mid-sentence, probably because the 800-token output cap is hit quickly by
   Devanagari. `isCacheableResponse` (`lib/assistant/cache-guard.ts`) only rejects
   replies under 8 characters or the canned error strings, so it cached it. Impact
   is small: the cache key includes the user, and entries expire after 5 minutes.
7. **Build can fail on a Google Fonts hiccup.** `next build` downloads Bodoni Moda
   and Outfit at build time. A bad response crashes `next/font` in Next 14.2.5
   (`Cannot read properties of null (reading '1')` at `loader.js:112`). A retry
   fixes it. It could fail a Render deploy the same way.
8. **Credentials were shared in plain text.** The HuggingFace key was pasted into a
   chat. Please **rotate it** once the deployment is set up. Your local
   `JWT_SECRET` was also shared; that matters only if it is reused anywhere real.

Decided, no change needed: `BylawsIndexedFile.organizationId` defaults to
`"trijya"` rather than `"rig360"`. This is kept as is.

---

## Questions for you

1. **How did `Trijya Projects` end up in the path?** Were you testing with the
   share mounted somewhere that made it appear as a folder? And is the bylaws
   folder laid out the same way on **every** drive?
2. **Your local Qdrant (`localhost:6336`):** does it hold anything worth keeping,
   or is a fresh re-index fine? (Re-indexing is cheap.)
3. **TRIJYA-3:** the Ollama models `qwen3-nl` and `gpt-oss-nl` were last modified
   on 11 September (there is also a custom `forgie` model). Are those yours, and is
   anything of yours running long jobs there? That load is what is breaking the
   old semantic search.
4. **Did you intend `nas_semantic_search` to cover files that already exist on
   the NAS?** As built it only covers new Forge uploads (see E).
5. **Roughly how many bylaws are Hindi, and how many are scans?** That decides
   whether D and G come first.

---

## What we need back from you

- Your review of `775e152`: agree, disagree, or changes.
- Answers to the five questions above.
- Which of C to J you will take, and your order.
- Anything **you** need from us to do them: access, credentials, decisions,
  infrastructure. Please list it explicitly.

---

## How to verify

### Run the regression suite

```bash
npx tsx scripts/test-rag.ts
```

Run it from the repo root (it also works from elsewhere). It needs **no** network,
Qdrant or HuggingFace account: the HTTP calls are replaced with in-process fakes,
and everything else runs the real code. Expected result: `35 passed, 0 failed`,
with exit code 0.

Most checks reproduce a defect and would fail against the code before
`775e152`. Checks worded "still", "unchanged" or "also" are regression guards for
behaviour that was already correct.

**Not covered** (needs a live Qdrant): fixes 7, 8 and 9. See P0, item B.

### Other checks run

- `tsc --noEmit`: clean.
- `next build`: succeeds. One attempt failed on a Google Fonts hiccup (issue 7)
  and passed on retry.

---

## Reference

### Commits on this branch

| Commit | Date | Author | What |
|---|---|---|---|
| `5331cd3` | 6 Aug | Daksh | Content-level RAG search for NAS documents |
| `e80fa38` | 24 Sep | Daksh | Separate Trijya bylaws RAG index + HF/Qdrant wiring |
| `b803db2` | 2 Oct | — | Merge `main` into this branch (one conflict in `TENANT_MODELS`, resolved as the union) |
| `775e152` | 2 Oct | — | The fixes described in this document |

### Files changed in `775e152`

| File | Change |
|---|---|
| `lib/rag/index-core.ts` | **New.** Shared indexing flow (fixes 4, 7, 10) |
| `lib/rag/index-nas-file.ts` | Now a thin wrapper over `index-core` |
| `lib/rag/index-bylaws-file.ts` | Now a thin wrapper over `index-core` |
| `lib/rag/embeddings.ts` | Retries, concurrency cap, size check (fixes 5, 6) |
| `lib/rag/qdrant.ts` | Payload indexes, `pruneStaleChunks`, minimum score (fixes 7, 8, 9) |
| `lib/rag/chunk.ts` | Infinite-loop guard (fix 11) |
| `lib/nas/bylaws-crawl.ts` | Folder detection; listing now returns sizes (fix 1) |
| `lib/nas/client.ts` | `nasFetchBytesStrict`, `FileTooLargeError` (fix 2) |
| `lib/nas/extract.ts` | `extractForIndex` (fixes 3, 4) |
| `app/api/nas/bylaws/reindex/route.ts` | Size pre-check, real outcome counts (fixes 2, 10) |
| `app/api/nas/bylaws/search/route.ts` | Input sanitising, no error leak (fix 11) |
| `app/api/nas/upload/route.ts` | Logs failed outcomes (fix 11) |
| `.env.example` | New settings documented; bylaws path corrected |

### Real bylaws folder contents (2 Oct, WD share)

```
/utility data/By_Laws/
  ARCHITECTURAL STANDARDS/      2 files, 245.1 MB
  NBCs/                        10 files, 533.4 MB
  ZONAL PLANS REGULATIONS/      4 files,  30.6 MB
  202504161857302632Bylaws_160425.pdf    1.7 MB
  Compiled_byelaws_I.pdf                 6.8 MB
  ews calculation.pdf                    2.2 MB
  G-O-07-01-2022 (1).pdf                 2.5 MB
  G.O.V-2-आ0-2016-60(आ0)2015.pdf         0.4 MB
  Tourism-policy-2023 (1).pdf            6.9 MB
  WhatsApp Image 2026-09-07 at 11.22.13 AM.jpeg  (not extractable)
```

Other bylaws-related files exist **outside** this folder, for example
`/utility data/Parking by laws for 99 sq. mt. plot area.pdf` and
`/Anjana/Utility/Byelaws.pdf`. The bylaws pipeline will not include those. Say if
it should.
