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
import hashlib
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
INDEX_SQ = {}              # server -> list[str]: squashed names, parallel to INDEX (see _squash)
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
    squashed = [_squash(e["name"]) for e in entries]
    with INDEX_LOCK:
        INDEX[server] = entries
        INDEX_SQ[server] = squashed
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


# ── Reachability (does SMB actually work right now?) ─────────────────────────
# /health only says this process is up, which is what the restart watchdog
# needs: a NAS outage must not make it restart the connector in a loop. Forge
# needs the other question, whether the NAS itself answers, so /servers carries
# a real SMB check per server: connect and list the share root. Cached briefly
# so a busy Files page does not open an SMB session per request.
REACH_TTL = int(os.environ.get("NAS_REACH_TTL", "30"))
REACH = {}  # server -> {"reachable", "checkedAt", "error"}
REACH_LOCK = threading.Lock()


def _probe(server: str) -> dict:
    try:
        conn, share = _connect(server)
    except HTTPException as e:
        return {"reachable": False, "checkedAt": int(time.time()), "error": str(e.detail)}
    try:
        conn.listPath(share, "/")
        return {"reachable": True, "checkedAt": int(time.time()), "error": None}
    except Exception as e:
        return {"reachable": False, "checkedAt": int(time.time()), "error": f"{server}: list failed ({type(e).__name__})"}
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _reachability() -> dict:
    now = time.time()
    with REACH_LOCK:
        stale = [s for s in SERVERS if now - REACH.get(s, {}).get("checkedAt", 0) >= REACH_TTL]
    if stale:
        out = {}
        threads = [threading.Thread(target=lambda s=s: out.__setitem__(s, _probe(s)), daemon=True) for s in stale]
        for t in threads:
            t.start()
        for t in threads:
            t.join(15)
        with REACH_LOCK:
            for s in stale:
                REACH[s] = out.get(s) or {"reachable": False, "checkedAt": int(time.time()), "error": f"{s}: check timed out"}
    with REACH_LOCK:
        return {s: dict(REACH[s]) for s in SERVERS}


@app.get("/servers")
def servers():
    reach = _reachability()
    return {"servers": [{"label": k, **reach[k]} for k in SERVERS]}


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
    from PIL import Image, ImageFilter, ImageOps
    _HAVE_OCR = True
except Exception:
    _HAVE_OCR = False

import shutil
import uuid
from concurrent.futures import ThreadPoolExecutor

# Pages OCR'd per document. Generous: a mostly-unreadable document has only
# its unreadable pages OCR'd (see _extract_pdf), and Trijya's include a
# compiled bye-laws book of a few hundred pages.
OCR_MAX_PAGES = int(os.environ.get("NAS_OCR_MAX_PAGES", "300"))
OCR_NICE = int(os.environ.get("NAS_OCR_NICE", "10"))
# A document whose pages are at least this share unreadable gets page-level
# OCR. Measured on every passage of Trijya's bylaws index (Oct 2026): normal
# documents 0-14%, broken ones 40-100%.
UNREADABLE_DOC_SHARE = float(os.environ.get("NAS_UNREADABLE_DOC_SHARE", "0.3"))

_STOPWORDS = frozenset("the of and to in a is for be shall with by on as or at from that this are which "
                       "an not any such its it have has been may all other than per under into within "
                       "where each above below".split())
_LATIN = re.compile(r"[A-Za-z]")
_DEVA = re.compile(r"[ऀ-ॿ]")
_WORD = re.compile(r"[a-z]+")


def _readable(t: str) -> bool:
    """Is this real language (English, or Unicode Hindi), or garbage from a
    broken text layer: a legacy Hindi typing font (Kruti Dev style text
    extracts as Latin nonsense), glyphs with no character map, or an empty
    scanned page? Kept identical to readableText() in lib/nas/readability.ts."""
    nonsp = re.sub(r"\s", "", t or "")
    if len(nonsp) < 20:
        return False
    latin = len(_LATIN.findall(t))
    deva = len(_DEVA.findall(t))
    if deva / max(1, latin + deva) >= 0.2:
        return True
    words = _WORD.findall(t.lower())
    stop = sum(1 for w in words if w in _STOPWORDS) / max(1, len(words))
    return (latin + deva) / len(nonsp) >= 0.5 and stop >= 0.08
