"""
medspaCy context enrichment layer.

This module adds medspaCy as a deterministic assertion/context pass without
replacing the existing spaCy/scispaCy abbreviation flow in Agent 1.

The pipeline still uses the existing mapper agents for terminology linking.
medspaCy is used here for what it is very good at: rule-based clinical context
signals such as negation, historical/family context, allergy mentions, and
procedure refusal cues around already-extracted entities.
"""

from __future__ import annotations

from collections import defaultdict
import re
import sys
from typing import Any


def _clean_text(value: Any) -> str:
    text = str(value or "")
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip(" \t\n\r;:,.")


def _copy_mapping(mapping: Any) -> dict:
    """Return a dict mapping and normalize nullable medspaCy context fields."""
    if isinstance(mapping, dict):
        copied = dict(mapping)
    else:
        copied = {"entity": _clean_text(mapping), "original_entity": _clean_text(mapping)}

    if not isinstance(copied.get("medspacy_context"), dict):
        copied.pop("medspacy_context", None)
    return copied


def _positive_phrase(value: Any) -> str:
    return _clean_text(value)


def _mapping_phrases(mapping: dict) -> list[str]:
    values = [
        mapping.get("entity"),
        mapping.get("original_entity"),
        mapping.get("generalized_term"),
        mapping.get("condition"),
        mapping.get("observation"),
        mapping.get("snomed_name"),
        mapping.get("loinc_name"),
        mapping.get("rxnorm_name"),
        mapping.get("icd10_name"),
    ]
    phrases: list[str] = []
    seen: set[str] = set()
    for value in values:
        for candidate in (_clean_text(value), _positive_phrase(value)):
            if len(candidate) < 3:
                continue
            if len(candidate.split()) > 12:
                continue
            key = candidate.casefold()
            if key not in seen:
                seen.add(key)
                phrases.append(candidate)
    return phrases


def _span_ext(span, name: str, default=False):
    try:
        return getattr(span._, name)
    except Exception:
        return default


def _window(text: str, start: int, end: int, radius: int = 90) -> str:
    return text[max(0, start - radius) : min(len(text), end + radius)]


def medspacy_available() -> tuple[bool, str]:
    try:
        import medspacy  # noqa: F401
        from medspacy.target_matcher import TargetRule  # noqa: F401
        return True, ""
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"


