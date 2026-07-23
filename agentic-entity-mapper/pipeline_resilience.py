"""Reusable fail-soft boundaries for independent pipeline stages."""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Callable


def _snapshot(value: Any) -> Any:
    try:
        return deepcopy(value)
    except Exception:
        if isinstance(value, list):
            return [dict(item) if isinstance(item, dict) else item for item in value]
        if isinstance(value, dict):
            return dict(value)
        return value


def _warning(stage: str, exc: Exception, fallback_error: Exception | None = None) -> dict:
    message = (
        f"{stage} was unavailable and the pipeline continued with the last valid data: "
        f"{type(exc).__name__}: {exc}"
    )
    if fallback_error is not None:
        message += (
            f" Fallback generation was also unavailable: "
            f"{type(fallback_error).__name__}: {fallback_error}"
        )
    warning = {
        "stage": stage,
        "severity": "warning",
        "exception_type": type(exc).__name__,
        "message": message,
    }
    print(f"⚠ {message}")
    return warning


def run_value_stage_fail_soft(
    stage: str,
    operation: Callable[[], Any],
    fallback: Any | Callable[[], Any],
    *,
    validator: Callable[[Any], bool] | None = None,
) -> tuple[Any, dict | None]:
    """Run a stage and return a fallback value plus warning instead of raising."""
    try:
        value = operation()
        if validator is not None and not validator(value):
            raise ValueError("stage returned an invalid result")
        return value, None
    except Exception as exc:
        fallback_error = None
        try:
            fallback_value = fallback() if callable(fallback) else _snapshot(fallback)
        except Exception as nested_exc:
            fallback_error = nested_exc
            fallback_value = None
        return fallback_value, _warning(stage, exc, fallback_error)


def run_mapping_stage_fail_soft(
    stage: str,
    mappings: list[dict],
    operation: Callable[[list[dict]], Any],
) -> tuple[list[dict], dict | None]:
    """Protect mapping state from partial mutation when an enrichment stage fails."""
    baseline = _snapshot(mappings if isinstance(mappings, list) else [])
    working_copy = _snapshot(baseline)

    def execute() -> list[dict]:
        result = operation(working_copy)
        if isinstance(result, tuple):
            result = result[0] if result else None
        if not isinstance(result, list):
            raise TypeError("mapping stage did not return a list")
        if not all(isinstance(item, dict) for item in result):
            raise TypeError("mapping stage returned a non-object mapping")
        return result

    value, warning = run_value_stage_fail_soft(
        stage,
        execute,
        baseline,
        validator=lambda result: isinstance(result, list),
    )
    return value if isinstance(value, list) else baseline, warning
