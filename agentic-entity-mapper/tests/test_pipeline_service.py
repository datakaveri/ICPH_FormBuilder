from pipeline_service import _merge_mappings


def test_merge_mappings_deduplicates_entity_text_case_insensitively():
    merged = _merge_mappings(
        [{"entity": "Type 2 diabetes mellitus", "snomed_code": "44054006"}],
        [
            {"entity": "type 2 diabetes mellitus", "snomed_code": "44054006"},
            {"entity": "Elevated HbA1c", "snomed_code": "444751005"},
        ],
    )

    assert [item["entity"] for item in merged] == [
        "Type 2 diabetes mellitus",
        "Elevated HbA1c",
    ]


def test_merge_mappings_keeps_contextually_distinct_entity_labels():
    merged = _merge_mappings(
        [{"entity": "cough"}],
        [{"entity": "no cough", "source_assertion_negated": True}],
    )

    assert len(merged) == 2
