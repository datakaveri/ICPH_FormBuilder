"""ICPH CSV ingestion backed by processed meta-form schema chunks."""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import shutil
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parent
ICPH_ROOT = PROJECT_ROOT.parent
SCHEMA_ROOT = PROJECT_ROOT / "SchemaTerminologies" / "schemas" / "ICPH_MetaForms"
PROCESSED_MD_DIR = SCHEMA_ROOT / "processedMD"
AGGREGATE_CHUNKS_PATH = PROCESSED_MD_DIR / "icph_metaform_chunks.jsonl"
OUTPUT_ROOT = ICPH_ROOT / "output"
UPLOADS_ROOT = OUTPUT_ROOT / "icph_csv_uploads"
BUNDLES_ROOT = OUTPUT_ROOT / "icph_fhir_bundles"
TERMINOLOGY_CACHE_PATH = OUTPUT_ROOT / "icph_terminology_cache.json"

SNOMED_SYSTEM = "http://snomed.info/sct"
LOINC_SYSTEM = "http://loinc.org"
RXNORM_SYSTEM = "http://www.nlm.nih.gov/research/umls/rxnorm"
ICD10_SYSTEM = "http://hl7.org/fhir/sid/icd-10-cm"
ICPH_SCHEMA_VARIABLE_EXTENSION_URL = "https://datakaveri.org/fhir/StructureDefinition/icph-schema-variable"
ICPH_ANSWER_TERMINOLOGY_EXTENSION_URL = "https://datakaveri.org/fhir/StructureDefinition/icph-answer-terminology"
ICPH_FORM_SOURCE_EXTENSION_URL = "https://datakaveri.org/fhir/StructureDefinition/icph-form-source"


def _include_derived_observations() -> bool:
    return str(os.environ.get("ICPH_INCLUDE_DERIVED_OBSERVATIONS") or "").strip().lower() in {"1", "true", "yes"}


@dataclass(frozen=True)
class IcphSchemaField:
    document_name: str
    form_index: int
    form_title: str
    variable: str
    question: str
    format_options: str
    instructions: str
    row_index: int


def _slug(value: str) -> str:
    slug = re.sub(r"[^0-9A-Za-z]+", "-", str(value or "")).strip("-").lower()
    return slug or "unknown"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _parse_csv_form_identity(filename: str) -> tuple[str, int]:
    match = re.search(r"(?P<doc>\d+)\s*docx[-_ ]*form\s*(?P<form>\d+)", filename, re.IGNORECASE)
    if not match:
        match = re.search(r"(?P<doc>\d+).*?form\s*(?P<form>\d+)", filename, re.IGNORECASE)
    if not match:
        raise ValueError(
            "Could not infer document/form from CSV filename. Expected a name like "
            "`5docx-form2-baseline_details_ultrasound.csv`."
        )
    return f"{int(match.group('doc'))}.docx", int(match.group("form"))


def load_icph_schema_fields(document_name: str, form_index: int) -> list[IcphSchemaField]:
    if not AGGREGATE_CHUNKS_PATH.is_file():
        raise FileNotFoundError(
            f"Missing ICPH schema chunks: {AGGREGATE_CHUNKS_PATH}. "
            "Run preprocess_icph_metaforms.py first."
        )
    fields: list[IcphSchemaField] = []
    with AGGREGATE_CHUNKS_PATH.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            if record.get("chunk_type") != "variable":
                continue
            if record.get("document_name") != document_name or int(record.get("form_index", -1)) != form_index:
                continue
            fields.append(
                IcphSchemaField(
                    document_name=str(record.get("document_name") or ""),
                    form_index=int(record.get("form_index") or form_index),
                    form_title=str(record.get("form_title") or ""),
                    variable=str(record.get("variable") or ""),
                    question=str(record.get("question") or ""),
                    format_options=str(record.get("format_options") or ""),
                    instructions=str(record.get("instructions") or ""),
                    row_index=int(record.get("row_index") or 0),
                )
            )
    if not fields:
        raise ValueError(f"No schema fields found for {document_name} form {form_index}.")
    return fields


def _read_csv_preserve_duplicate_headers(path: Path) -> tuple[list[str], list[list[str]]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle)
        try:
            header = next(reader)
        except StopIteration:
            raise ValueError(f"CSV is empty: {path}") from None
        rows = [row for row in reader if any(str(cell).strip() for cell in row)]
    return header, rows


def _align_csv_to_schema(
    header: list[str],
    rows: list[list[str]],
    expected_header: list[str],
) -> tuple[list[str], list[list[str]], list[str]]:
    """Return rows projected to the schema columns, ignoring ODK export metadata."""
    if header == expected_header:
        return header, rows, []

    positions: dict[str, int] = {}
    duplicate_columns: set[str] = set()
    for index, column in enumerate(header):
        if column in positions:
            duplicate_columns.add(column)
            continue
        positions[column] = index

    missing_columns = [column for column in expected_header if column not in positions]
    if missing_columns:
        raise ValueError(
            "CSV header does not match the ICPH schema. "
            f"Missing schema columns: {', '.join(missing_columns)}. "
            f"Expected {len(expected_header)} schema columns, got {len(header)} CSV columns."
        )

    schema_positions = [positions[column] for column in expected_header]
    aligned_rows: list[list[str]] = []
    for row in rows:
        padded = row + [""] * max(0, len(header) - len(row))
        aligned_rows.append([padded[position] if position < len(padded) else "" for position in schema_positions])

    ignored_columns = [column for column in header if column not in set(expected_header)]
    if duplicate_columns:
        ignored_columns.extend(f"duplicate:{column}" for column in sorted(duplicate_columns))
    return expected_header, aligned_rows, ignored_columns