# Each scanned page is OCR'd several ways and the reading Tesseract is most
# confident in is kept. No one way is best for every scan: measured on a
# Hindi setback table scanned clean and noisy (Oct 2026), 300 DPI read a
# clean scan perfectly but lost most of a noisy one, which 144 DPI after
# denoising read best; the most confident reading matched the best way in
# every case. "clean" = median denoise, contrast, black and white (Otsu).
# NAS_OCR_VARIANTS: comma-separated "<dpi>" or "<dpi>:clean".
OCR_VARIANTS = [(float(v.split(":")[0]), v.endswith(":clean"))
                for v in os.environ.get("NAS_OCR_VARIANTS", "300,300:clean,144:clean").split(",") if v.strip()]
# The LSTM engine; automatic page layout (psm 3) read the tables best.
OCR_CONFIG = os.environ.get("NAS_OCR_CONFIG", "--oem 1 --psm 3")
# Bump when OCR changes, so cached extractions made the old way are redone.
OCR_VERSION = "2"
# A page at least this share covered by images is a scan.
SCAN_IMAGE_SHARE = float(os.environ.get("NAS_SCAN_IMAGE_SHARE", "0.7"))
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
    Hindi government orders), else eng. NAS_OCR_LANG overrides. Keep eng
    first: on a Hindi setback table (Oct 2026) eng+hin read 15 of 15 plot
    sizes and figures, hin+eng and hin 7, dropping every "1" ("150" -> "50",
    "10.0" -> "0.0")."""
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


def _is_scan(page) -> bool:
    """A scanned page: mostly image, with no text of its own, or only an
    invisible text layer that some other OCR put over the image (Tesseract
    and scanner software write their text that way). That layer is often
    poor (the MDDA bylaws: "सेट बैक" as "पेट बैक", decimal points missing) and
    still passes _readable, so such pages are OCR'd here again."""
    try:
        area = abs(page.rect)
        if not area:
            return False
        covered = sum(abs(fitz.Rect(i["bbox"]) & page.rect) for i in page.get_image_info())
        if covered / area < SCAN_IMAGE_SHARE:
            return False
        # Text drawn with render mode 3 (invisible) is an OCR layer; real
        # text over a background image is visible.
        spans = page.get_texttrace()
        chars = sum(len(s.get("chars", ())) for s in spans)
        hidden = sum(len(s.get("chars", ())) for s in spans if s.get("type") == 3)
        return chars == 0 or hidden / chars >= 0.5
    except Exception:
        return False


def _clean(img):
    """Median denoise, full contrast, then black and white at Otsu's threshold."""
    img = ImageOps.autocontrast(img.filter(ImageFilter.MedianFilter(3)))
    hist = img.histogram()
    total = sum(hist)
    sum_all = sum(i * h for i, h in enumerate(hist))
    w_b = sum_b = 0
    best, threshold = -1.0, 128
    for t in range(256):
        w_b += hist[t]
        w_f = total - w_b
        if not w_b or not w_f:
            continue
        sum_b += t * hist[t]
        between = w_b * w_f * (sum_b / w_b - (sum_all - sum_b) / w_f) ** 2
        if between > best:
            best, threshold = between, t
    return img.point(lambda x: 255 if x > threshold else 0)


def _read(img, lang: str):
    """Tesseract's reading of one image: (mean word confidence, text). The
    text is rebuilt from the words, a line per line Tesseract found, so a
    table row stays on one line."""
    # nice: OCR yields the CPU to everything else on this box.
    d = pytesseract.image_to_data(img, lang=lang, config=OCR_CONFIG, nice=OCR_NICE,
                                  output_type=pytesseract.Output.DICT)
    lines, confs = {}, []
    for i, word in enumerate(d["text"]):
        if not word.strip():
            continue
        key = (d["block_num"][i], d["par_num"][i], d["line_num"][i])
        lines.setdefault(key, []).append(word)
        c = float(d["conf"][i])
        if c >= 0:
            confs.append(c)
    text, last = [], None
    for key in sorted(lines):
        if last is not None and key[:2] != last[:2]:
            text.append("")  # a new paragraph or block
        text.append(" ".join(lines[key]))
        last = key
    return (sum(confs) / len(confs) if confs else 0.0), "\n".join(text)


def _ocr_page(page, lang: str) -> str:
    """OCR one page each way in OCR_VARIANTS and keep the most confident
    reading. Grayscale: colour adds nothing to text and triples the memory."""
    best = (-1.0, "")
    for dpi, clean in OCR_VARIANTS:
        zoom = dpi / 72
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csGRAY, alpha=False)
        img = Image.frombytes("L", (pix.width, pix.height), pix.samples)
        reading = _read(_clean(img) if clean else img, lang)
        if reading[0] > best[0]:
            best = reading
    return best[1]


def _unlink(p: str):
    try:
        os.unlink(p)
    except Exception:
        pass


