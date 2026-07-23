import unittest
from unittest.mock import patch

from abbreviation_agent import run_abbreviation_agent
import loinc_mapper_agent as loinc
import rxnorm_mapper_agent as rxnorm
from loinc_mapper_agent import run_loinc_agent_langgraph
from rxnorm_mapper_agent import run_rxnorm_agent_langgraph
from snomed_mapper_agent import run_snomed_agent


class AgentFailSoftTests(unittest.TestCase):
    def test_agent1_continues_when_language_and_llm_initialization_fail(self):
        with (
            patch("abbreviation_agent.load_spacy_model", side_effect=RuntimeError("unavailable")),
            patch("abbreviation_agent.load_llm", side_effect=RuntimeError("unavailable")),
            patch("abbreviation_agent.mask_pii_locally", return_value="Safely masked text."),
        ):
            processed_text, logs = run_abbreviation_agent("Synthetic source text.")

        self.assertEqual(processed_text, "Safely masked text.")
        self.assertTrue(any("initialization failed" in log for log in logs))

    def test_snomed_resource_failure_preserves_seed_facts_without_codes(self):
        seed = [{"entity": "Synthetic source fact", "fhir_resource_type": "Observation"}]
        with patch("snomed_mapper_agent.load_resources", side_effect=OSError("unavailable")):
            result = run_snomed_agent("Synthetic source fact.", seed_entities=seed)

        self.assertEqual(result["mappings"][0]["entity"], "Synthetic source fact")
        self.assertNotIn("snomed_code", result["mappings"][0])
        self.assertTrue(result["warnings"])

    def test_loinc_routing_failure_returns_original_mappings(self):
        mappings = [{"entity": "Synthetic structured measurement"}]
        with patch("loinc_mapper_agent.load_llm", side_effect=RuntimeError("unavailable")):
            result, logs, traces = run_loinc_agent_langgraph("Synthetic context.", mappings)

        self.assertEqual(result, mappings)
        self.assertEqual(traces, [])
        self.assertTrue(any("left unchanged" in log for log in logs))

    def test_rxnorm_routing_failure_returns_original_mappings(self):
        mappings = [{"entity": "Synthetic product"}]
        with patch("rxnorm_mapper_agent.load_llm", side_effect=RuntimeError("unavailable")):
            result, logs, traces = run_rxnorm_agent_langgraph("Synthetic context.", mappings)

        self.assertEqual(result, mappings)
        self.assertEqual(traces, [])
        self.assertTrue(any("left unchanged" in log for log in logs))

    def test_loinc_dense_retrieval_remains_available_without_csv(self):
        candidate = {
            "code": "SYN-L",
            "display": "Synthetic structured measurement",
            "retrieval_source": "dense",
        }
        with (
            patch.object(loinc, "LOINC_LOOKUP_CSV", None),
            patch.object(loinc, "_loinc_lookup_df", None),
            patch.object(loinc, "_dense_loinc_candidates", return_value=[candidate]),
            patch.object(loinc, "_pick_best_candidate_with_llm", return_value=candidate),
        ):
            result = loinc._query_loinc("Synthetic structured measurement")

        self.assertEqual(result["code"], "SYN-L")

    def test_rxnorm_dense_retrieval_remains_available_without_csv(self):
        candidate = {
            "code": "SYN-R",
            "display": "Synthetic product",
            "retrieval_source": "dense",
        }
        with (
            patch.object(rxnorm, "RXNORM_LOOKUP_CSV", None),
            patch.object(rxnorm, "_rxnorm_lookup_df", None),
            patch.object(rxnorm, "_dense_rxnorm_candidates", return_value=[candidate]),
            patch.object(rxnorm, "_pick_best_candidate_with_llm", return_value=candidate),
        ):
            result = rxnorm._query_rxnorm("Synthetic product")

        self.assertEqual(result["rxcui"], "SYN-R")


if __name__ == "__main__":
    unittest.main()
