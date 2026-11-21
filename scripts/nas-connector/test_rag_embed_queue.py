"""rag_embed's queue: a live search waits for at most one micro-batch of a
bulk (indexer) request, not the whole request. Runs without a model.

    python3 scripts/nas-connector/test_rag_embed_queue.py
"""
import os, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["NAS_RAG_EMBED_MODELS"] = "fake"
import rag_embed

STEP = 0.2  # seconds per micro-batch
rag_embed._states["fake"] = {"model_id": "fake"}
rag_embed._run_safe = lambda s, texts: (time.sleep(STEP), [[float(len(t))] for t in texts])[1]

done = {}
def call(name, n):
    t0 = time.time()
    v = rag_embed.embed([f"t{i}" * (i % 5 + 1) for i in range(n)], "fake")
    done[name] = (time.time() - t0, v)

bulk = threading.Thread(target=call, args=("bulk", 128))  # 8 micro-batches = 1.6 s
bulk.start(); time.sleep(STEP * 1.5)
search = threading.Thread(target=call, args=("search", 1))
search.start(); search.join(); bulk.join()
s_wait, b_wait = done["search"][0], done["bulk"][0]
ok = s_wait < STEP * 2.5
print(f"{'PASS' if ok else 'FAIL'}  a search during a 128-text indexer request waited {s_wait:.2f} s (one micro-batch is {STEP} s; the whole request {b_wait:.2f} s)")
order_ok = all(abs(v[0] - len(f"t{i}" * (i % 5 + 1))) < 1e-9 for i, v in enumerate(done["bulk"][1]))
print(f"{'PASS' if order_ok else 'FAIL'}  the bulk request's vectors come back in input order")
two = [threading.Thread(target=call, args=(f"b{i}", 32)) for i in range(2)]
for t in two: t.start()
for t in two: t.join()
print(f"{'PASS' if all(f'b{i}' in done for i in range(2)) else 'FAIL'}  two bulk requests at once both finish")
sys.exit(0 if ok and order_ok else 1)
