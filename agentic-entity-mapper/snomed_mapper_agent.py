"""
SNOMED Mapping Agent (Agent 2)

A LangGraph-based agent that maps medical text to SNOMED CT codes.
The agent autonomously decides which tool to call at each step:

Tools:
    1. search_snomed      – FAISS vector search for candidate retrieval
    2. rerank_candidates   – LLM-based semantic validation of candidates
    3. decompose_entity    – Break complex entities into sub-entities
    4. generalize_entity   – Get standard medical synonym for unmatched terms

Usage:
    from snomed_mapper_agent import run_snomed_agent
    result = run_snomed_agent(input_text)
"""

import os

# These must be set before loading Torch/FAISS/tokenizers on macOS.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")

import json
import re
import time
from difflib import SequenceMatcher
import httpx
import numpy as np
import pandas as pd
import torch
import faiss
from transformers import AutoTokenizer, AutoModel, BertTokenizer, BertModel
from pathlib import Path
from typing import Any, TypedDict, Literal
from langchain_ollama import ChatOllama
from langchain_core.tools import tool
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.graph import StateGraph, END
import warnings
warnings.filterwarnings('ignore')

from prompts import load_prompt, format_prompt
import cache as entity_cache_module
from retrieval_trace import candidate_trace, query_trace
from schema_terminology_assets import (
    get_dense_index_backend,
    get_dense_index_paths,
    get_dense_max_length,
    get_embedding_model_name,
    get_embedding_model_path,
)

# =============================================================================
# Configuration
# =============================================================================
DENSE_INDEX_BACKEND = get_dense_index_backend()
DENSE_EMBEDDING_MODEL = get_embedding_model_name()
_SNOMED_RESOURCE_CONFIG_ERROR = None
try:
    DENSE_INDEX_PATH, METADATA_PATH = get_dense_index_paths("snomed_ct")
except Exception as exc:
    DENSE_INDEX_PATH, METADATA_PATH = None, None
    _SNOMED_RESOURCE_CONFIG_ERROR = exc

LLM_MODEL = os.getenv("LLM_MODEL") or os.getenv("OLLAMA_MODEL", "gpt-oss:20b")
LLM_BASE_URL = os.getenv("LLM_BASE_URL") or os.getenv("OLLAMA_BASE_URL", "http://10.10.17.55:80")
# Local Ollama endpoint alternative. Keep disabled unless explicitly requested.
# LOCAL_LLM_BASE_URL = "http://localhost:11434"
LLM_TIMEOUT = 600          # seconds for each HTTP request to the LLM
LLM_KEEP_ALIVE = "5m"        # unload model from GPU after 5 minutes of inactivity
LLM_RETRIES = 3            # max retry attempts on transient connection errors
LLM_RETRY_BACKOFF = 2      # seconds for initial backoff between retries
LLM_NUM_CTX = int(os.getenv("LLM_NUM_CTX", "8192"))
LLM_NUM_PREDICT = int(os.getenv("LLM_NUM_PREDICT", "8192"))

TOP_K = int(os.getenv("AGENTIC_SNOMED_TOP_K", "10"))
LEXICAL_TOP_K = int(os.getenv("AGENTIC_SNOMED_LEXICAL_TOP_K", "30"))
LEXICAL_MAX_POSTINGS = int(os.getenv("AGENTIC_SNOMED_LEXICAL_MAX_POSTINGS", "50000"))
LEXICAL_FUZZY_MIN_SIMILARITY = float(
    os.getenv("AGENTIC_SNOMED_FUZZY_MIN_SIMILARITY", "0.78")
)
LEXICAL_FUZZY_ALTERNATIVES = int(
    os.getenv("AGENTIC_SNOMED_FUZZY_ALTERNATIVES", "3")
)
LEXICAL_FUZZY_CANDIDATE_LIMIT = int(
    os.getenv("AGENTIC_SNOMED_FUZZY_CANDIDATE_LIMIT", "5000")
)
MAX_DECOMPOSE_CALLS = 3
LANGGRAPH_RECURSION_LIMIT = 80
USE_NATIVE_TOOL_AGENT = os.getenv("AGENTIC_SNOMED_TOOL_AGENT", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}


def _record_retrieval_traces_enabled() -> bool:
    return os.environ.get("AGENTIC_RECORD_RETRIEVAL_TRACES", "").strip().lower() in {"1", "true", "yes", "on"}

# =============================================================================
# Load Resources
# =============================================================================
faiss_index = None
usearch_index = None
turbovec_index = None
metadata_store = None
dense_model = None
dense_tokenizer = None
lexical_token_index = None
lexical_ngram_index = None

torch.set_num_threads(1)
if hasattr(torch, "set_num_interop_threads"):
    torch.set_num_interop_threads(1)
if hasattr(faiss, "omp_set_num_threads"):
    faiss.omp_set_num_threads(1)


def load_resources():
    """Load the selected dense index, metadata, and embedding model."""
    global faiss_index, usearch_index, turbovec_index, metadata_store, dense_model, dense_tokenizer

    if _SNOMED_RESOURCE_CONFIG_ERROR is not None:
        raise RuntimeError(
            f"SNOMED terminology resources are unavailable: {_SNOMED_RESOURCE_CONFIG_ERROR}"
        )

    if DENSE_INDEX_BACKEND == "usearch" and usearch_index is None:
        try:
            from usearch.index import Index
        except ImportError as exc:
            raise RuntimeError("USearch backend selected; install `usearch==2.25.3`.") from exc
        print("Loading USearch index...")
        usearch_index = Index.restore(str(DENSE_INDEX_PATH))
        print(f"   Loaded {len(usearch_index):,} vectors")
    elif DENSE_INDEX_BACKEND == "turbovec" and turbovec_index is None:
        try:
            from turbovec import IdMapIndex
        except ImportError as exc:
            raise RuntimeError("TurboVec backend selected; install `turbovec==0.8.0`.") from exc
        print("Loading TurboVec index...")
        turbovec_index = IdMapIndex.load(str(DENSE_INDEX_PATH))
        print(f"   Loaded {len(turbovec_index):,} vectors")
    elif DENSE_INDEX_BACKEND == "faiss" and faiss_index is None:
        print("Loading FAISS index...")
        faiss_index = faiss.read_index(str(DENSE_INDEX_PATH))
        print(f"   Loaded {faiss_index.ntotal:,} vectors")

    if metadata_store is None:
        print("Loading metadata...")
        metadata_store = pd.read_pickle(METADATA_PATH)
        if isinstance(metadata_store, dict):
            concepts = metadata_store.get("concepts", [])
            conceptid_to_fsn = metadata_store.get("conceptid_to_fsn", {})
            print(
                "   Loaded metadata dict with "
                f"{len(concepts):,} indexed terms and {len(conceptid_to_fsn):,} concepts"
            )
        else:
            print(f"   Loaded {len(metadata_store):,} rows")

    if dense_model is None:
        print(f"Loading {DENSE_EMBEDDING_MODEL} model...")
        model_name = str(get_embedding_model_path())
        try:
            dense_tokenizer = AutoTokenizer.from_pretrained(model_name)
            dense_model = AutoModel.from_pretrained(model_name)
        except ValueError as exc:
            if "model_type" not in str(exc):
                raise
            dense_tokenizer = BertTokenizer.from_pretrained(model_name)
            dense_model = BertModel.from_pretrained(model_name)
        dense_model.eval()
        print("   Model loaded!")

    active_index = {"faiss": faiss_index, "usearch": usearch_index, "turbovec": turbovec_index}[DENSE_INDEX_BACKEND]
    return active_index, metadata_store, dense_model, dense_tokenizer


def _candidate_from_metadata(idx: int) -> dict | None:
    """Resolve a FAISS result index into SNOMED candidate metadata."""
    _, metadata, _, _ = load_resources()

    if isinstance(metadata, dict):
        concepts = metadata.get("concepts")
        terms = metadata.get("terms", [])
        conceptid_to_fsn = metadata.get("conceptid_to_fsn", {})
        if not isinstance(concepts, list) or idx < 0 or idx >= len(concepts):
            return None
        concept_id = str(concepts[idx])
        indexed_term = terms[idx] if isinstance(terms, list) and idx < len(terms) else ""
        fsn = conceptid_to_fsn.get(concept_id)
        if fsn is None:
            try:
                fsn = conceptid_to_fsn.get(int(concept_id))
            except (TypeError, ValueError):
                fsn = None
        if fsn is None:
            fsn = concept_id
        return {
            "concept_id": concept_id,
            "term": str(indexed_term or fsn),
            "fsn": str(fsn),
            "top_hierarchy": "",
        }

    if idx < 0 or idx >= len(metadata):
        return None

    row = metadata.iloc[idx]
    return {
        "concept_id": str(row["concept_id"]),
        "term": str(row.get("term", row.get("label", row["fsn"]))),
        "fsn": str(row["fsn"]),
        "top_hierarchy": str(row.get("top_hierarchy", "")),
    }


def _normalize_lexical_tokens(text: str) -> list[str]:
    """Tokenize terminology/query text for generic lexical candidate retrieval."""
    tokens = re.findall(r"[a-z0-9]+", str(text or "").lower())
    # Two-character words can carry decisive terminology meaning. Discarding
    # every short token collapses distinct phrases before retrieval. Very common
    # tokens remain controlled by LEXICAL_MAX_POSTINGS in the caller.
    return [token for token in tokens if len(token) >= 2 or token.isdigit()]


def _load_lexical_token_index(metadata: Any) -> dict[str, list[int]]:
    """Build a lightweight token-to-row index over the local SNOMED descriptions."""
    global lexical_token_index
    if lexical_token_index is not None:
        return lexical_token_index

    print("Building SNOMED lexical token index...")
    index: dict[str, list[int]] = {}

    if isinstance(metadata, dict):
        terms = metadata.get("terms", [])
        iterable = enumerate(terms if isinstance(terms, list) else [])
    else:
        label_column = "term" if "term" in metadata.columns else "fsn"
        iterable = ((int(i), value) for i, value in metadata[label_column].items())

    for idx, term in iterable:
        for token in set(_normalize_lexical_tokens(str(term))):
            index.setdefault(token, []).append(int(idx))

    lexical_token_index = index
    print(f"   Built lexical index with {len(index):,} unique tokens")
    return lexical_token_index


def _character_ngrams(token: str, size: int = 3) -> set[str]:
    padded = f"^{str(token or '').lower()}$"
    if len(padded) <= size:
        return {padded}
    return {padded[index:index + size] for index in range(len(padded) - size + 1)}


def _load_lexical_ngram_index(token_index: dict[str, list[int]]) -> dict[str, list[str]]:
    """Index vocabulary tokens by character n-grams for spelling-tolerant lookup."""
    global lexical_ngram_index
    if lexical_ngram_index is not None:
        return lexical_ngram_index

    index: dict[str, list[str]] = {}
    for token in token_index:
        for ngram in _character_ngrams(token):
            index.setdefault(ngram, []).append(token)
    lexical_ngram_index = index
    return lexical_ngram_index


def _fuzzy_lexical_tokens(
    query_token: str,
    token_index: dict[str, list[int]],
) -> list[tuple[str, float]]:
    """Return nearby vocabulary tokens without a curated correction dictionary."""
    if len(query_token) < 4 or query_token in token_index:
        return []

    ngram_index = _load_lexical_ngram_index(token_index)
    shared_counts: dict[str, int] = {}
    for ngram in _character_ngrams(query_token):
        for candidate in ngram_index.get(ngram, []):
            shared_counts[candidate] = shared_counts.get(candidate, 0) + 1

    length_tolerance = max(2, round(len(query_token) * 0.35))
    shortlist = [
        candidate
        for candidate, _ in sorted(
            shared_counts.items(),
            key=lambda item: (-item[1], abs(len(item[0]) - len(query_token)), item[0]),
        )[:LEXICAL_FUZZY_CANDIDATE_LIMIT]
        if abs(len(candidate) - len(query_token)) <= length_tolerance
    ]
    scored = [
        (candidate, SequenceMatcher(None, query_token, candidate).ratio())
        for candidate in shortlist
    ]
    return [
        (candidate, similarity)
        for candidate, similarity in sorted(scored, key=lambda item: (-item[1], item[0]))
        if similarity >= LEXICAL_FUZZY_MIN_SIMILARITY
    ][:LEXICAL_FUZZY_ALTERNATIVES]


