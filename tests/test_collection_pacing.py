import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "vendor" / "xiaohongshu-relay-scrape" / "scripts" / "collection_pacing.py"
SPEC = importlib.util.spec_from_file_location("collection_pacing", MODULE_PATH)
assert SPEC and SPEC.loader
collection_pacing = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = collection_pacing
SPEC.loader.exec_module(collection_pacing)


class CollectionPacingTests(unittest.TestCase):
    def test_steady_mode_returns_fixed_delay(self) -> None:
        self.assertEqual(collection_pacing.next_collection_delay("steady", 3.0, 0.8, 2.4), 3.0)

    def test_random_mode_uses_configured_bounds(self) -> None:
        with patch.object(collection_pacing._RANDOM, "uniform", return_value=1.7) as uniform:
            delay = collection_pacing.next_collection_delay("random", 1.2, 0.8, 2.4)
        self.assertEqual(delay, 1.7)
        uniform.assert_called_once_with(0.8, 2.4)

    def test_random_mode_rejects_reversed_bounds(self) -> None:
        with self.assertRaises(ValueError):
            collection_pacing.next_collection_delay("random", 1.2, 3.0, 2.0)


if __name__ == "__main__":
    unittest.main()
