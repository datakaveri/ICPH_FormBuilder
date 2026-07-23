"""LOINC Mapping Agent (Agent 3).

Uses a LangGraph workflow to enrich SNOMED mappings with LOINC data when a
mapping appears to represent a test, observation, or procedure.
"""

from __future__ import annotations

from typing import List, TypedDict, Literal
import json
import os
import re
from pathlib import Path

from langchain_core.tools import tool
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.graph import StateGraph, END

import cache
import pandas as pd
from llm_runtime import load_llm, resilient_llm_invoke
from prompts import load_prompt
from retrieval_trace import candidate_trace, query_trace
from schema_terminology_assets import get_lookup_path
from terminology_dense_search import (
    dense_retrieval_unavailable,
    get_dense_retrieval_backend_label,
    search_dense_terminology,
)


def _normalize_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def _tokenize(value: str) -> list[str]:
    return [token for token in _normalize_text(value).split() if token]


def _loinc_score(row, query: str, raw_query: str) -> tuple:
    display = row["display"]
    long_name = row["long_common_name"]
    short_name = row["short_name"]
    component = row["component"]
    loinc_class = row["class"]

    query_tokens = set(_tokenize(raw_query))
    display_tokens = set(_tokenize(display))
    long_tokens = set(_tokenize(long_name))
    short_tokens = set(_tokenize(short_name))
    component_tokens = set(_tokenize(component))
    all_tokens = display_tokens | long_tokens | short_tokens | component_tokens

    exact_short = short_name and _normalize_text(short_name) == query
    exact_component = component and _normalize_text(component) == query
    exact_display = display and _normalize_text(display) == query
    exact_long = long_name and _normalize_text(long_name) == query
    query_in_short = query and query in _normalize_text(short_name)
    query_in_component = query and query in _normalize_text(component)
    query_in_display = query and query in _normalize_text(display)
    query_in_long = query and query in _normalize_text(long_name)

    overlap = len(query_tokens & all_tokens)
    coverage = overlap / max(len(query_tokens), 1)

    penalty = 0
    if row["status"].upper() in {"DEPRECATED", "DISCOURAGED"}:
        penalty += 20
    if "deprecated" in _normalize_text(display):
        penalty += 20

    return (
        1 if exact_short else 0,
        1 if exact_component else 0,
        1 if exact_display else 0,
        1 if exact_long else 0,
        1 if query_in_short else 0,
        1 if query_in_component else 0,
        1 if query_in_display else 0,
        1 if query_in_long else 0,
        coverage,
        overlap,
        -penalty,
        -len(display_tokens),
        row["code"],
    )


try:
    LOINC_LOOKUP_CSV = get_lookup_path("loinc")
    _LOINC_LOOKUP_CONFIG_ERROR = None
except Exception as exc:
    LOINC_LOOKUP_CSV = None
    _LOINC_LOOKUP_CONFIG_ERROR = exc
LOINC_LOOKUP_CACHE_KEY = "loinc_entity_v6_hybrid_k30_context"
LOINC_DENSE_TOP_K = int(os.getenv("AGENTIC_LOINC_DENSE_TOP_K", "30"))
LOINC_RERANK_CANDIDATE_LIMIT = int(os.getenv("AGENTIC_LOINC_RERANK_CANDIDATE_LIMIT", "12"))
_loinc_lookup_df = None
_retrieval_traces: list[dict] = []


def _record_retrieval_traces_enabled() -> bool:
    return os.environ.get("AGENTIC_RECORD_RETRIEVAL_TRACES", "").strip().lower() in {"1", "true", "yes", "on"}