def _lexical_snomed_candidates(entity: str, metadata: Any, limit: int = LEXICAL_TOP_K) -> list[dict]:
    """Retrieve SNOMED candidates by generic terminology-text overlap."""
    query_tokens = set(_normalize_lexical_tokens(entity))
    if not query_tokens:
        return []

    token_index = _load_lexical_token_index(metadata)
    row_overlap: dict[int, float] = {}
    fuzzy_rows: set[int] = set()
    for token in query_tokens:
        postings = token_index.get(token, [])
        if postings and len(postings) <= LEXICAL_MAX_POSTINGS:
            for idx in postings:
                row_overlap[idx] = row_overlap.get(idx, 0.0) + 1.0
            continue

        fuzzy_row_scores: dict[int, float] = {}
        for nearby_token, similarity in _fuzzy_lexical_tokens(token, token_index):
            nearby_postings = token_index.get(nearby_token, [])
            if len(nearby_postings) > LEXICAL_MAX_POSTINGS:
                continue
            for idx in nearby_postings:
                fuzzy_row_scores[idx] = max(fuzzy_row_scores.get(idx, 0.0), similarity)
        for idx, similarity in fuzzy_row_scores.items():
            row_overlap[idx] = row_overlap.get(idx, 0.0) + similarity
            fuzzy_rows.add(idx)

    if not row_overlap:
        return []

    query_norm = " ".join(sorted(query_tokens))
    scored: list[tuple[float, dict]] = []
    for idx, overlap in sorted(row_overlap.items(), key=lambda item: item[1], reverse=True)[:3000]:
        row = _candidate_from_metadata(idx)
        if row is None:
            continue
        term_tokens = set(_normalize_lexical_tokens(f"{row['term']} {row['fsn']}"))
        if not term_tokens:
            continue
        term_norm = " ".join(sorted(term_tokens))
        coverage = overlap / max(len(query_tokens), 1)
        specificity = 1.0 / (len(term_tokens) + 1)
        lexical_score = float(overlap) + (coverage * 3.0) + specificity
        if query_tokens.issubset(term_tokens):
            lexical_score += 2.0
        if term_tokens.issubset(query_tokens):
            lexical_score += 1.0
        if query_norm == term_norm:
            lexical_score += 4.0
        elif query_norm and (query_norm in term_norm or term_norm in query_norm):
            lexical_score += 1.0

        scored.append((lexical_score, {
            "concept_id": str(row["concept_id"]),
            "term": row["term"],
            "fsn": row["fsn"],
            "top_hierarchy": row["top_hierarchy"],
            "similarity_score": round(min(0.999, 0.45 + lexical_score / (lexical_score + 8.0)), 3),
            "retrieval_source": "lexical_fuzzy" if idx in fuzzy_rows else "lexical",
        }))

    deduped: dict[str, tuple[float, dict]] = {}
    for score, candidate in sorted(scored, key=lambda item: item[0], reverse=True):
        concept_id = candidate["concept_id"]
        if concept_id not in deduped:
            deduped[concept_id] = (score, candidate)
        if len(deduped) >= limit:
            break

    return [candidate for _, candidate in deduped.values()]


def _unique_exact_terminology_candidate(entity: str, candidates: list[dict]) -> dict | None:
    """Return one unambiguous exact terminology-label match, if present."""
    entity_tokens = _normalize_lexical_tokens(entity)
    if not entity_tokens:
        return None

    def label_matches_source(label: Any) -> bool:
        """Match a terminology label across a simple singular/plural inflection.

        Terminology descriptions commonly store a singular preferred term while
        clinical prose uses its regular plural. This remains deliberately
        conservative: every token must match and only a terminal ``s`` may
        differ. Semantic synonyms still require normal reranking.
        """
        label_tokens = _normalize_lexical_tokens(str(label or ""))
        if label_tokens == entity_tokens:
            return True
        if len(label_tokens) != len(entity_tokens) or not label_tokens:
            return False
        if label_tokens[:-1] != entity_tokens[:-1]:
            return False
        source_last = entity_tokens[-1]
        label_last = label_tokens[-1]
        return bool(
            len(source_last) >= 4
            and len(label_last) >= 4
            and (
                source_last == f"{label_last}s"
                or label_last == f"{source_last}s"
            )
        )

    exact_by_concept: dict[str, dict] = {}
    for candidate in candidates:
        concept_id = str(candidate.get("concept_id") or "").strip()
        if not concept_id:
            continue
        labels = [candidate.get("term"), candidate.get("fsn")]
        if any(label_matches_source(label) for label in labels if label):
            exact_by_concept.setdefault(concept_id, candidate)

    if len(exact_by_concept) != 1:
        return None
    return next(iter(exact_by_concept.values()))


def _exact_terminology_match_is_terminal(
    exact_candidate: dict | None,
    item: dict,
    *,
    search_entity: str,
    original_entity: str,
) -> bool:
    """Allow exact-match bypass only when no semantic context needs review.

    A generated alias can exactly match a terminology label while dropping
    negation or another meaning-changing qualifier. Therefore an exact label
    reached from a context-bearing source must still pass semantic reranking.
    """
    exact_source_search = _entity_merge_key(search_entity) == _entity_merge_key(
        original_entity
    )
    return bool(
        exact_candidate is not None
        and (
            not _has_context_marker(item)
            or (
                exact_source_search
                and item.get("terminology_context_changes_meaning") is False
            )
        )
    )


def get_embedding(text: str) -> np.ndarray:
    """Get SapBERT embedding for a text string."""
    _, _, model, tokenizer = load_resources()

    inputs = tokenizer(
        text,
        return_tensors="pt",
        padding=True,
        truncation=True,
        max_length=get_dense_max_length()
    )

    with torch.no_grad():
        outputs = model(**inputs)
        embedding = outputs.last_hidden_state[:, 0, :].numpy()

    embedding = embedding.astype("float32")
    norm = np.linalg.norm(embedding, axis=1, keepdims=True)
    norm[norm == 0] = 1.0
    return embedding / norm


# =============================================================================
# Initialize LLM (lazy)
# =============================================================================
snomed_llm = None


def get_snomed_llm():
    """Return the SNOMED LLM, initialising on first call."""
    global snomed_llm
    if snomed_llm is None:
        snomed_llm = ChatOllama(
            model=LLM_MODEL,
            base_url=LLM_BASE_URL,
            temperature=0,
            keep_alive=LLM_KEEP_ALIVE,
            num_ctx=LLM_NUM_CTX,
            num_predict=LLM_NUM_PREDICT,
            client_kwargs={"timeout": LLM_TIMEOUT},
        )
        print("SNOMED LLM configured!")
    return snomed_llm


def resilient_llm_invoke(llm, messages, *, retries=LLM_RETRIES):
    """Invoke the LLM with automatic retry on transient connection errors."""
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            return llm.invoke(messages)
        except Exception as exc:
            last_error = exc
            error_text = str(exc)
            if "error parsing tool call" in error_text or "unexpected end of JSON input" in error_text:
                print(f"   ⚠ LLM tool-call parsing failed; switching to fallback mapping: {exc}")
                raise
            wait = LLM_RETRY_BACKOFF * attempt
            print(f"   \u26a0 LLM connection/parsing error (attempt {attempt}/{retries}): {exc}")
            print(f"     Retrying in {wait}s...")
            time.sleep(wait)
    raise last_error


