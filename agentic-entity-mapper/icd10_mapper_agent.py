"""ICD-10 Mapping Agent (Agent 5).

Uses programmatic candidate retrieval plus semantic validation to enrich
applicable mappings with ICD-10-CM concepts.
"""

from __future__ import annotations

import csv
import os
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
from typing import List
import json
import re

from langchain_core.tools import tool
from langchain_core.messages import HumanMessage

import cache
from llm_runtime import load_llm, resilient_llm_invoke
from retrieval_trace import candidate_trace, query_trace
from schema_terminology_assets import (
    build_icd10_lookup,
    get_lookup_path,
)
from terminology_dense_search import (
    dense_retrieval_unavailable,
    get_dense_retrieval_backend_label,
    search_dense_terminology,
)


def _normalize_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()

def _tokenize(value: str) -> list[str]:
    return [token for token in _normalize_text(value).split() if token]


# Resources
ICD10_LOOKUP_CACHE_KEY = "icd10_entity_hybrid"
ICD10_DENSE_TOP_K = int(os.getenv("AGENTIC_ICD10_DENSE_TOP_K", "30"))
ICD10_LEXICAL_TOP_K = int(os.getenv("AGENTIC_ICD10_LEXICAL_TOP_K", "8"))
ICD10_RERANK_CANDIDATE_LIMIT = int(os.getenv("AGENTIC_ICD10_RERANK_CANDIDATE_LIMIT", "12"))
ICD10_LEXICAL_MIN_COVERAGE = float(os.getenv("AGENTIC_ICD10_LEXICAL_MIN_COVERAGE", "0.75"))
_icd10_lookup_rows: list[dict] | None = None
_icd10_lookup_by_code: dict[str, dict] | None = None
_icd10_lookup_signature = "unavailable"
_retrieval_traces: list[dict] = []


def _record_retrieval_traces_enabled() -> bool:
    return os.environ.get("AGENTIC_RECORD_RETRIEVAL_TRACES", "").strip().lower() in {"1", "true", "yes", "on"}


def _record_icd10_trace(entity: str, candidates: list[dict], selected: dict | None) -> None:
    selected_code = selected.get("code") if selected else None
    selected_rank = None
    for idx, candidate in enumerate(candidates, start=1):
        if selected_code and candidate.get("code") == selected_code:
            selected_rank = idx
            break
    _retrieval_traces.append(
        query_trace(
            vocabulary="ICD10",
            query_text=entity,
            retrieval_backend=(
                "Local ICD-10 lexical lookup + "
                f"{get_dense_retrieval_backend_label('icd10')}"
            ),
            retrieval_stage="hybrid_candidate_search",
            candidates=[
                candidate_trace(
                    rank=idx,
                    code=candidate.get("code"),
                    display=candidate.get("display"),
                    similarity_score=candidate.get("semantic_score"),
                    extra={
                        "retrieval_source": candidate.get("retrieval_source"),
                        "indexed_term": candidate.get("indexed_term"),
                        "lexical_coverage": candidate.get("lexical_coverage"),
                    },
                )
                for idx, candidate in enumerate(candidates, start=1)
            ],
            selected_code=selected_code,
            selected_display=selected.get("display") if selected else None,
            selected_rank=selected_rank,
            reranker_used=len(candidates) > 1,
            cache_hit=False,
        )
    )

def _parse_lookup_aliases(value: str) -> list[str]:
    """Read optional structured aliases while remaining compatible with old CSVs."""
    raw_value = str(value or "").strip()
    if not raw_value:
        return []
    try:
        parsed = json.loads(raw_value)
    except (json.JSONDecodeError, TypeError):
        parsed = None
    if isinstance(parsed, list):
        return [str(item).strip() for item in parsed if str(item).strip()]
    return [part.strip() for part in raw_value.split("|") if part.strip()]


def _lookup_search_terms(row: dict) -> list[str]:
    """Return human-readable lookup terms without assuming a fixed CSV schema."""
    terms: list[str] = []
    display = str(row.get("display") or "").strip()
    if display:
        terms.append(display)
    terms.extend(_parse_lookup_aliases(row.get("aliases", "")))
    excluded_fields = {"code", "display", "aliases", "status", "system_uri"}
    for key, value in row.items():
        if key.startswith("_") or key in excluded_fields:
            continue
        text = str(value or "").strip()
        if text:
            terms.append(text)
    return list(dict.fromkeys(terms))


