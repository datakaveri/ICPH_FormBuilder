"""Shared dense terminology retrieval for local ontology artifacts."""

from __future__ import annotations

import json
import os
from typing import Any

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from schema_terminology_assets import (
    get_dense_index_backend,
    get_dense_index_paths,
    get_dense_max_length,
    get_embedding_model_name,
    get_embedding_model_path,
)


_index_cache: dict[str, Any] = {}
_metadata_cache: dict[str, list[dict]] = {}
_dense_model = None
_dense_tokenizer = None
_dense_model_path = None
_load_failures: set[str] = set()
_faiss_module = None
DENSE_DEFAULT_TOP_K = int(os.getenv("AGENTIC_DENSE_DEFAULT_TOP_K", "30"))


def _get_faiss():
    global _faiss_module
    if _faiss_module is None:
        import faiss

        if hasattr(faiss, "omp_set_num_threads"):
            faiss.omp_set_num_threads(1)
        _faiss_module = faiss
    return _faiss_module


def get_dense_retrieval_backend_label(terminology: str) -> str:
    return f"Local {terminology.upper()} {get_dense_index_backend().upper()} + {get_embedding_model_name()}"


def dense_retrieval_unavailable(terminology: str) -> bool:
    """Report a resource/model failure so callers do not cache degraded no-matches."""
    return terminology in _load_failures


def _load_dense_model():
    global _dense_model, _dense_tokenizer, _dense_model_path
    from transformers import AutoModel, AutoTokenizer, BertModel, BertTokenizer

    model_path = str(get_embedding_model_path())
    if _dense_model is not None and _dense_model_path == model_path:
        return _dense_model, _dense_tokenizer

    print(f"Loading shared terminology embedding model: {model_path}...")
    try:
        _dense_tokenizer = AutoTokenizer.from_pretrained(model_path)
        _dense_model = AutoModel.from_pretrained(model_path)
    except ValueError as exc:
        if "model_type" not in str(exc):
            raise
        _dense_tokenizer = BertTokenizer.from_pretrained(model_path)
        _dense_model = BertModel.from_pretrained(model_path)
    _dense_model.eval()
    _dense_model_path = model_path
    print(f"   Shared terminology embedding model loaded: {model_path}")
    return _dense_model, _dense_tokenizer


def _load_dense_artifact(terminology: str):
    if terminology in _index_cache and terminology in _metadata_cache:
        return _index_cache[terminology], _metadata_cache[terminology]

    index_path, metadata_path = get_dense_index_paths(terminology)
    backend = get_dense_index_backend()
    print(f"Loading {terminology.upper()} {backend.upper()} terminology index...")

    if backend == "usearch":
        from usearch.index import Index

        index = Index.restore(str(index_path))
    elif backend == "turbovec":
        from turbovec import IdMapIndex

        index = IdMapIndex.load(str(index_path))
    else:
        faiss = _get_faiss()
        index = faiss.read_index(str(index_path))

    with metadata_path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    rows = payload.get("rows", []) if isinstance(payload, dict) else []

    _index_cache[terminology] = index
    _metadata_cache[terminology] = rows
    print(
        f"   {terminology.upper()} {backend.upper()} terminology index loaded: "
        f"{len(rows):,} metadata rows"
    )
    return index, rows


def _embedding(text: str):
    import numpy as np
    import torch

    model, tokenizer = _load_dense_model()
    inputs = tokenizer(
        text,
        return_tensors="pt",
        padding=True,
        truncation=True,
        max_length=get_dense_max_length(),
    )
    with torch.no_grad():
        outputs = model(**inputs)
        embedding = outputs.last_hidden_state[:, 0, :].numpy()
    embedding = embedding.astype("float32")
    norm = np.linalg.norm(embedding, axis=1, keepdims=True)
    norm[norm == 0] = 1.0
    return embedding / norm


def search_dense_terminology(terminology: str, query: str, top_k: int | None = None) -> list[dict]:
    """Return dense-retrieved terminology rows, or an empty list if unavailable."""
    if not query or not query.strip():
        return []
    if terminology in _load_failures:
        return []
    retrieval_limit = top_k or DENSE_DEFAULT_TOP_K

    try:
        index, metadata = _load_dense_artifact(terminology)
        query_embedding = _embedding(query)
        backend = get_dense_index_backend()
        if backend == "usearch":
            matches = index.search(query_embedding[0], retrieval_limit)
            raw_results = [(1.0 - float(match.distance), int(match.key)) for match in matches]
        else:
            scores, indices = index.search(query_embedding, retrieval_limit)
            raw_results = [(float(score), int(idx)) for score, idx in zip(scores[0], indices[0])]
    except Exception as exc:
        print(f"   Dense retrieval unavailable for {terminology}: {exc}")
        _load_failures.add(terminology)
        return []

    results: list[dict] = []
    for score, idx in raw_results:
        if idx < 0 or idx >= len(metadata):
            continue
        row = dict(metadata[int(idx)])
        row["semantic_score"] = float(score)
        row["retrieval_source"] = "dense"
        results.append(row)
    return results
