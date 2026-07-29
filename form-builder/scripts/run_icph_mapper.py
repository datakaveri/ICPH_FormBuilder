#!/usr/bin/env python3
"""Run the ICPH CSV mapper and write its JSON result to disk."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))

from generic_form_fhir_agent import run_generic_form_csv_pipeline


def main() -> int:
    parser = argparse.ArgumentParser(description="Run ICPH CSV to FHIR handoff.")
    parser.add_argument("csv_path", type=Path)
    parser.add_argument("output_json_path", type=Path)
    parser.add_argument(
        "--primary-identifier",
        dest="primary_identifier_variable",
        required=True,
        help="Survey variable used to group submitted rows into patient FHIR bundles.",
    )
    parser.add_argument(
        "--generic-form-draft",
        type=Path,
        required=True,
        help="Form-builder draft JSON used as the sole form definition for FHIR creation.",
    )
    parser.add_argument(
        "--terminology-review",
        type=Path,
        help="Reviewed terminology JSON whose approved mappings should code FHIR questionnaire items.",
    )
    args = parser.parse_args()

    result = run_generic_form_csv_pipeline(
        args.csv_path,
        args.generic_form_draft,
        primary_identifier_variable=args.primary_identifier_variable,
        output_dir=args.output_json_path.parent,
        terminology_review_path=args.terminology_review,
    )
    args.output_json_path.parent.mkdir(parents=True, exist_ok=True)
    args.output_json_path.write_text(
        json.dumps(result, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "ok": True,
        "patient_count": result.get("patient_count", 0),
        "row_count": result.get("row_count", 0),
        "bundle_count": len(result.get("bundles", [])),
        "primary_identifier_variable": result.get("primary_identifier_variable"),
        "output_json_path": str(args.output_json_path),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
