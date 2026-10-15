"""
Whole-NAS content indexer for Forge's RAG, running on TRIJYA-3.

Forge only content-indexes files uploaded through Forge (and the bylaws
folder). Most files reach the NAS over SMB, so they were never searchable by
content. This daemon walks every NAS share, finds the files whose text can be
indexed (PDF, Word, Excel, plain text), and indexes new and changed ones into
the same Qdrant collection Forge searches, in exactly Forge's format:

  - passages cut like lib/rag/chunk.ts (1,200 characters, 150 overlap,
    paragraph-aware) and near-empty ones dropped (MIN_CHUNK_LETTERS),
  - the same deterministic point ids (sha256 of org:server:path:chunkIndex),
    so a file indexed here and later re-indexed by Forge (an upload) simply
    overwrites the same points,
  - the same payload fields Forge reads.

It runs next to the NAS and the GPU, so nothing large travels to Render:
files are read over the LAN, PDFs go through the connector's own extractor
(text layer, OCR for unreadable pages), embeddings come from the connector's
/embed (one model on the GPU, shared with live search), and points go to the
Qdrant on this box.

Change detection is by size + modified time per file (state in SQLite, see
STATE_DB), with a content hash so a touched-but-unchanged file is not
re-embedded. A file that disappears from a COMPLETE walk has its points
removed. Bylaws files are left to the bylaws pipeline; backup and recycle-bin
folders are skipped. Failed files are retried with backoff.

Run: .venv/bin/python nas_indexer.py   (see run-indexer.sh; logs to indexer.log)
"""
import hashlib
import io
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.request
import zipfile
from collections import deque
from xml.etree import ElementTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# OCR is the expensive part. General NAS PDFs are mostly drawings and reports;
# cap OCR well below the bylaws pipeline's 300 pages. Must be set before the
# connector module is imported (it reads these at import time).
os.environ.setdefault("NAS_OCR_MAX_PAGES", os.environ.get("NAS_INDEXER_OCR_MAX_PAGES", "20"))
os.environ.setdefault("NAS_OCR_NICE", "15")

import connector  # noqa: E402  (SMB config, _connect, _extract_pdf, DENY_DIR)

ORG = os.environ.get("NAS_INDEXER_ORG", "trijya")
COLLECTION = os.environ.get("NAS_INDEXER_COLLECTION", "nas_documents_e5")
MODEL = os.environ.get("NAS_INDEXER_MODEL", "intfloat/multilingual-e5-large")
DIM = int(os.environ.get("NAS_INDEXER_DIM", "1024"))
PASSAGE_PREFIX = os.environ.get("NAS_INDEXER_PASSAGE_PREFIX", "passage: ")
CONNECTOR_URL = os.environ.get("NAS_INDEXER_CONNECTOR", "http://127.0.0.1:8787").rstrip("/")
QDRANT_URL = os.environ.get("NAS_INDEXER_QDRANT", "http://127.0.0.1:6333").rstrip("/")
QDRANT_KEY_FILE = os.path.expanduser(os.environ.get("NAS_INDEXER_QDRANT_KEY_FILE", "~/qdrant/api-key"))
STATE_DB = os.path.expanduser(os.environ.get("NAS_INDEXER_DB", "~/nas-indexer/state.db"))
STATUS_FILE = os.path.expanduser(os.environ.get("NAS_INDEXER_STATUS", "~/nas-indexer/status.json"))
WALK_EVERY = int(os.environ.get("NAS_INDEXER_WALK_EVERY", str(2 * 3600)))  # seconds between full walks
MAX_FILE_MB = int(os.environ.get("NAS_INDEXER_MAX_FILE_MB", "300"))
MAX_TEXT_CHARS = int(os.environ.get("NAS_INDEXER_MAX_TEXT_CHARS", "5000000"))  # = Forge RAG_MAX_TEXT_CHARS
MAX_ATTEMPTS = int(os.environ.get("NAS_INDEXER_MAX_ATTEMPTS", "4"))
EMBED_BATCH = 64
UPSERT_BATCH = 256