def _load_icd10_lookup() -> tuple[list[dict], dict[str, dict]]:
    """Load the ICD lookup independently of the optional dense model/index."""
    global _icd10_lookup_rows, _icd10_lookup_by_code, _icd10_lookup_signature
    if _icd10_lookup_rows is not None and _icd10_lookup_by_code is not None:
        return _icd10_lookup_rows, _icd10_lookup_by_code

    try:
        # Upgrade an older generated lookup from its local terminology source
        # when possible. Read-only deployments retain their existing artifact.
        lookup_path = build_icd10_lookup()
    except Exception as rebuild_error:
        try:
            lookup_path = get_lookup_path("icd10")
            print(f"   ICD-10 lookup refresh skipped: {rebuild_error}")
        except Exception as lookup_error:
            print(f"   ICD-10 lexical lookup unavailable: {lookup_error}")
            _icd10_lookup_rows = []
            _icd10_lookup_by_code = {}
            _icd10_lookup_signature = "unavailable"
            return _icd10_lookup_rows, _icd10_lookup_by_code

    print(f"Loading ICD-10 lookup CSV: {lookup_path}...")
    try:
        with lookup_path.open("r", encoding="utf-8", newline="") as handle:
            rows = []
            for row in csv.DictReader(handle):
                status = _normalize_text(row.get("status", ""))
                if status in {"deprecated", "inactive", "obsolete"}:
                    continue
                code = str(row.get("code") or "").strip()
                display = str(row.get("display") or "").strip()
                if code and display:
                    rows.append(dict(row))
    except Exception as exc:
        print(f"   ICD-10 lexical lookup unavailable: {exc}")
        rows = []

    by_code: dict[str, dict] = {}
    for row in rows:
        by_code.setdefault(str(row["code"]), row)
    _icd10_lookup_rows = rows
    _icd10_lookup_by_code = by_code
    try:
        lookup_stat = lookup_path.stat()
        _icd10_lookup_signature = f"{lookup_stat.st_size}:{lookup_stat.st_mtime_ns}"
    except OSError:
        _icd10_lookup_signature = "unavailable"
    print(f"   ICD-10 lookup CSV loaded: {len(rows):,} concepts")
    return rows, by_code


def _lexical_score(row: dict, query: str) -> tuple:
    normalized_terms = [
        normalized
        for normalized in (_normalize_text(term) for term in _lookup_search_terms(row))
        if normalized
    ]
    query_tokens = set(_tokenize(query))
    term_token_sets = [set(_tokenize(term)) for term in normalized_terms]
    overlaps = [len(query_tokens & tokens) for tokens in term_token_sets] or [0]
    coverage = max(overlaps) / max(len(query_tokens), 1)
    canonical_exact = _normalize_text(row.get("display", "")) == query
    exact = any(term == query for term in normalized_terms)
    starts_with = any(term.startswith(query) for term in normalized_terms)
    contains_query = any(query in term for term in normalized_terms)
    contained_by_query = any(term in query for term in normalized_terms)
    shortest_matching_term = min(
        (
            len(tokens)
            for term, tokens in zip(normalized_terms, term_token_sets)
            if query in term or term in query
        ),
        default=10**9,
    )
    return (
        1 if canonical_exact else 0,
        1 if exact else 0,
        1 if starts_with else 0,
        1 if contains_query else 0,
        1 if contained_by_query else 0,
        coverage,
        max(overlaps),
        -shortest_matching_term,
        str(row.get("code") or ""),
    )


def _candidate_from_lookup_row(row: dict, entity: str) -> dict:
    score = _lexical_score(row, _normalize_text(entity))
    return {
        "code": str(row.get("code") or "").strip(),
        "display": str(row.get("display") or entity).strip(),
        "status": str(row.get("status") or ""),
        "system_uri": str(row.get("system_uri") or ""),
        "retrieval_source": "lexical",
        "lexical_coverage": float(score[5]),
    }


