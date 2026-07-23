from __future__ import annotations

from collections import Counter
from typing import Any


def candidate_trace(
    *,
    rank: int,
    code: Any,
    display: Any = "",
    similarity_score: Any = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    item = {
        "rank": int(rank),
        "code": str(code or ""),
        "display": str(display or ""),
    }
    if similarity_score is not None:
        try:
            item["similarity_score"] = round(float(similarity_score), 6)
        except (TypeError, ValueError):
            item["similarity_score"] = similarity_score
    if extra:
        item.update({key: value for key, value in extra.items() if value is not None})
    return item


def query_trace(
    *,
    vocabulary: str,
    query_text: str,
    retrieval_backend: str,
    retrieval_stage: str,
    candidates: list[dict[str, Any]],
    selected_code: Any = None,
    selected_display: Any = None,
    selected_rank: Any = None,
    reranker_used: bool = False,
    cache_hit: bool = False,
    timings_ms: dict[str, Any] | None = None,
    matched_via: str | None = None,
) -> dict[str, Any]:
    return {
        "vocabulary": vocabulary,
        "query_text": str(query_text or ""),
        "retrieval_backend": retrieval_backend,
        "retrieval_stage": retrieval_stage,
        "candidate_count": len(candidates),
        "candidates": candidates,
        "selected_code": str(selected_code) if selected_code else None,
        "selected_display": str(selected_display) if selected_display else None,
        "selected_rank": int(selected_rank) if selected_rank else None,
        "reranker_used": bool(reranker_used),
        "cache_hit": bool(cache_hit),
        "timings_ms": timings_ms or {},
        "matched_via": matched_via,
    }


def summarize_traces(traces: list[dict[str, Any]] | None) -> dict[str, Any]:
    valid_traces = [trace for trace in traces or [] if isinstance(trace, dict)]
    vocab_counts = Counter(str(trace.get("vocabulary", "UNKNOWN")) for trace in valid_traces)
    return {
        "query_count": len(valid_traces),
        "queries": valid_traces,
        "vocabulary_query_counts": dict(sorted(vocab_counts.items())),
    }
