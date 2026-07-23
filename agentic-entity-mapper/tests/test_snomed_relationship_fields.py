from snomed_mapper_agent import (
    _exact_terminology_match_is_terminal,
    _has_context_marker,
    _merge_extracted_entities,
    _unique_exact_terminology_candidate,
    _uses_contextual_search_terms,
)


def test_context_bearing_generated_alias_cannot_bypass_semantic_reranking():
    exact_candidate = {
        "concept_id": "synthetic-code",
        "term": "alternate finding alias",
        "fsn": "Alternate finding alias (finding)",
    }
    source_item = {
        "entity": "absence of source finding",
        "source_assertion_negated": True,
        "terminology_context_changes_meaning": True,
        "entity_text_encodes_terminology_context": True,
    }

    assert not _exact_terminology_match_is_terminal(
        exact_candidate,
        source_item,
        search_entity="alternate finding alias",
        original_entity="absence of source finding",
    )


def test_plain_exact_source_match_can_still_use_deterministic_shortcut():
    exact_candidate = {
        "concept_id": "synthetic-code",
        "term": "source finding",
        "fsn": "Source finding (finding)",
    }
    source_item = {
        "entity": "source finding",
        "terminology_context_changes_meaning": False,
    }

    assert _exact_terminology_match_is_terminal(
        exact_candidate,
        source_item,
        search_entity="source finding",
        original_entity="source finding",
    )


def test_external_assertion_does_not_replace_the_source_terminology_term():
    source_item = {
        "entity": "source finding",
        "source_assertion_negated": True,
        "terminology_context_changes_meaning": False,
    }

    assert _has_context_marker(source_item)
    assert not _uses_contextual_search_terms(source_item)


def test_regular_plural_source_uses_unique_singular_terminology_label():
    candidate = {
        "concept_id": "synthetic-code",
        "term": "synthetic signal",
        "fsn": "Synthetic signal (finding)",
    }

    assert _unique_exact_terminology_candidate(
        "synthetic signals",
        [candidate, {"concept_id": "other-code", "term": "unrelated term"}],
    ) == candidate


def test_grounded_relationship_objects_survive_multi_pass_entity_merge():
    entity_batches = [
        [
            {
                "entity": "event alpha",
                "ontology_search_terms": ["event alpha"],
                "fhir_relationships": [
                    {
                        "relationship": "participant",
                        "target_entity": "role alpha",
                        "target_resource_type": "PractitionerRole",
                    }
                ],
            }
        ],
        [
            {
                "entity": "event alpha",
                "ontology_search_terms": ["event alpha"],
                "fhir_relationships": [
                    {
                        "relationship": "participant",
                        "target_entity": "role alpha",
                        "target_resource_type": "PractitionerRole",
                    },
                    {
                        "relationship": "participant",
                        "target_entity": "role beta",
                        "target_resource_type": "PractitionerRole",
                    },
                ],
            }
        ],
    ]

    merged = _merge_extracted_entities(entity_batches)

    assert len(merged) == 1
    assert merged[0]["fhir_relationships"] == [
        {
            "relationship": "participant",
            "target_entity": "role alpha",
            "target_resource_type": "PractitionerRole",
        },
        {
            "relationship": "participant",
            "target_entity": "role beta",
            "target_resource_type": "PractitionerRole",
        },
    ]
