import os
import io
import sys
import unittest
from dataclasses import dataclass
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from abbreviation_agent import (
    load_biomedical_ner_model,
    load_privacy_ner_model,
    mask_pii_locally,
)


@dataclass
class FakeEntity:
    text: str
    label_: str
    start_char: int
    end_char: int


class FakeDocument:
    def __init__(self, entities):
        self.ents = entities


class FakeNlp:
    def __init__(self, entities):
        self.entities = entities

    def __call__(self, _text):
        return FakeDocument(self.entities)


class FakeBiomedicalNer:
    def __init__(self, spans, score=1.0):
        self.spans = spans
        self.score = score

    def __call__(self, _text):
        return [
            {
                "start": start,
                "end": end,
                "entity_group": "MODEL_ENTITY",
                "score": self.score,
            }
            for start, end in self.spans
        ]


class LocalContextBiomedicalNer:
    def __init__(self, disputed_text):
        self.disputed_text = disputed_text

    def __call__(self, text):
        if text != self.disputed_text:
            return []
        return [
            {
                "start": 0,
                "end": len(text),
                "entity_group": "MODEL_ENTITY",
                "score": 0.99,
            }
        ]


class RaisingNlp:
    def __call__(self, _text):
        raise RuntimeError("synthetic model failure")


class ModelLoadingStatusTests(unittest.TestCase):
    def tearDown(self):
        load_privacy_ner_model.cache_clear()
        load_biomedical_ner_model.cache_clear()

    def test_privacy_loader_reports_success_once(self):
        loaded_model = object()
        output = io.StringIO()
        load_privacy_ner_model.cache_clear()

        with (
            patch.dict(os.environ, {"AGENTIC_PII_SPACY_MODEL": "test_privacy_model"}),
            patch("spacy.load", return_value=loaded_model) as spacy_load,
            redirect_stdout(output),
        ):
            first_result = load_privacy_ner_model()
            second_result = load_privacy_ner_model()

        self.assertIs(first_result, loaded_model)
        self.assertIs(second_result, loaded_model)
        spacy_load.assert_called_once_with("test_privacy_model")
        self.assertEqual(output.getvalue().count("Privacy NER model loaded"), 1)

    def test_disabled_privacy_loader_reports_fallback(self):
        output = io.StringIO()
        load_privacy_ner_model.cache_clear()

        with (
            patch.dict(os.environ, {"AGENTIC_PII_SPACY_MODEL": ""}),
            redirect_stdout(output),
        ):
            result = load_privacy_ner_model()

        self.assertIsNone(result)
        self.assertIn("Privacy NER model is disabled", output.getvalue())
        self.assertIn("local format recognizers", output.getvalue())

    def test_biomedical_loader_reports_success_once(self):
        model_path = Path("/models/test-biomedical-ner")
        tokenizer = object()
        token_model = object()
        loaded_pipeline = object()
        fake_transformers = SimpleNamespace(
            AutoTokenizer=SimpleNamespace(from_pretrained=MagicMock(return_value=tokenizer)),
            AutoModelForTokenClassification=SimpleNamespace(
                from_pretrained=MagicMock(return_value=token_model)
            ),
            pipeline=MagicMock(return_value=loaded_pipeline),
        )
        output = io.StringIO()
        load_biomedical_ner_model.cache_clear()

        with (
            patch(
                "abbreviation_agent.get_biomedical_ner_model_path",
                return_value=model_path,
            ),
            patch.dict(sys.modules, {"transformers": fake_transformers}),
            redirect_stdout(output),
        ):
            first_result = load_biomedical_ner_model()
            second_result = load_biomedical_ner_model()

        self.assertIs(first_result, loaded_pipeline)
        self.assertIs(second_result, loaded_pipeline)
        self.assertEqual(output.getvalue().count("Biomedical NER model loaded"), 1)
        fake_transformers.pipeline.assert_called_once_with(
            "token-classification",
            model=token_model,
            tokenizer=tokenizer,
            aggregation_strategy="simple",
            device=-1,
        )

    def test_missing_biomedical_model_reports_safe_fallback(self):
        output = io.StringIO()
        load_biomedical_ner_model.cache_clear()

        with (
            patch("abbreviation_agent.get_biomedical_ner_model_path", return_value=None),
            redirect_stdout(output),
        ):
            result = load_biomedical_ner_model()

        self.assertIsNone(result)
        self.assertIn("Biomedical NER model is unavailable", output.getvalue())
        self.assertIn("privacy-safe masking", output.getvalue())


