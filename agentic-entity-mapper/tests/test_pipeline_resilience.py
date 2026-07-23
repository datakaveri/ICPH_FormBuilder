import unittest

from pipeline_resilience import (
    run_mapping_stage_fail_soft,
    run_value_stage_fail_soft,
)


class PipelineResilienceTests(unittest.TestCase):
    def test_mapping_failure_restores_unmodified_input(self):
        mappings = [{"entity": "Synthetic input", "status": "original"}]

        def failing_stage(working_mappings):
            working_mappings[0]["status"] = "partially changed"
            working_mappings.append({"entity": "Partial output"})
            raise RuntimeError("synthetic stage failure")

        result, warning = run_mapping_stage_fail_soft(
            "Synthetic mapper",
            mappings,
            failing_stage,
        )

        self.assertEqual(result, mappings)
        self.assertEqual(mappings[0]["status"], "original")
        self.assertEqual(warning["stage"], "Synthetic mapper")

    def test_invalid_mapping_result_is_treated_as_stage_failure(self):
        mappings = [{"entity": "Synthetic input"}]
        result, warning = run_mapping_stage_fail_soft(
            "Synthetic mapper",
            mappings,
            lambda _: {"unexpected": "shape"},
        )

        self.assertEqual(result, mappings)
        self.assertEqual(warning["exception_type"], "TypeError")

    def test_value_stage_uses_fallback_without_raising(self):
        result, warning = run_value_stage_fail_soft(
            "Synthetic preprocessing",
            lambda: (_ for _ in ()).throw(OSError("synthetic resource failure")),
            lambda: "safe fallback",
            validator=lambda value: isinstance(value, str) and bool(value),
        )

        self.assertEqual(result, "safe fallback")
        self.assertEqual(warning["exception_type"], "OSError")


if __name__ == "__main__":
    unittest.main()