def _lexical_icd10_candidates(entity: str) -> list[dict]:
    rows, _ = _load_icd10_lookup()
    query = _normalize_text(entity)
    if not query:
        return []

    ranked: list[tuple[tuple, dict]] = []
    for row in rows:
        score = _lexical_score(row, query)
        canonical_exact, exact, starts_with, contains_query, contained_by_query, coverage = score[:6]
        if not (
            canonical_exact
            or exact
            or starts_with
            or contains_query
            or contained_by_query
            or coverage >= ICD10_LEXICAL_MIN_COVERAGE
        ):
            continue
        ranked.append((score, row))
    ranked.sort(key=lambda item: item[0], reverse=True)
    return [
        _candidate_from_lookup_row(row, entity)
        for _, row in ranked[:ICD10_LEXICAL_TOP_K]
    ]


def _dense_icd10_candidates(entity: str) -> list[dict]:
    _, lookup_by_code = _load_icd10_lookup()
    rows = search_dense_terminology("icd10", entity, ICD10_DENSE_TOP_K)
    candidates: list[dict] = []
    for row in rows:
        code = str(row.get("code") or "").strip()
        if not code:
            continue
        canonical_row = lookup_by_code.get(code, {})
        display = (
            canonical_row.get("display")
            or row.get("display")
            or row.get("indexed_term")
            or entity
        )
        candidates.append(
            {
                "code": code,
                "display": str(display),
                "status": str(canonical_row.get("status") or row.get("status") or ""),
                "system_uri": str(canonical_row.get("system_uri") or ""),
                "indexed_term": str(row.get("indexed_term") or ""),
                "semantic_score": row.get("semantic_score"),
                "retrieval_source": "dense",
            }
        )
    return candidates


def _dedupe_icd10_candidates(candidates: list[dict]) -> list[dict]:
    deduped: list[dict] = []
    by_code: dict[str, dict] = {}
    for candidate in candidates:
        code = str(candidate.get("code") or "").strip()
        if not code:
            continue
        existing = by_code.get(code)
        if existing is None:
            copied = dict(candidate)
            by_code[code] = copied
            deduped.append(copied)
            continue
        sources = {
            source
            for value in (existing.get("retrieval_source"), candidate.get("retrieval_source"))
            for source in str(value or "").split("+")
            if source
        }
        existing["retrieval_source"] = "+".join(
            source for source in ("lexical", "dense") if source in sources
        )
        for field in ("semantic_score", "indexed_term", "lexical_coverage"):
            if existing.get(field) in (None, "") and candidate.get(field) not in (None, ""):
                existing[field] = candidate[field]
    return deduped

def _fallback_candidate_without_llm(
    entity: str,
    candidates: list[dict],
    *,
    source_assertion_negated: bool = False,
) -> dict | None:
    """Use only trustworthy lexical evidence if semantic validation is unavailable."""
    normalized_entity = _normalize_text(entity)
    for candidate in candidates:
        if "lexical" not in str(candidate.get("retrieval_source") or "").split("+"):
            continue
        if source_assertion_negated and _normalize_text(candidate.get("display", "")) != normalized_entity:
            continue
        return candidate
    return None


def _pick_best_candidate_with_llm(
    entity: str,
    context: str,
    candidates: list[dict],
    *,
    source_assertion_negated: bool = False,
    assertion_encoded_by_concept: bool = False,
) -> dict | None:
    if not candidates:
        return None

    prompt = (
        "You are deciding whether an extracted healthcare fact has a clinically equivalent ICD-10-CM candidate.\n"
        "Return only JSON like {\"selected_code\": \"...\"} or {\"selected_code\": null}.\n"
        "Choose null when ICD-10-CM is not applicable to the fact or when candidates are merely related. "
        "Do not convert administrative, participant, medication, procedure, measurement, or other non-diagnosis facts into diagnoses; these are illustrative, non-exhaustive examples.\n"
        "If the source assertion is absent or negated, return null unless the candidate itself preserves that complete meaning. Do not assign a positive diagnosis code merely because downstream FHIR could negate it.\n\n"
        f"Entity: {entity}\n"
        f"Source assertion negated/absent: {json.dumps(bool(source_assertion_negated))}\n"
        f"Selected source concept encodes assertion: {json.dumps(bool(assertion_encoded_by_concept))}\n"
        f"Context: {context}\n\n"
        "Candidates:\n"
        + json.dumps(candidates, indent=2)
    )
    try:
        llm = load_llm()
        response = resilient_llm_invoke(llm, [HumanMessage(content=prompt)])
        response_text = str(response.content).strip()
        match = re.search(r'\{.*"selected_code".*\}', response_text, re.DOTALL)
        payload = json.loads(match.group(0) if match else response_text)
        selected_code = payload.get("selected_code")
        if not selected_code:
            return None
        for candidate in candidates:
            if candidate["code"] == selected_code:
                return candidate
    except Exception:
        return _fallback_candidate_without_llm(
            entity,
            candidates,
            source_assertion_negated=source_assertion_negated,
        )
    return None