def enrich_mappings_with_medspacy(input_text: str, mappings: list[dict]) -> tuple[list[dict], list[str]]:
    """Return mappings enriched with medspaCy context flags plus UI logs.

    If medspaCy is not installed, the function returns the input mappings
    unchanged and emits a clear warning log. That keeps local development usable
    while making the missing dependency visible.
    """
    logs: list[str] = ["### medspaCy Context Enrichment"]

    if not mappings:
        logs.append("No mappings were available for medspaCy context enrichment.")
        return mappings, logs

    source_mappings = [_copy_mapping(mapping) for mapping in mappings]

    available, error = medspacy_available()
    if not available:
        logs.append(
            "⚠ medspaCy is not installed in the Python environment running Streamlit; "
            "mappings were left unchanged. Install project requirements in that same "
            "environment to enable this context pass. "
            f"Python executable: {sys.executable}. Import error: {error}"
        )
        return source_mappings, logs

    import medspacy
    from medspacy.target_matcher import TargetRule
    try:
        from loguru import logger

        logger.disable("PyRuSH")
    except Exception:
        pass

    print("Loading medspaCy context pipeline...")
    try:
        nlp = medspacy.load()
    except Exception as exc:
        message = (
            f"⚠ medspaCy failed to load; mappings were left unchanged: "
            f"{type(exc).__name__}: {exc}"
        )
        print(message)
        logs.append(message)
        return source_mappings, logs
    print("   medspaCy context pipeline loaded.")
    logs.append("medspaCy context pipeline loaded.")

    try:
        target_matcher = nlp.get_pipe("medspacy_target_matcher")
    except Exception:
        try:
            target_matcher = nlp.add_pipe("medspacy_target_matcher", first=True)
        except Exception as exc:
            logs.append(f"⚠ medspaCy target matcher unavailable; mappings were left unchanged: {exc}")
            return source_mappings, logs

    rules = []
    phrase_count = 0
    for index, mapping in enumerate(source_mappings):
        for phrase in _mapping_phrases(mapping):
            label = f"MAPPED_ENTITY_{index}"
            rules.append(TargetRule(literal=phrase, category=label))
            phrase_count += 1

    if not rules:
        logs.append("No usable entity phrases were found for medspaCy target matching.")
        return source_mappings, logs

    try:
        target_matcher.add(rules)
    except TypeError:
        # Older medspaCy versions expose the same method without keyword names.
        target_matcher.add(rules=rules)
    except Exception as exc:
        logs.append(f"⚠ medspaCy target rules could not be added; mappings were left unchanged: {exc}")
        return source_mappings, logs

    try:
        doc = nlp(input_text)
    except Exception as exc:
        message = (
            f"⚠ medspaCy inference failed; mappings were left unchanged: "
            f"{type(exc).__name__}: {exc}"
        )
        print(message)
        logs.append(message)
        return source_mappings, logs
    mentions_by_index: dict[int, list[dict]] = defaultdict(list)

    for ent in doc.ents:
        label = str(ent.label_)
        match = re.fullmatch(r"MAPPED_ENTITY_(\d+)", label)
        if not match:
            continue

        index = int(match.group(1))
        try:
            sentence_start = ent.sent.start_char
            sentence_end = ent.sent.end_char
        except Exception:
            sentence_start = max(0, ent.start_char - 120)
            sentence_end = min(len(input_text), ent.end_char + 120)
        context_window = _window(input_text, ent.start_char, ent.end_char)
        mention = {
            "text": ent.text,
            "start": ent.start_char,
            "end": ent.end_char,
            "negated": bool(_span_ext(ent, "is_negated", False)),
            "uncertain": bool(_span_ext(ent, "is_uncertain", False) or _span_ext(ent, "is_possible", False)),
            "historical": bool(_span_ext(ent, "is_historical", False)),
            "hypothetical": bool(_span_ext(ent, "is_hypothetical", False)),
            "family": bool(_span_ext(ent, "is_family", False)),
            "refused": bool(_span_ext(ent, "is_refused", False)),
            "allergy": bool(_span_ext(ent, "is_allergy", False)),
            "context_window": _clean_text(context_window),
        }
        mentions_by_index[index].append(mention)

    enriched: list[dict] = []
    changed = 0

    for index, mapping in enumerate(source_mappings):
        new_mapping = _copy_mapping(mapping)
        mentions = mentions_by_index.get(index, [])
        if not mentions:
            if not isinstance(new_mapping.get("medspacy_context"), dict):
                new_mapping["medspacy_context"] = {"matched": False, "mentions": []}
            else:
                new_mapping["medspacy_context"].setdefault("matched", False)
                new_mapping["medspacy_context"].setdefault("mentions", [])
            enriched.append(new_mapping)
            continue

        any_negated = any(mention["negated"] for mention in mentions)
        any_refused = any(mention["refused"] for mention in mentions)
        any_allergy = any(mention["allergy"] for mention in mentions)
        any_historical = any(mention["historical"] for mention in mentions)
        any_hypothetical = any(mention["hypothetical"] for mention in mentions)
        any_family = any(mention["family"] for mention in mentions)
        any_uncertain = any(mention["uncertain"] for mention in mentions)

        applied: list[str] = []

        if any_negated:
            source_was_negated = bool(new_mapping.get("source_assertion_negated"))
            external_negation = new_mapping.get("assertion_encoded_by_concept") is not True
            if not source_was_negated or bool(new_mapping.get("negated")) != external_negation:
                changed += 1
            new_mapping["source_assertion_negated"] = True
            new_mapping["negated"] = external_negation
            new_mapping.setdefault("negation_type", "medspacy")
            new_mapping["medspacy_negated"] = True
            applied.append("negated")

        if any_refused:
            if not new_mapping.get("consent_refused"):
                changed += 1
            new_mapping["consent_refused"] = True
            new_mapping["medspacy_refused"] = True
            applied.append("refused")

        if any_allergy:
            if not new_mapping.get("is_allergy"):
                changed += 1
            new_mapping["is_allergy"] = True
            new_mapping["medspacy_allergy"] = True
            applied.append("allergy")

        if any_historical:
            new_mapping["medspacy_historical"] = True
            applied.append("historical")
        if any_hypothetical:
            new_mapping["medspacy_hypothetical"] = True
            applied.append("hypothetical")
        if any_family:
            new_mapping["medspacy_family_context"] = True
            applied.append("family_context")
        if any_uncertain:
            new_mapping["medspacy_uncertain"] = True
            applied.append("uncertain")

        new_mapping["medspacy_context"] = {
            "matched": True,
            "applied_flags": applied,
            "mentions": mentions[:5],
        }
        enriched.append(new_mapping)

    logs.append(f"✅ medspaCy target rules added: {phrase_count}")
    matched_count = sum(
        1
        for item in enriched
        if isinstance(item, dict) and (item.get("medspacy_context") or {}).get("matched")
    )
    logs.append(f"✅ medspaCy matched mapped entities: {matched_count}/{len(enriched)}")
    logs.append(f"✅ medspaCy updated assertion/context flags on {changed} mapping(s).")
    return enriched, logs
