import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from scripts.migrate_application_outreach import build_audit, collect_records


class ApplicationMigrationTests(unittest.TestCase):
    def test_collect_records_deduplicates_and_prefers_full_body(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "job-a" / "application_intelligence.json"
            second = root / "job-b" / "application_intelligence.json"
            first.parent.mkdir(parents=True)
            second.parent.mkdir(parents=True)
            first.write_text(json.dumps({"records": [{"note_id": "n1", "title": "role"}]}, ensure_ascii=False), encoding="utf-8")
            second.write_text(json.dumps({"records": [{"note_id": "n1", "title": "role", "body": "full body"}, {"note_id": "n2", "body": "second"}]}, ensure_ascii=False), encoding="utf-8")

            records, files, raw_count = collect_records(root, root / "output")

            self.assertEqual(raw_count, 3)
            self.assertEqual(len(files), 2)
            self.assertEqual({item["note_id"] for item in records}, {"n1", "n2"})
            self.assertEqual(next(item for item in records if item["note_id"] == "n1")["body"], "full body")

    def test_audit_reports_copy_change_and_quality(self):
        old = [{"note_id": "n1", "title": "role", "outreach": {"cover_letter": "old", "email_subject": "old subject"}}]
        new = [{"note_id": "n1", "title": "role", "outreach": {"cover_letter": "new copy", "email_subject": "new subject", "content_quality": {"batch_ready": True}, "used_evidence_ids": ["e1"]}}]

        audit = build_audit(old, new)

        self.assertEqual(audit["counts"], {"old": 1, "new": 1, "updated": 1, "ready": 1, "blocked": 0})
        self.assertEqual(audit["changes"][0]["change_type"], "updated")
        self.assertEqual(audit["changes"][0]["used_evidence_ids"], ["e1"])


if __name__ == "__main__":
    unittest.main()
