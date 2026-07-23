"""Canonical runtime paths for schemas and terminology artifacts.

All schema, source terminology, lookup, model, and dense-index files must live
under ``SchemaTerminologies``. Runtime modules import this resolver instead of
hardcoding legacy ``output/``, ``Terminologies/``, ``schemas/``, or
``evaluation/`` paths.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
SCHEMA_TERMINOLOGIES_DIR = Path(
    os.environ.get("SCHEMA_TERMINOLOGIES_DIR", PROJECT_ROOT / "SchemaTerminologies")
).expanduser().resolve()
ARTIFACTS_DIR = SCHEMA_TERMINOLOGIES_DIR / "artifacts"
SHARED_ARTIFACTS_DIR = ARTIFACTS_DIR / "shared"

STACKS = {
    "FaissSapBERT": ("faiss", "sapbert"),
    "FaissBioSyn": ("faiss", "biosyn"),
    "USearchSapBERT": ("usearch", "sapbert"),
    "USearchBioSyn": ("usearch", "biosyn"),
    "TurboVecSapBERT": ("turbovec", "sapbert"),
    "TurboVecBioSyn": ("turbovec", "biosyn"),
}
STACK_BY_COMPONENTS = {components: name for name, components in STACKS.items()}
DEFAULT_ARTIFACT_STACK = "FaissSapBERT"


def _require_file(path: Path, description: str) -> Path:
    if not path.is_file():
        raise FileNotFoundError(f"Missing {description}: {path}")
    return path


def _latest_version_dir(root: Path, description: str) -> Path:
    if not root.is_dir():
        raise FileNotFoundError(f"Missing {description} directory: {root}")
    versions = sorted(path for path in root.iterdir() if path.is_dir())
    if not versions:
        raise FileNotFoundError(f"No versioned {description} assets found under {root}")
    return versions[-1]


def get_artifact_stack() -> str:
    explicit_stack = os.environ.get("AGENTIC_ARTIFACT_STACK", "").strip()
    if explicit_stack:
        stack = explicit_stack
    else:
        backend = os.environ.get("AGENTIC_DENSE_INDEX_BACKEND", "").strip().lower()
        model = os.environ.get("AGENTIC_EMBEDDING_MODEL", "").strip().lower()
        stack = STACK_BY_COMPONENTS.get((backend, model), DEFAULT_ARTIFACT_STACK)
    if stack not in STACKS:
        allowed = ", ".join(STACKS)
        raise ValueError(
            f"AGENTIC_ARTIFACT_STACK={stack!r} is unsupported; choose one of: {allowed}."
        )
    return stack


def get_dense_index_backend() -> str:
    return STACKS[get_artifact_stack()][0]


def get_embedding_model_name() -> str:
    return STACKS[get_artifact_stack()][1]


def get_dense_max_length() -> int:
    default = 25 if get_embedding_model_name() == "biosyn" else 256
    raw_value = os.environ.get("AGENTIC_DENSE_MAX_LENGTH")
    if not raw_value:
        return default
    try:
        return max(1, int(raw_value))
    except ValueError as exc:
        raise ValueError(f"AGENTIC_DENSE_MAX_LENGTH must be an integer, got {raw_value!r}") from exc


def get_embedding_model_path() -> Path:
    model_name = get_embedding_model_name()
    model_dir = ARTIFACTS_DIR / "models" / model_name
    _require_file(model_dir / "config.json", f"{model_name} model config")
    return model_dir


def get_biomedical_ner_model_path() -> Path | None:
    """Return the installed local biomedical NER model, if available."""
    configured = os.environ.get("AGENTIC_BIOMEDICAL_NER_MODEL_PATH", "").strip()
    model_dir = (
        Path(configured).expanduser().resolve()
        if configured
        else ARTIFACTS_DIR / "models" / "biomedical_ner"
    )
    return model_dir if (model_dir / "config.json").is_file() else None


def get_fhir_schema_path() -> Path:
    return _require_file(
        SCHEMA_TERMINOLOGIES_DIR / "schemas" / "fhir" / "r4" / "fhir.schema.json",
        "FHIR R4 schema",
    )


def get_lookup_path(terminology: str) -> Path:
    filenames = {
        "snomed_ct": "snomed_ct_lookup.csv",
        "loinc": "loinc_lookup.csv",
        "rxnorm": "rxnorm_lookup.csv",
        "icd10": "icd10_lookup.csv",
    }
    if terminology not in filenames:
        raise ValueError(f"Unsupported terminology lookup: {terminology}")
    version_dir = _latest_version_dir(SHARED_ARTIFACTS_DIR / terminology, f"{terminology} lookup")
    return _require_file(version_dir / "lookups" / filenames[terminology], f"{terminology} lookup")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _get_icd10_source_path() -> Path:
    configured = os.environ.get("AGENTIC_ICD10_SOURCE_PATH", "").strip()
    if configured:
        return _require_file(Path(configured).expanduser().resolve(), "ICD-10 source")
    source_root = SCHEMA_TERMINOLOGIES_DIR / "terminologies" / "ICD"
    candidates = sorted(source_root.rglob("*syst_codes.txt")) if source_root.is_dir() else []
    if not candidates:
        raise FileNotFoundError(f"No ICD-10 system-code source found under {source_root}")
    return candidates[-1]


def build_icd10_lookup(force: bool = False) -> Path:
    """Build the shared ICD lookup with canonical titles and searchable aliases."""
    source = _get_icd10_source_path()
    version_dir = _latest_version_dir(SHARED_ARTIFACTS_DIR / "icd10", "icd10 lookup")
    output = version_dir / "lookups" / "icd10_lookup.csv"
    metadata_path = output.with_name("icd10_lookup_metadata.json")
    source_sha256 = _sha256_file(source)
    builder_sha256 = _sha256_file(Path(__file__).resolve())

    if output.exists() and metadata_path.exists() and not force:
        try:
            with output.open("r", encoding="utf-8", newline="") as handle:
                fieldnames = next(csv.reader(handle), [])
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            if (
                "aliases" in fieldnames
                and metadata.get("source_sha256") == source_sha256
                and metadata.get("builder_sha256") == builder_sha256
            ):
                return output
        except (OSError, ValueError, json.JSONDecodeError):
            pass

    system_uri = os.environ.get(
        "AGENTIC_ICD10_SYSTEM_URI",
        "http://hl7.org/fhir/sid/icd-10-cm",
    ).strip()
    if metadata_path.exists():
        try:
            existing_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            system_uri = str(existing_metadata.get("system_uri") or system_uri)
        except (OSError, ValueError, json.JSONDecodeError):
            pass

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_suffix(".csv.tmp")
    record_count = 0
    with source.open("r", encoding="utf-8", newline="") as source_handle, temporary_output.open(
        "w", encoding="utf-8", newline=""
    ) as output_handle:
        reader = csv.reader(source_handle, delimiter=";")
        writer = csv.DictWriter(
            output_handle,
            fieldnames=["code", "display", "aliases", "status", "system_uri"],
        )
        writer.writeheader()
        for source_row in reader:
            if len(source_row) < 12:
                continue
            code = source_row[6].strip()
            canonical_display = source_row[8].strip()
            if not code or not canonical_display:
                continue
            aliases = [
                value
                for value in dict.fromkeys(item.strip() for item in source_row[9:12])
                if value and value != canonical_display
            ]
            writer.writerow(
                {
                    "code": code,
                    "display": canonical_display,
                    "aliases": json.dumps(aliases, ensure_ascii=False),
                    "status": "active_or_unknown",
                    "system_uri": system_uri,
                }
            )
            record_count += 1
    temporary_output.replace(output)

    try:
        source_reference = str(source.relative_to(SCHEMA_TERMINOLOGIES_DIR))
    except ValueError:
        source_reference = str(source)
    metadata = {
        "artifact_type": "terminology_lookup",
        "terminology": "icd10",
        "version": output.parents[1].name,
        "system_uri": system_uri,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_file": source_reference,
        "source_sha256": source_sha256,
        "builder_sha256": builder_sha256,
        "lookup_csv": str(output.relative_to(SCHEMA_TERMINOLOGIES_DIR)),
        "record_count": record_count,
    }
    temporary_metadata = metadata_path.with_suffix(".json.tmp")
    temporary_metadata.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    temporary_metadata.replace(metadata_path)
    print(f"   ICD-10 lookup CSV refreshed: {record_count:,} concepts")
    return output


def build_rxnorm_lookup(force: bool = False) -> Path:
    """Rebuild the shared RxNorm CSV using canonical class URI identifiers."""
    source = _require_file(
        SCHEMA_TERMINOLOGIES_DIR / "terminologies" / "rxnorm" / "RXNORM.ttl",
        "RxNorm TTL source",
    )
    version_dir = _latest_version_dir(SHARED_ARTIFACTS_DIR / "rxnorm", "rxnorm lookup")
    output = version_dir / "lookups" / "rxnorm_lookup.csv"
    metadata_path = output.with_name("rxnorm_lookup_metadata.json")
    if output.exists() and not force:
        return output

    class_start = re.compile(r"^<http://purl\.bioontology\.org/ontology/RXNORM/([^>]+)>\s+a\s+owl:Class\s*;")
    pref_label = re.compile(r'skos:prefLabel\s+"""(.*?)"""@en')
    current_code: str | None = None
    current_label: str | None = None
    current_obsolete = False
    record_count = 0

    def flush(writer: csv.DictWriter) -> None:
        nonlocal current_code, current_label, current_obsolete, record_count
        if current_code and current_label:
            writer.writerow(
                {
                    "code": current_code,
                    "display": current_label,
                    "status": "obsolete" if current_obsolete else "active_or_unknown",
                    "system_uri": "http://rxnorm.info/rxcui",
                }
            )
            record_count += 1
        current_code = None
        current_label = None
        current_obsolete = False

    output.parent.mkdir(parents=True, exist_ok=True)
    with source.open(encoding="utf-8", errors="ignore") as source_handle, output.open(
        "w", encoding="utf-8", newline=""
    ) as output_handle:
        writer = csv.DictWriter(
            output_handle,
            fieldnames=["code", "display", "status", "system_uri"],
        )
        writer.writeheader()
        for raw_line in source_handle:
            line = raw_line.strip()
            start_match = class_start.match(line)
            if start_match:
                flush(writer)
                current_code = start_match.group(1)
                continue
            if current_code is None:
                continue
            label_match = pref_label.search(line)
            if label_match and current_label is None:
                current_label = label_match.group(1)
            # Embedded RXCUI properties are deliberately ignored: they may be
            # historical/source-linked IDs rather than this class's canonical ID.
            if "/RXN_OBSOLETED>" in line:
                current_obsolete = True
            if line.endswith("."):
                flush(writer)
        flush(writer)

    metadata = {
        "artifact_type": "terminology_lookup",
        "terminology": "rxnorm",
        "version": output.parents[1].name,
        "system_uri": "http://rxnorm.info/rxcui",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_file": str(source.relative_to(SCHEMA_TERMINOLOGIES_DIR)),
        "lookup_csv": str(output.relative_to(SCHEMA_TERMINOLOGIES_DIR)),
        "record_count": record_count,
    }
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return output


def get_dense_index_paths(terminology: str) -> tuple[Path, Path]:
    index_base_names = {
        "snomed_ct": "snomed",
        "icd10": "icd10",
        "loinc": "loinc",
        "rxnorm": "rxnorm",
    }
    if terminology not in index_base_names:
        raise ValueError(f"Unsupported terminology dense index: {terminology}")
    stack_root = ARTIFACTS_DIR / get_artifact_stack() / terminology
    version_dir = _latest_version_dir(stack_root, f"{terminology} {get_artifact_stack()}")
    index_dir = version_dir / "indexes"
    backend = get_dense_index_backend()
    base_name = index_base_names[terminology]
    extension = {"faiss": "index", "usearch": "usearch", "turbovec": "tvim"}[backend]
    metadata_name = "snomed_metadata.pkl" if terminology == "snomed_ct" else f"{base_name}_metadata.json"
    return (
        _require_file(index_dir / f"{base_name}.{extension}", f"{terminology} {backend} index"),
        _require_file(index_dir / metadata_name, f"{terminology} {backend} metadata"),
    )


def get_snomed_faiss_paths() -> tuple[Path, Path]:
    return get_dense_index_paths("snomed_ct")


def get_icd10_faiss_paths() -> tuple[Path, Path]:
    return get_dense_index_paths("icd10")


def describe_active_assets() -> dict[str, str]:
    snomed_index, snomed_metadata = get_dense_index_paths("snomed_ct")
    icd10_index, icd10_metadata = get_dense_index_paths("icd10")
    loinc_index, loinc_metadata = get_dense_index_paths("loinc")
    rxnorm_index, rxnorm_metadata = get_dense_index_paths("rxnorm")
    return {
        "schema_terminologies_dir": str(SCHEMA_TERMINOLOGIES_DIR),
        "artifact_stack": get_artifact_stack(),
        "index_backend": get_dense_index_backend(),
        "embedding_model": get_embedding_model_name(),
        "embedding_model_path": str(get_embedding_model_path()),
        "fhir_schema": str(get_fhir_schema_path()),
        "snomed_lookup": str(get_lookup_path("snomed_ct")),
        "snomed_index": str(snomed_index),
        "snomed_metadata": str(snomed_metadata),
        "loinc_lookup": str(get_lookup_path("loinc")),
        "loinc_index": str(loinc_index),
        "loinc_metadata": str(loinc_metadata),
        "rxnorm_lookup": str(get_lookup_path("rxnorm")),
        "rxnorm_index": str(rxnorm_index),
        "rxnorm_metadata": str(rxnorm_metadata),
        "icd10_lookup": str(get_lookup_path("icd10")),
        "icd10_index": str(icd10_index),
        "icd10_metadata": str(icd10_metadata),
    }