# Text formats only. Images and drawings carry no indexable text.
EXTS = {"pdf", "docx", "xlsx", "xls", "txt", "csv", "tsv", "md", "rtf"}
# The bylaws folder belongs to the bylaws pipeline (its own collection),
# matched like lib/nas/bylaws-crawl.ts isBylawsPath.
BYLAWS = re.compile(r"(?i)(^|/)utility[ _-]*data/+bye?[\s_-]*laws?(/|$)")

# Not documents: software installers and drivers copied onto the NAS, and the
# readme / licence / log files that come with them or that AutoCAD and Revit
# write next to drawings. Measured on WD (Oct 2026): ~1,500 of 27,000 text
# files were installer/driver content.
JUNK_DIR = re.compile(r"(?i)^(softwares?|drivers?|.*\bdriver\b.*|setup|installers?|program files.*|appdata|x64|x86|_?getintopc.*|"
                      r"libraries)$")  # "Libraries": Revit's bundled family/type catalogues under user profiles
JUNK_FILE = re.compile(r"(?i)^(readme|read me|license|licence|eula|.*licenseagreement.*|audit report|verifydbxml|changelog|version|third.?party.*|"
                       r"free download sketchup.*|.*\.log)(\s*\(\d+\))?\.(txt|rtf|md)$")

TARGET_CHARS, OVERLAP_CHARS = 1200, 150
MIN_CHUNK_LETTERS = int(os.environ.get("RAG_MIN_CHUNK_LETTERS", "40"))


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


# ── Forge-compatible chunking and ids ─────────────────────────────────────────

def chunk_text(text, target=TARGET_CHARS, overlap=OVERLAP_CHARS):
    """Port of lib/rag/chunk.ts chunkText."""
    clean = text.replace("\r\n", "\n").strip()
    if not clean:
        return []
    target = max(1, int(target))
    overlap = min(max(0, int(overlap)), target - 1)
    paragraphs = [p.strip() for p in re.split(r"\n{2,}", clean)]
    pieces = []
    for p in paragraphs:
        if not p:
            continue
        if len(p) <= target:
            pieces.append(p)
            continue
        for i in range(0, len(p), target - overlap):
            pieces.append(p[i:i + target])
    chunks, buf = [], ""
    for piece in pieces:
        candidate = f"{buf}\n\n{piece}" if buf else piece
        if len(candidate) > target and buf:
            chunks.append(buf)
            tail = buf[max(0, len(buf) - overlap):]
            buf = f"{tail}\n\n{piece}"
        else:
            buf = candidate
    if buf.strip():
        chunks.append(buf.strip())
    return chunks


def letter_count(text):
    """Letters in any script, including combining marks (Devanagari vowel signs)."""
    return sum(1 for ch in text if unicodedata.category(ch)[0] in ("L", "M"))


def substantive(chunks):
    return [c for c in chunks if letter_count(c) >= MIN_CHUNK_LETTERS]


def point_id(server, path, index):
    """Same as lib/rag/qdrant.ts pointId."""
    h = hashlib.sha256(f"{ORG}:{server}:{path}:{index}".encode()).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


# ── HTTP helpers ─────────────────────────────────────────────────────────────

_QKEY = None


def _qkey():
    global _QKEY
    if _QKEY is None:
        _QKEY = open(QDRANT_KEY_FILE).read().strip()
    return _QKEY


def _http(method, url, body=None, headers=None, timeout=300):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def qdrant(method, path, body=None):
    return _http(method, QDRANT_URL + path, body, {"api-key": _qkey()})


def embed(texts):
    out = []
    for i in range(0, len(texts), EMBED_BATCH):
        batch = [PASSAGE_PREFIX + t for t in texts[i:i + EMBED_BATCH]]
        for attempt in range(5):
            try:
                r = _http("POST", CONNECTOR_URL + "/embed", {"model": MODEL, "texts": batch}, timeout=600)
                break
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(5 * (attempt + 1))
        vecs = r.get("vectors") or []
        if len(vecs) != len(batch) or any(len(v) != DIM for v in vecs):
            raise RuntimeError(f"embedding returned {len(vecs)} vectors, wanted {len(batch)} x {DIM}")
        out.extend(vecs)
    return out


