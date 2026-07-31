from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import recheck_application_draft as recheck  # noqa: E402


class FakeProvider:
    provider = "fixture"


def fixture_payload() -> dict:
    return {
        "record": {
            "title": "Data intern",
            "body": "Hiring a data intern. Apply by email.",
            "job_card": {"role_name": "Data intern"},
            "application_info": {
                "responsibilities": [{"text": "Analyze data", "priority": 1}],
                "requirements": [{"text": "Use SQL", "priority": 1}],
                "application_routes": [
                    {"type": "email", "value": "jobs@example.test", "channel": "email"},
                ],
            },
            "job_capabilities": [{"id": "cap-1", "capability": "Analysis"}],
            "fit_evidence": [{"id": "evidence-1", "label": "SQL project", "detail": "Built a report"}],
            "outreach": {
                "used_evidence_ids": ["evidence-1"],
                "capability_matches": ["cap-1"],
            },
        },
        "draft": {
            "greeting": "Hello, I am Candidate.",
            "email_subject": "Application for Data intern",
            "email_body": "I used SQL in a project and would welcome an interview.",
            "cover_letter": "Subject: Data intern\nDear hiring manager,\nI used SQL in a project.",
        },
        "candidateProfile": {"name": "Candidate"},
        "threshold": 90,
    }


class RecheckApplicationDraftTests(unittest.TestCase):
    def test_rechecks_without_mutating_or_rewriting_the_draft(self) -> None:
        payload = fixture_payload()
        original = copy.deepcopy(payload)
        captured = {}

        def evaluate(_provider, role, evidence, draft, candidate_profile):
            captured.update({
                "role": role,
                "evidence": evidence,
                "draft": draft,
                "candidate_profile": candidate_profile,
            })
            return {
                "score": 94,
                "rubric": recheck._rubric_for_score(94),
                "strengths": ["Grounded"],
                "problems": [],
                "rewrite_instructions": [],
            }

        with patch.object(recheck, "_evaluate", side_effect=evaluate), patch.object(
            recheck, "_deterministic_problems", return_value=[]
        ):
            report = recheck.evaluate_payload(payload, FakeProvider)

        self.assertEqual(payload, original)
        self.assertEqual(captured["role"]["role_name"], "Data intern")
        self.assertEqual(captured["evidence"][0]["id"], "evidence-1")
        self.assertEqual(captured["draft"]["used_evidence_ids"], ["evidence-1"])
        self.assertEqual(captured["draft"]["email_body"], payload["draft"]["email_body"])
        self.assertEqual(captured["candidate_profile"], {"name": "Candidate"})
        self.assertEqual(report["score"], 94)
        self.assertTrue(report["passed"])
        self.assertTrue({
            "score", "rubric", "strengths", "problems", "rewrite_instructions",
            "threshold", "passed", "attempt", "attempts",
        }.issubset(report))
        self.assertEqual(report["claim_validation"]["schemaVersion"], 1)

    def test_deterministic_problem_caps_score_and_rebuilds_rubric(self) -> None:
        evaluation = {
            "score": 98,
            "rubric": recheck._rubric_for_score(98),
            "strengths": ["Fluent"],
            "problems": ["Model issue"],
            "rewrite_instructions": [],
        }
        with patch.object(recheck, "_evaluate", return_value=evaluation), patch.object(
            recheck, "_deterministic_problems", return_value=["Grounding issue"]
        ):
            report = recheck.evaluate_payload(fixture_payload(), FakeProvider)

        self.assertEqual(report["score"], 89)
        self.assertEqual(sum(report["rubric"].values()), 89)
        self.assertFalse(report["passed"])
        self.assertEqual(report["problems"], ["Model issue", "Grounding issue"])
        self.assertEqual(report["rewrite_instructions"], ["Grounding issue"])

    def test_threshold_never_drops_below_existing_gate(self) -> None:
        payload = fixture_payload()
        payload["threshold"] = 75
        with patch.object(recheck, "_evaluate", return_value={
            "score": 88,
            "rubric": recheck._rubric_for_score(88),
            "strengths": [],
            "problems": [],
            "rewrite_instructions": [],
        }), patch.object(recheck, "_deterministic_problems", return_value=[]):
            report = recheck.evaluate_payload(payload, FakeProvider)

        self.assertEqual(report["threshold"], 90)
        self.assertFalse(report["passed"])

        payload["threshold"] = 95
        with patch.object(recheck, "_evaluate", return_value={
            "score": 94,
            "rubric": recheck._rubric_for_score(94),
            "strengths": [],
            "problems": [],
            "rewrite_instructions": [],
        }), patch.object(recheck, "_deterministic_problems", return_value=[]):
            report = recheck.evaluate_payload(payload, FakeProvider)
        self.assertEqual(report["threshold"], 95)
        self.assertFalse(report["passed"])

    def test_rejects_missing_record_or_draft(self) -> None:
        with self.assertRaisesRegex(ValueError, "record and draft"):
            recheck.evaluate_payload({"record": {}}, FakeProvider)


if __name__ == "__main__":
    unittest.main()
