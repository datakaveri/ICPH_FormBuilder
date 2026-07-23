"""
Multi-level cache for the medical text processing pipeline.

Two tiers:
  1. Phrase cache  – keyed by exact input text → full API response JSON
  2. Entity cache  – keyed by normalised entity string → SNOMED mapping dict

Both are persisted to JSON files in a `cache/` directory next to this module.
"""

import json
import threading
import hashlib
import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Storage directory
# ---------------------------------------------------------------------------
CACHE_DIR = Path(__file__).parent / "cache"
try:
    CACHE_DIR.mkdir(exist_ok=True)
except OSError as exc:
    print(f"⚠ Cache directory unavailable; pipeline processing will continue without persistence: {exc}")

PHRASE_CACHE_PATH = CACHE_DIR / "phrase_cache.json"
ENTITY_CACHE_PATH = CACHE_DIR / "entity_cache.json"
STAGE_CACHE_PATH = CACHE_DIR / "stage_cache.json"

# Cache entries are scoped automatically to the source files which determine
# pipeline output. Editing an agent, prompt, dependency manifest, or FHIR schema
# therefore starts using fresh keys without a manually maintained version label.
_source_namespace_signature: tuple[tuple[str, int, int], ...] | None = None
_source_namespace_value: str | None = None

# ---------------------------------------------------------------------------
# In-memory caches (loaded once from disk, written back on every update)
# ---------------------------------------------------------------------------
_lock = threading.Lock()

_phrase_cache: dict[str, dict] | None = None
_entity_cache: dict[str, dict] | None = None
_stage_cache: dict[str, dict] | None = None


def _cache_source_paths() -> list[Path]:
    project_root = Path(__file__).resolve().parent
    paths = list(project_root.glob("*.py"))
    paths.extend(
        path
        for path in (project_root / "prompts").rglob("*")
        if path.is_file()
    )
    paths.extend(
        path
        for path in (
            project_root / "requirements.txt",
            project_root
            / "SchemaTerminologies"
            / "schemas"
            / "fhir"
            / "r4"
            / "fhir.schema.json",
        )
        if path.is_file()
    )
    return sorted(set(paths), key=lambda path: str(path.relative_to(project_root)))


def _automatic_source_namespace() -> str:
    """Return a stable fingerprint which changes when pipeline sources change."""
    global _source_namespace_signature, _source_namespace_value

    project_root = Path(__file__).resolve().parent
    paths = _cache_source_paths()
    signature = tuple(
        (
            str(path.relative_to(project_root)),
            path.stat().st_mtime_ns,
            path.stat().st_size,
        )
        for path in paths
    )
    if signature == _source_namespace_signature and _source_namespace_value:
        return _source_namespace_value

    digest = hashlib.sha256()
    for path in paths:
        relative_path = str(path.relative_to(project_root))
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")

    _source_namespace_signature = signature
    _source_namespace_value = digest.hexdigest()[:16]
    return _source_namespace_value


def _cache_namespace() -> str:
    deployment_namespace = (
        os.environ.get("AGENTIC_CACHE_NAMESPACE", "default").strip() or "default"
    )
    runtime_configuration = sorted(
        (key, value)
        for key, value in os.environ.items()
        if key != "AGENTIC_CACHE_NAMESPACE"
        and key.startswith(("AGENTIC_", "LLM_", "OLLAMA_"))
    )
    runtime_digest = hashlib.sha256(
        json.dumps(runtime_configuration, ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:12]
    return (
        f"{deployment_namespace}-{_automatic_source_namespace()}-"
        f"{runtime_digest}"
    )


def _load_json(path: Path) -> dict:
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            print(f"⚠ Cache read unavailable for {path.name}; continuing without cached data: {exc}")
            return {}
    return {}


def _save_json(path: Path, data: dict) -> bool:
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False, default=str)
        return True
    except OSError as exc:
        print(f"⚠ Cache write unavailable for {path.name}; pipeline processing will continue: {exc}")
        return False


def _get_phrase_cache() -> dict:
    global _phrase_cache
    if _phrase_cache is None:
        _phrase_cache = _load_json(PHRASE_CACHE_PATH)
    return _phrase_cache


