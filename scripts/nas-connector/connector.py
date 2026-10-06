"""
Trijya NAS connector — runs on TRIJYA-3 (LAN-side), fronted by the Cloudflare
Tunnel + Access. Exposes a small REST API over SMB to the two office NAS units.
Reads host/share/username from config.json and the password from a locked file.
No secrets are logged. Cloudflare Access is the auth boundary (same as the LLM).
"""
import os
import io
import re
import json
import time
import tempfile
import threading
from collections import deque

# Don't recurse into backup/recycle/system trees — they're huge and dwarf the
# real project files, wasting the index budget. The folders still appear as
# entries; we just don't walk into them.
DENY_DIR = re.compile(r"(?i)(backup|recycle|system volume information|\$recycle|\.tmp$)")

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from smb.SMBConnection import SMBConnection

BASE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(BASE, "config.json")))
PW = open(CFG["passwordFile"]).read().strip()
SERVERS = {s["label"]: s for s in CFG["servers"]}

# ── Filename index (built in the background) ─────────────────────────────────
# Live recursive SMB walks are slow (hundreds of round-trips), so we keep a flat
# in-memory index of {name, path, isDir, size} per server and refresh it
# periodically. Search hits the index (instant); it falls back to a live walk
# only until the first index build completes.
INDEX = {}                 # server -> list[dict]
INDEX_META = {}            # server -> {"count", "updated", "building"}
INDEX_LOCK = threading.Lock()
INDEX_MAX_ENTRIES = int(os.environ.get("NAS_INDEX_MAX", "80000"))
INDEX_MAX_DEPTH = int(os.environ.get("NAS_INDEX_DEPTH", "9"))
INDEX_INTERVAL = int(os.environ.get("NAS_INDEX_INTERVAL", "1800"))  # 30 min

app = FastAPI(title="trijya-nas-connector")


def _norm(p: str) -> str:
    p = (p or "/").replace("\\", "/")
    while "//" in p:
        p = p.replace("//", "/")
    if not p.startswith("/"):
        p = "/" + p
    return p


def _connect(server: str):
    s = SERVERS.get(server)
    if not s:
        raise HTTPException(404, f"unknown server '{server}'")
    conn = SMBConnection(
        s["username"], PW, "forge-connector", "nas",
        use_ntlm_v2=True, is_direct_tcp=True,
    )
    try:
        ok = conn.connect(s["host"], 445, timeout=10)
    except Exception as e:
        raise HTTPException(502, f"{server}: connect failed ({type(e).__name__})")
    if not ok:
        raise HTTPException(502, f"{server}: connect rejected")
    return conn, s["share"]


def _build_index(server: str):
    with INDEX_LOCK:
        INDEX_META[server] = {**INDEX_META.get(server, {}), "building": True}
    entries = []
    deadline = time.time() + 300
    try:
        conn, share = _connect(server)
    except Exception:
        with INDEX_LOCK:
            INDEX_META[server] = {**INDEX_META.get(server, {}), "building": False}
        return
    try:
        # Breadth-first so the entry budget is spread ACROSS all top-level
        # project folders (shallow, most-searched paths) rather than being
        # exhausted deep inside one subtree.
        queue = deque([("/", 0)])
        while queue:
            if len(entries) >= INDEX_MAX_ENTRIES or time.time() > deadline:
                break
            p, depth = queue.popleft()
            try:
                items = conn.listPath(share, p)
            except Exception:
                continue
            for f in items:
                if f.filename in (".", ".."):
                    continue
                fp = (p.rstrip("/") + "/" + f.filename)
                entries.append({
                    "name": f.filename, "path": fp,
                    "isDir": bool(f.isDirectory), "size": int(f.file_size),
                    # mtime powers "latest / newest" search + date sorting.
                    "mtime": int(f.last_write_time or 0),
                })
                if f.isDirectory and depth < INDEX_MAX_DEPTH and not DENY_DIR.search(f.filename):
                    queue.append((fp, depth + 1))
    finally:
        try:
            conn.close()
        except Exception:
            pass
    with INDEX_LOCK:
        INDEX[server] = entries
        INDEX_META[server] = {"count": len(entries), "updated": int(time.time()), "building": False}


