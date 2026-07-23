"""Headless orchestration for the mapper backend API.

This module calls the mapper agents without importing any UI framework, so
other services can run the pipeline through Python or HTTP entry points.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any


ProgressCallback = Callable[[str, str, str], None]

DEFAULT_STAGES = ["SNOMED", "MEDSPACY", "LOINC", "RXNORM", "ICD10", "FHIR"]
ALLOWED_STAGES = set(DEFAULT_STAGES)


def _seed_mappings(processed_text: str) -> list[dict]:
    """Extract lightweight entity candidates when SNOMED is disabled."""
    try:
        from snomed_mapper_agent import extract_entities_with_llm

        entities = extract_entities_with_llm(processed_text)
    except Exception:
        entities = []

    if not entities:
        entities = [
            {"entity": fragment.strip()}
            for fragment in re.split(r"[\n.;]+", processed_text)
            if len(fragment.strip()) > 2
        ]

    mappings: list[dict] = []
    for item in entities:
        source = item if isinstance(item, dict) else {"entity": str(item)}
        entity = str(source.get("entity") or "").strip()
        if not entity:
            continue
        mappings.append(
            {
                **source,
                "entity": entity,
                "original_entity": source.get("original_entity") or entity,
            }
        )
    return mappings


def _merge_mappings(current: list[dict], additions: list[dict]) -> list[dict]:
    """Merge audit discoveries without duplicating the same source fact."""
    merged = [dict(item) for item in current if isinstance(item, dict)]
    seen = {
        re.sub(r"\s+", " ", str(item.get("entity") or item.get("original_entity") or "").lower()).strip()
        for item in merged
    }
    for item in additions:
        if not isinstance(item, dict):
            continue
        key = re.sub(
            r"\s+",
            " ",
            str(item.get("entity") or item.get("original_entity") or "").lower(),
        ).strip()
        if key and key not in seen:
            merged.append(dict(item))
            seen.add(key)
    return merged


def run_pipeline_headless(
    input_text: str,
    patient_payload: str | dict | list | None = None,
    stages: list[str] | None = None,
    on_progress: ProgressCallback | None = None,
) -> dict[str, Any]:
    """Run the agent pipeline and return the same core artifacts as Streamlit."""
    selected = [stage.upper() for stage in (stages or DEFAULT_STAGES)]
    unknown = sorted(set(selected) - ALLOWED_STAGES)
    if unknown:
        raise ValueError(f"Unknown pipeline stages: {', '.join(unknown)}")

    def progress(stage: str, status: str, message: str) -> None:
        if on_progress:
            on_progress(stage, status, message)

    warnings: list[dict[str, str]] = []
    agent_logs: dict[str, list[str]] = {}

    progress("PRIVACY", "running", "Protecting identifiers and resolving abbreviations")
    try:
        from abbreviation_agent import run_abbreviation_agent

        processed_text, logs = run_abbreviation_agent(input_text)
        agent_logs["PRIVACY"] = [str(item) for item in logs]
    except Exception as exc:
        try:
            from abbreviation_agent import mask_pii_locally

            processed_text = mask_pii_locally(input_text)
        except Exception:
            processed_text = "[TEXT REDACTED: LOCAL PRIVACY PROCESSING UNAVAILABLE]"
        warning = f"Privacy and abbreviation stage used its safe fallback: {exc}"
        warnings.append({"stage": "PRIVACY", "message": warning})
        agent_logs["PRIVACY"] = [warning]
    progress("PRIVACY", "complete", "Clinical text prepared")

    mappings: list[dict]
    if "SNOMED" in selected:
        progress("SNOMED", "running", "Linking clinical concepts to SNOMED CT")
        try:
            from snomed_mapper_agent import audit_missed_snomed_mappings, run_snomed_agent

            result = run_snomed_agent(processed_text)
            mappings = result.get("mappings", []) if isinstance(result, dict) else []
            agent_logs["SNOMED"] = [str(item) for item in result.get("warnings", [])]
            audit_additions = audit_missed_snomed_mappings(processed_text, mappings)
            mappings = _merge_mappings(mappings, audit_additions)
        except Exception as exc:
            mappings = _seed_mappings(processed_text)
            warning = f"SNOMED mapping was unavailable; extracted facts were retained: {exc}"
            warnings.append({"stage": "SNOMED", "message": warning})
            agent_logs["SNOMED"] = [warning]
        progress("SNOMED", "complete", f"{len(mappings)} clinical facts available")
    else:
        progress("EXTRACTION", "running", "Extracting direct mapping candidates")
        mappings = _seed_mappings(processed_text)
        progress("EXTRACTION", "complete", f"{len(mappings)} clinical facts available")

    def run_medspacy(text: str, current: list[dict]) -> Any:
        from medspacy_context_agent import enrich_mappings_with_medspacy

        return enrich_mappings_with_medspacy(text, current)

    def run_loinc(text: str, current: list[dict]) -> Any:
        from loinc_mapper_agent import run_loinc_agent_langgraph

        return run_loinc_agent_langgraph(text, current)

    def run_rxnorm(text: str, current: list[dict]) -> Any:
        from rxnorm_mapper_agent import run_rxnorm_agent_langgraph

        return run_rxnorm_agent_langgraph(text, current)

    def run_icd10(text: str, current: list[dict]) -> Any:
        from icd10_mapper_agent import run_icd10_agent_langgraph

        return run_icd10_agent_langgraph(text, current)

    stage_runners: list[tuple[str, str, Callable[[str, list[dict]], Any]]] = []
    if "MEDSPACY" in selected:
        stage_runners.append(("MEDSPACY", "Resolving assertion and clinical context", run_medspacy))
    if "LOINC" in selected:
        stage_runners.append(("LOINC", "Mapping tests and observations", run_loinc))
    if "RXNORM" in selected:
        stage_runners.append(("RXNORM", "Mapping medications and substances", run_rxnorm))
    if "ICD10" in selected:
        stage_runners.append(("ICD10", "Enriching diagnoses with ICD-10-CM", run_icd10))

    for stage, message, runner in stage_runners:
        progress(stage, "running", message)
        try:
            result = runner(processed_text, mappings)
            if isinstance(result, tuple):
                mappings = result[0]
                logs = result[1] if len(result) > 1 else []
            else:
                mappings, logs = result, []
            agent_logs[stage] = [str(item) for item in logs]
            failures = [str(item) for item in logs if str(item).startswith("STAGE_FAILURE:")]
            for failure in failures:
                warnings.append({"stage": stage, "message": failure.partition(":")[2].strip()})
        except Exception as exc:
            warning = f"{stage} enrichment was unavailable; prior mappings were preserved: {exc}"
            warnings.append({"stage": stage, "message": warning})
            agent_logs[stage] = [warning]
        progress(stage, "complete", f"{len(mappings)} mappings retained")

    bundle: dict = {}
    bundle_path = ""
    if "FHIR" in selected:
        progress("FHIR", "running", "Building and validating the FHIR R4 Bundle")
        try:
            from fhir_bundle_agent import run_fhir_bundle_agent

            bundle, bundle_path, logs = run_fhir_bundle_agent(
                input_text=processed_text,
                mappings=mappings,
                patient_payload=patient_payload,
            )
            agent_logs["FHIR"] = [str(item) for item in logs]
        except Exception as exc:
            from fhir_bundle_agent import _build_diagnostic_fhir_bundle

            warning = f"FHIR composition used a diagnostic Bundle: {exc}"
            warnings.append({"stage": "FHIR", "message": warning})
            agent_logs["FHIR"] = [warning]
            bundle = _build_diagnostic_fhir_bundle(
                input_text=processed_text,
                mappings=mappings,
                diagnostics=[warning],
            )
        progress(
            "FHIR",
            "complete",
            f"{len(bundle.get('entry', [])) if isinstance(bundle, dict) else 0} resources assembled",
        )

    return {
        "input_text": input_text,
        "processed_text": processed_text,
        "pipeline_stages": selected,
        "mappings": mappings,
        "fhir_bundle": bundle,
        "fhir_bundle_path": bundle_path,
        "warnings": warnings,
        "agent_logs": agent_logs,
    }