def _get_entity_cache() -> dict:
    global _entity_cache
    if _entity_cache is None:
        _entity_cache = _load_json(ENTITY_CACHE_PATH)
    return _entity_cache


def _get_stage_cache() -> dict:
    global _stage_cache
    if _stage_cache is None:
        _stage_cache = _load_json(STAGE_CACHE_PATH)
    return _stage_cache


def _stage_key(stage: str, payload) -> str:
    try:
        serialised = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    except TypeError:
        serialised = json.dumps(str(payload), ensure_ascii=False)
    digest = hashlib.sha256(serialised.encode("utf-8")).hexdigest()
    return f"{_cache_namespace()}:{stage}:{digest}"


# ---------------------------------------------------------------------------
# Phrase cache API
# ---------------------------------------------------------------------------
def _phrase_key(text: str) -> str:
    digest = hashlib.sha256(str(text or "").strip().encode("utf-8")).hexdigest()
    return f"{_cache_namespace()}:phrase:{digest}"


def get_phrase(text: str) -> dict | None:
    """Look up an exact phrase. Returns the cached response dict or None."""
    key = _phrase_key(text)
    with _lock:
        hit = _get_phrase_cache().get(key)
    if hit:
        print(f"⚡ Phrase cache HIT: '{key}'")
    return hit


def put_phrase(text: str, response: dict) -> None:
    """Store a full API response for a given input phrase."""
    key = _phrase_key(text)
    with _lock:
        cache = _get_phrase_cache()
        cache[key] = response
        saved = _save_json(PHRASE_CACHE_PATH, cache)
    if saved:
        print(f"💾 Phrase cache STORE: '{key}'")


# ---------------------------------------------------------------------------
# Entity cache API
# ---------------------------------------------------------------------------
def _normalise(entity: str) -> str:
    return f"{_cache_namespace()}::{entity.strip().lower()}"


def get_entity(entity: str) -> dict | None:
    """Look up a single entity's SNOMED mapping. Returns mapping dict or None."""
    key = _normalise(entity)
    with _lock:
        hit = _get_entity_cache().get(key)
    if hit:
        print(f"⚡ Entity cache HIT: '{entity}'")
    return hit


def put_entity(entity: str, mapping: dict) -> None:
    """Store a SNOMED mapping for a single entity."""
    key = _normalise(entity)
    with _lock:
        cache = _get_entity_cache()
        cache[key] = mapping
        _save_json(ENTITY_CACHE_PATH, cache)


def put_entities_bulk(mappings: list[dict]) -> None:
    """Store multiple entity mappings at once (single disk write)."""
    with _lock:
        cache = _get_entity_cache()
        for m in mappings:
            entity = m.get("original_entity", "")
            if entity:
                cache[_normalise(entity)] = m
        saved = _save_json(ENTITY_CACHE_PATH, cache)
    if saved:
        print(f"💾 Entity cache STORE: {len(mappings)} entities")


# ---------------------------------------------------------------------------
# Stage cache API
# ---------------------------------------------------------------------------
def get_stage(stage: str, payload) -> dict | None:
    """Look up a cached stage result by stage name and serialized payload."""
    key = _stage_key(stage, payload)
    with _lock:
        hit = _get_stage_cache().get(key)
    if hit:
        print(f"⚡ Stage cache HIT: '{stage}'")
    return hit


def put_stage(stage: str, payload, response: dict) -> None:
    """Store a cached stage result keyed by stage name and payload hash."""
    key = _stage_key(stage, payload)
    with _lock:
        cache = _get_stage_cache()
        cache[key] = response
        saved = _save_json(STAGE_CACHE_PATH, cache)
    if saved:
        print(f"💾 Stage cache STORE: '{stage}'")


def clear_stage(stage: str) -> int:
    """Remove cached results for one pipeline stage without touching others."""
    namespace = _cache_namespace()
    prefixes = (f"{namespace}:{stage}:", f"{stage}:")
    with _lock:
        cache = _get_stage_cache()
        keys = [key for key in cache if key.startswith(prefixes)]
        for key in keys:
            del cache[key]
        if keys:
            _save_json(STAGE_CACHE_PATH, cache)
    return len(keys)
