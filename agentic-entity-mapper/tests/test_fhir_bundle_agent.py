import unittest
from unittest.mock import patch

from fhir_bundle_agent import (
    _build_diagnostic_fhir_bundle,
    _merge_grounded_relationship_audit,
    _merge_grounded_patient_provider_interactions,
    _merge_mapping_review_updates,
    _mappings_share_source_fact,
    _normalize_schema_shaped_resource,
    _replace_invalid_bundle_with_diagnostic,
    _validated_resource_intent,
    build_fhir_bundle_schema_first,
    run_fhir_bundle_agent,
    validate_fhir_bundle,
)


class FhirSchemaShapeRepairTests(unittest.TestCase):
    def test_grounded_interaction_promotes_event_and_connects_all_participants(self):
        note = "During the routine follow-up visit, the patient was seen by a nurse practitioner and physician."
        mappings = [
            {
                "entity": "routine follow-up visit",
                "original_entity": "routine follow-up visit",
                "fhir_resource_type": "Procedure",
                "snomed_code": "synthetic-event-code",
                "snomed_name": "Follow-up visit (procedure)",
            },
            {
                "entity": "nurse practitioner",
                "original_entity": "nurse practitioner",
                "fhir_resource_type": "Practitioner",
                "snomed_code": "synthetic-role-code-a",
                "snomed_name": "Nurse practitioner role",
            },
            {
                "entity": "physician",
                "original_entity": "physician",
                "fhir_resource_type": "Practitioner",
                "snomed_code": "synthetic-role-code-b",
                "snomed_name": "Physician role",
            },
        ]
        payload = {
            "interactions": [
                {
                    "event_mapping_index": 0,
                    "event_evidence": "routine follow-up visit",
                    "participants": [
                        {
                            "mapping_index": 1,
                            "evidence": "seen by a nurse practitioner and physician",
                        },
                        {
                            "mapping_index": 2,
                            "evidence": "seen by a nurse practitioner and physician",
                        },
                    ],
                }
            ]
        }

        corrected = _merge_grounded_patient_provider_interactions(
            mappings,
            note,
            payload,
        )
        bundle = build_fhir_bundle_schema_first(input_text=note, mappings=corrected)

        self.assertEqual(corrected[0]["fhir_resource_type"], "Encounter")
        encounter = next(
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Encounter"
        )
        self.assertEqual(
            {
                participant["individual"]["reference"]
                for participant in encounter["participant"]
            },
            {
                "PractitionerRole/practitioner-role-001",
                "PractitionerRole/practitioner-role-002",
            },
        )
        self.assertEqual(encounter["subject"]["reference"], "Patient/patient-001")
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_relationship_audit_runs_even_when_broad_review_uses_fallback(self):
        note = "During the routine follow-up visit, the patient was seen by a nurse practitioner and physician."
        mappings = [
            {
                "entity": "routine follow-up visit",
                "original_entity": "routine follow-up visit",
                "fhir_resource_type": "Procedure",
            },
            {
                "entity": "nurse practitioner",
                "original_entity": "nurse practitioner",
                "fhir_resource_type": "Practitioner",
            },
            {
                "entity": "physician",
                "original_entity": "physician",
                "fhir_resource_type": "Practitioner",
            },
        ]
        fallback_review = {
            "summary": "Synthetic broad-review fallback.",
            "warnings": ["Synthetic fallback."],
            "resource_expectations": [],
            "corrected_mappings": mappings,
        }
        payload = {
            "interactions": [
                {
                    "event_mapping_index": 0,
                    "event_evidence": "routine follow-up visit",
                    "participants": [
                        {
                            "mapping_index": 1,
                            "evidence": "seen by a nurse practitioner and physician",
                        },
                        {
                            "mapping_index": 2,
                            "evidence": "seen by a nurse practitioner and physician",
                        },
                    ],
                }
            ]
        }

        def interaction_audit(_llm, *, input_text, mappings):
            return _merge_grounded_patient_provider_interactions(
                mappings,
                input_text,
                payload,
            )

        with (
            patch("fhir_bundle_agent.review_mappings_for_fhir", return_value=fallback_review),
            patch("fhir_bundle_agent.load_llm", return_value=object()),
            patch(
                "fhir_bundle_agent._audit_grounded_patient_provider_interactions",
                side_effect=interaction_audit,
            ) as interaction_mock,
            patch(
                "fhir_bundle_agent._audit_grounded_mapping_relationships",
                side_effect=lambda _llm, *, input_text, mappings: mappings,
            ),
            patch(
                "fhir_bundle_agent.review_generated_fhir_bundle",
                return_value={"summary": "Synthetic generated-bundle review."},
            ),
            patch(
                "fhir_bundle_agent.save_fhir_bundle",
                return_value="/tmp/synthetic-related-bundle.json",
            ),
        ):
            bundle, _bundle_path, _logs = run_fhir_bundle_agent(
                input_text=note,
                mappings=mappings,
            )

        interaction_mock.assert_called_once()
        encounter = next(
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Encounter"
        )
        self.assertEqual(len(encounter["participant"]), 2)
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_mapping_review_cannot_overwrite_grounded_encounter_intent(self):
        mappings = [
            {
                "entity": "follow-up event alpha",
                "original_entity": "follow-up event alpha",
                "fhir_resource_type": "Encounter",
            }
        ]
        updates = {
            0: {
                "mapping_index": 0,
                "entity": "follow-up event alpha",
                "fhir_resource_type": "Procedure",
            }
        }

        corrected = _merge_mapping_review_updates(
            mappings,
            updates,
            ["Encounter", "Procedure"],
        )

        self.assertEqual(corrected[0]["fhir_resource_type"], "Encounter")

    def test_relationship_audit_requires_exact_note_evidence(self):
        note = "The follow-up event alpha included clinician role alpha."
        mappings = [
            {
                "entity": "follow-up event alpha",
                "original_entity": "follow-up event alpha",
                "fhir_resource_type": "Encounter",
            },
            {
                "entity": "clinician role alpha",
                "original_entity": "clinician role alpha",
                "fhir_resource_type": "Practitioner",
            },
        ]
        grounded_payload = {
            "relationships": [
                {
                    "source_mapping_index": 0,
                    "relationship": "participant.individual",
                    "target_mapping_index": 1,
                    "evidence": note,
                }
            ]
        }
        ungrounded_payload = {
            "relationships": [
                {
                    "source_mapping_index": 0,
                    "relationship": "participant.individual",
                    "target_mapping_index": 1,
                    "evidence": "A relationship not present in the note.",
                }
            ]
        }

        grounded = _merge_grounded_relationship_audit(mappings, note, grounded_payload)
        ungrounded = _merge_grounded_relationship_audit(mappings, note, ungrounded_payload)

        self.assertEqual(
            grounded[0]["fhir_relationships"][0]["target_mapping_index"],
            1,
        )
        self.assertEqual(
            grounded[0]["fhir_relationships"][0]["target_resource_type"],
            "PractitionerRole",
        )
        self.assertNotIn("fhir_relationships", ungrounded[0])
        bundle = build_fhir_bundle_schema_first(input_text=note, mappings=grounded)
        encounter = next(
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Encounter"
        )
        self.assertEqual(
            encounter["participant"][0]["individual"]["reference"],
            "PractitionerRole/practitioner-role-001",
        )
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_terminology_hierarchy_does_not_override_grounded_encounter_intent(self):
        mapping = {
            "entity": "follow-up event alpha",
            "original_entity": "follow-up event alpha",
            "fhir_resource_type": "Encounter",
            "snomed_code": "synthetic-event-code",
            "snomed_name": "Follow-up event alpha (procedure)",
        }

        self.assertEqual(_validated_resource_intent(mapping), "Encounter")

    def test_encounter_resolves_all_grounded_practitioner_participants(self):
        mappings = [
            {
                "entity": "follow-up event alpha",
                "original_entity": "follow-up event alpha",
                "fhir_resource_type": "Encounter",
                "snomed_code": "synthetic-event-code",
                "snomed_name": "Follow-up event alpha (procedure)",
                "fhir_relationships": [
                    {
                        "relationship": "participant",
                        "target_entity": "clinician role alpha",
                        "target_resource_type": "PractitionerRole",
                    },
                    {
                        "relationship": "participant.individual",
                        "target_entity": "clinician role beta",
                        "target_resource_type": "PractitionerRole",
                    },
                ],
            },
            {
                "entity": "clinician role alpha",
                "original_entity": "clinician role alpha",
                "fhir_resource_type": "Practitioner",
                "snomed_code": "synthetic-role-code-a",
                "snomed_name": "Clinician role alpha",
            },
            {
                "entity": "clinician role beta",
                "original_entity": "clinician role beta",
                "fhir_resource_type": "Practitioner",
                "snomed_code": "synthetic-role-code-b",
                "snomed_name": "Clinician role beta",
            },
        ]

        bundle = build_fhir_bundle_schema_first(
            input_text="A grounded follow-up event included two clinician roles.",
            mappings=mappings,
        )

        encounter = next(
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Encounter"
        )
        practitioner_role_ids = {
            entry["resource"]["id"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "PractitionerRole"
        }
        participant_references = {
            participant["individual"]["reference"]
            for participant in encounter["participant"]
        }
        self.assertEqual(encounter["subject"]["reference"], "Patient/patient-001")
        self.assertEqual(encounter["status"], "unknown")
        self.assertEqual(
            encounter["class"]["extension"][0]["valueCode"],
            "unknown",
        )
        self.assertEqual(
            participant_references,
            {f"PractitionerRole/{resource_id}" for resource_id in practitioner_role_ids},
        )
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_coverage_resolves_grounded_organization_payor(self):
        mappings = [
            {
                "entity": "plan coverage alpha",
                "original_entity": "plan coverage alpha",
                "fhir_resource_type": "Coverage",
                "snomed_code": "synthetic-coverage-code",
                "snomed_name": "Plan coverage alpha",
                "fhir_relationships": [
                    {
                        "relationship": "payor",
                        "target_entity": "organization alpha",
                        "target_resource_type": "Organization",
                    }
                ],
            },
            {
                "entity": "organization alpha",
                "original_entity": "organization alpha",
                "fhir_resource_type": "Organization",
                "snomed_code": "synthetic-organization-code",
                "snomed_name": "Organization alpha",
            },
        ]

        bundle = build_fhir_bundle_schema_first(
            input_text="Grounded plan coverage is underwritten by organization alpha.",
            mappings=mappings,
        )

        coverage = next(
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Coverage"
        )
        organization = next(
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Organization"
        )
        self.assertEqual(coverage["beneficiary"]["reference"], "Patient/patient-001")
        self.assertEqual(
            coverage["payor"],
            [{"reference": f"Organization/{organization['id']}"}],
        )
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_single_encounter_deterministically_connects_unlinked_practitioner_role(self):
        mappings = [
            {
                "entity": "follow-up event alpha",
                "original_entity": "follow-up event alpha",
                "fhir_resource_type": "Encounter",
                "snomed_code": "synthetic-event-code",
                "snomed_name": "Follow-up event alpha",
            },
            {
                "entity": "clinician role alpha",
                "original_entity": "clinician role alpha",
                "fhir_resource_type": "Practitioner",
                "snomed_code": "synthetic-role-code",
                "snomed_name": "Clinician role alpha",
            },
        ]

        bundle = build_fhir_bundle_schema_first(
            input_text="Two unrelated grounded facts are present.",
            mappings=mappings,
        )
        encounter = next(
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Encounter"
        )

        self.assertEqual(
            encounter["participant"],
            [
                {
                    "individual": {
                        "reference": "PractitionerRole/practitioner-role-001",
                    }
                }
            ],
        )
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_unlinked_role_uses_only_empty_encounter_when_other_encounter_is_claimed(self):
        mappings = [
            {
                "entity": "event alpha",
                "original_entity": "event alpha",
                "fhir_resource_type": "Encounter",
                "snomed_code": "synthetic-event-code-a",
            },
            {
                "entity": "role alpha",
                "original_entity": "role alpha",
                "fhir_resource_type": "Practitioner",
                "snomed_code": "synthetic-role-code-a",
            },
            {
                "entity": "role beta",
                "original_entity": "role beta",
                "fhir_resource_type": "Practitioner",
                "snomed_code": "synthetic-role-code-b",
            },
            {
                "entity": "event beta",
                "original_entity": "event beta",
                "fhir_resource_type": "Encounter",
                "snomed_code": "synthetic-event-code-b",
                "fhir_relationships": [
                    {
                        "relationship": "participant.individual",
                        "target_mapping_index": 1,
                        "target_entity": "role alpha",
                        "target_resource_type": "PractitionerRole",
                    }
                ],
            },
        ]

        bundle = build_fhir_bundle_schema_first(
            input_text="Two structured encounter facts and two role facts are present.",
            mappings=mappings,
        )
        encounters = {
            resource["type"][0]["text"]: resource
            for entry in bundle["entry"]
            if (resource := entry["resource"])["resourceType"] == "Encounter"
        }

        self.assertEqual(
            encounters["event alpha"]["participant"][0]["individual"]["reference"],
            "PractitionerRole/practitioner-role-002",
        )
        self.assertEqual(
            encounters["event beta"]["participant"][0]["individual"]["reference"],
            "PractitionerRole/practitioner-role-001",
        )
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_multiple_empty_encounters_do_not_receive_an_arbitrary_role(self):
        mappings = [
            {
                "entity": "event alpha",
                "original_entity": "event alpha",
                "fhir_resource_type": "Encounter",
                "snomed_code": "synthetic-event-code-a",
            },
            {
                "entity": "event beta",
                "original_entity": "event beta",
                "fhir_resource_type": "Encounter",
                "snomed_code": "synthetic-event-code-b",
            },
            {
                "entity": "role alpha",
                "original_entity": "role alpha",
                "fhir_resource_type": "Practitioner",
                "snomed_code": "synthetic-role-code",
            },
        ]

        bundle = build_fhir_bundle_schema_first(
            input_text="Two unrelated encounter facts and one role fact are present.",
            mappings=mappings,
        )
        encounters = [
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Encounter"
        ]

        self.assertEqual(len(encounters), 2)
        self.assertTrue(all("participant" not in encounter for encounter in encounters))
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_malformed_optional_mapping_field_does_not_block_bundle(self):
        mapping = {
            "entity": "mapped medication",
            "original_entity": "source medication mention",
            "fhir_resource_type": "MedicationStatement",
            "snomed_code": "synthetic-snomed-code",
            "snomed_name": "Synthetic medication concept",
            "rxnorm_code": "synthetic-rxnorm-code",
            "rxnorm_name": "Synthetic medication product",
            "dosage": "unstructured dosage",
        }

        bundle = build_fhir_bundle_schema_first(
            input_text="A source medication mention is present.",
            mappings=[mapping],
        )

        self.assertEqual(validate_fhir_bundle(bundle), [])
        medication = next(
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "MedicationStatement"
        )
        self.assertNotIn("dosage", medication)
        self.assertEqual(
            medication["medicationCodeableConcept"]["coding"][0]["code"],
            "synthetic-snomed-code",
        )

    def test_valid_structured_optional_mapping_field_is_preserved(self):
        resource = {
            "resourceType": "MedicationStatement",
            "id": "medication-statement-001",
            "medicationCodeableConcept": {"text": "synthetic medication"},
            "subject": {"reference": "Patient/patient-001"},
            "dosage": [{"text": "Take as directed"}],
        }

        normalized = _normalize_schema_shaped_resource(resource, [])

        self.assertEqual(normalized["dosage"], [{"text": "Take as directed"}])

    def test_same_source_fact_preserves_complementary_ontology_codes(self):
        mappings = [
            {
                "entity": "normalized mapped fact",
                "original_entity": "shared source mention",
                "fhir_resource_type": "Condition",
                "snomed_code": "synthetic-code-a",
                "snomed_name": "Synthetic primary concept",
            },
            {
                "entity": "alternate mapped fact",
                "original_entity": "shared source mention",
                "icd10_code": "synthetic-code-b",
                "icd10_name": "Synthetic alternate concept",
            },
        ]

        bundle = build_fhir_bundle_schema_first(
            input_text="A shared source mention is present.",
            mappings=mappings,
        )

        resources = [
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Condition"
        ]
        self.assertEqual(len(resources), 1)
        codes = {
            coding["code"]
            for coding in resources[0]["code"]["coding"]
        }
        self.assertEqual(codes, {"synthetic-code-a", "synthetic-code-b"})
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_explicit_shared_boolean_contradiction_keeps_facts_separate(self):
        left = {
            "original_entity": "shared source mention",
            "arbitrary_context": {"items": [{"arbitrary_flag": True}]},
        }
        right = {
            "original_entity": "shared source mention",
            "arbitrary_context": {"items": [{"arbitrary_flag": False}]},
        }

        self.assertFalse(_mappings_share_source_fact(left, right))

    def test_underlying_code_uses_external_refutation_when_assertion_not_encoded(self):
        mappings = [
            {
                "entity": "absence of synthetic condition alpha",
                "original_entity": "absence of synthetic condition alpha",
                "fhir_resource_type": "Condition",
                "source_assertion_negated": True,
            },
            {
                "entity": "synthetic condition alpha",
                "original_entity": "synthetic condition alpha",
                "fhir_resource_type": "Condition",
                "snomed_code": "synthetic-underlying-code",
                "source_assertion_negated": True,
                "assertion_encoded_by_concept": False,
            },
        ]

        bundle = build_fhir_bundle_schema_first(
            input_text="Absence of synthetic condition alpha was documented.",
            mappings=mappings,
        )

        conditions = [
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Condition"
        ]
        self.assertEqual(len(conditions), 1)
        self.assertEqual(
            conditions[0]["code"]["coding"][0]["code"],
            "synthetic-underlying-code",
        )
        self.assertEqual(
            [
                coding["code"]
                for coding in conditions[0]["verificationStatus"]["coding"]
            ],
            ["refuted"],
        )
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_external_negative_assertion_keeps_underlying_code_text_and_one_resource(self):
        mappings = [
            {
                "entity": "synthetic alpha denied",
                "original_entity": "synthetic alpha denied",
                "fhir_resource_type": "Observation",
                "source_assertion_negated": True,
            },
            {
                "entity": "synthetic alpha",
                "original_entity": "synthetic alpha",
                "fhir_resource_type": "Observation",
                "snomed_code": "synthetic-alpha-code",
                "snomed_name": "Synthetic alpha finding",
                "source_assertion_negated": True,
                "assertion_encoded_by_concept": False,
            },
        ]

        bundle = build_fhir_bundle_schema_first(
            input_text="Synthetic alpha was stated to be absent.",
            mappings=mappings,
        )

        observations = [
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Observation"
        ]
        self.assertEqual(len(observations), 1)
        self.assertEqual(observations[0]["code"]["text"], "synthetic alpha")
        self.assertEqual(
            observations[0]["code"]["coding"][0]["code"],
            "synthetic-alpha-code",
        )
        self.assertIs(observations[0]["valueBoolean"], False)
        self.assertEqual(observations[0]["interpretation"][0]["coding"][0]["code"], "N")
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_inconsistent_encoded_assertion_flag_does_not_hide_refutation(self):
        mapping = {
            "entity": "synthetic condition gamma",
            "original_entity": "synthetic condition gamma",
            "fhir_resource_type": "Condition",
            "snomed_code": "synthetic-positive-code",
            "source_assertion_negated": True,
            "assertion_encoded_by_concept": True,
            "negation_type": None,
        }

        bundle = build_fhir_bundle_schema_first(
            input_text="A synthetic condition gamma was absent.",
            mappings=[mapping],
        )

        condition = next(
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Condition"
        )
        self.assertEqual(
            condition["verificationStatus"]["coding"][0]["code"],
            "refuted",
        )
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_assertion_encoded_code_avoids_duplicate_external_refutation(self):
        mappings = [
            {
                "entity": "absence of synthetic condition beta",
                "original_entity": "absence of synthetic condition beta",
                "fhir_resource_type": "Condition",
                "source_assertion_negated": True,
            },
            {
                "entity": "negative synthetic condition beta",
                "original_entity": "synthetic condition beta",
                "fhir_resource_type": "Condition",
                "snomed_code": "synthetic-assertion-code",
                "source_assertion_negated": True,
                "assertion_encoded_by_concept": True,
                "negation_type": "synthetic-absence",
            },
        ]

        bundle = build_fhir_bundle_schema_first(
            input_text="Absence of synthetic condition beta was documented.",
            mappings=mappings,
        )

        conditions = [
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Condition"
        ]
        self.assertEqual(len(conditions), 1)
        self.assertEqual(
            conditions[0]["code"]["coding"][0]["code"],
            "synthetic-assertion-code",
        )
        self.assertNotIn("verificationStatus", conditions[0])
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_contextual_assertion_code_does_not_require_negation_type(self):
        mapping = {
            "entity": "absence of synthetic finding delta",
            "original_entity": "synthetic finding delta",
            "generalized_term": "absence of synthetic finding delta",
            "matched_via": "contextual_search",
            "fhir_resource_type": "Observation",
            "snomed_code": "synthetic-context-code",
            "snomed_name": "Synthetic absence concept",
            "source_assertion_negated": True,
            "assertion_encoded_by_concept": True,
            "negation_type": None,
        }

        bundle = build_fhir_bundle_schema_first(
            input_text="Synthetic finding delta was documented as absent.",
            mappings=[mapping],
        )

        observation = next(
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Observation"
        )
        self.assertEqual(
            observation["code"]["text"],
            "absence of synthetic finding delta",
        )
        self.assertNotIn("valueBoolean", observation)
        self.assertNotIn("interpretation", observation)
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_assertion_complete_mapping_supersedes_base_fallback(self):
        mappings = [
            {
                "entity": "synthetic finding epsilon",
                "original_entity": "synthetic finding epsilon",
                "fhir_resource_type": "Observation",
                "snomed_code": "synthetic-base-code",
                "snomed_name": "Synthetic positive concept",
                "source_assertion_negated": True,
                "assertion_encoded_by_concept": True,
                "negation_type": None,
            },
            {
                "entity": "synthetic finding epsilon",
                "original_entity": "absence of synthetic finding epsilon",
                "fhir_resource_type": "Observation",
                "snomed_code": "synthetic-assertion-code",
                "snomed_name": "Synthetic assertion-complete concept",
                "source_assertion_negated": True,
                "assertion_encoded_by_concept": True,
                "negation_type": "synthetic-absence",
            },
        ]

        bundle = build_fhir_bundle_schema_first(
            input_text="Absence of synthetic finding epsilon was documented.",
            mappings=mappings,
        )

        observations = [
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Observation"
        ]
        self.assertEqual(len(observations), 1)
        self.assertEqual(
            [coding["code"] for coding in observations[0]["code"]["coding"]],
            ["synthetic-assertion-code"],
        )
        self.assertEqual(
            observations[0]["code"]["text"],
            "absence of synthetic finding epsilon",
        )
        self.assertNotIn("valueBoolean", observations[0])
        self.assertNotIn("interpretation", observations[0])
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_nested_provenance_text_is_not_promoted_to_resource_narrative(self):
        mapping = {
            "entity": "normalized synthetic finding",
            "original_entity": "source synthetic finding",
            "fhir_resource_type": "Observation",
            "snomed_code": "synthetic-finding-code",
            "snomed_name": "Canonical synthetic display",
            "medspacy_context": {
                "mentions": [{"text": "nested provenance text"}],
            },
        }

        bundle = build_fhir_bundle_schema_first(
            input_text="A source synthetic finding was documented.",
            mappings=[mapping],
        )

        observation = next(
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Observation"
        )
        self.assertNotIn("text", observation)
        self.assertEqual(observation["code"]["text"], "source synthetic finding")
        self.assertEqual(
            observation["code"]["coding"][0]["display"],
            "Canonical synthetic display",
        )
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_unclassified_coded_fact_uses_schema_defined_basic_fallback(self):
        mapping = {
            "entity": "synthetic unclassified fact",
            "original_entity": "synthetic source fact",
            "snomed_code": "synthetic-unclassified-code",
            "snomed_name": "Synthetic unclassified concept",
        }

        bundle = build_fhir_bundle_schema_first(
            input_text="A synthetic source fact is present.",
            mappings=[mapping],
        )

        fallback_resources = [
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Basic"
        ]
        self.assertEqual(len(fallback_resources), 1)
        self.assertEqual(
            fallback_resources[0]["code"]["coding"][0]["code"],
            "synthetic-unclassified-code",
        )
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_unclassified_text_only_fact_uses_schema_defined_basic_fallback(self):
        mapping = {
            "entity": "synthetic text-only fact",
            "original_entity": "synthetic source phrase",
        }

        bundle = build_fhir_bundle_schema_first(
            input_text="A synthetic source phrase is present.",
            mappings=[mapping],
        )

        fallback_resources = [
            entry["resource"]
            for entry in bundle["entry"]
            if entry["resource"]["resourceType"] == "Basic"
        ]
        self.assertEqual(len(fallback_resources), 1)
        self.assertEqual(
            fallback_resources[0]["code"]["text"],
            "synthetic source phrase",
        )
        self.assertEqual(validate_fhir_bundle(bundle), [])

    def test_diagnostic_fallback_is_itself_a_valid_fhir_bundle(self):
        bundle = _build_diagnostic_fhir_bundle(
            input_text="A synthetic input fact is present.",
            mappings=[{"entity": "synthetic fact"}],
            diagnostics=["Synthetic composition failure."],
        )

        self.assertEqual(validate_fhir_bundle(bundle), [])
        outcome = bundle["entry"][0]["resource"]
        self.assertEqual(outcome["resourceType"], "OperationOutcome")
        self.assertEqual(outcome["issue"][0]["severity"], "error")
        self.assertEqual(outcome["issue"][0]["code"], "exception")

    def test_invalid_composed_bundle_is_replaced_before_save(self):
        replacement, original_errors = _replace_invalid_bundle_with_diagnostic(
            bundle={"resourceType": "Bundle", "type": "invalid-type"},
            input_text="A synthetic input fact is present.",
            mappings=[{"entity": "synthetic fact"}],
            diagnostics_prefix="Synthetic validation failure.",
        )

        self.assertTrue(original_errors)
        self.assertEqual(validate_fhir_bundle(replacement), [])
        self.assertTrue(_bundle_has_error_operation_outcome_for_test(replacement))

    def test_agent_saves_diagnostic_bundle_when_builder_raises(self):
        mappings = [{"entity": "synthetic fact"}]
        review = {
            "summary": "Synthetic review.",
            "warnings": [],
            "resource_expectations": [],
            "corrected_mappings": mappings,
        }
        with (
            patch("fhir_bundle_agent.review_mappings_for_fhir", return_value=review),
            patch(
                "fhir_bundle_agent.build_fhir_bundle_schema_first",
                side_effect=RuntimeError("synthetic failure"),
            ),
            patch(
                "fhir_bundle_agent.save_fhir_bundle",
                return_value="/tmp/synthetic-diagnostic-bundle.json",
            ) as save_mock,
        ):
            bundle, bundle_path, _logs = run_fhir_bundle_agent(
                input_text="A synthetic input fact is present.",
                mappings=mappings,
            )

        self.assertEqual(validate_fhir_bundle(bundle), [])
        self.assertTrue(bundle_path)
        self.assertTrue(_bundle_has_error_operation_outcome_for_test(bundle))
        save_mock.assert_called_once_with(bundle)

    def test_agent_continues_when_optional_review_raises(self):
        mappings = [
            {
                "entity": "synthetic unclassified fact",
                "snomed_code": "synthetic-code",
            }
        ]
        with (
            patch(
                "fhir_bundle_agent.review_mappings_for_fhir",
                side_effect=RuntimeError("synthetic review failure"),
            ),
            patch(
                "fhir_bundle_agent.review_generated_fhir_bundle",
                return_value={"summary": "Synthetic generated-bundle review."},
            ),
            patch(
                "fhir_bundle_agent.save_fhir_bundle",
                return_value="/tmp/synthetic-valid-bundle.json",
            ),
        ):
            bundle, bundle_path, _logs = run_fhir_bundle_agent(
                input_text="A synthetic input fact is present.",
                mappings=mappings,
            )

        self.assertEqual(validate_fhir_bundle(bundle), [])
        self.assertTrue(bundle_path)
        self.assertFalse(_bundle_has_error_operation_outcome_for_test(bundle))

    def test_agent_returns_valid_bundle_in_memory_when_persistence_fails(self):
        mappings = [{"entity": "synthetic fact"}]
        review = {
            "summary": "Synthetic review.",
            "warnings": [],
            "resource_expectations": [],
            "corrected_mappings": mappings,
        }
        with (
            patch("fhir_bundle_agent.review_mappings_for_fhir", return_value=review),
            patch(
                "fhir_bundle_agent.review_generated_fhir_bundle",
                return_value={"summary": "Synthetic generated-bundle review."},
            ),
            patch(
                "fhir_bundle_agent.save_fhir_bundle",
                side_effect=OSError("synthetic persistence failure"),
            ),
        ):
            bundle, bundle_path, logs = run_fhir_bundle_agent(
                input_text="A synthetic input fact is present.",
                mappings=mappings,
            )

        self.assertEqual(validate_fhir_bundle(bundle), [])
        self.assertEqual(bundle_path, "")
        self.assertTrue(any("returning the valid Bundle in memory" in log for log in logs))


def _bundle_has_error_operation_outcome_for_test(bundle):
    return any(
        entry.get("resource", {}).get("resourceType") == "OperationOutcome"
        and any(
            issue.get("severity") in {"error", "fatal"}
            for issue in entry.get("resource", {}).get("issue", [])
        )
        for entry in bundle.get("entry", [])
    )


if __name__ == "__main__":
    unittest.main()