# ── Semantic embedding index (nomic-embed-text via local ollama) ─────────────
# Adds meaning-based search on top of the substring index: filename + parent
# folder text is embedded and ranked by cosine similarity to the query. Bounded
# to files (cap NAS_EMBED_MAX) so the build stays fast on the preemptible box.
import urllib.request

try:
    import numpy as np
    _HAVE_NUMPY = True
except Exception:
    _HAVE_NUMPY = False

EMBED_MODEL = os.environ.get("NAS_EMBED_MODEL", "nomic-embed-text")
EMBED_URL = os.environ.get("OLLAMA_EMBED_URL", "http://localhost:11434/api/embed")
EMBED_MAX = int(os.environ.get("NAS_EMBED_MAX", "20000"))
EMBED = {}          # server -> {"mat": np.ndarray(N,D) normalized, "meta": [{name,path}]}
EMBED_META = {}     # server -> {"count", "updated", "building"}
EMBED_LOCK = threading.Lock()


def _embed_batch(texts):
    body = json.dumps({"model": EMBED_MODEL, "input": texts}).encode()
    req = urllib.request.Request(EMBED_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read()).get("embeddings") or []


def _build_embed_index(server):
    if not _HAVE_NUMPY:
        return
    with INDEX_LOCK:
        entries = [e for e in INDEX.get(server, []) if not e["isDir"]][:EMBED_MAX]
    if not entries:
        return
    EMBED_META[server] = {"count": 0, "updated": 0, "building": True}
    vecs, meta = [], []
    B = 96
    for i in range(0, len(entries), B):
        chunk = entries[i:i + B]
        texts = []
        for e in chunk:
            parts = e["path"].strip("/").split("/")
            parent = parts[-2] if len(parts) >= 2 else ""
            texts.append((parent + " " + e["name"]).strip()[:200])
        try:
            embs = _embed_batch(texts)
        except Exception:
            continue
        for e, v in zip(chunk, embs):
            if v:
                vecs.append(v)
                meta.append({"name": e["name"], "path": e["path"]})
    if not vecs:
        EMBED_META[server] = {"count": 0, "updated": int(time.time()), "building": False}
        return
    mat = np.array(vecs, dtype=np.float32)
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1
    mat = mat / norms
    with EMBED_LOCK:
        EMBED[server] = {"mat": mat, "meta": meta}
        EMBED_META[server] = {"count": len(meta), "updated": int(time.time()), "building": False}


def _indexer_loop():
    while True:
        for server in list(SERVERS.keys()):
            try:
                _build_index(server)
            except Exception:
                pass
            try:
                _build_embed_index(server)
            except Exception:
                pass
        time.sleep(INDEX_INTERVAL)


@app.on_event("startup")
def _start_indexer():
    threading.Thread(target=_indexer_loop, daemon=True).start()


@app.get("/health")
def health():
    with INDEX_LOCK:
        meta = {k: {"count": v.get("count", 0), "updated": v.get("updated", 0)} for k, v in INDEX_META.items()}
    with EMBED_LOCK:
        emeta = {k: {"count": v.get("count", 0), "updated": v.get("updated", 0)} for k, v in EMBED_META.items()}
    return {"ok": True, "servers": list(SERVERS.keys()), "index": meta, "semantic": emeta}


