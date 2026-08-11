"""Generic XLSForm draft/CSV to FHIR mapper used by the ICPH form builder."""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _stable_id(*parts: Any, length: int = 12) -> str:
    text = "|".join(str(part or "") for part in parts)
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:length]


def _slug(value: Any, fallback: str = "item", max_length: int = 64) -> str:
    text = re.sub(r"[^A-Za-z0-9.-]+", "-", str(value or fallback)).strip("-")
    return (text or fallback)[:max_length]


def _local_system(workspace_id: str, stem: str) -> str:
    return f"https://datakaveri.org/fhir/icph-form-builder/{_slug(workspace_id)}/{_slug(stem)}"


def _question_type(question: dict[str, Any]) -> str:
    return str(question.get("type") or "").strip().lower()


STRUCTURAL_TYPES = {"begin_group", "end_group", "begin_repeat", "end_repeat"}
END_STRUCTURAL_TYPES = {"end_group", "end_repeat"}
QUESTIONNAIRE_EXCLUDED_TYPES = {"end_group", "end_repeat", "csv-external", "audit"}
NON_OBSERVATION_TYPES = {
    "note",
    "begin_group",
    "end_group",
    "begin_repeat",
    "end_repeat",
    "calculate",
    "csv-external",
    "audit",
    "image",
    "audio",
    "background-audio",
    "video",
    "file",
}
QUESTION_EXTENSION_URL = "https://datakaveri.org/fhir/StructureDefinition/icph-form-builder-question"
OPTION_EXTENSION_URL = "https://datakaveri.org/fhir/StructureDefinition/icph-form-builder-choice"
APPROVED_TERMINOLOGY_EXTENSION_URL = "https://datakaveri.org/fhir/StructureDefinition/icph-approved-terminology"
VOCABULARY_SYSTEM_URIS = {
    "snomed": "http://snomed.info/sct",
    "loinc": "http://loinc.org",
    "icd10": "http://hl7.org/fhir/sid/icd-10-cm",
    "rxnorm": "http://rxnorm.info/rxcui",
}


def _include_derived_observations() -> bool:
    return str(os.environ.get("ICPH_INCLUDE_DERIVED_OBSERVATIONS") or "").strip().lower() in {"1", "true", "yes"}


def _clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _vocabulary_key(value: Any) -> str:
    text = re.sub(r"[^a-z0-9]+", "", str(value or "").lower())
    if "loinc" in text:
        return "loinc"
    if "rxnorm" in text or "rxcui" in text:
        return "rxnorm"
    if "icd" in text:
        return "icd10"
    return "snomed"


def _mapping_to_coding(mapping: dict[str, Any]) -> dict[str, str] | None:
    code = _clean_text(mapping.get("code") or mapping.get("concept_id") or mapping.get("standard_concept_code"))
    if not code:
        return None
    vocabulary = mapping.get("vocabulary") or mapping.get("vocabularyLabel") or mapping.get("terminology")
    vocabulary_key = _vocabulary_key(vocabulary)
    system = _clean_text(mapping.get("systemUri") or mapping.get("system_uri") or VOCABULARY_SYSTEM_URIS.get(vocabulary_key))
    display = _clean_text(
        mapping.get("display")
        or mapping.get("term")
        or mapping.get("preferredTerm")
        or mapping.get("fsn")
        or mapping.get("concept_name")
        or code
    )
    if not system:
        return None
    return {"system": system, "code": code, "display": display or code}


def _question_review_keys(question: dict[str, Any]) -> list[str]:
    keys: list[str] = []
    for value in (question.get("name"), question.get("id")):
        text = _clean_text(value)
        if text and text not in keys:
            keys.append(text)
    return keys


def _approved_mappings_for_entity(entity: dict[str, Any]) -> list[dict[str, Any]]:
    if entity.get("validationStatus") == "unmapped_confirmed":
        return []
    if entity.get("validationStatus") == "auto_approved":
        return []
    approved = entity.get("approvedMappings")
    if isinstance(approved, list) and approved:
        return [
            mapping
            for mapping in approved
            if isinstance(mapping, dict)
            and mapping.get("approvedVia") != "automatic_high_confidence_brute_search"
        ]
    if entity.get("validated") and entity.get("code") and entity.get("validationStatus") in {"selected", "replaced"}:
        return [entity]
    return []