def ensure_collection():
    try:
        qdrant("GET", f"/collections/{COLLECTION}")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        qdrant("PUT", f"/collections/{COLLECTION}", {"vectors": {"size": DIM, "distance": "Cosine"}})
        log(f"created collection {COLLECTION}")
    # The payload indexes Forge's ensureCollection creates (idempotent).
    for field, schema in (("organizationId", "keyword"), ("server", "keyword"), ("path", "keyword"), ("chunkIndex", "integer")):
        try:
            qdrant("PUT", f"/collections/{COLLECTION}/index?wait=true", {"field_name": field, "field_schema": schema})
        except Exception:
            pass


def _file_filter(server, path, min_index=None):
    must = [
        {"key": "organizationId", "match": {"value": ORG}},
        {"key": "server", "match": {"value": server}},
        {"key": "path", "match": {"value": path}},
    ]
    if min_index is not None:
        must.append({"key": "chunkIndex", "range": {"gte": min_index}})
    return {"must": must}


def upsert(server, path, chunks, vectors):
    name = path.rsplit("/", 1)[-1]
    for i in range(0, len(chunks), UPSERT_BATCH):
        pts = [{
            "id": point_id(server, path, j),
            "vector": vectors[j],
            "payload": {"organizationId": ORG, "server": server, "path": path, "fileName": name,
                        "chunkIndex": j, "text": chunks[j]},
        } for j in range(i, min(i + UPSERT_BATCH, len(chunks)))]
        qdrant("PUT", f"/collections/{COLLECTION}/points?wait=true", {"points": pts})


def prune(server, path, keep):
    """Remove this file's points with chunkIndex >= keep (keep=0: all of them)."""
    qdrant("POST", f"/collections/{COLLECTION}/points/delete?wait=true", {"filter": _file_filter(server, path, keep)})


# ── Extraction ───────────────────────────────────────────────────────────────

# One SMB session per share, reused for every file. Opening a new session per
# file made the WD NAS refuse connections after a while (Oct 2026: ~1,500
# files failed with ConnectionRefusedError), which can also hit people
# browsing the Files tab at the same time.
_SESSIONS = {}


def _session(server):
    if server not in _SESSIONS:
        _SESSIONS[server] = connector._connect(server)
    return _SESSIONS[server]


def _drop_session(server):
    conn, _ = _SESSIONS.pop(server, (None, None))
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass


def _fetch(server, path):
    for attempt in range(3):
        try:
            conn, share = _session(server)
            buf = io.BytesIO()
            conn.retrieveFile(share, path, buf)
            return buf.getvalue()
        except Exception:
            _drop_session(server)  # a broken session is replaced, not reused
            if attempt == 2:
                raise
            time.sleep(10 * (attempt + 1))


# Pages larger than about A2 (longest side in points) are drawing sheets. Their
# text layer, if any, is labels; OCR of a whole sheet takes up to a minute and
# yields little, so they are not OCR'd.
DRAWING_SHEET_PT = 1300
OCR_MAX_PAGES = int(os.environ.get("NAS_OCR_MAX_PAGES", "20"))


