"""
Sentence embeddings for Forge's RAG, computed on TRIJYA-3 instead of the
HuggingFace API (whose free tier has a small monthly allowance: a large
re-index used it up in October 2026 and took every bylaws search down).

Runs the SAME models as the HuggingFace API from the official ONNX export in
each model's own repository, with the sentence-transformers settings that
repository publishes (pooling mode, normalisation, max sequence length), read
from its config files rather than hard-coded. For BAAI/bge-small-en-v1.5 this
was checked against vectors the API produced: cosine 1.000000.

Several models can be served at once (NAS_RAG_EMBED_MODELS, comma-separated;
the first is the default). That is what lets a new index be built with a new
model while search keeps using the old one. Forge names the model in every
request, so vectors from two models are never mixed.

ONNX Runtime rather than PyTorch: far smaller, faster on CPU. Each model is
loaded lazily on first use; texts are embedded NAS_RAG_EMBED_MICROBATCH at a
time (memory stays bounded for large models), one request at a time, on
NAS_RAG_EMBED_THREADS CPU threads, so this cannot saturate a box that also
runs other work.
"""
import json
import os
import threading

MODELS = [m.strip() for m in os.environ.get("NAS_RAG_EMBED_MODELS", os.environ.get("NAS_RAG_EMBED_MODEL", "BAAI/bge-small-en-v1.5")).split(",") if m.strip()]
MODEL_ID = MODELS[0]  # the default
THREADS = max(1, int(os.environ.get("NAS_RAG_EMBED_THREADS", "4")))
MICROBATCH = max(1, int(os.environ.get("NAS_RAG_EMBED_MICROBATCH", "16")))
MAX_BATCH = 128
# Each model is downloaded into its own plain folder (real files, side by
# side). Not the HuggingFace cache: it stores files as symlinks into a shared
# blobs folder, and ONNX Runtime refuses a model whose separate weights file
# (onnx/model.onnx_data, used by large models) resolves outside the model's
# own directory ("External data path escapes model directory").
MODEL_DIR = os.path.expanduser(os.environ.get("NAS_RAG_MODEL_DIR", "~/.cache/rag-models"))

_lock = threading.Lock()
_states = {}  # model id -> dict(session, tokenizer, pooling, normalize, inputs)


def _load(model_id):
    import numpy as np  # noqa: F401  (fail early if missing)
    import onnxruntime as ort
    from huggingface_hub import hf_hub_download
    from tokenizers import Tokenizer

    local = os.path.join(MODEL_DIR, model_id.replace("/", "__"))
    get = lambda f: hf_hub_download(model_id, f, local_dir=local)  # downloaded once, then reused
    model_path = get("onnx/model.onnx")
    try:
        # Large models keep their weights in a separate file next to the
        # graph; ONNX Runtime finds it there. Small ones have none.
        get("onnx/model.onnx_data")
    except Exception:
        pass
    pooling_cfg = json.load(open(get("1_Pooling/config.json")))
    modules = json.load(open(get("modules.json")))
    st_cfg = json.load(open(get("sentence_bert_config.json")))

    if pooling_cfg.get("pooling_mode_cls_token"):
        pooling = "cls"
    elif pooling_cfg.get("pooling_mode_mean_tokens"):
        pooling = "mean"
    else:
        raise RuntimeError(f"{model_id}: unsupported pooling {pooling_cfg}")
    normalize = any(m.get("type", "").endswith("Normalize") for m in modules)
    max_len = int(st_cfg.get("max_seq_length", 512))

    tok = Tokenizer.from_file(get("tokenizer.json"))
    tok.enable_truncation(max_length=max_len)
    tok.enable_padding()

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = THREADS
    opts.inter_op_num_threads = 1
    sess = ort.InferenceSession(model_path, sess_options=opts, providers=["CPUExecutionProvider"])
    return {"session": sess, "tokenizer": tok, "pooling": pooling, "normalize": normalize,
            "inputs": {i.name for i in sess.get_inputs()}, "max_len": max_len}


def info() -> dict:
    """What this box serves, without loading anything."""
    return {"model": MODEL_ID, "models": MODELS, "threads": THREADS, "microbatch": MICROBATCH,
            "loaded": MODEL_ID in _states, "loaded_models": sorted(_states)}


def _run(s, texts):
    import numpy as np

    enc = s["tokenizer"].encode_batch(texts)
    ids = np.array([e.ids for e in enc], dtype=np.int64)
    mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
    feed = {"input_ids": ids, "attention_mask": mask}
    if "token_type_ids" in s["inputs"]:
        feed["token_type_ids"] = np.array([e.type_ids for e in enc], dtype=np.int64)
    hidden = s["session"].run(None, feed)[0]  # (batch, seq, dim)
    if s["pooling"] == "cls":
        vec = hidden[:, 0, :]
    else:
        m = mask[:, :, None].astype(hidden.dtype)
        vec = (hidden * m).sum(axis=1) / np.clip(m.sum(axis=1), 1e-9, None)
    if s["normalize"]:
        vec = vec / np.clip(np.linalg.norm(vec, axis=1, keepdims=True), 1e-12, None)
    return vec.astype(float).tolist()


def embed(texts, model=None):
    """List of strings -> list of float lists. Raises on any problem; the
    caller turns that into an HTTP error so Forge falls back to the API."""
    model = model or MODEL_ID
    if model not in MODELS:
        raise LookupError(f"this connector serves {', '.join(MODELS)}, not {model}")
    if not isinstance(texts, list) or not texts or not all(isinstance(t, str) for t in texts):
        raise ValueError("texts must be a non-empty list of strings")
    if len(texts) > MAX_BATCH:
        raise ValueError(f"at most {MAX_BATCH} texts per request")
    with _lock:  # one request at a time: bounded CPU and memory
        if model not in _states:
            _states[model] = _load(model)
        s = _states[model]
        # Embed in length order: each micro-batch is padded to its longest
        # text, so grouping similar lengths avoids computing on padding (the
        # padding is masked out, so results are the same). Restore the order
        # before returning.
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
        vecs = [None] * len(texts)
        for i in range(0, len(order), MICROBATCH):
            idx = order[i:i + MICROBATCH]
            for j, v in zip(idx, _run(s, [texts[k] for k in idx])):
                vecs[j] = v
    return vecs
