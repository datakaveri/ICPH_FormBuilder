import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cache


class AutomaticCacheNamespaceTests(unittest.TestCase):
    def setUp(self):
        self.original_signature = cache._source_namespace_signature
        self.original_value = cache._source_namespace_value

    def tearDown(self):
        cache._source_namespace_signature = self.original_signature
        cache._source_namespace_value = self.original_value

    def test_source_edit_changes_namespace_without_manual_version(self):
        project_root = Path(cache.__file__).resolve().parent
        with tempfile.TemporaryDirectory(dir=project_root) as directory:
            source = Path(directory) / "agent.py"
            source.write_text("first", encoding="utf-8")
            with patch.object(cache, "_cache_source_paths", return_value=[source]):
                cache._source_namespace_signature = None
                cache._source_namespace_value = None
                before = cache._automatic_source_namespace()
                source.write_text("second version", encoding="utf-8")
                after = cache._automatic_source_namespace()

        self.assertNotEqual(before, after)

    def test_runtime_configuration_changes_namespace(self):
        with patch.dict(os.environ, {"LLM_MODEL": "model-a"}):
            before = cache._cache_namespace()
        with patch.dict(os.environ, {"LLM_MODEL": "model-b"}):
            after = cache._cache_namespace()

        self.assertNotEqual(before, after)