@app.get("/semantic")
def semantic(server: str, q: str, k: int = 15):
    if not _HAVE_NUMPY:
        raise HTTPException(503, "semantic index unavailable (numpy missing)")
    with EMBED_LOCK:
        idx = EMBED.get(server)
    if not idx:
        raise HTTPException(503, f"semantic index for '{server}' not ready yet")
    try:
        qv = _embed_batch([q])[0]
    except Exception as e:
        raise HTTPException(502, f"embed failed: {type(e).__name__}")
    qa = np.array(qv, dtype=np.float32)
    qa = qa / (np.linalg.norm(qa) or 1)
    scores = idx["mat"] @ qa
    k = max(1, min(k, 50))
    top = np.argsort(-scores)[:k]
    results = [
        {"name": idx["meta"][int(i)]["name"], "path": idx["meta"][int(i)]["path"], "score": round(float(scores[int(i)]), 4)}
        for i in top
    ]
    return {"server": server, "query": q, "results": results}


@app.post("/reindex")
def reindex():
    for server in list(SERVERS.keys()):
        threading.Thread(target=_build_index, args=(server,), daemon=True).start()
    return {"ok": True, "reindexing": list(SERVERS.keys())}


@app.get("/servers")
def servers():
    return {"servers": [{"label": k} for k in SERVERS]}


@app.get("/list")
def list_dir(server: str, path: str = "/"):
    conn, share = _connect(server)
    try:
        items = conn.listPath(share, _norm(path))
    except Exception as e:
        raise HTTPException(404, f"cannot list '{path}': {type(e).__name__}")
    finally:
        try:
            conn.close()
        except Exception:
            pass
    out = []
    for f in items:
        if f.filename in (".", ".."):
            continue
        out.append({
            "name": f.filename,
            "isDir": bool(f.isDirectory),
            "size": int(f.file_size),
            "mtime": int(f.last_write_time),
        })
    out.sort(key=lambda x: (not x["isDir"], x["name"].lower()))
    return {"server": server, "path": _norm(path), "items": out}


@app.get("/download")
def download(server: str, path: str):
    conn, share = _connect(server)
    tmp = tempfile.NamedTemporaryFile(delete=False)
    try:
        conn.retrieveFile(share, _norm(path), tmp)
        tmp.flush()
        tmp.close()
    except Exception as e:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass
        raise HTTPException(404, f"cannot download '{path}': {type(e).__name__}")
    finally:
        try:
            conn.close()
        except Exception:
            pass
    name = os.path.basename(_norm(path)) or "download"
    return FileResponse(
        tmp.name,
        filename=name,
        background=BackgroundTask(lambda: os.path.exists(tmp.name) and os.unlink(tmp.name)),
    )


# ── Connector-side text extraction (large/scanned PDFs) ───────────────────────
# Render (Forge's host) is memory-constrained (512 MB, free plan) and can't
# safely download+parse the NBC/standards PDFs (50-120+ MB each). TRIJYA-3
# isn't, so for those files Forge asks the connector to extract text itself
# and send text, never raw bytes. Falls back to OCR when the PDF has no
# selectable text at all (a scan).
#
# Runs as a background JOB, not inside one request: Forge reaches this box
# through Cloudflare, which cuts any request off at ~100 s, and OCR of a big
# scan takes minutes. Forge starts a job (POST /extract/jobs, returns at once)
# and polls GET /extract/jobs/{id} with short requests until it is done.
#   - One worker by default (NAS_EXTRACT_WORKERS): this box also runs the
#     local LLM, so extraction must never fan out.
#   - A request for a file that already has a queued, running or recently
#     finished job returns THAT job, so a retry after a Forge-side timeout
#     reuses the work instead of OCR-ing the same file again.
#   - Finished results are kept for NAS_EXTRACT_RESULT_TTL seconds (1 h).
#   - Too many queued jobs -> 429, so callers back off instead of piling up.
try:
    # PyMuPDF. `import pymupdf` is the current name; the old `fitz` alias is
    # deprecated and slated for removal, but older installs only have that.
    try:
        import pymupdf as fitz
    except ImportError:
        import fitz
    _HAVE_FITZ = True
except Exception:
    _HAVE_FITZ = False

try:
    import pytesseract
    from PIL import Image
    _HAVE_OCR = True