def _dedupe_codings(codings: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[tuple[str, str]] = set()
    unique: list[dict[str, str]] = []
    for coding in codings:
        key = (coding.get("system", ""), coding.get("code", ""))
        if not key[0] or not key[1] or key in seen:
            continue
        seen.add(key)
        unique.append(coding)
    return unique


def _load_approved_terminology(terminology_review_path: str | Path | None) -> dict[str, list[dict[str, str]]]:
    if not terminology_review_path:
        return {}
    path = Path(terminology_review_path)
    if not path.is_file():
        raise ValueError(f"Terminology review file was not found: {path}")

    review = json.loads(path.read_text(encoding="utf-8"))
    by_question: dict[str, list[dict[str, str]]] = defaultdict(list)
    for question in review.get("questions") or []:
        if not isinstance(question, dict):
            continue
        question_keys = [key for key in _question_review_keys(question) if key]
        for entity in question.get("entities") or []:
            if not isinstance(entity, dict):
                continue
            for mapping in _approved_mappings_for_entity(entity):
                coding = _mapping_to_coding(mapping)
                if not coding:
                    continue
                for key in question_keys:
                    by_question[key].append(coding)

    return {key: _dedupe_codings(codings) for key, codings in by_question.items() if codings}


def _approved_codings_for_question(
    question: dict[str, Any],
    terminology_by_question: dict[str, list[dict[str, str]]],
) -> list[dict[str, str]]:
    codings: list[dict[str, str]] = []
    for key in _question_review_keys(question):
        codings.extend(terminology_by_question.get(key, []))
    return _dedupe_codings(codings)


def _question_local_coding(workspace_id: str, question: dict[str, Any]) -> dict[str, str]:
    name = str(question.get("name") or "").strip()
    return {
        "system": _local_system(workspace_id, "questions"),
        "code": name,
        "display": str(question.get("label") or name),
    }


def _question_codings(
    workspace_id: str,
    question: dict[str, Any],
    terminology_by_question: dict[str, list[dict[str, str]]],
) -> list[dict[str, str]]:
    return [
        _question_local_coding(workspace_id, question),
        *_approved_codings_for_question(question, terminology_by_question),
    ]


def _approved_terminology_extension(codings: list[dict[str, str]]) -> dict[str, Any] | None:
    if not codings:
        return None
    return {
        "url": APPROVED_TERMINOLOGY_EXTENSION_URL,
        "extension": [{"url": "coding", "valueCoding": coding} for coding in codings],
    }


def _approved_terminology_stats(
    draft: dict[str, Any],
    terminology_by_question: dict[str, list[dict[str, str]]],
) -> tuple[int, int]:
    question_count = 0
    coding_count = 0
    for question in _questionnaire_questions(draft):
        codings = _approved_codings_for_question(question, terminology_by_question)
        if not codings:
            continue
        question_count += 1
        coding_count += len(codings)
    return question_count, coding_count


def _is_choice_type(question: dict[str, Any]) -> bool:
    return _question_type(question) in {
        "select_one",
        "select_multiple",
        "rank",
        "select_one_from_file",
        "select_multiple_from_file",
    }


def _is_multi_choice_type(question: dict[str, Any]) -> bool:
    return _question_type(question) in {"select_multiple", "select_multiple_from_file", "rank"}


def _questionnaire_questions(draft: dict[str, Any]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    questions: list[dict[str, Any]] = []
    for question in draft.get("questions") or []:
        name = str(question.get("name") or "").strip()
        qtype = _question_type(question)
        if not name or qtype in QUESTIONNAIRE_EXCLUDED_TYPES:
            continue
        if name in seen and qtype not in {"begin_group", "begin_repeat"}:
            continue
        seen.add(name)
        questions.append(question)
    return questions


def _answer_questions(draft: dict[str, Any]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    questions: list[dict[str, Any]] = []
    for question in draft.get("questions") or []:
        name = str(question.get("name") or "").strip()
        if not name or name in seen or _question_type(question) in STRUCTURAL_TYPES:
            continue
        seen.add(name)
        questions.append(question)
    return questions


def _option_display(question: dict[str, Any], code: str) -> str:
    for option in question.get("options") or []:
        if str(option.get("name") or "") == str(code):
            return str(option.get("label") or code).strip()
    return str(code)


def _split_choice_value(question: dict[str, Any], raw_value: Any) -> list[str]:
    if isinstance(raw_value, list):
        values: list[str] = []
        for item in raw_value:
            values.extend(_split_choice_value(question, item))
        return values
    text = str(raw_value or "").strip()
    if not text:
        return []
    qtype = _question_type(question)
    if qtype in {"select_multiple", "select_multiple_from_file", "rank"}:
        return [item.strip() for item in re.split(r"\s*\|\s*|\s+", text) if item.strip()]
    return [text]


def _answer_coding(workspace_id: str, draft: dict[str, Any], question: dict[str, Any], code: str) -> dict[str, str]:
    form_stem = draft.get("formId") or draft.get("title") or "form"
    list_stem = question.get("listName") or question.get("name") or "choices"
    return {
        "system": _local_system(workspace_id, f"{form_stem}-{list_stem}"),
        "code": str(code),
        "display": _option_display(question, code) or str(code),
    }


def _fhir_time(value: Any) -> str:
    text = str(value or "").strip()
    if re.match(r"^\d{2}:\d{2}$", text):
        return f"{text}:00"
    return text


def _fhir_datetime(value: Any) -> str:
    text = str(value or "").strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$", text):
        return f"{text}:00Z"
    if re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$", text):
        return f"{text}Z"
    return text


def _attachment_content_type(file_name: str) -> str:
    ext = Path(str(file_name or "")).suffix.lower()
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".pdf": "application/pdf",
    }.get(ext, "")


def _answer_attachment(text: str) -> dict[str, Any]:
    attachment: dict[str, Any] = {"title": text}
    if re.match(r"^\S+$", text):
        attachment["url"] = text
    content_type = _attachment_content_type(text)
    if content_type:
        attachment["contentType"] = content_type
    return attachment


def _qr_answers(workspace_id: str, draft: dict[str, Any], question: dict[str, Any], raw_value: Any) -> list[dict[str, Any]]:
    text = str(raw_value or "").strip()
    if not text:
        return []
    qtype = _question_type(question)
    if _is_choice_type(question):
        return [
            {"valueCoding": _answer_coding(workspace_id, draft, question, code)}
            for code in _split_choice_value(question, raw_value)
        ]
    if qtype == "integer":
        try:
            return [{"valueInteger": int(float(text))}]
        except ValueError:
            return [{"valueString": text}]
    if qtype in {"decimal", "range"}:
        try:
            return [{"valueDecimal": float(text)}]
        except ValueError:
            return [{"valueString": text}]
    if qtype == "date":
        return [{"valueDate": text}]
    if qtype == "time":
        return [{"valueTime": _fhir_time(text)}]
    if qtype in {"datetime", "start", "end"}:
        return [{"valueDateTime": _fhir_datetime(text)}]
    if qtype == "today":
        return [{"valueDate": text[:10]}]
    if qtype == "acknowledge":
        return [{"valueBoolean": text.lower() in {"1", "true", "yes", "ok"}}]
    if qtype in {"image", "audio", "background-audio", "video", "file"}:
        return [{"valueAttachment": _answer_attachment(text)}]
    return [{"valueString": text}]


def _observation_value(workspace_id: str, draft: dict[str, Any], question: dict[str, Any], raw_value: Any) -> dict[str, Any] | None:
    answers = _qr_answers(workspace_id, draft, question, raw_value)
    if not answers:
        return None
    if len(answers) > 1 or "valueCoding" in answers[0]:
        return {"valueCodeableConcept": {"coding": [answer["valueCoding"] for answer in answers if "valueCoding" in answer]}}
    answer = answers[0]
    if "valueInteger" in answer:
        return {"valueInteger": answer["valueInteger"]}
    if "valueDecimal" in answer:
        return {"valueDecimal": answer["valueDecimal"]}
    if "valueDate" in answer:
        return {"valueDateTime": answer["valueDate"]}
    if "valueTime" in answer:
        return {"valueString": answer["valueTime"]}
    if "valueDateTime" in answer:
        return {"valueDateTime": answer["valueDateTime"]}
    if "valueBoolean" in answer:
        return {"valueBoolean": answer["valueBoolean"]}
    return {"valueString": str(answer.get("valueString") or raw_value or "").strip()}


def _questionnaire_item_type(question: dict[str, Any]) -> str:
    qtype = _question_type(question)
    if qtype in {"begin_group", "begin_repeat"}:
        return "group"
    if qtype == "note":
        return "display"
    if qtype == "integer":
        return "integer"
    if qtype in {"decimal", "range"}:
        return "decimal"
    if qtype == "date":
        return "date"
    if qtype == "time":
        return "time"
    if qtype in {"datetime", "start", "end"}:
        return "dateTime"
    if qtype == "today":
        return "date"
    if _is_choice_type(question):
        return "choice"
    if qtype == "acknowledge":
        return "boolean"
    if qtype in {"image", "audio", "background-audio", "video", "file"}:
        return "attachment"
    if qtype == "text" and "multiline" in str(question.get("appearance") or "").lower():
        return "text"
    return "string"


def _string_extension(url: str, value: Any) -> dict[str, str] | None:
    text = str(value or "").strip()
    if not text:
        return None
    return {"url": url, "valueString": text}


def _bool_extension(url: str, value: Any) -> dict[str, bool] | None:
    if value is None or value == "":
        return None
    return {"url": url, "valueBoolean": bool(value)}


def _source_extension(question: dict[str, Any]) -> dict[str, Any]:
    columns = [
        ("name", question.get("name")),
        ("odkType", question.get("type")),
        ("listName", question.get("listName")),
        ("hint", question.get("hint")),
        ("appearance", question.get("appearance")),
        ("relevant", question.get("relevant")),
        ("constraint", question.get("constraint")),
        ("constraintMessage", question.get("constraintMessage")),
        ("requiredExpression", question.get("requiredExpression")),
        ("requiredMessage", question.get("requiredMessage")),
        ("default", question.get("defaultValue")),
        ("calculation", question.get("calculation")),
        ("trigger", question.get("trigger")),
        ("choiceFilter", question.get("choiceFilter")),
        ("parameters", question.get("parameters")),
        ("repeatCount", question.get("repeatCount")),
        ("guidanceHint", question.get("guidanceHint")),
        ("saveTo", question.get("saveTo")),
        ("image", question.get("image")),
        ("bigImage", question.get("bigImage")),
        ("audio", question.get("audio")),
        ("video", question.get("video")),
    ]
    extension = [item for key, value in columns if (item := _string_extension(key, value))]
    if (item := _bool_extension("required", question.get("required"))) is not None:
        extension.append(item)
    if (item := _bool_extension("readOnly", question.get("readOnly"))) is not None:
        extension.append(item)
    for key, value in sorted((question.get("extraColumns") or {}).items()):
        if item := _string_extension(f"extra-{key}", value):
            extension.append(item)
    return {"url": QUESTION_EXTENSION_URL, "extension": extension}


def _choice_extension(option: dict[str, Any]) -> dict[str, Any] | None:
    columns = [
        ("image", option.get("image")),
        ("audio", option.get("audio")),
        ("video", option.get("video")),
        ("bigImage", option.get("bigImage") or option.get("big-image")),
        ("geometry", option.get("geometry")),
    ]
    extension = [item for key, value in columns if (item := _string_extension(key, value))]
    for key, value in sorted((option.get("extraColumns") or {}).items()):
        if item := _string_extension(f"extra-{key}", value):
            extension.append(item)
    if not extension:
        return None
    return {"url": OPTION_EXTENSION_URL, "extension": extension}


def _answer_options(workspace_id: str, draft: dict[str, Any], question: dict[str, Any]) -> list[dict[str, Any]]:
    options = []
    for option in question.get("options") or []:
        code = str(option.get("name") or option.get("value") or "").strip()
        if not code:
            continue
        item = {"valueCoding": _answer_coding(workspace_id, draft, question, code)}
        if extension := _choice_extension(option):
            item["extension"] = [extension]
        options.append(item)
    return options


def _initial_answers(workspace_id: str, draft: dict[str, Any], question: dict[str, Any]) -> list[dict[str, Any]]:
    value = str(question.get("defaultValue") or "").strip()
    if not value or re.search(r"\b[a-zA-Z_][\w-]*\s*\(", value):
        return []
    return _qr_answers(workspace_id, draft, question, value)


def _literal_value(value: str) -> str:
    text = str(value or "").strip()
    wrapped = re.match(r"^(?:date|date-time)\(\s*['\"]([^'\"]+)['\"]\s*\)$", text, re.I)
    if wrapped:
        return wrapped.group(1)
    if (text.startswith("'") and text.endswith("'")) or (text.startswith('"') and text.endswith('"')):
        return text[1:-1]
    return text


def _enable_answer_for_source(
    workspace_id: str,
    draft: dict[str, Any],
    source: dict[str, Any] | None,
    value: str,
) -> dict[str, Any]:
    if source and _is_choice_type(source):
        return {"answerCoding": _answer_coding(workspace_id, draft, source, value)}
    qtype = _question_type(source or {})
    if qtype == "integer":
        try:
            return {"answerInteger": int(float(value))}
        except ValueError:
            return {"answerString": value}
    if qtype in {"decimal", "range"}:
        try:
            return {"answerDecimal": float(value)}
        except ValueError:
            return {"answerString": value}
    if qtype == "date" or qtype == "today":
        return {"answerDate": value[:10]}
    if qtype == "time":
        return {"answerTime": _fhir_time(value)}
    if qtype in {"datetime", "start", "end"}:
        return {"answerDateTime": _fhir_datetime(value)}
    if qtype == "acknowledge":
        return {"answerBoolean": str(value).strip().lower() in {"1", "true", "yes", "ok"}}
    return {"answerString": value}


def _parse_enable_term(
    workspace_id: str,
    draft: dict[str, Any],
    source_by_name: dict[str, dict[str, Any]],
    expression: str,
) -> dict[str, Any] | None:
    text = str(expression or "").strip()
    exists_match = re.match(r"^string-length\(\s*\$\{(?P<name>[A-Za-z_][\w.-]*)\}\s*\)\s*>\s*0$", text)
    if exists_match:
        return {"question": exists_match.group("name"), "operator": "exists", "answerBoolean": True}
    empty_match = re.match(r"^\$\{(?P<name>[A-Za-z_][\w.-]*)\}\s*(?P<operator>=|!=)\s*(['\"]{2})$", text)
    if empty_match:
        return {
            "question": empty_match.group("name"),
            "operator": "exists",
            "answerBoolean": empty_match.group("operator") == "!=",
        }
    selected_match = re.match(
        r"^(?P<negated>not\()?selected\(\s*\$\{(?P<name>[A-Za-z_][\w.-]*)\}\s*,\s*(?P<value>['\"][^'\"]+['\"])\s*\)\)?$",
        text,
    )
    if selected_match:
        name = selected_match.group("name")
        value = _literal_value(selected_match.group("value"))
        return {
            "question": name,
            "operator": "!=" if selected_match.group("negated") else "=",
            **_enable_answer_for_source(workspace_id, draft, source_by_name.get(name), value),
        }
    simple_match = re.match(
        r"^\$\{(?P<name>[A-Za-z_][\w.-]*)\}\s*(?P<operator>>=|<=|!=|=|>|<)\s*(?P<value>.+)$",
        text,
    )
    if not simple_match:
        return None
    name = simple_match.group("name")
    value = _literal_value(simple_match.group("value"))
    if value == "":
        return {"question": name, "operator": "exists", "answerBoolean": simple_match.group("operator") == "!="}
    return {
        "question": name,
        "operator": simple_match.group("operator"),
        **_enable_answer_for_source(workspace_id, draft, source_by_name.get(name), value),
    }


def _split_logic_terms(expression: str) -> tuple[list[str], str | None]:
    parts = re.split(r"\s+(and|or)\s+", str(expression or "").strip(), flags=re.I)
    if not parts:
        return [], None
    terms = [parts[index].strip() for index in range(0, len(parts), 2) if parts[index].strip()]
    joiners = [parts[index].strip().lower() for index in range(1, len(parts), 2)]
    if not joiners:
        return terms, None
    if len(set(joiners)) == 1:
        return terms, "all" if joiners[0] == "and" else "any"
    return [str(expression or "").strip()], None


def _enable_when(
    workspace_id: str,
    draft: dict[str, Any],
    source_by_name: dict[str, dict[str, Any]],
    expression: str,
) -> tuple[list[dict[str, Any]], str | None]:
    if not str(expression or "").strip():
        return [], None
    terms, behavior = _split_logic_terms(expression)
    parsed = [_parse_enable_term(workspace_id, draft, source_by_name, term) for term in terms]
    if not parsed or any(item is None for item in parsed):
        return [], None
    return [item for item in parsed if item], behavior


def _questionnaire_item(
    workspace_id: str,
    draft: dict[str, Any],
    question: dict[str, Any],
    source_by_name: dict[str, dict[str, Any]],
    terminology_by_question: dict[str, list[dict[str, str]]],
) -> dict[str, Any]:
    name = str(question.get("name") or "").strip()
    approved_codings = _approved_codings_for_question(question, terminology_by_question)
    extensions = [_source_extension(question)]
    if terminology_extension := _approved_terminology_extension(approved_codings):
        extensions.append(terminology_extension)
    item: dict[str, Any] = {
        "linkId": name,
        "definition": _local_system(workspace_id, f"question/{name}"),
        "code": _question_codings(workspace_id, question, terminology_by_question),
        "text": str(question.get("label") or name),
        "type": _questionnaire_item_type(question),
        "extension": extensions,
    }
    if question.get("required"):
        item["required"] = True
    if question.get("readOnly") or _question_type(question) == "calculate":
        item["readOnly"] = True
    if _is_multi_choice_type(question) or _question_type(question) == "begin_repeat":
        item["repeats"] = True
    if options := _answer_options(workspace_id, draft, question):
        item["answerOption"] = options
    if initial := _initial_answers(workspace_id, draft, question):
        item["initial"] = initial
    enable_when, behavior = _enable_when(
        workspace_id,
        draft,
        source_by_name,
        str(question.get("relevant") or ""),
    )
    if enable_when:
        item["enableWhen"] = enable_when
        if behavior and len(enable_when) > 1:
            item["enableBehavior"] = behavior
    return item


def _append_nested_questionnaire_item(
    root_items: list[dict[str, Any]],
    stack: list[dict[str, Any]],
    item: dict[str, Any],
    qtype: str,
) -> None:
    target = stack[-1].setdefault("item", []) if stack else root_items
    target.append(item)
    if qtype in {"begin_group", "begin_repeat"}:
        stack.append(item)


def _questionnaire_items(
    workspace_id: str,
    draft: dict[str, Any],
    terminology_by_question: dict[str, list[dict[str, str]]],
) -> list[dict[str, Any]]:
    root_items: list[dict[str, Any]] = []
    stack: list[dict[str, Any]] = []
    source_by_name: dict[str, dict[str, Any]] = {}
    for question in draft.get("questions") or []:
        qtype = _question_type(question)
        if qtype in END_STRUCTURAL_TYPES:
            if stack:
                stack.pop()
            continue
        name = str(question.get("name") or "").strip()
        if not name or qtype in QUESTIONNAIRE_EXCLUDED_TYPES:
            continue
        item = _questionnaire_item(workspace_id, draft, question, source_by_name, terminology_by_question)
        _append_nested_questionnaire_item(root_items, stack, item, qtype)
        source_by_name.setdefault(name, question)
    return root_items


def _questionnaire_resource(
    workspace_id: str,
    draft: dict[str, Any],
    terminology_by_question: dict[str, list[dict[str, str]]],
) -> dict[str, Any]:
    questionnaire_id = _slug(draft.get("formId") or draft.get("title") or workspace_id)
    return {
        "resourceType": "Questionnaire",
        "id": questionnaire_id,
        "url": _local_system(workspace_id, "questionnaire"),
        "status": "active",
        "title": str(draft.get("title") or draft.get("formId") or "ICPH form"),
        "date": _now_iso(),
        "item": _questionnaire_items(workspace_id, draft, terminology_by_question),
    }


def _qr_item(
    workspace_id: str,
    question: dict[str, Any],
    answers: list[dict[str, Any]],
    terminology_by_question: dict[str, list[dict[str, str]]],
) -> dict[str, Any]:
    name = str(question.get("name") or "").strip()
    approved_codings = _approved_codings_for_question(question, terminology_by_question)
    extensions = [_source_extension(question)]
    if terminology_extension := _approved_terminology_extension(approved_codings):
        extensions.append(terminology_extension)
    return {
        "linkId": name,
        "definition": _local_system(workspace_id, f"question/{name}"),
        "text": str(question.get("label") or name),
        "answer": answers,
        "extension": extensions,
    }


def _prune_empty_response_groups(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pruned: list[dict[str, Any]] = []
    for item in items:
        if "item" in item:
            children = _prune_empty_response_groups(list(item.get("item") or []))
            if children:
                next_item = {**item, "item": children}
                pruned.append(next_item)
            continue
        if item.get("answer"):
            pruned.append(item)
    return pruned


def _questionnaire_response_items(
    workspace_id: str,
    draft: dict[str, Any],
    row: dict[str, str],
    terminology_by_question: dict[str, list[dict[str, str]]],
) -> list[dict[str, Any]]:
    root_items: list[dict[str, Any]] = []
    stack: list[dict[str, Any]] = []
    for question in draft.get("questions") or []:
        qtype = _question_type(question)
        if qtype in END_STRUCTURAL_TYPES:
            if stack:
                stack.pop()
            continue
        name = str(question.get("name") or "").strip()
        if not name or qtype in QUESTIONNAIRE_EXCLUDED_TYPES:
            continue
        if qtype in {"begin_group", "begin_repeat"}:
            approved_codings = _approved_codings_for_question(question, terminology_by_question)
            extensions = [_source_extension(question)]
            if terminology_extension := _approved_terminology_extension(approved_codings):
                extensions.append(terminology_extension)
            group = {
                "linkId": name,
                "definition": _local_system(workspace_id, f"question/{name}"),
                "text": str(question.get("label") or name),
                "item": [],
                "extension": extensions,
            }
            target = stack[-1].setdefault("item", []) if stack else root_items
            target.append(group)
            stack.append(group)
            continue
        answers = _qr_answers(workspace_id, draft, question, row.get(name, ""))
        if not answers:
            continue
        target = stack[-1].setdefault("item", []) if stack else root_items
        target.append(_qr_item(workspace_id, question, answers, terminology_by_question))
    return _prune_empty_response_groups(root_items)


def _patient_resource(workspace_id: str, primary_identifier_variable: str, patient_value: str) -> dict[str, Any]:
    patient_id = _slug(patient_value, f"patient-{_stable_id(workspace_id, patient_value)}")
    return {
        "resourceType": "Patient",
        "id": patient_id,
        "identifier": [
            {
                "system": _local_system(workspace_id, primary_identifier_variable or "primary-identifier"),
                "value": patient_value,
            }
        ],
    }


def _bundle_for_patient(
    *,
    workspace_id: str,
    draft: dict[str, Any],
    primary_identifier_variable: str,
    patient_value: str,
    rows: list[tuple[int, dict[str, str]]],
    terminology_by_question: dict[str, list[dict[str, str]]],
) -> dict[str, Any]:
    questions = _answer_questions(draft)
    questionnaire = _questionnaire_resource(workspace_id, draft, terminology_by_question)
    patient = _patient_resource(workspace_id, primary_identifier_variable, patient_value)
    patient_id = str(patient["id"])
    resources: list[dict[str, Any]] = [questionnaire, patient]

    for row_number, row in rows:
        entry_hash = _stable_id(workspace_id, patient_value, row_number, json.dumps(row, sort_keys=True))
        submitted_at = str(row.get("_submitted_at") or row.get("submittedAt") or _now_iso())
        encounter_id = _slug(f"encounter-{entry_hash}")
        resources.append(
            {
                "resourceType": "Encounter",
                "id": encounter_id,
                "status": "finished",
                "class": {
                    "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
                    "code": "AMB",
                    "display": "ambulatory",
                },
                "subject": {"reference": f"Patient/{patient_id}"},
                "period": {"start": submitted_at, "end": submitted_at},
            }
        )

        questionnaire_items = _questionnaire_response_items(workspace_id, draft, row, terminology_by_question)
        resources.append(
            {
                "resourceType": "QuestionnaireResponse",
                "id": _slug(f"qr-{entry_hash}"),
                "status": "completed",
                "identifier": {"system": _local_system(workspace_id, "entry"), "value": str(row_number)},
                "questionnaire": questionnaire["url"],
                "subject": {"reference": f"Patient/{patient_id}"},
                "encounter": {"reference": f"Encounter/{encounter_id}"},
                "authored": submitted_at,
                "item": questionnaire_items,
            }
        )

        if _include_derived_observations():
            for question in questions:
                if _question_type(question) in NON_OBSERVATION_TYPES:
                    continue
                name = str(question.get("name") or "")
                value = _observation_value(workspace_id, draft, question, row.get(name, ""))
                if not value:
                    continue
                resources.append(
                    {
                        "resourceType": "Observation",
                        "id": _slug(f"obs-{entry_hash}-{name}"),
                        "status": "final",
                        "code": {
                            "coding": _question_codings(workspace_id, question, terminology_by_question),
                            "text": str(question.get("label") or name),
                        },
                        "subject": {"reference": f"Patient/{patient_id}"},
                        "encounter": {"reference": f"Encounter/{encounter_id}"},
                        "effectiveDateTime": submitted_at,
                        **value,
                    }
                )

    bundle_id = _slug(f"bundle-{patient_id}-{_stable_id(workspace_id, patient_value, len(rows))}")
    return {
        "resourceType": "Bundle",
        "id": bundle_id,
        "type": "collection",
        "timestamp": _now_iso(),
        "entry": [
            {
                "fullUrl": f"https://datakaveri.org/fhir/{resource['resourceType']}/{resource['id']}",
                "resource": resource,
            }
            for resource in resources
        ],
    }


def run_generic_form_csv_pipeline(
    csv_path: str | Path,
    form_draft_path: str | Path,
    *,
    primary_identifier_variable: str,
    output_dir: str | Path,
    terminology_review_path: str | Path | None = None,
) -> dict[str, Any]:
    csv_path = Path(csv_path)
    form_draft_path = Path(form_draft_path)
    output_dir = Path(output_dir)
    primary_identifier = str(primary_identifier_variable or "").strip()
    if not primary_identifier:
        raise ValueError("Primary identifier variable is required for generic form FHIR mapping.")

    draft = json.loads(form_draft_path.read_text(encoding="utf-8"))
    terminology_by_question = _load_approved_terminology(terminology_review_path)
    approved_question_count, approved_coding_count = _approved_terminology_stats(draft, terminology_by_question)
    workspace_id = csv_path.parent.parent.parent.name or _slug(draft.get("formId") or draft.get("title") or "workspace")

    with csv_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        header = reader.fieldnames or []
        if primary_identifier not in header:
            raise ValueError(f"CSV does not contain selected primary identifier column `{primary_identifier}`.")
        rows = [dict(row) for row in reader]

    grouped: dict[str, list[tuple[int, dict[str, str]]]] = defaultdict(list)
    for row_number, row in enumerate(rows, start=2):
        patient_value = str(row.get(primary_identifier) or "").strip()
        if not patient_value:
            raise ValueError(f"Missing selected primary identifier `{primary_identifier}` at CSV row {row_number}.")
        grouped[patient_value].append((row_number, row))

    output_dir.mkdir(parents=True, exist_ok=True)
    bundles: list[dict[str, Any]] = []
    for patient_value, patient_rows in sorted(grouped.items()):
        bundle = _bundle_for_patient(
            workspace_id=workspace_id,
            draft=draft,
            primary_identifier_variable=primary_identifier,
            patient_value=patient_value,
            rows=patient_rows,
            terminology_by_question=terminology_by_question,
        )
        bundle_path = output_dir / f"{_slug(patient_value)}-{_stable_id(workspace_id, patient_value)}_{_slug(draft.get('formId') or draft.get('title') or workspace_id)}.json"
        bundle_path.write_text(json.dumps(bundle, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        bundles.append(
            {
                "patient_id": patient_value,
                "visit_count": len(patient_rows),
                "bundle": bundle,
                "bundle_path": str(bundle_path),
                "entry_count": len(bundle.get("entry", [])),
                "replaced_entry_count": 0,
                "appended_entry_count": len(bundle.get("entry", [])),
            }
        )

    return {
        "ok": True,
        "mode": "generic_form_mapper",
        "source_csv_path": str(csv_path),
        "form_draft_path": str(form_draft_path),
        "terminology_review_path": str(terminology_review_path) if terminology_review_path else "",
        "approved_terminology_question_count": approved_question_count,
        "approved_terminology_coding_count": approved_coding_count,
        "form_id": draft.get("formId") or "",
        "form_title": draft.get("title") or "",
        "primary_identifier_variable": primary_identifier,
        "patient_count": len(grouped),
        "row_count": len(rows),
        "column_count": len(header),
        "bundles": bundles,
        "output_dir": str(output_dir),
        "generated_at": _now_iso(),
    }
