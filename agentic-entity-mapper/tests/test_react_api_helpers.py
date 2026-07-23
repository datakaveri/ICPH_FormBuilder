import json

import pytest
from fastapi import HTTPException

import react_api


def test_bundle_metadata_counts_resource_types(tmp_path):
    bundle_path = tmp_path / "bundle.json"
    bundle_path.write_text(
        json.dumps(
            {
                "resourceType": "Bundle",
                "id": "bundle-test",
                "entry": [
                    {"resource": {"resourceType": "Patient", "id": "patient-1"}},
                    {"resource": {"resourceType": "Observation", "id": "observation-1"}},
                    {"resource": {"resourceType": "Observation", "id": "observation-2"}},
                ],
            }
        ),
        encoding="utf-8",
    )

    metadata = react_api._bundle_metadata(bundle_path)

    assert metadata["entries"] == 3
    assert metadata["resource_types"] == {"Patient": 1, "Observation": 2}


def test_safe_bundle_path_rejects_traversal():
    with pytest.raises(HTTPException) as error:
        react_api._safe_bundle_path("../bundle.json")

    assert error.value.status_code == 400
