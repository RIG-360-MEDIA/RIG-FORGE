# NAS + Bylaws Search: Changes from 4 to 17 October 2026, and What Is Left

**For:** Daksh (owner of the RAG / bylaws system), and anyone picking it up.
**State as of:** 17 October 2026, `main` at the commit that adds this file.

This is the starting point for further work on the search system. It covers
everything changed since round 4 (4 October), why each change was made, how the
bylaws search works now, how it was tested, and the open issues in priority
order. Earlier work is in three older documents, still accurate for what they
cover:

| Document | Covers |
|---|---|
| [`NAS_RAG_REVIEW.md`](NAS_RAG_REVIEW.md) | The first review of the original branch and the fixes in `775e152` (2 Oct) |
| [`DAKSH_RAG_HANDOFF.md`](DAKSH_RAG_HANDOFF.md) | Status and open items as of 3–4 Oct, questions for Daksh |
| [`RAG_BACKLOG_CHANGES.md`](RAG_BACKLOG_CHANGES.md) | Rounds 1–4 (large PDFs, OCR, backfill jobs, retry queue, hybrid ranking, `.docx`, crons, review fixes) |

---

## 1. Where things stand

Both searches are **live in production** for the Trijya company:

| Feature | Where in the app | What it searches | Size |
|---|---|---|---|
| **Bylaws search** | Workspace → Bylaws tab; Forgie tool `bylaws_search` | `trijya_bylaws_e5`: 20 bylaws / NBC / government order PDFs from `/utility data/By_Laws` | 20,916 passages |
| **Whole-NAS content search** | Workspace → Files → "search inside files"; Forgie tool `nas_semantic_search` | `nas_documents_e5`: every PDF, Word, Excel, text and CSV file on the WD share, except bylaws and software/installer folders | 22,443 files, 281,264 passages |
| Filename search | Files tab search box; Forgie "find …" | The connector's in-memory index of all file names | ~327k files |

How the pieces connect:

```
Forge on Render
   │  HTTPS, Cloudflare Access service token
   ▼
nas.rig360media.com  (Cloudflare tunnel)  ──►  TRIJYA-3 (WSL)
                                                 ├─ NAS connector :8787   (files, /extract, /embed, /qdrant pass-through)
                                                 │    └─ embeddings: multilingual-e5-large, ONNX on the GPU, CPU fallback
                                                 ├─ Qdrant :6333          (both collections, self-hosted)
                                                 ├─ nas_indexer.py        (walks the NAS, indexes whole-NAS content)
                                                 └─ Ollama :11434         (Forgie's local LLM; also RIG SURVEILLANCE)
                                                        │ SMB
                                                        ▼
                                                 WD NAS  ("Trijya Projects" share)
```

Production settings (Render):

| Setting | Value | Note |
|---|---|---|
| `HF_EMBEDDING_MODEL` | `intfloat/multilingual-e5-large` | English + Hindi; served by the connector's `/embed` |
| `HF_EMBEDDING_DIM` | `1024` | |
| `QDRANT_URL` | `https://nas.rig360media.com/qdrant` | Qdrant on TRIJYA-3 through the connector |
| `QDRANT_API_KEY` | (secret) | the key in `~/qdrant/api-key` on the box |
| `QDRANT_BYLAWS_COLLECTION` | `trijya_bylaws_e5` | |
| `QDRANT_COLLECTION` | `nas_documents_e5` | |
| `RAG_MIN_SCORE` | `0.82` | calibrated on the bylaws collection only (see issue 9) |

The Qdrant Cloud cluster still holds the old English collection
(`trijya_bylaws`, bge-small) and a 14 Oct copy of `trijya_bylaws_e5`. To
fall back to the cloud, point `QDRANT_URL` and `QDRANT_API_KEY` at the Cloud
cluster (values with Kavya). To go back to the English model as well, also set
`HF_EMBEDDING_MODEL=BAAI/bge-small-en-v1.5`, `HF_EMBEDDING_DIM=384`,
`QDRANT_BYLAWS_COLLECTION=trijya_bylaws`, `QDRANT_COLLECTION=nas_documents`
and `RAG_MIN_SCORE=0.50`. Whole-NAS content exists only on TRIJYA-3
(issue 11).