def _search_candidates(entity: str, context: str = "") -> list[dict]:
    if not _normalize_text(entity):
        return []
    lexical_candidates = _lexical_icd10_candidates(entity)
    dense_candidates = _dense_icd10_candidates(entity)
    return _dedupe_icd10_candidates(
        [*lexical_candidates, *dense_candidates]
    )[:ICD10_RERANK_CANDIDATE_LIMIT]

def _query_icd10(
    entity: str,
    context: str = "",
    *,
    source_assertion_negated: bool = False,
    assertion_encoded_by_concept: bool = False,
) -> dict | None:
    candidates = _search_candidates(entity, context)
    if not candidates:
        _record_icd10_trace(entity, [], None)
        return None

    selected = _pick_best_candidate_with_llm(
        entity,
        context,
        candidates,
        source_assertion_negated=source_assertion_negated,
        assertion_encoded_by_concept=assertion_encoded_by_concept,
    )
    _record_icd10_trace(entity, candidates, selected)
    if not selected:
        return None
    return {"icd10_code": selected["code"], "icd10_name": selected["display"]}


@tool
def icd10_lookup(
    entity: str,
    context: str,
    source_assertion_negated: bool = False,
    assertion_encoded_by_concept: bool = False,
) -> str:
    """Resolve a single entity to an ICD-10-CM concept when applicable."""
    if not entity:
        return json.dumps({"status": "NO_ENTITY", "entity": entity, "icd10_code": None, "icd10_name": None})

    _load_icd10_lookup()
    cache_key = {
        "entity": entity,
        "context": context,
        "lookup_signature": _icd10_lookup_signature,
        "source_assertion_negated": bool(source_assertion_negated),
        "assertion_encoded_by_concept": bool(assertion_encoded_by_concept),
    }
    cached = None if _record_retrieval_traces_enabled() else cache.get_stage(ICD10_LOOKUP_CACHE_KEY, cache_key)
    if cached:
        return json.dumps({"status": "CACHE_HIT", **cached})

    lookup_failed = False
    try:
        icd10 = _query_icd10(
            entity,
            context,
            source_assertion_negated=bool(source_assertion_negated),
            assertion_encoded_by_concept=bool(assertion_encoded_by_concept),
        )
        if icd10:
            result = {"status": "CANDIDATES_FOUND", "entity": entity, **icd10}
        else:
            result = {"status": "NO_MATCH", "entity": entity, "icd10_code": None, "icd10_name": entity}
    except Exception as exc:
        lookup_failed = True
        print(f"   ICD-10 hybrid lookup unavailable for '{entity}': {exc}")
        result = {"status": "NO_MATCH", "entity": entity, "icd10_code": None, "icd10_name": entity}

    retrieval_degraded = not result.get("icd10_code") and dense_retrieval_unavailable("icd10")
    if retrieval_degraded:
        print("   ICD-10 no-match was not cached because dense retrieval is unavailable.")
    if not lookup_failed and not retrieval_degraded:
        cache.put_stage(ICD10_LOOKUP_CACHE_KEY, cache_key, result)
    return json.dumps(result)


def _mapping_candidate_terms(mapping: dict) -> list[str]:
    terms = []
    for value in (mapping.get("entity"), mapping.get("original_entity")):
        if isinstance(value, str) and value.strip():
            terms.append(re.sub(r"\s+", " ", value).strip())
    return list(dict.fromkeys(terms))


