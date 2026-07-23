"""FHIR bundle assembly for the medical text pipeline.

Agent 6 composes a FHIR R4 Bundle from patient metadata plus ontology mapping
outputs. The active path builds FHIR JSON deterministically in Python using the
local FHIR R4 schema, then validates and repairs the result against that schema.
An LLM can still be enabled for review/experimentation, but it is not trusted to
author the final Bundle by default.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import httpx
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TypedDict
import functools

from prompts import load_prompt
from langchain_core.tools import tool
from langchain_core.messages import HumanMessage
from langgraph.graph import StateGraph, END
from jsonschema import Draft6Validator
from llm_runtime import load_llm, resilient_llm_invoke
from schema_terminology_assets import get_fhir_schema_path


OUTPUT_DIR = Path(__file__).parent / "output"
FHIR_BUNDLE_DIR = OUTPUT_DIR / "fhir_bundles"
PROJECT_ROOT = Path(__file__).parent
FHIR_SCHEMA_PATH = get_fhir_schema_path()
USE_SCHEMA_FIRST_FHIR_COMPOSITION = os.getenv("AGENTIC_FHIR_SCHEMA_FIRST", "true").strip().lower() not in {
    "0",
    "false",
    "no",
    "off",
}
FHIR_SCHEMA_RAG_RESOURCE_LIMIT = int(os.getenv("AGENTIC_FHIR_SCHEMA_RAG_LIMIT", "6"))
FHIR_SCHEMA_RAG_PROPERTY_DETAIL_LIMIT = int(os.getenv("AGENTIC_FHIR_SCHEMA_RAG_PROPERTY_LIMIT", "8"))
FHIR_SCHEMA_INTENT_MIN_SCORE = int(os.getenv("AGENTIC_FHIR_INTENT_MIN_SCORE", "20"))
FHIR_SCHEMA_INTENT_MIN_MARGIN = int(os.getenv("AGENTIC_FHIR_INTENT_MIN_MARGIN", "8"))
LLM_TIMEOUT = int(os.getenv("LLM_TIMEOUT", "600"))
LLM_NUM_CTX = int(os.getenv("LLM_NUM_CTX", "8192"))
LLM_NUM_PREDICT = int(os.getenv("LLM_NUM_PREDICT", "8192"))
DEFAULT_DEIDENTIFIED_PATIENT_ID = os.getenv("AGENTIC_FHIR_DEFAULT_PATIENT_ID", "patient-001")
FHIR_GENERIC_FALLBACK_RESOURCE_TYPE = "Basic"
USE_LLM_FHIR_REVIEW = os.getenv("AGENTIC_FHIR_LLM_REVIEW", "true").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
USE_LLM_FHIR_RELATIONSHIP_AUDIT = os.getenv(
    "AGENTIC_FHIR_RELATIONSHIP_AUDIT",
    "true",
).strip().lower() in {"1", "true", "yes", "on"}
FHIR_REVIEW_TIMEOUT = int(os.getenv("AGENTIC_FHIR_REVIEW_TIMEOUT", "90"))
FHIR_REVIEW_NUM_PREDICT = int(os.getenv("AGENTIC_FHIR_REVIEW_NUM_PREDICT", "2048"))
USE_LLM_FHIR_AUTHORING = os.getenv("AGENTIC_FHIR_LLM_AUTHORING", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
ALLOW_PATIENT_PII_IN_FHIR = os.getenv("AGENTIC_FHIR_ALLOW_PATIENT_PII", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}


def _safe_name(value: str, fallback: str = "unknown") -> str:
    if not value:
        return fallback
    cleaned = re.sub(r"[^0-9A-Za-z]+", "_", str(value)).strip("_")
    return cleaned[:120] or fallback


def _load_json_payload(payload: str | dict | list | None) -> Any:
    if payload is None:
        return None
    if isinstance(payload, (dict, list)):
        return payload

    text = str(payload).strip()
    if not text:
        return None

    return json.loads(text)


def _extract_json_object(response_text: str) -> dict:
    """Extract the first complete JSON object from an LLM response."""
    text = str(response_text or "").strip()
    if "</think>" in text:
        text = text.split("</think>")[-1].strip()

    markdown_match = re.search(r"```(?:json)?(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if markdown_match:
        text = markdown_match.group(1).strip()

    if not text:
        raise ValueError("LLM returned empty JSON string")

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

    if not isinstance(payload, dict):
        raise ValueError("LLM JSON root must be an object")
    return payload


def _llm_endpoint_config() -> tuple[str, str]:
    model = os.environ.get("LLM_MODEL") or os.environ.get("OLLAMA_MODEL") or "gpt-oss:20b"
    base_url = os.environ.get("LLM_BASE_URL") or os.environ.get("OLLAMA_BASE_URL") or "http://10.10.17.55:80"
    return model, base_url.rstrip("/")


def _invoke_ollama_generate_json(
    prompt: str,
    *,
    json_mode: bool,
    timeout_seconds: int | None = None,
    num_predict: int | None = None,
) -> str:
    model, base_url = _llm_endpoint_config()
    payload: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "keep_alive": "5m",
        "options": {
            "num_ctx": LLM_NUM_CTX,
            "num_predict": num_predict or LLM_NUM_PREDICT,
        },
    }
    if json_mode:
        payload["format"] = "json"

    response = httpx.post(
        f"{base_url}/api/generate",
        json=payload,
        timeout=httpx.Timeout(timeout_seconds or LLM_TIMEOUT, connect=15.0),
    )
    response.raise_for_status()
    return str(response.json().get("response") or "").strip()


def _invoke_fhir_json_response(base_llm, prompt: str) -> str:
    """Call the FHIR composition LLM through multiple JSON-capable paths."""
    errors: list[str] = []
    llm_candidates = [("chat-json", base_llm)]
    try:
        llm_candidates.insert(0, ("chat-bound-json", base_llm.bind(format="json")))
    except Exception:
        pass

    for mode, llm in llm_candidates:
        try:
            response = resilient_llm_invoke(llm, [HumanMessage(content=prompt)])
            response_text = str(response.content or "").strip()
            print(f"     * Agent 6 {mode} response length: {len(response_text)} chars")
            if response_text:
                return response_text
            errors.append(f"{mode}: empty response")
        except Exception as exc:
            errors.append(f"{mode}: {exc}")
            print(f"     ! Agent 6 {mode} call failed: {exc}")

    for json_mode in (True, False):
        mode = "direct-generate-json" if json_mode else "direct-generate"
        try:
            response_text = _invoke_ollama_generate_json(prompt, json_mode=json_mode)
            print(f"     * Agent 6 {mode} response length: {len(response_text)} chars")
            if response_text:
                return response_text
            errors.append(f"{mode}: empty response")
        except Exception as exc:
            errors.append(f"{mode}: {exc}")
            print(f"     ! Agent 6 {mode} call failed: {exc}")

    raise ValueError("; ".join(errors) or "LLM returned empty JSON string")


def _extract_patient_records(payload: Any) -> list[dict]:
    if payload is None:
        return []

    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]

    if not isinstance(payload, dict):
        return []

    if payload.get("resourceType") == "Bundle":
        records: list[dict] = []
        for entry in payload.get("entry", []):
            resource = entry.get("resource", {}) if isinstance(entry, dict) else {}
            if isinstance(resource, dict) and resource.get("resourceType") == "Patient":
                records.append(resource)
        return records

    if payload.get("resourceType") == "Patient":
        return [payload]

    if isinstance(payload.get("patients"), list):
        return [item for item in payload["patients"] if isinstance(item, dict)]

    if payload.get("patient") and isinstance(payload["patient"], dict):
        return [payload["patient"]]

    return []


@functools.lru_cache(maxsize=1)
def _load_fhir_schema_definitions() -> dict:
    with open(FHIR_SCHEMA_PATH, "r", encoding="utf-8") as file_handle:
        schema = json.load(file_handle)
    return schema.get("definitions", {}) if isinstance(schema, dict) else {}


@functools.lru_cache(maxsize=1)
def _fhir_schema_resource_names() -> tuple[str, ...]:
    definitions = _load_fhir_schema_definitions()
    resource_list = definitions.get("ResourceList", {})
    names = []
    for item in resource_list.get("oneOf", []):
        ref = item.get("$ref") if isinstance(item, dict) else None
        if isinstance(ref, str) and ref.startswith("#/definitions/"):
            name = ref.rsplit("/", 1)[-1]
            if name in definitions:
                names.append(name)
    return tuple(names)


def _schema_tokenize(value: Any) -> set[str]:
    return {
        token.lower()
        for token in re.findall(r"[A-Za-z][A-Za-z0-9]+", str(value or ""))
        if len(token) > 2
    }


def _compact_schema_property(prop: dict) -> dict:
    compact: dict[str, Any] = {}
    if not isinstance(prop, dict):
        return compact

    description = str(prop.get("description") or "").strip()
    if description:
        compact["description"] = description[:60]
    if "const" in prop:
        compact["const"] = prop["const"]
    if "enum" in prop:
        compact["enum"] = prop["enum"]
    if "type" in prop:
        compact["type"] = prop["type"]
    if "$ref" in prop:
        compact["ref"] = str(prop["$ref"]).rsplit("/", 1)[-1]
    if isinstance(prop.get("items"), dict):
        items = prop["items"]
        item_info: dict[str, Any] = {}
        if "$ref" in items:
            item_info["ref"] = str(items["$ref"]).rsplit("/", 1)[-1]
        if "type" in items:
            item_info["type"] = items["type"]
        compact["items"] = item_info
    return compact


def _compact_schema_definition(name: str) -> dict:
    definition = _load_fhir_schema_definitions().get(name, {})
    properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
    required = definition.get("required", [])
    detailed_properties = {}
    for prop_name, prop_value in properties.items():
        if not isinstance(prop_value, dict):
            continue
        should_detail = (
            prop_name in required
            or prop_name in {"resourceType", "id"}
            or "enum" in prop_value
            or "const" in prop_value
        )
        if should_detail and len(detailed_properties) < FHIR_SCHEMA_RAG_PROPERTY_DETAIL_LIMIT:
            detailed_properties[prop_name] = _compact_schema_property(prop_value)

    return {
        "description": str(definition.get("description") or "").strip()[:100],
        "required": required,
        "property_names": list(properties.keys())[:24],
        "property_names_truncated": len(properties) > 24,
        "property_details": detailed_properties,
    }


def _mapping_resource_hints(mappings: list[dict]) -> set[str]:
    resource_names = set(_fhir_schema_resource_names())
    hints = {"Bundle", "Patient"}
    for mapping in mappings:
        if not isinstance(mapping, dict):
            continue
        ranked_candidates = _schema_ranked_resource_candidates_for_mapping(mapping)
        if ranked_candidates:
            hints.add(ranked_candidates[0])

        for value in mapping.values():
            if isinstance(value, str) and value in resource_names:
                hints.add(value)
    return hints


def _schema_resource_search_text(name: str, definition: dict) -> str:
    properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
    prop_text = " ".join(
        f"{prop_name} {prop.get('description', '')}"
        for prop_name, prop in properties.items()
        if isinstance(prop, dict)
    )
    return f"{name} {definition.get('description', '')} {prop_text}"


def _resource_hints_from_text(text: str, resource_names: tuple[str, ...]) -> set[str]:
    """Find exact FHIR resource names in validation feedback or model context."""
    source = str(text or "")
    return {name for name in resource_names if name in source}


def _retrieve_fhir_schema_context(
    input_text: str,
    mappings: list[dict],
    validation_feedback: str | None = None,
) -> dict:
    definitions = _load_fhir_schema_definitions()
    resource_names = _fhir_schema_resource_names()
    query_tokens = _schema_tokenize(
        " ".join(
            [
                input_text,
                json.dumps(mappings, default=str, ensure_ascii=False),
                validation_feedback or "",
            ]
        )
    )
    hinted_resources = _mapping_resource_hints(mappings)
    hinted_resources.update(_resource_hints_from_text(validation_feedback or "", resource_names))

    scored = []
    for name in resource_names:
        definition = definitions.get(name, {})
        candidate_tokens = _schema_tokenize(_schema_resource_search_text(name, definition))
        overlap = query_tokens & candidate_tokens
        score = len(overlap)
        name_tokens = _schema_tokenize(re.sub(r"(?<!^)([A-Z])", r" \1", name))
        if name_tokens and name_tokens <= query_tokens:
            score += 25
        if name in hinted_resources:
            score += 100
        if score >= 2 or name in hinted_resources:
            scored.append((score, name))

    selected = []
    for _score, name in sorted(scored, key=lambda item: (-item[0], item[1])):
        if name not in selected:
            selected.append(name)
        if len(selected) >= FHIR_SCHEMA_RAG_RESOURCE_LIMIT:
            break

    for required_name in sorted(hinted_resources):
        if required_name in definitions and required_name not in selected:
            selected.insert(0, required_name)

    datatype_names = [
        "CodeableConcept",
        "Coding",
        "Reference",
        "Identifier",
        "Quantity",
    ]

    return {
        "schema_source": str(FHIR_SCHEMA_PATH),
        "note": "Retrieved from local FHIR R4 schema. Skeleton metadata is structural guidance, not a resource-type limit.",
        "retrieved_resource_definitions": {
            name: _compact_schema_definition(name)
            for name in selected
            if name in definitions
        },
        "common_datatype_definitions": {
            name: _compact_schema_definition(name)
            for name in datatype_names
            if name in definitions
        },
    }


def _json_shape(value: Any, depth: int = 3) -> Any:
    if depth <= 0:
        if isinstance(value, dict):
            return "{...}"
        if isinstance(value, list):
            return ["..."]
        return type(value).__name__

    if isinstance(value, dict):
        shaped = {}
        for key, item in value.items():
            if item in ("", None, [], {}):
                shaped[key] = item
            else:
                shaped[key] = _json_shape(item, depth - 1)
        return shaped

    if isinstance(value, list):
        if not value:
            return []
        return [_json_shape(value[0], depth - 1)]

    if isinstance(value, str):
        if value.startswith(("http://", "https://", "urn:")):
            return value
        return "string"

    if isinstance(value, bool):
        return "boolean"

    if isinstance(value, (int, float)):
        return "number"

    return type(value).__name__


def _compact_bundle_entries(bundle: dict, limit: int | None = None, *, shape_only: bool = False) -> dict:
    """Keep FHIR guidance compact enough for local-model context windows."""
    if not isinstance(bundle, dict):
        return {}

    compact = {
        "resourceType": bundle.get("resourceType"),
        "type": bundle.get("type"),
        "entry": [],
    }
    entries = bundle.get("entry", [])
    if limit is not None:
        entries = entries[:limit]

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        resource = entry.get("resource")
        if not isinstance(resource, dict):
            continue
        compact_resource = _json_shape(resource, depth=3) if shape_only else resource
        compact["entry"].append(
            {
                "fullUrl": entry.get("fullUrl"),
                "resource": compact_resource,
            }
        )

    return compact


def _fhir_reference_prompt_context() -> str:
    """Return the schema-defined Bundle envelope without resource templates."""
    return json.dumps(
        {
            "bundle_envelope_shape": {
                "resourceType": "Bundle",
                "type": "collection",
                "entry": [
                    {
                        "fullUrl": "urn:uuid:<resource-id>",
                        "resource": {"resourceType": "<FHIR resource type>", "id": "<resource-id>"},
                    }
                ],
            },
        },
        ensure_ascii=False,
        indent=2,
    )


def _normalize_patient_name(name_value: Any) -> list[dict]:
    if isinstance(name_value, list):
        normalized = []
        for item in name_value:
            if isinstance(item, dict):
                normalized.append(item)
        return normalized

    if isinstance(name_value, dict):
        return [name_value]

    if isinstance(name_value, str) and name_value.strip():
        parts = name_value.strip().split()
        if len(parts) == 1:
            return [{"use": "official", "family": parts[0]}]
        return [{"use": "official", "family": parts[-1], "given": parts[:-1]}]

    return []


def _normalize_patient_record(patient: dict, index: int) -> dict:
    patient_id = str(patient.get("id") or patient.get("patient_id") or f"patient-{index:03d}")
    if not ALLOW_PATIENT_PII_IN_FHIR:
        resource = {
            "resourceType": "Patient",
            "id": f"patient-{index:03d}",
        }
        if "active" in patient:
            resource["active"] = bool(patient.get("active"))
        return resource

    resource = {
        "resourceType": "Patient",
        "id": patient_id,
    }
    if "active" in patient:
        resource["active"] = bool(patient.get("active"))

    name_value = patient.get("name")
    normalized_name = _normalize_patient_name(name_value)
    if normalized_name:
        resource["name"] = normalized_name

    if patient.get("gender"):
        resource["gender"] = patient["gender"]

    if patient.get("birthDate"):
        resource["birthDate"] = patient["birthDate"]

    if patient.get("telecom"):
        resource["telecom"] = patient["telecom"]

    if patient.get("identifier"):
        resource["identifier"] = patient["identifier"]

    return resource


def _select_patient_id(mapping: dict, default_patient_id: str) -> str:
    return str(
        mapping.get("patient_id")
        or mapping.get("subject_id")
        or mapping.get("patientId")
        or default_patient_id
    )


def _resource_type(mapping: dict) -> str:
    return str(mapping.get("fhir_resource_type") or "").strip()


def _camel_case_words(value: str) -> str:
    return re.sub(r"(?<!^)([A-Z])", r" \1", str(value or ""))


def _mapping_resource_candidate_names() -> tuple[str, ...]:
    infrastructure_resources = {"Bundle", "Patient", "Parameters", "OperationOutcome"}
    return tuple(
        name
        for name in _fhir_schema_resource_names()
        if name not in infrastructure_resources
        and _resource_has_mapping_fact_slot(name)
        and _resource_can_represent_extracted_fact(name)
    )


def _resource_has_mapping_fact_slot(resource_type: str) -> bool:
    """Return true when a resource has schema-declared slots for mapped codings."""
    definition = _load_fhir_schema_definitions().get(str(resource_type), {})
    properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
    return any(
        _property_expects_codeable_concept(prop_schema)
        or _property_expects_codeable_concept_array(prop_schema)
        or _property_expects_coding_array(prop_schema)
        for prop_schema in properties.values()
        if isinstance(prop_schema, dict)
    )


def _resource_patient_link_score(resource_type: str) -> int:
    """Score schema references that link a resource to the patient context."""
    definition = _load_fhir_schema_definitions().get(str(resource_type), {})
    properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
    patient_context_tokens = {"patient", "subject", "beneficiary"}
    score = 0
    for prop_name, prop_schema in properties.items():
        if not (
            _property_expects_reference(prop_schema)
            or _property_expects_reference_array(prop_schema)
        ):
            continue
        prop_tokens = _schema_tokenize(prop_name)
        if prop_tokens & patient_context_tokens:
            score += 3
        elif prop_name in definition.get("required", []):
            score += 1
    return score


def _resource_can_represent_extracted_fact(resource_type: str) -> bool:
    """Return true for resources that can carry patient-note facts.

    This is schema-shape based. FHIR also contains definitional terminology
    resources which have codes but describe vocabularies rather than a patient's
    clinical/admin fact. Those should not compete with patient-level resources
    during deterministic Bundle construction.
    """
    definition = _load_fhir_schema_definitions().get(str(resource_type), {})
    properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
    return any(
        _property_expects_reference(property_schema)
        or _property_expects_reference_array(property_schema)
        for property_schema in properties.values()
        if isinstance(property_schema, dict)
    )


def _resource_id_prefix(resource_type: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", _camel_case_words(resource_type).lower()).strip("-")


def _mapping_intent_tokens(mapping: dict) -> tuple[set[str], set[str]]:
    key_tokens: set[str] = set()
    value_tokens: set[str] = set()

    def add_value_tokens(value: Any) -> None:
        if value in (None, "", False, [], {}):
            return
        if isinstance(value, str):
            normalized = re.sub(r"\s+", " ", value).strip()
            if not normalized or len(re.findall(r"\w+", normalized)) > 12:
                return
            if re.search(r"[.!?]\s+\w", normalized):
                return
            value_tokens.update(_schema_tokenize(_camel_case_words(normalized)))
            return
        if isinstance(value, (int, float, bool)):
            value_tokens.update(_schema_tokenize(str(value)))
            return
        if isinstance(value, list):
            for item in value:
                add_value_tokens(item)
            return
        if isinstance(value, dict):
            for child_key, child_value in value.items():
                if str(child_key).startswith("_"):
                    continue
                key_tokens.update(_schema_tokenize(child_key))
                add_value_tokens(child_value)

    for key, value in mapping.items():
        if value in (None, "", False, [], {}):
            continue
        if str(key).startswith("_"):
            continue
        key_tokens.update(_schema_tokenize(key))
        add_value_tokens(value)
    return key_tokens, value_tokens


def _mapping_primary_intent_tokens(mapping: dict) -> set[str]:
    """Return tokens that describe the mapping's own fact, not related facts."""
    primary_values = (
        mapping.get("entity"),
        mapping.get("original_entity"),
        mapping.get("generalized_term"),
        mapping.get("snomed_name"),
        mapping.get("fsn"),
    )
    return _schema_tokenize(" ".join(str(value or "") for value in primary_values))