except Exception:
    _HAVE_OCR = False

import shutil
import uuid
from concurrent.futures import ThreadPoolExecutor

OCR_MAX_PAGES = int(os.environ.get("NAS_OCR_MAX_PAGES", "60"))
OCR_ZOOM = float(os.environ.get("NAS_OCR_ZOOM", "2.0"))  # ~144 DPI at 2x
EXTRACT_WORKERS = max(1, int(os.environ.get("NAS_EXTRACT_WORKERS", "1")))
EXTRACT_RESULT_TTL = int(os.environ.get("NAS_EXTRACT_RESULT_TTL", "3600"))
EXTRACT_MAX_QUEUED = int(os.environ.get("NAS_EXTRACT_MAX_QUEUED", "20"))
EXTRACT_DEFAULT_MAX_CHARS = 1_000_000

_extract_pool = ThreadPoolExecutor(max_workers=EXTRACT_WORKERS, thread_name_prefix="extract")
_jobs = {}  # id -> dict(state, key, created, finished, result)
_jobs_lock = threading.Lock()
_ocr_lang_cache = None


def _ocr_lang() -> str:
    """eng+hin when the Hindi language pack is installed (many bylaws are
    Hindi government orders), else eng. NAS_OCR_LANG overrides."""
    global _ocr_lang_cache
    if _ocr_lang_cache is None:
        forced = os.environ.get("NAS_OCR_LANG", "").strip()
        if forced:
            _ocr_lang_cache = forced
        else:
            try:
                langs = set(pytesseract.get_languages(config=""))
            except Exception:
                # tesseract missing or failing: answer "eng" but do NOT cache
                # it, so installing tesseract (and the Hindi pack) later takes
                # effect without restarting the connector.
                return "eng"
            _ocr_lang_cache = "eng+hin" if "hin" in langs else "eng"
    return _ocr_lang_cache


def _tesseract_available() -> bool:
    """pytesseract is only a wrapper: the tesseract program itself is a system
    package (apt install tesseract-ocr). Checked per call, so installing it
    takes effect without a restart."""
    if not _HAVE_OCR:
        return False
    cmd = getattr(getattr(pytesseract, "pytesseract", None), "tesseract_cmd", "tesseract")
    return bool(shutil.which(cmd))


def _unlink(p: str):
    try:
        os.unlink(p)
    except Exception:
        pass


def _extract_pdf(server: str, path: str, max_chars: int) -> dict:
    """Never raises: every outcome is a result dict."""
    try:
        conn, share = _connect(server)
    except HTTPException as e:
        return {"ok": False, "reason": f"connector could not reach {server}: {e.detail}"}
    tmp = tempfile.NamedTemporaryFile(delete=False)
    try:
        try:
            conn.retrieveFile(share, _norm(path), tmp)
        finally:
            tmp.close()
            try:
                conn.close()
            except Exception:
                pass
    except Exception as e:
        _unlink(tmp.name)
        return {"ok": False, "reason": f"cannot download '{path}': {type(e).__name__}"}

    try:
        try:
            doc = fitz.open(tmp.name)
        except Exception as e:
            return {"ok": False, "reason": f"PDF could not be opened: {type(e).__name__}"}
        try:
            # Text layer first. Stop reading pages once past the cap.
            parts, size = [], 0
            for page in doc:
                t = page.get_text()
                parts.append(t)
                size += len(t)
                if size > max_chars:
                    break
            text = "\n\n".join(parts).strip()
            if text:
                return {"ok": True, "text": text[:max_chars], "method": "text",
                        "truncated": len(text) > max_chars}

            # No selectable text at all: almost always a scan. OCR page by page.
            if not _HAVE_OCR:
                return {"ok": False, "reason": "PDF has no selectable text (likely scanned images; needs OCR, "
                                               "but pytesseract is not installed on the connector)"}
            if not _tesseract_available():
                return {"ok": False, "reason": "PDF has no selectable text (likely scanned images; needs OCR, "
                                               "but the tesseract program is not installed on the connector: "
                                               "sudo apt-get install -y tesseract-ocr tesseract-ocr-hin)"}
            lang = _ocr_lang()
            limit = min(doc.page_count, OCR_MAX_PAGES)
            parts, size = [], 0
            for i in range(limit):
                pix = doc[i].get_pixmap(matrix=fitz.Matrix(OCR_ZOOM, OCR_ZOOM))
                img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                t = pytesseract.image_to_string(img, lang=lang)
                parts.append(t)
                size += len(t)
                if size > max_chars:
                    break
            ocr_text = "\n\n".join(parts).strip()
            if not ocr_text:
                return {"ok": False, "reason": "OCR found no readable text on this PDF"}
            return {"ok": True, "text": ocr_text[:max_chars], "method": "ocr", "lang": lang,
                    "truncated": doc.page_count > limit or len(ocr_text) > max_chars}
        finally:
            doc.close()
    except Exception as e:  # last resort: a worker must never die silently
        return {"ok": False, "reason": f"extraction failed: {type(e).__name__}: {str(e)[:200]}"}
    finally:
        _unlink(tmp.name)