def _record_loinc_trace(entity: str, candidates: list[dict], selected: dict | None) -> None:
    selected_code = selected.get("code") if selected else None
    selected_rank = None
    for idx, candidate in enumerate(candidates, start=1):
        if selected_code and candidate.get("code") == selected_code:
            selected_rank = idx
            break
    _retrieval_traces.append(
        query_trace(
            vocabulary="LOINC",
            query_text=entity,
            retrieval_backend=f"Local LOINC lexical lookup + {get_dense_retrieval_backend_label('loinc')}",
            retrieval_stage="hybrid_candidate_search",
            candidates=[
                candidate_trace(
                    rank=idx,
                    code=candidate.get("code"),
                    display=candidate.get("display") or candidate.get("long_common_name"),
                    extra={
                        "long_common_name": candidate.get("long_common_name"),
                        "short_name": candidate.get("short_name"),
                        "class": candidate.get("class"),
                        "status": candidate.get("status"),
                        "retrieval_source": candidate.get("retrieval_source"),
                        "indexed_term": candidate.get("indexed_term"),
                        "semantic_score": candidate.get("semantic_score"),
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


class Agent3State(TypedDict):
    messages: list


def _fallback_candidate_without_llm(
    candidates: list[dict],
    *,
    asserted_absent: bool = False,
) -> dict | None:
    if asserted_absent:
        return None
    for candidate in candidates:
        if candidate.get("retrieval_source") != "dense":
            return candidate
    return None


def _pick_best_candidate_with_llm(
    entity: str,
    context: str,
    candidates: list[dict],
    *,
    asserted_absent: bool = False,
) -> dict | None:
    """Use the LLM to choose among a small set of local terminology candidates."""
    if not candidates:
        return None
    if (
        len(candidates) == 1
        and candidates[0].get("retrieval_source") != "dense"
        and not asserted_absent
    ):
        return _fallback_candidate_without_llm(candidates)

    prompt = (
        "You are selecting the best LOINC concept for a clinical entity.\n"
        "LOINC is for lab tests, measurements, panels, survey items, and structured observations. "
        "Prefer exact terminology matches. Choose null if the candidates are merely related but do "
        "not represent the same ordered or observed concept. Do not choose a panel, component, order, "
        "or result-type candidate unless that level of meaning is supported by the entity and context.\n"
        "If the entity is absent, negated, denied, or otherwise states the non-presence of a finding, "
        "choose null for candidates that ask about or encode the positive presence of that finding. "
        "Only select a LOINC candidate when it preserves the same assertion context, or when it is a "
        "result-independent lab/test/order concept where LOINC represents the measurement itself.\n"
        "Return only JSON like {\"selected_code\": \"...\"} or {\"selected_code\": null}.\n"
        "Choose null if none of the candidates are an appropriate match.\n\n"
        f"Entity: {entity}\n"
        f"Source assertion negated/absent: {json.dumps(bool(asserted_absent))}\n"
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
            candidates,
            asserted_absent=asserted_absent,
        )
    return _fallback_candidate_without_llm(
        candidates,
        asserted_absent=asserted_absent,
    )


def _candidate_row_to_dict(candidate, fallback_entity: str) -> dict:
    get_value = candidate.get if hasattr(candidate, "get") else lambda key, default="": candidate[key] if key in candidate else default
    return {
        "code": get_value("code"),
        "display": get_value("display") or get_value("long_common_name") or get_value("indexed_term") or fallback_entity,
        "long_common_name": get_value("long_common_name") or get_value("display") or get_value("indexed_term") or "",
        "short_name": get_value("short_name") or "",
        "component": get_value("component") or get_value("display") or get_value("indexed_term") or "",
        "class": get_value("class") or "",
        "status": get_value("status") or "",
        "indexed_term": get_value("indexed_term") or "",
        "semantic_score": get_value("semantic_score"),
        "retrieval_source": get_value("retrieval_source") or "lexical",
    }


def _dedupe_loinc_candidates(candidates: list[dict]) -> list[dict]:
    deduped: list[dict] = []
    seen_codes: set[str] = set()
    for candidate in candidates:
        code = str(candidate.get("code") or "").strip()
        if not code or code in seen_codes:
            continue
        seen_codes.add(code)
        deduped.append(candidate)
    return deduped


def _dense_loinc_candidates(entity: str) -> list[dict]:
    rows = search_dense_terminology("loinc", entity, LOINC_DENSE_TOP_K)
    candidates = []
    for row in rows:
        if str(row.get("status") or "").upper() != "ACTIVE":
            continue
        if "deprecated" in _normalize_text(f"{row.get('display', '')} {row.get('indexed_term', '')}"):
            continue
        candidates.append(_candidate_row_to_dict(row, entity))
    return candidates


@tool
def loinc_lookup(entity: str, context: str, negated: bool = False) -> str:
    """Resolve a single entity to a LOINC concept when applicable."""
    if not entity:
        return json.dumps({"entity": entity, "loinc_code": None, "loinc_name": None})

    cache_key = {"entity": entity, "negated": bool(negated)}
    cached = None if _record_retrieval_traces_enabled() else cache.get_stage(LOINC_LOOKUP_CACHE_KEY, cache_key)
    if cached:
        return json.dumps(cached)

    lookup_failed = False
    try:
        loinc = _query_loinc(entity, context, asserted_absent=bool(negated))
        if loinc:
            result = {
                "entity": entity,
                "loinc_code": loinc.get("code"),
                "loinc_name": loinc.get("display"),
                "loinc_class": loinc.get("class"),
            }
        else:
            result = {"entity": entity, "loinc_code": None, "loinc_name": entity}
    except Exception as exc:
        lookup_failed = True
        print(f"   LOINC lookup failed for '{entity}'; leaving it unmapped: {exc}")
        result = {"entity": entity, "loinc_code": None, "loinc_name": entity}

    retrieval_degraded = not result.get("loinc_code") and dense_retrieval_unavailable("loinc")
    if retrieval_degraded:
        print("   LOINC no-match was not cached because dense retrieval is unavailable.")
    if not lookup_failed and not retrieval_degraded:
        cache.put_stage(LOINC_LOOKUP_CACHE_KEY, cache_key, result)
    return json.dumps(result)


def _generalize_loinc_term(entity: str, context: str = "") -> str:
    """Use an LLM to convert a non-standard term into standard clinical terminology for LOINC."""
    prompt = (
        "You are an expert clinical terminology mapper.\n"
        f"The clinical entity '{entity}' (Context: '{context}') could not be found in the LOINC database.\n"
        "Please provide the standard, most common clinical or laboratory synonym for this test or observation.\n"
        "Return ONLY the standard clinical name string, nothing else. If you cannot generalize it, return the original entity."
    )
    try:
        llm = load_llm()
        response = resilient_llm_invoke(llm, [HumanMessage(content=prompt)])
        generalized = str(response.content).strip().lower()
        if generalized and generalized != entity.lower() and len(generalized) < 100:
            return generalized
    except Exception:
        pass
    return entity


def _query_loinc(
    entity: str,
    context: str = "",
    tried_generalize: bool = False,
    asserted_absent: bool = False,
) -> dict | None:
    """Resolve a LOINC concept using the local lookup artifact."""
    if not entity or not entity.strip():
        return None

    global _loinc_lookup_df
    if _loinc_lookup_df is None:
        expected_columns = [
            "code",
            "display",
            "long_common_name",
            "short_name",
            "component",
            "class",
            "status",
        ]
        try:
            if LOINC_LOOKUP_CSV is None or not LOINC_LOOKUP_CSV.exists():
                raise FileNotFoundError(_LOINC_LOOKUP_CONFIG_ERROR or "lookup CSV is missing")
            df = pd.read_csv(LOINC_LOOKUP_CSV, dtype=str).fillna("")
            missing_columns = [column for column in expected_columns if column not in df.columns]
            if missing_columns:
                raise ValueError(f"lookup CSV is missing columns: {missing_columns}")
            df = df[df["status"].str.upper().eq("ACTIVE")].copy()
            print(f"   LOINC lookup CSV loaded: {len(df):,} active concepts")
        except Exception as exc:
            print(f"   LOINC lookup CSV unavailable; dense retrieval will continue: {exc}")
            df = pd.DataFrame(columns=expected_columns)
        df["_display_norm"] = df["display"].map(_normalize_text)
        df["_long_norm"] = df["long_common_name"].map(_normalize_text)
        df["_short_norm"] = df["short_name"].map(_normalize_text)
        df["_component_norm"] = df["component"].map(_normalize_text)
        _loinc_lookup_df = df

    query = _normalize_text(entity)
    if not query:
        return None

    exact_fields = ["_short_norm", "_component_norm", "_display_norm", "_long_norm"]
    for field in exact_fields:
        matches = _loinc_lookup_df[_loinc_lookup_df[field] == query]
        if not matches.empty:
            candidates = [_candidate_row_to_dict(candidate, entity) for _, candidate in matches.iterrows()]
            candidates = sorted(
                candidates,
                key=lambda candidate: _loinc_score(pd.Series(candidate), query, entity),
                reverse=True,
            )[:5]
            selected = _pick_best_candidate_with_llm(
                entity,
                context,
                candidates,
                asserted_absent=asserted_absent,
            )
            _record_loinc_trace(entity, candidates, selected)
            return selected

    contains_masks = []
    for field in exact_fields:
        contains_masks.append(_loinc_lookup_df[field].str.contains(re.escape(query), regex=True, na=False))
    combined_mask = contains_masks[0]
    for mask in contains_masks[1:]:
        combined_mask = combined_mask | mask
    matches = _loinc_lookup_df[combined_mask]
    
    if matches.empty:
        dense_candidates = _dense_loinc_candidates(entity)
        if dense_candidates:
            candidates = _dedupe_loinc_candidates(dense_candidates)[:LOINC_RERANK_CANDIDATE_LIMIT]
            selected = _pick_best_candidate_with_llm(
                entity,
                context,
                candidates,
                asserted_absent=asserted_absent,
            )
            _record_loinc_trace(entity, candidates, selected)
            if selected:
                return selected
        if not tried_generalize:
            generalized_entity = _generalize_loinc_term(entity, context)
            if generalized_entity.lower() != entity.lower():
                return _query_loinc(
                    generalized_entity,
                    context,
                    tried_generalize=True,
                    asserted_absent=asserted_absent,
                )
        _record_loinc_trace(entity, [], None)
        return None

    ranked_rows = sorted(
        (candidate for _, candidate in matches.iterrows()),
        key=lambda candidate: _loinc_score(candidate, query, entity),
        reverse=True,
    )[:5]
    lexical_candidates = [_candidate_row_to_dict(candidate, entity) for candidate in ranked_rows]
    dense_candidates = _dense_loinc_candidates(entity)
    candidates = _dedupe_loinc_candidates([*lexical_candidates, *dense_candidates])[:LOINC_RERANK_CANDIDATE_LIMIT]
    selected = _pick_best_candidate_with_llm(
        entity,
        context,
        candidates,
        asserted_absent=asserted_absent,
    )
    _record_loinc_trace(entity, candidates, selected)
    return selected


def run_loinc_agent_langgraph(processed_text: str, mappings: List[dict]) -> tuple[List[dict], list[str], list[dict]]:
    """Run Agent 3 with LLM-guided tool routing over the mapping list."""
    global _retrieval_traces
    _retrieval_traces = []
    logs: list[str] = []
    enriched_mappings = [
        dict(mapping) if isinstance(mapping, dict) else {"entity": str(mapping or "").strip()}
        for mapping in (mappings if isinstance(mappings, list) else [])
        if isinstance(mapping, dict) or str(mapping or "").strip()
    ]
    entity_index = {
        (mapping.get("entity") or mapping.get("original_entity") or ""): idx
        for idx, mapping in enumerate(enriched_mappings)
    }

    tools = [loinc_lookup]
    try:
        llm = load_llm()
        llm_with_tools = llm.bind_tools(tools)
        system_prompt = load_prompt("agent3_system")
    except Exception as exc:
        warning = f"LOINC routing model unavailable; mappings were left unchanged: {exc}"
        print(f"⚠ {warning}")
        logs.append(f"STAGE_FAILURE: {warning}")
        return enriched_mappings, logs, []
    agent_iterations = [0]

    def agent_node(state: Agent3State) -> Agent3State:
        agent_iterations[0] += 1
        iteration = agent_iterations[0]
        messages = state["messages"]
        print(f"   > Agent thinking (iteration {iteration})...")
        response = resilient_llm_invoke(llm_with_tools, messages)
        if hasattr(response, "tool_calls") and response.tool_calls:
            calls = len(response.tool_calls)
            print(f"   > Agent requested {calls} tool call(s).")
        else:
            print("   > Agent finished.")
        return {"messages": messages + [response]}

    def tool_node(state: Agent3State) -> Agent3State:
        messages = state["messages"]
        last_message = messages[-1]
        tool_results = []
        for tool_call in last_message.tool_calls:
            tool_name = tool_call["name"]
            tool_args = dict(tool_call["args"])
            args_short = ", ".join(f"{k}='{v}'" for k, v in tool_args.items())
            print(f"   > Executing tool: {tool_name}")
            logs.append(f"   🔧 Tool executed: {tool_name}")
            lookup_entity = str(tool_args.get("entity") or "")
            lookup_idx = entity_index.get(lookup_entity)
            if lookup_idx is None:
                for i, m in enumerate(enriched_mappings):
                    m_ent = m.get("entity") or m.get("original_entity") or ""
                    if m_ent and lookup_entity and (lookup_entity.lower() in m_ent.lower() or m_ent.lower() in lookup_entity.lower()):
                        lookup_idx = i
                        break
            if lookup_idx is not None and "negated" not in tool_args:
                lookup_mapping = enriched_mappings[lookup_idx]
                tool_args["negated"] = bool(
                    lookup_mapping.get("source_assertion_negated")
                    or lookup_mapping.get("negated")
                )
            result = loinc_lookup.invoke(tool_args)
            try:
                parsed = json.loads(result)
            except Exception:
                parsed = {"entity": tool_args.get("entity"), "loinc_code": None, "loinc_name": tool_args.get("entity")}
            entity = parsed.get("entity") or tool_args.get("entity") or ""
            idx = entity_index.get(entity)
            if idx is None:
                # Fallback 1: string match
                for i, m in enumerate(enriched_mappings):
                    m_ent = m.get("entity") or m.get("original_entity") or ""
                    if m_ent and entity and (entity.lower() in m_ent.lower() or m_ent.lower() in entity.lower()):
                        idx = i
                        break

            new_code = parsed.get("loinc_code")
            new_name = parsed.get("loinc_name")
            new_class = parsed.get("loinc_class")
            if new_code:
                logs.append(f"   ✅ LOINC selected for '{entity}': {new_code} — {new_name}")
            else:
                logs.append(f"   ⚠ No LOINC selected for '{entity}'")

            if idx is None and new_code:
                # Fallback 2: code match
                for i, m in enumerate(enriched_mappings):
                    existing_code = m.get("loinc_code")
                    if existing_code and new_code in existing_code:
                        idx = i
                        break

            if idx is not None:
                if new_code:
                    existing = enriched_mappings[idx].get("loinc_code")
                    if existing:
                        if new_code not in existing:
                            enriched_mappings[idx]["loinc_code"] += f", {new_code}"
                            enriched_mappings[idx]["loinc_name"] += f", {new_name}"
                    else:
                        enriched_mappings[idx]["loinc_code"] = new_code
                        enriched_mappings[idx]["loinc_name"] = new_name
                    if new_class:
                        enriched_mappings[idx]["loinc_class"] = new_class
            else:
                if new_code:
                    new_mapping = {
                        "entity": entity,
                        "original_entity": entity,
                        # The LOINC tool is called only after Agent 3 has
                        # semantically classified this as a test, measurement,
                        # survey item, or structured observation. Preserve that
                        # grounded role for schema-based FHIR routing.
                        "observation": entity,
                        "loinc_code": new_code,
                        "loinc_name": new_name,
                        "loinc_class": new_class,
                        "matched_via": "federated_discovery",
                        "confidence": "High",
                    }
                    enriched_mappings.append(new_mapping)
                    entity_index[entity] = len(enriched_mappings) - 1
            tool_results.append(ToolMessage(content=result, tool_call_id=tool_call["id"]))
        return {"messages": messages + tool_results}

    def should_continue(state: Agent3State) -> Literal["tools", "end"]:
        last_message = state["messages"][-1]
        if hasattr(last_message, "tool_calls") and last_message.tool_calls:
            return "tools"
        return "end"

    workflow = StateGraph(Agent3State)
    workflow.add_node("agent", agent_node)
    workflow.add_node("tools", tool_node)
    workflow.set_entry_point("agent")
    workflow.add_conditional_edges("agent", should_continue, {"tools": "tools", "end": END})
    workflow.add_edge("tools", "agent")
    graph = workflow.compile()

    print("\n" + "=" * 60)
    print("STARTING AGENT 3: LOINC Mapping")
    print("=" * 60)
    print(f"Input mappings: {len(enriched_mappings)}")
    print("   Terms to process:")
    for m in enriched_mappings:
        print(f"     - {m.get('entity')}")

    logs.append("=" * 60)
    logs.append("STARTING AGENT 3: LOINC Mapping")
    logs.append("=" * 60)
    logs.append(f"Input mappings: {len(enriched_mappings)}")
    input_payload = json.dumps(
        [
            {
                "entity": m.get("entity"),
                "negated": bool(m.get("source_assertion_negated") or m.get("negated")),
                "negation_type": m.get("negation_type"),
                "consent_refused": m.get("consent_refused"),
            }
            for m in enriched_mappings
        ],
        indent=2,
    )
    initial_state = {
        "messages": [
            HumanMessage(
                content=(
                    f"{system_prompt}\n\n"
                    f"Context text: {processed_text}\n\n"
                    f"Mappings to review:\n{input_payload}\n\n"
                    "Use the `loinc_lookup` tool only for mappings that appear to be tests, labs, or structured observations. "
                    "After you are done with all needed tool calls, stop calling tools."
                )
            )
        ]
    }
    try:
        graph.invoke(initial_state, config={"recursion_limit": 80})
    except Exception as exc:
        warning = f"LOINC workflow stopped early; preserved mappings will continue downstream: {exc}"
        print(f"⚠ {warning}")
        logs.append(f"STAGE_FAILURE: {warning}")
    print("   > LOINC Agent workflow complete.")
    logs.append("   ✅ LOINC Agent workflow complete.")
    return enriched_mappings, logs, list(_retrieval_traces)


def run_loinc_agent(processed_text: str, mappings: List[dict]) -> List[dict]:
    """Backward-compatible entry point that returns only the enriched mappings."""
    output_mappings, _, _ = run_loinc_agent_langgraph(processed_text, mappings)
    return output_mappings
