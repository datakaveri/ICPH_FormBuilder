"""RxNorm Mapping Agent (Agent 4).

Uses a LangGraph workflow to enrich mappings with RxNorm concepts and allergy
flags when medication-like entities are detected.
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

LOOKUP_CACHE_KEY = "rxnorm_entity_v3_hybrid_k30"
RXNORM_DENSE_TOP_K = int(os.getenv("AGENTIC_RXNORM_DENSE_TOP_K", "30"))
RXNORM_RERANK_CANDIDATE_LIMIT = int(os.getenv("AGENTIC_RXNORM_RERANK_CANDIDATE_LIMIT", "12"))


def _normalize_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def _tokenize(value: str) -> list[str]:
    return [token for token in _normalize_text(value).split() if token]


def _rxnorm_score(row, query: str, raw_query: str) -> tuple:
    display = row["display"]
    display_norm = _normalize_text(display)
    query_tokens = set(_tokenize(raw_query))
    display_tokens = set(_tokenize(display))

    exact_display = display_norm == query
    starts_with = display_norm.startswith(query)
    contains_query = query in display_norm
    overlap = len(query_tokens & display_tokens)
    coverage = overlap / max(len(query_tokens), 1)

    return (
        1 if exact_display else 0,
        1 if starts_with else 0,
        1 if contains_query else 0,
        coverage,
        overlap,
        -len(display_tokens),
        row["code"],
    )


try:
    RXNORM_LOOKUP_CSV = get_lookup_path("rxnorm")
    _RXNORM_LOOKUP_CONFIG_ERROR = None
except Exception as exc:
    RXNORM_LOOKUP_CSV = None
    _RXNORM_LOOKUP_CONFIG_ERROR = exc
_rxnorm_lookup_df = None
_retrieval_traces: list[dict] = []


def _record_retrieval_traces_enabled() -> bool:
    return os.environ.get("AGENTIC_RECORD_RETRIEVAL_TRACES", "").strip().lower() in {"1", "true", "yes", "on"}


def _record_rxnorm_trace(entity: str, candidates: list[dict], selected: dict | None) -> None:
    selected_code = selected.get("code") if selected else None
    selected_rank = None
    for idx, candidate in enumerate(candidates, start=1):
        if selected_code and candidate.get("code") == selected_code:
            selected_rank = idx
            break
    _retrieval_traces.append(
        query_trace(
            vocabulary="RxNorm",
            query_text=entity,
            retrieval_backend=f"Local RxNorm lexical lookup + {get_dense_retrieval_backend_label('rxnorm')}",
            retrieval_stage="hybrid_candidate_search",
            candidates=[
                candidate_trace(
                    rank=idx,
                    code=candidate.get("code"),
                    display=candidate.get("display"),
                    extra={
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


class Agent4State(TypedDict):
    messages: list


def _fallback_candidate_without_llm(candidates: list[dict]) -> dict | None:
    for candidate in candidates:
        if candidate.get("retrieval_source") != "dense":
            return candidate
    return None


def _pick_best_candidate_with_llm(entity: str, context: str, candidates: list[dict]) -> dict | None:
    """Use the LLM to choose among a small set of local RxNorm candidates."""
    if not candidates:
        return None
    if len(candidates) == 1 and candidates[0].get("retrieval_source") != "dense":
        return _fallback_candidate_without_llm(candidates)

    prompt = (
        "You are selecting the best RxNorm concept for a clinical entity.\n"
        "Choose the candidate that best preserves the entity meaning in context.\n"
        "Prefer exact ingredient, branded/generic name, strength, and dose-form matches when stated. "
        "Choose null if candidates are only loosely related, represent a different ingredient/product, "
        "or add product details not supported by the entity and context.\n"
        "Return only JSON like {\"selected_code\": \"...\"} or {\"selected_code\": null}.\n\n"
        f"Entity: {entity}\n"
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
        return _fallback_candidate_without_llm(candidates)
    return _fallback_candidate_without_llm(candidates)


def _candidate_row_to_dict(candidate, fallback_entity: str) -> dict:
    get_value = candidate.get if hasattr(candidate, "get") else lambda key, default="": candidate[key] if key in candidate else default
    return {
        "code": get_value("code"),
        "display": get_value("display") or get_value("indexed_term") or fallback_entity,
        "status": get_value("status") or "",
        "indexed_term": get_value("indexed_term") or "",
        "semantic_score": get_value("semantic_score"),
        "retrieval_source": get_value("retrieval_source") or "lexical",
    }


def _dedupe_rxnorm_candidates(candidates: list[dict]) -> list[dict]:
    deduped: list[dict] = []
    seen_codes: set[str] = set()
    for candidate in candidates:
        code = str(candidate.get("code") or "").strip()
        if not code or code in seen_codes:
            continue
        seen_codes.add(code)
        deduped.append(candidate)
    return deduped


def _dense_rxnorm_candidates(entity: str) -> list[dict]:
    rows = search_dense_terminology("rxnorm", entity, RXNORM_DENSE_TOP_K)
    candidates = []
    for row in rows:
        if str(row.get("status") or "").lower() == "obsolete":
            continue
        candidates.append(_candidate_row_to_dict(row, entity))
    return candidates


@tool
def rxnorm_lookup(entity: str, context: str) -> str:
    """Resolve a single entity to an RxNorm concept when applicable."""
    if not entity:
        return json.dumps({"entity": entity, "rxcui": None, "name": None})

    cached = None if _record_retrieval_traces_enabled() else cache.get_stage(LOOKUP_CACHE_KEY, entity)
    if cached:
        return json.dumps(cached)

    lookup_failed = False
    try:
        rxnorm = _query_rxnorm(entity, context)
        if rxnorm:
            result = {
                "entity": entity,
                "rxcui": rxnorm.get("rxcui"),
                "name": rxnorm.get("name"),
                "rxnorm_code": rxnorm.get("rxcui"),
            }
        else:
            result = {"entity": entity, "rxcui": None, "name": entity}
    except Exception as exc:
        lookup_failed = True
        print(f"   RxNorm lookup failed for '{entity}'; leaving it unmapped: {exc}")
        result = {"entity": entity, "rxcui": None, "name": entity}

    retrieval_degraded = not result.get("rxcui") and dense_retrieval_unavailable("rxnorm")
    if retrieval_degraded:
        print("   RxNorm no-match was not cached because dense retrieval is unavailable.")
    if not lookup_failed and not retrieval_degraded:
        cache.put_stage(LOOKUP_CACHE_KEY, entity, result)
    return json.dumps(result)


def _generalize_rxnorm_term(entity: str, context: str = "") -> str:
    """Use an LLM to convert a non-standard medication term into standard RxNorm US generic terminology."""
    prompt = (
        "You are an expert clinical terminology mapper for RxNorm.\n"
        f"The clinical entity '{entity}' (Context: '{context}') could not be found in the local RxNorm database.\n"
        "Please provide the standard US generic medication name for this drug.\n"
        "Return ONLY the standard generic medication name string, nothing else. If you cannot generalize it, return the original entity."
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


def _query_rxnorm(entity: str, context: str = "", tried_generalize: bool = False) -> dict | None:
    """Resolve an RxNorm concept using the local lookup artifact."""
    if not entity or not entity.strip():
        _record_rxnorm_trace(entity, [], None)
        return None

    global _rxnorm_lookup_df
    if _rxnorm_lookup_df is None:
        expected_columns = ["code", "display", "status"]
        try:
            if RXNORM_LOOKUP_CSV is None or not RXNORM_LOOKUP_CSV.exists():
                raise FileNotFoundError(_RXNORM_LOOKUP_CONFIG_ERROR or "lookup CSV is missing")
            df = pd.read_csv(RXNORM_LOOKUP_CSV, dtype=str).fillna("")
            missing_columns = [column for column in expected_columns if column not in df.columns]
            if missing_columns:
                raise ValueError(f"lookup CSV is missing columns: {missing_columns}")
            df = df[~df["status"].str.lower().eq("obsolete")].copy()
            print(f"   RxNorm lookup CSV loaded: {len(df):,} active concepts")
        except Exception as exc:
            print(f"   RxNorm lookup CSV unavailable; dense retrieval will continue: {exc}")
            df = pd.DataFrame(columns=expected_columns)
        df["_display_norm"] = df["display"].map(_normalize_text)
        _rxnorm_lookup_df = df

    query = _normalize_text(entity)
    if not query:
        return None

    exact_matches = _rxnorm_lookup_df[_rxnorm_lookup_df["_display_norm"] == query]
    if not exact_matches.empty:
        ranked_rows = sorted(
            (candidate for _, candidate in exact_matches.iterrows()),
            key=lambda candidate: _rxnorm_score(candidate, query, entity),
            reverse=True,
        )[:5]
        candidates = [_candidate_row_to_dict(candidate, entity) for candidate in ranked_rows]
        selected = _pick_best_candidate_with_llm(entity, context, candidates)
        _record_rxnorm_trace(entity, candidates, selected)
        if not selected:
            return None
        return {"rxcui": selected["code"], "name": selected["display"]}

    matches = _rxnorm_lookup_df[_rxnorm_lookup_df["_display_norm"].str.contains(re.escape(query), regex=True, na=False)]
    if matches.empty:
        dense_candidates = _dense_rxnorm_candidates(entity)
        if dense_candidates:
            candidates = _dedupe_rxnorm_candidates(dense_candidates)[:RXNORM_RERANK_CANDIDATE_LIMIT]
            selected = _pick_best_candidate_with_llm(entity, context, candidates)
            _record_rxnorm_trace(entity, candidates, selected)
            if selected:
                return {"rxcui": selected["code"], "name": selected["display"]}
        if not tried_generalize:
            generalized = _generalize_rxnorm_term(entity, context)
            if generalized != entity:
                return _query_rxnorm(generalized, context, tried_generalize=True)
        return None

    ranked_rows = sorted(
        (candidate for _, candidate in matches.iterrows()),
        key=lambda candidate: _rxnorm_score(candidate, query, entity),
        reverse=True,
    )[:5]
    lexical_candidates = [_candidate_row_to_dict(candidate, entity) for candidate in ranked_rows]
    dense_candidates = _dense_rxnorm_candidates(entity)
    candidates = _dedupe_rxnorm_candidates([*lexical_candidates, *dense_candidates])[:RXNORM_RERANK_CANDIDATE_LIMIT]
    selected = _pick_best_candidate_with_llm(entity, context, candidates)
    _record_rxnorm_trace(entity, candidates, selected)
    if not selected:
        return None
    return {"rxcui": selected["code"], "name": selected["display"]}


def run_rxnorm_agent_langgraph(processed_text: str, mappings: List[dict]) -> tuple[List[dict], list[str], list[dict]]:
    """Run Agent 4 with LLM-guided tool routing over the mapping list."""
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

    tools = [rxnorm_lookup]
    try:
        llm = load_llm()
        llm_with_tools = llm.bind_tools(tools)
        system_prompt = load_prompt("agent4_system")
    except Exception as exc:
        warning = f"RxNorm routing model unavailable; mappings were left unchanged: {exc}"
        print(f"⚠ {warning}")
        logs.append(f"STAGE_FAILURE: {warning}")
        return enriched_mappings, logs, []
    agent_iterations = [0]

    def agent_node(state: Agent4State) -> Agent4State:
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

    def tool_node(state: Agent4State) -> Agent4State:
        messages = state["messages"]
        last_message = messages[-1]
        tool_results = []
        for tool_call in last_message.tool_calls:
            tool_name = tool_call["name"]
            tool_args = tool_call["args"]
            args_short = ", ".join(f"{k}='{v}'" for k, v in tool_args.items())
            print(f"   > Executing tool: {tool_name}")
            logs.append(f"   🔧 Tool executed: {tool_name}")
            result = rxnorm_lookup.invoke(tool_args)
            try:
                parsed = json.loads(result)
            except Exception:
                parsed = {"entity": tool_args.get("entity"), "rxcui": None, "name": tool_args.get("entity")}
            entity = parsed.get("entity") or tool_args.get("entity") or ""
            idx = entity_index.get(entity)
            if idx is None:
                # Fallback 1: string match
                for i, m in enumerate(enriched_mappings):
                    m_ent = m.get("entity") or m.get("original_entity") or ""
                    if m_ent and entity and (entity.lower() in m_ent.lower() or m_ent.lower() in entity.lower()):
                        idx = i
                        break

            new_code = parsed.get("rxnorm_code") or parsed.get("rxcui")
            new_name = parsed.get("rxnorm_name") or parsed.get("name")

            if idx is None and new_code:
                # Fallback 2: code match
                for i, m in enumerate(enriched_mappings):
                    existing_code = m.get("rxnorm_code")
                    if existing_code and new_code in existing_code:
                        idx = i
                        break

            if idx is not None:
                if new_code:
                    existing = enriched_mappings[idx].get("rxnorm_code")
                    if existing:
                        if new_code not in existing:
                            enriched_mappings[idx]["rxnorm_code"] += f", {new_code}"
                            enriched_mappings[idx]["rxnorm_name"] += f", {new_name}"
                    else:
                        enriched_mappings[idx]["rxnorm_code"] = new_code
                        enriched_mappings[idx]["rxnorm_name"] = new_name
                        
            else:
                if new_code:
                    new_mapping = {
                        "entity": entity,
                        "original_entity": entity,
                        "rxnorm_code": new_code,
                        "rxnorm_name": new_name,
                        "matched_via": "federated_discovery",
                        "confidence": "High",
                    }
                    enriched_mappings.append(new_mapping)
                    entity_index[entity] = len(enriched_mappings) - 1
            logs.append(
                f"   Output: {parsed.get('rxnorm_code') or parsed.get('rxcui') or 'None'} | "
                f"{parsed.get('rxnorm_name') or parsed.get('name') or 'None'}"
            )
            tool_results.append(ToolMessage(content=result, tool_call_id=tool_call["id"]))
        return {"messages": messages + tool_results}

    def should_continue(state: Agent4State) -> Literal["tools", "end"]:
        last_message = state["messages"][-1]
        if hasattr(last_message, "tool_calls") and last_message.tool_calls:
            return "tools"
        return "end"

    workflow = StateGraph(Agent4State)
    workflow.add_node("agent", agent_node)
    workflow.add_node("tools", tool_node)
    workflow.set_entry_point("agent")
    workflow.add_conditional_edges("agent", should_continue, {"tools": "tools", "end": END})
    workflow.add_edge("tools", "agent")
    graph = workflow.compile()

    print("\n" + "=" * 60)
    print("STARTING AGENT 4: RxNorm Mapping")
    print("=" * 60)
    print(f"Input mappings: {len(enriched_mappings)}")
    print("   Terms to process:")
    for m in enriched_mappings:
        print(f"     - {m.get('entity')}")

    logs.append("=" * 60)
    logs.append("STARTING AGENT 4: RxNorm Mapping")
    logs.append("=" * 60)
    logs.append(f"Input mappings: {len(enriched_mappings)}")
    input_payload = json.dumps(
        [{"entity": m.get("entity"), "negated": m.get("negated"), "negation_type": m.get("negation_type"), "consent_refused": m.get("consent_refused"), "is_allergy": m.get("is_allergy"), "allergy_category": m.get("allergy_category")} for m in enriched_mappings],
        indent=2,
    )
    initial_state = {
        "messages": [
            HumanMessage(
                content=(
                    f"{system_prompt}\n\n"
                    f"Context text: {processed_text}\n\n"
                    f"Mappings to review:\n{input_payload}\n\n"
                    "Use the `rxnorm_lookup` tool only for medication-like entities or allergy mentions that should be resolved to RxNorm. "
                    "After you are done with all needed tool calls, stop calling tools."
                )
            )
        ]
    }
    try:
        graph.invoke(initial_state, config={"recursion_limit": 80})
    except Exception as exc:
        warning = f"RxNorm workflow stopped early; preserved mappings will continue downstream: {exc}"
        print(f"⚠ {warning}")
        logs.append(f"STAGE_FAILURE: {warning}")
    print("   > RxNorm Agent workflow complete.")
    logs.append("   ✅ RxNorm Agent workflow complete.")
    return enriched_mappings, logs, list(_retrieval_traces)


def run_rxnorm_agent(processed_text: str, mappings: List[dict]) -> List[dict]:
    """Backward-compatible entry point that returns only the enriched mappings."""
    output_mappings, _, _ = run_rxnorm_agent_langgraph(processed_text, mappings)
    return output_mappings
