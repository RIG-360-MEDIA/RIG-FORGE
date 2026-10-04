# Deploying the updated NAS connector to TRIJYA-3

**Why this doc exists:** the connector (`scripts/nas-connector/connector.py`)
gained text extraction endpoints (`POST /extract/jobs`, `GET /extract/jobs/{id}`) (large-PDF text extraction
+ OCR fallback — see `docs/RAG_BACKLOG_CHANGES.md`, items C/D). It needs
deploying to TRIJYA-3 before it does anything. **This can't be done from a
coding session like this one** — there's no SSH/VPN path to TRIJYA-3 from
here, and `TRIJYA_NAS_BASE_URL` is unset in this environment's `.env`, so
there isn't even a way to reach the connector's existing HTTP API, let alone
push new code to the box. This is a manual step for whoever has access to
TRIJYA-3 (per the handoff doc, that's "Us"/Kavya, not something CI-driven —
there's no existing deploy script or service file in this repo to go on).

## What needs to happen on TRIJYA-3

1. **Pull the latest code.** Get `scripts/nas-connector/connector.py` and
   the new `scripts/nas-connector/requirements.txt` (didn't exist before
   this session — the connector's actual Python deps were never written
   down anywhere until now) onto the box, however code normally gets there
   (git pull, scp, etc. — not documented, so use whatever's already in
   place).

2. **Install the new dependencies:**
   ```bash
   pip install -r scripts/nas-connector/requirements.txt
   ```
   This adds `pymupdf` and `pytesseract` (new) alongside the existing
   `fastapi`, `pysmb`, `numpy`. `pytesseract` is a thin wrapper — it also
   needs the **system** `tesseract-ocr` binary, which pip can't install:
   ```bash
   # Debian/Ubuntu (TRIJYA-3 runs the connector on its WSL side)
   sudo apt-get install -y tesseract-ocr tesseract-ocr-hin
   ```
   `tesseract-ocr-hin` is the Hindi language pack. When it is installed the
   connector OCRs with `eng+hin` automatically (several bylaws are Hindi
   government orders); without it, Hindi scans come out as garbage. Check
   with `tesseract --list-langs` (should list `eng` and `hin`).

   Optional connector settings (environment variables, all have defaults):
   `NAS_EXTRACT_WORKERS` (1 — extraction never fans out on this box, which
   also runs the local LLM), `NAS_EXTRACT_MAX_QUEUED` (20), `NAS_EXTRACT_RESULT_TTL`
   (3600 s), `NAS_OCR_MAX_PAGES` (60), `NAS_OCR_ZOOM` (2.0), `NAS_OCR_LANG`
   (forces a language, e.g. `eng`).

3. **Restart the connector process.** However it's currently kept running
   (systemd service, screen/tmux session, Docker container, etc. — not
   documented in this repo) — restart it so the new code and deps take
   effect.

4. **Smoke-test extraction** through the Cloudflare Tunnel, same auth as
   every other connector call. Extraction runs as a background **job**:
   Cloudflare cuts any single request off at about 100 seconds and OCR of a
   big scan takes minutes, so one long request can never work. Start a job,
   then poll it:
   ```bash
   H='-H "CF-Access-Client-Id: <value>" -H "CF-Access-Client-Secret: <value>"'
   # start (returns at once with {"id": "...", "state": "queued"})
   curl -X POST $H "https://<TRIJYA_NAS_BASE_URL>/extract/jobs?server=WD&path=/utility%20data/By_Laws/NBCs/<a%20real%20NBC%20volume%20filename>.pdf"
   # poll every few seconds until "state": "done"
   curl $H "https://<TRIJYA_NAS_BASE_URL>/extract/jobs/<id>"
   ```
   A real large PDF to test against: any file under the `NBCs/` or
   `ARCHITECTURAL STANDARDS/` subfolders listed in
   `docs/NAS_RAG_REVIEW.md`'s "Real bylaws folder contents" section — those
   are exactly the files that have been failing with `skippedTooLarge` until
   now. When done, expect
   `"result": {"ok": true, "text": "...", "method": "text"|"ocr", "truncated": false}`.
   `"method": "ocr"` means that PDF had no selectable text and got OCR'd
   (the result then also says which `lang` was used) — check a couple to see
   how many bylaws are scans (this also answers question 5 in the original
   review doc). Asking for the same file again while it runs, or within an
   hour after, returns the same job instead of redoing it.

5. **Run the real backfill** once this is deployed and the production DB
   has the `BylawsReindexRun`/`lastSeenAt`/`NasReindexRun` additions (see
   `docs/RAG_BACKLOG_CHANGES.md`'s "Not done" section):
   ```bash
   curl -X POST -H "Authorization: Bearer <admin JWT>" \
     https://rig-forge.onrender.com/api/nas/bylaws/reindex
   ```
   then poll `GET .../bylaws/reindex?runId=...` and confirm the NBC/standards
   PDFs that were previously skipped now show up as `indexed`.

## What this does NOT require

No code in this repo needed to change to support this deploy — `nasExtractText`
(`lib/nas/client.ts`) treats a 404 on `/extract/jobs` as "connector not updated
yet" and those files are recorded as skipped/failed with that reason, so
Forge's side is safe to ship ahead of this. Once the connector is updated,
the retry cron (`/api/cron/rag-retry`) picks the failed files up again on its
own; or just re-run the backfill.