def _pdf_text(b):
    """Like the connector's extractor (text layer; OCR for unreadable pages),
    reading bytes already fetched, and skipping OCR on drawing sheets."""
    import fitz
    try:
        doc = fitz.open(stream=b, filetype="pdf")
    except Exception as e:
        raise RuntimeError(f"PDF could not be opened: {type(e).__name__}")
    try:
        pages = [p.get_text() for p in doc]
        bad = {i for i, t in enumerate(pages) if not connector._readable(t)}
        if len(bad) / (len(pages) or 1) < connector.UNREADABLE_DOC_SHARE:
            return "\n\n".join(pages).strip(), None
        ocr_ok = connector._HAVE_OCR and connector._tesseract_available()
        lang = connector._ocr_lang() if ocr_ok else None
        parts, size, ocred, sheets, skipped = [], 0, 0, 0, 0
        for i, t in enumerate(pages):
            if i not in bad:
                piece = t
            else:
                r = doc[i].rect
                if max(r.width, r.height) > DRAWING_SHEET_PT:
                    sheets += 1
                    continue
                if not ocr_ok or ocred >= OCR_MAX_PAGES:
                    skipped += 1
                    continue
                pix = doc[i].get_pixmap(matrix=fitz.Matrix(connector.OCR_ZOOM, connector.OCR_ZOOM))
                img = connector.Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                piece = connector.pytesseract.image_to_string(img, lang=lang, nice=connector.OCR_NICE)
                ocred += 1
            parts.append(piece)
            size += len(piece)
            if size > MAX_TEXT_CHARS:
                break
        notes = []
        if ocred:
            notes.append(f"{ocred} page(s) OCR'd")
        if sheets:
            notes.append(f"{sheets} drawing sheet(s) without text skipped")
        if skipped:
            notes.append(f"{skipped} unreadable page(s) left out")
        return "\n\n".join(parts).strip(), "; ".join(notes) or None
    finally:
        doc.close()


def _decode(b):
    if b.startswith(b"\xff\xfe") or b.startswith(b"\xfe\xff"):
        return b.decode("utf-16", errors="replace")
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return b.decode("cp1252", errors="replace")


_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _docx_text(b):
    with zipfile.ZipFile(io.BytesIO(b)) as z:
        root = ElementTree.fromstring(z.read("word/document.xml"))
    paras = []
    for p in root.iter(_W + "p"):
        parts = []
        for x in p.iter():
            if x.tag == _W + "t":
                parts.append(x.text or "")
            elif x.tag == _W + "tab":
                parts.append("\t")
            elif x.tag in (_W + "br", _W + "cr"):
                parts.append("\n")
        paras.append("".join(parts))
    # Paragraphs separated by a blank line, as mammoth's raw text does.
    return "\n\n".join(x for x in paras if x.strip())


def _sheet_text(b, ext):
    out = []
    if ext == "xlsx":
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(b), read_only=True, data_only=True)
        for ws in wb.worksheets:
            rows = [",".join("" if v is None else str(v) for v in row) for row in ws.iter_rows(values_only=True)]
            rows = [r for r in rows if r.strip(",")]
            if rows:
                out.append(f"# Sheet: {ws.title}\n" + "\n".join(rows))
    else:
        import xlrd
        wb = xlrd.open_workbook(file_contents=b)
        for sh in wb.sheets():
            rows = [",".join(str(c.value) if c.value not in ("", None) else "" for c in sh.row(r)) for r in range(sh.nrows)]
            rows = [r for r in rows if r.strip(",")]
            if rows:
                out.append(f"# Sheet: {sh.name}\n" + "\n".join(rows))
    return "\n\n".join(out)


def extract(server, path, ext):
    """-> (text, note) or raises with a reason."""
    b = _fetch(server, path)
    if ext == "pdf":
        text, note = _pdf_text(b)
        return text[:MAX_TEXT_CHARS], note
    if ext == "docx":
        text = _docx_text(b)
    elif ext in ("xlsx", "xls"):
        text = _sheet_text(b, ext)
    else:
        text = _decode(b)
    return text[:MAX_TEXT_CHARS], None


# ── State ────────────────────────────────────────────────────────────────────

def db():
    os.makedirs(os.path.dirname(STATE_DB), exist_ok=True)
    c = sqlite3.connect(STATE_DB)
    c.execute("""CREATE TABLE IF NOT EXISTS files (
        server TEXT, path TEXT, size INTEGER, mtime INTEGER,
        status TEXT,            -- PENDING | INDEXED | FAILED | GAVE_UP
        chunks INTEGER DEFAULT 0, content_hash TEXT, error TEXT,
        attempts INTEGER DEFAULT 0, next_try REAL DEFAULT 0,
        indexed_at REAL, seen_walk INTEGER,
        PRIMARY KEY (server, path))""")
    c.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)")
    c.commit()
    return c


