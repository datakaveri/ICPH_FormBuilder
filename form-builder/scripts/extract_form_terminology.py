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
import re
import sys
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
}

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
    "bicycle",
    "bike",
    "bleeding",
    "body",
    "brain",
    "burn",
    "burns",
    "chest",
    "child",
    "death",
    "deceased",
    "drowning",
    "fall",
    "fatal",
    "fracture",
    "gender",
    "gunshot",
    "head",
    "health",
    "helmet",
    "homicide",
    "injury",
    "intent",
    "mechanism",
    "medical",
    "motorcycle",
    "neck",
    "patient",
    "pedestrian",
    "poisoning",
    "postmortem",
    "pregnancy",
    "pregnant",
    "road",
    "seatbelt",
    "sex",
    "substance",
    "suicide",
    "transport",
    "trauma",
    "vehicle",
}


def utc_stamp() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
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
        f"Variable name: {clean_text(question.get('name'))}" if question.get("name") else "",
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
    return {
        "entity": entity,
        "originalEntity": original,
        "terminology": "SNOMED CT" if code else "",
        "code": code,
        "term": term,
        "negated": bool(mapping.get("source_assertion_negated") or mapping.get("negated")),
        "allergy": bool(mapping.get("is_allergy")),
        "raw": mapping,
    }


def latest_snomed_lookup_path(mapper_root: Path) -> Path | None:
    lookup_root = mapper_root / "SchemaTerminologies" / "artifacts" / "shared" / "snomed_ct"
    if not lookup_root.is_dir():
        return None
    candidates = sorted(lookup_root.glob("*/lookups/snomed_ct_lookup.csv"))
    return candidates[-1] if candidates else None


def lookup_keys(value: Any) -> set[str]:
    text = clean_text(value)
    if not text:
        return set()
    without_semantic_tag = re.sub(r"\s*\([^()]*\)\s*$", "", text).strip()
    keys = {candidate_key(text), candidate_key(without_semantic_tag)}
    return {key for key in keys if key}


class ExactSnomedLookup:
    def __init__(self, mapper_root: Path):
        self.records: dict[str, dict[str, str]] = {}
        self.error = ""
        path = latest_snomed_lookup_path(mapper_root)
        if path is None:
            self.error = "SNOMED lookup CSV was not found; entities are shown without codes."
            return
        try:
            with path.open("r", encoding="utf-8", newline="") as handle:
                reader = csv.DictReader(handle)
                for row in reader:
                    code = clean_text(row.get("code"))
                    if not code:
                        continue
                    record = {
                        "code": code,
                        "term": clean_text(row.get("preferred_term") or row.get("display") or row.get("fsn")),
                        "fsn": clean_text(row.get("fsn") or row.get("display") or row.get("preferred_term")),
                        "system_uri": clean_text(row.get("system_uri") or "http://snomed.info/sct"),
                    }
                    for value in (row.get("display"), row.get("preferred_term"), row.get("fsn")):
                        for key in lookup_keys(value):
                            self.records.setdefault(key, record)
        except Exception as exc:
            self.records = {}
            self.error = f"Could not load SNOMED lookup CSV; entities are shown without codes: {exc}"

    def match(self, entity: str) -> dict[str, str] | None:
        for key in lookup_keys(entity):
            if key in self.records:
                return self.records[key]
        words = words_for(entity)
        if len(words) == 1 and len(words[0]) > 3 and words[0].endswith("s"):
            return self.records.get(words[0][:-1])
        return None


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
    candidates: list[str] = []

    if meaningful_words:
        compact_words = [word for word in semantic_words if word not in {"completed", "performed"}]
        if compact_words:
            candidates.append(title_candidate(compact_words[:8]))
        candidates.extend(title_candidate([word]) for word in meaningful_words)
    elif include_option and len(semantic_words) >= 2:
        candidates.append(title_candidate(semantic_words[:8]))

    clean_candidates = []
    seen = set()
    for candidate in candidates:
        key = candidate_key(candidate)
        if not key or key in OPTION_SKIP_VALUES or key in seen:
            continue
        seen.add(key)
        clean_candidates.append(candidate)
    return clean_candidates


def extract_form_entities(question: dict[str, Any], lookup: ExactSnomedLookup | None = None) -> list[dict[str, Any]]:
    qtype = clean_text(question.get("type"))
    if qtype in SKIP_TYPES:
        return []

    candidates: list[str] = []
    for value in (
        question.get("label"),
        question.get("hint"),
        question.get("guidanceHint") or question.get("guidance_hint"),
    ):
        candidates.extend(phrase_candidates(value))

    if not candidates:
        candidates.extend(phrase_candidates(humanize_name(question.get("name"))))

    if qtype.startswith("select_"):
        for option in question.get("options") or []:
            candidates.extend(phrase_candidates(option.get("label") or option.get("name"), include_option=True))

    entities = []
    seen = set()
    for candidate in candidates:
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
        }
        match = lookup.match(candidate) if lookup is not None else None
        if match:
            mapping.update(
                {
                    "concept_id": match.get("code", ""),
                    "term": match.get("term", ""),
                    "fsn": match.get("fsn", ""),
                    "system_uri": match.get("system_uri", "http://snomed.info/sct"),
                    "matched_via": "form_definition_exact_snomed",
                    "confidence": "High",
                }
            )
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
    questions = list(form.get("questions") or [])
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
    }
    write_json(args.output_path, payload)

    lookup = ExactSnomedLookup(args.mapper_root)
    if lookup.error:
        payload["warnings"].append({"stage": "SNOMED", "message": lookup.error})
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
                result["entities"] = extract_form_entities(question, lookup)
            except Exception as exc:
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