---

## 2. What changed, and why

In order. Commits are on `main`.

### 2.1 Embeddings computed on TRIJYA-3 (`65de329`, `2a607d1`)

**Why:** on 11 Oct the HuggingFace free allowance ran out (HTTP 402 on every
call), which took every search down.
**What:** the connector serves `POST /embed` (`scripts/nas-connector/rag_embed.py`):
the same models from their official ONNX exports, with the pooling and
normalisation each model publishes. Checked against vectors from the HF API:
cosine 1.000000. `lib/rag/embeddings.ts` uses the connector first and the HF
API only as a fallback. Large extraction results were also timing out on the
way back; fixed in `2a607d1`.

### 2.2 Whole NBC volumes, and OCR for broken text layers (`9f3696e`, `39be98a`)

**Why:** big references were cut at 1 M characters, and several PDFs (NBC 2016
digital volumes, `Compiled_byelaws_I.pdf`, a 2016 G.O.) have text layers that
are garbage: legacy Hindi fonts, or glyphs with no character map. They were
indexed as nonsense.
**What:** `RAG_MAX_TEXT_CHARS` 5 M, Qdrant upserts batched (256 points). A
readability rule: a document with 30% or more unreadable pages gets page-level
OCR (tesseract 5.5.3 with all language packs, installed on the box without
sudo in `~/ocr`).

### 2.3 Multilingual embedding model (`cdddaf6`, `394909f`, `0048831`)

**Why:** `bge-small-en-v1.5` is English-only. Every Hindi question got the same
three unrelated passages.
**What:** the connector can serve several models at once, and
`scripts/nas-connector/rag_migrate.py` re-embeds a collection into a new one
without downtime. The bylaws were migrated to `multilingual-e5-large` and
production switched on 14 Oct. Models load from plain folders in
`~/.cache/rag-models`, because ONNX external weights fail from the HF cache's
symlinks. Embedding micro-batches are sorted by length to cut padding.

### 2.4 Near-empty chunks, and the minimum score (`9e9cf16`, `3f76482`, merged `d76cdf7`)

**Why:** chunks such as `,2016` or `(Ss)` scored 0.81–0.82 against any query,
including nonsense, on e5. So the 0.79 floor filtered nothing.
**What:** chunks under 40 letters are not indexed (`RAG_MIN_CHUNK_LETTERS`).
Hindi vowel signs count as letters. 134 such points were deleted with
`scripts/rag-prune-junk-chunks.ts`. The minimum score was re-calibrated on 22
relevant and 18 irrelevant English and Hindi questions: the best relevant hits
scored 0.838–0.900, irrelevant ones 0.732–0.831. So `RAG_MIN_SCORE=0.82`.

### 2.5 Filename search tolerates spelling (`87702de`)

**Why:** "bylaws", "byelaws", "by laws" and "bye-laws" found different files.
**What:** the connector's filename index compares squashed names (no spaces or
punctuation, with `bye` read as `by`) in tiers: exact substring, then squashed,
then all words. `/servers` now does a real SMB reachability check per NAS,
cached 30 s.

### 2.6 Qdrant self-hosted on TRIJYA-3, embeddings on the GPU (`abe682e`)

