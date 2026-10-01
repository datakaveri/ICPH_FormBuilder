#!/usr/bin/env python3
"""Extract terminology candidates from an ICPH form draft.

This script is launched by the form-builder API as a background job after a
form is published. It writes progress and final results to a workspace JSON
file so the React UI can poll without blocking form filling.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SKIP_TYPES = {
    "begin_group",
    "end_group",
    "begin_repeat",
    "end_repeat",
    "calculate",
    "hidden",
    "start",
    "end",
    "today",
    "deviceid",
    "username",
    "phonenumber",
    "email",
    "audit",
    "csv-external",
    "timer",
}
STRUCTURAL_TYPES = {"begin_group", "end_group", "begin_repeat", "end_repeat"}

OPTION_SKIP_VALUES = {
    "yes",
    "no",
    "other",
    "others",
    "unknown",
    "not known",
    "dont know",
    "don't know",
    "not applicable",
    "na",
    "n/a",
    "none",
    "refused",
    "prefer not to say",
}

QUESTION_WORD_DROP = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "by",
    "code",
    "completed",
    "date",
    "day",
    "days",
    "detail",
    "details",
    "did",
    "do",
    "does",
    "enter",
    "field",
    "for",
    "form",
    "from",
    "has",
    "have",
    "id",
    "identification",
    "if",
    "in",
    "is",
    "month",
    "months",
    "name",
    "number",
    "of",
    "on",
    "or",
    "please",
    "question",
    "record",
    "reported",
    "reporting",
    "select",
    "section",
    "specify",
    "the",
    "then",
    "time",
    "to",
    "total",
    "type",
    "value",
    "was",
    "were",
    "with",
    "without",
    "year",
    "years",
}

MEANINGFUL_WORDS = {
    "abdomen",
    "abdominal",
    "age",
    "alcohol",
    "assault",
    "autopsy",
    "birth",
    "bicycle",
    "bike",
    "bleeding",
    "body",
    "brain",
    "burn",
    "burns",
    "chest",
    "child",
    "cholesterol",
    "consent",
    "death",
    "deceased",
    "drowning",
    "diabetes",
    "diabetic",
    "diastolic",
    "fall",
    "fatal",
    "fracture",
    "gestational",
    "gender",
    "gunshot",
    "head",
    "health",
    "helmet",
    "homicide",
    "injury",
    "insulin",
    "intent",
    "mechanism",
    "medical",
    "menstrual",
    "motorcycle",
    "neck",
    "patient",
    "period",
    "pedestrian",
    "poisoning",
    "postmortem",
    "pregnancy",
    "pregnant",
    "pressure",
    "road",
    "seatbelt",
    "sex",
    "sugar",
    "systolic",
    "substance",
    "suicide",
    "transport",
    "trauma",
    "vehicle",
}

KNOWN_TERM_PATTERNS = [
    (r"\bdate\s+of\s+birth\b", "Date of birth"),
    (r"\bbirth\s+date\b", "Date of birth"),
    (r"\bgestational\s+age\b", "Gestational age"),
    (r"\blast\s+menstrual\s+period\b", "Last menstrual period"),
    (r"\bmenstrual\s+period\b", "Menstrual period"),
    (r"\binformed\s+consent\b", "Informed consent"),
    (r"\bblood\s+pressure\b", "Blood pressure"),
    (r"\bsystolic\s+blood\s+pressure\b", "Systolic blood pressure"),
    (r"\bdiastolic\s+blood\s+pressure\b", "Diastolic blood pressure"),
    (r"\bblood\s+sugar\b", "Blood sugar"),
    (r"\bgestational\s+diabetes\b", "Gestational diabetes"),
    (r"\bdiabetes\b", "Diabetes"),
    (r"\bcholesterol\b", "Cholesterol"),
    (r"\bpreeclampsia\b", "Preeclampsia"),
    (r"\beclampsia\b", "Eclampsia"),
    (r"\basthma\b", "Asthma"),
    (r"\bkidney\s+disease\b", "Kidney disease"),
    (r"\bheart\s+disease\b", "Heart disease"),
    (r"\bphone\s+number\b", "Phone number"),
    (r"\btelephone\s+number\b", "Phone number"),
]

MEANINGFUL_WORDS -= {"birth", "gestational", "menstrual", "period"}

VOCABULARY_LABELS = {
    "snomed": "SNOMED CT",
    "loinc": "LOINC",
    "icd10": "ICD-10",
    "rxnorm": "RxNorm",
}

VOCABULARY_SYSTEM_URIS = {
    "snomed": "http://snomed.info/sct",
    "loinc": "http://loinc.org",
    "icd10": "http://hl7.org/fhir/sid/icd-10-cm",
    "rxnorm": "http://rxnorm.info/rxcui",
}

SEARCH_STOP_WORDS = {
    "a",
    "an",
    "and",
    "as",
    "by",
    "for",
    "from",
    "in",
    "is",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
}

AUTO_APPROVE_SKIP_KEYS = {
    "health",
    "individual",
    "medical",
    "name",
    "patient",
    "person",
    "respondent",
}


def utc_stamp() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
            if existing.get("status") == "skipped_unmapped":
                return
        except Exception:
            pass
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temp_path.replace(path)


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def display_text(value: Any) -> str:
    """Return a stable display string from plain or multilingual XLSForm values."""
    if isinstance(value, dict):
        for key in ("english", "en", "default", "label"):
            if key in value:
                text = display_text(value[key])
                if text:
                    return text
        for item in value.values():
            text = display_text(item)
            if text:
                return text
        return ""
    if isinstance(value, list):
        return clean_text(" ".join(display_text(item) for item in value))
    return clean_text(value)


def question_text(question: dict[str, Any]) -> str:
    parts = [
        display_text(question.get("label")),
        display_text(question.get("hint")),
        display_text(question.get("guidanceHint") or question.get("guidance_hint")),
    ]
    options = []
    for option in question.get("options") or []:
        label = display_text(option.get("label"))
        name = clean_text(option.get("name"))
        if label and name:
            options.append(f"{label} ({name})")
        elif label or name:
            options.append(label or name)
    if options:
        parts.append("Options: " + "; ".join(options))
    return ". ".join(part for part in parts if part)


def compact_entity(mapping: dict[str, Any]) -> dict[str, Any]:
    entity = clean_text(mapping.get("entity") or mapping.get("original_entity"))
    original = clean_text(mapping.get("original_entity") or entity)
    vocabulary = clean_text(mapping.get("vocabulary") or "")
    vocabulary_label = clean_text(
        mapping.get("vocabularyLabel")
        or mapping.get("terminology")
        or VOCABULARY_LABELS.get(vocabulary, "")
    )
    code = clean_text(
        mapping.get("snomed_code")
        or mapping.get("concept_id")
        or mapping.get("code")
        or mapping.get("standard_concept_code")
    )
    term = clean_text(
        mapping.get("snomed_term")
        or mapping.get("term")
        or mapping.get("concept_name")
        or mapping.get("label")
    )
    approved_mappings = mapping.get("approved_mappings") or mapping.get("approvedMappings") or []
    candidate_mappings = mapping.get("candidate_mappings") or mapping.get("candidateMappings") or []
    return {
        "entity": entity,
        "originalEntity": original,
        "sourceComponent": clean_text(mapping.get("source_component") or mapping.get("sourceComponent")),
        "sourceLabel": clean_text(mapping.get("source_label") or mapping.get("sourceLabel")),
        "sourceText": clean_text(mapping.get("source_text") or mapping.get("sourceText")),
        "sourceQuestion": clean_text(mapping.get("source_question") or mapping.get("sourceQuestion")),
        "decompositionMethod": clean_text(mapping.get("decomposition_method") or mapping.get("decompositionMethod") or "form_definition_phrase_candidates"),
        "vocabulary": vocabulary,
        "vocabularyLabel": vocabulary_label,
        "terminology": vocabulary_label if code else "",
        "code": code,
        "term": term,
        "display": clean_text(mapping.get("display") or term or entity),
        "fsn": clean_text(mapping.get("fsn") or mapping.get("fully_specified_name") or term),
        "systemUri": clean_text(mapping.get("systemUri") or mapping.get("system_uri") or VOCABULARY_SYSTEM_URIS.get(vocabulary, "")),
        "candidateMappings": candidate_mappings,
        "approvedMappings": approved_mappings,
        "validationStatus": clean_text(mapping.get("validationStatus") or mapping.get("validation_status")),
        "validated": bool(mapping.get("validated")),
        "negated": bool(mapping.get("source_assertion_negated") or mapping.get("negated")),
        "allergy": bool(mapping.get("is_allergy")),
        "raw": mapping,
    }


def latest_shared_lookup_path(mapper_root: Path, vocabulary: str, file_name: str) -> Path | None:
    lookup_root = mapper_root / "SchemaTerminologies" / "artifacts" / "shared" / vocabulary
    if not lookup_root.is_dir():
        return None
    candidates = sorted(lookup_root.glob(f"*/lookups/{file_name}"))
    return candidates[-1] if candidates else None


def latest_snomed_lookup_path(mapper_root: Path) -> Path | None:
    return latest_shared_lookup_path(mapper_root, "snomed_ct", "snomed_ct_lookup.csv")


def latest_icd10_lookup_path(mapper_root: Path) -> Path | None:
    return latest_shared_lookup_path(mapper_root, "icd10", "icd10_lookup.csv")


def latest_rxnorm_metadata_path(mapper_root: Path) -> Path | None:
    return latest_shared_lookup_path(mapper_root, "rxnorm", "rxnorm_metadata.json")


def latest_loinc_lookup_path(mapper_root: Path) -> Path | None:
    loinc_root = mapper_root / "SchemaTerminologies" / "terminologies" / "loinc"
    if not loinc_root.is_dir():
        return None
    candidates = sorted(loinc_root.glob("*/LoincTable/Loinc.csv"))
    return candidates[-1] if candidates else None


def lookup_keys(value: Any) -> set[str]:
    text = clean_text(value)
    if not text:
        return set()
    without_semantic_tag = re.sub(r"\s*\([^()]*\)\s*$", "", text).strip()
    keys = {candidate_key(text), candidate_key(without_semantic_tag)}
    return {key for key in keys if key}


def normalize_search_text(value: Any) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", re.sub(r"\([^()]*\)\s*$", " ", str(value or "").lower()))).strip()


def search_tokens(value: Any) -> list[str]:
    return [
        token
        for token in dict.fromkeys(normalize_search_text(value).split())
        if len(token) >= 3 and token not in SEARCH_STOP_WORDS
    ]


def split_aliases(value: Any) -> list[str]:
    text = clean_text(value)
    if not text:
        return []
    if text.startswith("["):
        try:
            data = json.loads(text)
            if isinstance(data, list):
                return [clean_text(item) for item in data if clean_text(item)]
        except Exception:
            pass
    return [clean_text(item) for item in re.split(r"[;|]", text) if clean_text(item)]


def row_search_values(row: dict[str, str]) -> list[str]:
    values = row_primary_values(row)
    values.extend(split_aliases(row.get("aliases", "")))
    seen = set()
    unique = []
    for value in values:
        text = clean_text(value)
        key = normalize_search_text(text)
        if text and key and key not in seen:
            seen.add(key)
            unique.append(text)
    return unique


def row_primary_values(row: dict[str, str]) -> list[str]:
    return [
        row.get("display", ""),
        row.get("preferredTerm", ""),
        row.get("fsn", ""),
    ]


def score_vocabulary_row(row: dict[str, Any], query: str, query_key: str, tokens: list[str], exact: bool) -> float:
    row_keys = [normalize_search_text(value) for value in row_search_values(row)]
    row_keys = [key for key in row_keys if key]
    score = 1000.0 if exact else 0.0
    if any(key.startswith(query_key) or query_key.startswith(key) for key in row_keys):
        score += 160
    if query_key and query_key in row.get("searchText", ""):
        score += 130
    row_token_set = set(row.get("tokens") or [])
    overlap = len([token for token in tokens if token in row_token_set])
    coverage = overlap / len(tokens) if tokens else 0
    score += overlap * 35 + coverage * 80
    preferred_key = normalize_search_text(row.get("preferredTerm") or row.get("display"))
    if preferred_key and query_key and query_key in preferred_key:
        score += 40
    if clean_text(row.get("status")).lower() in {"active", "active_or_unknown", "active or unknown"}:
        score += 10
    if preferred_key or row.get("searchText"):
        score -= abs(len(preferred_key or row.get("searchText", "")) - len(query_key)) * (0.75 if len(tokens) == 1 else 0.12)
    return round(score, 2)


def is_high_confidence_match(row: dict[str, Any], query: str, query_key: str, tokens: list[str], exact: bool, primary_exact: bool, score: float) -> bool:
    if query_key in AUTO_APPROVE_SKIP_KEYS:
        return False
    if row.get("vocabulary") == "icd10":
        return primary_exact
    if exact:
        return True
    if len(tokens) < 2:
        return False
    row_token_set = set(row.get("tokens") or [])
    if not all(token in row_token_set for token in tokens):
        return False
    row_keys = [normalize_search_text(value) for value in row_search_values(row)]
    compact_query = query_key.replace(" ", "")
    for key in row_keys:
        if not key:
            continue
        compact_key = key.replace(" ", "")
        tight_length = len(compact_key) <= max(len(compact_query) * 2.4, len(compact_query) + 20)
        if tight_length and (key.startswith(query_key) or query_key.startswith(key) or query_key in key):
            return score >= 240
    return False


class BruteVocabularyLookup:
    def __init__(self, mapper_root: Path):
        self.indices: dict[str, dict[str, Any]] = {}
        self.warnings: list[dict[str, str]] = []
        self._load_snomed(mapper_root)
        self._load_loinc(mapper_root)
        self._load_icd10(mapper_root)
        self._load_rxnorm(mapper_root)

    def _new_index(self) -> dict[str, Any]:
        return {"rows": [], "tokenIndex": {}, "exactIndex": {}}

    def _add_row(self, index: dict[str, Any], vocabulary: str, row: dict[str, str]) -> None:
        code = clean_text(row.get("code"))
        if not code:
            return
        label = VOCABULARY_LABELS[vocabulary]
        row = {
            "vocabulary": vocabulary,
            "vocabularyLabel": label,
            "code": code,
            "display": clean_text(row.get("display")),
            "preferredTerm": clean_text(row.get("preferredTerm") or row.get("display")),
            "fsn": clean_text(row.get("fsn") or row.get("preferredTerm") or row.get("display")),
            "aliases": clean_text(row.get("aliases")),
            "status": clean_text(row.get("status")),
            "systemUri": clean_text(row.get("systemUri") or VOCABULARY_SYSTEM_URIS[vocabulary]),
        }
        values = row_search_values(row)
        row["searchText"] = normalize_search_text(" ".join(values))
        row["tokens"] = search_tokens(row["searchText"])
        row_index = len(index["rows"])
        index["rows"].append(row)
        for value in values:
            for key in lookup_keys(value):
                index["exactIndex"].setdefault(key, row_index)
        for token in row["tokens"]:
            index["tokenIndex"].setdefault(token, []).append(row_index)

    def _load_csv(self, vocabulary: str, path: Path | None, missing_message: str, row_mapper) -> None:
        if path is None:
            self.warnings.append({"stage": VOCABULARY_LABELS[vocabulary], "message": missing_message})
            return
        index = self._new_index()
        try:
            with path.open("r", encoding="utf-8", newline="") as handle:
                for row in csv.DictReader(handle):
                    self._add_row(index, vocabulary, row_mapper(row))
        except Exception as exc:
            self.warnings.append({"stage": VOCABULARY_LABELS[vocabulary], "message": f"Could not load lookup: {exc}"})
            return
        self.indices[vocabulary] = index

    def _load_snomed(self, mapper_root: Path) -> None:
        self._load_csv(
            "snomed",
            latest_snomed_lookup_path(mapper_root),
            "SNOMED lookup CSV was not found; SNOMED auto-mapping is disabled.",
            lambda row: {
                "code": row.get("code", ""),
                "display": row.get("display", ""),
                "preferredTerm": row.get("preferred_term") or row.get("display", ""),
                "fsn": row.get("fsn") or row.get("display", ""),
                "status": row.get("status", ""),
                "systemUri": row.get("system_uri") or VOCABULARY_SYSTEM_URIS["snomed"],
            },
        )

    def _load_loinc(self, mapper_root: Path) -> None:
        self._load_csv(
            "loinc",
            latest_loinc_lookup_path(mapper_root),
            "LOINC table was not found; LOINC auto-mapping is disabled.",
            lambda row: {
                "code": row.get("LOINC_NUM") or row.get("loinc_num") or "",
                "display": row.get("LONG_COMMON_NAME") or row.get("SHORTNAME") or row.get("COMPONENT") or "",
                "preferredTerm": row.get("SHORTNAME") or row.get("LONG_COMMON_NAME") or row.get("COMPONENT") or "",
                "fsn": row.get("LONG_COMMON_NAME") or " ".join(
                    clean_text(row.get(key)) for key in ("COMPONENT", "PROPERTY", "SYSTEM") if clean_text(row.get(key))
                ),
                "aliases": row.get("RELATEDNAMES2") or "",
                "status": row.get("STATUS") or "",
                "systemUri": VOCABULARY_SYSTEM_URIS["loinc"],
            },
        )

    def _load_icd10(self, mapper_root: Path) -> None:
        self._load_csv(
            "icd10",
            latest_icd10_lookup_path(mapper_root),
            "ICD-10 lookup CSV was not found; ICD-10 auto-mapping is disabled.",
            lambda row: {
                "code": row.get("code", ""),
                "display": row.get("display", ""),
                "preferredTerm": row.get("display", ""),
                "fsn": row.get("display", ""),
                "aliases": row.get("aliases", ""),
                "status": row.get("status", ""),
                "systemUri": row.get("system_uri") or VOCABULARY_SYSTEM_URIS["icd10"],
            },
        )

    def _load_rxnorm(self, mapper_root: Path) -> None:
        path = latest_rxnorm_metadata_path(mapper_root)
        if path is None:
            self.warnings.append({"stage": VOCABULARY_LABELS["rxnorm"], "message": "RxNorm metadata was not found; RxNorm auto-mapping is disabled."})
            return
        index = self._new_index()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            for row in data.get("rows") or []:
                self._add_row(index, "rxnorm", {
                    "code": row.get("code", ""),
                    "display": row.get("display") or row.get("indexed_term") or "",
                    "preferredTerm": row.get("display") or row.get("indexed_term") or "",
                    "fsn": row.get("display") or row.get("indexed_term") or "",
                    "status": row.get("status", ""),
                    "systemUri": row.get("system_uri") or VOCABULARY_SYSTEM_URIS["rxnorm"],
                })
        except Exception as exc:
            self.warnings.append({"stage": VOCABULARY_LABELS["rxnorm"], "message": f"Could not load lookup: {exc}"})
            return
        self.indices["rxnorm"] = index

    def search(self, entity: str, limit_per_vocabulary: int = 3) -> list[dict[str, Any]]:
        query_key = candidate_key(entity)
        if not query_key:
            return []
        tokens = search_tokens(entity)
        all_results: list[dict[str, Any]] = []
        for vocabulary, index in self.indices.items():
            candidate_ids = set()
            exact = False
            for key in lookup_keys(entity):
                if key in index["exactIndex"]:
                    candidate_ids.add(index["exactIndex"][key])
                    exact = True
            words = words_for(entity)
            if len(words) == 1 and len(words[0]) > 3 and words[0].endswith("s"):
                singular = words[0][:-1]
                if singular in index["exactIndex"]:
                    candidate_ids.add(index["exactIndex"][singular])
                    exact = True
            for token in tokens:
                postings = index["tokenIndex"].get(token, [])
                if len(postings) > 50000:
                    continue
                candidate_ids.update(postings)
            scored = []
            for row_index in candidate_ids:
                row = index["rows"][row_index]
                entity_keys = lookup_keys(entity)
                row_exact = any(index["exactIndex"].get(key) == row_index for key in entity_keys)
                row_primary_exact = any(lookup_keys(value) & entity_keys for value in row_primary_values(row))
                score = score_vocabulary_row(row, entity, query_key, tokens, row_exact)
                if score <= 0:
                    continue
                high_confidence = is_high_confidence_match(row, entity, query_key, tokens, row_exact, row_primary_exact, score)
                scored.append((score, high_confidence, row_exact, row_primary_exact, row))
            scored.sort(key=lambda item: (item[1], item[3], item[2], item[0]), reverse=True)
            for score, high_confidence, row_exact, row_primary_exact, row in scored[:limit_per_vocabulary]:
                all_results.append({
                    "vocabulary": row["vocabulary"],
                    "vocabularyLabel": row["vocabularyLabel"],
                    "terminology": row["vocabularyLabel"],
                    "code": row["code"],
                    "display": row["preferredTerm"] or row["display"] or row["fsn"],
                    "term": row["preferredTerm"] or row["display"] or row["fsn"],
                    "preferredTerm": row["preferredTerm"],
                    "fsn": row["fsn"],
                    "systemUri": row["systemUri"],
                    "status": row["status"],
                    "score": score,
                    "matchKind": "exact" if row_primary_exact else ("alias_exact" if row_exact else "lexical"),
                    "confidence": "High" if high_confidence else "Candidate",
                })
        all_results.sort(key=lambda item: (item["confidence"] == "High", item["matchKind"] == "exact", item["score"]), reverse=True)
        return all_results

    def high_confidence_matches(self, entity: str) -> list[dict[str, Any]]:
        seen_vocabularies = set()
        matches = []
        for match in self.search(entity, limit_per_vocabulary=3):
            if match.get("confidence") != "High":
                continue
            vocabulary = match.get("vocabulary")
            if vocabulary in seen_vocabularies:
                continue
            seen_vocabularies.add(vocabulary)
            matches.append(match)
        return matches


def humanize_name(value: Any) -> str:
    text = re.sub(r"[_\-]+", " ", clean_text(value))
    return re.sub(r"\s+", " ", text).strip()


def normalize_candidate_text(value: Any) -> str:
    text = display_text(value)
    text = re.sub(r"jr://\S+", " ", text)
    text = re.sub(r"\$\{[^}]+\}", " ", text)
    text = re.sub(r"^\s*\d+(?:\.\d+)*\s*", "", text)
    text = re.sub(r"[_/]+", " ", text)
    text = re.sub(r"[(){}\[\]<>]", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" \t\n\r:;,.!?-")
    return text


def candidate_key(value: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", str(value or "").lower()))


def words_for(value: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", str(value or "").lower())


def title_candidate(words: list[str]) -> str:
    return " ".join(words).strip().title()


def phrase_candidates(value: Any, *, include_option: bool = False) -> list[str]:
    text = normalize_candidate_text(value)
    if not text:
        return []

    normalized = candidate_key(text)
    if include_option and normalized in OPTION_SKIP_VALUES:
        return []

    words = words_for(text)
    if not words:
        return []

    semantic_words = [word for word in words if word not in QUESTION_WORD_DROP]
    meaningful_words = [word for word in semantic_words if word in MEANINGFUL_WORDS]
    if "aged" in semantic_words and "age" not in meaningful_words:
        meaningful_words.append("age")
    candidates: list[str] = []

    for pattern, canonical in KNOWN_TERM_PATTERNS:
        if re.search(pattern, normalized):
            candidates.append(canonical)

    if meaningful_words:
        candidates.extend(title_candidate([word]) for word in meaningful_words)
    elif include_option and 2 <= len(semantic_words) <= 4:
        candidates.append(title_candidate(semantic_words))

    clean_candidates = []
    seen = set()
    for candidate in candidates:
        key = candidate_key(candidate)
        if not key or key in OPTION_SKIP_VALUES or key in seen:
            continue
        seen.add(key)
        clean_candidates.append(candidate)
    return clean_candidates


def sourced_phrase_candidates(
    value: Any,
    *,
    source_component: str,
    source_label: str,
    include_option: bool = False,
) -> list[dict[str, str]]:
    source_text = display_text(value)
    return [
        {
            "candidate": candidate,
            "source_component": source_component,
            "source_label": source_label,
            "source_text": source_text,
        }
        for candidate in phrase_candidates(value, include_option=include_option)
    ]


def option_display_text(option: dict[str, Any]) -> str:
    label = display_text(option.get("label"))
    name = clean_text(option.get("name"))
    if label and name:
        return f"{label} ({name})"
    return label or name


LLM_ENTITY_PROMPT = """You are a clinical terminology extraction assistant.
Extract only independently codeable clinical, administrative, demographic, procedure,
measurement, substance, anatomy, or device concepts that are explicitly present in
the supplied form question. Preserve meaning-changing qualifiers such as body site,
severity, laterality, temporality, and negation. Do not invent diagnoses from a
question's answer type, and do not extract generic instruction words, units, or
response mechanics as entities.