def _run_job(job_id: str, server: str, path: str, max_chars: int):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        job["state"] = "running"
    try:
        result = _extract_pdf(server, path, max_chars)
    except Exception as e:  # _extract_pdf should never raise; belt and braces
        result = {"ok": False, "reason": f"extraction failed: {type(e).__name__}"}
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is not None:
            job.update(state="done", finished=time.time(), result=result)


def _prune_jobs():
    """Drop finished jobs past their TTL. Caller holds _jobs_lock."""
    now = time.time()
    for jid in [j for j, v in _jobs.items() if v["state"] == "done" and now - v["finished"] > EXTRACT_RESULT_TTL]:
        del _jobs[jid]


def _job_view(job_id: str, job: dict) -> dict:
    out = {"id": job_id, "state": job["state"]}
    if job["state"] == "done":
        out["result"] = job["result"]
    return out


@app.post("/extract/jobs")
def start_extract(server: str, path: str, max_chars: int = EXTRACT_DEFAULT_MAX_CHARS):
    if not _HAVE_FITZ:
        raise HTTPException(501, "PyMuPDF (pymupdf) is not installed on the connector")
    if server not in SERVERS:
        raise HTTPException(404, f"unknown server '{server}'")
    if not path.lower().endswith(".pdf"):
        raise HTTPException(400, "only .pdf is supported by /extract/jobs")
    max_chars = max(1, min(int(max_chars), 5_000_000))
    key = (server, _norm(path), max_chars)
    with _jobs_lock:
        _prune_jobs()
        for jid, job in _jobs.items():
            if job["key"] == key:  # queued, running, or finished within the TTL
                return _job_view(jid, job)
        queued = sum(1 for j in _jobs.values() if j["state"] in ("queued", "running"))
        if queued >= EXTRACT_MAX_QUEUED:
            raise HTTPException(429, f"{queued} extractions already queued; try again later")
        job_id = uuid.uuid4().hex
        _jobs[job_id] = {"state": "queued", "key": key, "created": time.time(), "finished": None, "result": None}
    _extract_pool.submit(_run_job, job_id, server, path, max_chars)
    return {"id": job_id, "state": "queued"}


@app.get("/extract/jobs/{job_id}")
def extract_status(job_id: str):
    with _jobs_lock:
        _prune_jobs()
        job = _jobs.get(job_id)
        if job is None:
            # Unknown: expired, or the connector restarted (jobs live in memory).
            raise HTTPException(404, "no such extraction job")
        return _job_view(job_id, job)