# Finished extractions are kept on disk, keyed by the file's size and
# modified time and by OCR_VERSION, so the nightly bylaws sync, which asks for
# every PDF again, gets an unchanged scan back at once instead of OCR-ing it
# for many minutes every night.
EXTRACT_CACHE_DIR = os.environ.get("NAS_EXTRACT_CACHE_DIR", os.path.join(BASE, "extract-cache"))


def _cache_file(server: str, path: str, size: int, mtime: float, max_chars: int) -> str:
    key = json.dumps([server, _norm(path), size, mtime, max_chars, OCR_VERSION, _ocr_lang() if _HAVE_OCR else ""])
    return os.path.join(EXTRACT_CACHE_DIR, hashlib.sha1(key.encode()).hexdigest() + ".json")


def _cache_get(f: str):
    try:
        with open(f, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _cache_put(f: str, result: dict):
    try:
        os.makedirs(EXTRACT_CACHE_DIR, exist_ok=True)
        tmp = f + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False)
        os.replace(tmp, f)
    except Exception:
        pass


def _extract_pdf(server: str, path: str, max_chars: int) -> dict:
    """Never raises: every outcome is a result dict."""
    try:
        conn, share = _connect(server)
    except HTTPException as e:
        return {"ok": False, "reason": f"connector could not reach {server}: {e.detail}"}
    try:
        a = conn.getAttributes(share, _norm(path))
        cache = _cache_file(server, path, int(a.file_size), float(a.last_write_time or 0), max_chars)
    except Exception:
        cache = None
    hit = cache and _cache_get(cache)
    if hit:
        try:
            conn.close()
        except Exception:
            pass
        return hit
    result = _extract_downloaded(conn, share, server, path, max_chars)
    if cache and result.get("ok"):
        _cache_put(cache, result)
    return result


def _extract_downloaded(conn, share: str, server: str, path: str, max_chars: int) -> dict:
    """Download the PDF over SMB (closing the connection) and extract it."""
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
            # Text layer of every page, and whether each one needs OCR: not
            # real language, or a scan (whose text layer, if any, is someone
            # else's OCR).
            pages = [page.get_text() for page in doc]
            ocr_ready = _HAVE_OCR and _tesseract_available()
            scans = {i for i in range(len(pages)) if _is_scan(doc[i])} if ocr_ready else set()
            bad = [i for i, t in enumerate(pages) if i in scans or not _readable(t)]
            n = len(pages) or 1

            # Mostly readable: index the text layer as it is, as before. (Normal
            # documents have a few "unreadable" pages, tables and title pages;
            # measured on Trijya's bylaws: at most 14% of passages.)
            if len(bad) / n < UNREADABLE_DOC_SHARE:
                text = "\n\n".join(pages).strip()
                return {"ok": True, "text": text[:max_chars], "method": "text",
                        "truncated": len(text) > max_chars}

            # Mostly unreadable: a scan (no text layer) or a broken one (a legacy
            # Hindi typing font, or glyphs with no character map). Keep the
            # readable pages, OCR the others up to the page budget, and leave
            # out what cannot be read rather than index garbage.
            if not ocr_ready and len(bad) == len(pages):
                if not _HAVE_OCR:
                    return {"ok": False, "reason": "PDF has no selectable text (likely scanned images; needs OCR, "
                                                   "but pytesseract is not installed on the connector)"}
                return {"ok": False, "reason": "PDF has no selectable text (likely scanned images; needs OCR, "
                                               "but the tesseract program is not installed on the connector: "
                                               "sudo apt-get install -y tesseract-ocr tesseract-ocr-hin)"}
            lang = _ocr_lang() if ocr_ready else None
            bad_set = set(bad)
            parts, size, ocred, skipped = [], 0, 0, 0
            for i, t in enumerate(pages):
                if i not in bad_set:
                    piece = t
                elif ocr_ready and ocred < OCR_MAX_PAGES:
                    piece = _ocr_page(doc[i], lang)
                    ocred += 1
                elif _readable(t):
                    piece = t  # a scan past the page budget: its own text layer beats nothing
                else:
                    skipped += 1
                    continue
                parts.append(piece)
                size += len(piece)
                if size > max_chars:
                    break
            text = "\n\n".join(parts).strip()
            if not text:
                return {"ok": False, "reason": "OCR found no readable text on this PDF"}
            readable_pages = len(pages) - len(bad)
            note = None
            if skipped:
                why = f"NAS_OCR_MAX_PAGES={OCR_MAX_PAGES}" if ocr_ready else "tesseract not installed"
                note = f"{skipped} of {len(pages)} pages unreadable and not OCR'd ({why}); left out"
            return {"ok": True, "text": text[:max_chars],
                    "method": "ocr" if readable_pages == 0 else "mixed",
                    "lang": lang, "truncated": len(text) > max_chars,
                    "pages": len(pages), "pages_ocr": ocred, "pages_skipped": skipped, "note": note}
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


