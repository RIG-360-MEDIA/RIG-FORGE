"""
Re-embed a RAG collection into a new Qdrant collection with another model,
without touching the live one. Used for the switch from bge-small-en
(English only) to multilingual-e5-large, so Hindi bylaws become searchable.

Every passage's text is already stored in the source collection, so nothing
is downloaded from the NAS and nothing is re-extracted or re-OCR'd: each
point is copied with the same id and payload and a vector from the new model.
Search keeps using the source collection until Forge is pointed at the new
one (QDRANT_*_COLLECTION, HF_EMBEDDING_MODEL, HF_EMBEDDING_DIM, RAG_MIN_SCORE).

Safe to stop and re-run at any time:
  - a point already in the destination with the same text, embedded with the
    same model and prefix (recorded in its "embedModel" payload field), is
    skipped;
  - a point whose text changed in the source since it was copied (the file
    was re-indexed) is re-embedded;
  - with --prune, destination points no longer in the source are deleted.
Runs at nice 10, embedding in this process (not through the connector), so
live searches are never queued behind it.

  QDRANT_URL=... QDRANT_API_KEY=... NAS_RAG_EMBED_MODELS=intfloat/multilingual-e5-large \\
  NAS_RAG_EMBED_THREADS=8 python rag_migrate.py --src trijya_bylaws --dst trijya_bylaws_e5 \\
      --model intfloat/multilingual-e5-large --passage-prefix "passage: " [--prune]
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rag_embed  # noqa: E402

URL = os.environ["QDRANT_URL"].rstrip("/")
KEY = os.environ["QDRANT_API_KEY"]
PAGE = 256
EMBED_BATCH = 64


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def q(method, path, body=None, tries=6, ok404=False):
    data = json.dumps(body).encode() if body is not None else None
    for t in range(tries):
        req = urllib.request.Request(f"{URL}{path}", data=data, method=method,
                                     headers={"api-key": KEY, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404 and ok404:
                return None
            if e.code < 500 and e.code != 429:
                raise RuntimeError(f"Qdrant {method} {path}: HTTP {e.code} {e.read()[:200]!r}")
        except Exception as e:  # network blip
            if t == tries - 1:
                raise
        time.sleep(min(30, 2 ** t))
    raise RuntimeError(f"Qdrant {method} {path}: gave up after {tries} attempts")


def ensure_collection(name, dim):
    info = q("GET", f"/collections/{name}", ok404=True)
    if info is None:
        q("PUT", f"/collections/{name}", {"vectors": {"size": dim, "distance": "Cosine"}})
        log(f"created {name} ({dim} dims, cosine)")
    else:
        have = info["result"]["config"]["params"]["vectors"]["size"]
        if have != dim:
            raise SystemExit(f"{name} exists with {have} dims, model gives {dim}: refusing to mix")
    # Same payload indexes Forge creates (lib/rag/qdrant.ts ensureCollection).
    for field, schema in (("organizationId", "keyword"), ("server", "keyword"), ("path", "keyword"), ("chunkIndex", "integer")):
        q("PUT", f"/collections/{name}/index?wait=true", {"field_name": field, "field_schema": schema})


def scroll(name, offset, with_payload):
    body = {"limit": PAGE, "with_payload": with_payload, "with_vector": False}
    if offset is not None:
        body["offset"] = offset
    r = q("POST", f"/collections/{name}/points/scroll", body)["result"]
    return r["points"], r.get("next_page_offset")


def count(name):
    return q("POST", f"/collections/{name}/points/count", {"exact": True})["result"]["count"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--dst", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--passage-prefix", default="")
    ap.add_argument("--prune", action="store_true", help="delete destination points no longer in the source")
    a = ap.parse_args()
    try:
        os.nice(10)
    except Exception:
        pass

    total = count(a.src)
    dim = len(rag_embed.embed([a.passage_prefix + "dimension probe"], a.model)[0])
    ensure_collection(a.dst, dim)
    log(f"{a.src} -> {a.dst}: {total} points, model {a.model}, {dim} dims, prefix {a.passage_prefix!r}, "
        f"{rag_embed.THREADS} threads")

    marker = f"{a.model}|{a.passage_prefix}"  # what made each destination vector
    seen = set()
    done = skipped = 0
    t0 = time.time()
    offset = None
    while True:
        points, offset = scroll(a.src, offset, True)
        if not points:
            break
        ids = [p["id"] for p in points]
        seen.update(ids)
        have = q("POST", f"/collections/{a.dst}/points", {"ids": ids, "with_payload": ["text", "embedModel"], "with_vector": False})["result"]
        have_key = {h["id"]: ((h.get("payload") or {}).get("text"), (h.get("payload") or {}).get("embedModel")) for h in have}
        todo = [p for p in points if have_key.get(p["id"]) != (p["payload"].get("text"), marker)]
        skipped += len(points) - len(todo)
        for i in range(0, len(todo), EMBED_BATCH):
            batch = todo[i:i + EMBED_BATCH]
            vectors = rag_embed.embed([a.passage_prefix + p["payload"]["text"] for p in batch], a.model)
            q("PUT", f"/collections/{a.dst}/points?wait=true",
              {"points": [{"id": p["id"], "vector": v, "payload": {**p["payload"], "embedModel": marker}} for p, v in zip(batch, vectors)]})
            done += len(batch)
        processed = done + skipped
        rate = done / max(1e-9, time.time() - t0)
        eta = (total - processed) / rate / 60 if rate > 0 else 0
        log(f"{processed}/{total} ({100 * processed / max(1, total):.0f}%) | embedded {done}, already there {skipped} | "
            f"{rate:.1f} passages/s | ~{eta:.0f} min left")
        if offset is None:
            break

    pruned = 0
    if a.prune:
        offset = None
        while True:
            points, offset = scroll(a.dst, offset, False)
            extra = [p["id"] for p in points if p["id"] not in seen]
            if extra:
                q("POST", f"/collections/{a.dst}/points/delete?wait=true", {"points": extra})
                pruned += len(extra)
            if offset is None:
                break
    log(f"DONE: source {count(a.src)}, destination {count(a.dst)} | embedded {done}, already there {skipped}, "
        f"pruned {pruned} | {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
