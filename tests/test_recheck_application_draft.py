from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import recheck_application_draft as recheck  # noqa: E402
import ai_application_workflow as workflow  # noqa: E402


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
            "email_body": (
                "Hello, I am applying for the Data intern role. In my SQL project, I built a report "
                "from the available data and documented the analysis clearly for review. I would "
                "welcome an interview to discuss how I could support the team's data work."
            ),
            "cover_letter": "Subject: Data intern\nDear hiring manager,\nI used SQL in a project.",
        },
        "candidateProfile": {"name": "Candidate"},
        "threshold": 90,
    }


class RecheckApplicationDraftTests(unittest.TestCase):
    def test_next_step_rule_is_shared_by_deterministic_and_human_quality_checks(self) -> None:
        message = "\u671f\u5f85\u5c31\u5c97\u4f4d\u5f53\u524d\u4efb\u52a1\u3001\u534f\u4f5c\u8282\u594f\u548c\u6210\u679c\u6807\u51c6\u8fdb\u4e00\u6b65\u4ea4\u6d41\uff0c\u8c22\u8c22\u3002"
        self.assertTrue(workflow._has_clear_communication_next_step(message))

        draft = {
            "greeting": "\u60a8\u597d\uff0c\u6211\u662f\u5019\u9009\u4eba\u3002",
            "email_subject": "\u5e94\u8058\u6570\u636e\u5b9e\u4e60\u751f",
            "email_body": message,
            "cover_letter": "\u60a8\u597d\uff0c\u6211\u662f\u5019\u9009\u4eba\u3002",
            "used_evidence_ids": [],
        }
        dimensions = workflow._human_quality_dimensions(draft, {}, [], {})
        self.assertTrue(dimensions["call_to_action"]["passed"])

        problems = recheck._deterministic_problems(draft, {}, [], {})
        self.assertFalse(any("\u6c9f\u901a\u4e0b\u4e00\u6b65" in problem for problem in problems))

    def test_explicit_source_subject_format_can_name_role_in_greeting(self) -> None:
        role = recheck._role_from_record({
            "title": "产品与用户运营实习生",
            "body": "邮件主题格式：学校+姓名。招聘产品与用户运营实习生。",
            "job_card": {"role_name": "产品与用户运营实习生"},
            "application_info": {},
        })
        draft = {
            "greeting": "您好，我想申请产品与用户运营实习生岗位。",
            "email_subject": "曼彻斯特大学+王梓楠",
            "email_body": "",
            "cover_letter": "",
            "used_evidence_ids": [],
        }

        dimensions = recheck._human_quality_dimensions(draft, role, [], {})

        self.assertTrue(role["subject_rule_detected"])
        self.assertNotIn("主题没有准确点名当前岗位", dimensions["relevance"]["problems"])

    def test_normalizes_social_post_title_before_quality_role_matching(self) -> None:
        role = recheck._role_from_record({
            "title": "成都内容运营实习生/剪辑实习生招继任",
            "application_info": {},
            "job_card": {},
        })

        self.assertEqual(role["role_name"], "内容运营实习生/剪辑实习生")

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
            "threshold", "passed", "attempt", "attempts", "human_quality",
            "sourceHash", "sourceHashStatus", "sourceReviewRequired",
            "legacySourceHashInferred",
        }.issubset(report))
        self.assertEqual(set(report["human_quality"]), {
            "factual_grounding", "specificity", "relevance", "naturalness", "brevity",
            "tone", "repetition", "attachment_consistency", "call_to_action", "ai_cliche_score",
        })
        for dimension in report["human_quality"].values():
            self.assertEqual(set(dimension), {
                "score", "passed", "problems", "evidence", "suggestedFix",
            })
            self.assertIsInstance(dimension["score"], int)
            self.assertIsInstance(dimension["passed"], bool)
            self.assertIsInstance(dimension["problems"], list)
            self.assertIsInstance(dimension["evidence"], list)
            self.assertIsInstance(dimension["suggestedFix"], str)
        self.assertEqual(len(report["sourceHash"]), 64)
        self.assertEqual(report["sourceHashStatus"], "legacy_inferred")
        self.assertFalse(report["sourceReviewRequired"])
        self.assertTrue(report["legacySourceHashInferred"])
        self.assertEqual(report["claim_validation"]["schemaVersion"], 1)

    def test_preserves_structured_profile_evidence_for_claim_validation(self) -> None:
        payload = fixture_payload()
        payload["candidateProfile"] = {
            "name": " Candidate ",
            "experiences": [{
                "id": "exp-1",
                "organization": "Example Lab",
                "title": "Data project",
                "results": ["Built a report"],
            }],
        }
        captured = {}

        def validate(record, profile=None, candidate_profile=None, draft=None):
            captured.update({
                "record": record,
                "profile": profile,
                "candidate_profile": candidate_profile,
                "draft": draft,
            })
            return {
                "schemaVersion": 1,
                "status": "passed",
                "hardFactsPassed": True,
                "sendable": True,
                "counts": {"total": 0, "valid": 0, "failed": 0, "needsHumanReview": 0},
                "sourceBindings": [],
                "claims": [],
                "legacyEvidenceIdsPreserved": True,
            }

        def evaluate(_provider, _role, evidence, _draft, _candidate_profile):
            captured["evaluation_evidence"] = evidence
            return {
                "score": 94,
                "rubric": recheck._rubric_for_score(94),
                "strengths": ["Grounded"],
                "problems": [],
                "rewrite_instructions": [],
            }

        with patch.object(recheck, "_evaluate", side_effect=evaluate), patch.object(
            recheck, "_deterministic_problems", return_value=[]
        ), patch.object(recheck, "validate_generated_claims", side_effect=validate):
            report = recheck.evaluate_payload(payload, FakeProvider)

        self.assertTrue(report["passed"])
        self.assertEqual(captured["profile"]["name"], "Candidate")
        self.assertIsInstance(captured["profile"]["experiences"], list)
        self.assertEqual(captured["profile"]["experiences"][0]["id"], "exp-1")
        self.assertIsInstance(captured["candidate_profile"]["experiences"], list)
        evaluated_ids = {item["id"] for item in captured["evaluation_evidence"]}
        self.assertEqual(evaluated_ids, {"evidence-1", "exp-1"})

    def test_attachment_mismatch_fails_quality_gate_without_rewriting_draft(self) -> None:
        payload = fixture_payload()
        payload["draft"]["email_body"] = (
            "My resume is attached. I used SQL in a project and would welcome an interview."
        )
        payload["attachmentContext"] = {"attachments": []}
        original = copy.deepcopy(payload)
        evaluation = {
            "score": 94,
            "rubric": recheck._rubric_for_score(94),
            "strengths": ["Grounded"],
            "problems": [],
            "rewrite_instructions": [],
        }

        with patch.object(recheck, "_evaluate", return_value=evaluation), patch.object(
            recheck, "_deterministic_problems", return_value=[]
        ):
            report = recheck.evaluate_payload(payload, FakeProvider)

        self.assertEqual(payload, original)
        self.assertEqual(report["score"], 89)
        self.assertFalse(report["passed"])
        attachment = report["human_quality"]["attachment_consistency"]
        self.assertFalse(attachment["passed"])
        self.assertTrue(any("没有选择附件" in problem for problem in attachment["problems"]))
        self.assertTrue(any("没有选择附件" in problem for problem in report["problems"]))

    def test_changed_source_marks_old_draft_for_review_without_rewriting_it(self) -> None:
        payload = fixture_payload()
        payload["record"]["outreach"]["sourceHash"] = "0" * 64
        original_draft = copy.deepcopy(payload["draft"])
        evaluation = {
            "score": 96,
            "rubric": recheck._rubric_for_score(96),
            "strengths": ["Grounded"],
            "problems": [],
            "rewrite_instructions": [],
        }

        with patch.object(recheck, "_evaluate", return_value=evaluation), patch.object(
            recheck, "_deterministic_problems", return_value=[]
        ):
            report = recheck.evaluate_payload(payload, FakeProvider)

        self.assertEqual(payload["draft"], original_draft)
        self.assertEqual(report["score"], 89)
        self.assertEqual(report["sourceHashStatus"], "changed")
        self.assertTrue(report["sourceReviewRequired"])
        self.assertFalse(report["legacySourceHashInferred"])
        self.assertFalse(report["passed"])
        self.assertTrue(any("证据已变化" in problem for problem in report["problems"]))

    def test_content_bound_generation_source_hash_supersedes_legacy_record_hash(self) -> None:
        payload = fixture_payload()
        payload["record"]["outreach"]["sourceHash"] = "0" * 64
        evidence = recheck._candidate_evidence(payload["record"], payload["candidateProfile"])
        payload["sourceHash"] = recheck._application_copy_source_hash(
            payload["record"], payload["candidateProfile"], evidence
        )
        evaluation = {
            "score": 96,
            "rubric": recheck._rubric_for_score(96),
            "strengths": ["Grounded"],
            "problems": [],
            "rewrite_instructions": [],
        }

        with patch.object(recheck, "_evaluate", return_value=evaluation), patch.object(
            recheck, "_deterministic_problems", return_value=[]
        ):
            report = recheck.evaluate_payload(payload, FakeProvider)

        self.assertEqual(report["sourceHashStatus"], "current")
        self.assertFalse(report["sourceReviewRequired"])
        self.assertTrue(report["passed"])

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

    def test_deterministic_strict_mode_skips_provider_and_keeps_fact_gate(self) -> None:
        payload = fixture_payload()
        payload["evaluationMode"] = "deterministic_strict"
        claim_report = {
            "schemaVersion": 1,
            "status": "passed",
            "hardFactsPassed": True,
            "sendable": True,
            "counts": {"total": 0, "valid": 0, "failed": 0, "needsHumanReview": 0},
            "sourceBindings": [],
            "claims": [],
            "legacyEvidenceIdsPreserved": True,
        }

        with patch.object(recheck, "_evaluate", side_effect=AssertionError("provider must not run")), patch.object(
            recheck, "_deterministic_problems", return_value=[]
        ), patch.object(
            recheck, "_human_quality_dimensions", return_value={}
        ), patch.object(
            recheck, "validate_generated_claims", return_value=claim_report
        ):
            report = recheck.evaluate_payload(payload, FakeProvider)

        self.assertEqual(report["evaluationMode"], "deterministic_strict")
        self.assertEqual(report["score"], 100)
        self.assertTrue(report["passed"])

    def test_deterministic_strict_mode_caps_score_when_fact_gate_fails(self) -> None:
        payload = fixture_payload()
        payload["evaluationMode"] = "deterministic_strict"
        claim_report = {
            "schemaVersion": 1,
            "status": "failed",
            "hardFactsPassed": False,
            "sendable": False,
            "counts": {"total": 1, "valid": 0, "failed": 1, "needsHumanReview": 0},
            "sourceBindings": [],
            "claims": [{"text": "unsupported metric", "validationStatus": "failed"}],
            "legacyEvidenceIdsPreserved": True,
        }

        with patch.object(recheck, "_evaluate", side_effect=AssertionError("provider must not run")), patch.object(
            recheck, "_deterministic_problems", return_value=[]
        ), patch.object(
            recheck, "_human_quality_dimensions", return_value={}
        ), patch.object(
            recheck, "validate_generated_claims", return_value=claim_report
        ):
            report = recheck.evaluate_payload(payload, FakeProvider)

        self.assertEqual(report["score"], 89)
        self.assertFalse(report["passed"])
        self.assertTrue(any("事实" in problem for problem in report["problems"]))

    def test_rejects_missing_record_or_draft(self) -> None:
        with self.assertRaisesRegex(ValueError, "record and draft"):
            recheck.evaluate_payload({"record": {}}, FakeProvider)


if __name__ == "__main__":
    unittest.main()