# ── Locate a passage's page (Forge's source view) ────────────────────────────
# The RAG index stores passages without page numbers. To let a user check an
# answer against the PDF, Forge sends a few exact snippets of the passage and
# this returns the page holding the most of them, with that page's text.
# Pages are read from the PDF's text layer, so a scanned page that was OCR'd
# at index time is not found (no text layer to match): Forge then says so.
# The page texts of the last few documents are cached, keyed by size and
# modification time, so opening several sources from one document downloads
# it once.
from collections import OrderedDict

LOCATE_CACHE_DOCS = int(os.environ.get("NAS_LOCATE_CACHE_DOCS", "4"))
LOCATE_PAGE_CHARS = 12_000
_locate_cache = OrderedDict()   # (server, path, size, mtime) -> (raw pages, folded pages)
_locate_lock = threading.Lock()
_WS = re.compile(r"\s+")


def _fold(t: str) -> str:
    """Whitespace-insensitive, case-insensitive form for matching."""
    return _WS.sub(" ", t).strip().lower()


def _pdf_pages(server: str, path: str):
    """(raw page texts, folded page texts) of a PDF on the NAS. Raises on failure."""
    conn, share = _connect(server)
    tmp = None
    try:
        a = conn.getAttributes(share, _norm(path))
        key = (server, _norm(path), a.file_size, a.last_write_time)
        with _locate_lock:
            hit = _locate_cache.get(key)
            if hit is not None:
                _locate_cache.move_to_end(key)
                return hit
        tmp = tempfile.NamedTemporaryFile(delete=False)
        try:
            conn.retrieveFile(share, _norm(path), tmp)
        finally:
            tmp.close()
    finally:
        try:
            conn.close()
        except Exception:
            pass
    try:
        doc = fitz.open(tmp.name)
        try:
            raw = [page.get_text() for page in doc]
        finally:
            doc.close()
    finally:
        _unlink(tmp.name)
    pages = (raw, [_fold(t) for t in raw])
    with _locate_lock:
        _locate_cache[key] = pages
        while len(_locate_cache) > LOCATE_CACHE_DOCS:
            _locate_cache.popitem(last=False)
    return pages


@app.post("/locate")
def locate(body: dict):
    """{"server", "path", "anchors": [exact snippets]} -> the page holding the
    most anchors: {"page" (1-based), "pageCount", "pageText", "matched", "of"},
    or {"page": null, "reason"}. Never an error for a document problem."""
    server = str(body.get("server") or "")
    path = str(body.get("path") or "")
    anchors = [_fold(str(x)) for x in (body.get("anchors") or [])][:12]
    anchors = [x for x in anchors if len(x) >= 12]
    if not path.lower().endswith(".pdf"):
        return {"page": None, "reason": "not a PDF: pages exist only for PDFs"}
    if not _HAVE_FITZ:
        return {"page": None, "reason": "PyMuPDF (pymupdf) is not installed on the connector"}
    if not anchors:
        return {"page": None, "reason": "no text to look for"}
    try:
        raw, folded = _pdf_pages(server, path)
    except HTTPException as e:
        return {"page": None, "reason": f"connector could not reach {server}: {e.detail}"}
    except Exception as e:
        return {"page": None, "reason": f"cannot read '{path}': {type(e).__name__}"}
    best, best_n = None, 0
    for i, page in enumerate(folded):
        n = sum(1 for x in anchors if x in page)
        if n > best_n:
            best, best_n = i, n
    if best is None:
        return {"page": None, "pageCount": len(raw),
                "reason": "the passage is not in the PDF's text layer (often a scanned page read by OCR)"}
    return {"page": best + 1, "pageCount": len(raw), "pageText": raw[best][:LOCATE_PAGE_CHARS],
            "matched": best_n, "of": len(anchors)}


# ── Embeddings for Forge's RAG (see rag_embed.py) ────────────────────────────
# Forge sends {"model": "...", "texts": [...]} and gets one vector per text.
# It names the model it expects; a different model here is refused (400), so
# vectors from two different models can never be mixed in one index. Any
# failure is an HTTP error, and Forge then falls back to the HuggingFace API.
@app.get("/embed/info")
def embed_info():
    try:
        import rag_embed
    except Exception as e:
        raise HTTPException(501, f"embedding support not installed: {type(e).__name__}")
    return rag_embed.info()