**Why:** whole-NAS content is about 280k passages × 1024 dimensions. Qdrant
Cloud's free tier (1 GB RAM, 4 GB disk) is too small for that.
**What:** Qdrant 1.19.1 runs on the box (`~/qdrant`, 127.0.0.1:6333, API key).
Forge reaches it through the connector's `/qdrant/{path}` pass-through, with
the same Cloudflare Access token as every other connector call. `getClient()`
in `lib/rag/qdrant.ts` reads the URL path as the client prefix and adds the CF
headers when the host is the NAS host. Embeddings run on the RTX 3080 Ti
(`onnxruntime-gpu`, 4 GB cap) and fall back to the CPU per batch when Ollama
has filled the GPU (`7512b62`).

### 2.7 Whole-NAS content search (`72aefcf`, `7512b62`)

**Why:** the Forge-side backfill only indexed files uploaded through Forge,
and folders listed in `NAS_INDEX_FOLDERS`. Kavya asked that every document on
the NAS be searchable however it got there, mostly SMB.
**What:** `scripts/nas-connector/nas_indexer.py` runs on the box as a service.
- Every 2 hours it walks the WD share, keeping state in SQLite
  (`~/nas-indexer/state.db`).
- It extracts PDF (text layer, plus OCR of up to 20 unreadable pages; drawing
  sheets larger than A2 are skipped), `.docx`, `.xlsx`/`.xls`, `.txt`, `.csv`,
  `.tsv`, `.md` and `.rtf`.
- Its chunking and point ids are ports of `chunk.ts` and Forge's `pointId`, so
  Forge's code reads its points like its own (cross-checked identical on 64
  texts).
- Files missing from a complete walk are removed from the index.
- Failures retry with backoff (15 min, 1 h, 6 h, 24 h), then are given up.
- Excluded: the bylaws folder, software/driver/installer folders, and readme /
  licence / log files.
- One persistent SMB session per share: a session per file made the NAS
  refuse connections.

In Forge, `POST /api/nas/content-search` serves the Files tab, and
`nas_semantic_search` covers the whole NAS.

### 2.8 Whole-question search for bylaws (`b41df22`)

**Why:** "FAR for a 2000 sq m plot" returned FAR passages for any plot size,
or setback passages that mention 2000. Vector search treats "2000" as just a
token, and the row that applies says ">1200".
**What:** `lib/rag/query-match.ts` reads the question's regulation topics and
plot area. A passage had to mention every topic and contain a row covering
the area. Candidates come from a pool of 200 passages scoring at least
`RAG_MIN_SCORE − 0.04`. When nothing meets every part, the closest passages
are returned with `allMatched: false`, and the UI says so.

### 2.9 The answer is a table row, from the right table (`f44513d`, `2cc6d87`)

**Why:** in testing after the 14 Oct demo, the check in 2.8 was too loose. It
was per passage, not per table. "Setback for a 200 sq m plot" answered from
the healthcare table, which happens to have the same figures. A FAR table
passed a setback question because its coverage column says "after ensuring
setbacks". Fee schedules passed area questions. The building type in a
question was ignored, and "18 m road" or "20 m high" were not understood.
Before the change, 18 of the 41 first test questions were answered correctly.
See section 4.

**What:** a match is now a ROW:
- **The value falls in the row**, in the column for that kind of value:
  - plot area (sq m, sq ft, sq yd/gaj, acres, hectares, converted to sq m);
  - building height ("20 m high");
  - road width ("18 m road").
  - Ranges read: `300 - 500`, `>1200`, `=>100 - 300`, `up to 150`,
    `more than 3000`, and Hindi `1001 से 3000 तक` and `35000 से अधिक`.
  - An open row (">1200") applies only as the last threshold below the value.
  - A percentage ("up to 50 percent") and a range in a column heading
    ("Road Width (>12 -24m)") are not values.
- **The table is about every asked topic:** FAR, setback, ground coverage,
  parking, height, staircase, basement, road width or ventilation. The topic
  must be named in the table's own heading, in the last sentence above the row
  that names any topic. "After ensuring setbacks" does not count. Value-column
  headings ("Building Height (m)") don't count as the topic either.