def _mapping_source_intent_tokens(mapping: dict) -> set[str]:
    """Return only source-facing fact tokens, excluding terminology hierarchy labels.

    Terminology displays may contain semantic tags such as a SNOMED hierarchy in
    parentheses. Those tags describe the ontology concept; they must not, by
    themselves, override a resource intent grounded in the source statement.
    """
    source_values = (
        mapping.get("entity"),
        mapping.get("original_entity"),
        mapping.get("generalized_term"),
    )
    return _schema_tokenize(" ".join(str(value or "") for value in source_values))


def _mapping_primary_field_tokens(mapping: dict, primary_tokens: set[str]) -> set[str]:
    """Return keys whose values describe the primary fact itself."""
    supported = set()
    for key, value in mapping.items():
        if value in (None, "", False, [], {}):
            continue
        if not isinstance(value, str):
            continue
        value_tokens = _schema_tokenize(value)
        if value_tokens and primary_tokens and value_tokens & primary_tokens:
            supported.update(_schema_tokenize(_camel_case_words(key)))
    return supported


def _resource_intent_score(resource_type: str, mapping: dict) -> int:
    definitions = _load_fhir_schema_definitions()
    if resource_type not in definitions:
        return -1

    primary_tokens = _mapping_primary_intent_tokens(mapping)
    key_tokens = _mapping_primary_field_tokens(mapping, primary_tokens)
    resource_name_tokens = _schema_tokenize(_camel_case_words(resource_type))
    definition = definitions.get(resource_type, {})
    description_tokens = _schema_tokenize(definition.get("description", ""))
    property_tokens = set()
    for property_name in definition.get("properties", {}):
        property_tokens.update(_schema_tokenize(_camel_case_words(property_name)))
    explicit = _resource_type(mapping)

    score = 0
    primary_name_overlap = primary_tokens & resource_name_tokens
    if (
        resource_name_tokens
        and len(primary_name_overlap) / len(resource_name_tokens) >= 0.5
    ):
        score += 36 * len(primary_name_overlap)
    key_name_overlap = key_tokens & resource_name_tokens
    if (
        resource_name_tokens
        and len(key_name_overlap) / len(resource_name_tokens) >= 0.5
    ):
        score += 24 * len(key_name_overlap)
    score += 2 * len(key_tokens & description_tokens)
    score += len(key_tokens & property_tokens)
    if explicit == resource_type:
        score += 15
    return score


def _mapping_without_resource_intent(mapping: dict) -> dict:
    item = dict(mapping)
    item.pop("fhir_resource_type", None)
    return item


def _schema_evidence_resource_candidates(mapping: dict) -> list[str]:
    """Rank resources without allowing a proposed type to validate itself."""
    return _schema_ranked_resource_candidates_for_mapping(
        _mapping_without_resource_intent(mapping)
    )


def _resource_name_is_fully_supported(resource_type: str, mapping: dict) -> bool:
    """Require complete schema resource-name evidence for deterministic overrides."""
    resource_tokens = _schema_tokenize(_camel_case_words(resource_type))
    if not resource_tokens:
        return False
    source_tokens = _mapping_source_intent_tokens(mapping)
    field_tokens = _mapping_primary_field_tokens(mapping, source_tokens)
    return resource_tokens <= (source_tokens | field_tokens)


def _validated_resource_intent(mapping: dict) -> str:
    """Validate proposed intent against independent mapping/schema evidence."""
    proposed = _resource_type(mapping)
    resource_names = set(_mapping_resource_candidate_names())
    if proposed and proposed not in resource_names:
        proposed_tokens = _schema_tokenize(_camel_case_words(proposed))
        contractions = [
            resource_type
            for resource_type in resource_names
            if _schema_tokenize(_camel_case_words(resource_type))
            and _schema_tokenize(_camel_case_words(resource_type)) < proposed_tokens
        ]
        extensions = [
            resource_type
            for resource_type in resource_names
            if proposed_tokens
            and proposed_tokens < _schema_tokenize(_camel_case_words(resource_type))
        ]
        if len(contractions) == 1:
            proposed = contractions[0]
        elif len(extensions) == 1:
            proposed = extensions[0]
    evidence_mapping = _mapping_without_resource_intent(mapping)
    candidates = _schema_evidence_resource_candidates(evidence_mapping)
    # A lexical/schema rank can place a definitional or more qualified resource
    # above the patient-level resource even when the mapping lacks every token
    # needed to support that qualified name. Skip unsupported candidates instead
    # of allowing the first one to block the next fully grounded schema choice.
    supported_candidates = [
        candidate
        for candidate in candidates
        if _resource_name_is_fully_supported(candidate, evidence_mapping)
        and _resource_intent_score(candidate, evidence_mapping) >= FHIR_SCHEMA_INTENT_MIN_SCORE
    ]
    top = supported_candidates[0] if supported_candidates else ""
    top_score = _resource_intent_score(top, evidence_mapping) if top else -1
    proposed_score = (
        _resource_intent_score(proposed, evidence_mapping)
        if proposed in resource_names
        else -1
    )

    if proposed in resource_names:
        if (
            top
            and top != proposed
            and _resource_name_is_fully_supported(top, evidence_mapping)
            and top_score >= FHIR_SCHEMA_INTENT_MIN_SCORE
            and top_score - proposed_score >= FHIR_SCHEMA_INTENT_MIN_MARGIN
        ):
            return top
        if proposed_score >= FHIR_SCHEMA_INTENT_MIN_SCORE:
            return proposed
        # A schema-constrained semantic review may resolve intent that lexical
        # schema evidence cannot. Accept it only when there is no strong conflict.
        if (
            not top
            or top_score < FHIR_SCHEMA_INTENT_MIN_SCORE
            or not _resource_name_is_fully_supported(top, evidence_mapping)
        ):
            return proposed

    if (
        top
        and top_score >= FHIR_SCHEMA_INTENT_MIN_SCORE
    ):
        next_score = (
            _resource_intent_score(supported_candidates[1], evidence_mapping)
            if len(supported_candidates) > 1
            else -1
        )
        if top_score - next_score >= FHIR_SCHEMA_INTENT_MIN_MARGIN:
            return top
    return ""


def _preferred_fhir_resource_type(mapping: dict, *, buildable_only: bool = False) -> str:
    """Pick the most specific schema-backed resource type for a mapping.

    This is structural FHIR routing: it scores official FHIR resource
    definitions against mapping field names/values. It does not check note
    phrases or specific clinical entities.
    """
    explicit = _resource_type(mapping)
    resource_names = set(_mapping_resource_candidate_names())
    if explicit in resource_names:
        return explicit

    candidate_resources = sorted(resource_names)
    scored = [
        (_resource_intent_score(resource_type, mapping), resource_type)
        for resource_type in candidate_resources
    ]
    scored = [(score, resource_type) for score, resource_type in scored if score >= 12]
    if scored:
        return sorted(scored, key=lambda item: (-item[0], item[1]))[0][1]
    return ""


def _mapping_prefers_resource(mapping: dict, resource_type: str) -> bool:
    return _preferred_fhir_resource_type(mapping, buildable_only=True) == resource_type


def _prefer_assertion_complete_mappings(mappings: list[dict]) -> list[dict]:
    """Drop base fallbacks superseded by a coded, assertion-complete mapping.

    Terminology search may retain both a context-preserving selection and the
    underlying base fallback for one source fact. Once a coded concept has
    verified that it carries the source assertion, the base concept cannot be
    placed beside it without changing the meaning of the CodeableConcept.
    """
    candidates = [dict(mapping) for mapping in mappings if isinstance(mapping, dict)]
    assertion_complete = [
        mapping
        for mapping in candidates
        if _mapping_encodes_source_negative_assertion(mapping)
    ]
    if not assertion_complete:
        return candidates

    return [
        mapping
        for mapping in candidates
        if _mapping_encodes_source_negative_assertion(mapping)
        or not any(
            _mappings_share_source_fact(mapping, complete_mapping)
            for complete_mapping in assertion_complete
        )
    ]


def _apply_fhir_intent_fallback(mappings: list[dict]) -> list[dict]:
    """Populate resource intent from existing mapper fields when Agent 6 is unavailable.

    This is deliberately based on schema-ranked mapping evidence, not input-text
    phrase matching or a curated entity/resource list.
    """
    corrected: list[dict] = []
    for mapping in _prefer_assertion_complete_mappings(mappings):
        item = dict(mapping)
        validated = _validated_resource_intent(item)
        if validated:
            item["fhir_resource_type"] = validated
        else:
            item.pop("fhir_resource_type", None)

        corrected.append(item)

    # Multiple terminology agents may map the same extracted mention to
    # complementary concepts. If exactly one resource intent is grounded for
    # that source fact, share it with the other mappings so their codes can be
    # reconciled on the same FHIR resource.
    for index, item in enumerate(corrected):
        if item.get("fhir_resource_type"):
            continue
        compatible_peer_types = {
            str(peer.get("fhir_resource_type") or "").strip()
            for peer in corrected
            if peer is not item
            and _mappings_share_source_fact(item, peer)
            and str(peer.get("fhir_resource_type") or "").strip()
        }
        if len(compatible_peer_types) == 1:
            item["fhir_resource_type"] = next(iter(compatible_peer_types))
    return corrected


def _mapping_source_fact_key(mapping: dict) -> str:
    """Return a normalized identity for the source mention behind a mapping."""
    if not isinstance(mapping, dict):
        return ""
    source_text = mapping.get("original_entity") or mapping.get("entity")
    return _schema_field_signature(source_text)


