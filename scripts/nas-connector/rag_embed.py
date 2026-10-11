"""
Sentence embeddings for Forge's RAG, computed on TRIJYA-3 instead of the
HuggingFace API (whose free tier has a small monthly allowance: a large
re-index could use it up and take every bylaws search down until it resets).

Runs the SAME model as the HuggingFace API (BAAI/bge-small-en-v1.5 by default)
from the official ONNX export in the model's own repository, with the
sentence-transformers settings that repository publishes (pooling mode,
normalisation, max sequence length), read from its config files rather than
hard-coded. So the vectors match the API's and everything already indexed
stays valid; Forge falls back to the API whenever this is unavailable.

ONNX Runtime rather than PyTorch: ~20 MB instead of ~1 GB, faster on CPU, and
nothing else on this box depends on it. Loaded lazily on first use, and capped
to NAS_RAG_EMBED_THREADS CPU threads (default 4) so bulk indexing cannot
saturate a box that also runs the local LLM.
"""
import json
import os
import threading

MODEL_ID = os.environ.get("NAS_RAG_EMBED_MODEL", "BAAI/bge-small-en-v1.5")
THREADS = max(1, int(os.environ.get("NAS_RAG_EMBED_THREADS", "4")))
MAX_BATCH = 128

_lock = threading.Lock()
_state = None  # dict(session, tokenizer, pooling, normalize, dim, inputs)


def _load():
    import numpy as np  # noqa: F401  (fail early if missing)
    import onnxruntime as ort
    from huggingface_hub import hf_hub_download
    from tokenizers import Tokenizer

    get = lambda f: hf_hub_download(MODEL_ID, f)  # cached under ~/.cache/huggingface after the first run
    model_path = get("onnx/model.onnx")
    pooling_cfg = json.load(open(get("1_Pooling/config.json")))
    modules = json.load(open(get("modules.json")))
    st_cfg = json.load(open(get("sentence_bert_config.json")))

    if pooling_cfg.get("pooling_mode_cls_token"):
        pooling = "cls"
    elif pooling_cfg.get("pooling_mode_mean_tokens"):
        pooling = "mean"
    else:
        raise RuntimeError(f"{MODEL_ID}: unsupported pooling {pooling_cfg}")
    normalize = any(m.get("type", "").endswith("Normalize") for m in modules)
    max_len = int(st_cfg.get("max_seq_length", 512))

    tok = Tokenizer.from_file(get("tokenizer.json"))
    tok.enable_truncation(max_length=max_len)
    tok.enable_padding()

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = THREADS
    opts.inter_op_num_threads = 1
    sess = ort.InferenceSession(model_path, sess_options=opts, providers=["CPUExecutionProvider"])
    return {
        "session": sess, "tokenizer": tok, "pooling": pooling, "normalize": normalize,
        "dim": int(pooling_cfg.get("word_embedding_dimension", 0)) or None,
        "inputs": {i.name for i in sess.get_inputs()}, "max_len": max_len,
    }


def info() -> dict:
    """What this box serves, without loading the model."""
    return {"model": MODEL_ID, "threads": THREADS, "loaded": _state is not None}


def embed(texts):
    """List of strings -> list of float lists. Raises on any problem; the
    caller turns that into an HTTP error so Forge falls back to the API."""
    global _state
    import numpy as np

    if not isinstance(texts, list) or not texts or not all(isinstance(t, str) for t in texts):
        raise ValueError("texts must be a non-empty list of strings")
    if len(texts) > MAX_BATCH:
        raise ValueError(f"at most {MAX_BATCH} texts per request")
    with _lock:  # one batch at a time: bounded CPU, and the tokenizer is shared
        if _state is None:
            _state = _load()
        s = _state
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
