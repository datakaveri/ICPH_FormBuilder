"""FastAPI backend bridge for Agentic Entity Mapper."""

from __future__ import annotations

import json
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

from pipeline_service import ALLOWED_STAGES, DEFAULT_STAGES, run_pipeline_headless


ROOT = Path(__file__).resolve().parent
BUNDLE_DIRECTORY = ROOT / "output" / "fhir_bundles"

app = FastAPI(title="Agentic Entity Mapper API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8787",
        "http://127.0.0.1:8787",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class PipelineRequest(BaseModel):
    input_text: str = Field(min_length=1, max_length=50_000)
    patient_payload: str | dict | list | None = None
    stages: list[str] = Field(default_factory=lambda: list(DEFAULT_STAGES))

    @field_validator("input_text")
    @classmethod
    def text_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Clinical text cannot be blank")
        return value.strip()

    @field_validator("stages")
    @classmethod
    def stages_must_be_supported(cls, values: list[str]) -> list[str]:
        normalized = [value.upper() for value in values]
        unknown = sorted(set(normalized) - ALLOWED_STAGES)
        if unknown:
            raise ValueError(f"Unsupported stages: {', '.join(unknown)}")
        return normalized


_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="clinical-pipeline")
_job_lock = threading.Lock()
_jobs: dict[str, dict[str, Any]] = {}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _bundle_metadata(path: Path) -> dict[str, Any]:
    try:
        bundle = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    entries = bundle.get("entry", []) if isinstance(bundle, dict) else []
    resource_types: dict[str, int] = {}
    for entry in entries:
        resource = entry.get("resource", {}) if isinstance(entry, dict) else {}
        resource_type = str(resource.get("resourceType") or "Unknown")
        resource_types[resource_type] = resource_types.get(resource_type, 0) + 1
    return {
        "filename": path.name,
        "id": bundle.get("id") or path.stem,
        "timestamp": bundle.get("timestamp"),
        "entries": len(entries),
        "resource_types": resource_types,
    }


def _safe_bundle_path(filename: str) -> Path:
    if filename != Path(filename).name or not filename.endswith(".json"):
        raise HTTPException(status_code=400, detail="Invalid Bundle filename")
    path = BUNDLE_DIRECTORY / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="FHIR Bundle not found")
    return path


def _run_job(job_id: str, request: PipelineRequest) -> None:
    def report(stage: str, status: str, message: str) -> None:
        with _job_lock:
            job = _jobs.get(job_id)
            if not job:
                return
            job["current_stage"] = stage
            job["message"] = message
            job["events"].append(
                {"stage": stage, "status": status, "message": message, "at": _utc_now()}
            )

    with _job_lock:
        _jobs[job_id]["status"] = "running"
        _jobs[job_id]["started_at"] = _utc_now()
    try:
        result = run_pipeline_headless(
            input_text=request.input_text,
            patient_payload=request.patient_payload,
            stages=request.stages,
            on_progress=report,
        )
        with _job_lock:
            _jobs[job_id].update(
                status="complete",
                result=result,
                message="FHIR workspace is ready",
                completed_at=_utc_now(),
            )
    except Exception as exc:
        with _job_lock:
            _jobs[job_id].update(
                status="failed",
                error=str(exc),
                message="The pipeline could not complete",
                completed_at=_utc_now(),
            )


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/bundles")
def list_bundles() -> list[dict[str, Any]]:
    if not BUNDLE_DIRECTORY.exists():
        return []
    rows = [_bundle_metadata(path) for path in BUNDLE_DIRECTORY.glob("*.json")]
    return sorted((row for row in rows if row), key=lambda row: row.get("timestamp") or "", reverse=True)


@app.get("/api/bundles/{filename}")
def get_bundle(filename: str) -> dict[str, Any]:
    path = _safe_bundle_path(filename)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail="Stored Bundle contains invalid JSON") from exc


@app.post("/api/pipeline/jobs", status_code=202)
def create_pipeline_job(request: PipelineRequest) -> dict[str, str]:
    job_id = uuid.uuid4().hex[:16]
    with _job_lock:
        _jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "message": "Pipeline queued",
            "current_stage": None,
            "events": [],
            "created_at": _utc_now(),
            "result": None,
            "error": None,
        }
    _executor.submit(_run_job, job_id, request)
    return {"id": job_id, "status": "queued"}


@app.get("/api/pipeline/jobs/{job_id}")
def get_pipeline_job(job_id: str) -> dict[str, Any]:
    with _job_lock:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Pipeline job not found")
        return dict(job)


@app.post("/api/icph-csv/run")
async def run_icph_csv(
    files: list[UploadFile] = File(...),
    primary_identifier_variable: str = Form(...),
) -> dict[str, Any]:
    if not files:
        raise HTTPException(status_code=400, detail="Upload at least one ICPH form CSV.")
    primary_identifier = str(primary_identifier_variable or "").strip()
    if not primary_identifier:
        raise HTTPException(status_code=400, detail="Choose the primary identifier variable.")

    from icph_csv_agent import UPLOADS_ROOT, run_icph_csv_batch

    saved_paths: list[Path] = []
    try:
        UPLOADS_ROOT.mkdir(parents=True, exist_ok=True)
        for upload in files:
            filename = Path(upload.filename or "").name
            if not filename or not filename.lower().endswith(".csv"):
                raise HTTPException(status_code=400, detail="Only CSV files are supported.")
            target = UPLOADS_ROOT / filename
            target.write_bytes(await upload.read())
            saved_paths.append(target)

        result = run_icph_csv_batch(saved_paths, primary_identifier_variable=primary_identifier)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    bundles = result.get("bundles", []) if isinstance(result, dict) else []
    primary = bundles[0] if bundles else {}
    return {
        "message": "ICPH CSV Bundle generation complete",
        "summary": {key: value for key, value in result.items() if key != "bundles"},
        "bundles": bundles,
        "primary_bundle": primary.get("bundle"),
        "primary_bundle_path": primary.get("bundle_path"),
    }