@app.post("/upload")
async def upload(server: str, path: str, file: UploadFile = File(...)):
    conn, share = _connect(server)
    # Buffer to a temp file so pysmb gets a real seekable file object.
    tmp = tempfile.NamedTemporaryFile(delete=False)
    try:
        while True:
            chunk = await file.read(1024 * 256)
            if not chunk:
                break
            tmp.write(chunk)
        tmp.flush()
        tmp.close()
        dest = _norm(path).rstrip("/") + "/" + os.path.basename(file.filename)
        size = os.path.getsize(tmp.name)
        with open(tmp.name, "rb") as fh:
            conn.storeFile(share, dest, fh)
        # Incremental index update so the new file is searchable immediately
        # (no waiting for the 30-min full refresh).
        with INDEX_LOCK:
            if server in INDEX:
                INDEX[server] = [e for e in INDEX[server] if e["path"] != dest]
                INDEX[server].append({"name": os.path.basename(dest), "path": dest, "isDir": False, "size": size})
        return {"ok": True, "server": server, "path": dest}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"upload failed: {type(e).__name__}: {str(e)[:120]}")
    finally:
        try:
            conn.close()
        except Exception:
            pass
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


def _live_walk_search(server, ql, limit, base="/"):
    """Fallback used only before the index for this server is built."""
    conn, share = _connect(server)
    results = []
    deadline = time.time() + 12
    stack = [(base or "/", 0)]
    try:
        while stack and len(results) < limit and time.time() < deadline:
            p, depth = stack.pop()
            try:
                items = conn.listPath(share, p)
            except Exception:
                continue
            for f in items:
                if f.filename in (".", ".."):
                    continue
                fp = (p.rstrip("/") + "/" + f.filename)
                if ql in f.filename.lower():
                    results.append({"name": f.filename, "path": fp, "isDir": bool(f.isDirectory), "size": int(f.file_size), "mtime": int(f.last_write_time or 0)})
                    if len(results) >= limit:
                        break
                if f.isDirectory and depth < 6:
                    stack.append((fp, depth + 1))
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return results


@app.get("/search")
def search(
    server: str,
    q: str,
    path: str = "/",
    limit: int = 60,
    sort: str = "relevance",
    since: int = 0,
):
    """sort: relevance | latest | oldest | largest | name.  since: unix secs
    (only files modified after it) — powers "survey drawings, latest"."""
    if server not in SERVERS:
        raise HTTPException(404, f"unknown server '{server}'")
    ql = q.lower().strip()
    # Optional folder scope: only match files under this path (like a Windows
    # "search in current folder"). "/" = whole drive.
    scope = _norm(path)
    prefix = None if scope == "/" else (scope.rstrip("/") + "/")

    def _finish(rows, source):
        if since:
            rows = [r for r in rows if r.get("mtime", 0) >= since]
        if sort == "latest":
            rows = sorted(rows, key=lambda r: r.get("mtime", 0), reverse=True)
        elif sort == "oldest":
            rows = sorted(rows, key=lambda r: r.get("mtime", 0))
        elif sort == "largest":
            rows = sorted(rows, key=lambda r: r.get("size", 0), reverse=True)
        elif sort == "name":
            rows = sorted(rows, key=lambda r: r.get("name", "").lower())
        return {
            "server": server, "query": q, "sort": sort,
            "results": rows[:limit], "truncated": len(rows) > limit, "source": source,
        }

    with INDEX_LOCK:
        idx = INDEX.get(server)
    if idx is not None:
        # Instant in-memory filter over the pre-built index. When sorting we must
        # collect ALL matches first (not stop at `limit`), or "latest" would only
        # sort an arbitrary first slice.
        cap = limit if sort == "relevance" and not since else 5000
        results = []
        for e in idx:
            if ql in e["name"].lower() and (prefix is None or e["path"].startswith(prefix)):
                results.append(e)
                if len(results) >= cap:
                    break
        return _finish(results, "index")
    # Index not ready yet → one-time live fallback (already path-scoped).
    results = _live_walk_search(server, ql, max(limit, 200) if (since or sort != "relevance") else limit, base=scope)
    return _finish(results, "live")