def meta_get(c, k, default=None):
    r = c.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return r[0] if r else default


def meta_set(c, k, v):
    c.execute("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))
    c.commit()


# ── Walk ─────────────────────────────────────────────────────────────────────

def walk(server):
    """All indexable files on a share -> (dict path -> (size, mtime), complete)."""
    conn, share = connector._connect(server)
    found, complete = {}, True
    q = deque(["/"])
    try:
        while q:
            p = q.popleft()
            try:
                items = conn.listPath(share, p)
            except Exception:
                complete = False
                continue
            for f in items:
                if f.filename in (".", ".."):
                    continue
                fp = p.rstrip("/") + "/" + f.filename
                if f.isDirectory:
                    if not connector.DENY_DIR.search(f.filename) and not JUNK_DIR.match(f.filename) and not BYLAWS.search(fp + "/"):
                        q.append(fp)
                    continue
                ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
                if ext not in EXTS or f.filename.startswith("~$") or JUNK_FILE.match(f.filename) or BYLAWS.search(fp):
                    continue
                found[fp] = (int(f.file_size), int(f.last_write_time or 0))
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return found, complete


def sync_walk(c):
    walk_no = int(meta_get(c, "walk_no", "0")) + 1
    total_new = total_changed = total_gone = 0
    for server in connector.SERVERS:
        t0 = time.time()
        try:
            found, complete = walk(server)
        except Exception as e:
            log(f"walk {server} failed: {type(e).__name__}: {e}")
            continue
        known = {p: (s, m, st) for p, s, m, st in c.execute("SELECT path, size, mtime, status FROM files WHERE server=?", (server,))}
        new = changed = 0
        for p, (size, mtime) in found.items():
            k = known.get(p)
            if k is None:
                c.execute("INSERT INTO files (server, path, size, mtime, status, seen_walk) VALUES (?,?,?,?, 'PENDING', ?)", (server, p, size, mtime, walk_no))
                new += 1
            elif (k[0], k[1]) != (size, mtime):
                c.execute("UPDATE files SET size=?, mtime=?, status='PENDING', attempts=0, next_try=0, seen_walk=? WHERE server=? AND path=?",
                          (size, mtime, walk_no, server, p))
                changed += 1
            else:
                c.execute("UPDATE files SET seen_walk=? WHERE server=? AND path=?", (walk_no, server, p))
        gone = 0
        if complete:
            # Only a complete walk proves a file is gone (a folder that failed
            # to list would otherwise look like deleted files).
            for (p,) in c.execute("SELECT path FROM files WHERE server=? AND seen_walk<?", (server, walk_no)).fetchall():
                try:
                    prune(server, p, 0)
                    c.execute("DELETE FROM files WHERE server=? AND path=?", (server, p))
                    gone += 1
                except Exception as e:
                    log(f"remove {server}:{p} failed: {e}")
        c.commit()
        log(f"walk {server}: {len(found)} indexable files, {new} new, {changed} changed, {gone} removed, "
            f"{'complete' if complete else 'INCOMPLETE (no removals)'}, {time.time() - t0:.0f}s")
        total_new += new; total_changed += changed; total_gone += gone
    meta_set(c, "walk_no", walk_no)
    meta_set(c, "last_walk", int(time.time()))
    return total_new, total_changed, total_gone


# ── Index one file ───────────────────────────────────────────────────────────

BACKOFF = [15 * 60, 3600, 6 * 3600, 24 * 3600]


def index_one(c, server, path, size):
    ext = path.rsplit(".", 1)[-1].lower()
    if size == 0:
        c.execute("UPDATE files SET status='INDEXED', chunks=0, error='empty file', attempts=0 WHERE server=? AND path=?", (server, path))
        c.commit()
        return "empty file"
    if size > MAX_FILE_MB * 1024 * 1024:
        c.execute("UPDATE files SET status='GAVE_UP', error=? WHERE server=? AND path=?",
                  (f"file is {size / 1048576:.0f} MB, over the {MAX_FILE_MB} MB limit", server, path))
        c.commit()
        return "skipped"
    try:
        text, note = extract(server, path, ext)
        h = hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()
        row = c.execute("SELECT content_hash, chunks FROM files WHERE server=? AND path=?", (server, path)).fetchone()
        if row and row[0] == h:
            c.execute("UPDATE files SET status='INDEXED', error=NULL, attempts=0 WHERE server=? AND path=?", (server, path))
            c.commit()
            return "unchanged"
        chunks = substantive(chunk_text(text))
        if chunks:
            upsert(server, path, chunks, embed(chunks))
        prune(server, path, len(chunks))
        warn = note
        if not chunks:
            warn = "no passage had enough readable text to index"
        c.execute("UPDATE files SET status='INDEXED', chunks=?, content_hash=?, error=?, attempts=0, next_try=0, indexed_at=? "
                  "WHERE server=? AND path=?", (len(chunks), h, warn, time.time(), server, path))
        c.commit()
        return f"{len(chunks)} passages"
    except Exception as e:
        reason = f"{type(e).__name__}: {str(e)[:300]}"
        a = (c.execute("SELECT attempts FROM files WHERE server=? AND path=?", (server, path)).fetchone() or [0])[0] + 1
        status = "GAVE_UP" if a >= MAX_ATTEMPTS else "FAILED"
        c.execute("UPDATE files SET status=?, error=?, attempts=?, next_try=? WHERE server=? AND path=?",
                  (status, reason, a, time.time() + BACKOFF[min(a - 1, len(BACKOFF) - 1)], server, path))
        c.commit()
        return f"failed ({reason[:80]})"


def write_status(c, extra=None):
    counts = dict(c.execute("SELECT status, count(*) FROM files GROUP BY status").fetchall())
    passages = c.execute("SELECT coalesce(sum(chunks),0) FROM files WHERE status='INDEXED'").fetchone()[0]
    s = {"updated": int(time.time()), "collection": COLLECTION, "files": counts, "passages": passages,
         "last_walk": int(meta_get(c, "last_walk", "0")), **(extra or {})}
    tmp = STATUS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f)
    os.replace(tmp, STATUS_FILE)