class PrivacyMaskingTests(unittest.TestCase):
    def test_clinical_span_is_protected_from_false_person_label(self):
        text = "A clinical concept was reviewed."
        start = text.index("clinical concept")
        end = start + len("clinical concept")
        privacy_nlp = FakeNlp([FakeEntity("clinical concept", "PERSON", start, end)])
        biomedical_nlp = FakeBiomedicalNer([(start, end)])

        with (
            patch("abbreviation_agent.load_privacy_ner_model", return_value=privacy_nlp),
            patch("abbreviation_agent.load_biomedical_ner_model", return_value=biomedical_nlp),
        ):
            masked = mask_pii_locally(text)

        self.assertEqual(masked, text)

    def test_unprotected_person_is_masked(self):
        text = "Example Person was reviewed."
        start = text.index("Example Person")
        end = start + len("Example Person")
        privacy_nlp = FakeNlp([FakeEntity("Example Person", "PERSON", start, end)])

        with (
            patch("abbreviation_agent.load_privacy_ner_model", return_value=privacy_nlp),
            patch("abbreviation_agent.load_biomedical_ner_model", return_value=None),
        ):
            masked = mask_pii_locally(text)

        self.assertEqual(masked, "[NAME] was reviewed.")

    def test_biomedical_model_protects_false_person_span(self):
        text = "A clinician documented Examplemed 650mg for a clinical reason."
        start = text.index("Examplemed 650")
        end = start + len("Examplemed 650")
        privacy_nlp = FakeNlp([FakeEntity("Examplemed 650", "PERSON", start, end)])
        biomedical_nlp = FakeBiomedicalNer([(start, text.index("mg") + len("mg"))])

        with (
            patch("abbreviation_agent.load_privacy_ner_model", return_value=privacy_nlp),
            patch("abbreviation_agent.load_biomedical_ner_model", return_value=biomedical_nlp),
        ):
            masked = mask_pii_locally(text)

        self.assertEqual(masked, text)

    def test_disputed_person_span_is_rechecked_in_local_model_context(self):
        text = "A long context contains Synthetic clinical measurement among other facts."
        disputed = "Synthetic clinical measurement"
        start = text.index(disputed)
        end = start + len(disputed)
        privacy_nlp = FakeNlp([FakeEntity(disputed, "PERSON", start, end)])
        biomedical_nlp = LocalContextBiomedicalNer(disputed)

        with (
            patch("abbreviation_agent.load_privacy_ner_model", return_value=privacy_nlp),
            patch("abbreviation_agent.load_biomedical_ner_model", return_value=biomedical_nlp),
        ):
            masked = mask_pii_locally(text)

        self.assertEqual(masked, text)

    def test_low_confidence_biomedical_prediction_does_not_expose_person(self):
        text = "Example Person was reviewed."
        start = text.index("Example Person")
        end = start + len("Example Person")
        privacy_nlp = FakeNlp([FakeEntity("Example Person", "PERSON", start, end)])
        biomedical_nlp = FakeBiomedicalNer([(start, end)], score=0.2)

        with (
            patch("abbreviation_agent.load_privacy_ner_model", return_value=privacy_nlp),
            patch("abbreviation_agent.load_biomedical_ner_model", return_value=biomedical_nlp),
        ):
            masked = mask_pii_locally(text)

        self.assertEqual(masked, "[NAME] was reviewed.")

    def test_biomedical_loader_failure_does_not_stop_masking(self):
        text = "Example Person was reviewed."
        start = text.index("Example Person")
        end = start + len("Example Person")
        privacy_nlp = FakeNlp([FakeEntity("Example Person", "PERSON", start, end)])

        with (
            patch("abbreviation_agent.load_privacy_ner_model", return_value=privacy_nlp),
            patch(
                "abbreviation_agent.load_biomedical_ner_model",
                side_effect=RuntimeError("synthetic loader failure"),
            ),
        ):
            masked = mask_pii_locally(text)

        self.assertEqual(masked, "[NAME] was reviewed.")

    def test_biomedical_inference_failure_does_not_stop_masking(self):
        text = "Example Person was reviewed."
        start = text.index("Example Person")
        end = start + len("Example Person")
        privacy_nlp = FakeNlp([FakeEntity("Example Person", "PERSON", start, end)])

        with (
            patch("abbreviation_agent.load_privacy_ner_model", return_value=privacy_nlp),
            patch("abbreviation_agent.load_biomedical_ner_model", return_value=RaisingNlp()),
        ):
            masked = mask_pii_locally(text)

        self.assertEqual(masked, "[NAME] was reviewed.")

    def test_privacy_inference_failure_uses_local_fallback(self):
        text = "Dr. Example Person reviewed the record."

        with (
            patch("abbreviation_agent.load_privacy_ner_model", return_value=RaisingNlp()),
            patch("abbreviation_agent.load_biomedical_ner_model", return_value=None),
        ):
            masked = mask_pii_locally(text)

        self.assertEqual(masked, "Dr. [NAME] reviewed the record.")

    def test_unknown_word_is_preserved_without_guessing(self):
        text = "The note contains qzxv without a known classification."

        with (
            patch("abbreviation_agent.load_privacy_ner_model", return_value=FakeNlp([])),
            patch("abbreviation_agent.load_biomedical_ner_model", return_value=FakeBiomedicalNer([])),
        ):
            masked = mask_pii_locally(text)

        self.assertEqual(masked, text)

    def test_person_followed_by_age_remains_masked(self):
        text = "Example Person is 45 years old."
        start = text.index("Example Person")
        end = start + len("Example Person")
        privacy_nlp = FakeNlp([FakeEntity("Example Person", "PERSON", start, end)])

        with (
            patch("abbreviation_agent.load_privacy_ner_model", return_value=privacy_nlp),
            patch("abbreviation_agent.load_biomedical_ner_model", return_value=None),
        ):
            masked = mask_pii_locally(text)

        self.assertEqual(masked, "[NAME] is 45 years old.")

    def test_organization_is_preserved_by_default(self):
        text = "Example Organization provides the plan."
        start = text.index("Example Organization")
        end = start + len("Example Organization")
        privacy_nlp = FakeNlp([FakeEntity("Example Organization", "ORG", start, end)])

        with (
            patch("abbreviation_agent.load_privacy_ner_model", return_value=privacy_nlp),
            patch("abbreviation_agent.load_biomedical_ner_model", return_value=None),
            patch.dict(os.environ, {}, clear=False),
        ):
            os.environ.pop("AGENTIC_PII_MASK_ORGANIZATIONS", None)
            masked = mask_pii_locally(text)

        self.assertEqual(masked, text)

    def test_strict_policy_can_mask_organization(self):
        text = "Example Organization provides the plan."
        start = text.index("Example Organization")
        end = start + len("Example Organization")
        privacy_nlp = FakeNlp([FakeEntity("Example Organization", "ORG", start, end)])

        with (
            patch("abbreviation_agent.load_privacy_ner_model", return_value=privacy_nlp),
            patch("abbreviation_agent.load_biomedical_ner_model", return_value=None),
            patch.dict(os.environ, {"AGENTIC_PII_MASK_ORGANIZATIONS": "true"}),
        ):
            masked = mask_pii_locally(text)

        self.assertEqual(masked, "[PII] provides the plan.")


if __name__ == "__main__":
    unittest.main()