@app.post("/embed")
def embed(body: dict):
    try:
        import rag_embed
    except Exception as e:
        raise HTTPException(501, f"embedding support not installed: {type(e).__name__}")
    model = body.get("model") or rag_embed.MODEL_ID
    try:
        vectors = rag_embed.embed(body.get("texts"), model)
    except (ValueError, LookupError) as e:  # bad input, or a model this box does not serve
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(503, f"embedding failed: {type(e).__name__}: {str(e)[:200]}")
    return {"model": model, "dim": len(vectors[0]), "vectors": vectors}


# ── Qdrant pass-through ──────────────────────────────────────────────────────
# Forge's vector index lives in a Qdrant on this box (127.0.0.1:6333, see
# scripts/nas-connector/QDRANT.md). Qdrant only listens on localhost, so Forge
# reaches it here, behind the same Cloudflare tunnel + Access check as every
# other route; Qdrant's own API key (sent by Forge, checked by Qdrant) is the
# second lock. Requests and responses are passed through unchanged.
QDRANT_LOCAL_URL = os.environ.get("QDRANT_LOCAL_URL", "http://127.0.0.1:6333").rstrip("/")
_QDRANT_FWD_HEADERS = ("api-key", "authorization", "content-type")

from fastapi import Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
import urllib.error


@app.api_route("/qdrant/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def qdrant_proxy(path: str, request: Request):
    body = await request.body()
    url = f"{QDRANT_LOCAL_URL}/{path}" + (f"?{request.url.query}" if request.url.query else "")
    headers = {h: request.headers[h] for h in _QDRANT_FWD_HEADERS if h in request.headers}

    def call():
        req = urllib.request.Request(url, data=body or None, method=request.method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, r.read(), r.headers.get("content-type", "application/json")
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers.get("content-type", "application/json")
        except Exception as e:
            return 502, json.dumps({"status": {"error": f"qdrant unreachable: {type(e).__name__}"}}).encode(), "application/json"

    status, data, ctype = await run_in_threadpool(call)
    return Response(content=data, status_code=status, media_type=ctype)


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


# ── Filename matching ────────────────────────────────────────────────────────
# A plain substring test misses the same word written differently: "bylaws"
# vs "By Laws", "By_Laws", "Bye-Laws" or "byelaws". So a name also matches when
# it contains the query with spaces, underscores, hyphens and dots squashed out
# (and the Indian "bye-laws" spelling folded into "bylaws"), or, for a query of
# several words, every word in any order. Exact substring hits rank first.
_SQUASH = re.compile(r"[\s_\-.]+")
_BYE = re.compile(r"bye(?=laws?)")


def _squash(s: str) -> str:
    return _BYE.sub("by", _SQUASH.sub("", s.lower()))


def _matcher(q: str):
    """Returns name -> tier (0 exact substring, 1 squashed, 2 all words) or None."""
    ql = q.lower().strip()
    qs = _squash(ql)
    words = [w for w in (_squash(t) for t in re.split(r"[\s_\-]+", ql)) if w]

    def tier(name: str, ns: str = None):
        n = name.lower()
        if ql and ql in n:
            return 0
        if not qs:
            return None
        if ns is None:
            ns = _squash(n)
        if qs in ns:
            return 1
        if len(words) > 1 and all(w in ns for w in words):
            return 2
        return None

    return tier


def _live_walk_search(server, q, limit, base="/"):
    """Fallback used only before the index for this server is built."""
    match = _matcher(q)
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
                if match(f.filename) is not None:
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
        sq = INDEX_SQ.get(server)
    if idx is not None:
        # Instant in-memory filter over the pre-built index. When sorting we must
        # collect ALL matches first (not stop at `limit`), or "latest" would only
        # sort an arbitrary first slice. Exact substring hits rank first; the
        # scan stops early only once there are enough of those.
        cap = limit if sort == "relevance" and not since else 5000
        match = _matcher(q)
        tiers = ([], [], [])
        for i, e in enumerate(idx):
            if prefix is not None and not e["path"].startswith(prefix):
                continue
            t = match(e["name"], sq[i] if sq is not None and i < len(sq) else None)
            if t is not None:
                tiers[t].append(e)
                if len(tiers[0]) >= cap:
                    break
        return _finish(tiers[0] + tiers[1] + tiers[2], "index")
    # Index not ready yet → one-time live fallback (already path-scoped).
    results = _live_walk_search(server, q, max(limit, 200) if (since or sort != "relevance") else limit, base=scope)
    return _finish(results, "live")
