# Deploying the updated NAS connector to TRIJYA-3

**Why this doc exists:** the connector (`scripts/nas-connector/connector.py`)
gained a new `GET /extract` endpoint this session (large-PDF text extraction
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
   # Debian/Ubuntu
   sudo apt-get install -y tesseract-ocr
   # or on whatever TRIJYA-3 actually runs — adjust accordingly
   ```

3. **Restart the connector process.** However it's currently kept running
   (systemd service, screen/tmux session, Docker container, etc. — not
   documented in this repo) — restart it so the new code and deps take
   effect.

4. **Smoke-test `/extract`** through the Cloudflare Tunnel, same auth as
   every other connector call:
   ```bash
   curl -X GET \
     -H "CF-Access-Client-Id: <value>" \
     -H "CF-Access-Client-Secret: <value>" \
     "https://<TRIJYA_NAS_BASE_URL>/extract?server=WD&path=/utility%20data/By_Laws/NBCs/<a%20real%20NBC%20volume%20filename>.pdf"
   ```
   A real large PDF to test against: any file under the `NBCs/` or
   `ARCHITECTURAL STANDARDS/` subfolders listed in
   `docs/NAS_RAG_REVIEW.md`'s "Real bylaws folder contents" section — those
   are exactly the files that have been failing with `skippedTooLarge` until
   now. Expect `{"ok": true, "text": "...", "method": "text"|"ocr", "truncated": false}`.
   `"method": "ocr"` means that particular PDF had no selectable text and
   got OCR'd — check a couple to get a sense of how many of the bylaws are
   scans (this also answers question 5 in the original review doc).

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
(`lib/nas/client.ts`) already treats a 404 on `/extract` as "not available yet"
and falls back to today's `skippedTooLarge` behavior, so Forge's side has
been safe to ship ahead of this the whole time.