def _boolean_context_values(value: Any, path: tuple[str, ...] = ()) -> dict[tuple[str, ...], bool]:
    """Collect Boolean evidence recursively without maintaining a field list."""
    values: dict[tuple[str, ...], bool] = {}
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = (*path, str(key))
            if isinstance(child, bool):
                values[child_path] = child
            elif isinstance(child, (dict, list)):
                values.update(_boolean_context_values(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            child_path = (*path, str(index))
            if isinstance(child, bool):
                values[child_path] = child
            elif isinstance(child, (dict, list)):
                values.update(_boolean_context_values(child, child_path))
    return values


def _shared_boolean_context_is_compatible(left: dict, right: dict) -> bool:
    """Reject only explicit Boolean contradictions present in both mappings."""
    left_values = _boolean_context_values(left)
    right_values = _boolean_context_values(right)
    shared_paths = left_values.keys() & right_values.keys()
    return all(left_values[path] == right_values[path] for path in shared_paths)


def _mappings_share_source_fact(left: dict, right: dict) -> bool:
    """Return whether two mappings are compatible views of one source fact."""
    left_key = _mapping_source_fact_key(left)
    right_key = _mapping_source_fact_key(right)
    left_type = str(left.get("fhir_resource_type") or "").strip()
    right_type = str(right.get("fhir_resource_type") or "").strip()
    if left_type and right_type and left_type != right_type:
        return False

    if left_key and left_key == right_key:
        return _shared_boolean_context_is_compatible(left, right)

    # Extractors may emit both a contextual phrase and its underlying referent.
    # Consolidate them only when both explicitly carry the same negative source
    # assertion and one primary label fully contains the other's tokens.
    if not (
        left.get("source_assertion_negated") is True
        and right.get("source_assertion_negated") is True
    ):
        return False
    left_markers = _mapping_primary_text_markers(left)
    right_markers = _mapping_primary_text_markers(right)
    return any(
        (
            _schema_field_signature(left_marker)
            and _schema_field_signature(left_marker)
            == _schema_field_signature(right_marker)
        )
        or _token_overlap_match(left_marker, right_marker, min_overlap=1)
        or _token_overlap_match(right_marker, left_marker, min_overlap=1)
        for left_marker in left_markers
        for right_marker in right_markers
    )


def _build_codings(mapping: dict, fallback_display: str) -> list[dict]:
    codings = []
    snomed_code = mapping.get("snomed_code") or mapping.get("concept_id")
    if snomed_code:
        codings.append({"system": "http://snomed.info/sct", "code": str(snomed_code), "display": mapping.get("snomed_name") or mapping.get("fsn") or fallback_display})
    if mapping.get("icd10_code"):
        codings.append({"system": "http://hl7.org/fhir/sid/icd-10-cm", "code": str(mapping.get("icd10_code")), "display": mapping.get("icd10_name") or fallback_display})
    if mapping.get("loinc_code"):
        codings.append({"system": "http://loinc.org", "code": str(mapping.get("loinc_code")), "display": mapping.get("loinc_name") or fallback_display})
    if mapping.get("rxnorm_code"):
        codings.append({"system": "http://rxnorm.info/rxcui", "code": str(mapping.get("rxnorm_code")), "display": mapping.get("rxnorm_name") or fallback_display})
    return codings


def _canonical_coding(coding: dict) -> dict:
    normalized = dict(coding)
    system = str(normalized.get("system") or "").strip()
    if system == "http://rxnorm.info/rxcui":
        normalized["system"] = "http://www.nlm.nih.gov/research/umls/rxnorm"
    elif system == "http://hl7.org/fhir/sid/icd-10":
        normalized["system"] = "http://hl7.org/fhir/sid/icd-10-cm"
    return normalized


@functools.lru_cache(maxsize=1)
def _load_fhir_bundle_validator() -> Draft6Validator | None:
    with open(FHIR_SCHEMA_PATH, "r", encoding="utf-8") as file_handle:
        schema = json.load(file_handle)
    bundle_schema = {
        "$schema": schema.get("$schema"),
        "definitions": schema.get("definitions", {}),
        "$ref": "#/definitions/Bundle",
    }
    return Draft6Validator(bundle_schema)


def validate_fhir_bundle(bundle: dict) -> list[str]:
    """Validate the generated bundle against the local FHIR R4 JSON schema."""
    validator = _load_fhir_bundle_validator()
    if validator is None:
        return ["FHIR schema file not found; validation skipped."]
    errors = []
    for error in validator.iter_errors(bundle):
        path = ".".join(str(part) for part in error.path) or "<root>"
        errors.append(f"{path}: {error.message}")
        if len(errors) >= 10:
            break
    return errors


def _mapping_codes(mapping: dict) -> list[str]:
    return [code for _, code in _mapping_code_items(mapping)]


def _mapping_code_items(mapping: dict) -> list[tuple[str, str]]:
    items = []
    seen = set()
    for key, value in mapping.items():
        normalized_key = re.sub(r"[^a-z0-9]+", "_", str(key).lower()).strip("_")
        if normalized_key != "concept_id" and not normalized_key.endswith("_code"):
            continue
        if isinstance(value, (dict, list, tuple, set)):
            continue
        code = str(value or "").strip()
        if code and code not in seen:
            items.append((str(key), code))
            seen.add(code)
    return items


def _mapping_text_markers(mapping: dict) -> list[str]:
    markers = []
    for key, value in mapping.items():
        normalized_key = _schema_field_signature(key)
        if (
            not isinstance(value, str)
            or str(key).startswith("_")
            or normalized_key.endswith(("code", "id", "system"))
            or _display_like_score(value) < 0
        ):
            continue
        markers.append(value.strip())
    return markers


def _mapping_primary_text_markers(mapping: dict) -> list[str]:
    """Return labels for the mapping's primary fact, excluding related fields."""
    primary_keys = (
        "entity",
        "original_entity",
        "generalized_term",
        "snomed_name",
        "fsn",
        "loinc_name",
        "rxnorm_name",
        "icd10_name",
    )
    return [
        value.strip()
        for key in primary_keys
        if isinstance((value := mapping.get(key)), str) and value.strip()
    ]


def _token_overlap_match(left: str, right: str, *, min_overlap: int = 2, min_coverage: float = 1.0) -> bool:
    left_tokens = {
        token
        for token in re.findall(r"[a-z0-9]+", str(left or "").lower())
        if len(token) > 1
    }
    right_tokens = {
        token
        for token in re.findall(r"[a-z0-9]+", str(right or "").lower())
        if len(token) > 1
    }
    if not left_tokens or not right_tokens:
        return False
    overlap = left_tokens & right_tokens
    if len(overlap) < min_overlap:
        return False
    return len(overlap) / max(len(left_tokens), 1) >= min_coverage


def _resource_matches_mapping_evidence(resource: dict, mapping: dict) -> bool:
    return _resource_fact_slots_match_mapping(resource, mapping)


def _mapping_should_be_represented(mapping: dict) -> bool:
    if not isinstance(mapping, dict):
        return False
    if _mapping_codes(mapping):
        return True
    if mapping.get("fhir_resource_type"):
        return True
    if any(isinstance(value, bool) and value for value in mapping.values()):
        return True
    return bool(_mapping_primary_text_markers(mapping))


def _bundle_has_code_in_compatible_resource(bundle: dict, mapping: dict, code: str) -> bool:
    compatible_types = _mapping_compatible_resource_types(mapping)
    for entry in bundle.get("entry", []):
        if not isinstance(entry, dict):
            continue
        resource = entry.get("resource")
        if not isinstance(resource, dict):
            continue
        resource_type = str(resource.get("resourceType") or "")
        if (
            compatible_types
            and resource_type not in compatible_types
            and resource_type != FHIR_GENERIC_FALLBACK_RESOURCE_TYPE
        ):
            continue
        for concept in _existing_resource_fact_coding_containers(resource):
            for coding in concept.get("coding", []):
                if isinstance(coding, dict) and str(coding.get("code") or "").strip() == code:
                    return True
    return False


def _fhir_mapping_coverage_issues(bundle: dict, mappings: list[dict]) -> list[str]:
    """Find mapped facts that the composed bundle appears to have omitted."""
    bundle_text = json.dumps(bundle, default=str, ensure_ascii=False).lower()
    issues = []
    for index, mapping in enumerate(_compact_mappings_for_fhir(mappings), start=1):
        if not _mapping_should_be_represented(mapping):
            continue

        code_items = _mapping_code_items(mapping)
        missing_codes = [
            f"{key}={code}"
            for key, code in code_items
            if not _bundle_has_code_in_compatible_resource(bundle, mapping, code)
        ]
        if code_items and not missing_codes:
            continue

        text_markers = _mapping_text_markers(mapping)
        if not code_items and any(marker.lower() in bundle_text for marker in text_markers):
            continue

        label = (
            mapping.get("entity")
            or mapping.get("original_entity")
            or mapping.get("snomed_name")
            or mapping.get("fsn")
            or f"mapping {index}"
        )
        if missing_codes:
            issues.append(
                f"mapping {index} is missing mapped ontology code(s) in Bundle: "
                f"{label!r} ({', '.join(missing_codes)})."
            )
        else:
            issues.append(
                f"mapping {index} appears omitted from Bundle: {label!r} (no code)."
            )
        if len(issues) >= 8:
            break
    return issues


def _patient_context_for_prompt(patient_payload: str | dict | list | None) -> dict:
    payload = _load_json_payload(patient_payload)
    patient_records = _extract_patient_records(payload)
    if not patient_records:
        patient_records = [
            {
                "id": DEFAULT_DEIDENTIFIED_PATIENT_ID,
            }
        ]

    return {
        "raw_patient_payload": payload if ALLOW_PATIENT_PII_IN_FHIR else None,
        "patient_pii_policy": (
            "Patient metadata is passed through because AGENTIC_FHIR_ALLOW_PATIENT_PII is enabled."
            if ALLOW_PATIENT_PII_IN_FHIR
            else "Patient metadata is de-identified by default; do not include names, telecom, address, identifiers, or birthDate."
        ),
        "normalized_patients": [
            _normalize_patient_record(patient, index + 1)
            for index, patient in enumerate(patient_records)
        ],
    }


def _bundle_infrastructure(input_text: str, mappings: list[dict], patient_payload: str | dict | list | None) -> dict:
    seed = {
        "input_text": input_text,
        "mappings": mappings,
        "patient_payload": (
            _load_json_payload(patient_payload)
            if ALLOW_PATIENT_PII_IN_FHIR
            else _patient_context_for_prompt(patient_payload)["normalized_patients"]
        ),
    }
    bundle_hash = hashlib.sha256(
        json.dumps(seed, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:12]
    return {
        "bundle_id": f"bundle-{bundle_hash}",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _compact_mapping_value(value: Any, *, max_chars: int = 1800) -> Any:
    """Keep JSON-safe mapping data without maintaining a field allowlist."""
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
            compact_item = _compact_mapping_value(item, max_chars=max_chars)
            if compact_item not in (None, "", [], {}):
                compacted.append(compact_item)
        return compacted or None
    if isinstance(value, dict):
        compacted = {}
        for key, item in value.items():
            compact_item = _compact_mapping_value(item, max_chars=max_chars)
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


def _compact_mappings_for_fhir(mappings: list[dict]) -> list[dict]:
    """Compact mapping payloads by size/shape instead of field names."""
    compacted = []
    for mapping in mappings:
        if not isinstance(mapping, dict):
            continue
        item = {}
        for key, value in mapping.items():
            compact_value = _compact_mapping_value(value)
            if compact_value not in (None, "", [], {}):
                item[str(key)] = compact_value
        if item:
            compacted.append(item)
    return compacted


def _first_mapping_value(mappings: list[dict], keys: tuple[str, ...]) -> str:
    for mapping in mappings:
        if not isinstance(mapping, dict):
            continue
        for key in keys:
            value = mapping.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


def _first_grounded_mapping_field(mappings: list[dict], field_name: str) -> Any:
    for mapping in mappings:
        if not isinstance(mapping, dict):
            continue
        value = mapping.get(field_name)
        if value not in (None, "", [], {}):
            return value
    return None


def _schema_field_signature(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _grounded_value_for_schema_property(mappings: list[dict], prop_name: str) -> Any:
    prop_signature = _schema_field_signature(prop_name)
    if not prop_signature:
        return None

    def iter_fields(value: Any):
        if isinstance(value, dict):
            for key, child in value.items():
                if not str(key).startswith("_"):
                    yield key, child
                if isinstance(child, (dict, list)):
                    yield from iter_fields(child)
        elif isinstance(value, list):
            for child in value:
                if isinstance(child, (dict, list)):
                    yield from iter_fields(child)

    for mapping in mappings:
        if not isinstance(mapping, dict):
            continue
        for key, value in iter_fields(mapping):
            if _schema_field_signature(key) != prop_signature:
                continue
            if value not in (None, "", [], {}):
                return value
    return None


def _normalize_grounded_reference(value: Any) -> dict | None:
    if isinstance(value, dict):
        if value.get("reference") or value.get("display") or value.get("identifier"):
            return dict(value)
        return None
    if isinstance(value, str) and value.strip():
        text = value.strip()
        if "/" in text or text.startswith(("urn:", "http://", "https://")):
            return {"reference": text}
        return {"display": text}
    return None


def _codeable_concept_display(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    text = value.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    for coding in value.get("coding", []):
        if not isinstance(coding, dict):
            continue
        display = coding.get("display")
        if isinstance(display, str) and display.strip():
            return display.strip()
    return ""


def _display_like_score(value: str) -> int:
    text = str(value or "").strip()
    if not text:
        return -1
    lowered = text.lower()
    if lowered.startswith(("http://", "https://", "urn:")):
        return -1
    if re.fullmatch(r"[A-Z]?[0-9][A-Z0-9.\\-]*", text):
        return -1
    words = re.findall(r"[A-Za-z][A-Za-z0-9-]*", text)
    if not words:
        return -1
    if len(text) > 180 or len(words) > 14:
        return -1
    score = 10 * len(words)
    score += min(len(text), 80)
    if " " in text:
        score += 20
    if "(" in text and ")" in text:
        score += 10
    if len(words) == 1 and len(text) <= 3:
        score -= 30
    return score


def _iter_mapping_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, list):
        strings = []
        for item in value:
            strings.extend(_iter_mapping_strings(item))
        return strings
    if isinstance(value, dict):
        strings = []
        for item in value.values():
            strings.extend(_iter_mapping_strings(item))
        return strings
    return []


def _mapping_display(mapping: dict, *preferred_keys: str) -> str:
    for key in preferred_keys:
        value = mapping.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    candidates = [
        (score, index, text)
        for index, text in enumerate(_iter_mapping_strings(mapping))
        if (score := _display_like_score(text)) >= 0
    ]
    if not candidates:
        return ""
    return sorted(candidates, key=lambda item: (-item[0], item[1]))[0][2]


def _normalize_code_array(value: Any) -> list[str]:
    normalized = []
    if not isinstance(value, list):
        value = [value]
    for item in value:
        if isinstance(item, str) and item.strip():
            normalized.append(item.strip())
        elif isinstance(item, dict):
            code = item.get("code") or item.get("display") or item.get("text")
            if isinstance(code, str) and code.strip():
                normalized.append(code.strip().lower())
    return list(dict.fromkeys(normalized))


def _property_expects_reference(prop_schema: dict) -> bool:
    return isinstance(prop_schema, dict) and prop_schema.get("$ref") == "#/definitions/Reference"


def _property_expects_reference_array(prop_schema: dict) -> bool:
    if not isinstance(prop_schema, dict) or prop_schema.get("type") != "array":
        return False
    items = prop_schema.get("items")
    return isinstance(items, dict) and items.get("$ref") == "#/definitions/Reference"


def _property_expects_coding_array(prop_schema: dict) -> bool:
    if not isinstance(prop_schema, dict) or prop_schema.get("type") != "array":
        return False
    items = prop_schema.get("items")
    return isinstance(items, dict) and items.get("$ref") == "#/definitions/Coding"


def _property_expects_codeable_concept(prop_schema: dict) -> bool:
    return isinstance(prop_schema, dict) and prop_schema.get("$ref") == "#/definitions/CodeableConcept"


def _property_expects_codeable_concept_array(prop_schema: dict) -> bool:
    if not isinstance(prop_schema, dict) or prop_schema.get("type") != "array":
        return False
    items = prop_schema.get("items")
    return isinstance(items, dict) and items.get("$ref") == "#/definitions/CodeableConcept"


def _property_expects_narrative(prop_schema: dict) -> bool:
    """Return whether a schema property expects FHIR Narrative content."""
    return (
        isinstance(prop_schema, dict)
        and prop_schema.get("$ref") == "#/definitions/Narrative"
    )


def _normalize_codeable_concept(value: Any) -> dict | None:
    if isinstance(value, dict):
        concept = dict(value)
        if concept.get("coding") or concept.get("text"):
            return concept
        code = concept.get("code")
        if code:
            coding = {key: concept[key] for key in ("system", "code", "display") if concept.get(key)}
            return {"coding": [coding]}
        return None
    if isinstance(value, str) and value.strip():
        return {"text": value.strip()}
    return None


def _resource_codeable_concept_property_names(resource_type: str) -> list[str]:
    definition = _load_fhir_schema_definitions().get(str(resource_type), {})
    properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
    return [
        name
        for name, prop_schema in properties.items()
        if _property_expects_codeable_concept(prop_schema)
        or _property_expects_codeable_concept_array(prop_schema)
    ]


def _resource_coding_array_property_names(resource_type: str) -> list[str]:
    definition = _load_fhir_schema_definitions().get(str(resource_type), {})
    properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
    return [
        name
        for name, prop_schema in properties.items()
        if _property_expects_coding_array(prop_schema)
    ]


def _schema_reference_property_for_target(resource_type: str, target_resource_type: str) -> str:
    """Choose a target reference slot using only the official FHIR schema."""
    definition = _load_fhir_schema_definitions().get(str(resource_type), {})
    properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
    required = set(definition.get("required", [])) if isinstance(definition, dict) else set()
    target_tokens = _schema_tokenize(_camel_case_words(target_resource_type))
    if not target_tokens:
        return ""

    ranked = []
    required_reference_properties = []
    for position, (prop_name, prop_schema) in enumerate(properties.items()):
        if not (
            _property_expects_reference(prop_schema)
            or _property_expects_reference_array(prop_schema)
        ):
            continue
        if prop_name in required:
            required_reference_properties.append(prop_name)
        prop_tokens = _schema_tokenize(_camel_case_words(prop_name))
        description = str(prop_schema.get("description", ""))
        description_tokens = _schema_tokenize(description)
        name_overlap = len(target_tokens & prop_tokens)
        description_overlap = len(target_tokens & description_tokens)
        if not name_overlap and not description_overlap:
            continue
        description_lower = description.lower()
        target_mention_position = min(
            (
                match.start()
                for token in target_tokens
                if (match := re.search(rf"\b{re.escape(token)}s?\b", description_lower))
            ),
            default=len(description_lower) + 1,
        )
        ranked.append(
            (
                -name_overlap,
                -description_overlap,
                target_mention_position,
                -int(prop_name in required),
                position,
                prop_name,
            )
        )
    if ranked:
        return sorted(ranked)[0][5]
    if len(required_reference_properties) == 1:
        return required_reference_properties[0]
    return ""


def _set_schema_reference_to_target(
    resource: dict,
    target_resource_type: str,
    target_resource_id: str,
) -> dict:
    """Set a schema-supported context reference without replacing existing evidence."""
    resource_type = str(resource.get("resourceType") or "")
    prop_name = _schema_reference_property_for_target(resource_type, target_resource_type)
    if not prop_name or resource.get(prop_name) not in (None, "", [], {}):
        return resource

    definition = _load_fhir_schema_definitions().get(resource_type, {})
    properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
    reference = {"reference": f"{target_resource_type}/{target_resource_id}"}
    updated = dict(resource)
    updated[prop_name] = (
        [reference]
        if _property_expects_reference_array(properties.get(prop_name, {}))
        else reference
    )
    return updated


def _ensure_unique_bundle_context_references(bundle: dict, target_resource_type: str) -> dict:
    """Link resources to a unique Bundle context resource when their schemas support it."""
    entries = [entry for entry in bundle.get("entry", []) if isinstance(entry, dict)]
    targets = [
        entry.get("resource")
        for entry in entries
        if isinstance(entry.get("resource"), dict)
        and entry["resource"].get("resourceType") == target_resource_type
        and str(entry["resource"].get("id") or "").strip()
    ]
    if len(targets) != 1:
        return bundle

    target_id = str(targets[0]["id"])
    repaired = dict(bundle)
    repaired_entries = []
    for entry in entries:
        resource = entry.get("resource")
        if not isinstance(resource, dict) or resource.get("resourceType") == target_resource_type:
            repaired_entries.append(entry)
            continue
        updated_entry = dict(entry)
        updated_entry["resource"] = _set_schema_reference_to_target(
            resource,
            target_resource_type,
            target_id,
        )
        repaired_entries.append(updated_entry)
    repaired["entry"] = repaired_entries
    return repaired


def _mapping_identity_signatures(mapping: dict) -> set[str]:
    """Return exact normalized labels that may identify one extracted fact."""
    return {
        signature
        for key in ("entity", "original_entity", "generalized_term")
        if (signature := _schema_field_signature(mapping.get(key)))
    }


def _relationship_target_mapping(
    relationship: dict,
    mappings: list[dict],
) -> dict | None:
    """Resolve a grounded relationship target without fuzzy entity guessing."""
    target_entity = _schema_field_signature(relationship.get("target_entity"))
    target_type = str(relationship.get("target_resource_type") or "").strip()

    candidates: list[dict] = []
    try:
        target_index = int(relationship.get("target_mapping_index"))
    except (TypeError, ValueError):
        target_index = -1
    if 0 <= target_index < len(mappings):
        candidate = mappings[target_index]
        if target_entity and target_entity not in _mapping_identity_signatures(candidate):
            return None
        candidates = [candidate]
    elif target_entity:
        candidates = [
            mapping
            for mapping in mappings
            if target_entity in _mapping_identity_signatures(mapping)
        ]
    else:
        return None

    if target_type:
        candidates = [
            mapping
            for mapping in candidates
            if _validated_resource_intent(mapping) == target_type
        ]
    return candidates[0] if len(candidates) == 1 else None


def _resources_for_mapping(entries: list[dict], mapping: dict) -> list[dict]:
    """Find the Bundle resources that carry a mapping's primary fact."""
    resources = [
        entry.get("resource")
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("resource"), dict)
    ]
    preferred_type = _validated_resource_intent(mapping)
    exact = [
        resource
        for resource in resources
        if resource.get("resourceType") == preferred_type
        and _resource_fact_slots_match_mapping(resource, mapping)
    ]
    if exact:
        return exact
    return [
        resource
        for resource in resources
        if _resource_matches_mapping(resource, mapping)
    ]


def _relationship_property_name(properties: dict, requested_name: str) -> str:
    requested_signature = _schema_field_signature(requested_name)
    matches = [
        name
        for name in properties
        if _schema_field_signature(name) == requested_signature
    ]
    return matches[0] if len(matches) == 1 else ""


def _append_reference_value(value: Any, reference: dict) -> list[dict]:
    values = [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []
    target = reference.get("reference")
    if any(item.get("reference") == target for item in values):
        return values
    # A display-only placeholder is less precise than a resolved in-Bundle target.
    values = [item for item in values if item.get("reference")]
    values.append(reference)
    return values


def _apply_schema_relationship_reference(
    source: dict,
    relationship_path: str,
    target: dict,
) -> dict:
    """Apply a relationship only when its path is a schema-declared Reference slot."""
    source_type = str(source.get("resourceType") or "")
    target_type = str(target.get("resourceType") or "")
    target_id = str(target.get("id") or "")
    if not source_type or not target_type or not target_id:
        return source

    definitions = _load_fhir_schema_definitions()
    definition = definitions.get(source_type, {})
    properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
    path_parts = [part for part in str(relationship_path or "").split(".") if part]
    if not path_parts:
        return source
    prop_name = _relationship_property_name(properties, path_parts[0])
    if not prop_name:
        return source

    prop_schema = properties.get(prop_name, {})
    reference = {"reference": f"{target_type}/{target_id}"}
    updated = dict(source)
    if _property_expects_reference(prop_schema):
        current = updated.get(prop_name)
        if current in (None, "", {}, []) or not (
            isinstance(current, dict) and current.get("reference")
        ):
            updated[prop_name] = reference
        return updated
    if _property_expects_reference_array(prop_schema):
        updated[prop_name] = _append_reference_value(updated.get(prop_name), reference)
        return updated

    if prop_schema.get("type") != "array" or not isinstance(prop_schema.get("items"), dict):
        return source
    item_ref = str(prop_schema["items"].get("$ref") or "")
    if not item_ref.startswith("#/definitions/"):
        return source
    backbone_definition = definitions.get(item_ref.rsplit("/", 1)[-1], {})
    backbone_properties = (
        backbone_definition.get("properties", {})
        if isinstance(backbone_definition, dict)
        else {}
    )
    nested_name = ""
    if len(path_parts) > 1:
        nested_name = _relationship_property_name(backbone_properties, path_parts[1])
        if not _property_expects_reference(backbone_properties.get(nested_name, {})):
            return source
    else:
        reference_properties = [
            name
            for name, nested_schema in backbone_properties.items()
            if _property_expects_reference(nested_schema)
        ]
        if len(reference_properties) != 1:
            return source
        nested_name = reference_properties[0]

    current_items = [
        item for item in updated.get(prop_name, []) if isinstance(item, dict)
    ]
    if any(
        isinstance(item.get(nested_name), dict)
        and item[nested_name].get("reference") == reference["reference"]
        for item in current_items
    ):
        return updated
    current_items.append({nested_name: reference})
    updated[prop_name] = current_items
    return updated


def _compose_grounded_bundle_relationships(bundle: dict, mappings: list[dict]) -> dict:
    """Resolve explicitly extracted mapping relationships into FHIR references."""
    repaired = dict(bundle)
    entries = [entry for entry in repaired.get("entry", []) if isinstance(entry, dict)]
    compact_mappings = [
        mapping
        for mapping in _compact_mappings_for_fhir(mappings)
        if isinstance(mapping, dict)
    ]

    for source_mapping in compact_mappings:
        relationships = source_mapping.get("fhir_relationships")
        if not isinstance(relationships, list):
            continue
        for relationship in relationships:
            if not isinstance(relationship, dict):
                continue
            relationship_path = str(
                relationship.get("relationship")
                or relationship.get("property")
                or relationship.get("path")
                or ""
            ).strip()
            target_mapping = _relationship_target_mapping(relationship, compact_mappings)
            if not relationship_path or target_mapping is None:
                continue
            source_resources = _resources_for_mapping(entries, source_mapping)
            target_resources = _resources_for_mapping(entries, target_mapping)
            if len(source_resources) != 1 or len(target_resources) != 1:
                continue
            source_resource = source_resources[0]
            updated_resource = _apply_schema_relationship_reference(
                source_resource,
                relationship_path,
                target_resources[0],
            )
            if updated_resource is source_resource:
                continue
            for entry in entries:
                if entry.get("resource") is source_resource:
                    entry["resource"] = updated_resource
                    break

    repaired["entry"] = entries
    return repaired


def _ensure_unambiguous_encounter_practitioner_participants(bundle: dict) -> dict:
    """Connect unlinked practitioner roles when one Encounter target is unambiguous.

    This is a FHIR graph-completeness rule, not entity or phrase inference. If
    several otherwise equivalent Encounter targets remain, no assignment is
    made because choosing one would invent event-specific participation.
    """
    repaired = dict(bundle)
    entries = [entry for entry in repaired.get("entry", []) if isinstance(entry, dict)]
    encounters = [
        entry.get("resource")
        for entry in entries
        if isinstance(entry.get("resource"), dict)
        and entry["resource"].get("resourceType") == "Encounter"
        and str(entry["resource"].get("id") or "").strip()
    ]
    practitioner_roles = [
        entry.get("resource")
        for entry in entries
        if isinstance(entry.get("resource"), dict)
        and entry["resource"].get("resourceType") == "PractitionerRole"
        and str(entry["resource"].get("id") or "").strip()
    ]
    if not encounters or not practitioner_roles:
        return repaired

    referenced_role_ids = {
        str(individual.get("reference") or "").split("/", 1)[-1]
        for encounter in encounters
        for participant in encounter.get("participant", [])
        if isinstance(participant, dict)
        and isinstance((individual := participant.get("individual")), dict)
        and str(individual.get("reference") or "").startswith("PractitionerRole/")
    }
    unlinked_roles = [
        role
        for role in practitioner_roles
        if str(role.get("id")) not in referenced_role_ids
    ]
    if not unlinked_roles:
        return repaired

    if len(encounters) == 1:
        target_encounter = encounters[0]
    else:
        encounters_without_practitioner_participants = [
            encounter
            for encounter in encounters
            if not any(
                isinstance(participant, dict)
                and isinstance(participant.get("individual"), dict)
                and str(participant["individual"].get("reference") or "").startswith(
                    "PractitionerRole/"
                )
                for participant in encounter.get("participant", [])
            )
        ]
        if len(encounters_without_practitioner_participants) != 1:
            return repaired
        target_encounter = encounters_without_practitioner_participants[0]

    participants = [
        participant
        for participant in target_encounter.get("participant", [])
        if isinstance(participant, dict)
    ]
    participants.extend(
        {
            "individual": {
                "reference": f"PractitionerRole/{role['id']}",
            }
        }
        for role in unlinked_roles
    )
    target_encounter["participant"] = participants
    repaired["entry"] = entries
    return repaired


def _resource_reference_path_context(resource_type: str) -> list[dict[str, str]]:
    """Describe schema-declared reference paths for a focused relationship audit."""
    definitions = _load_fhir_schema_definitions()
    definition = definitions.get(str(resource_type), {})
    properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
    paths: list[dict[str, str]] = []
    for prop_name, prop_schema in properties.items():
        if _property_expects_reference(prop_schema) or _property_expects_reference_array(prop_schema):
            paths.append(
                {
                    "path": prop_name,
                    "description": str(prop_schema.get("description") or "")[:300],
                }
            )
            continue
        if not isinstance(prop_schema, dict) or prop_schema.get("type") != "array":
            continue
        items = prop_schema.get("items")
        item_ref = str(items.get("$ref") or "") if isinstance(items, dict) else ""
        if not item_ref.startswith("#/definitions/"):
            continue
        nested_definition = definitions.get(item_ref.rsplit("/", 1)[-1], {})
        nested_properties = (
            nested_definition.get("properties", {})
            if isinstance(nested_definition, dict)
            else {}
        )
        for nested_name, nested_schema in nested_properties.items():
            if _property_expects_reference(nested_schema):
                paths.append(
                    {
                        "path": f"{prop_name}.{nested_name}",
                        "description": str(nested_schema.get("description") or "")[:300],
                    }
                )
    return paths


def _relationship_evidence_is_grounded(input_text: str, evidence: Any) -> bool:
    note = re.sub(r"\s+", " ", str(input_text or "")).strip().casefold()
    quote = re.sub(r"\s+", " ", str(evidence or "")).strip().casefold()
    return bool(note and quote and len(quote) >= 8 and quote in note)


def _merge_grounded_relationship_audit(
    mappings: list[dict],
    input_text: str,
    payload: dict,
) -> list[dict]:
    """Merge only schema-valid relationships backed by an exact note excerpt."""
    corrected = [dict(mapping) for mapping in mappings if isinstance(mapping, dict)]
    relationships = payload.get("relationships") if isinstance(payload, dict) else None
    if not isinstance(relationships, list):
        return corrected

    for item in relationships:
        if not isinstance(item, dict) or not _relationship_evidence_is_grounded(
            input_text,
            item.get("evidence"),
        ):
            continue
        try:
            source_index = int(item.get("source_mapping_index"))
            target_index = int(item.get("target_mapping_index"))
        except (TypeError, ValueError):
            continue
        if (
            source_index == target_index
            or not 0 <= source_index < len(corrected)
            or not 0 <= target_index < len(corrected)
        ):
            continue

        relationship_path = str(item.get("relationship") or "").strip()
        source_type = _validated_resource_intent(corrected[source_index])
        target_type = _validated_resource_intent(corrected[target_index])
        if not relationship_path or not source_type or not target_type:
            continue
        source_probe = {"resourceType": source_type, "id": "source-probe"}
        target_probe = {"resourceType": target_type, "id": "target-probe"}
        if _apply_schema_relationship_reference(
            source_probe,
            relationship_path,
            target_probe,
        ) == source_probe:
            continue

        target_entity = str(
            corrected[target_index].get("entity")
            or corrected[target_index].get("original_entity")
            or ""
        ).strip()
        relationship = {
            "relationship": relationship_path,
            "target_mapping_index": target_index,
            "target_entity": target_entity,
            "target_resource_type": target_type,
        }
        existing = corrected[source_index].get("fhir_relationships")
        existing = [value for value in existing if isinstance(value, dict)] if isinstance(existing, list) else []
        signature = (
            _schema_field_signature(relationship_path),
            target_index,
        )
        if any(
            (
                _schema_field_signature(value.get("relationship") or value.get("path")),
                value.get("target_mapping_index"),
            ) == signature
            for value in existing
        ):
            continue
        corrected[source_index]["fhir_relationships"] = [*existing, relationship]
    return corrected


def _audit_grounded_mapping_relationships(
    llm,
    *,
    input_text: str,
    mappings: list[dict],
) -> list[dict]:
    """Run a narrow relationship-only review after resource intent is stable."""
    if len(mappings) < 2:
        return mappings
    mapping_context = [
        {
            "mapping_index": index,
            "entity": mapping.get("entity"),
            "original_entity": mapping.get("original_entity"),
            "fhir_resource_type": _validated_resource_intent(mapping),
        }
        for index, mapping in enumerate(mappings)
        if isinstance(mapping, dict)
    ]
    resource_types = list(
        dict.fromkeys(
            item["fhir_resource_type"]
            for item in mapping_context
            if item.get("fhir_resource_type")
        )
    )
    path_context = {
        resource_type: _resource_reference_path_context(resource_type)
        for resource_type in resource_types
    }
    prompt = (
        "Audit only the explicitly stated relationships between the indexed FHIR facts below. "
        "Do not change resource types or copy clinical fields. A relationship is eligible only when "
        "the note directly states that the two indexed facts participate in the same relationship. "
        "Mere co-occurrence, typical healthcare workflow, or world knowledge is not evidence. Use only "
        "a path listed for the source resource type. Preserve every explicitly stated participant or party. "
        "For evidence, copy an exact contiguous excerpt from the note that states the relationship. "
        "Return ONLY JSON as {\"relationships\":[{\"source_mapping_index\":0,"
        "\"relationship\":\"exact.path\",\"target_mapping_index\":1,"
        "\"evidence\":\"exact note excerpt\"}]}. Return an empty array when no relationship is explicit.\n\n"
        f"Note:\n{input_text}\n\n"
        f"Indexed facts:\n{json.dumps(mapping_context, ensure_ascii=False)}\n\n"
        f"Allowed reference paths by source type:\n{json.dumps(path_context, ensure_ascii=False)}"
    )
    try:
        response = resilient_llm_invoke(llm, [HumanMessage(content=prompt)])
        payload = _extract_json_object(str(response.content or ""))
        return _merge_grounded_relationship_audit(mappings, input_text, payload)
    except Exception as exc:
        print(f"     * Grounded relationship audit skipped: {exc}")
        return mappings


def _merge_grounded_patient_provider_interactions(
    mappings: list[dict],
    input_text: str,
    payload: dict,
) -> list[dict]:
    """Promote explicitly evidenced interaction events and attach their participants."""
    corrected = [dict(mapping) for mapping in mappings if isinstance(mapping, dict)]
    interactions = payload.get("interactions") if isinstance(payload, dict) else None
    if not isinstance(interactions, list):
        return corrected

    for interaction in interactions:
        if not isinstance(interaction, dict) or not _relationship_evidence_is_grounded(
            input_text,
            interaction.get("event_evidence"),
        ):
            continue
        try:
            event_index = int(interaction.get("event_mapping_index"))
        except (TypeError, ValueError):
            continue
        if not 0 <= event_index < len(corrected):
            continue

        participants = interaction.get("participants")
        if not isinstance(participants, list):
            continue
        grounded_participants: list[tuple[int, str]] = []
        for participant in participants:
            if not isinstance(participant, dict) or not _relationship_evidence_is_grounded(
                input_text,
                participant.get("evidence"),
            ):
                continue
            try:
                participant_index = int(participant.get("mapping_index"))
            except (TypeError, ValueError):
                continue
            if (
                participant_index == event_index
                or not 0 <= participant_index < len(corrected)
                or _validated_resource_intent(corrected[participant_index])
                != "PractitionerRole"
            ):
                continue
            grounded_participants.append(
                (participant_index, str(participant.get("evidence") or ""))
            )
        if not grounded_participants:
            continue

        corrected[event_index]["fhir_resource_type"] = "Encounter"
        corrected[event_index]["fhir_primary_code_property"] = "type"
        existing = corrected[event_index].get("fhir_relationships")
        existing = [value for value in existing if isinstance(value, dict)] if isinstance(existing, list) else []
        for participant_index, evidence in grounded_participants:
            if any(
                _schema_field_signature(value.get("relationship") or value.get("path"))
                == _schema_field_signature("participant.individual")
                and value.get("target_mapping_index") == participant_index
                for value in existing
            ):
                continue
            target_mapping = corrected[participant_index]
            existing.append(
                {
                    "relationship": "participant.individual",
                    "target_mapping_index": participant_index,
                    "target_entity": str(
                        target_mapping.get("entity")
                        or target_mapping.get("original_entity")
                        or ""
                    ).strip(),
                    "target_resource_type": "PractitionerRole",
                    "evidence": evidence,
                }
            )
        corrected[event_index]["fhir_relationships"] = existing
    return corrected


def _audit_grounded_patient_provider_interactions(
    llm,
    *,
    input_text: str,
    mappings: list[dict],
) -> list[dict]:
    """Identify explicit interaction events independently of the broad FHIR review."""
    practitioner_indexes = [
        index
        for index, mapping in enumerate(mappings)
        if isinstance(mapping, dict)
        and _validated_resource_intent(mapping) == "PractitionerRole"
    ]
    if not practitioner_indexes:
        return mappings
    mapping_context = [
        {
            "mapping_index": index,
            "entity": mapping.get("entity"),
            "original_entity": mapping.get("original_entity"),
            "current_fhir_resource_type": _validated_resource_intent(mapping),
        }
        for index, mapping in enumerate(mappings)
        if isinstance(mapping, dict)
    ]
    prompt = (
        "Identify only patient-provider interactions explicitly stated in the note. An interaction must "
        "have one indexed event fact and one or more indexed clinician/professional-role facts that the "
        "note explicitly says participated in that event. Do not infer participation merely because facts "
        "co-occur in the note or because a role commonly treats patients. For event_evidence, copy an exact "
        "contiguous note excerpt that establishes the event. For each participant evidence, copy an exact "
        "contiguous excerpt that states that role's participation. Use only the supplied mapping indexes. "
        "Return ONLY JSON as {\"interactions\":[{\"event_mapping_index\":0,"
        "\"event_evidence\":\"exact excerpt\",\"participants\":[{\"mapping_index\":1,"
        "\"evidence\":\"exact excerpt\"}]}]}. Return an empty interactions array if the relationship "
        "is not explicit.\n\n"
        f"Note:\n{input_text}\n\n"
        f"Indexed facts:\n{json.dumps(mapping_context, ensure_ascii=False)}"
    )
    try:
        response = resilient_llm_invoke(llm, [HumanMessage(content=prompt)])
        payload = _extract_json_object(str(response.content or ""))
        return _merge_grounded_patient_provider_interactions(
            mappings,
            input_text,
            payload,
        )
    except Exception as exc:
        print(f"     * Patient-provider interaction audit skipped: {exc}")
        return mappings


def _normalize_coding_array(value: Any) -> list[dict]:
    raw_items = value if isinstance(value, list) else [value]
    codings = []
    for item in raw_items:
        if isinstance(item, dict) and isinstance(item.get("coding"), list):
            codings.extend(coding for coding in item["coding"] if isinstance(coding, dict))
        elif isinstance(item, dict):
            codings.append(item)
        elif isinstance(item, str) and item.strip():
            codings.append({"display": item.strip()})
    return [
        _canonical_coding(coding)
        for coding in codings
        if coding.get("code") or coding.get("system") or coding.get("display")
    ]


def _property_item_enum(prop_schema: dict) -> set[str]:
    if not isinstance(prop_schema, dict):
        return set()
    items = prop_schema.get("items")
    if not isinstance(items, dict):
        return set()
    values = items.get("enum")
    if not isinstance(values, list):
        return set()
    return {str(value) for value in values}


def _property_value_matches_schema(
    prop_schema: dict,
    value: Any,
    definitions: dict,
) -> bool:
    """Return whether one property value has the shape declared by FHIR.

    The property schema is evaluated with the complete local definitions table
    so that this remains resource- and release-data driven.  In particular,
    this catches array/object shape mismatches introduced when mapping fields
    happen to share a name with a FHIR property.
    """
    if not isinstance(prop_schema, dict):
        return False
    validator = Draft6Validator(
        {
            "$schema": "http://json-schema.org/draft-06/schema#",
            "definitions": definitions,
            "allOf": [prop_schema],
        }
    )
    return validator.is_valid(value)


def _normalize_schema_shaped_resource(resource: dict, mappings: list[dict]) -> dict:
    definitions = _load_fhir_schema_definitions()
    resource_type = resource.get("resourceType")
    definition = definitions.get(str(resource_type), {})
    properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
    required = set(definition.get("required", [])) if isinstance(definition, dict) else set()
    normalized = {
        key: value
        for key, value in resource.items()
        if key in properties or key == "resourceType"
        if not (str(key).startswith("_") and not isinstance(value, (dict, list)))
    }
    for prop_name, prop_schema in properties.items():
        if prop_name in normalized or prop_name == "resourceType" or prop_name.startswith("_"):
            continue
        # A nested provenance field named ``text`` is not a FHIR Narrative.
        # Narrative is optional here, so leave it absent unless a complete,
        # schema-shaped Narrative was explicitly supplied on the resource.
        if _property_expects_narrative(prop_schema):
            continue
        grounded_value = _grounded_value_for_schema_property(mappings, prop_name)
        if grounded_value not in (None, "", [], {}):
            normalized[prop_name] = grounded_value

    for prop_name, prop_schema in properties.items():
        if prop_name not in normalized:
            continue

        if _property_expects_coding_array(prop_schema):
            codings = _normalize_coding_array(normalized.get(prop_name))
            if codings:
                normalized[prop_name] = codings
            else:
                normalized.pop(prop_name, None)
            continue

        if _property_expects_reference_array(prop_schema):
            references = []
            raw_references = normalized.get(prop_name)
            if not isinstance(raw_references, list):
                raw_references = [raw_references]
            for reference in raw_references:
                if isinstance(reference, dict) and (reference.get("reference") or reference.get("display")):
                    references.append(reference)
                elif isinstance(reference, str) and reference.strip():
                    references.append({"display": reference.strip()})
            if references:
                normalized[prop_name] = references
            else:
                normalized.pop(prop_name, None)
            continue

        if _property_expects_codeable_concept(prop_schema):
            concept = _normalize_codeable_concept(normalized.get(prop_name))
            if concept:
                normalized[prop_name] = concept
            else:
                normalized.pop(prop_name, None)
            continue

        if _property_expects_codeable_concept_array(prop_schema):
            raw_concepts = normalized.get(prop_name)
            if not isinstance(raw_concepts, list):
                raw_concepts = [raw_concepts]
            concepts = [
                concept
                for item in raw_concepts
                if (concept := _normalize_codeable_concept(item)) is not None
            ]
            if concepts:
                normalized[prop_name] = concepts
            else:
                normalized.pop(prop_name, None)
            continue

        allowed_item_codes = _property_item_enum(prop_schema)
        if allowed_item_codes:
            codes = [
                code
                for code in _normalize_code_array(normalized[prop_name])
                if code in allowed_item_codes
            ]
            if codes:
                normalized[prop_name] = codes
            else:
                normalized.pop(prop_name, None)

        enum_values = prop_schema.get("enum") if isinstance(prop_schema, dict) else None
        if isinstance(enum_values, list) and isinstance(normalized.get(prop_name), dict):
            code = normalized[prop_name].get("code")
            if isinstance(code, str) and code in enum_values:
                normalized[prop_name] = code
        elif isinstance(enum_values, list) and isinstance(normalized.get(prop_name), str):
            if normalized[prop_name] not in enum_values:
                normalized.pop(prop_name, None)

        # Mapping enrichment may supply a field whose name matches a FHIR
        # property while its JSON shape does not. Optional malformed values
        # must not make an otherwise representable resource fail as a whole.
        # Required values remain in place so validation reports missing or bad
        # required clinical data instead of silently discarding it.
        if (
            prop_name in normalized
            and prop_name not in required
            and not _property_value_matches_schema(
                prop_schema,
                normalized[prop_name],
                definitions,
            )
        ):
            normalized.pop(prop_name, None)

    for prop_name in required:
        if prop_name in normalized:
            continue
        prop_schema = properties.get(prop_name, {})
        if _property_expects_reference(prop_schema):
            reference = _normalize_grounded_reference(
                _first_grounded_mapping_field(mappings, prop_name)
            )
            if reference:
                normalized[prop_name] = reference
        elif _property_expects_reference_array(prop_schema):
            raw_references = _first_grounded_mapping_field(mappings, prop_name)
            if not isinstance(raw_references, list):
                raw_references = [raw_references] if raw_references not in (None, "", [], {}) else []
            references = [
                reference
                for item in raw_references
                if (reference := _normalize_grounded_reference(item)) is not None
            ]
            if references:
                normalized[prop_name] = references

    return normalized


def _prune_empty_values(value: Any) -> Any:
    if isinstance(value, dict):
        pruned = {}
        for key, child in value.items():
            cleaned = _prune_empty_values(child)
            if key in {"resourceType", "id"} or cleaned not in (None, "", [], {}):
                pruned[key] = cleaned
        return pruned
    if isinstance(value, list):
        return [
            cleaned
            for item in value
            if (cleaned := _prune_empty_values(item)) not in (None, "", [], {})
        ]
    return value


def _resource_codeable_concepts(resource: dict) -> list[dict]:
    resource_type = str(resource.get("resourceType") or "")
    concepts = []
    for prop_name in _resource_codeable_concept_property_names(resource_type):
        value = resource.get(prop_name)
        if isinstance(value, dict):
            concepts.append(value)
        elif isinstance(value, list):
            concepts.extend(item for item in value if isinstance(item, dict))
    return concepts


def _existing_resource_codeable_concepts(resource: dict) -> list[dict]:
    return _resource_codeable_concepts(resource)


def _existing_resource_fact_coding_containers(resource: dict) -> list[dict]:
    resource_type = str(resource.get("resourceType") or "")
    containers = list(_existing_resource_codeable_concepts(resource))
    for prop_name in _resource_coding_array_property_names(resource_type):
        value = resource.get(prop_name)
        if isinstance(value, list):
            codings = [item for item in value if isinstance(item, dict)]
            if codings:
                containers.append({"coding": codings})
        elif isinstance(value, dict):
            containers.append({"coding": [value]})
    return containers


def _resource_fact_slots_match_mapping(resource: dict, mapping: dict) -> bool:
    containers = _existing_resource_fact_coding_containers(resource)
    if not containers:
        return False

    resource_codes = {
        str(coding.get("code") or "").strip()
        for container in containers
        for coding in container.get("coding", [])
        if isinstance(coding, dict) and str(coding.get("code") or "").strip()
    }
    if resource_codes & set(_mapping_codes(mapping)):
        return True

    def fact_values() -> list[str]:
        values = []
        for container in containers:
            text = container.get("text")
            if isinstance(text, str):
                values.append(text)
            for coding in container.get("coding", []):
                if isinstance(coding, dict) and isinstance(coding.get("display"), str):
                    values.append(coding["display"])
        return values

    resource_values = fact_values()
    resource_signatures = {
        _schema_field_signature(value)
        for value in resource_values
        if _schema_field_signature(value)
    }
    if any(
        _schema_field_signature(marker) in resource_signatures
        for marker in _mapping_primary_text_markers(mapping)
        if _schema_field_signature(marker)
    ):
        return True

    # A composer may place assertion wording in CodeableConcept.text even
    # though the mapping correctly carries it in structured FHIR fields. Match
    # that resource to the underlying mapped referent only when both sides are
    # explicitly negative, then canonicalize the text later. This is generic
    # token containment; it does not depend on a clinical term or trigger word.
    resource_is_negative = bool(
        resource.get("valueBoolean") is False
        or any(
            isinstance(coding, dict)
            and str(coding.get("code") or "").strip() in {"N", "refuted"}
            for property_name in ("interpretation", "verificationStatus")
            for concept in (
                resource.get(property_name, [])
                if isinstance(resource.get(property_name), list)
                else [resource.get(property_name)]
            )
            if isinstance(concept, dict)
            for coding in concept.get("coding", [])
        )
    )
    if not (
        resource_is_negative
        and bool(mapping.get("source_assertion_negated") or mapping.get("negated"))
    ):
        return False
    return any(
        _token_overlap_match(marker, value, min_overlap=1)
        for marker in _mapping_primary_text_markers(mapping)
        for value in resource_values
    )


def _resource_matches_mapping(resource: dict, mapping: dict) -> bool:
    resource_type = str(resource.get("resourceType") or "")
    compatible_types = _mapping_compatible_resource_types(mapping)
    if resource_type == FHIR_GENERIC_FALLBACK_RESOURCE_TYPE:
        return _resource_fact_slots_match_mapping(resource, mapping)
    if not compatible_types or resource_type not in compatible_types:
        return False

    return _resource_fact_slots_match_mapping(resource, mapping)


def _resource_matches_mapping_group(
    resource: dict,
    mapping: dict,
    mappings: list[dict],
) -> bool:
    """Match a resource through any equivalent mapping of the same source fact."""
    if _resource_matches_mapping(resource, mapping):
        return True

    resource_type = str(resource.get("resourceType") or "")
    compatible_types = _mapping_compatible_resource_types(mapping)
    if compatible_types and resource_type not in compatible_types:
        return False

    return any(
        anchor is not mapping
        and _mappings_share_source_fact(anchor, mapping)
        and _resource_matches_mapping(resource, anchor)
        for anchor in mappings
        if isinstance(anchor, dict)
    )


def _mapping_compatible_resource_types(mapping: dict) -> set[str]:
    resource_names = set(_mapping_resource_candidate_names())
    explicit = str(mapping.get("fhir_resource_type") or "").strip()
    if explicit in resource_names:
        return {explicit}
    validated = _validated_resource_intent(mapping)
    return {validated} if validated in resource_names else set()


def _coding_key(coding: dict) -> tuple[str, str]:
    canonical = _canonical_coding(coding)
    return str(canonical.get("system") or ""), str(canonical.get("code") or "")


def _ensure_codeable_concept_codings(concept: dict, codings: list[dict]) -> None:
    canonical_existing = []
    existing = set()
    for coding in concept.get("coding", []):
        if not isinstance(coding, dict):
            continue
        canonical = _canonical_coding(coding)
        key = _coding_key(canonical)
        if key[1] and key not in existing:
            canonical_existing.append(canonical)
            existing.add(key)
    concept["coding"] = canonical_existing
    for coding in codings:
        canonical = _canonical_coding(coding)
        key = _coding_key(canonical)
        if key[1] and key not in existing:
            concept["coding"].append(canonical)
            existing.add(key)


def _allowed_primary_code_keys_for_resource(resource: dict, mappings: list[dict]) -> set[tuple[str, str]]:
    allowed = set()
    for mapping in mappings:
        if not _resource_matches_mapping_group(resource, mapping, mappings):
            continue
        for coding in _build_codings(mapping, str(mapping.get("entity") or "")):
            allowed.add(_coding_key(coding))
    return allowed


def _all_mapping_code_values(mappings: list[dict]) -> set[str]:
    values = set()
    for mapping in mappings:
        values.update(_mapping_codes(mapping))
    return values


def _remove_incompatible_primary_codings(bundle: dict, mappings: list[dict]) -> dict:
    all_mapping_codes = _all_mapping_code_values(mappings)
    for entry in bundle.get("entry", []):
        if not isinstance(entry, dict):
            continue
        resource = entry.get("resource")
        if not isinstance(resource, dict):
            continue
        allowed = _allowed_primary_code_keys_for_resource(resource, mappings)
        for concept in _resource_codeable_concepts(resource):
            filtered = []
            seen = set()
            for coding in concept.get("coding", []):
                if not isinstance(coding, dict):
                    continue
                canonical = _canonical_coding(coding)
                key = _coding_key(canonical)
                code = key[1]
                if code in all_mapping_codes and key not in allowed:
                    continue
                if code and key not in seen:
                    filtered.append(canonical)
                    seen.add(key)
            concept["coding"] = filtered
    return bundle


def _ensure_mapping_codings_in_bundle(bundle: dict, mappings: list[dict]) -> dict:
    """Preserve all mapped ontology codings on matching FHIR resources."""
    repaired = dict(bundle)
    compact_mappings = _compact_mappings_for_fhir(mappings)
    for entry in repaired.get("entry", []):
        if not isinstance(entry, dict):
            continue
        resource = entry.get("resource")
        if not isinstance(resource, dict):
            continue
        for mapping in compact_mappings:
            if not _resource_matches_mapping_group(resource, mapping, compact_mappings):
                continue
            primary_property = _primary_codeable_concept_property(
                str(resource.get("resourceType") or ""),
                mapping,
            )
            primary_value = resource.get(primary_property)
            if isinstance(primary_value, dict):
                concepts = [primary_value]
            elif isinstance(primary_value, list):
                concepts = [item for item in primary_value if isinstance(item, dict)]
            else:
                concepts = []
            if not concepts:
                continue
            display = (
                mapping.get("entity")
                or mapping.get("loinc_name")
                or mapping.get("rxnorm_name")
                or mapping.get("icd10_name")
                or mapping.get("snomed_name")
                or mapping.get("fsn")
                or ""
            )
            codings = _build_codings(mapping, str(display))
            if not codings:
                continue
            for concept in concepts:
                _ensure_codeable_concept_codings(concept, codings)
                if (
                    bool(mapping.get("source_assertion_negated") or mapping.get("negated"))
                    and not _mapping_encodes_source_negative_assertion(mapping)
                ):
                    source_display = _mapping_source_display(mapping)
                    if source_display:
                        concept["text"] = source_display
    repaired = _remove_incompatible_primary_codings(repaired, compact_mappings)
    return repaired


def _first_bundle_patient_id(bundle: dict) -> str:
    for entry in bundle.get("entry", []):
        if not isinstance(entry, dict):
            continue
        resource = entry.get("resource")
        if isinstance(resource, dict) and resource.get("resourceType") == "Patient":
            patient_id = str(resource.get("id") or "").strip()
            if patient_id:
                return patient_id
    return DEFAULT_DEIDENTIFIED_PATIENT_ID


def _collect_reference_targets(value: Any) -> set[tuple[str, str]]:
    resource_names = set(_fhir_schema_resource_names())
    targets: set[tuple[str, str]] = set()
    if isinstance(value, dict):
        reference = value.get("reference")
        if isinstance(reference, str) and "/" in reference and not reference.startswith(("http://", "https://", "urn:")):
            resource_type, resource_id = reference.split("/", 1)
            resource_type = resource_type.strip()
            resource_id = resource_id.strip()
            if resource_type in resource_names and resource_id:
                targets.add((resource_type, resource_id))
        for child in value.values():
            targets.update(_collect_reference_targets(child))
    elif isinstance(value, list):
        for child in value:
            targets.update(_collect_reference_targets(child))
    return targets


def _minimal_resource_for_reference(resource_type: str, resource_id: str) -> dict | None:
    definition = _load_fhir_schema_definitions().get(resource_type, {})
    required = set(definition.get("required", [])) if isinstance(definition, dict) else set()
    if required - {"resourceType", "id"}:
        return None
    return {
        "resourceType": resource_type,
        "id": resource_id,
    }


def _ensure_referenced_resource_entries(bundle: dict) -> dict:
    """Ensure safely buildable referenced resources have bundle entries."""
    repaired = dict(bundle)
    entries = [
        entry
        for entry in repaired.get("entry", [])
        if isinstance(entry, dict)
    ]
    existing_targets = set()
    for entry in entries:
        resource = entry.get("resource")
        if not isinstance(resource, dict):
            continue
        resource_type = str(resource.get("resourceType") or "").strip()
        resource_id = str(resource.get("id") or "").strip()
        if resource_type and resource_id:
            existing_targets.add((resource_type, resource_id))

    referenced_targets = _collect_reference_targets(entries)
    if not referenced_targets and ("Patient", DEFAULT_DEIDENTIFIED_PATIENT_ID) not in existing_targets:
        referenced_targets.add(("Patient", DEFAULT_DEIDENTIFIED_PATIENT_ID))

    missing_entries = []
    for resource_type, resource_id in sorted(referenced_targets):
        if (resource_type, resource_id) in existing_targets:
            continue
        resource = _minimal_resource_for_reference(resource_type, resource_id)
        if not resource:
            continue
        missing_entries.append(
            {
                "fullUrl": f"urn:uuid:{resource_type}-{_safe_name(resource_id)}",
                "resource": resource,
            }
        )

    repaired["entry"] = [*missing_entries, *entries]
    return repaired


def _next_resource_index(bundle: dict, resource_type: str, prefix: str) -> int:
    highest = 0
    for entry in bundle.get("entry", []):
        if not isinstance(entry, dict):
            continue
        resource = entry.get("resource")
        if not isinstance(resource, dict) or resource.get("resourceType") != resource_type:
            continue
        resource_id = str(resource.get("id") or "")
        match = re.search(rf"^{re.escape(prefix)}-(\d+)$", resource_id)
        if match:
            highest = max(highest, int(match.group(1)))
        else:
            highest += 1
    return highest + 1


def _make_entries_for_resource_type(
    resource_type: str,
    mapping: dict,
    patient_id: str,
    index: int,
) -> list[dict]:
    entry = _make_schema_shaped_mapping_entry(resource_type, mapping, patient_id, index)
    return [entry] if entry else []


def _resource_names_appearing_in_mapping_values(mapping: dict) -> list[str]:
    """Return schema-supported resource names found in mapping value evidence."""
    _, value_tokens = _mapping_intent_tokens(mapping)
    matches = []
    for resource_type in _mapping_resource_candidate_names():
        resource_tokens = _schema_tokenize(_camel_case_words(resource_type))
        if resource_tokens and resource_tokens <= value_tokens:
            matches.append(resource_type)
    return sorted(
        matches,
        key=lambda resource_type: (
            -_resource_intent_score(resource_type, mapping),
            -_resource_patient_link_score(resource_type),
            resource_type,
        ),
    )


def _schema_ranked_resource_candidates_for_mapping(mapping: dict, *, min_score: int = 12) -> list[str]:
    """Rank schema-supported patient resources from mapping keys and values."""
    if not isinstance(mapping, dict):
        return []

    resource_names = set(_mapping_resource_candidate_names())
    explicit = _resource_type(mapping)
    value_name_matches = set(_resource_names_appearing_in_mapping_values(mapping))
    candidates: list[tuple[tuple[int, int, int, int, str], str]] = []

    for resource_type in resource_names:
        score = _resource_intent_score(resource_type, mapping)
        explicit_match = int(resource_type == explicit)
        value_name_match = int(resource_type in value_name_matches)
        if not explicit_match and not value_name_match and score < min_score:
            continue
        rank = (
            -explicit_match,
            -value_name_match,
            -score,
            -_resource_patient_link_score(resource_type),
            resource_type,
        )
        candidates.append((rank, resource_type))

    return [resource_type for _, resource_type in sorted(candidates)]


def _primary_codeable_concept_property(resource_type: str, mapping: dict) -> str:
    """Choose the primary coded slot from schema and grounded mapping evidence."""
    property_names = _resource_codeable_concept_property_names(resource_type)
    if not property_names:
        return ""

    def is_context_slot(property_name: str) -> bool:
        tokens = _schema_tokenize(_camel_case_words(property_name))
        return bool(tokens & {"status", "reason", "category", "interpretation"})

    reviewed_property = str(mapping.get("fhir_primary_code_property") or "").strip()
    if reviewed_property in property_names and not is_context_slot(reviewed_property):
        return reviewed_property

    definition = _load_fhir_schema_definitions().get(resource_type, {})
    properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
    required = set(definition.get("required", [])) if isinstance(definition, dict) else set()
    mapping_tokens = _mapping_primary_intent_tokens(mapping)
    resource_tokens = _schema_tokenize(_camel_case_words(resource_type))
    ranked = []
    primary_property_names = [
        property_name
        for property_name in property_names
        if not is_context_slot(property_name)
    ] or property_names
    for position, property_name in enumerate(primary_property_names):
        property_schema = properties.get(property_name, {})
        descriptor_tokens = _schema_tokenize(
            f"{_camel_case_words(property_name)} {property_schema.get('description', '')}"
        )
        score = (
            20 * len(mapping_tokens & descriptor_tokens)
            + 8 * len(resource_tokens & descriptor_tokens)
            + 30 * int(property_name in required)
            + 60 * int(property_name == "code")
        )
        ranked.append((-score, position, property_name))
    return sorted(ranked)[0][2]


def _resource_has_required_fields(resource: dict) -> bool:
    definition = _load_fhir_schema_definitions().get(str(resource.get("resourceType") or ""), {})
    required = set(definition.get("required", [])) if isinstance(definition, dict) else set()
    return all(resource.get(prop_name) not in (None, "", [], {}) for prop_name in required)


def _complete_unique_grounded_required_reference(resource: dict, mapping: dict) -> dict:
    """Complete one unresolved required Reference using grounded mapping text.

    This is deliberately schema-driven: it does not name a resource or property.
    It applies only when the selected resource has exactly one required Reference
    left after patient linking and the mapping provides a usable source label.
    """
    resource_type = str(resource.get("resourceType") or "")
    definition = _load_fhir_schema_definitions().get(resource_type, {})
    properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
    required = set(definition.get("required", [])) if isinstance(definition, dict) else set()
    missing_reference_properties = [
        prop_name
        for prop_name in required
        if resource.get(prop_name) in (None, "", [], {})
        and (
            _property_expects_reference(properties.get(prop_name, {}))
            or _property_expects_reference_array(properties.get(prop_name, {}))
        )
    ]
    if len(missing_reference_properties) != 1:
        return resource

    display = _mapping_display(
        mapping,
        "original_entity",
        "entity",
        "generalized_term",
        "snomed_name",
        "fsn",
    )
    if not display:
        return resource

    prop_name = missing_reference_properties[0]
    reference = {"display": display}
    completed = dict(resource)
    completed[prop_name] = (
        [reference]
        if _property_expects_reference_array(properties.get(prop_name, {}))
        else reference
    )
    return completed


def _apply_grounded_negative_assertion_fields(resource: dict, mapping: dict) -> dict:
    """Represent external negation using assertion fields supported by the schema."""
    source_is_negative = bool(
        mapping.get("source_assertion_negated")
        or mapping.get("negated")
    )
    if not source_is_negative or _mapping_encodes_source_negative_assertion(mapping):
        return resource

    resource_type = str(resource.get("resourceType") or "")
    definition = _load_fhir_schema_definitions().get(resource_type, {})
    properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
    updated = dict(resource)

    verification_schema = properties.get("verificationStatus", {})
    if _property_expects_codeable_concept(verification_schema):
        updated["verificationStatus"] = {
            "coding": [{"code": "refuted", "display": "Refuted"}],
            "text": "Refuted",
        }

    value_boolean_schema = properties.get("valueBoolean", {})
    if isinstance(value_boolean_schema, dict) and value_boolean_schema.get("type") == "boolean":
        updated["valueBoolean"] = False

    interpretation_schema = properties.get("interpretation", {})
    if _property_expects_codeable_concept_array(interpretation_schema):
        updated["interpretation"] = [
            {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
                        "code": "N",
                        "display": "Negative",
                    }
                ],
                "text": "Negative",
            }
        ]

    return updated


def _mapping_encodes_source_negative_assertion(mapping: dict) -> bool:
    """Require coded, verified evidence before suppressing FHIR negation."""
    negation_type = mapping.get("negation_type")
    contextual_selection = (
        str(mapping.get("matched_via") or "").strip() == "contextual_search"
        and bool(str(mapping.get("generalized_term") or "").strip())
    )
    return bool(
        _mapping_codes(mapping)
        and mapping.get("source_assertion_negated") is True
        and mapping.get("assertion_encoded_by_concept") is True
        and (
            (isinstance(negation_type, str) and negation_type.strip())
            or contextual_selection
            or mapping.get("entity_text_encodes_terminology_context") is True
        )
    )


def _mapping_source_display(mapping: dict) -> str:
    """Return source-facing text while keeping ontology displays canonical."""
    if _mapping_encodes_source_negative_assertion(mapping):
        contextual_term = str(mapping.get("generalized_term") or "").strip()
        if (
            str(mapping.get("matched_via") or "").strip() == "contextual_search"
            and contextual_term
        ):
            return contextual_term
    return _mapping_display(
        mapping,
        "source_text",
        "original_entity",
        "entity",
        "generalized_term",
        "snomed_name",
        "fsn",
    )


def _complete_encounter_protocol_fields(resource: dict) -> dict:
    """Make a grounded Encounter minimally representable without inventing context.

    FHIR R4 requires Encounter.class and status. When the note establishes an
    interaction but does not state its class or lifecycle, data-absent-reason
    and the standard ``unknown`` status preserve that uncertainty explicitly.
    """
    if resource.get("resourceType") != "Encounter":
        return resource
    completed = dict(resource)
    completed.setdefault("status", "unknown")
    completed.setdefault(
        "class",
        {
            "extension": [
                {
                    "url": "http://hl7.org/fhir/StructureDefinition/data-absent-reason",
                    "valueCode": "unknown",
                }
            ]
        },
    )
    return completed


def _remove_redundant_external_assertions(bundle: dict, mappings: list[dict]) -> dict:
    """Prefer a terminology-encoded assertion over duplicate FHIR assertion fields."""
    repaired = dict(bundle)
    compact_mappings = [
        mapping
        for mapping in _compact_mappings_for_fhir(mappings)
        if isinstance(mapping, dict)
    ]
    for entry in repaired.get("entry", []):
        resource = entry.get("resource") if isinstance(entry, dict) else None
        if not isinstance(resource, dict):
            continue
        resource_codes = {
            str(coding.get("code") or "").strip()
            for concept in _existing_resource_fact_coding_containers(resource)
            for coding in concept.get("coding", [])
            if isinstance(coding, dict) and str(coding.get("code") or "").strip()
        }
        assertion_is_encoded = any(
            _mapping_encodes_source_negative_assertion(mapping)
            and bool(resource_codes & set(_mapping_codes(mapping)))
            and _resource_matches_mapping_group(resource, mapping, compact_mappings)
            for mapping in compact_mappings
        )
        if not assertion_is_encoded:
            continue
        resource.pop("verificationStatus", None)
        if resource.get("valueBoolean") is False:
            resource.pop("valueBoolean", None)
        interpretation = resource.get("interpretation")
        if isinstance(interpretation, list) and all(
            isinstance(concept, dict)
            and (
                str(concept.get("text") or "").strip().lower() == "negative"
                or any(
                    isinstance(coding, dict)
                    and str(coding.get("code") or "").strip() == "N"
                    for coding in concept.get("coding", [])
                )
            )
            for concept in interpretation
        ):
            resource.pop("interpretation", None)
    return repaired


def _make_schema_shaped_mapping_entry(
    resource_type: str,
    mapping: dict,
    patient_id: str,
    index: int,
) -> dict | None:
    """Build a minimal schema-shaped resource for mapped facts without a custom builder."""
    if resource_type not in _mapping_resource_candidate_names():
        return None

    display = _mapping_source_display(mapping)
    codings = _build_codings(mapping, display)
    concept_property = _primary_codeable_concept_property(resource_type, mapping)
    if not concept_property or (not display and not codings):
        return None

    definition = _load_fhir_schema_definitions().get(resource_type, {})
    properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
    concept: dict[str, Any] = {}
    if codings:
        concept["coding"] = codings
    if display:
        concept["text"] = display

    resource = {
        "resourceType": resource_type,
        "id": f"{_resource_id_prefix(resource_type)}-{index:03d}",
        concept_property: (
            [concept]
            if _property_expects_codeable_concept_array(properties.get(concept_property, {}))
            else concept
        ),
    }
    resource = _set_schema_reference_to_target(resource, "Patient", patient_id)
    resource = _complete_unique_grounded_required_reference(resource, mapping)
    resource = _apply_grounded_negative_assertion_fields(resource, mapping)
    resource = _complete_encounter_protocol_fields(resource)
    normalized = _normalize_schema_shaped_resource(resource, [mapping])
    normalized.setdefault("resourceType", resource_type)
    normalized.setdefault("id", resource["id"])

    if not _resource_has_required_fields(normalized):
        return None
    if not _resource_matches_mapping_evidence(normalized, mapping):
        return None
    return {
        "fullUrl": f"urn:uuid:{resource_type}-{normalized['id']}",
        "resource": normalized,
    }


def _deterministic_builder_candidates(mapping: dict) -> list[tuple[str, dict]]:
    """Return locally buildable FHIR resource intents for a mapping."""
    candidates: list[tuple[str, dict]] = []

    def add(resource_type: str) -> None:
        if resource_type not in _mapping_resource_candidate_names():
            return
        item = dict(mapping)
        item["fhir_resource_type"] = resource_type
        if not any(existing_type == resource_type for existing_type, _ in candidates):
            candidates.append((resource_type, item))

    resource_type = _validated_resource_intent(mapping)
    if resource_type:
        add(resource_type)

    return candidates


def _repair_preferred_resource_placement(bundle: dict, mappings: list[dict]) -> dict:
    """Move facts from generic resources to schema-preferred resources.

    This is a generic FHIR placement repair. It compares mapping fields against
    local FHIR schema resource definitions, then prevents a less suitable resource
    from standing in for a more specific schema-supported resource.
    """
    repaired = dict(bundle)
    compact_mappings = [
        mapping
        for mapping in _compact_mappings_for_fhir(mappings)
        if isinstance(mapping, dict)
    ]
    if not compact_mappings:
        return repaired

    patient_id = _first_bundle_patient_id(repaired)
    actionable: list[tuple[dict, str]] = []
    for mapping in compact_mappings:
        preferred = _validated_resource_intent(mapping)
        if not preferred:
            continue
        represented = any(
            isinstance(entry, dict)
            and isinstance(entry.get("resource"), dict)
            and entry["resource"].get("resourceType") == preferred
            and _resource_matches_mapping_group(
                entry["resource"],
                mapping,
                compact_mappings,
            )
            for entry in repaired.get("entry", [])
        )
        buildable = bool(_make_entries_for_resource_type(preferred, mapping, patient_id, 1))
        if represented or buildable:
            actionable.append((mapping, preferred))

    if not actionable:
        return repaired

    retained_entries = []
    for entry in repaired.get("entry", []):
        if not isinstance(entry, dict):
            continue
        resource = entry.get("resource")
        if not isinstance(resource, dict):
            retained_entries.append(entry)
            continue
        resource_type = str(resource.get("resourceType") or "")
        if any(
            resource_type != preferred and _resource_matches_mapping_evidence(resource, mapping)
            for mapping, preferred in actionable
        ):
            continue
        retained_entries.append(entry)

    repaired["entry"] = retained_entries

    for mapping, preferred in actionable:
        represented = any(
            isinstance(entry, dict)
            and isinstance(entry.get("resource"), dict)
            and entry["resource"].get("resourceType") == preferred
            and _resource_matches_mapping_group(
                entry["resource"],
                mapping,
                compact_mappings,
            )
            for entry in repaired.get("entry", [])
        )
        if represented:
            continue
        prefix = _resource_id_prefix(preferred)
        next_index = _next_resource_index(repaired, preferred, prefix)
        entries = _make_entries_for_resource_type(
            preferred,
            mapping,
            _select_patient_id(mapping, patient_id),
            next_index,
        )
        for generated_entry in entries:
            repaired.setdefault("entry", []).append(generated_entry)

    return repaired


def _ensure_buildable_mapping_resources(bundle: dict, mappings: list[dict]) -> dict:
    """Add omitted mapped facts when we can safely build their FHIR resource.

    This is a generic completeness repair: it relies on structured mapping
    fields, schema-selected resource intent, and local resource builders rather
    rather than phrase-specific or resource-specific rules.
    """
    repaired = dict(bundle)
    compact_mappings = [
        mapping
        for mapping in _compact_mappings_for_fhir(mappings)
        if isinstance(mapping, dict)
    ]
    if not compact_mappings:
        return repaired

    patient_id = _first_bundle_patient_id(repaired)
    for mapping in compact_mappings:
        for resource_type, builder_mapping in _deterministic_builder_candidates(mapping):
            if any(
                isinstance(entry, dict)
                and isinstance(entry.get("resource"), dict)
                and entry["resource"].get("resourceType") == resource_type
                and _resource_matches_mapping_group(
                    entry["resource"],
                    builder_mapping,
                    compact_mappings,
                )
                for entry in repaired.get("entry", [])
            ):
                break

            prefix = _resource_id_prefix(resource_type)
            next_index = _next_resource_index(repaired, resource_type, prefix)
            generated_entries = _make_entries_for_resource_type(
                resource_type,
                builder_mapping,
                _select_patient_id(builder_mapping, patient_id),
                next_index,
            )
            if not generated_entries:
                continue
            for generated_entry in generated_entries:
                repaired.setdefault("entry", []).append(generated_entry)
            break

    return repaired


def _ensure_generic_mapping_fallback_resources(bundle: dict, mappings: list[dict]) -> dict:
    """Represent remaining mapped facts with FHIR's schema-defined generic resource.

    FHIR R4 defines Basic for concepts that do not fit another resource. This
    fallback is applied only after schema-selected resource construction has
    run. It preserves ontology codings when present and otherwise retains the
    source fact as CodeableConcept text.
    """
    repaired = dict(bundle)
    compact_mappings = [
        mapping
        for mapping in _compact_mappings_for_fhir(mappings)
        if isinstance(mapping, dict)
    ]
    if FHIR_GENERIC_FALLBACK_RESOURCE_TYPE not in _mapping_resource_candidate_names():
        return repaired

    patient_id = _first_bundle_patient_id(repaired)
    prefix = _resource_id_prefix(FHIR_GENERIC_FALLBACK_RESOURCE_TYPE)
    for mapping in compact_mappings:
        code_items = _mapping_code_items(mapping)
        if code_items:
            missing_codes = {
                code
                for _, code in code_items
                if not _bundle_has_code_in_compatible_resource(repaired, mapping, code)
            }
            if not missing_codes:
                continue
        else:
            text_markers = _mapping_primary_text_markers(mapping)
            if not text_markers:
                continue
            bundle_text = json.dumps(repaired, default=str, ensure_ascii=False).lower()
            if any(marker.lower() in bundle_text for marker in text_markers):
                continue
            missing_codes = set()

        fallback_mapping = dict(mapping)
        for key, value in list(fallback_mapping.items()):
            normalized_key = re.sub(r"[^a-z0-9]+", "_", str(key).lower()).strip("_")
            if normalized_key == "concept_id" or normalized_key.endswith("_code"):
                if str(value or "").strip() not in missing_codes:
                    fallback_mapping.pop(key, None)

        next_index = _next_resource_index(
            repaired,
            FHIR_GENERIC_FALLBACK_RESOURCE_TYPE,
            prefix,
        )
        generated_entries = _make_entries_for_resource_type(
            FHIR_GENERIC_FALLBACK_RESOURCE_TYPE,
            fallback_mapping,
            _select_patient_id(fallback_mapping, patient_id),
            next_index,
        )
        repaired.setdefault("entry", []).extend(generated_entries)
    return repaired


def _drop_nonrepresentational_mapping_resources(bundle: dict, mappings: list[dict]) -> dict:
    """Remove resources that contain mapping evidence but cannot hold codings."""
    repaired = dict(bundle)
    compact_mappings = [
        mapping
        for mapping in _compact_mappings_for_fhir(mappings)
        if isinstance(mapping, dict)
    ]
    if not compact_mappings:
        return repaired

    retained_entries = []
    for entry in repaired.get("entry", []):
        if not isinstance(entry, dict):
            continue
        resource = entry.get("resource")
        if not isinstance(resource, dict):
            retained_entries.append(entry)
            continue
        resource_type = str(resource.get("resourceType") or "")
        matched_mappings = [
            mapping
            for mapping in compact_mappings
            if _resource_matches_mapping_evidence(resource, mapping)
        ]
        if matched_mappings and not any(
            resource_type in _mapping_compatible_resource_types(mapping)
            for mapping in matched_mappings
        ):
            continue
        if matched_mappings and not any(
            _resource_fact_slots_match_mapping(resource, mapping)
            for mapping in matched_mappings
        ):
            continue
        retained_entries.append(entry)

    repaired["entry"] = retained_entries
    return repaired


def _repair_fhir_schema_shape(bundle: dict, mappings: list[dict]) -> dict:
    """Apply schema-level FHIR R4 shape repairs before validation.

    These repairs are based on FHIR resource definitions, not clinical phrase
    matching. They correct common LLM JSON-shape mistakes by comparing each
    generated resource against its FHIR schema definition.
    """
    repaired = dict(bundle)
    entries = []
    intent_mappings = _apply_fhir_intent_fallback(mappings)
    compact_mappings = _compact_mappings_for_fhir(intent_mappings)

    for entry in repaired.get("entry", []):
        if not isinstance(entry, dict):
            continue
        resource = entry.get("resource")
        if not isinstance(resource, dict):
            entries.append(entry)
            continue

        resource_mappings = [
            mapping
            for mapping in compact_mappings
            if _resource_fact_slots_match_mapping(resource, mapping)
        ]
        entry = dict(entry)
        normalized_resource = _normalize_schema_shaped_resource(
            dict(resource),
            resource_mappings,
        )
        for mapping in resource_mappings:
            normalized_resource = _apply_grounded_negative_assertion_fields(
                normalized_resource,
                mapping,
            )
        entry["resource"] = normalized_resource
        entries.append(entry)

    repaired["entry"] = entries
    repaired = _drop_nonrepresentational_mapping_resources(repaired, intent_mappings)
    repaired = _repair_preferred_resource_placement(repaired, intent_mappings)
    repaired = _ensure_buildable_mapping_resources(repaired, intent_mappings)
    repaired = _ensure_generic_mapping_fallback_resources(repaired, intent_mappings)
    repaired = _ensure_mapping_codings_in_bundle(repaired, intent_mappings)
    repaired = _remove_redundant_external_assertions(repaired, intent_mappings)
    repaired = _compose_grounded_bundle_relationships(repaired, intent_mappings)
    repaired = _ensure_unambiguous_encounter_practitioner_participants(repaired)
    repaired = _ensure_unique_bundle_context_references(repaired, "Patient")
    repaired = _ensure_referenced_resource_entries(repaired)
    repaired = _prune_empty_values(repaired)
    return repaired


def _normalize_composed_bundle(bundle: dict, infrastructure: dict) -> dict:
    normalized = dict(bundle)
    normalized.setdefault("resourceType", "Bundle")
    normalized.setdefault("id", infrastructure["bundle_id"])
    normalized.setdefault("type", "collection")
    normalized.setdefault("timestamp", infrastructure["timestamp"])

    entries = []
    for index, entry in enumerate(normalized.get("entry", []), start=1):
        if not isinstance(entry, dict):
            continue
        resource = entry.get("resource")
        if not isinstance(resource, dict):
            continue
        resource_type = str(resource.get("resourceType") or "Resource")
        resource_id = str(resource.get("id") or f"{resource_type.lower()}-{index:03d}")
        resource["id"] = resource_id
        entry["resource"] = resource
        entry.setdefault("fullUrl", f"urn:uuid:{resource_type}-{resource_id}")
        entries.append(entry)
    normalized["entry"] = entries
    return normalized


def _bundle_has_error_operation_outcome(bundle: dict) -> bool:
    for entry in bundle.get("entry", []):
        resource = entry.get("resource") if isinstance(entry, dict) else None
        if not isinstance(resource, dict) or resource.get("resourceType") != "OperationOutcome":
            continue
        for issue in resource.get("issue", []):
            if isinstance(issue, dict) and issue.get("severity") in {"error", "fatal"}:
                return True
    return False


def _append_coverage_operation_outcome(bundle: dict, issues: list[str]) -> dict:
    """Record non-fatal completeness diagnostics inside an otherwise valid Bundle."""
    if not issues:
        return bundle
    repaired = dict(bundle)
    entries = list(repaired.get("entry", []))
    digest = hashlib.sha256(
        json.dumps(issues, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()[:12]
    resource_id = f"operation-outcome-{digest}"
    entries.append(
        {
            "fullUrl": f"urn:uuid:{resource_id}",
            "resource": {
                "resourceType": "OperationOutcome",
                "id": resource_id,
                "issue": [
                    {
                        "severity": "warning",
                        "code": "incomplete",
                        "diagnostics": issue,
                    }
                    for issue in issues
                ],
            },
        }
    )
    repaired["entry"] = entries
    return repaired


def _build_diagnostic_fhir_bundle(
    *,
    input_text: str,
    mappings: list[dict],
    diagnostics: list[str],
) -> dict:
    """Return a minimal valid FHIR Bundle when normal composition cannot finish.

    This is a transport-level fallback, not a clinical mapping fallback. It uses
    only standard FHIR Bundle and OperationOutcome fields so arbitrary mapping
    content cannot make the diagnostic artifact itself invalid.
    """
    normalized_diagnostics = []
    for diagnostic in diagnostics:
        text = re.sub(r"\s+", " ", str(diagnostic or "")).strip()
        if text:
            normalized_diagnostics.append(text[:2000])
    if not normalized_diagnostics:
        normalized_diagnostics = ["FHIR Bundle composition did not complete."]

    seed = {
        "input_text": str(input_text or ""),
        "mappings": mappings if isinstance(mappings, list) else [],
        "diagnostics": normalized_diagnostics,
    }
    digest = hashlib.sha256(
        json.dumps(seed, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:12]
    outcome_id = f"operation-outcome-{digest}"
    return {
        "resourceType": "Bundle",
        "id": f"bundle-{digest}",
        "type": "collection",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "entry": [
            {
                "fullUrl": f"urn:uuid:{outcome_id}",
                "resource": {
                    "resourceType": "OperationOutcome",
                    "id": outcome_id,
                    "issue": [
                        {
                            "severity": "error",
                            "code": "exception",
                            "diagnostics": diagnostic,
                        }
                        for diagnostic in normalized_diagnostics
                    ],
                },
            }
        ],
    }


def _replace_invalid_bundle_with_diagnostic(
    *,
    bundle: dict | None,
    input_text: str,
    mappings: list[dict],
    diagnostics_prefix: str,
) -> tuple[dict, list[str]]:
    """Keep only schema-valid output; convert invalid/missing output to diagnostics."""
    if not isinstance(bundle, dict) or not bundle:
        issues = [diagnostics_prefix]
    else:
        try:
            issues = validate_fhir_bundle(bundle)
        except Exception as exc:
            issues = [f"FHIR Bundle validation could not complete: {exc}"]

    if not issues:
        return bundle, []

    diagnostic_bundle = _build_diagnostic_fhir_bundle(
        input_text=input_text,
        mappings=mappings,
        diagnostics=[diagnostics_prefix, *issues],
    )
    return diagnostic_bundle, issues


def _build_deterministic_fhir_bundle(
    *,
    input_text: str,
    mappings: list[dict],
    patient_payload: str | dict | list | None,
) -> dict:
    """Build a valid best-effort Bundle from mappings without an Agent 6 JSON response."""
    effective_mappings = _apply_fhir_intent_fallback(mappings)
    infrastructure = _bundle_infrastructure(input_text, effective_mappings, patient_payload)
    patient_context = _patient_context_for_prompt(patient_payload)
    entries = [
        {
            "fullUrl": f"urn:uuid:{patient['id']}",
            "resource": patient,
        }
        for patient in patient_context["normalized_patients"]
    ]
    bundle = {
        "resourceType": "Bundle",
        "id": infrastructure["bundle_id"],
        "type": "collection",
        "timestamp": infrastructure["timestamp"],
        "entry": entries,
    }
    return _repair_fhir_schema_shape(bundle, effective_mappings)


def _compose_fhir_prompt(
    *,
    input_text: str,
    mappings: list[dict],
    patient_payload: str | dict | list | None,
    infrastructure: dict,
    previous_error: str | None = None,
) -> str:
    patient_context = _patient_context_for_prompt(patient_payload)
    fhir_mappings = _compact_mappings_for_fhir(mappings)
    reference_context = _fhir_reference_prompt_context()
    schema_context = _retrieve_fhir_schema_context(
        input_text,
        fhir_mappings,
        validation_feedback=previous_error,
    )

    repair_instruction = ""
    if previous_error:
        compact_feedback = re.sub(r"\s+", " ", str(previous_error)).strip()[:1500]
        repair_instruction = (
            "\nYour previous bundle failed local FHIR R4 validation or JSON parsing. "
            "Repair the bundle and return a complete replacement JSON object.\n"
            f"Validation/parsing feedback: {compact_feedback}\n"
        )

    return (
        f"{load_prompt('agent6_system')}\n\n"
        "Compose the final FHIR R4 Bundle JSON directly from the extracted mappings and patient context.\n"
        "Use the retrieved FHIR schema definitions for resource shape. Use skeleton metadata only for structural orientation, never as a resource-type limit.\n"
        "Use only facts supported by the input text, patient metadata, and mappings. Do not invent names, identifiers, dates, values, policies, or clinicians.\n"
        "Patient PII is de-identified by default. Do not include patient names, telecom, address, identifiers, or birthDate unless the patient context explicitly says PII pass-through is enabled.\n"
        "Do not use fixed phrase rules. Use the ontology codes, displays, and medspaCy/context flags already present in the mappings.\n"
        "If a mapping contains multiple ontology codes for the same fact, preserve every applicable coding in the same FHIR CodeableConcept instead of choosing only one system.\n"
        "Preserve every supplied ontology coding that belongs to the same mapped fact in that fact's schema-selected primary CodeableConcept.\n"
        "Represent every supported extracted fact using the most appropriate resource from the retrieved schema. Clinical, administrative, participant, assertion, and workflow facts are illustrative and non-exhaustive categories; do not treat them as a closed resource list.\n"
        "For every chosen resource type, follow its retrieved schema and populate required fields only from grounded mapping or patient-context evidence.\n"
        "When a terminology concept already encodes absence/refusal/negative meaning, do not double-negate it with a contradictory status.\n"
        "Every extracted mapping with a terminology code or FHIR resource intent must be represented in the Bundle unless another generated resource already carries that same code/fact. If a mapping has codes from several ontologies, every one of those codes must appear in the Bundle. This includes negated or absent observations/findings; they are mapped facts, not reasons to omit the resource.\n"
        "Preserve the provided de-identified patient reference and use the provided bundle id/timestamp.\n"
        "Keep the output compact: omit narratives, contained resources, empty arrays, empty objects, and optional fields that are not supported by the input.\n"
        "Return ONLY the final FHIR Bundle JSON object. No markdown. No explanation. No wrapper key.\n"
        f"{repair_instruction}\n"
        f"Required bundle infrastructure: {json.dumps(infrastructure, ensure_ascii=False)}\n\n"
        f"Retrieved FHIR schema context:\n{json.dumps(schema_context, ensure_ascii=False, indent=2)}\n\n"
        f"FHIR structural metadata:\n{reference_context}\n\n"
        f"Patient context:\n{json.dumps(patient_context, default=str, ensure_ascii=False, indent=2)}\n\n"
        f"Original input text:\n{input_text}\n\n"
    f"Extracted ontology/context mappings:\n{json.dumps(fhir_mappings, default=str, ensure_ascii=False, indent=2)}"
    )


def _fhir_prompt_diagnostics(
    input_text: str,
    mappings: list[dict],
    prompt: str,
    validation_feedback: str | None = None,
) -> dict:
    fhir_mappings = _compact_mappings_for_fhir(mappings)
    schema_context = _retrieve_fhir_schema_context(
        input_text,
        fhir_mappings,
        validation_feedback=validation_feedback,
    )
    return {
        "compact_mapping_count": len(fhir_mappings),
        "schema_resources": list(schema_context.get("retrieved_resource_definitions", {}).keys()),
        "prompt_chars": len(prompt),
        "approx_prompt_tokens": max(1, len(prompt) // 4),
    }


def _build_fhir_bundle_llm_authored(
    *,
    input_text: str,
    mappings: list[dict],
    patient_payload: str | dict | list | None = None,
) -> dict:
    """Experimental legacy path: ask the LLM to compose FHIR JSON."""
    llm = load_llm()
    effective_mappings = _apply_fhir_intent_fallback(mappings)
    infrastructure = _bundle_infrastructure(input_text, effective_mappings, patient_payload)
    previous_error: str | None = None
    last_bundle: dict | None = None

    print("     * Agent 6 schema-first mode: preparing FHIR schema RAG prompt...")
    print(f"     * Remote LLM target: {os.environ.get('LLM_MODEL', 'gpt-oss:20b')} @ {os.environ.get('LLM_BASE_URL', 'http://10.10.17.55:80')}")

    for attempt in range(1, 4):
        prompt = _compose_fhir_prompt(
            input_text=input_text,
            mappings=effective_mappings,
            patient_payload=patient_payload,
            infrastructure=infrastructure,
            previous_error=previous_error,
        )
        diagnostics = _fhir_prompt_diagnostics(
            input_text,
            effective_mappings,
            prompt,
            validation_feedback=previous_error,
        )
        print(
            "     * Agent 6 prompt ready "
            f"(attempt {attempt}/3, resources={diagnostics['schema_resources']}, "
            f"mappings={diagnostics['compact_mapping_count']}, "
            f"~{diagnostics['approx_prompt_tokens']} tokens)."
        )
        try:
            started = time.monotonic()
            print(f"     * Agent 6 calling remote LLM for FHIR JSON (attempt {attempt}/3)...")
            response_text = _invoke_fhir_json_response(llm, prompt)
            elapsed = time.monotonic() - started
            print(
                f"     * Agent 6 received LLM response in {elapsed:.1f}s "
                f"({len(response_text)} chars). Parsing JSON..."
            )
            payload = _extract_json_object(response_text)
            bundle = payload.get("bundle") if isinstance(payload.get("bundle"), dict) else payload
            if bundle.get("resourceType") != "Bundle":
                raise ValueError("FHIR response root must be resourceType Bundle")
            print("     * Agent 6 parsed Bundle JSON. Normalizing ids/fullUrls...")
            bundle = _normalize_composed_bundle(bundle, infrastructure)
            print("     * Agent 6 applying FHIR schema-shape normalization...")
            bundle = _repair_fhir_schema_shape(bundle, effective_mappings)
            print("     * Agent 6 validating Bundle against local FHIR R4 schema...")
            validation_errors = validate_fhir_bundle(bundle)
            coverage_errors = _fhir_mapping_coverage_issues(bundle, effective_mappings)
            last_bundle = bundle
            if not validation_errors and not coverage_errors:
                print(f"     * Agent 6 FHIR schema validation passed ({len(bundle.get('entry', []))} entries).")
                return bundle
            feedback = []
            if validation_errors:
                feedback.extend(re.sub(r"\s+", " ", err).strip()[:300] for err in validation_errors[:10])
            if coverage_errors:
                feedback.extend(re.sub(r"\s+", " ", err).strip()[:300] for err in coverage_errors[:8])
            previous_error = "; ".join(feedback)
            if validation_errors:
                print(
                    "     ! Agent 6 validation found issues; retrying with schema feedback: "
                    f"{'; '.join(validation_errors[:3])[:500]}"
                )
            if coverage_errors:
                print(
                    "     ! Agent 6 bundle omitted mapped facts; retrying with coverage feedback: "
                    f"{'; '.join(coverage_errors[:3])[:500]}"
                )
        except Exception as exc:
            previous_error = str(exc)
            print(
                f"     ! Agent 6 attempt {attempt}/3 failed during LLM/parse/validation: "
                f"{previous_error[:500]}"
            )

    if last_bundle is not None:
        print("     ! Agent 6 returning last parseable Bundle even though validation had issues.")
        return last_bundle

    print("     ! Agent 6 returned no parseable JSON; building deterministic Bundle from mappings.")
    fallback_bundle = _build_deterministic_fhir_bundle(
        input_text=input_text,
        mappings=effective_mappings,
        patient_payload=patient_payload,
    )
    validation_errors = validate_fhir_bundle(fallback_bundle)
    coverage_errors = _fhir_mapping_coverage_issues(fallback_bundle, effective_mappings)
    if validation_errors:
        raise RuntimeError(
            "Agent 6 could not compose parseable FHIR JSON and deterministic fallback "
            f"did not validate: {'; '.join(validation_errors[:5])}"
        )
    if coverage_errors:
        print(
            "     ! Deterministic fallback could not represent every mapped fact: "
            f"{'; '.join(coverage_errors[:5])[:500]}"
        )
    print(f"     * Deterministic FHIR fallback built {len(fallback_bundle.get('entry', []))} entries.")
    return fallback_bundle


def build_fhir_bundle_schema_first(
    *,
    input_text: str,
    mappings: list[dict],
    patient_payload: str | dict | list | None = None,
) -> dict:
    """Build a FHIR Bundle in Python using local schema-backed repairs."""
    if USE_LLM_FHIR_AUTHORING:
        print("     * Agent 6 LLM authoring enabled by AGENTIC_FHIR_LLM_AUTHORING=1.")
        return _build_fhir_bundle_llm_authored(
            input_text=input_text,
            mappings=mappings,
            patient_payload=patient_payload,
        )

    effective_mappings = _apply_fhir_intent_fallback(mappings)
    schema_context = _retrieve_fhir_schema_context(input_text, effective_mappings)
    retrieved_resources = list(schema_context.get("retrieved_resource_definitions", {}).keys())
    print("     * Agent 6 Python-first mode: local FHIR Bundle assembly.")
    print(
        "     * Retrieved local FHIR schema context "
        f"(resources={retrieved_resources}, mappings={len(_compact_mappings_for_fhir(effective_mappings))})."
    )
    print("     * Building resources with deterministic Python builders...")

    bundle = _build_deterministic_fhir_bundle(
        input_text=input_text,
        mappings=effective_mappings,
        patient_payload=patient_payload,
    )
    print("     * Applying schema-shape normalization and completeness repair...")
    bundle = _repair_fhir_schema_shape(bundle, effective_mappings)

    validation_errors = validate_fhir_bundle(bundle)
    if validation_errors:
        print(
            "     ! Python-first build still has validation issues after repair: "
            f"{'; '.join(validation_errors[:3])[:500]}"
        )
        raise RuntimeError(
            "Python-first FHIR build did not validate: "
            f"{'; '.join(validation_errors[:5])}"
        )

    coverage_errors = _fhir_mapping_coverage_issues(bundle, effective_mappings)
    if coverage_errors:
        print(
            "     ! Python-first build retained non-fatal completeness warnings: "
            f"{'; '.join(coverage_errors[:5])[:500]}"
        )
        bundle = _append_coverage_operation_outcome(bundle, coverage_errors)
        diagnostic_validation_errors = validate_fhir_bundle(bundle)
        if diagnostic_validation_errors:
            raise RuntimeError(
                "FHIR completeness diagnostics did not validate: "
                f"{'; '.join(diagnostic_validation_errors[:5])}"
            )
    else:
        print("     * Python-first completeness check passed for mapped ontology codes.")

    print(f"     * Python-first FHIR build passed schema validation ({len(bundle.get('entry', []))} entries).")
    return bundle


def review_generated_fhir_bundle(
    *,
    input_text: str,
    mappings: list[dict],
    bundle: dict,
) -> dict:
    """LLM-assisted, non-authoritative review of a Python-built FHIR Bundle."""
    validation_errors = validate_fhir_bundle(bundle)
    effective_mappings = _apply_fhir_intent_fallback(mappings)
    coverage_errors = _fhir_mapping_coverage_issues(bundle, effective_mappings)

    base_review = {
        "llm_review_used": False,
        "summary": "Python schema validation and coverage checks completed.",
        "warnings": [],
        "issues": [],
        "python_validation_errors": validation_errors,
        "python_coverage_warnings": coverage_errors,
    }

    if not USE_LLM_FHIR_REVIEW:
        base_review["summary"] = "LLM FHIR review disabled; Python validation/coverage checks completed."
        return base_review

    compact_bundle = _compact_bundle_entries(bundle, shape_only=False)
    compact_mappings = _compact_mappings_for_fhir(effective_mappings)
    schema_context = _retrieve_fhir_schema_context(input_text, effective_mappings)
    review_prompt = (
        "You are Agent 6's FHIR semantic review component.\n"
        "The FHIR Bundle has already been built by deterministic Python code and validated locally.\n"
        "Your role is review only: do not rewrite the Bundle, do not output FHIR JSON, and do not invent missing facts.\n"
        "Compare the original text, ontology/context mappings, Python validation result, semantic coverage warnings, and generated Bundle.\n"
        "Flag only issues supported by the provided evidence, such as omitted mapped facts, wrong resource placement, missing coding systems, contradictory negation/refusal handling, or unsupported invented data.\n"
        "Return ONLY valid JSON with this shape:\n"
        "{\n"
        "  \"summary\": \"string\",\n"
        "  \"passed\": true,\n"
        "  \"issues\": [\n"
        "    {\n"
        "      \"severity\": \"info|warning|error\",\n"
        "      \"entity\": \"string or null\",\n"
        "      \"resourceType\": \"string or null\",\n"
        "      \"concern\": \"string\",\n"
        "      \"evidence\": \"string\",\n"
        "      \"suggested_python_check\": \"string or null\"\n"
        "    }\n"
        "  ],\n"
        "  \"warnings\": [\"string\"]\n"
        "}\n\n"
        f"Retrieved FHIR schema resources: {list(schema_context.get('retrieved_resource_definitions', {}).keys())}\n\n"
        f"Original input text:\n{input_text}\n\n"
        f"Ontology/context mappings:\n{json.dumps(compact_mappings, default=str, ensure_ascii=False, indent=2)}\n\n"
        f"Generated Bundle:\n{json.dumps(compact_bundle, default=str, ensure_ascii=False, indent=2)}\n\n"
        f"Python validation errors:\n{json.dumps(validation_errors, ensure_ascii=False)}\n\n"
        f"Python semantic coverage warnings:\n{json.dumps(coverage_errors, ensure_ascii=False)}"
    )

    try:
        print("     * Agent 6 LLM semantic review starting (non-authoritative)...")
        started = time.monotonic()
        response_text = _invoke_ollama_generate_json(
            review_prompt,
            json_mode=True,
            timeout_seconds=FHIR_REVIEW_TIMEOUT,
            num_predict=FHIR_REVIEW_NUM_PREDICT,
        )
        elapsed = time.monotonic() - started
        print(
            f"     * Agent 6 LLM semantic review returned in {elapsed:.1f}s "
            f"({len(response_text)} chars)."
        )
        payload = _extract_json_object(response_text)
        issues = payload.get("issues", [])
        if not isinstance(issues, list):
            issues = []
        warnings = payload.get("warnings", [])
        if not isinstance(warnings, list):
            warnings = []
        return {
            **base_review,
            "llm_review_used": True,
            "summary": str(payload.get("summary") or "LLM semantic review completed.").strip(),
            "passed": bool(payload.get("passed", not issues and not warnings)),
            "warnings": [str(item) for item in warnings[:8]],
            "issues": [item for item in issues[:12] if isinstance(item, dict)],
        }
    except Exception as exc:
        diagnostic = f"LLM semantic review unavailable; Python-built Bundle remained authoritative: {exc}"
        print(f"     * Optional Agent 6 semantic review skipped: {exc}")
        return {
            **base_review,
            "summary": "Optional LLM semantic review unavailable; Python validation and completeness checks remain authoritative.",
            "review_diagnostic": diagnostic,
        }


class Agent5State(TypedDict):
    input_text: str
    mappings: list[dict]
    patient_payload: str | dict | list | None
    bundle: dict | None
    bundle_path: str | None
    review_summary: dict | None
    build_error: str | None
    logs: list[str]


def _complete_schema_required_mapping_fields(
    llm,
    *,
    input_text: str,
    mapping: dict,
    patient_payload: str | dict | list | None,
) -> dict:
    """Align one mapping to its selected resource schema without resource rules."""
    item = dict(mapping)
    resource_type = _validated_resource_intent(item)
    if not resource_type:
        return item
    item["fhir_resource_type"] = resource_type

    definition = _load_fhir_schema_definitions().get(resource_type, {})
    properties = definition.get("properties", {}) if isinstance(definition, dict) else {}
    codeable_properties = _resource_codeable_concept_property_names(resource_type)
    patient_context = _patient_context_for_prompt(patient_payload)

    required = [
        name
        for name in definition.get("required", [])
        if name not in {"resourceType", "id"}
    ]
    if not properties or not codeable_properties:
        return item

    resource_schema = {
        name: _compact_schema_property(property_schema)
        for name, property_schema in properties.items()
        if name not in {"resourceType", "id"} and not name.startswith("_")
    }
    prompt = (
        "Align this one mapped fact to the selected FHIR R4 resource definition. Use the note and mapping "
        "as the only semantic evidence. Select exactly one primary_code_property from the supplied "
        "CodeableConcept properties; it must be the property whose schema meaning represents the mapped "
        "fact itself, not a category, reason, status, interpretation, or related fact. Use exact "
        "schema property names and schema-compatible JSON shapes. Mapping fields may use different wording "
        "from the schema; align them by grounded semantic meaning rather than requiring an exact key-name "
        "match. References to a grounded party may use "
        "a display value when no resource identifier is present. Patient references may use the supplied "
        "de-identified Patient id. Do not invent status, identity, organization, relationship, or clinical "
        "facts. Preserve assertion/context using schema fields only when grounded, and do not duplicate "
        "meaning already encoded by the terminology concept. When assertion meaning is carried externally "
        "because the selected terminology concept does not encode it, populate every compatible schema "
        "field needed to communicate that assertion unambiguously. Do not treat one Boolean or status field "
        "as complete when the schema also provides a categorical interpretation/assertion CodeableConcept "
        "for the same grounded meaning. Use the correct standard coding for such a field. If a field is not "
        "grounded, omit it. Return "
        "ONLY JSON as {\"primary_code_property\":\"schema_property\","
        "\"fields\":{\"schema_property\":\"value\"}}.\n\n"
        f"Note:\n{input_text}\n\n"
        f"Mapping:\n{json.dumps(item, ensure_ascii=False, default=str)}\n\n"
        f"Resource type:\n{resource_type}\n\n"
        f"Resource description:\n{definition.get('description', '')}\n\n"
        f"Required properties:\n{json.dumps(required, ensure_ascii=False)}\n\n"
        f"Eligible primary CodeableConcept properties:\n{json.dumps(codeable_properties, ensure_ascii=False)}\n\n"
        f"Resource property schemas:\n{json.dumps(resource_schema, ensure_ascii=False)}\n\n"
        f"De-identified patients:\n{json.dumps(patient_context['normalized_patients'], ensure_ascii=False)}"
    )
    try:
        response = resilient_llm_invoke(llm, [HumanMessage(content=prompt)])
        payload = _extract_json_object(str(response.content or ""))
    except Exception as exc:
        print(f"     * Required-field completion skipped for {resource_type}: {exc}")
        return item

    primary_property = str(
        payload.get("primary_code_property") if isinstance(payload, dict) else ""
    ).strip()
    if primary_property in codeable_properties:
        item["fhir_primary_code_property"] = primary_property

    fields = payload.get("fields") if isinstance(payload, dict) else None
    if not isinstance(fields, dict):
        return item
    for key, value in fields.items():
        if key not in properties or key in {"resourceType", "id"} or key.startswith("_"):
            continue
        compact_value = _compact_mapping_value(value)
        if compact_value not in (None, "", [], {}) and item.get(key) in (None, "", [], {}):
            item[key] = compact_value
    return item


def _complete_mappings_for_schema(
    llm,
    *,
    input_text: str,
    mappings: list[dict],
    patient_payload: str | dict | list | None,
) -> list[dict]:
    """Apply schema-required completion consistently to every mapping."""
    corrected = _apply_fhir_intent_fallback(mappings)
    completed = [
        _complete_schema_required_mapping_fields(
            llm,
            input_text=input_text,
            mapping=mapping,
            patient_payload=patient_payload,
        )
        for mapping in corrected
    ]
    return _apply_fhir_intent_fallback(completed)


def _merge_mapping_review_updates(
    mappings: list[dict],
    updates: dict[int, dict],
    available_resource_types: list[str] | tuple[str, ...],
) -> list[dict]:
    """Fill missing review fields without overwriting grounded mapper decisions."""
    corrected_mappings = []
    for mapping_index, mapping in enumerate(mappings):
        new_mapping = dict(mapping)
        update = updates.get(mapping_index)
        if isinstance(update, dict):
            for key, value in update.items():
                if key in {"mapping_index", "entity", "original_entity", "generalized_term"}:
                    continue
                if (
                    key == "fhir_resource_type"
                    and str(value or "").strip() not in available_resource_types
                ):
                    continue
                compact_value = _compact_mapping_value(value)
                if compact_value in (None, "", [], {}):
                    continue
                if key not in new_mapping or new_mapping.get(key) in (None, "", [], {}):
                    new_mapping[str(key)] = compact_value
        corrected_mappings.append(new_mapping)
    return corrected_mappings


def review_mappings_for_fhir(input_text: str, mappings: list[dict], patient_payload: str | dict | list | None = None) -> dict:
    """Ask the LLM to review mappings for FHIR assembly readiness without editing them."""
    if not USE_LLM_FHIR_REVIEW:
        return {
            "summary": "Applied structured mapping fallback for FHIR assembly.",
            "warnings": [],
            "resource_expectations": ["FHIR resource intent inferred from mapper fields and terminology semantic tags."],
            "corrected_mappings": _apply_fhir_intent_fallback(mappings),
        }

    llm = load_llm()
    system_prompt = (
        "You are a clinical mapping review agent. Review mappings for logical "
        "consistency before legacy FHIR bundle assembly. Do not generate FHIR resources."
    )
    reference_context = _fhir_reference_prompt_context()
    mapping_review_payload = [
        {"mapping_index": index, **mapping}
        for index, mapping in enumerate(_compact_mappings_for_fhir(mappings))
    ]
    schema_context = _retrieve_fhir_schema_context(input_text, mapping_review_payload)
    available_resource_types = list(_mapping_resource_candidate_names())
    prompt = (
        f"{system_prompt}\n\n"
        "You are reviewing mappings before FHIR bundle assembly.\n"
        "For each existing mapping, infer the intended FHIR resource type and resource-level fields from the original text, terminology mapping, and medspaCy context fields. Keep each mapping_index's fact, codings, and assertion context independent. Do not generate FHIR JSON.\n"
        "Classify the primary real-world fact named by entity/original_entity. Fields describing a related participant, action, indication, result, or object are relationship context and must not cause the primary fact to be routed as that related fact. A resource type is eligible only when its retrieved definition describes the primary fact itself. This principle is general and applies to all resource types.\n"
        "Set `fhir_resource_type` only to a resource in the schema-derived available resource list. Use retrieved resource details for required fields and property shapes when present.\n"
        "Set `fhir_primary_code_property` to the exact CodeableConcept property from that resource's retrieved schema that represents the mapping's primary fact. Do not use a category, reason, status, interpretation, or related-fact property as the primary code slot.\n"
        "Use the original text as the source of truth. Preserve uncertainty with null/omitted fields instead of guessing.\n"
        "If a mapped concept already represents absence or negation, do not add a second negation flag.\n"
        "If assertion meaning is external to the mapped concept, represent it completely using all compatible fields in the selected resource schema; do not stop after only a Boolean or status field when a categorical interpretation/assertion field is also available.\n"
        "For any assertion, category, verification, status, or other resource field, provide a FHIR-compatible value only when supported by the text or mapping semantics. These field categories are illustrative and non-exhaustive.\n"
        "Choose resource types from the grounded meaning and retrieved FHIR schema. Populate identifiers, participants, organizations, and references only when supported by the input.\n"
        "When the input explicitly relates facts from different mapping indexes, put `fhir_relationships` on the mapping whose FHIR resource owns the reference. Each relationship object must contain `relationship` as the exact FHIR property or dotted property path, `target_entity` copied exactly from the target mapping, and `target_resource_type` as the target's selected resource type. Preserve all explicitly stated participants or parties. Do not infer relationships from co-occurrence, typical clinical workflow, or world knowledge. Do not copy the target's coding or assertion fields into the source mapping.\n"
        "IMPORTANT: You MUST return ONLY valid JSON. Escape all double quotes inside string values. Do not truncate the JSON array.\n"
        "Return only JSON with these top-level keys:\n"
        "{\n"
        "  \"step_by_step_review\": \"string\",\n"
        "  \"summary\": \"string\",\n"
        "  \"warnings\": [\"string\"],\n"
        "  \"resource_expectations\": [\"string\"],\n"
        "  \"updates\": [\n"
        "    {\n"
        "       \"mapping_index\": \"integer copied exactly from the input mapping\",\n"
        "       \"entity\": \"string (the exact entity name from that input mapping)\",\n"
        "       \"fhir_relationships\": [{\"relationship\": \"exact FHIR property/path\", \"target_entity\": \"exact target entity\", \"target_resource_type\": \"FHIR resource name\"}],\n"
        "       \"any_grounded_mapping_field\": \"value\"\n"
        "    }\n"
        "  ]\n"
        "}\n\n"
        "FHIR structural metadata:\n"
        f"{reference_context}\n\n"
        "Retrieved FHIR schema context:\n"
        f"{json.dumps(schema_context, default=str, ensure_ascii=False, indent=2)}\n\n"
        "Schema-derived available resource types:\n"
        f"{json.dumps(available_resource_types, ensure_ascii=False)}\n\n"
        f"Input text: {input_text}\n\n"
        f"Patient metadata context: {json.dumps(_patient_context_for_prompt(patient_payload), default=str, ensure_ascii=False)}\n\n"
        f"Mappings: {json.dumps(mapping_review_payload, default=str, indent=2)}"
    )
    
    for attempt in range(2):
        try:
            response = resilient_llm_invoke(llm, [HumanMessage(content=prompt)])
            response_text = str(response.content).strip()
            
            # Extract JSON robustly, ignoring DeepSeek-style think tags
            if "</think>" in response_text:
                response_text = response_text.split("</think>")[-1]
            
            response_text = response_text.strip()
            
            # Extract from markdown block if present
            markdown_match = re.search(r'```(?:json)?(.*?)```', response_text, re.DOTALL | re.IGNORECASE)
            if markdown_match:
                response_text = markdown_match.group(1).strip()
                
            # Find outermost curly braces
            start_idx = response_text.find('{')
            end_idx = response_text.rfind('}')
            
            if start_idx != -1 and end_idx != -1 and end_idx >= start_idx:
                json_str = response_text[start_idx:end_idx+1]
            else:
                json_str = response_text
            
            if not json_str.strip():
                raise ValueError("LLM returned empty JSON string (possibly only think blocks)")
            
            payload = json.loads(json_str)
            
            # Merge each review update only into the mapping index it reviewed.
            corrected_mappings = []
            updates = {}
            for update in payload.get("updates", []):
                if not isinstance(update, dict):
                    continue
                try:
                    mapping_index = int(update.get("mapping_index"))
                except (TypeError, ValueError):
                    continue
                if 0 <= mapping_index < len(mappings) and mapping_index not in updates:
                    updates[mapping_index] = update

            corrected_mappings = _merge_mapping_review_updates(
                mappings,
                updates,
                available_resource_types,
            )

            corrected_mappings = _complete_mappings_for_schema(
                llm,
                input_text=input_text,
                mappings=corrected_mappings,
                patient_payload=patient_payload,
            )
            return {
                "summary": str(payload.get("summary", "")).strip() or "Mappings reviewed for FHIR assembly.",
                "warnings": [str(item) for item in payload.get("warnings", [])][:5],
                "resource_expectations": [str(item) for item in payload.get("resource_expectations", [])][:8],
                "corrected_mappings": corrected_mappings,
            }
        except Exception as exc:
            if attempt == 0:
                prompt = f"Your previous response failed to parse as JSON. Error: {exc}. Ensure you output ONLY valid JSON without any markdown formatting, and no <think> blocks in the middle of JSON.\n\n" + prompt
                continue
            # The global review endpoint has already failed twice. Do not issue
            # one more LLM request per mapping; use the schema-derived local
            # inference path, which is authoritative for Python-first assembly.
            fallback_mappings = _apply_fhir_intent_fallback(mappings)
            return {
                "summary": "LLM review unavailable; applied structured mapping fallback for FHIR assembly.",
                "warnings": [f"Review fallback triggered: JSON Parse Error {exc}"],
                "resource_expectations": ["FHIR resource intent inferred from mapper fields and terminology semantic tags."],
                "corrected_mappings": fallback_mappings,
            }
            
    fallback_mappings = _apply_fhir_intent_fallback(mappings)
    return {
        "summary": "LLM review unavailable; applied structured mapping fallback for FHIR assembly.",
        "warnings": ["Review fallback triggered: Max attempts reached"],
        "resource_expectations": ["FHIR resource intent inferred from mapper fields and terminology semantic tags."],
        "corrected_mappings": fallback_mappings,
    }


def run_fhir_bundle_agent(
    *,
    input_text: str,
    mappings: list[dict],
    patient_payload: str | dict | list | None = None,
) -> tuple[dict, str, list[str]]:
    """Run the FHIR bundle agent as a LangGraph workflow."""
    if isinstance(mappings, dict):
        mappings = [mappings]
    elif not isinstance(mappings, list):
        mappings = []
    mappings = [
        dict(mapping)
        if isinstance(mapping, dict)
        else {"entity": str(mapping).strip()}
        for mapping in mappings
        if isinstance(mapping, dict) or str(mapping or "").strip()
    ]

    def initialize(state: Agent5State) -> Agent5State:
        logs = list(state["logs"])
        print("\n" + "=" * 60)
        print("STARTING AGENT 6: FHIR Bundle Generation")
        print("=" * 60)
        print(f"Input mappings: {len(mappings)}")
        print("   Terms to process:")
        for m in mappings:
            print(f"     - {m.get('entity')}")
        
        logs.append("=" * 60)
        logs.append("🚀 STARTING AGENT 6: FHIR Bundle Generation")
        logs.append("=" * 60)
        logs.append(f"📝 Input mappings: {len(mappings)}")
        
        return {**state, "logs": logs}

    def review_mappings_node(state: Agent5State) -> Agent5State:
        logs = list(state["logs"])
        try:
            review = review_mappings_for_fhir(
                input_text=state["input_text"],
                mappings=state["mappings"],
                patient_payload=state["patient_payload"],
            )
        except Exception as exc:
            try:
                corrected_mappings = _apply_fhir_intent_fallback(state["mappings"])
            except Exception:
                corrected_mappings = state["mappings"]
            review = {
                "summary": "Optional mapping review failed; local schema-based composition will continue.",
                "warnings": [f"Mapping review unavailable: {exc}"],
                "resource_expectations": [],
                "corrected_mappings": corrected_mappings,
            }

        corrected_mappings = review.get("corrected_mappings", state["mappings"])
        if USE_LLM_FHIR_RELATIONSHIP_AUDIT:
            try:
                relationship_llm = load_llm()
                corrected_mappings = _audit_grounded_patient_provider_interactions(
                    relationship_llm,
                    input_text=state["input_text"],
                    mappings=corrected_mappings,
                )
                corrected_mappings = _audit_grounded_mapping_relationships(
                    relationship_llm,
                    input_text=state["input_text"],
                    mappings=corrected_mappings,
                )
            except Exception as exc:
                warning = f"Relationship audit unavailable: {exc}"
                review.setdefault("warnings", []).append(warning)
                print(f"     ! {warning}")
        review["corrected_mappings"] = corrected_mappings

        if USE_SCHEMA_FIRST_FHIR_COMPOSITION:
            print("   > Running schema-constrained mapping intent review before Python-first composition.")
            logs.append("   🧠 Running schema-constrained mapping intent review before Python-first composition.")
            for warning in review.get("warnings", []):
                print(f"     ! Warning: {warning}")
                logs.append(f"     ⚠️ {warning}")
            return {
                **state,
                "mappings": review.get("corrected_mappings", state["mappings"]),
                "review_summary": review,
                "logs": logs,
            }

        print("   > Reviewing mappings for FHIR extraction (negations, allergies, refusals)...")
        logs.append("   🧠 LLM Reviewing mappings for FHIR assembly...")

        for warning in review.get("warnings", []):
            print(f"     ! Warning: {warning}")
            logs.append(f"     ⚠️ {warning}")
            
        for expectation in review.get("resource_expectations", []):
            print(f"     * Expectation: {expectation}")
            logs.append(f"     ✅ {expectation}")
            
        return {
            **state, 
            "mappings": review.get("corrected_mappings", state["mappings"]),
            "review_summary": review, 
            "logs": logs
        }

    def build_bundle_node(state: Agent5State) -> Agent5State:
        logs = list(state["logs"])
        print(f"   > Building FHIR bundle...")
        logs.append(f"   🔧 Building FHIR bundle...")
        try:
            bundle = build_fhir_bundle_schema_first(
                input_text=state["input_text"],
                mappings=state["mappings"],
                patient_payload=state["patient_payload"],
            )
        except Exception as exc:
            build_error = f"Agent 6 Python-first FHIR build failed: {exc}"
            print(f"     ! {build_error}")
            bundle = _build_diagnostic_fhir_bundle(
                input_text=state["input_text"],
                mappings=state["mappings"],
                diagnostics=[build_error],
            )
            print("     ! A valid diagnostic FHIR Bundle will be saved for this run.")
            logs.append(f"     ❌ {build_error}")
            logs.append("     ⚠️ A valid diagnostic FHIR Bundle will be saved for this run.")
            return {
                **state,
                "bundle": bundle,
                "build_error": None,
                "review_summary": {
                    "summary": "FHIR composition failed; a valid diagnostic Bundle was generated.",
                    "passed": False,
                    "warnings": [],
                    "issues": [{"severity": "error", "concern": build_error}],
                },
                "logs": logs,
            }

        review_summary = state.get("review_summary")
        if (
            USE_SCHEMA_FIRST_FHIR_COMPOSITION
            and bundle.get("resourceType") == "Bundle"
            and not _bundle_has_error_operation_outcome(bundle)
        ):
            review_summary = review_generated_fhir_bundle(
                input_text=state["input_text"],
                mappings=state["mappings"],
                bundle=bundle,
            )
            print(f"     * Agent 6 review summary: {review_summary.get('summary')}")
            logs.append(f"     🧠 Agent 6 review summary: {review_summary.get('summary')}")
            for warning in review_summary.get("warnings", [])[:5]:
                print(f"     ! Agent 6 review warning: {warning}")
                logs.append(f"     ⚠️ Agent 6 review warning: {warning}")
            for issue in review_summary.get("issues", [])[:5]:
                concern = issue.get("concern") if isinstance(issue, dict) else str(issue)
                severity = issue.get("severity", "warning") if isinstance(issue, dict) else "warning"
                print(f"     ! Agent 6 review {severity}: {concern}")
                logs.append(f"     ⚠️ Agent 6 review {severity}: {concern}")

        return {
            **state,
            "bundle": bundle,
            "build_error": None,
            "review_summary": review_summary,
            "logs": logs,
        }

    def save_bundle_node(state: Agent5State) -> Agent5State:
        logs = list(state["logs"])
        bundle, validation_errors = _replace_invalid_bundle_with_diagnostic(
            bundle=state.get("bundle"),
            input_text=state["input_text"],
            mappings=state["mappings"],
            diagnostics_prefix=(
                state.get("build_error")
                or "FHIR composition returned no schema-valid Bundle."
            ),
        )
        if validation_errors:
            for issue in validation_errors[:5]:
                print(f"     ! Validation Issue: {issue}")
                logs.append(f"     ⚠️ {issue}")
            print("     ! Replaced invalid output with a diagnostic FHIR Bundle.")
            logs.append("     ⚠️ Replaced invalid output with a diagnostic FHIR Bundle.")
        else:
            print(f"     * Validation Passed.")
            logs.append(f"     ✅ Validation Passed.")
        try:
            bundle_path = save_fhir_bundle(bundle)
            print("   > Saved FHIR bundle to " + str(bundle_path))
            logs.append(f"   ✅ Saved FHIR bundle to {bundle_path}")
        except Exception as exc:
            bundle_path = ""
            message = f"FHIR Bundle persistence unavailable; returning the valid Bundle in memory: {exc}"
            print(f"     ! {message}")
            logs.append(f"     ⚠️ {message}")
        return {
            **state,
            "bundle": bundle,
            "build_error": None,
            "bundle_path": str(bundle_path),
            "logs": logs,
        }

    workflow = StateGraph(Agent5State)
    workflow.add_node("initialize", initialize)
    workflow.add_node("review_mappings", review_mappings_node)
    workflow.add_node("build_bundle", build_bundle_node)
    workflow.add_node("save_bundle", save_bundle_node)
    workflow.set_entry_point("initialize")
    workflow.add_edge("initialize", "review_mappings")
    workflow.add_edge("review_mappings", "build_bundle")
    workflow.add_edge("build_bundle", "save_bundle")
    workflow.add_edge("save_bundle", END)

    graph = workflow.compile()
    initial_state = {
        "input_text": input_text,
        "mappings": mappings,
        "patient_payload": patient_payload,
        "bundle": None,
        "bundle_path": None,
        "review_summary": None,
        "build_error": None,
        "logs": [],
    }
    try:
        result = graph.invoke(initial_state)
    except Exception as exc:
        message = f"FHIR workflow unavailable; generated a diagnostic Bundle instead: {exc}"
        print(f"     ! {message}")
        bundle = _build_diagnostic_fhir_bundle(
            input_text=input_text,
            mappings=mappings,
            diagnostics=[message],
        )
        try:
            bundle_path = str(save_fhir_bundle(bundle))
        except Exception as save_exc:
            print(f"     ! Diagnostic FHIR Bundle could not be saved; returning it in memory: {save_exc}")
            bundle_path = ""
        return bundle, bundle_path, [f"     ⚠️ {message}"]
    return result["bundle"] or {}, str(result.get("bundle_path") or ""), result["logs"]


@tool
def fhir_bundle_tool(input_text: str, mappings_json: str | list | dict, patient_payload: str | dict | list | None = None) -> str:
    """Tool: FHIR bundle assembly callable by an LLM agent.

    Arguments:
        input_text: Original input text
        mappings_json: JSON string or object representing mappings (list of dicts)
        patient_payload: Optional patient metadata (string/dict/list)

    Returns:
        JSON string with keys `bundle` and `bundle_path`.
    """
    # Accept either a JSON string or an already-parsed object
    mappings = mappings_json
    input_error = None
    if isinstance(mappings_json, str):
        try:
            mappings = json.loads(mappings_json)
        except Exception as exc:
            mappings = []
            input_error = f"Mapping payload is not valid JSON: {exc}"

    if isinstance(mappings, dict):
        nested_mappings = mappings.get("mappings")
        mappings = nested_mappings if isinstance(nested_mappings, list) else [mappings]
    if not isinstance(mappings, list):
        mappings = []

    build_error = input_error
    if input_error:
        bundle = _build_diagnostic_fhir_bundle(
            input_text=input_text,
            mappings=mappings,
            diagnostics=[input_error],
        )
    else:
        try:
            bundle = build_fhir_bundle_schema_first(
                input_text=input_text,
                mappings=mappings,
                patient_payload=patient_payload,
            )
        except Exception as exc:
            build_error = f"Agent 6 Python-first FHIR build failed: {exc}"
            bundle = _build_diagnostic_fhir_bundle(
                input_text=input_text,
                mappings=mappings,
                diagnostics=[build_error],
            )

    bundle, replacement_issues = _replace_invalid_bundle_with_diagnostic(
        bundle=bundle,
        input_text=input_text,
        mappings=mappings,
        diagnostics_prefix=build_error or "FHIR composition produced an invalid Bundle.",
    )
    if _bundle_has_error_operation_outcome(bundle):
        review_summary = {
            "summary": "FHIR composition did not complete; a valid diagnostic Bundle was generated.",
            "passed": False,
            "warnings": replacement_issues,
            "issues": ([{"severity": "error", "concern": build_error}] if build_error else []),
        }
    else:
        review_summary = review_generated_fhir_bundle(
            input_text=input_text,
            mappings=mappings,
            bundle=bundle,
        )
    bundle_path = save_fhir_bundle(bundle)

    result = {"bundle": bundle, "bundle_path": str(bundle_path), "review_summary": review_summary}
    return json.dumps(result, default=str)


def save_fhir_bundle(bundle: dict) -> Path:
    """Persist a generated FHIR Bundle to output/fhir_bundles."""
    FHIR_BUNDLE_DIR.mkdir(parents=True, exist_ok=True)

    bundle_id = _safe_name(bundle.get("id", "bundle"))
    target_path = FHIR_BUNDLE_DIR / f"{bundle_id}.json"

    with open(target_path, "w", encoding="utf-8") as file_handle:
        json.dump(bundle, file_handle, indent=2, ensure_ascii=False)

    return target_path
