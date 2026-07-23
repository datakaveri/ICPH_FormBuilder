import csv
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import icd10_mapper_agent as icd10
import schema_terminology_assets as terminology_assets


class ICD10LookupArtifactTests(unittest.TestCase):
    def test_builder_keeps_canonical_title_and_search_aliases_separate(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory) / "SchemaTerminologies"
            source = (
                root
                / "terminologies"
                / "ICD"
                / "synthetic-release"
                / "synthetic_syst_codes.txt"
            )
            source.parent.mkdir(parents=True)
            source_row = [
                "4",
                "T",
                "X",
                "00",
                "SYN",
                "SYN.1",
                "SYN.1",
                "SYN1",
                "Synthetic category: Synthetic detail",
                "Synthetic category",
                "Synthetic detail",
                "",
                "001",
                "",
                "",
                "",
                "",
            ]
            with source.open("w", encoding="utf-8", newline="") as handle:
                csv.writer(handle, delimiter=";").writerow(source_row)

            shared_root = root / "artifacts" / "shared"
            (shared_root / "icd10" / "synthetic-release" / "lookups").mkdir(
                parents=True
            )
            with (
                patch.object(terminology_assets, "SCHEMA_TERMINOLOGIES_DIR", root),
                patch.object(terminology_assets, "SHARED_ARTIFACTS_DIR", shared_root),
                patch.dict(os.environ, {"AGENTIC_ICD10_SOURCE_PATH": ""}),
            ):
                lookup_path = terminology_assets.build_icd10_lookup()

            with lookup_path.open("r", encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(rows[0]["code"], "SYN.1")
            self.assertEqual(
                rows[0]["display"],
                "Synthetic category: Synthetic detail",
            )
            self.assertEqual(
                json.loads(rows[0]["aliases"]),
                ["Synthetic category", "Synthetic detail"],
            )


class ICD10HybridRetrievalTests(unittest.TestCase):
    def setUp(self):
        self.lookup_rows = [
            {
                "code": "SYN.1",
                "display": "Synthetic canonical title",
                "aliases": json.dumps(["Source wording"]),
                "status": "active",
                "system_uri": "urn:synthetic:system",
            },
            {
                "code": "SYN.2",
                "display": "Distant canonical title",
                "aliases": "[]",
                "status": "active",
                "system_uri": "urn:synthetic:system",
            },
        ]
        self.lookup_by_code = {row["code"]: row for row in self.lookup_rows}

    def test_csv_and_dense_candidates_are_merged_by_code(self):
        dense_rows = [
            {
                "code": "SYN.1",
                "display": "Stale abbreviated title",
                "indexed_term": "Source wording",
                "semantic_score": 0.99,
            },
            {
                "code": "SYN.2",
                "display": "Stale leaf title",
                "indexed_term": "Related wording",
                "semantic_score": 0.91,
            },
        ]
        with (
            patch.object(
                icd10,
                "_load_icd10_lookup",
                return_value=(self.lookup_rows, self.lookup_by_code),
            ),
            patch.object(icd10, "search_dense_terminology", return_value=dense_rows),
        ):
            candidates = icd10._search_candidates("Source wording")

        by_code = {candidate["code"]: candidate for candidate in candidates}
        self.assertEqual(by_code["SYN.1"]["retrieval_source"], "lexical+dense")
        self.assertEqual(by_code["SYN.1"]["display"], "Synthetic canonical title")
        self.assertEqual(by_code["SYN.2"]["retrieval_source"], "dense")
        self.assertEqual(by_code["SYN.2"]["display"], "Distant canonical title")

    def test_csv_lookup_still_works_when_dense_retrieval_is_unavailable(self):
        with (
            patch.object(
                icd10,
                "_load_icd10_lookup",
                return_value=(self.lookup_rows, self.lookup_by_code),
            ),
            patch.object(icd10, "search_dense_terminology", return_value=[]),
        ):
            candidates = icd10._search_candidates("Synthetic canonical title")

        self.assertEqual(candidates[0]["code"], "SYN.1")
        self.assertEqual(candidates[0]["retrieval_source"], "lexical")

    def test_llm_failure_falls_back_only_to_safe_lexical_evidence(self):
        candidates = [
            {
                "code": "SYN.1",
                "display": "Synthetic canonical title",
                "retrieval_source": "lexical+dense",
            },
            {
                "code": "SYN.2",
                "display": "Distant canonical title",
                "retrieval_source": "dense",
            },
        ]
        with patch.object(icd10, "load_llm", side_effect=RuntimeError("unavailable")):
            positive = icd10._pick_best_candidate_with_llm(
                "Synthetic canonical title",
                "",
                candidates,
            )
            negated = icd10._pick_best_candidate_with_llm(
                "No synthetic canonical title",
                "",
                candidates,
                source_assertion_negated=True,
            )

        self.assertEqual(positive["code"], "SYN.1")
        self.assertIsNone(negated)


if __name__ == "__main__":
    unittest.main()