def main():
    import argparse
    ap = argparse.ArgumentParser(description="Whole-NAS content indexer")
    ap.add_argument("--walk-only", action="store_true", help="walk the shares, update the queue, print counts, exit")
    ap.add_argument("--max-files", type=int, default=0, help="index at most N files, then exit (testing)")
    args = ap.parse_args()

    c = db()
    ensure_collection()
    log(f"indexer up: org={ORG} collection={COLLECTION} model={MODEL} exts={sorted(EXTS)}")
    if args.walk_only:
        sync_walk(c)
        write_status(c)
        log(json.dumps(json.load(open(STATUS_FILE))))
        return
    done_since = 0
    while True:
        if args.max_files and done_since >= args.max_files:
            write_status(c)
            return
        if time.time() - int(meta_get(c, "last_walk", "0")) >= WALK_EVERY:
            n, ch, g = sync_walk(c)
            write_status(c)
        row = c.execute(
            "SELECT server, path, size FROM files WHERE status IN ('PENDING','FAILED') AND next_try<=? "
            "ORDER BY status='FAILED', size LIMIT 1", (time.time(),)).fetchone()
        if not row:
            write_status(c, {"idle": True})
            time.sleep(60)
            continue
        server, path, size = row
        t0 = time.time()
        result = index_one(c, server, path, size)
        done_since += 1
        log(f"{server}:{path} ({size / 1048576:.1f} MB): {result} in {time.time() - t0:.1f}s")
        if done_since % 25 == 0:
            write_status(c)


if __name__ == "__main__":
    main()
