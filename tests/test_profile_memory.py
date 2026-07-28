from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from profile_memory import schema


class ProfileMemorySchemaTests(unittest.TestCase):
    def test_schema_contains_candidate_application_fields(self):
        payload = schema()
        self.assertIn("candidate_application", payload["required"])
        candidate_application = payload["properties"]["candidate_application"]
        self.assertEqual(
            set(candidate_application["required"]),
            {
                "name",
                "school",
                "major",
                "degreeYear",
                "phoneWeChat",
                "email",
                "availabilityDays",
                "internshipDuration",
            },
        )


if __name__ == "__main__":
    unittest.main()