Return ONLY valid JSON in this exact shape:
{{"entities":[{{"text":"...","confidence":"High|Medium|Low","reason":"..."}}]}}

QUESTION CONTEXT:
{context}
"""


def _json_from_model_text(value: Any) -> dict[str, Any]:
    text = clean_text(value)
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE | re.DOTALL).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("LLM response did not contain a JSON object.")
    parsed = json.loads(text[start:end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("LLM response JSON was not an object.")
    return parsed


class LlmEntityExtractor:
    """Small adapter for Ollama and OpenAI-compatible local model servers."""

    def __init__(self, endpoint: str | None = None, model: str | None = None):
        self.endpoint = (endpoint or os.environ.get("ICPH_LLM_ENDPOINT") or "http://10.10.17.55").rstrip("/")
        self.model = model or os.environ.get("ICPH_LLM_MODEL") or ""
        self.api_style = ""
        self.timeout = max(5, int(os.environ.get("ICPH_LLM_TIMEOUT", "90")))
        self._discover_model()

    def _request_json(self, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        request = urllib.request.Request(
            f"{self.endpoint}{path}",
            data=json.dumps(payload).encode("utf-8") if payload is not None else None,
            headers={"content-type": "application/json"},
            method="POST" if payload is not None else "GET",
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def _discover_model(self) -> None:
        if self.model:
            self.api_style = "ollama"
            return
        model_rows: list[tuple[str, float]] = []
        try:
            data = self._request_json("/api/tags")
            for item in data.get("models") or []:
                name = clean_text(item.get("name") or item.get("model"))
                size = clean_text((item.get("details") or {}).get("parameter_size"))
                numeric_size = float(re.search(r"[0-9.]+", size).group(0)) if re.search(r"[0-9.]+", size) else 0
                if name:
                    model_rows.append((name, numeric_size))
            if model_rows:
                self.api_style = "ollama"
        except Exception:
            pass
        if not model_rows:
            try:
                data = self._request_json("/v1/models")
                for item in data.get("data") or []:
                    name = clean_text(item.get("id"))
                    if name:
                        model_rows.append((name, 0))
                if model_rows:
                    self.api_style = "openai"
            except Exception:
                pass
        if not model_rows:
            raise RuntimeError(f"No models could be discovered at {self.endpoint}.")

        def rank(row: tuple[str, float]) -> tuple[int, float, str]:
            name, size = row
            lowered = name.lower()
            family = next((score for token, score in {
                "qwen": 5,
                "llama": 4,
                "gemma": 3,
                "mistral": 2,
                "deepseek": 1,
            }.items() if token in lowered), 0)
            return family, size, name

        self.model = sorted(model_rows, key=rank, reverse=True)[0][0]

    def metadata(self) -> dict[str, Any]:
        return {"enabled": True, "endpoint": self.endpoint, "model": self.model, "apiStyle": self.api_style}

    def _complete(self, prompt: str) -> str:
        if self.api_style == "ollama":
            try:
                data = self._request_json("/api/chat", {
                    "model": self.model,
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": False,
                    "format": "json",
                    "options": {"temperature": 0.1},
                })
                return str((data.get("message") or {}).get("content") or "")
            except Exception:
                data = self._request_json("/api/generate", {
                    "model": self.model,
                    "prompt": prompt,
                    "stream": False,
                    "format": "json",
                    "options": {"temperature": 0.1},
                })
                return str(data.get("response") or "")
        data = self._request_json("/v1/chat/completions", {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
        })
        return str((((data.get("choices") or [{}])[0].get("message") or {}).get("content")) or "")

    def extract(self, question: dict[str, Any]) -> list[dict[str, str]]:
        context = question_text(question)
        parsed = _json_from_model_text(self._complete(LLM_ENTITY_PROMPT.format(context=context)))
        entities = parsed.get("entities")
        if not isinstance(entities, list):
            raise ValueError("LLM response did not contain an entities list.")
        results = []
        seen = set()
        for item in entities:
            if not isinstance(item, dict):
                continue
            text = normalize_candidate_text(item.get("text"))
            key = candidate_key(text)
            if not text or not key or key in seen or len(text) > 180:
                continue
            seen.add(key)
            results.append({
                "candidate": text,
                "confidence": clean_text(item.get("confidence")) or "Medium",
                "reason": clean_text(item.get("reason")),
            })
            if len(results) >= 12:
                break
        return results


def approved_mapping(match: dict[str, Any]) -> dict[str, Any]:
    return {
        "vocabulary": match.get("vocabulary", ""),
        "vocabularyLabel": match.get("vocabularyLabel", ""),
        "terminology": match.get("terminology") or match.get("vocabularyLabel", ""),
        "code": match.get("code", ""),
        "display": match.get("display", ""),
        "term": match.get("term") or match.get("display", ""),
        "preferredTerm": match.get("preferredTerm", ""),
        "fsn": match.get("fsn", ""),
        "systemUri": match.get("systemUri", ""),
        "confidence": match.get("confidence", ""),
        "matchKind": match.get("matchKind", ""),
        "score": match.get("score", 0),
        "approvedAt": utc_stamp(),
        "approvedVia": "automatic_high_confidence_brute_search",
    }


def extract_form_entities(
    question: dict[str, Any],
    lookup: BruteVocabularyLookup | None = None,
    llm: LlmEntityExtractor | None = None,
) -> list[dict[str, Any]]:
    qtype = clean_text(question.get("type"))
    if qtype in SKIP_TYPES:
        return []

    candidates: list[dict[str, str]] = []
    if llm is not None:
        for item in llm.extract(question):
            candidates.append({
                "candidate": item["candidate"],
                "source_component": "llm_analysis",
                "source_label": "LLM analysis",
                "source_text": question_text(question),
                "llm_confidence": item.get("confidence", "Medium"),
                "llm_reason": item.get("reason", ""),
            })
    else:
        candidates.extend(sourced_phrase_candidates(
            question.get("label"),
            source_component="label",
            source_label="Question",
        ))
        candidates.extend(sourced_phrase_candidates(
            question.get("hint"),
            source_component="hint",
            source_label="Question hint",
        ))
        candidates.extend(sourced_phrase_candidates(
            question.get("guidanceHint") or question.get("guidance_hint"),
            source_component="guidance_hint",
            source_label="Guidance hint",
        ))

        if qtype.startswith("select_"):
            for option in question.get("options") or []:
                option_text = option_display_text(option)
                option_candidates = sourced_phrase_candidates(
                    option.get("label") or option.get("name"),
                    source_component="option",
                    source_label="Option/choice",
                    include_option=True,
                )
                if option_text:
                    for item in option_candidates:
                        item["source_text"] = option_text
                candidates.extend(option_candidates)

    entities = []
    seen = set()
    for item in candidates:
        candidate = item["candidate"]
        key = candidate_key(candidate)
        if not key or key in seen:
            continue
        seen.add(key)
        mapping = {
            "entity": candidate,
            "original_entity": candidate,
            "matched_via": "form_definition_text",
            "confidence": "Extracted",
            "source_question": question.get("name") or question.get("id") or "",
            "source_component": item.get("source_component") or "",
            "source_label": item.get("source_label") or "",
            "source_text": item.get("source_text") or "",
            "decomposition_method": "llm_entity_decomposition" if llm is not None else "field_level_phrase_candidates",
        }
        if item.get("llm_confidence"):
            mapping["confidence"] = item["llm_confidence"]
        if item.get("llm_reason"):
            mapping["extraction_reason"] = item["llm_reason"]
        candidates_from_vocabularies = lookup.search(candidate) if lookup is not None else []
        if candidates_from_vocabularies:
            mapping["candidate_mappings"] = candidates_from_vocabularies[:12]
        entities.append(
            compact_entity(mapping)
        )
        if len(entities) >= 12:
            break
    return entities


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract question-level terminology from a form draft.")
    parser.add_argument("draft_path", type=Path)
    parser.add_argument("output_path", type=Path)
    parser.add_argument("--mapper-root", type=Path, required=True)
    parser.add_argument("--question-ids", default="", help="Comma-separated question IDs/names to rerun.")
    parser.add_argument("--merge-existing", action="store_true", help="Preserve non-selected question results already in the output file.")
    args = parser.parse_args()

    sys.path.insert(0, str(args.mapper_root))

    started_at = utc_stamp()
    form = json.loads(args.draft_path.read_text(encoding="utf-8"))
    questions = [
        question
        for question in list(form.get("questions") or [])
        if clean_text(question.get("type")) not in STRUCTURAL_TYPES
    ]
    selected_ids = {item.strip() for item in args.question_ids.split(",") if item.strip()}
    existing_by_key: dict[str, dict[str, Any]] = {}
    existing_questions: list[dict[str, Any]] = []
    if args.merge_existing and args.output_path.is_file():
        try:
            existing_payload = json.loads(args.output_path.read_text(encoding="utf-8"))
            existing_questions = list(existing_payload.get("questions") or [])
            for item in existing_questions:
                key = clean_text(item.get("id") or item.get("name"))
                if key:
                    existing_by_key[key] = item
                name = clean_text(item.get("name"))
                if name:
                    existing_by_key[name] = item
        except Exception:
            existing_questions = []
    payload: dict[str, Any] = {
        "ok": True,
        "status": "running",
        "startedAt": started_at,
        "completedAt": None,
        "formTitle": form.get("title") or "",
        "formId": form.get("formId") or "",
        "questionCount": len(selected_ids) if selected_ids else len(questions),
        "processedQuestionCount": 0,
        "entityCount": 0,
        "questions": existing_questions if selected_ids and existing_questions else [],
        "warnings": [],
        "rerunQuestionIds": sorted(selected_ids),
        "llm": {"enabled": bool(form.get("terminologyUseLlm")), "status": "disabled"},
    }
    write_json(args.output_path, payload)

    lookup = BruteVocabularyLookup(args.mapper_root)
    llm = None
    if form.get("terminologyUseLlm"):
        try:
            llm = LlmEntityExtractor()
            payload["llm"] = {**llm.metadata(), "status": "ready"}
        except Exception as exc:
            payload["llm"] = {
                "enabled": True,
                "status": "unavailable",
                "endpoint": os.environ.get("ICPH_LLM_ENDPOINT") or "http://10.10.17.55",
                "error": str(exc),
            }
            payload["warnings"].append({
                "stage": "LLM",
                "message": f"LLM mode was enabled but could not be started; using deterministic extraction instead: {exc}",
            })
        write_json(args.output_path, payload)
    if lookup.warnings:
        payload["warnings"].extend(lookup.warnings)
        write_json(args.output_path, payload)

    output_by_key = {}
    if payload["questions"]:
        for existing in payload["questions"]:
            key = clean_text(existing.get("id") or existing.get("name"))
            if key:
                output_by_key[key] = existing
            name = clean_text(existing.get("name"))
            if name:
                output_by_key[name] = existing
    processed_count = 0
    for index, question in enumerate(questions, start=1):
        question_id = clean_text(question.get("id") or f"question_{index}")
        question_name = clean_text(question.get("name"))
        if selected_ids and question_id not in selected_ids and question_name not in selected_ids:
            if not existing_by_key.get(question_id) and not existing_by_key.get(question_name):
                result = {
                    "id": question.get("id") or f"question_{index}",
                    "name": question.get("name") or "",
                    "label": display_text(question.get("label")) or question.get("name") or f"Question {index}",
                    "type": clean_text(question.get("type")),
                    "sourceText": question_text(question),
                    "status": "not_rerun",
                    "processedText": "",
                    "entities": [],
                    "warnings": [],
                }
                payload["questions"].append(result)
                output_by_key[question_id] = result
            continue
        qtype = clean_text(question.get("type"))
        source_text = question_text(question)
        result = {
            "id": question.get("id") or f"question_{index}",
            "name": question.get("name") or "",
            "label": display_text(question.get("label")) or question.get("name") or f"Question {index}",
            "type": qtype,
            "sourceText": source_text,
            "status": "complete",
            "processedText": "",
            "entities": [],
            "warnings": [],
        }

        if not source_text or qtype in SKIP_TYPES:
            result["status"] = "skipped"
        else:
            try:
                result["processedText"] = source_text
                result["entities"] = extract_form_entities(question, lookup, llm)
            except Exception as exc:
                if llm is not None:
                    try:
                        result["entities"] = extract_form_entities(question, lookup, None)
                        result["warnings"] = [{
                            "stage": "LLM",
                            "message": f"LLM analysis failed for this question; deterministic extraction was used instead: {exc}",
                        }]
                    except Exception as fallback_exc:
                        result["status"] = "error"
                        result["warnings"] = [{"stage": "TERMINOLOGY", "message": str(fallback_exc)}]
                else:
                    result["status"] = "error"
                    result["warnings"] = [{"stage": "TERMINOLOGY", "message": str(exc)}]

        existing = output_by_key.get(question_id) or output_by_key.get(question_name)
        if existing in payload["questions"]:
            payload["questions"][payload["questions"].index(existing)] = result
        else:
            payload["questions"].append(result)
        output_by_key[question_id] = result
        if question_name:
            output_by_key[question_name] = result
        processed_count += 1
        payload["processedQuestionCount"] = processed_count
        payload["entityCount"] = sum(len(item.get("entities") or []) for item in payload["questions"])
        write_json(args.output_path, payload)

    payload.update({
        "status": "complete",
        "completedAt": utc_stamp(),
        "entityCount": sum(len(item.get("entities") or []) for item in payload["questions"]),
    })
    write_json(args.output_path, payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