def _icd10_applicable(mapping: dict) -> bool:
    """Use explicit diagnosis/allergy intent before ICD-10 candidate retrieval."""
    if mapping.get("icd10_code"):
        return False
    return bool(
        mapping.get("condition")
        or mapping.get("is_allergy")
        or str(mapping.get("fhir_resource_type") or "").strip() == "Condition"
    )


def _merge_icd10_result(mapping: dict, parsed: dict) -> bool:
    new_code = parsed.get("icd10_code")
    new_name = parsed.get("icd10_name")
    if not new_code:
        return False
    existing = mapping.get("icd10_code")
    if existing:
        existing_codes = {code.strip() for code in str(existing).split(",") if code.strip()}
        if str(new_code) in existing_codes:
            return False
        mapping["icd10_code"] = f"{existing}, {new_code}"
        mapping["icd10_name"] = f"{mapping.get('icd10_name') or ''}, {new_name}".strip(", ")
    else:
        mapping["icd10_code"] = new_code
        mapping["icd10_name"] = new_name
    return True


def run_icd10_agent_langgraph(processed_text: str, mappings: List[dict]) -> tuple[List[dict], list[str], list[dict]]:
    """Run Agent 5 with programmatic tool routing over the mapping list."""
    global _retrieval_traces
    _retrieval_traces = []
    logs: list[str] = []
    enriched_mappings = [
        dict(mapping) if isinstance(mapping, dict) else {"entity": str(mapping or "").strip()}
        for mapping in (mappings if isinstance(mappings, list) else [])
        if isinstance(mapping, dict) or str(mapping or "").strip()
    ]

    print("\n" + "=" * 60)
    print("STARTING AGENT 5: ICD-10 Mapping")
    print("=" * 60)
    print("   Using programmatic ICD-10 flow. Native LLM tool calls are disabled to avoid Ollama tool-call JSON parsing failures.")
    print(f"Input mappings: {len(enriched_mappings)}")
    print("   Terms to process:")
    for m in enriched_mappings:
        print(f"     - {m.get('entity')}")

    logs.append("=" * 60)
    logs.append("STARTING AGENT 5: ICD-10 Mapping")
    logs.append("=" * 60)
    logs.append("   Using programmatic ICD-10 flow; native LLM tool calls are disabled.")
    logs.append(f"Input mappings: {len(enriched_mappings)}")

    for mapping in enriched_mappings:
        entity = mapping.get("entity") or mapping.get("original_entity") or ""
        if not _icd10_applicable(mapping):
            print(f"   - Skipping ICD-10 for '{entity}' (no diagnosis/allergy intent or already mapped).")
            continue

        print(f"   > ICD-10 lookup candidates for '{entity}'")
        matched = False
        for term in _mapping_candidate_terms(mapping):
            print(f"   > Executing tool: icd10_lookup('{term}')")
            logs.append("   🔧 Tool executed: icd10_lookup")
            result = icd10_lookup.invoke({
                "entity": term,
                "context": processed_text,
                "source_assertion_negated": bool(
                    mapping.get("source_assertion_negated") or mapping.get("negated")
                ),
                "assertion_encoded_by_concept": bool(
                    mapping.get("assertion_encoded_by_concept")
                ),
            })
            try:
                parsed = json.loads(result)
            except Exception:
                parsed = {"entity": term, "icd10_code": None, "icd10_name": term}
            if _merge_icd10_result(mapping, parsed):
                print(f"     ICD-10 selected: {parsed.get('icd10_code')} — {parsed.get('icd10_name')}")
                logs.append(f"   ✅ ICD-10 selected for '{entity}': {parsed.get('icd10_code')} — {parsed.get('icd10_name')}")
                matched = True
                break
        if not matched:
            logs.append(f"   ⚠ No ICD-10 selected for '{entity}'")

    print("   > ICD-10 Agent workflow complete.")
    logs.append("   ✅ ICD-10 Agent workflow complete.")
    return enriched_mappings, logs, list(_retrieval_traces)

def run_icd10_agent(processed_text: str, mappings: List[dict]) -> List[dict]:
    """Backward-compatible entry point that returns only the enriched mappings."""
    output_mappings, _, _ = run_icd10_agent_langgraph(processed_text, mappings)
    return output_mappings