def _parse_datetime(value: str) -> datetime | None:
    text = str(value or "").strip()
    for fmt in ("%d-%m-%Y %H:%M:%S", "%d-%m-%Y %H:%M", "%d-%m-%Y", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _fhir_datetime(value: str) -> str | None:
    parsed = _parse_datetime(value)
    if parsed:
        return parsed.replace(tzinfo=timezone.utc).isoformat()
    return None


def _stable_id(*parts: Any) -> str:
    return hashlib.sha1("|".join(str(part) for part in parts).encode("utf-8")).hexdigest()[:12]


_TERMINOLOGY_CACHE: dict[str, Any] | None = None


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _load_terminology_cache() -> dict[str, Any]:
    global _TERMINOLOGY_CACHE
    if _TERMINOLOGY_CACHE is not None:
        return _TERMINOLOGY_CACHE
    if TERMINOLOGY_CACHE_PATH.is_file():
        try:
            _TERMINOLOGY_CACHE = json.loads(TERMINOLOGY_CACHE_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            _TERMINOLOGY_CACHE = {}
    else:
        _TERMINOLOGY_CACHE = {}
    return _TERMINOLOGY_CACHE


def _save_terminology_cache() -> None:
    if _TERMINOLOGY_CACHE is None:
        return
    TERMINOLOGY_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    TERMINOLOGY_CACHE_PATH.write_text(
        json.dumps(_TERMINOLOGY_CACHE, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _cached_lookup(cache_key: str, resolver) -> Any:
    cache = _load_terminology_cache()
    if cache_key in cache and not (isinstance(cache[cache_key], dict) and cache[cache_key].get("error")):
        return cache[cache_key]
    try:
        value = resolver()
    except Exception as exc:
        value = {"error": str(exc)}
    cache[cache_key] = value
    _save_terminology_cache()
    return value


def _clean_option_label(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip(" ;|")


def _format_options_map(field: IcphSchemaField) -> dict[str, str]:
    options = str(field.format_options or "")
    if "=" not in options:
        return {}
    matches = list(re.finditer(r"(?P<code>-?\d+[A-Za-z]?|[A-Za-z]\w*)\s*=", options))
    parsed: dict[str, str] = {}
    for index, match in enumerate(matches):
        code = match.group("code").strip()
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(options)
        label = _clean_option_label(options[start:end])
        if code and label:
            parsed[code] = label
    return parsed


def _answer_display(value: str, field: IcphSchemaField) -> str:
    text = str(value or "").strip()
    return _format_options_map(field).get(text, text)


def _normalize_query(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def _field_context(field: IcphSchemaField) -> str:
    parts = [
        f"Document: {field.document_name}",
        f"Form: {field.form_title}",
        f"Variable: {field.variable}",
        f"Question: {field.question}",
        f"Format/options: {field.format_options}",
    ]
    if field.instructions:
        parts.append(f"Instructions: {field.instructions}")
    return "\n".join(part for part in parts if part)


def _clinical_phrase_from_question(question: str) -> str:
    phrase = str(question or "")
    phrase = re.sub(r"<<[^>]+>>", " ", phrase)
    phrase = re.sub(r"\([^)]*please[^)]*\)", " ", phrase, flags=re.IGNORECASE)
    phrase = re.sub(r"\?", " ", phrase)
    replacements = [
        r"^\s*are you\s+",
        r"^\s*is the individual\s+",
        r"^\s*did the individual\s+",
        r"^\s*do you\s+",
        r"^\s*does the child\s+",
        r"^\s*have you ever been told by a doctor or other health worker that you have\s+",
        r"^\s*have you ever had\s+",
        r"^\s*in the past two weeks,\s*have you taken\s+",
        r"^\s*are you currently taking\s+",
        r"^\s*what is your\s+",
        r"^\s*please\s+",
    ]
    for pattern in replacements:
        phrase = re.sub(pattern, "", phrase, flags=re.IGNORECASE)
    phrase = re.sub(r"\bnot during pregnancy\b", "", phrase, flags=re.IGNORECASE)
    phrase = re.sub(r"\s+", " ", phrase).strip(" .:")
    return phrase or str(question or "").strip()


def _answer_meaning_query(field: IcphSchemaField, value: str) -> str:
    label = _answer_display(value, field)
    phrase = _clinical_phrase_from_question(field.question)
    normalized_label = _normalize_query(label)
    if normalized_label in {"yes", "y", "true", "present"}:
        return phrase
    if normalized_label in {"no", "n", "false", "none", "never"}:
        return f"not {phrase}"
    if label and label != str(value or "").strip():
        return f"{phrase}: {label}"
    return phrase


def _is_identifier_like(field: IcphSchemaField) -> bool:
    text = f"{field.variable} {field.question} {field.format_options}".lower()
    return any(
        keyword in text
        for keyword in [
            "device id",
            "study id",
            "screening id",
            "tube",
            "phone",
            "telephone",
            "address",
            "name",
            "alphanumeric",
        ]
    )


def _looks_medication_related(field: IcphSchemaField, value: str = "") -> bool:
    text = f"{field.question} {_answer_display(value, field)} {field.instructions}".lower()
    return any(keyword in text for keyword in ["drug", "medication", "insulin", "treatment", "remedy", "tablet"])


def _looks_condition_related(field: IcphSchemaField) -> bool:
    text = f"{field.question} {field.instructions}".lower()
    return any(
        keyword in text
        for keyword in [
            "diagnosed",
            "disease",
            "diabetes",
            "hypertension",
            "blood pressure",
            "cholesterol",
            "asthma",
            "preeclampsia",
            "eclampsia",
            "pain",
            "bleeding",
            "headache",
            "vision",
            "swelling",
            "urine output",
            "pregnan",
        ]
    )


def _looks_observation_related(field: IcphSchemaField) -> bool:
    text = f"{field.question} {field.format_options}".lower()
    return any(
        keyword in text
        for keyword in [
            "blood",
            "glucose",
            "pressure",
            "pulse",
            "height",
            "weight",
            "circumference",
            "length",
            "sample",
            "status",
            "test",
            "measured",
            "gestational age",
            "date",
            "time",
            "ultrasound",
        ]
    )


def _coding(system: str, code: Any, display: Any) -> dict[str, str] | None:
    code_text = str(code or "").strip()
    display_text = str(display or "").strip()
    if not system or not code_text:
        return None
    coding = {"system": system, "code": code_text}
    if display_text:
        coding["display"] = display_text
    return coding


def _dedupe_codings(codings: list[dict[str, str]]) -> list[dict[str, str]]:
    deduped: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for coding in codings:
        key = (str(coding.get("system") or ""), str(coding.get("code") or ""))
        if not key[0] or not key[1] or key in seen:
            continue
        seen.add(key)
        deduped.append(coding)
    return deduped


def _snomed_mapping(query: str) -> dict[str, Any] | None:
    query = str(query or "").strip()
    if not query:
        return None

    def resolver():
        from snomed_mapper_agent import search_snomed_candidates_direct

        candidates = search_snomed_candidates_direct(query, top_k=5)
        if not candidates:
            return None
        threshold = _env_float("ICPH_SNOMED_MIN_SCORE", 0.55)
        selected = candidates[0]
        if float(selected.get("similarity_score") or 0) < threshold:
            return None
        return {
            "system": SNOMED_SYSTEM,
            "code": selected.get("concept_id"),
            "display": selected.get("fsn") or selected.get("term"),
            "query": query,
            "score": selected.get("similarity_score"),
        }

    result = _cached_lookup(f"snomed::{query.lower()}", resolver)
    return result if isinstance(result, dict) and result.get("code") else None


def _loinc_mapping(field: IcphSchemaField) -> dict[str, Any] | None:
    if _is_identifier_like(field) or not _looks_observation_related(field):
        return None
    query = _clinical_phrase_from_question(field.question)
    context = _field_context(field)

    def resolver():
        from loinc_mapper_agent import _dense_loinc_candidates

        candidates = _dense_loinc_candidates(query, context)
        if not candidates:
            return None
        candidate = candidates[0]
        score = candidate.get("semantic_score")
        if score is not None and float(score) < _env_float("ICPH_LOINC_MIN_SCORE", 0.50):
            return None
        return {
            "system": LOINC_SYSTEM,
            "code": candidate.get("code"),
            "display": candidate.get("display") or candidate.get("long_common_name"),
            "query": query,
            "score": score,
        }

    result = _cached_lookup(f"loinc::{field.document_name}::{field.form_index}::{field.variable}::{query}", resolver)
    return result if isinstance(result, dict) and result.get("code") else None


def _rxnorm_mapping(field: IcphSchemaField, value: str) -> dict[str, Any] | None:
    if not _looks_medication_related(field, value):
        return None
    query = _answer_meaning_query(field, value)
    context = _field_context(field)

    def resolver():
        from rxnorm_mapper_agent import _dense_rxnorm_candidates

        candidates = _dense_rxnorm_candidates(query, context)
        if not candidates:
            return None
        candidate = candidates[0]
        score = candidate.get("semantic_score")
        if score is not None and float(score) < _env_float("ICPH_RXNORM_MIN_SCORE", 0.55):
            return None
        return {
            "system": RXNORM_SYSTEM,
            "code": candidate.get("code"),
            "display": candidate.get("display"),
            "query": query,
            "score": score,
        }

    result = _cached_lookup(f"rxnorm::{field.document_name}::{field.form_index}::{field.variable}::{query}", resolver)
    return result if isinstance(result, dict) and result.get("code") else None


def _icd10_mapping(field: IcphSchemaField, value: str) -> dict[str, Any] | None:
    if not _looks_condition_related(field):
        return None
    query = _answer_meaning_query(field, value)
    context = _field_context(field)

    def resolver():
        from icd10_mapper_agent import _search_candidates

        candidates = _search_candidates(query, context)
        if not candidates:
            return None
        candidate = candidates[0]
        score = candidate.get("semantic_score")
        if score is not None and float(score) < _env_float("ICPH_ICD10_MIN_SCORE", 0.50):
            return None
        return {
            "system": ICD10_SYSTEM,
            "code": candidate.get("code"),
            "display": candidate.get("display"),
            "query": query,
            "score": score,
        }

    result = _cached_lookup(f"icd10::{field.document_name}::{field.form_index}::{field.variable}::{query}", resolver)
    return result if isinstance(result, dict) and result.get("code") else None


def _terminology_codify_field(field: IcphSchemaField, value: str) -> dict[str, list[dict[str, str]]]:
    if _is_identifier_like(field):
        return {"question": [], "answer": []}

    question_codings: list[dict[str, str]] = []
    answer_codings: list[dict[str, str]] = []

    loinc = _loinc_mapping(field)
    if loinc and (coding := _coding(loinc["system"], loinc["code"], loinc.get("display"))):
        question_codings.append(coding)

    if _looks_condition_related(field):
        snomed = _snomed_mapping(_answer_meaning_query(field, value))
        if snomed and (coding := _coding(snomed["system"], snomed["code"], snomed.get("display"))):
            question_codings.append(coding)

    rxnorm = _rxnorm_mapping(field, value)
    if rxnorm and (coding := _coding(rxnorm["system"], rxnorm["code"], rxnorm.get("display"))):
        question_codings.append(coding)

    icd10 = _icd10_mapping(field, value)
    if icd10 and (coding := _coding(icd10["system"], icd10["code"], icd10.get("display"))):
        question_codings.append(coding)

    if _format_options_map(field):
        answer_query = _answer_meaning_query(field, value)
        answer_snomed = _snomed_mapping(answer_query)
        if answer_snomed and (coding := _coding(answer_snomed["system"], answer_snomed["code"], answer_snomed.get("display"))):
            answer_codings.append(coding)

    return {"question": question_codings, "answer": answer_codings}


def _answer_value(value: str, field: IcphSchemaField) -> dict[str, Any]:
    text = str(value or "").strip()
    fmt = field.format_options.lower()
    if text == "":
        return {"valueString": ""}
    option_labels = _format_options_map(field)
    if option_labels:
        return {
            "valueCoding": {
                "system": "https://datakaveri.org/fhir/CodeSystem/icph-schema-answer",
                "code": text,
                "display": option_labels.get(text, text),
            }
        }
    if "numeric" in fmt or "number" in fmt or "range" in fmt:
        try:
            return {"valueDecimal": float(text)}
        except ValueError:
            return {"valueString": text}
    if "dd-mm-yyyy hh:mm" in fmt:
        return {"valueDateTime": _fhir_datetime(text) or text}
    if "dd-mm-yyyy" in fmt or fmt.strip() == "date":
        parsed = _parse_datetime(text)
        return {"valueDate": parsed.date().isoformat() if parsed else text}
    return {"valueString": text}


def _observation_answer_value(
    answer: dict[str, Any],
    field: IcphSchemaField,
    value: str,
    terminology: dict[str, list[dict[str, str]]],
) -> dict[str, Any] | None:
    if "valueDecimal" in answer:
        value_quantity = {"value": answer["valueDecimal"]}
        unit_match = re.search(r"\(([^)]+)\)", field.question or field.format_options)
        if unit_match:
            value_quantity["unit"] = unit_match.group(1)
        return {"valueQuantity": value_quantity}
    if "valueCoding" in answer:
        codings = _dedupe_codings([answer["valueCoding"]] + terminology.get("answer", []))
        return {
            "valueCodeableConcept": {
                "coding": codings,
                "text": _answer_display(value, field),
            }
        }
    if "valueDate" in answer:
        return {"valueDateTime": answer["valueDate"]}
    if "valueDateTime" in answer:
        return {"valueDateTime": answer["valueDateTime"]}
    return None


def _schema_variable_extension(field: IcphSchemaField) -> dict[str, Any]:
    schema_extensions = [
        {"url": "document", "valueString": field.document_name},
        {"url": "formIndex", "valueInteger": field.form_index},
        {"url": "formTitle", "valueString": field.form_title},
        {"url": "variable", "valueString": field.variable},
    ]
    if field.format_options:
        schema_extensions.append({"url": "formatOptions", "valueString": field.format_options})
    if field.instructions:
        schema_extensions.append({"url": "instructions", "valueString": field.instructions})
    return {
        "url": ICPH_SCHEMA_VARIABLE_EXTENSION_URL,
        "extension": schema_extensions,
    }


def _questionnaire_item_type(field: IcphSchemaField) -> str:
    fmt = str(field.format_options or "").lower()
    if _format_options_map(field):
        return "choice"
    if "dd-mm-yyyy hh:mm" in fmt or "datetime" in fmt or "date time" in fmt:
        return "dateTime"
    if "dd-mm-yyyy" in fmt or fmt.strip() == "date":
        return "date"
    if re.search(r"\btime\b", fmt):
        return "time"
    if "integer" in fmt or "whole number" in fmt:
        return "integer"
    if "numeric" in fmt or "number" in fmt or "range" in fmt or "decimal" in fmt:
        return "decimal"
    if "free text" in fmt or "free-text" in fmt or "paragraph" in fmt or "long text" in fmt:
        return "text"
    return "string"


def _questionnaire_answer_options(field: IcphSchemaField) -> list[dict[str, Any]]:
    options = []
    for code, display in _format_options_map(field).items():
        options.append(
            {
                "valueCoding": {
                    "system": "https://datakaveri.org/fhir/CodeSystem/icph-schema-answer",
                    "code": code,
                    "display": display,
                }
            }
        )
    return options


def _questionnaire_definition_item(field: IcphSchemaField, occurrence: int) -> dict[str, Any]:
    link_id = field.variable if occurrence == 1 else f"{field.variable}-{occurrence}"
    terminology = _terminology_codify_field(field, "")
    item: dict[str, Any] = {
        "linkId": link_id,
        "definition": f"https://datakaveri.org/fhir/Questionnaire/icph-{_slug(field.document_name)}-form-{field.form_index}#{link_id}",
        "code": _dedupe_codings(
            [
                {
                    "system": "https://datakaveri.org/fhir/CodeSystem/icph-schema-variable",
                    "code": field.variable,
                    "display": field.question or field.variable,
                }
            ]
            + terminology.get("question", [])
        ),
        "text": field.question or field.variable,
        "type": _questionnaire_item_type(field),
        "extension": [_schema_variable_extension(field)],
    }
    if options := _questionnaire_answer_options(field):
        item["answerOption"] = options
    return item


def _questionnaire_resource(
    *,
    fields: list[IcphSchemaField],
    document_name: str,
    form_index: int,
    form_title: str,
) -> dict[str, Any]:
    occurrence_count: dict[str, int] = {}
    items = []
    for field in fields:
        occurrence_count[field.variable] = occurrence_count.get(field.variable, 0) + 1
        items.append(_questionnaire_definition_item(field, occurrence_count[field.variable]))
    questionnaire_id = f"icph-{_slug(document_name)}-form-{form_index}"
    return {
        "resourceType": "Questionnaire",
        "id": questionnaire_id,
        "url": f"https://datakaveri.org/fhir/Questionnaire/{questionnaire_id}",
        "status": "active",
        "title": form_title or f"{document_name} form {form_index}",
        "date": _now_iso(),
        "item": items,
    }


def _questionnaire_item(field: IcphSchemaField, value: str, occurrence: int) -> dict[str, Any]:
    terminology = _terminology_codify_field(field, value)
    link_id = field.variable if occurrence == 1 else f"{field.variable}-{occurrence}"
    item = {
        "linkId": link_id,
        "definition": f"https://datakaveri.org/fhir/Questionnaire/icph-{_slug(field.document_name)}-form-{field.form_index}#{link_id}",
        "text": field.question or field.variable,
        "extension": [_schema_variable_extension(field)],
    }
    if str(value or "").strip():
        answer = _answer_value(value, field)
        answer_extensions = []
        for coding in terminology.get("answer", []):
            answer_extensions.append(
                {
                    "url": ICPH_ANSWER_TERMINOLOGY_EXTENSION_URL,
                    "valueCoding": coding,
                }
            )
        if answer_extensions:
            answer["extension"] = answer_extensions
        item["answer"] = [answer]
    return item


def _patient_resource(patient_id: str) -> dict[str, Any]:
    return {
        "resourceType": "Patient",
        "id": _slug(patient_id),
        "identifier": [
            {
                "system": "https://datakaveri.org/fhir/sid/icph-participant-id",
                "value": patient_id,
            }
        ],
    }


def _source_row_id(patient_id: str, document_name: str, form_index: int, row_number: int) -> str:
    return f"{_slug(patient_id)}-{_slug(document_name)}-form-{form_index}-row-{row_number}"


def _encounter_id(patient_id: str, document_name: str, form_index: int, row_number: int) -> str:
    return f"enc-{_source_row_id(patient_id, document_name, form_index, row_number)}"


def _encounter_resource(
    patient_id: str,
    row_number: int,
    timestamp: str | None,
    form_title: str,
    document_name: str,
    form_index: int,
) -> dict[str, Any]:
    encounter_id = _encounter_id(patient_id, document_name, form_index, row_number)
    encounter = {
        "resourceType": "Encounter",
        "id": encounter_id,
        "status": "finished",
        "class": {
            "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
            "code": "AMB",
            "display": "ambulatory",
        },
        "subject": {"reference": f"Patient/{_slug(patient_id)}"},
        "type": [{"text": form_title}],
        "extension": [
            {
                "url": ICPH_FORM_SOURCE_EXTENSION_URL,
                "extension": [
                    {"url": "document", "valueString": document_name},
                    {"url": "formIndex", "valueInteger": form_index},
                    {"url": "formTitle", "valueString": form_title},
                    {"url": "csvRowNumber", "valueInteger": row_number},
                ],
            }
        ],
    }
    if timestamp:
        encounter["period"] = {"start": timestamp}
    return encounter


def _questionnaire_response(
    *,
    patient_id: str,
    row_number: int,
    timestamp: str | None,
    fields: list[IcphSchemaField],
    values: list[str],
    document_name: str,
    form_index: int,
    form_title: str,
) -> dict[str, Any]:
    occurrence_count: dict[str, int] = {}
    items = []
    for field, value in zip(fields, values):
        occurrence_count[field.variable] = occurrence_count.get(field.variable, 0) + 1
        items.append(_questionnaire_item(field, value, occurrence_count[field.variable]))
    resource = {
        "resourceType": "QuestionnaireResponse",
        "id": f"qr-{_slug(patient_id)}-{_stable_id(document_name, form_index, row_number)}",
        "status": "completed",
        "subject": {"reference": f"Patient/{_slug(patient_id)}"},
        "encounter": {"reference": f"Encounter/{_encounter_id(patient_id, document_name, form_index, row_number)}"},
        "questionnaire": f"https://datakaveri.org/fhir/Questionnaire/icph-{_slug(document_name)}-form-{form_index}",
        "item": items,
        "extension": [
            {
                "url": ICPH_FORM_SOURCE_EXTENSION_URL,
                "extension": [
                    {"url": "document", "valueString": document_name},
                    {"url": "formIndex", "valueInteger": form_index},
                    {"url": "formTitle", "valueString": form_title},
                    {"url": "csvRowNumber", "valueInteger": row_number},
                ],
            }
        ],
    }
    if timestamp:
        resource["authored"] = timestamp
    return resource


def _observation_resource(
    patient_id: str,
    row_number: int,
    timestamp: str | None,
    field: IcphSchemaField,
    value: str,
    occurrence: int,
) -> dict[str, Any] | None:
    answer = _answer_value(value, field)
    terminology = _terminology_codify_field(field, value)
    observation_answer = _observation_answer_value(answer, field, value, terminology)
    if observation_answer is None:
        return None
    obs = {
        "resourceType": "Observation",
        "id": f"obs-{_slug(patient_id)}-{_stable_id(field.document_name, field.form_index, row_number, field.variable, occurrence)}",
        "status": "final",
        "subject": {"reference": f"Patient/{_slug(patient_id)}"},
        "encounter": {
            "reference": f"Encounter/{_encounter_id(patient_id, field.document_name, field.form_index, row_number)}"
        },
        "code": {
            "coding": _dedupe_codings(
                [
                    {
                        "system": "https://datakaveri.org/fhir/CodeSystem/icph-schema-variable",
                        "code": field.variable,
                        "display": field.question or field.variable,
                    }
                ]
                + terminology.get("question", [])
            ),
            "text": field.question or field.variable,
        },
        "extension": [
            _schema_variable_extension(field)
        ],
    }
    if timestamp:
        obs["effectiveDateTime"] = timestamp
    obs.update(observation_answer)
    return obs


def _bundle_for_patient(
    patient_id: str,
    rows: list[tuple[int, list[str]]],
    *,
    fields: list[IcphSchemaField],
    document_name: str,
    form_index: int,
    form_title: str,
) -> dict[str, Any]:
    questionnaire = _questionnaire_resource(
        fields=fields,
        document_name=document_name,
        form_index=form_index,
        form_title=form_title,
    )
    entries = [
        {"resource": _patient_resource(patient_id)},
        {"resource": questionnaire},
    ]
    for row_number, values in rows:
        row_map = {field.variable: value for field, value in zip(fields, values)}
        timestamp = _fhir_datetime(row_map.get("AA02", ""))
        encounter = _encounter_resource(patient_id, row_number, timestamp, form_title, document_name, form_index)
        qr = _questionnaire_response(
            patient_id=patient_id,
            row_number=row_number,
            timestamp=timestamp,
            fields=fields,
            values=values,
            document_name=document_name,
            form_index=form_index,
            form_title=form_title,
        )
        entries.append({"resource": encounter})
        entries.append({"resource": qr})
        if _include_derived_observations():
            occurrence_count: dict[str, int] = {}
            for field, value in zip(fields, values):
                occurrence_count[field.variable] = occurrence_count.get(field.variable, 0) + 1
                observation = _observation_resource(
                    patient_id,
                    row_number,
                    timestamp,
                    field,
                    value,
                    occurrence_count[field.variable],
                )
                if observation:
                    entries.append({"resource": observation})
    bundle_hash = _stable_id(patient_id, document_name, form_index, len(entries))
    return {
        "resourceType": "Bundle",
        "id": f"icph-{_slug(patient_id)}-{_slug(document_name)}-form-{form_index}-{bundle_hash}",
        "type": "collection",
        "timestamp": _now_iso(),
        "entry": entries,
    }


def _patient_bundle_path(patient_id: str, document_name: str) -> Path:
    return BUNDLES_ROOT / f"{patient_id}_{Path(document_name).stem}docx.fhir.json"


def _load_existing_patient_bundle(patient_id: str, document_name: str) -> dict[str, Any] | None:
    output_path = _patient_bundle_path(patient_id, document_name)
    if not output_path.is_file():
        return None
    try:
        bundle = json.loads(output_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    if bundle.get("resourceType") != "Bundle":
        return None
    return bundle


def _resource_key(entry: dict[str, Any]) -> tuple[str, str] | None:
    resource = entry.get("resource")
    if not isinstance(resource, dict):
        return None
    resource_type = str(resource.get("resourceType") or "")
    resource_id = str(resource.get("id") or "")
    if not resource_type or not resource_id:
        return None
    return resource_type, resource_id


def _resource_timestamp(resource: dict[str, Any]) -> str:
    if resource.get("resourceType") == "Questionnaire":
        return str(resource.get("date") or "")
    if resource.get("resourceType") == "Encounter":
        return str((resource.get("period") or {}).get("start") or "")
    if resource.get("resourceType") == "QuestionnaireResponse":
        return str(resource.get("authored") or "")
    if resource.get("resourceType") == "Observation":
        return str(resource.get("effectiveDateTime") or "")
    return ""


def _entry_sort_key(entry: dict[str, Any]) -> tuple[str, int, str]:
    resource = entry.get("resource") or {}
    resource_type = str(resource.get("resourceType") or "")
    type_rank = {
        "Patient": 0,
        "Questionnaire": 1,
        "Encounter": 2,
        "QuestionnaireResponse": 3,
        "Observation": 4,
    }.get(resource_type, 9)
    return (_resource_timestamp(resource), type_rank, str(resource.get("id") or ""))


def _merge_patient_bundle(
    *,
    patient_id: str,
    document_name: str,
    form_bundle: dict[str, Any],
) -> tuple[dict[str, Any], int, int]:
    existing_bundle = _load_existing_patient_bundle(patient_id, document_name)
    existing_entries = list((existing_bundle or {}).get("entry") or [])
    if not _include_derived_observations():
        existing_entries = [
            entry for entry in existing_entries
            if (entry.get("resource") or {}).get("resourceType") != "Observation"
        ]
    new_entries = list(form_bundle.get("entry") or [])
    new_keys = {key for entry in new_entries if (key := _resource_key(entry))}

    merged_entries: list[dict[str, Any]] = []
    replaced_count = 0
    seen_keys: set[tuple[str, str]] = set()
    for entry in existing_entries:
        key = _resource_key(entry)
        if key in new_keys:
            replaced_count += 1
            continue
        if key:
            seen_keys.add(key)
        merged_entries.append(entry)

    appended_count = 0
    for entry in new_entries:
        key = _resource_key(entry)
        if key and key in seen_keys:
            continue
        if key:
            seen_keys.add(key)
        appended_count += 1
        merged_entries.append(entry)

    patient_entries = [entry for entry in merged_entries if (entry.get("resource") or {}).get("resourceType") == "Patient"]
    non_patient_entries = [
        entry for entry in merged_entries if (entry.get("resource") or {}).get("resourceType") != "Patient"
    ]
    if patient_entries:
        patient_entry = patient_entries[-1]
    else:
        patient_entry = {"resource": _patient_resource(patient_id)}

    non_patient_entries.sort(key=_entry_sort_key)
    bundle_hash = _stable_id(patient_id, document_name, len(non_patient_entries))
    return (
        {
            "resourceType": "Bundle",
            "id": f"icph-{_slug(patient_id)}-{_slug(document_name)}-longitudinal-{bundle_hash}",
            "type": "collection",
            "timestamp": _now_iso(),
            "entry": [patient_entry] + non_patient_entries,
        },
        replaced_count,
        appended_count,
    )


def _save_uploaded_csv(uploaded_file) -> Path:
    UPLOADS_ROOT.mkdir(parents=True, exist_ok=True)
    target = UPLOADS_ROOT / Path(uploaded_file.name).name
    with tempfile.NamedTemporaryFile(delete=False) as temp_handle:
        temp_handle.write(uploaded_file.getbuffer())
        temp_path = Path(temp_handle.name)
    shutil.move(str(temp_path), target)
    return target


def run_icph_csv_pipeline(uploaded_file_or_path, primary_identifier_variable: str | None = None) -> dict[str, Any]:
    primary_identifier = str(primary_identifier_variable or "").strip()
    if not primary_identifier:
        raise ValueError("Primary identifier variable is required for ICPH CSV to FHIR mapping.")

    if isinstance(uploaded_file_or_path, (str, Path)):
        csv_path = Path(uploaded_file_or_path)
    else:
        csv_path = _save_uploaded_csv(uploaded_file_or_path)

    document_name, form_index = _parse_csv_form_identity(csv_path.name)
    fields = load_icph_schema_fields(document_name, form_index)
    form_title = fields[0].form_title
    expected_header = [field.variable for field in fields]
    header, raw_rows = _read_csv_preserve_duplicate_headers(csv_path)
    header, raw_rows, ignored_columns = _align_csv_to_schema(header, raw_rows, expected_header)
    if header != expected_header:
        raise ValueError(
            "CSV header does not match the ICPH schema for "
            f"{document_name} form {form_index}. "
            f"Expected {len(expected_header)} columns, got {len(header)}."
        )
    try:
        primary_identifier_index = header.index(primary_identifier)
    except ValueError as exc:
        raise ValueError(
            f"CSV does not contain selected primary identifier column `{primary_identifier}`."
        ) from exc

    patient_rows: dict[str, list[tuple[int, list[str]]]] = defaultdict(list)
    for row_number, row in enumerate(raw_rows, start=2):
        padded = row[: len(header)] + [""] * max(0, len(header) - len(row))
        patient_id = str(padded[primary_identifier_index]).strip()
        if not patient_id:
            raise ValueError(
                f"Missing selected primary identifier `{primary_identifier}` at CSV row {row_number}."
            )
        patient_rows[patient_id].append((row_number, padded[: len(header)]))

    aa02_index = header.index("AA02") if "AA02" in header else None
    if aa02_index is not None:
        for rows in patient_rows.values():
            rows.sort(key=lambda item: _parse_datetime(item[1][aa02_index]) or datetime.max)

    BUNDLES_ROOT.mkdir(parents=True, exist_ok=True)
    bundles: list[dict[str, Any]] = []
    for patient_id, rows in sorted(patient_rows.items()):
        form_bundle = _bundle_for_patient(
            patient_id,
            rows,
            fields=fields,
            document_name=document_name,
            form_index=form_index,
            form_title=form_title,
        )
        bundle, replaced_count, appended_count = _merge_patient_bundle(
            patient_id=patient_id,
            document_name=document_name,
            form_bundle=form_bundle,
        )
        output_path = _patient_bundle_path(patient_id, document_name)
        output_path.write_text(json.dumps(bundle, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        bundles.append(
            {
                "patient_id": patient_id,
                "visit_count": len(rows),
                "bundle": bundle,
                "bundle_path": str(output_path),
                "entry_count": len(bundle.get("entry", [])),
                "replaced_entry_count": replaced_count,
                "appended_entry_count": appended_count,
            }
        )

    return {
        "source_csv_path": str(csv_path),
        "source_csv_sha256": _sha256_file(csv_path),
        "document_name": document_name,
        "form_index": form_index,
        "form_title": form_title,
        "schema_path": str(PROCESSED_MD_DIR / f"{Path(document_name).stem}.md"),
        "patient_count": len(patient_rows),
        "row_count": len(raw_rows),
        "column_count": len(header),
        "primary_identifier_variable": primary_identifier,
        "ignored_columns": ignored_columns,
        "bundles": bundles,
        "output_dir": str(BUNDLES_ROOT),
    }


def _source_upload_name(uploaded_file_or_path) -> str:
    if isinstance(uploaded_file_or_path, (str, Path)):
        return Path(uploaded_file_or_path).name
    return str(getattr(uploaded_file_or_path, "name", "") or "")


def run_icph_csv_batch(uploaded_files_or_paths, primary_identifier_variable: str | None = None) -> dict[str, Any]:
    primary_identifier = str(primary_identifier_variable or "").strip()
    if not primary_identifier:
        raise ValueError("Primary identifier variable is required for ICPH CSV batch mapping.")

    uploads = list(uploaded_files_or_paths or [])
    if not uploads:
        raise ValueError("No ICPH CSV files were provided.")

    def sort_key(upload) -> tuple[int, int, str]:
        document_name, form_index = _parse_csv_form_identity(_source_upload_name(upload))
        return int(Path(document_name).stem), form_index, _source_upload_name(upload).lower()

    sorted_uploads = sorted(uploads, key=sort_key)
    file_results: list[dict[str, Any]] = []
    final_bundles: dict[tuple[str, str], dict[str, Any]] = {}
    total_rows = 0
    total_columns = 0
    processed_forms = []

    for upload in sorted_uploads:
        result = run_icph_csv_pipeline(upload, primary_identifier_variable=primary_identifier)
        file_results.append(result)
        total_rows += int(result.get("row_count") or 0)
        total_columns += int(result.get("column_count") or 0)
        processed_forms.append(
            {
                "source_csv_path": result.get("source_csv_path"),
                "document_name": result.get("document_name"),
                "form_index": result.get("form_index"),
                "form_title": result.get("form_title"),
                "row_count": result.get("row_count"),
                "patient_count": result.get("patient_count"),
                "ignored_columns": result.get("ignored_columns", []),
            }
        )
        for bundle_info in result.get("bundles", []):
            key = (str(bundle_info.get("patient_id") or ""), str(bundle_info.get("bundle_path") or ""))
            final_bundles[key] = bundle_info

    return {
        "source_file_count": len(sorted_uploads),
        "patient_count": len({patient_id for patient_id, _ in final_bundles}),
        "row_count": total_rows,
        "column_count": total_columns,
        "schema_path": str(PROCESSED_MD_DIR),
        "processed_forms": processed_forms,
        "file_results": file_results,
        "bundles": list(final_bundles.values()),
        "output_dir": str(BUNDLES_ROOT),
    }
