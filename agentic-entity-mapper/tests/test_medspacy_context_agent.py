import io
import sys
import unittest
from contextlib import redirect_stdout
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

from medspacy_context_agent import enrich_mappings_with_medspacy


class FakeTargetRule:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


class FakeTargetMatcher:
    def add(self, *_args, **_kwargs):
        return None


class FakeContextPipeline:
    def __init__(self, *, inference_error=None):
        self.inference_error = inference_error

    def get_pipe(self, _name):
        return FakeTargetMatcher()

    def __call__(self, _text):
        if self.inference_error is not None:
            raise self.inference_error
        return SimpleNamespace(ents=[])


def fake_medspacy_modules(pipeline):
    medspacy_module = ModuleType("medspacy")
    medspacy_module.load = lambda: pipeline
    target_matcher_module = ModuleType("medspacy.target_matcher")
    target_matcher_module.TargetRule = FakeTargetRule
    return {
        "medspacy": medspacy_module,
        "medspacy.target_matcher": target_matcher_module,
    }


class MedspacyLoadingStatusTests(unittest.TestCase):
    def test_successful_pipeline_load_is_reported(self):
        mappings = [{"entity": "synthetic finding"}]
        output = io.StringIO()

        with (
            patch.dict(
                sys.modules,
                fake_medspacy_modules(FakeContextPipeline()),
            ),
            redirect_stdout(output),
        ):
            result, logs = enrich_mappings_with_medspacy("synthetic finding", mappings)

        self.assertEqual(len(result), 1)
        self.assertIn("Loading medspaCy context pipeline", output.getvalue())
        self.assertIn("medspaCy context pipeline loaded", output.getvalue())
        self.assertIn("medspaCy context pipeline loaded.", logs)

    def test_inference_failure_returns_original_mapping_and_reports_fallback(self):
        mappings = [{"entity": "synthetic finding"}]
        pipeline = FakeContextPipeline(
            inference_error=RuntimeError("synthetic inference failure")
        )
        output = io.StringIO()

        with (
            patch.dict(sys.modules, fake_medspacy_modules(pipeline)),
            redirect_stdout(output),
        ):
            result, logs = enrich_mappings_with_medspacy("synthetic finding", mappings)

        self.assertEqual(result, mappings)
        self.assertIn("medspaCy inference failed", output.getvalue())
        self.assertTrue(any("mappings were left unchanged" in message for message in logs))


if __name__ == "__main__":
    unittest.main()