def _extract_json_object(response_text: str) -> Any:
    """Extract the first complete JSON object/array from an LLM response."""
    text = str(response_text or "").strip()
    if "</think>" in text:
        text = text.split("</think>")[-1].strip()

    markdown_match = re.search(r"```(?:json)?(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if markdown_match:
        text = markdown_match.group(1).strip()

    if not text:
        raise ValueError("LLM returned empty response")

    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        start_idx = text.find("{")
        if start_idx == -1:
            raise

        depth = 0
        in_string = False
        escape = False
        end_idx = -1
        for index, char in enumerate(text[start_idx:], start=start_idx):
            if escape:
                escape = False
                continue
            if char == "\\":
                escape = True
                continue
            if char == '"':
                in_string = not in_string
                continue
            if in_string:
                continue
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    end_idx = index
                    break

        if end_idx == -1:
            raise ValueError("LLM JSON object was truncated")
        payload = json.loads(text[start_idx : end_idx + 1])

    if not isinstance(payload, (dict, list)):
        raise ValueError("LLM JSON root must be an object or array")
    return payload


def _listify_text_values(value: Any) -> list[str]:
    if isinstance(value, list):
        values = value
    elif isinstance(value, str):
        values = [value]
    else:
        return []
    return [
        re.sub(r"\s+", " ", str(item)).strip(" \n\t-.,;:")
        for item in values
        if str(item).strip()
    ]


def _entity_text(item: dict) -> str:
    value = item.get("entity")
    if isinstance(value, str) and value.strip():
        return value.strip()
    scalar_values = [
        value.strip()
        for value in item.values()
        if isinstance(value, str) and value.strip()
    ]
    if len(scalar_values) == 1:
        return scalar_values[0]
    return ""


def _has_explicit_entity(item: dict) -> bool:
    value = item.get("entity")
    return isinstance(value, str) and bool(value.strip())


def _boolean_from_aliases(item: dict, keys: tuple[str, ...]) -> bool:
    for key in keys:
        value = item.get(key)
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.strip().lower() in {"true", "yes", "present"}:
            return True
    return False


def _context_flags_from_item(item: dict) -> dict[str, bool]:
    """Collect all true boolean model fields as generic context flags."""
    if not isinstance(item, dict):
        return {}
    return {
        str(key): True
        for key, value in item.items()
        if isinstance(value, bool) and value
    }


def _coerce_entity_payload(payload: Any) -> list[Any]:
    """Recover entity lists from nested JSON shapes without container-name rules."""
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []

    for value in payload.values():
        if isinstance(value, list) and any(isinstance(item, (dict, str)) for item in value):
            return value
        nested = _coerce_entity_payload(value)
        if nested:
            return nested
    return []


def _compact_entity_field(value: Any, *, max_chars: int = 1200) -> Any:
    """Preserve model-produced entity fields without a fixed field-name list."""
    if value in (None, "", [], {}):
        return None
    if isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        return text if len(text) <= max_chars else text[:max_chars]
    if isinstance(value, list):
        compacted = []
        for item in value:
            compact_item = _compact_entity_field(item, max_chars=max_chars)
            if compact_item not in (None, "", [], {}):
                compacted.append(compact_item)
        return compacted or None
    if isinstance(value, dict):
        compacted = {}
        for key, item in value.items():
            compact_item = _compact_entity_field(item, max_chars=max_chars)
            if compact_item not in (None, "", [], {}):
                compacted[str(key)] = compact_item
        if not compacted:
            return None
        if len(json.dumps(compacted, default=str, ensure_ascii=False)) > max_chars:
            return None
        return compacted
    text = str(value).strip()
    if not text:
        return None
    return text if len(text) <= max_chars else text[:max_chars]


def _coerce_entity_item(item: Any) -> dict | None:
    """Normalize one model-produced entity item into the pipeline's schema."""
    if isinstance(item, str):
        item = {"entity": item}
    if not isinstance(item, dict):
        return None

    entity = _entity_text(item)
    if not entity:
        return None

    search_terms = _listify_text_values(item.get("ontology_search_terms"))
    if not search_terms:
        search_terms.append(entity)

    normalized = {}
    for key, value in item.items():
        compact_value = _compact_entity_field(value)
        if compact_value not in (None, "", [], {}):
            normalized[str(key)] = compact_value

    context_flags = _context_flags_from_item(item)

    normalized["entity"] = entity
    normalized["ontology_search_terms"] = list(dict.fromkeys(search_terms))
    if context_flags:
        normalized["context_flags"] = context_flags
    return normalized


def _collect_entity_items(payload: Any, depth: int = 0) -> list[Any]:
    """Collect entity-like items from nested model JSON without clinical assumptions."""
    if depth > 8:
        return []

    if isinstance(payload, str):
        stripped = payload.strip()
        if stripped.startswith(("{", "[")):
            try:
                return _collect_entity_items(json.loads(stripped), depth + 1)
            except Exception:
                pass
        return [payload] if stripped else []

    if isinstance(payload, list):
        collected = []
        for item in payload:
            if _coerce_entity_item(item) is not None:
                collected.append(item)
            else:
                collected.extend(_collect_entity_items(item, depth + 1))
        return collected

    if isinstance(payload, dict):
        if _has_explicit_entity(payload) and _coerce_entity_item(payload) is not None:
            return [payload]

        collected = []
        for key, value in payload.items():
            if isinstance(value, (dict, list)):
                collected.extend(_collect_entity_items(value, depth + 1))
            elif isinstance(value, str) and value.strip().startswith(("{", "[")):
                collected.extend(_collect_entity_items(value, depth + 1))
        if collected:
            return collected

        if _coerce_entity_item(payload) is not None:
            return [payload]
        return collected

    return []


def _entity_items_from_payload(payload: Any) -> list[Any]:
    direct_items = _coerce_entity_payload(payload)
    collected = _collect_entity_items(direct_items)
    if collected:
        return collected
    return _collect_entity_items(payload)


def _ontology_search_terms_from_item(item: dict, entity: str) -> list[str]:
    """Return search terms without using broad fallbacks before direct search.

    Plain entities start with only the extracted text. Context-bearing entities
    with explicit boolean context flags can use model-supplied context-preserving
    terms first, then the base entity as the final fallback.
    """
    entity = str(entity or "").strip()
    if not entity:
        return []
    if not isinstance(item, dict) or not _uses_contextual_search_terms(item):
        return [entity]

    # The extraction/review contract already orders these from the complete,
    # context-preserving meaning to the positive/base fallback. Preserve that
    # semantic order: token-overlap reordering can move a positive fallback
    # ahead of an exact absent/refused/otherwise qualified terminology term.
    raw_terms = _listify_text_values(item.get("ontology_search_terms"))
    return list(dict.fromkeys([*raw_terms, entity]))


def _search_term_is_base_fallback(item: Any, entity: str, search_term: str) -> bool:
    """Return true when a search term is the base entity/fallback for context."""
    if not isinstance(item, dict) or not _uses_contextual_search_terms(item):
        return False
    plan = _ontology_search_terms_from_item(item, entity)
    if not plan:
        return False
    search_key = _entity_merge_key(search_term)
    final_key = _entity_merge_key(plan[-1])
    entity_key = _entity_merge_key(entity)
    if not search_key or search_key != final_key:
        return False
    if (
        search_key == entity_key
        and item.get("entity_text_encodes_terminology_context") is True
    ):
        return False
    return True


def _merge_model_item_fields(mapping: dict, item: Any) -> dict:
    """Carry model-produced structured fields without a fixed clinical field list."""
    if not isinstance(mapping, dict) or not isinstance(item, dict):
        return mapping

    reserved_fields = {
        "entity",
        "original_entity",
        "ontology_search_terms",
        "context_flags",
    }
    for key, value in item.items():
        if key in reserved_fields:
            continue
        compact_value = _compact_entity_field(value)
        if compact_value in (None, "", [], {}):
            continue
        if mapping.get(str(key)) in (None, "", [], {}):
            mapping[str(key)] = compact_value
    return mapping


def _json_capable_llms(base_llm) -> list[tuple[str, Any]]:
    llms: list[tuple[str, Any]] = []
    try:
        llms.append(("json", base_llm.bind(format="json")))
    except Exception:
        pass
    llms.append(("plain", base_llm))
    return llms


def _invoke_ollama_generate_prompt(prompt: str, label: str, *, json_mode: bool) -> dict:
    """Fallback around chat-template issues that can return empty AIMessage content."""
    payload: dict[str, Any] = {
        "model": LLM_MODEL,
        "prompt": prompt,
        "stream": False,
        "keep_alive": LLM_KEEP_ALIVE,
        "options": {
            "temperature": 0,
            "num_ctx": LLM_NUM_CTX,
            "num_predict": LLM_NUM_PREDICT,
        },
    }
    if json_mode:
        payload["format"] = "json"

    mode = "direct-generate-json" if json_mode else "direct-generate"
    print(f"   {label} LLM call ({mode} mode)...")
    response = httpx.post(
        f"{LLM_BASE_URL.rstrip('/')}/api/generate",
        json=payload,
        timeout=httpx.Timeout(LLM_TIMEOUT, connect=30.0),
    )
    response.raise_for_status()
    response_payload = response.json()
    response_text = str(response_payload.get("response") or "").strip()
    print(f"   {label} response length ({mode} mode): {len(response_text)} chars")
    if not response_text:
        raise ValueError(f"LLM returned empty response in {mode} mode")
    return _extract_json_object(response_text)


def _invoke_json_prompt(base_llm, prompt: str, label: str) -> dict:
    last_error: Exception | None = None
    for json_mode in (False, True):
        try:
            return _invoke_ollama_generate_prompt(prompt, label, json_mode=json_mode)
        except Exception as exc:
            last_error = exc
            mode = "direct-generate-json" if json_mode else "direct-generate"
            print(f"   {label} failed in {mode} mode: {exc}")

    for mode, candidate_llm in _json_capable_llms(base_llm):
        try:
            print(f"   {label} LLM call ({mode} mode)...")
            response = resilient_llm_invoke(candidate_llm, [HumanMessage(content=prompt)])
            response_text = str(response.content or "").strip()
            print(f"   {label} response length ({mode} mode): {len(response_text)} chars")
            if not response_text:
                raise ValueError(f"LLM returned empty response in {mode} mode")
            return _extract_json_object(response_text)
        except Exception as exc:
            last_error = exc
            print(f"   {label} failed in {mode} mode: {exc}")

    if last_error:
        raise last_error
    raise ValueError("No LLM invocation modes were available")


def _has_context_marker(item: dict) -> bool:
    """Detect model-supplied context markers without enumerating clinical contexts."""
    if not isinstance(item, dict):
        return False
    meaning_changes = item.get("terminology_context_changes_meaning")
    if meaning_changes is True:
        return True
    qualifiers = item.get("context_qualifiers")
    if isinstance(qualifiers, list) and any(str(value).strip() for value in qualifiers):
        return True
    flags = item.get("context_flags")
    if isinstance(flags, dict) and any(bool(value) for value in flags.values()):
        return True
    return any(isinstance(value, bool) and value for value in item.values())


def _uses_contextual_search_terms(item: dict) -> bool:
    """Use alternate terms only when structured context changes terminology meaning."""
    if not isinstance(item, dict):
        return False
    meaning_changes = item.get("terminology_context_changes_meaning")
    if meaning_changes is False:
        # The semantic review explicitly determined that assertion/context is
        # external to the terminology concept. Do not let the mere presence of
        # a true context Boolean override that decision and replace the source
        # referent with a generated alias.
        return False
    if meaning_changes is True:
        return True
    flags = item.get("context_flags")
    if isinstance(flags, dict) and any(bool(value) for value in flags.values()):
        return True
    return any(isinstance(value, bool) and value for value in item.values())


def _source_term_allows_external_context(
    item: Any,
    *,
    entity: str,
    search_term: str,
) -> bool:
    """Return true when structured context should remain outside terminology."""
    if not isinstance(item, dict):
        return False
    return bool(
        _entity_merge_key(entity) == _entity_merge_key(search_term)
        and item.get("terminology_context_changes_meaning") is False
        and item.get("entity_text_encodes_terminology_context") is not True
    )


def _review_contextual_search_terms(llm, text: str, entities: list[dict]) -> list[dict]:
    """Ask the model to repair context-bearing search terms without generating them in code."""
    review_prompt = (
        "Review the extracted entity JSON against the original note.\n"
        "Return the same JSON shape with the same entity objects, unless an object is clearly malformed.\n"
        "Do not add facts that are not in the note. Do not use fixed phrase templates or example vocabulary.\n"
        "For every item, set terminology_context_changes_meaning to true only when the source assertion or "
        "another grounded qualifier changes which terminology concept should be searched; otherwise set it "
        "to false. Set entity_text_encodes_terminology_context to true only when the entity wording itself "
        "expresses the complete meaning-changing context; otherwise set it to false. Put grounded context "
        "signals in a context_flags object without using a closed flag list. "
        "Resolve assertion scope from the full sentence meaning and syntax, not merely from token distance "
        "or the nearest context word. A shared assertion over coordinated entities must be applied to each "
        "entity it semantically governs, including when the governing phrase is distant. Stop propagation "
        "when a clause boundary, contrast, or new explicit assertion changes the scope. Do not apply context "
        "to unrelated entities that only happen to occur later. Set source_assertion_negated independently "
        "for every entity. These are general scope principles, not phrase templates. "
        "When terminology_context_changes_meaning is true, ensure the "
        "entity and especially the FIRST ontology_search_terms value preserve the clinical context expressed "
        "by the note. "
        "Use concise terminology-style wording for search terms; remove intensifiers and source-note wording "
        "that does not change the ontology concept. "
        "For context-bearing concepts, rewrite source phrasing into ontology-style meaning that preserves "
        "absence, refusal, experiencer, uncertainty, temporality, and other meaning-changing context. "
        "Use terminology-style wording rather than copying trigger wording from the note. "
        "The base clinical term may appear later as a fallback search term, but not first when the context "
        "changes the meaning.\n"
        "For coordinated lists under one shared context, each listed item must independently preserve that "
        "shared context in its first search term.\n"
        "Return ONLY valid JSON in the same format: {\"entities\":[...]}.\n\n"
        f"Original note:\n{text}\n\n"
        f"Extracted JSON to review:\n{json.dumps({'entities': entities}, ensure_ascii=False)}"
    )

    try:
        payload = _invoke_json_prompt(llm, review_prompt, "Entity extraction context-term review")
        reviewed = _entity_items_from_payload(payload)
        if isinstance(reviewed, list) and reviewed:
            normalized = [_coerce_entity_item(item) for item in reviewed]
            return [item for item in normalized if isinstance(item, dict)]
    except Exception as exc:
        print(f"   Entity extraction context-term review skipped after error: {exc}")

    return entities


def _expand_missing_contextual_search_terms(
    llm,
    text: str,
    item: dict,
    search_terms: list[str],
    *,
    force: bool = False,
) -> list[str]:
    """Generate a small context-preserving search set when extraction omitted it."""
    if not isinstance(item, dict) or (not force and not _uses_contextual_search_terms(item)):
        return search_terms

    entity = str(item.get("entity") or "").strip()
    entity_key = _entity_merge_key(entity)
    if any(
        _entity_merge_key(term) and _entity_merge_key(term) != entity_key
        for term in search_terms
    ):
        return search_terms

    prompt = (
        "Generate at most three concise terminology search terms for the complete asserted meaning of "
        "this one entity in its note context. The terms must preserve every meaning-changing context "
        "already grounded in the entity JSON. Return semantic equivalents, not decomposed parts, broader "
        "positive concepts, note trigger wording, or newly invented facts. Do not repeat the base entity; "
        "the caller adds it later as the final fallback. Return ONLY JSON as "
        "{\"search_terms\":[\"string\"]}.\n\n"
        f"Note:\n{text}\n\n"
        f"Entity JSON:\n{json.dumps(item, ensure_ascii=False, default=str)}"
    )
    try:
        payload = _invoke_json_prompt(llm, prompt, "Context-preserving terminology expansion")
        expanded = _listify_text_values(
            payload.get("search_terms") if isinstance(payload, dict) else None
        )[:3]
    except Exception as exc:
        print(f"   Context-preserving terminology expansion skipped after error: {exc}")
        return search_terms

    contextual = [
        term
        for term in expanded
        if _entity_merge_key(term) and _entity_merge_key(term) != entity_key
    ]
    return list(dict.fromkeys([*contextual, *search_terms]))


def _payload_preview(payload: Any, limit: int = 500) -> str:
    try:
        preview = json.dumps(payload, ensure_ascii=False, default=str)
    except Exception:
        preview = str(payload)
    return re.sub(r"\s+", " ", preview).strip()[:limit]


def _normalize_extracted_entities_payload(payload: Any, llm, text: str) -> list[dict]:
    direct_entities = _coerce_entity_payload(payload)
    entities = _entity_items_from_payload(payload)
    payload_keys = list(payload.keys()) if isinstance(payload, dict) else [type(payload).__name__]
    print(
        f"   Entity extraction parsed payload keys: {payload_keys}; "
        f"direct items: {len(direct_entities)}; collected items: {len(entities)}"
    )
    if not isinstance(entities, list):
        return []

    entities = _review_contextual_search_terms(llm, text, entities)

    cleaned = []
    seen = set()
    for raw_item in entities:
        item = _coerce_entity_item(raw_item)
        if item is None:
            preview = json.dumps(raw_item, ensure_ascii=False, default=str)[:250]
            print(f"   Entity extraction dropped unrecognized item: {preview}")
            continue

        entity = item["entity"]
        if not isinstance(entity, str):
            continue

        value = re.sub(r"\s+", " ", entity).strip(" \n\t-.,;:")
        if len(value) < 3:
            continue

        key = value.lower()
        if key in seen:
            continue
        seen.add(key)

        normalized_item = dict(item)
        normalized_item["entity"] = value
        normalized_item["ontology_search_terms"] = _listify_text_values(item.get("ontology_search_terms"))
        context_flags = {
            **(
                item.get("context_flags")
                if isinstance(item.get("context_flags"), dict)
                else {}
            ),
            **_context_flags_from_item(item),
        }
        if context_flags:
            normalized_item["context_flags"] = context_flags
        cleaned.append(normalized_item)
    print(f"   Entity extraction normalized entities: {len(cleaned)}")
    if not cleaned:
        print(f"   Entity extraction unusable payload preview: {_payload_preview(payload)}")
    return cleaned


def _entity_merge_key(entity: str) -> str:
    tokens = re.findall(r"[a-z0-9]+", str(entity or "").lower())
    return " ".join(tokens)


def _merge_extracted_entities(entity_lists: list[list[dict]]) -> list[dict]:
    merged: dict[str, dict] = {}
    order: list[str] = []

    def merge_value(existing: dict, key: str, value: Any) -> None:
        if value in (None, "", [], {}):
            return
        current = existing.get(key)
        if isinstance(current, bool) or isinstance(value, bool):
            existing[key] = bool(current) or bool(value)
        elif isinstance(current, list) or isinstance(value, list):
            current_items = current if isinstance(current, list) else ([current] if current not in (None, "", [], {}) else [])
            value_items = value if isinstance(value, list) else [value]
            combined = []
            seen_items = set()
            for item in [*current_items, *value_items]:
                try:
                    signature = json.dumps(
                        item,
                        sort_keys=True,
                        ensure_ascii=False,
                        default=str,
                    )
                except (TypeError, ValueError):
                    signature = repr(item)
                if signature in seen_items:
                    continue
                seen_items.add(signature)
                combined.append(item)
            existing[key] = combined
        elif isinstance(current, dict) and isinstance(value, dict):
            existing[key] = {**current, **value}
        elif current in (None, "", [], {}):
            existing[key] = value

    for entities in entity_lists:
        for item in entities:
            if not isinstance(item, dict):
                continue
            entity = str(item.get("entity") or "").strip()
            key = _entity_merge_key(entity)
            if not key:
                continue
            if key not in merged:
                merged[key] = dict(item)
                order.append(key)
                continue

            existing = merged[key]
            existing_terms = _listify_text_values(existing.get("ontology_search_terms"))
            new_terms = _listify_text_values(item.get("ontology_search_terms"))
            existing["ontology_search_terms"] = list(dict.fromkeys([*existing_terms, *new_terms, entity]))

            existing_context = _listify_text_values(existing.get("context_qualifiers"))
            new_context = _listify_text_values(item.get("context_qualifiers"))
            existing["context_qualifiers"] = list(dict.fromkeys([*existing_context, *new_context]))

            existing_flags = (
                existing.get("context_flags")
                if isinstance(existing.get("context_flags"), dict)
                else {}
            )
            new_flags = item.get("context_flags") if isinstance(item.get("context_flags"), dict) else {}
            existing["context_flags"] = {**existing_flags, **new_flags, **_context_flags_from_item(item)}

            for field, value in item.items():
                if field in {"entity", "ontology_search_terms", "context_qualifiers", "context_flags"}:
                    continue
                merge_value(existing, field, value)

    return [merged[key] for key in order]


def _consolidate_extracted_entities_with_llm(
    llm,
    text: str,
    entities: list[dict],
    *,
    label: str,
) -> list[dict]:
    """Consolidate duplicate extraction variants without clinical term rules."""
    if len(entities) < 2:
        return entities

    prompt = (
        "Consolidate extracted entity candidates for ontology mapping.\n"
        "Return one canonical entity object for each distinct clinical/FHIR-relevant fact in the note. "
        "Merge duplicates, synonyms, plural/singular variants, alternate phrasings, and base/fallback "
        "forms only when they represent the same real-world fact with the same subject and context. "
        "Keep the most meaning-specific entity wording and ontology_search_terms first, especially "
        "when context changes the meaning. "
        "Preserve each fact's independently resolved source assertion. Never merge facts whose assertion, "
        "experiencer, temporality, certainty, or other meaning-changing context differs. "
        "Do not upgrade intensifiers into reaction, severity, complication, or outcome concepts unless "
        "that reaction or outcome is explicitly stated in the note. "
        "Do not keep both a context-specific fact and its base fallback as separate entities when the "
        "note expresses only the context-specific fact. Do not merge distinct facts merely because one "
        "appears as a structured attribute of another; keep separate facts when they could need separate "
        "FHIR representation, such as participant/role facts, administrative/coverage facts, procedure "
        "recommendation/refusal facts, medication facts, indication/reason facts, or finding/result facts. "
        "These are examples, not a closed list. Remove placeholders, parser artifacts, identifiers, "
        "patient demographic/PII metadata, note-section labels, documentation boilerplate, "
        "for example age-only mentions, names, contact details, addresses, identifiers, or masked "
        "de-identification tokens. These examples are not exhaustive. Do not remove clinically meaningful "
        "quantities or strengths when they belong to medications, tests, or procedures. "
        "and fragments that do not carry a representable fact. Preserve all grounded structured fields "
        "from merged items. Do not invent facts.\n"
        "Return ONLY JSON with one top-level key named entities. Each entity object must contain a "
        "non-empty entity string and ontology_search_terms array. Additional grounded fields are allowed.\n\n"
        f"Note:\n{text}\n\n"
        f"Candidate entities:\n{json.dumps({'entities': entities}, ensure_ascii=False, default=str)}"
    )

    try:
        payload = _invoke_json_prompt(llm, prompt, label)
        cleaned = _normalize_extracted_entities_payload(payload, llm, text)
        if cleaned:
            consolidated = _merge_extracted_entities([cleaned])
            print(
                f"   {label} consolidated {len(entities)} candidates into "
                f"{len(consolidated)} distinct entities."
            )
            return consolidated
    except Exception as exc:
        print(f"   {label} skipped after error: {exc}")

    return entities


# =============================================================================
# LangGraph Agent
# =============================================================================
def extract_entities_with_llm(text: str) -> list[dict]:
    """Extract context-aware entities before programmatic terminology search."""
    llm = get_snomed_llm()

    detailed_prompt = (
        "Extract the distinct clinical and healthcare-administrative FHIR-relevant facts from the note below.\n"
        "All entity categories and context types named below are illustrative and non-exhaustive; "
        "apply the general clinical/FHIR relevance principle to facts not named in the examples.\n"
        "Include findings, disorders, symptoms, anatomy with clinically relevant qualifiers, "
        "procedures, tests, medications including brand/generic names with strengths or doses, "
        "clinician/professional roles, organizations with a grounded healthcare role, administrative "
        "relationships, and other distinct FHIR-relevant facts even when they appear "
        "as context, rationale, indication, result, or qualifier for another statement.\n"
        "Treat an explicitly stated patient-provider interaction as its own event fact; do not extract "
        "only the participating parties and lose the interaction that connects them.\n"
        "Preserve context that changes clinical meaning, including negation, refusal, allergy, "
        "family history, uncertainty, and temporality.\n"
        "For each entity, provide `ontology_search_terms` ordered from most context-specific to "
        "most general. If the text expresses absence, refusal, allergy, family history, or another "
        "context that SNOMED may encode as a pre-coordinated concept, the first search term should "
        "preserve that context using concise terminology-style wording rather than note-only modifiers. "
        "For absent findings, the first search term should express absence of that finding, "
        "not note trigger wording or colloquial shorthand. "
        "For refusal context, the first search term should preserve the refusal meaning, not only the base action. "
        "Include the underlying base entity as a later fallback term.\n"
        "For coordinated lists under shared context, expand the shared context to every listed item.\n"
        "Resolve the scope of every assertion from sentence meaning and syntax rather than word proximity. "
        "Apply a governing assertion to every coordinated entity within its semantic scope even when the "
        "entity is distant, and stop at a genuine clause boundary, contrast, or new assertion. Do not extend "
        "it to unrelated later facts. Set `source_assertion_negated` independently for every entity. These "
        "principles are illustrative of scope reasoning and do not define a closed phrase list.\n"
        "Extract EVERY distinct relevant fact, including facts whose primary representation is an "
        "administrative FHIR resource and which may not have a SNOMED code. This includes each "
        "allergy substance, each absent-context finding in a coordinated list, each refusal-context action, "
        "each medication mention with strength/dose when stated, each test/result, each clinically meaningful "
        "reason or indication, and each clinician/professional role mention.\n"
        "For allergy lists, create one entity per allergen/substance and mark each one as allergy.\n"
        "For absent findings, the entity and first ontology search terms should preserve absence "
        "when possible; include the base finding only as a later fallback term.\n"
        "For any other meaning-changing context, add a short structured field or qualifier and preserve "
        "that context in the first ontology search term when it affects terminology mapping.\n"
        "Return only facts grounded in clinical or healthcare-administrative content from the note; do not treat placeholders, "
        "identifiers, patient demographic/PII metadata, note-section labels, documentation boilerplate, "
        "parser artifacts, generic filler words, or frequency-only terms as clinical entities. "
        "PII/demographic examples include age-only mentions, names, contact details, addresses, identifiers, "
        "and masked de-identification tokens; these examples are not exhaustive. A non-person organization "
        "with an explicit healthcare role is not patient demographic metadata. Preserve clinically meaningful "
        "quantities or strengths when they belong to medications, tests, or procedures.\n"
        "For each entity, capture any structured context that changes meaning.\n"
        "Set `terminology_context_changes_meaning` to true only when that grounded context changes the "
        "terminology concept that should be searched, and false otherwise. Store grounded context signals "
        "in a `context_flags` object; its keys are open-ended rather than a closed category list.\n"
        "When the primary fact clearly corresponds to an official FHIR R4 resource, set "
        "`fhir_resource_type` to that resource name; otherwise use null. Determine it from the primary fact, "
        "not from a related participant, action, indication, result, or object. The resource set is open-ended.\n"
        "Also capture other context when present, such as experiencer, temporality, certainty, "
        "historical status, hypothetical status, or relationship to the patient.\n"
        "When the note explicitly relates two extracted facts, add `fhir_relationships` to the "
        "entity whose selected FHIR resource owns the reference. Each relationship object must contain "
        "`relationship` as the exact FHIR property or dotted property path, `target_entity` as the exact "
        "entity label of another extracted item, and `target_resource_type` as that target's selected FHIR "
        "resource type. Preserve every explicitly stated participant or party. Do not create relationships "
        "from mere co-occurrence, assumed healthcare workflow, or general world knowledge.\n"
        "The `entities` value MUST be a flat array of entity objects. Do not group objects under "
        "any wrapper. Every object in "
        "the array MUST contain a non-empty string field named `entity` and an "
        "`ontology_search_terms` array. Additional grounded structured fields are allowed "
        "and will be preserved.\n"
        "Return ONLY JSON with one top-level key named entities.\n\n"
        f"Note: {text}"
    )

    repair_prompt = (
        "Return ONLY valid JSON. Extract clinical and healthcare-administrative FHIR-relevant facts from this note. "
        "The following entity and context categories are illustrative and non-exhaustive. "
        "Do not omit allergy substances, absent findings, refusal-context actions, medication names with "
        "strengths/doses, tests, clinically meaningful reasons or indications, or clinician/professional roles. Apply shared context to every item in a coordinated list, "
        "Preserve an explicitly stated patient-provider interaction as its own event fact in addition to its parties. "
        "and preserve clinically meaningful context in ontology_search_terms before general fallback terms. "
        "Use concise terminology-style search terms; do not carry over intensifiers or note wording unless "
        "it changes the clinical meaning. For absent findings, express absent finding meaning first. "
        "Use formal absence wording rather than colloquial negative shorthand. "
        "For refusal context, express refusal meaning first. "
        "Resolve assertion scope semantically across coordinated or grammatically linked entities, not by "
        "nearest-word distance. Set source_assertion_negated independently for every item and do not carry "
        "an assertion across a boundary or contrast that changes its scope. "
        "Retain facts whose primary representation is an administrative FHIR resource even when no SNOMED "
        "code is expected. Do not extract patient demographic/PII metadata, de-identification artifacts, note-section labels, "
        "or documentation boilerplate as ontology entities. Examples include age-only mentions, names, "
        "contact details, addresses, identifiers, and masked de-identification tokens; these examples are "
        "not exhaustive. Preserve clinically meaningful quantities or strengths when they belong to "
        "medications, tests, or procedures. "
        "The `entities` value MUST be a flat array only. Do not return grouped categories, nested arrays, "
        "or objects keyed by category. Every item MUST have a non-empty string field named `entity` "
        "and an `ontology_search_terms` array. Include the boolean field "
        "`terminology_context_changes_meaning` and an open-ended `context_flags` object. "
        "Include `fhir_resource_type` when the primary fact clearly supports an official FHIR R4 resource; "
        "otherwise use null. Do not use a related fact to classify the primary entity. "
        "For explicit relationships between extracted facts, add `fhir_relationships` to the item whose "
        "FHIR resource owns the reference. Use the exact FHIR property/path plus the exact target entity "
        "label and target resource type; never infer a relationship from co-occurrence alone. "
        "Additional grounded structured fields are allowed "
        "and will be preserved.\n"
        f"Note: {text}"
    )

    rescue_prompt = (
        "Return ONLY valid JSON with exactly one top-level key named entities. "
        "The value of entities must be a flat array. Every array item must be one entity object with "
        "a non-empty entity string and ontology_search_terms array. Do not return category wrappers, "
        "nested groups, prose, markdown, or a single object containing multiple entities. "
        "Extract all clinical and healthcare-administrative FHIR-relevant facts from the note. The following categories are "
        "illustrative and non-exhaustive: "
        "conditions, tests, medications including stated strengths/doses, allergies, absent findings, refusal-context actions, "
        "clinically meaningful reasons or indications, clinician/professional roles, organizations with a "
        "grounded healthcare role, and administrative relationships. Preserve context in structured fields. "
        "An explicitly stated patient-provider interaction is a distinct event fact and must not be reduced to its parties. "
        "Resolve shared assertion scope from the full sentence and set source_assertion_negated separately "
        "for each entity; do not use simple word proximity or propagate across a meaning-changing boundary. "
        "Do not extract patient demographic/PII metadata, de-identification artifacts, note-section labels, "
        "or documentation boilerplate as ontology entities. Examples include age-only mentions, names, "
        "contact details, addresses, identifiers, and masked de-identification tokens; these examples are "
        "not exhaustive. Preserve clinically meaningful quantities or strengths when they belong to "
        "medications, tests, or procedures. "
        "Use formal terminology-style search terms. Include the boolean field "
        "terminology_context_changes_meaning and an open-ended context_flags object. "
        "Include fhir_resource_type when the primary fact clearly supports an official FHIR R4 resource; "
        "otherwise use null. "
        "Preserve explicit links between extracted facts in `fhir_relationships` on the reference-owning "
        "item, using exact FHIR property/path, exact target entity label, and target resource type. Never "
        "infer links from co-occurrence alone. "
        "Additional grounded fields are allowed and will be preserved.\n"
        f"Note: {text}"
    )

    last_error = None
    extracted_batches: list[list[dict]] = []
    for attempt, prompt in enumerate((detailed_prompt, repair_prompt, rescue_prompt), start=1):
        try:
            payload = _invoke_json_prompt(llm, prompt, f"Entity extraction attempt {attempt}/3")
            cleaned = _normalize_extracted_entities_payload(payload, llm, text)
            if cleaned:
                extracted_batches.append(cleaned)
                print(
                    f"   Entity extraction attempt {attempt}/3 contributed "
                    f"{len(cleaned)} usable entities."
                )
                continue
            last_error = ValueError("LLM returned parseable JSON but no usable entity objects")
            print(
                f"   Entity extraction attempt {attempt}/3 produced no usable entities; "
                "trying stricter prompt..."
            )
        except Exception as exc:
            last_error = exc
            print(f"   Entity extraction attempt {attempt}/3 failed: {exc}")

    merged = _merge_extracted_entities(extracted_batches)
    if merged:
        consolidated = _consolidate_extracted_entities_with_llm(
            llm,
            text,
            merged,
            label="Entity extraction consolidation",
        )
        print(
            f"   Entity extraction merged {sum(len(batch) for batch in extracted_batches)} "
            f"prompt entities into {len(consolidated)} distinct entities."
        )
        return consolidated

    print(f"   Entity extraction fallback failed: {last_error}")
    return []


def _mapping_labels_for_audit(mappings: list[dict]) -> list[str]:
    labels: list[str] = []

    def is_identity_key(key: str) -> bool:
        normalized_key = re.sub(r"[^a-z0-9]+", "_", str(key or "").lower()).strip("_")
        key_parts = set(normalized_key.split("_"))
        return bool(
            key_parts & {"entity", "term", "name", "display", "label"}
            or normalized_key in {"fsn", "text"}
        )

    def is_label_like(value: Any) -> bool:
        if not isinstance(value, str):
            return False
        normalized = re.sub(r"\s+", " ", value).strip()
        if not normalized or not re.search(r"[A-Za-z]", normalized):
            return False
        if len(re.findall(r"\w+", normalized)) > 12:
            return False
        if re.search(r"[.!?]\s+\w", normalized):
            return False
        return True

    for mapping in mappings or []:
        if not isinstance(mapping, dict):
            continue
        for key, value in mapping.items():
            if is_identity_key(str(key)) and is_label_like(value):
                labels.append(re.sub(r"\s+", " ", str(value)).strip())
    return list(dict.fromkeys(labels))


def extract_missed_entities_with_llm(text: str, existing_mappings: list[dict]) -> list[dict]:
    """Audit the note for omitted entities without entity-specific rules."""
    llm = get_snomed_llm()
    covered_labels = _mapping_labels_for_audit(existing_mappings)
    covered_keys = {_entity_merge_key(label) for label in covered_labels if _entity_merge_key(label)}

    audit_prompt = (
        "Audit the note for clinically meaningful entities that are NOT already represented "
        "by the current extracted/mapped entity list.\n"
        "Return only omitted entities that are grounded in the note. Treat semantic duplicates, "
        "synonyms, plural/singular variants, brand/generic equivalents, and more general/broader "
        "forms of already-covered items as already represented.\n"
        "The already represented labels below are identity/display labels only; do not assume that "
        "a fact is represented just because it might appear as context or an attribute inside another "
        "mapping. If a distinct note fact could need its own FHIR representation, return it.\n"
        "Preserve an explicitly stated patient-provider interaction as a distinct event fact when the "
        "current labels contain only its participants.\n"
        "Include any omitted distinct fact that belongs in clinical or healthcare-administrative FHIR mapping only when present "
        "in the note.\n"
        "Do not return patient demographic/PII metadata, de-identification artifacts, note-section labels, "
        "or documentation boilerplate as missed ontology entities. Examples include age-only mentions, names, "
        "contact details, addresses, identifiers, and masked de-identification tokens; these examples are "
        "not exhaustive. Preserve clinically meaningful quantities or strengths when they belong to "
        "medications, tests, or procedures. Do not discard a non-person organization when the note gives "
        "it an explicit healthcare-administrative role.\n"
        "Preserve meaning-changing context in structured fields and in context-specific "
        "ontology_search_terms before fallback terms. You may include any additional structured "
        "fields that are grounded in the note; do not invent missing facts.\n"
        "Audit assertion scope across the complete sentence. Apply a shared assertion to all and only the "
        "coordinated or grammatically governed entities, even when separated by intervening words. Stop at "
        "a clause boundary, contrast, or new explicit assertion. Set source_assertion_negated independently "
        "for every omitted entity. Do not rely on a fixed trigger vocabulary or distance window.\n"
        "When the omitted primary fact clearly corresponds to an official FHIR R4 resource, include "
        "fhir_resource_type; otherwise omit it or use null. The resource set is open-ended.\n"
        "If the note explicitly links an omitted fact to another extracted fact, preserve the link in "
        "`fhir_relationships` on the reference-owning item using the exact FHIR property/path, exact target "
        "entity label, and target resource type. Never infer a link from co-occurrence alone.\n"
        "Do not upgrade intensifiers into reaction, severity, complication, or outcome concepts unless "
        "that reaction or outcome is explicitly stated in the note.\n"
        "Return ONLY JSON with one top-level key named entities. Each entity object must contain "
        "a non-empty string field named entity and an ontology_search_terms array. Additional "
        "grounded fields are allowed and will be preserved.\n\n"
        f"Note:\n{text}\n\n"
        f"Already represented entity labels:\n{json.dumps(covered_labels, ensure_ascii=False)}"
    )

    try:
        payload = _invoke_json_prompt(llm, audit_prompt, "Missed-entity audit")
        cleaned = _normalize_extracted_entities_payload(payload, llm, text)
    except Exception as exc:
        print(f"   Missed-entity audit skipped after error: {exc}")
        return []

    missed = []
    for item in cleaned:
        entity_key = _entity_merge_key(item.get("entity", ""))
        term_keys = {
            _entity_merge_key(term)
            for term in _listify_text_values(item.get("ontology_search_terms"))
            if _entity_merge_key(term)
        }
        if entity_key and entity_key in covered_keys:
            continue
        if term_keys and term_keys <= covered_keys:
            continue
        missed.append(item)

    missed = _merge_extracted_entities([missed])
    missed = _consolidate_extracted_entities_with_llm(
        llm,
        text,
        missed,
        label="Missed-entity audit consolidation",
    )
    print(f"   Missed-entity audit proposed {len(missed)} new candidate entities.")
    return missed


def audit_missed_snomed_mappings(input_text: str, existing_mappings: list[dict]) -> list[dict]:
    """Extract and map omitted note entities using the same SNOMED mapping flow."""
    missed_entities = extract_missed_entities_with_llm(input_text, existing_mappings)
    if not missed_entities:
        return []

    existing_keys = {
        _entity_merge_key(label)
        for label in _mapping_labels_for_audit(existing_mappings)
        if _entity_merge_key(label)
    }
    mapping_result = run_snomed_agent(input_text, seed_entities=missed_entities)
    additions = []
    for mapping in mapping_result.get("mappings", []):
        if not isinstance(mapping, dict):
            continue
        labels = _mapping_labels_for_audit([mapping])
        if any(_entity_merge_key(label) in existing_keys for label in labels if _entity_merge_key(label)):
            continue
        additions.append(mapping)

    print(f"   Missed-entity audit mapped {len(additions)} additional entities.")
    return additions


def _unmapped_seed_mappings(seed_entities: list[dict] | None, reason: str) -> list[dict]:
    """Preserve supplied facts without inventing terminology codes."""
    preserved: list[dict] = []
    for item in seed_entities or []:
        mapping = dict(item) if isinstance(item, dict) else {"entity": str(item or "").strip()}
        entity = str(mapping.get("entity") or mapping.get("original_entity") or "").strip()
        if not entity:
            continue
        mapping.setdefault("entity", entity)
        mapping.setdefault("original_entity", entity)
        mapping.setdefault("matched_via", "terminology_unavailable")
        mapping.setdefault("confidence", "Low")
        mapping.setdefault("reason", reason)
        preserved.append(mapping)
    return preserved


def run_snomed_agent(input_text: str, seed_entities: list[dict] | None = None) -> dict:
    """
    Run Agent 2: SNOMED Mapping using LangGraph.

    The agent autonomously decides which tools to call to map
    medical entities to SNOMED CT codes.

    Args:
        input_text: Preprocessed text from Agent 1
        seed_entities: Optional pre-extracted entity objects to map instead of
            running the extraction prompt again.

    Returns:
        Dictionary with input_text and list of mappings
    """
    input_text = str(input_text or "")
    try:
        load_resources()
    except Exception as exc:
        warning = f"SNOMED resources unavailable; facts were left unmapped and processing can continue: {exc}"
        print(f"⚠ {warning}")
        return {
            "input_text": input_text,
            "mappings": _unmapped_seed_mappings(seed_entities, warning),
            "retrieval_traces": [],
            "warnings": [warning],
        }
    try:
        llm = get_snomed_llm()
    except Exception as exc:
        warning = f"SNOMED model client unavailable; facts were left unmapped and processing can continue: {exc}"
        print(f"⚠ {warning}")
        return {
            "input_text": input_text,
            "mappings": _unmapped_seed_mappings(seed_entities, warning),
            "retrieval_traces": [],
            "warnings": [warning],
        }

    # Per-invocation shared state
    _search_results_cache = {}
    _decompose_call_count = [0]
    _collected_mappings = []
    _seen_entities = set()
    _generalize_provenance = {}
    _decompose_provenance = {}
    _search_alias_provenance = {}
    _rerank_attempts = {}
    _retrieval_traces = []
    _trace_by_entity = {}
    _represented_extraction_keys = set()
    agent_loop_failed = [False]

    def extraction_keys_for_item(item: Any, entity: str | None = None) -> set[str]:
        keys = set()
        if entity:
            key = _entity_merge_key(entity)
            if key:
                keys.add(key)
        if isinstance(item, dict):
            item_entity = _entity_merge_key(item.get("entity", ""))
            if item_entity:
                keys.add(item_entity)
            for term in _listify_text_values(item.get("ontology_search_terms")):
                term_key = _entity_merge_key(term)
                if term_key:
                    keys.add(term_key)
        return keys

    def record_snomed_search(entity: str, candidates: list[dict]) -> None:
        trace = query_trace(
            vocabulary="SNOMED",
            query_text=entity,
            retrieval_backend=f"Local SNOMED {DENSE_INDEX_BACKEND.upper()} + {DENSE_EMBEDDING_MODEL}",
            retrieval_stage="dense_vector_search",
            candidates=[
                candidate_trace(
                    rank=candidate["rank"],
                    code=candidate["concept_id"],
                    display=candidate.get("fsn") or candidate.get("term"),
                    similarity_score=candidate.get("similarity_score"),
                    extra={"term": candidate.get("term"), "top_hierarchy": candidate.get("top_hierarchy")},
                )
                for candidate in candidates
            ],
            reranker_used=True,
            cache_hit=False,
        )
        _retrieval_traces.append(trace)
        _trace_by_entity[entity] = trace

    def record_snomed_selection(entity: str, result: dict) -> None:
        trace = _trace_by_entity.get(entity)
        if not trace:
            return
        selected_code = str(result.get("concept_id") or "")
        trace["selected_code"] = selected_code or None
        trace["selected_display"] = result.get("fsn")
        trace["matched_via"] = result.get("matched_via")
        for candidate in trace.get("candidates", []):
            if str(candidate.get("code", "")) == selected_code:
                trace["selected_rank"] = candidate.get("rank")
                break

    def run_programmatic_snomed_mapping() -> None:
        """Create mappings with JSON extraction plus programmatic terminology search."""
        print("\n   Executing programmatic SNOMED mapping.")
        if seed_entities is None:
            entities = extract_entities_with_llm(input_text)
            print(f"   Programmatic extraction produced entities: {entities}")
        else:
            entities = _merge_extracted_entities([seed_entities])
            print(f"   Programmatic mapping received seed entities: {entities}")

        for item in entities:
            entity = item.get("entity") if isinstance(item, dict) else item
            if not entity:
                continue
            item_keys = extraction_keys_for_item(item, str(entity))
            if item_keys and item_keys <= _represented_extraction_keys:
                print(f"   Skipping already represented extraction variant: {entity}")
                continue

            fhir_resource_type = item.get("fhir_resource_type") if isinstance(item, dict) else None
            if fhir_resource_type and isinstance(item, dict):
                item["fhir_resource_type"] = fhir_resource_type

            search_terms = _ontology_search_terms_from_item(item, str(entity).strip())
            search_terms = _expand_missing_contextual_search_terms(
                llm,
                input_text,
                item,
                search_terms,
            )
            print(f"   Search plan for '{entity}': {search_terms}")
            selected = False
            context_search_attempted = False
            context_expansion_attempted = _uses_contextual_search_terms(item)
            entity_key = _entity_merge_key(str(entity))
            search_context_item = item

            for search_entity in search_terms:
                search_key = _entity_merge_key(search_entity)
                if search_key and search_key != entity_key:
                    context_search_attempted = True
                _search_alias_provenance[search_entity] = {
                    "original_entity": entity,
                    "item": search_context_item,
                    "allow_external_context": (
                        _search_term_is_base_fallback(
                            search_context_item,
                            str(entity),
                            search_entity,
                        )
                        or _source_term_allows_external_context(
                            search_context_item,
                            entity=str(entity),
                            search_term=search_entity,
                        )
                    ),
                    "context_search_attempted": (
                        context_search_attempted or context_expansion_attempted
                    ),
                }
                try:
                    search_payload = json.loads(search_snomed.invoke({"entity": search_entity}))
                except Exception as exc:
                    print(f"   Fallback search failed for '{search_entity}': {exc}")
                    continue

                status = search_payload.get("status")
                active_entity = search_entity

                if status == "CACHE_HIT":
                    selected = True
                    break
                if status != "CANDIDATES_FOUND":
                    continue

                try:
                    rerank_payload = json.loads(
                        rerank_candidates.invoke({"entity": active_entity, "context": input_text})
                    )
                except Exception as exc:
                    print(f"   Fallback rerank failed for '{active_entity}': {exc}")
                    continue

                if rerank_payload.get("action") == "SELECT":
                    selected = True
                    break

                if (
                    rerank_payload.get("context_retry_required")
                    and not context_expansion_attempted
                ):
                    context_item = dict(item)
                    context_item["terminology_context_changes_meaning"] = True
                    retry_terms = _expand_missing_contextual_search_terms(
                        llm,
                        input_text,
                        context_item,
                        [str(entity)],
                        force=True,
                    )
                    additions = [
                        term
                        for term in retry_terms
                        if _entity_merge_key(term) != _entity_merge_key(search_entity)
                        and term not in search_terms
                    ]
                    search_terms.extend(additions)
                    search_terms.append(search_entity)
                    search_context_item = context_item
                    context_expansion_attempted = True
                    print(
                        "   Assertion context discovered during reranking; "
                        "trying context-preserving terms before base fallback."
                    )

                print(f"   Fallback rerank returned NO_MATCH for '{active_entity}'")

            if selected:
                _represented_extraction_keys.update(item_keys)
                continue

            try:
                decompose_payload = json.loads(
                    decompose_entity.invoke({"entity": entity, "context": input_text})
                )
            except Exception as exc:
                print(f"   Fallback decomposition failed for '{entity}': {exc}")
                decompose_payload = {"status": "CANNOT_DECOMPOSE", "sub_entities": []}

            if decompose_payload.get("status") == "DECOMPOSED":
                for sub_entity in decompose_payload.get("sub_entities", []):
                    if not sub_entity:
                        continue
                    _search_alias_provenance[sub_entity] = {"original_entity": entity, "item": item}
                    try:
                        search_payload = json.loads(search_snomed.invoke({"entity": sub_entity}))
                    except Exception as exc:
                        print(f"   Fallback search failed for decomposed '{sub_entity}': {exc}")
                        continue

                    if search_payload.get("status") == "CACHE_HIT":
                        selected = True
                        break
                    if search_payload.get("status") != "CANDIDATES_FOUND":
                        continue

                    try:
                        rerank_payload = json.loads(
                            rerank_candidates.invoke({"entity": sub_entity, "context": input_text})
                        )
                    except Exception as exc:
                        print(f"   Fallback rerank failed for decomposed '{sub_entity}': {exc}")
                        continue

                    if rerank_payload.get("action") == "SELECT":
                        selected = True
                        break

                if selected:
                    _represented_extraction_keys.update(item_keys)
                    continue

            if decompose_payload.get("status") in {"CANNOT_DECOMPOSE", "LIMIT_REACHED"}:
                try:
                    generalize_payload = json.loads(generalize_entity.invoke({"entity": entity}))
                except Exception as exc:
                    print(f"   Fallback generalization failed for '{entity}': {exc}")
                    generalize_payload = {"status": "NO_ALTERNATIVE", "generic_name": entity}

                generic_name = (
                    generalize_payload.get("generic_name")
                    or generalize_payload.get("entity")
                    or entity
                )
                if generic_name and generic_name != entity:
                    _search_alias_provenance[generic_name] = {"original_entity": entity, "item": item}
                    try:
                        search_payload = json.loads(search_snomed.invoke({"entity": generic_name}))
                    except Exception as exc:
                        print(f"   Fallback search failed for generalized '{generic_name}': {exc}")
                        search_payload = {"status": "ERROR"}

                    if search_payload.get("status") == "CACHE_HIT":
                        selected = True
                    elif search_payload.get("status") == "CANDIDATES_FOUND":
                        try:
                            rerank_payload = json.loads(
                                rerank_candidates.invoke({"entity": generic_name, "context": input_text})
                            )
                        except Exception as exc:
                            print(f"   Fallback rerank failed for generalized '{generic_name}': {exc}")
                            rerank_payload = {"action": "NO_MATCH"}
                        selected = rerank_payload.get("action") == "SELECT"

                if selected:
                    _represented_extraction_keys.update(item_keys)
                    continue

            if fhir_resource_type and entity not in _seen_entities:
                mapping = {
                    "entity": entity,
                    "original_entity": entity,
                    "matched_via": "fhir_intent_no_snomed_match",
                    "confidence": "Low",
                    "fhir_resource_type": fhir_resource_type,
                    "reason": "Kept as FHIR resource intent after SNOMED search did not select a terminology match.",
                }
                _merge_model_item_fields(mapping, item)
                _collected_mappings.append(mapping)
                _seen_entities.add(entity)

    # -----------------------------------------------------------------
    # Define State
    # -----------------------------------------------------------------
    class AgentState(TypedDict):
        messages: list

    # -----------------------------------------------------------------
    # Tool 1: Search SNOMED
    # -----------------------------------------------------------------
    @tool
    def search_snomed(entity: str) -> str:
        """Search the SNOMED CT database for candidate matches for a medical entity.
        Returns top matching SNOMED concepts with similarity scores.
        Always call this BEFORE rerank_candidates for the same entity.

        Args:
            entity: The medical entity text to search for
        """
        print(f"\n   search_snomed('{entity}')")

        # Check entity cache first
        alias_info = _search_alias_provenance.get(entity, {})
        alias_item = alias_info.get("item") if isinstance(alias_info, dict) else {}
        cached = entity_cache_module.get_entity(entity)
        if cached and cached.get("matched_via") == "fallback":
            print(f"   Ignoring old fallback cache entry for '{entity}'")
            cached = None
        if cached and alias_info:
            print(f"   Ignoring context-blind cache shortcut for '{entity}'")
            cached = None
        if cached and not _record_retrieval_traces_enabled():
            print(f"   Cache HIT for '{entity}'")
            original_entity = (
                alias_info.get("original_entity")
                if isinstance(alias_info, dict)
                else None
            ) or entity

            # Collect mapping immediately
            if original_entity not in _seen_entities:
                cached_assertion_encoded = cached.get("assertion_encoded_by_concept")
                source_assertion_negated = bool(
                    cached.get("source_assertion_negated")
                    or cached.get("negated")
                    or alias_item.get("source_assertion_negated", False)
                    or alias_item.get("negated", False)
                )
                mapping = {
                    "entity": original_entity,
                    "original_entity": original_entity,
                    "concept_id": str(cached.get("concept_id", "")),
                    "fsn": cached.get("fsn", ""),
                    "matched_via": cached.get("matched_via", "cached") if original_entity == entity else "contextual_search_cached",
                    "generalized_term": cached.get("generalized_term") or (entity if original_entity != entity else None),
                    "reason": cached.get("reason", "Retrieved directly from cache."),
                    "confidence": cached.get("confidence"),
                    "observation": cached.get("observation"),
                    "condition": cached.get("condition"),
                    "source_assertion_negated": source_assertion_negated,
                    "negated": source_assertion_negated and cached_assertion_encoded is not True,
                    "assertion_encoded_by_concept": cached_assertion_encoded,
                    "negation_type": cached.get("negation_type"),
                    "consent_refused": cached.get("consent_refused", bool(alias_item.get("consent_refused", False))),
                    "is_allergy": cached.get("is_allergy", bool(alias_item.get("is_allergy", False))),
                    "allergy_category": cached.get("allergy_category") or alias_item.get("allergy_category"),
                    "context_qualifiers": cached.get("context_qualifiers") or alias_item.get("context_qualifiers"),
                    "fhir_resource_type": cached.get("fhir_resource_type") or alias_item.get("fhir_resource_type"),
                }
                _merge_model_item_fields(mapping, alias_item)
                _collected_mappings.append(mapping)
                _seen_entities.add(original_entity)

            return json.dumps({
                "status": "CACHE_HIT",
                "entity": entity,
                "concept_id": cached.get("concept_id"),
                "fsn": cached.get("fsn"),
                "message": "Entity already mapped from cache. No need to rerank."
            })

        # Dense vector search using the selected backend.
        index, metadata, _, _ = load_resources()
        lexical_candidates = _lexical_snomed_candidates(entity, metadata, LEXICAL_TOP_K)
        query_embedding = get_embedding(entity)
        if DENSE_INDEX_BACKEND == "usearch":
            matches = index.search(query_embedding[0], TOP_K)
            raw_results = [(1.0 - float(match.distance), int(match.key)) for match in matches]
        else:
            scores, indices = index.search(query_embedding, TOP_K)
            raw_results = [(float(score), int(idx)) for score, idx in zip(scores[0], indices[0])]

        dense_candidates = []
        for score, idx in raw_results:
            row = _candidate_from_metadata(int(idx))
            if row is None:
                continue
            dense_candidates.append({
                "concept_id": str(row["concept_id"]),
                "term": row["term"],
                "fsn": row["fsn"],
                "top_hierarchy": row["top_hierarchy"],
                "similarity_score": round(float(score), 3),
                "retrieval_source": "dense",
            })

        candidates = []
        seen_concepts = set()
        for candidate in [*lexical_candidates, *dense_candidates]:
            concept_id = candidate.get("concept_id")
            if not concept_id or concept_id in seen_concepts:
                continue
            seen_concepts.add(concept_id)
            candidate = dict(candidate)
            candidate["rank"] = len(candidates) + 1
            candidates.append(candidate)

        # Store full candidates for reranking
        _search_results_cache[entity] = candidates
        record_snomed_search(entity, candidates)

        print(
            f"   Found {len(candidates)} candidates "
            f"({len(lexical_candidates)} lexical + {len(dense_candidates)} dense before dedupe)"
        )
        for c in candidates[:3]:
            source = c.get("retrieval_source", "search")
            print(f"     {c['rank']}. {c['fsn'][:60]}... ({source}, score: {c['similarity_score']})")

        return json.dumps({
            "status": "CANDIDATES_FOUND",
            "entity": entity,
            "num_candidates": len(candidates),
            "candidates": [
                {
                    "rank": c["rank"],
                    "term": c["term"],
                    "fsn": c["fsn"],
                    "similarity_score": c["similarity_score"]
                }
                for c in candidates
            ]
        })

    # -----------------------------------------------------------------
    # Tool 2: Rerank Candidates
    # -----------------------------------------------------------------
    @tool
    def rerank_candidates(entity: str, context: str) -> str:
        """Evaluate SNOMED search candidates and decide if any is a valid match.
        Must be called AFTER search_snomed for the same entity.
        Returns SELECT with the best match, or NO_MATCH if none are clinically equivalent.

        Args:
            entity: The medical entity that was searched
            context: The original full input text for clinical context
        """
        print(f"\n   rerank_candidates('{entity}')")

        candidates = _search_results_cache.get(entity, [])
        if not candidates:
            return json.dumps({
                "action": "NO_MATCH",
                "entity": entity,
                "reason": "No candidates available. Call search_snomed first."
            })

        alias_info = _search_alias_provenance.get(entity, {})
        alias_item = alias_info.get("item") if isinstance(alias_info, dict) else {}
        exact_candidate = _unique_exact_terminology_candidate(entity, candidates)
        original_entity = str(
            (
                alias_info.get("original_entity")
                if isinstance(alias_info, dict)
                else None
            )
            or entity
        ).strip()
        exact_match_is_terminal = _exact_terminology_match_is_terminal(
            exact_candidate,
            alias_item,
            search_entity=entity,
            original_entity=original_entity,
        )

        # Track per-entity rerank attempts
        _rerank_attempts[entity] = _rerank_attempts.get(entity, 0) + 1
        is_retry = _rerank_attempts[entity] > 1

        # Format candidates for LLM prompt
        candidates_text = ""
        for c in candidates:
            candidates_text += (
                f"\n{c['rank']}. Term: {c.get('term', c['fsn'])}\n"
                f"   FSN: {c['fsn']}\n"
                f"   Concept ID: {c['concept_id']}\n"
                f"   Hierarchy: {c['top_hierarchy']}\n"
                f"   Similarity: {c['similarity_score']:.3f}\n"
            )

        try:
            if exact_match_is_terminal:
                result = {
                    "action": "SELECT",
                    "concept_id": exact_candidate.get("concept_id"),
                    "fsn": exact_candidate.get("fsn"),
                    "confidence": "High",
                    "reason": "Unique exact terminology-label match.",
                    "source_assertion_negated": bool(
                        alias_item.get("source_assertion_negated")
                        or alias_item.get("negated")
                    ),
                    "assertion_encoded_by_concept": None,
                    "core_referent_preserved": True,
                }
                print("   Unique exact terminology-label match; semantic fallback not needed.")
            else:
                prompt = format_prompt(
                    "snomed_reranking",
                    entity=entity,
                    context=context,
                    candidates_text=candidates_text
                )
                response = resilient_llm_invoke(llm, [HumanMessage(content=prompt)])
                response_text = response.content.strip()

                json_match = re.search(r'\{.*?"action".*?\}', response_text, re.DOTALL)
                if json_match:
                    result = json.loads(json_match.group())
                else:
                    result = json.loads(response_text)

            action = result.get("action", "NO_MATCH")

            if action == "SELECT":
                # Determine provenance
                original_entity = original_entity or _generalize_provenance.get(entity, entity)
                allow_external_context = bool(
                    alias_info.get("allow_external_context")
                    if isinstance(alias_info, dict)
                    else False
                )
                assertion_encoded_by_concept = (
                    result.get("assertion_encoded_by_concept")
                    if isinstance(result.get("assertion_encoded_by_concept"), bool)
                    else None
                )
                source_assertion_negated = bool(
                    alias_item.get("source_assertion_negated", False)
                    or alias_item.get("negated", False)
                    or result.get("source_assertion_negated") is True
                    or result.get("negated") is True
                )
                context_sensitive_selection = bool(
                    _has_context_marker(alias_item)
                    or original_entity != entity
                    or source_assertion_negated
                    or result.get("consent_refused") is True
                )
                if (
                    context_sensitive_selection
                    and result.get("core_referent_preserved") is not True
                    and not exact_match_is_terminal
                ):
                    print(
                        "   Candidate did not prove preservation of the underlying referent; "
                        "trying the next search term."
                    )
                    no_match_result = dict(result) if isinstance(result, dict) else {}
                    no_match_result.update({
                        "action": "NO_MATCH",
                        "entity": entity,
                        "reason": (
                            "Context-bearing selection did not preserve or confirm the "
                            "underlying referent/action."
                        ),
                    })
                    return json.dumps(no_match_result)
                if (
                    source_assertion_negated
                    and assertion_encoded_by_concept is not True
                    and not allow_external_context
                    and not bool(alias_info.get("context_search_attempted"))
                ):
                    no_match_result = dict(result) if isinstance(result, dict) else {}
                    no_match_result.update({
                        "action": "NO_MATCH",
                        "entity": entity,
                        "reason": "Assertion context requires context-preserving terminology search before base fallback.",
                        "context_retry_required": True,
                    })
                    return json.dumps(no_match_result)
                if (
                    _has_context_marker(alias_item)
                    and assertion_encoded_by_concept is not True
                    and not allow_external_context
                ):
                    print(
                        "   Context search selected a concept that did not encode the requested context; "
                        "trying remaining context terms before base fallback."
                    )
                    no_match_result = dict(result) if isinstance(result, dict) else {}
                    no_match_result.update({
                        "action": "NO_MATCH",
                        "entity": entity,
                        "reason": "Context-specific search selected a concept that did not encode the requested context.",
                    })
                    return json.dumps(no_match_result)
                matched_via = "direct"
                generalized_term = None

                if isinstance(alias_info, dict) and alias_info.get("original_entity") and alias_info.get("original_entity") != entity:
                    matched_via = "contextual_search"
                    generalized_term = entity
                elif entity in _generalize_provenance:
                    matched_via = "generalized"
                    generalized_term = entity
                elif entity in _decompose_provenance:
                    matched_via = "decomposed"
                elif original_entity in _decompose_provenance:
                    matched_via = "decomposed"

                context_bearing_selection = (
                    bool(generalized_term)
                    or bool(result.get("negated"))
                    or bool(result.get("consent_refused"))
                    or _has_context_marker(alias_item)
                )
                display_entity = str(
                    generalized_term
                    or (
                        original_entity
                        if context_bearing_selection
                        else None
                    )
                    or result.get("observation")
                    or result.get("condition")
                    or original_entity
                ).strip()

                mapping = {
                    "entity": display_entity or original_entity,
                    "original_entity": original_entity,
                    "concept_id": str(result.get("concept_id", "")),
                    "fsn": result.get("fsn", ""),
                    "matched_via": matched_via,
                    "generalized_term": generalized_term,
                    "reason": result.get("reason", "LLM selected this concept as a direct match."),
                    "confidence": result.get("confidence", "Unknown"),
                    "observation": result.get("observation"),
                    "condition": result.get("condition"),
                    "source_assertion_negated": source_assertion_negated,
                    "negated": source_assertion_negated and assertion_encoded_by_concept is not True,
                    "assertion_encoded_by_concept": assertion_encoded_by_concept,
                    "core_referent_preserved": result.get("core_referent_preserved"),
                    "negation_type": result.get("negation_type"),
                    "consent_refused": result.get("consent_refused", bool(alias_item.get("consent_refused", False))),
                    "is_allergy": result.get("is_allergy", bool(alias_item.get("is_allergy", False))),
                    "allergy_category": result.get("allergy_category") or alias_item.get("allergy_category"),
                    "context_qualifiers": alias_item.get("context_qualifiers"),
                    "fhir_resource_type": alias_item.get("fhir_resource_type"),
                }
                _merge_model_item_fields(mapping, alias_item)
                record_snomed_selection(entity, {**result, "matched_via": matched_via})

                # Cache and collect
                entity_cache_module.put_entity(original_entity, mapping)
                if entity != original_entity:
                    entity_cache_module.put_entity(entity, mapping)

                if original_entity not in _seen_entities:
                    _collected_mappings.append(mapping)
                    _seen_entities.add(original_entity)

                print(f"   SELECT: {result.get('fsn')}")
                return json.dumps({
                    "action": "SELECT",
                    "entity": display_entity or entity,
                    "original_entity": original_entity,
                    "concept_id": result.get("concept_id"),
                    "fsn": result.get("fsn"),
                    "matched_via": matched_via,
                    "reason": result.get("reason", ""),
                    "observation": result.get("observation"),
                    "condition": result.get("condition"),
                    "source_assertion_negated": source_assertion_negated,
                    "negated": source_assertion_negated and assertion_encoded_by_concept is not True,
                    "assertion_encoded_by_concept": assertion_encoded_by_concept,
                    "core_referent_preserved": result.get("core_referent_preserved"),
                    "negation_type": result.get("negation_type"),
                    "consent_refused": result.get("consent_refused", False),
                    "is_allergy": result.get("is_allergy", False),
                    "allergy_category": result.get("allergy_category"),
                })

            else:
                if is_retry:
                    print("   NO_MATCH on retry — leaving entity unmapped")

                print(f"   NO_MATCH: {result.get('reason', '')[:80]}")
                return json.dumps({
                    "action": "NO_MATCH",
                    "entity": entity,
                    "reason": result.get("reason", "No suitable match found")
                })

        except Exception as e:
            print(f"   Reranking failed: {e}; leaving entity unmapped")
            return json.dumps({
                "action": "NO_MATCH",
                "entity": entity,
                "reason": f"Reranking failed: {e}"
            })

    # -----------------------------------------------------------------
    # Tool 3: Decompose Entity
    # -----------------------------------------------------------------
    @tool
    def decompose_entity(entity: str, context: str) -> str:
        """Break a complex medical entity into simpler sub-entities for individual mapping.
        Use when rerank_candidates returns NO_MATCH for a compound or complex entity.
        After decomposing, call search_snomed and rerank_candidates for each sub-entity.

        If this tool returns LIMIT_REACHED, use generalize_entity instead.

        Args:
            entity: The complex entity to decompose
            context: The original full input text for context
        """
        _decompose_call_count[0] += 1

        if _decompose_call_count[0] > MAX_DECOMPOSE_CALLS:
            print(f"   decompose LIMIT REACHED ({MAX_DECOMPOSE_CALLS})")
            return json.dumps({
                "status": "LIMIT_REACHED",
                "entity": entity,
                "message": (
                    f"Decomposition limit ({MAX_DECOMPOSE_CALLS}) reached. "
                    "Use generalize_entity for this entity instead, "
                    "then search_snomed and rerank_candidates on the generalized term."
                )
            })

        print(f"\n   decompose_entity('{entity}') — call {_decompose_call_count[0]}/{MAX_DECOMPOSE_CALLS}")

        prompt = format_prompt("entity_decomposition", entity=entity, context=context)

        try:
            response = resilient_llm_invoke(llm, [HumanMessage(content=prompt)])
            response_text = response.content.strip()

            json_match = re.search(
                r'\{.*?"sub_entities".*?\[.*?\].*?\}', response_text, re.DOTALL
            )
            if json_match:
                result = json.loads(json_match.group())
                sub_entities = result.get("sub_entities", [entity])
            else:
                result = json.loads(response_text)
                sub_entities = result.get("sub_entities", [entity])

        except Exception as e:
            print(f"   Decomposition failed: {e}")
            sub_entities = re.split(r'\s+(?:and|with|in)\s+', entity)
            sub_entities = [s.strip() for s in sub_entities if s.strip()]

        # Filter out the original entity if returned unchanged
        sub_entities = [
            s for s in sub_entities
            if s.lower().strip() != entity.lower().strip()
        ]

        if not sub_entities:
            print(f"   Could not decompose further")
            return json.dumps({
                "status": "CANNOT_DECOMPOSE",
                "entity": entity,
                "message": (
                    "Entity cannot be broken down further. "
                    "Use generalize_entity to get a medical synonym, "
                    "then search_snomed and rerank_candidates."
                )
            })

        # Track provenance
        for sub in sub_entities:
            _decompose_provenance[sub] = entity

        print(f"   Sub-entities: {sub_entities}")
        return json.dumps({
            "status": "DECOMPOSED",
            "entity": entity,
            "sub_entities": sub_entities
        })

    # -----------------------------------------------------------------
    # Tool 4: Generalize Entity
    # -----------------------------------------------------------------
    @tool
    def generalize_entity(entity: str) -> str:
        """Get the standard medical synonym for a term that could not be matched directly.
        Use when decompose_entity returns LIMIT_REACHED or CANNOT_DECOMPOSE.
        After getting the generic name, call search_snomed and rerank_candidates
        with the generalized term.

        Args:
            entity: The unmatched medical entity to generalize
        """
        print(f"\n   generalize_entity('{entity}')")

        prompt = format_prompt("generalize_entity", entity=entity)

        try:
            response = resilient_llm_invoke(llm, [HumanMessage(content=prompt)])
            response_text = response.content.strip()

            json_match = re.search(r'\{.*?"generic_name".*?\}', response_text, re.DOTALL)
            if json_match:
                result = json.loads(json_match.group())
            else:
                result = json.loads(response_text)

            generic_name = result.get("generic_name", entity)
            category = result.get("category", "unknown")

            print(f"   '{entity}' -> '{generic_name}' (category: {category})")

            # Track provenance
            if generic_name.lower().strip() != entity.lower().strip():
                _generalize_provenance[generic_name] = entity

                return json.dumps({
                    "status": "GENERALIZED",
                    "original_entity": entity,
                    "generic_name": generic_name,
                    "category": category,
                    "message": (
                        f"Now call search_snomed with '{generic_name}' "
                        f"and then rerank_candidates."
                    )
                })

            return json.dumps({
                "status": "NO_ALTERNATIVE",
                "entity": entity,
                "generic_name": generic_name,
                "message": (
                    "No better medical synonym found. "
                    "Call search_snomed with the original term "
                    "and rerank_candidates to validate it."
                )
            })

        except Exception as e:
            print(f"   Generalization failed: {e}")
            return json.dumps({
                "status": "NO_ALTERNATIVE",
                "entity": entity,
                "generic_name": entity,
                "message": "Generalization failed. Leave unmapped unless reranking selects a candidate."
            })

    # -----------------------------------------------------------------
    # Wire up the agent
    # -----------------------------------------------------------------
    tools = [search_snomed, rerank_candidates, decompose_entity, generalize_entity]
    llm_with_tools = llm.bind_tools(tools)
    _agent_iteration = [0]

    def agent_node(state: AgentState) -> AgentState:
        """Agent reasons about tool results and decides next action."""
        _agent_iteration[0] += 1
        iteration = _agent_iteration[0]
        messages = state["messages"]
        print(f"\n-- Agent 2 | iteration {iteration} --")
        response = resilient_llm_invoke(llm_with_tools, messages)

        if hasattr(response, "tool_calls") and response.tool_calls:
            tool_names = [tc['name'] for tc in response.tool_calls]
            print(f"   Agent calls: {tool_names}  (iteration {iteration})")
        else:
            print(f"   Agent done — no more tools  (after {iteration} iterations)")
            print(f"   LLM Output: {response.content}")

        return {"messages": messages + [response]}

    def tool_node(state: AgentState) -> AgentState:
        """Execute tools requested by the agent."""
        messages = state["messages"]
        last_message = messages[-1]

        tool_results = []
        for tool_call in last_message.tool_calls:
            tool_name = tool_call["name"]
            tool_args = tool_call["args"]
            args_short = ", ".join(f"{k}='{v}'" for k, v in tool_args.items())
            print(f"\n   >> Executing tool: {tool_name}({args_short})")

            for t in tools:
                if t.name == tool_name:
                    result = t.invoke(tool_args)
                    tool_results.append(
                        ToolMessage(content=result, tool_call_id=tool_call["id"])
                    )
                    break

        return {"messages": messages + tool_results}

    def should_continue(state: AgentState) -> Literal["tools", "end", "force_continue"]:
        """Route to tools or end based on agent's decision."""
        last_message = state["messages"][-1]
        if hasattr(last_message, "tool_calls") and last_message.tool_calls:
            return "tools"
        
        content = getattr(last_message, "content", "").lower()
        if "summary" in content or "finished" in content or "complete" in content:
            return "end"
            
        return "force_continue"
        
    def force_continue_node(state: AgentState) -> AgentState:
        """Prompt the LLM to continue if it stopped without calling tools."""
        print("   >> Forcing agent to continue (No tool calls detected)")
        prompt = (
            "You returned text without calling a tool, and did not provide a final summary. "
            "You MUST use tools to process the remaining entities on your checklist. "
            "If you just searched for candidates, your VERY NEXT response MUST be to call `rerank_candidates`. "
            "If you are completely finished mapping all entities, write a summary."
        )
        return {"messages": state["messages"] + [HumanMessage(content=prompt)]}

    # -----------------------------------------------------------------
    # Build LangGraph
    # -----------------------------------------------------------------
    workflow = StateGraph(AgentState)
    workflow.add_node("agent", agent_node)
    workflow.add_node("tools", tool_node)
    workflow.add_node("force_continue", force_continue_node)
    workflow.set_entry_point("agent")
    workflow.add_conditional_edges(
        "agent",
        should_continue,
        {"tools": "tools", "force_continue": "force_continue", "end": END}
    )
    workflow.add_edge("tools", "agent")
    workflow.add_edge("force_continue", "agent")
    app = workflow.compile()

    # -----------------------------------------------------------------
    # System Prompt
    # -----------------------------------------------------------------
    system_prompt = load_prompt("agent2_system")

    print("\n" + "=" * 60)
    print("STARTING AGENT 2: SNOMED Mapping")
    print("=" * 60)
    print(f"Input: {input_text}")

    if seed_entities is not None or not USE_NATIVE_TOOL_AGENT:
        if seed_entities is not None:
            print("   Using programmatic SNOMED flow for supplied audit entities.")
        else:
            print("   Using programmatic SNOMED flow. Native LLM tool calls are disabled to avoid Ollama tool-call JSON parsing failures.")
        run_programmatic_snomed_mapping()
    else:
        print("   Using native LLM tool-call flow.")

        # -----------------------------------------------------------------
        # Execute Graph with recursion limit
        # -----------------------------------------------------------------
        initial_state = {
            "messages": [
                HumanMessage(content=f"{system_prompt}\n\nText to map: {input_text}")
            ]
        }

        try:
            app.invoke(
                initial_state,
                config={"recursion_limit": LANGGRAPH_RECURSION_LIMIT}
            )
        except Exception as e:
            agent_loop_failed[0] = True
            print(f"\n   Agent stopped: {e}")
            print(f"   Collected {len(_collected_mappings)} mapping(s) before failure.")

        if agent_loop_failed[0] or not _collected_mappings:
            print("   Native tool-call flow did not complete; switching to programmatic SNOMED mapping.")
            run_programmatic_snomed_mapping()

    # -----------------------------------------------------------------
    # Return collected mappings
    # -----------------------------------------------------------------
    print(f"\n{'='*60}")
    print(f"AGENT 2 COMPLETE — {len(_collected_mappings)} mappings found")
    print(f"{'='*60}")
    for m in _collected_mappings:
        via = m.get('matched_via', '')
        gen = f" (generalized: {m.get('generalized_term')})" if m.get('generalized_term') else ""
        print(f"   {m.get('original_entity')} -> {m.get('fsn')} [{via}]{gen}")

    return {
        "input_text": input_text,
        "mappings": _collected_mappings,
        "retrieval_traces": _retrieval_traces,
    }


# =============================================================================
# Legacy compatibility
# =============================================================================
def map_entities_to_snomed(input_text: str, entities: list) -> dict:
    """Legacy function — delegates to run_snomed_agent."""
    return run_snomed_agent(input_text)