- **The building type matches**, when the question names one: residential,
  group housing, commercial, healthcare, educational, industrial, hotel,
  assembly / hall, or petrol pump.
  - It must be the nearest type named above the row.
  - A heading that lists several types ("शिक्षण संस्थायें /चिकित्सा …")
    applies to all of them.
  - "All occupancy buildings" applies to any type.
  - "Non-residential" is not residential.
- **Sections** are split at clause numbers (3.2.4.1, also 7.21), and at Hindi
  lettered clauses ("(स)-"). A clause number written as a reference ("as per
  paragraph 3.2.4.9") is not a heading.
- **Tables span passages.** For each candidate, Forge fetches the two passages
  before it and the one after it by their deterministic point ids. The heading
  may be two passages up; the asked row may be in the next one. When the row
  is in a neighbour, that passage is the one shown.
- **Ranking.** In order:
  1. the asked use matched;
  2. a clean table row, then a figure in prose, then a section that only
     names the topic;
  3. the row itself names the topic;
  4. with no use asked, a residential table;
  5. then state bylaws and G.O.s, NBC, the TCPO model bye-laws, and reference
     books (Time-Saver Standards, Neufert), in that order
     (`documentPriority`);
  6. then the tightest range around the value;
  7. then meaning and keywords.

  Rows with OCR noise (`|`, `[`, stray Latin inside Hindi) and ranges from
  zero rank as unclean.
- **Hindi questions** are also searched with their parts in English ("FAR for
  a 500 sq m plot"), and the English word for their use counts as theirs, so
  the English tables can answer them.
- **Questions without a value** ("parking for a shopping mall") are matched per
  section. The line shown is the table line or sentence in the question's own
  words that states the value ("3 Shopping mall 3 / 100 sqm of floor area").
- **Each result carries:**
  - `matchedRow`: the row as printed;
  - `section`: the clause, e.g. "3.2.4.1 Residential – Plotted Development";
  - `values`: the row read against its column labels, e.g. "Front 3 m, Rear
    1.5 m, Side-1 0 m, Side-2 0 m", for setback, FAR and ventilation-shaft
    tables, only when those columns are what was asked.

  `BylawsPanel` shows them; the API routes and both Forgie tools pass them on.
- **Duplicated overlap stripped.** Passages are read without the overlap that
  `chunkText` writes twice into hard-split paragraphs (`cleanPassage`, see
  issue 4).

### 2.10 Box services made self-starting (no commit; on TRIJYA-3)

**Why:** on 16 Oct every NAS feature returned 530 for hours. `cloudflared` had
died, and its only restarter (`~/forgie/watchdog.sh`) needs a Windows logon.
**What:** every service has a cron job, at boot and every 1 or 5 minutes, that
starts it if it is not running (section 5). Proven on 17 Oct: the box
rebooted at about 05:04, and everything was back within two minutes with
nobody logged on.

### Commits

| Commit | Change |
|---|---|
| `65de329`, `2a607d1` | Embeddings from TRIJYA-3; large extraction results no longer time out |
| `9f3696e` | 5 M character cap, batched upserts |
| `39be98a` | OCR for PDFs with broken text layers |
| `cdddaf6`, `394909f` | Several embedding models at once; migration script; ONNX from plain folders |
| `0048831` | Embed micro-batches in length order |
| `9e9cf16`, `3f76482`, `d76cdf7` | Drop near-empty chunks; e5 min-score calibration |
| `87702de` | Spelling-tolerant filename search; real reachability check |
| `b41df22` | Whole-question search for bylaws |
| `abe682e` | Connector Qdrant pass-through; GPU embeddings |
| `72aefcf`, `7512b62` | Whole-NAS content search (indexer, API, Files tab); indexer robustness; GPU→CPU fallback |
| `f44513d`, `2cc6d87` | Bylaws answers as table rows from the right table; ranking |
| (this commit) | This report and the test pack in `scripts/bylaws-eval/` |

---

## 3. Code map

| File | Role |
|---|---|
| `lib/rag/query-match.ts` | Reads the question (topics, use, area/height/road) and finds the answering row in a passage. All the rules in 2.9. Pure functions, no I/O. |
| `lib/rag/qdrant.ts` | Qdrant client; `searchChunksConstrained`: pool search, Hindi→English re-search, neighbour fetch, matching, ranking, de-duplication |
| `lib/rag/chunk.ts` | `chunkText`, `substantiveChunks`, `cleanPassage` |
| `lib/rag/embeddings.ts` | Query/passage embedding: connector `/embed` first, HF API fallback; e5 prefixes |
| `app/api/nas/bylaws/search/route.ts` | Bylaws tab API |
| `app/api/nas/content-search/route.ts` | Files tab "search inside files" API |
| `lib/assistant/tools/bylaws.ts`, `lib/assistant/tools/nas.ts` | Forgie tools |
| `components/workspace/BylawsPanel.tsx`, `FilesPanel.tsx` | UI |
| `scripts/nas-connector/connector.py` | NAS connector (FastAPI): files, filename index, extraction jobs, `/embed`, `/qdrant` |
| `scripts/nas-connector/rag_embed.py` | ONNX embeddings, GPU with CPU fallback |
| `scripts/nas-connector/nas_indexer.py`, `run-indexer.sh`, `restart-indexer.sh` | Whole-NAS indexer service |
| `scripts/nas-connector/rag_migrate.py` | Re-embed a collection into another model |
| `scripts/test-rag.ts` | Offline unit tests (144), no network needed |
| `scripts/bylaws-eval/` | The 81-question test pack and its two runners (section 4) |

---

## 4. Testing

**Unit tests:** `npx tsx scripts/test-rag.ts`. 144 pass. The last section
pins the rules in 2.9 on real bylaws text: same-shape tables, the FAR table
that says "after ensuring setbacks", a table split over two passages, road
width rows for several uses, unit conversion, Hindi ranges, percentages,
sentences that look like rows, `cleanPassage`, and document priority.

**The test pack** (`scripts/bylaws-eval/cases.mjs`) has 81 questions. The
expected answer of each was read from the bylaws text.

| Batch | Questions | Purpose |
|---|---|---|
| 1 | 41 | Every setback, FAR, ground coverage, parking, height, staircase, ventilation, basement and road-width table; Hindi; nonsense questions. The matcher was fixed against these. |
| 2 | 27 | Written after batch 1 passed, run once before further changes (held out). It found 10 real problems, all fixed in `2cc6d87`. |
| 3 | 13 | Messy phrasing: typos, "sq.m.", acres, lowercase "far", questions the bylaws cannot answer exactly. Read by eye. |

Two runners:

```bash
# This checkout's code against the real Qdrant (before pushing a change):
npx tsx scripts/bylaws-eval/run-local.mts --env=path/to/render.env
# The deployed site, through the Bylaws tab API (after a deploy):
FORGE_EMAIL=... FORGE_PASS=... node scripts/bylaws-eval/run-live.mjs
```

`run-local` reads only the Qdrant, embedding and Cloudflare keys from the env
file, and never touches the database. `run-live` needs a Trijya account; ask
Kavya for the test admin.

**Results on 17 Oct:**

| | Before (`7512b62`) | Now (`2cc6d87`) |
|---|---|---|
| Batch 1 | 18 / 41 | 41 / 41 |
| All 81, local runner | – | 81 / 81 |
| All 81, live site | – | 81 / 81 |
| First result correct (64 graded) | – | 56 / 64 |
| Latency, live (median / p90) | about 0.5 s | 1.2 s / 2.2 s |

All 8 questions where the right answer is 2nd or 3rd instead of first have no
number in them (issue 6).

---

## 5. TRIJYA-3 services

SSH over Tailscale: `ssh trijya-3@100.99.155.88`. Tailscale must be running on
the PC you connect from. All of these run as the `trijya-3` user, started by
its crontab (`crontab -l`), at boot and then every 1 or 5 minutes if not
running.

| Service | Files | Start / restart | Logs / state |
|---|---|---|---|
| NAS connector :8787 | `~/nas-connector/connector.py`, `start-nas.sh`, `config.json` | `ensure-running.sh` (cron, every minute) | `~/nas-connector/nas.log` |
| Qdrant :6333 | `~/qdrant/{qdrant,config.yaml,api-key}` | `~/qdrant/start-qdrant.sh` (cron) | `~/qdrant/qdrant.log`, data `~/qdrant/storage` (1.7 GB) |
| Indexer | `~/nas-connector/nas_indexer.py` | `run-indexer.sh` (cron, every 5 min); `restart-indexer.sh [--rewalk]` | `~/nas-indexer/{state.db,status.json,indexer.log}` |
| Cloudflare tunnel | `~/cloudflared/` | `ensure-tunnel.sh` (cron, every minute) | `~/cloudflared/tunnel.log` |
| Ollama :11434 | `~/forgie/ollama-start.sh` | cron, every 5 min | |

Gotchas:
- Never check a process with `pgrep -f name` or `pkill -f name` from an SSH
  command that contains that name. It matches your own session. Split the
  string: `pgrep -f "cloudfl""ared"`.
- `nvidia-smi` is at `/usr/lib/wsl/lib/nvidia-smi`.
- The GPU (12 GB) is shared: RIG SURVEILLANCE keeps qwen2.5:7b loaded (about
  5 GB), the embeddings take up to 4 GB, and Forgie's local model about 2 GB.
- The repo copies of the connector, `rag_embed.py` and `nas_indexer.py` are
  the deployed versions. Deploy by `scp` and restart; the old file is kept as
  `*.bak-<date>` on the box.

---

## 6. Open issues, in priority order

Each has what is wrong, why it matters, a suggested fix, and when it is done.
Items marked **Kavya decides** must not be started without her go-ahead.

### 1. Personal ID documents are in the whole-NAS index (privacy). **Kavya decides.**

**What:** the indexer indexes every document, including clients' and staff's
identity and financial papers. By file name alone, `nas_documents_e5` holds
about 72 Aadhaar, 35 PAN, 15 income-tax-return, 6 passport and 3 bank / cheque /
salary-slip files. ID copies inside bundles with other names (RERA, MDDA
submission sets) are on top of that.
**Why it matters:** anyone in Trijya with Files access can find the passage
itself by searching a name or "aadhaar number". When Forgie's NAS tool is used,
passages go to whichever LLM answers, often an external one (issue 3).
Aadhaar numbers have strict rules on storage and display, and India's DPDP Act
limits use to the purpose of collection.
**Suggested fix:**
- Exclude ID and financial documents in the indexer, by file and folder name.
- Skip or redact passages containing Aadhaar (12 digits in groups of 4) or PAN
  (`[A-Z]{5}[0-9]{4}[A-Z]`) patterns.
- Delete those files' points from Qdrant, and mark them excluded in `state.db`
  so they are not re-added.

**Never delete or move anything on the NAS itself.** Kavya has asked that
nothing changes until she says so.
**Done when:** searching "aadhaar", "PAN" or a client's name returns no ID
document passages, and the indexer log shows them skipped.

### 2. Forgie chat does not answer bylaws questions

**What:** in chat, as tested on 14 and 17 Oct:
- The local 3B model answers bylaws questions itself without calling
  `bylaws_search`, and answers wrongly. On staircase width it said there is no
  single minimum.
- A Hindi parking question made the local model try to create a ticket six
  times. The calls were rejected, so nothing was created.
- Gemini called `bylaws_search` six times, then gave up with "Sorry, I didn't
  manage…".
- "How many active projects" prints raw tool JSON.

The Bylaws tab works; chat does not. Kavya asked to leave chat alone until now.
**Suggested fix:**
- Send bylaws, NBC and Hindi rule questions straight to `bylaws_search`. The
  model then writes the answer from `values`, `matchedRow` and `section`,
  citing the document.
- Never let the small local model call write tools.
- Fix the routing so tool-using questions go to a capable model (issue 3).

**Done when:** the questions in `cases.mjs` asked in chat give the same row
and figures as the Bylaws tab, and no raw JSON is shown.

**Update 18 Oct (not yet tested against the live index):** chat no longer
leaves retrieval to the model. `lib/rag/answer.ts` routes bylaws questions
and "what does the document say" questions; the route searches with the whole
message (a follow-up such as "and for commercial?" inherits the topic, use
and plot size of the previous question), then one no-tools call at
temperature 0.2 answers from the numbered passages only, citing them, with a
source list built from the passages. Runs before the filename fast-lane and
the reply cache. The answer goes to the cloud providers first;
`RAG_ANSWER_LOCAL_FIRST=true` keeps it on the local model (issue 3). The
Bylaws tab now calls `POST /api/nas/bylaws/answer`: same passages, plus a
written answer above them. Routing cases are in `scripts/test-rag.ts`.

### 3. Which LLM answers, and what data leaves the network. **Kavya decides.**

**What:** Forgie tries `local` (qwen2.5:3b on TRIJYA-3), then Groq, Gemini and
Cerebras (`ASSISTANT_PROVIDER_ORDER=local,groq,gemini,cerebras`). The 3B model
is too weak for tool use, so most real questions go to an external provider,
carrying task data and NAS passages.
**Options given to Kavya on 17 Oct:**
- **Fully local:** qwen3:14b (9.3 GB) or gpt-oss:20b, both already on the box.
  This needs GPU room: embeddings to the CPU, and RIG SURVEILLANCE sharing the
  model or moving.
- **Hybrid:** company data only to the local model; general questions may use
  the cloud.
- **Keep the cloud,** but never send file contents.

Before any switch, test the candidate model on the same questions against
Gemini.

### 4. `chunkText` writes the overlap twice

**What:** when a paragraph longer than 1200 characters is hard-split, each
piece already starts with the last 150 characters of the previous piece, and
the buffer logic prefixes the previous chunk's tail again. Stored text then
begins with the same ~150 characters twice. That breaks reading tables, and
users see a doubled fragment in excerpts.
**Now:** `cleanPassage` removes the copy whenever passages are read, so
nothing visible is wrong.
**Fix properly:**
- Correct `chunkText` and its Python port `chunk_text` in `nas_indexer.py`
  together, and keep them identical (there is a cross-check in the session
  notes; add one to `test-rag.ts`).
- Re-index both collections.
- Remove `cleanPassage` after the re-index.

### 5. Read tables at index time, not query time

**What:** most of the work in 2.9 rebuilds, at every query, structure that
existed in the PDF:
- clause numbers and headings;
- table column headers;
- rows split across passages.

This costs latency (1.2 s median instead of 0.5 s, mostly the neighbour fetch
of up to about 3 × 200 point ids) and fails on badly OCR'd tables.
**Suggested fix:**
- At index time, chunk tables row-aware (never split a row, repeat the column
  header in each chunk).
- Store `section` (clause number and title), `tableHeader` and the use in the
  payload.
- `query-match.ts` then reads those fields instead of guessing, and the
  neighbour fetch can go.

PyMuPDF's `find_tables()` on the connector is a good starting point.
**Done when:** the test pack still passes 81/81 with the neighbour fetch
removed, and median latency is back under 0.7 s.

### 6. Questions without a number: right answer not always first

**What:** 56 of 64 graded questions have the right answer first. The other 8
have it 2nd or 3rd, and all have no number:
- `park-ecs-base`, `fire-hr`, `hi-height`, `hi-park`;
- `b2-park-office`, `b2-park-ind`, `b2-park-marriage`, `b2-set-petrol`.

For example, "parking requirement for office building" shows the multi-level
parking clause first.
**Suggested fix:** with issue 5's payload fields, prefer a row whose label is
the asked use in the asked topic's table. Add these 8 as `top: 1` cases.

### 7. Hindi bylaws have poor OCR

**What:** `Compiled_byelaws_I.pdf` (Uttarakhand, Hindi) was OCR'd from images,
and its tables come out garbled: decimals lost ("75" for 7.5), table rules as
`|` and `[`, stray Latin. Those rows now rank last, but their figures are
unreadable, so broad Hindi questions return rough passages.
**Suggested fix:**
- Re-OCR at higher resolution with `hin+eng` and table-aware page
  segmentation (tesseract `--psm 6`).
- Or get a digital (text) copy of the compiled bylaws.

Check with the Hindi cases in the test pack.

### 8. Rules given as a rate are not worked out

**What:** "parking for a 200 sq m shop" should give 2 ECS: shops need 1 ECS
per 100 sq m of floor area. The search looks for a row whose range covers 200,
finds none, and shows related rows.
**Suggested fix:** recognise rate rows ("N per 100 sqm", "N / 125 sqm") and
compute the result when the question gives an area. Show the working
("1 per 100 sq m × 200 sq m = 2 ECS").

### 9. Min score for whole-NAS content is not calibrated

`RAG_MIN_SCORE=0.82` was calibrated on the bylaws collection. The same value is
used for `nas_documents_e5`, where passages are shorter and noisier (BOQs,
letters, spreadsheets). Calibrate it the same way, on 20 or more relevant and
irrelevant content questions. If the value differs, make it per collection.

### 10. Indexer: 46 files given up, and duplicate results

**Failed files:**
- 21 `.xlsx` that are not zip files: really old `.xls`, or corrupt. Try `xlrd`
  when `openpyxl` fails, and the reverse for `.xls` that are really `.xlsx`.
- 8 over the size limit.
- 8 `.xls` that `xlrd` cannot read.
- 6 encrypted PDFs.
- 3 others.

`sqlite3 ~/nas-indexer/state.db "select path,error from files where status='GAVE_UP'"`
lists them.

**Duplicates:** the same file in several folders shows up several times in
"search inside files" (e.g. `Deduction_Details.pdf`). Group results by content
hash ("also in 3 other folders").

### 11. No backup of the self-hosted Qdrant

`~/qdrant/snapshots` is empty. `nas_documents_e5` (281k passages, days of GPU
time) exists only on TRIJYA-3. Schedule a weekly snapshot of both collections
(`POST /collections/{name}/snapshots`) and copy it off the box. Re-sync the
Qdrant Cloud fallback copy of the bylaws, or retire it.

### 12. Smaller items

- **Topic and use vocabulary** in `query-match.ts` (`TOPICS`, `USES`) is
  hand-written. Extend it as real questions come in: open space, plinth,
  mumty, balcony, compounding fees, EWS/LIG, farmhouse.
- **Reference books** (Time-Saver Standards, Neufert; 7,200 passages) are in
  the bylaws collection though they are not rules. Ranking puts them last;
  consider moving them to their own collection.
- **Box services** depend on cron; a `systemd` setup would need sudo. The old
  `~/forgie/watchdog.sh` (needs a Windows logon) can be retired once Kavya
  agrees.
- **Forge's own NAS backfill** (`POST /api/nas/reindex`, `NAS_INDEX_FOLDERS`)
  overlaps with the box indexer. Decide whether to keep it for
  uploads-through-Forge only, or remove it.

---

## 7. What to send back

For each item you take on: the commit, the test pack result (`run-local`
before the push, `run-live` after the deploy), and anything you changed on
TRIJYA-3, with the path of the `.bak` copy.
