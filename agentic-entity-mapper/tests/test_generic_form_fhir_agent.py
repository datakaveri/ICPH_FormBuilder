import csv
import json
import tempfile
import unittest
from pathlib import Path

from generic_form_fhir_agent import run_generic_form_csv_pipeline


class GenericFormFhirAgentTest(unittest.TestCase):
    def test_groups_submitted_rows_into_patient_bundles(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory) / "workspace"
            csv_path = root / "data" / "mapper" / "answers.csv"
            draft_path = root / "drafts" / "form.json"
            terminology_path = root / "terminology" / "question_entities.json"
            output_dir = root / "fhir"
            csv_path.parent.mkdir(parents=True)
            draft_path.parent.mkdir(parents=True)
            terminology_path.parent.mkdir(parents=True)

            draft_path.write_text(
                json.dumps(
                    {
                        "title": "Smoke Form",
                        "formId": "smoke_form",
                        "questions": [
                            {
                                "id": "q1",
                                "type": "text",
                                "name": "patient_id",
                                "label": "Patient ID",
                            },
                            {
                                "id": "q2",
                                "type": "integer",
                                "name": "age",
                                "label": "Age",
                            },
                            {
                                "id": "q3",
                                "type": "select_one",
                                "name": "pregnant",
                                "label": "Are you pregnant?",
                                "listName": "yes_no",
                                "options": [
                                    {"name": "0", "label": "No"},
                                    {"name": "1", "label": "Yes"},
                                ],
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )
            with csv_path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(
                    handle,
                    fieldnames=["patient_id", "_submitted_at", "age", "pregnant"],
                )
                writer.writeheader()
                writer.writerow(
                    {
                        "patient_id": "AAA00001",
                        "_submitted_at": "2026-01-01T09:00:00Z",
                        "age": "29",
                        "pregnant": "1",
                    }
                )
                writer.writerow(
                    {
                        "patient_id": "BBB00002",
                        "_submitted_at": "2026-01-02T09:00:00Z",
                        "age": "31",
                        "pregnant": "0",
                    }
                )
            terminology_path.write_text(
                json.dumps(
                    {
                        "status": "complete",
                        "questions": [
                            {
                                "id": "q3",
                                "name": "pregnant",
                                "label": "Are you pregnant?",
                                "entities": [
                                    {
                                        "entity": "pregnant",
                                        "validated": True,
                                        "approvedMappings": [
                                            {
                                                "vocabulary": "snomed",
                                                "vocabularyLabel": "SNOMED CT",
                                                "code": "77386006",
                                                "display": "Pregnancy",
                                                "systemUri": "http://snomed.info/sct",
                                            }
                                        ],
                                    }
                                ],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            result = run_generic_form_csv_pipeline(
                csv_path,
                draft_path,
                primary_identifier_variable="patient_id",
                output_dir=output_dir,
                terminology_review_path=terminology_path,
            )

            self.assertTrue(result["ok"])
            self.assertEqual(result["patient_count"], 2)
            self.assertEqual(result["row_count"], 2)
            self.assertEqual(result["approved_terminology_question_count"], 1)
            self.assertEqual(result["approved_terminology_coding_count"], 1)
            self.assertEqual(len(result["bundles"]), 2)
            self.assertTrue(Path(result["bundles"][0]["bundle_path"]).is_file())

            bundle = result["bundles"][0]["bundle"]
            resources = [entry["resource"] for entry in bundle["entry"]]
            self.assertEqual(bundle["resourceType"], "Bundle")
            self.assertIn("Patient", {resource["resourceType"] for resource in resources})
            self.assertIn("Questionnaire", {resource["resourceType"] for resource in resources})
            self.assertIn("QuestionnaireResponse", {resource["resourceType"] for resource in resources})

            questionnaire = next(resource for resource in resources if resource["resourceType"] == "Questionnaire")
            pregnant_question = next(item for item in questionnaire["item"] if item["linkId"] == "pregnant")
            self.assertIn(
                {"system": "http://snomed.info/sct", "code": "77386006", "display": "Pregnancy"},
                pregnant_question["code"],
            )

            questionnaire_response = next(
                resource for resource in resources if resource["resourceType"] == "QuestionnaireResponse"
            )
            pregnant_item = next(item for item in questionnaire_response["item"] if item["linkId"] == "pregnant")
            coding = pregnant_item["answer"][0]["valueCoding"]
            self.assertEqual(coding["code"], "1")
            self.assertEqual(coding["display"], "Yes")
            terminology_extensions = [
                extension
                for extension in pregnant_item.get("extension", [])
                if extension.get("url", "").endswith("icph-approved-terminology")
            ]
            self.assertEqual(
                terminology_extensions[0]["extension"][0]["valueCoding"]["code"],
                "77386006",
            )


if __name__ == "__main__":
    unittest.main()
