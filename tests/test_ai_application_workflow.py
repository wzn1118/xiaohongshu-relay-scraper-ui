from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from ai_application_workflow import _merge_feedback, enrich_payload  # noqa: E402


class FakeProvider:
    provider = "test-provider"
    model = "fixture-model"

    def __init__(self) -> None:
        self.writer_calls = 0
        self.last_request_used_images = False

    def generate_json(self, system, user, schema, image_urls=None):
        required = set(schema.get("required", []))
        if "role_name" in required:
            self.last_request_used_images = bool(image_urls)
            return {
                "role_name": "增长运营实习",
                "responsibilities": [{"text": "分析活动数据并推动优化", "priority": 1}],
                "requirements": [{"text": "具备数据分析和跨团队协作能力", "priority": 1}],
                "application_routes": [{"type": "email", "value": "jobs@example.com", "channel": "email", "confidence": 100}],
                "capabilities": [{"id": "cap-1", "capability": "数据驱动运营", "why_it_matters": "支持增长决策", "priority": 5}],
                "image_analysis": {
                    "status": "analyzed" if image_urls else "unavailable",
                    "summary": "海报标注数据分析岗位" if image_urls else "",
                    "job_signals": ["数据分析"] if image_urls else [],
                },
            }
        if "used_evidence_ids" in required:
            self.writer_calls += 1
            if self.writer_calls == 1:
                return {
                    "greeting": "您好，附件是我的简历。",
                    "email_subject": "增长运营实习申请",
                    "email_body": "您好，附件是我的简历。",
                    "cover_letter": "附件是我的简历。",
                    "used_evidence_ids": ["project-1"],
                    "capability_matches": ["cap-1"],
                }
            cover = (
                "我曾负责校园活动的用户调研与数据复盘，从访谈记录和转化数据中定位关键流失环节，"
                "再与内容和执行成员共同调整触达节奏。这个过程中，我把分散信息整理成可跟进的指标，"
                "并依据结果迭代方案，也形成了从问题拆解、数据验证到协同落地的完整工作方式。\n\n"
                "我能够把同样的方法用于增长任务：先明确目标与衡量口径，再持续追踪反馈，及时把分析"
                "转化为可执行动作。我重视事实边界和沟通效率，会主动同步假设、进度与风险，让团队能够"
                "快速判断下一步。期待进一步交流我能如何支持实际项目。"
            )
            return {
                "greeting": "您好，我有数据复盘与跨团队推进经验，希望进一步沟通增长运营实习。",
                "email_subject": "增长运营实习申请",
                "email_body": "您好，我曾通过用户调研和转化数据定位问题，并协同团队推动方案迭代。期待进一步沟通我能为增长项目提供的支持。",
                "cover_letter": cover,
                "used_evidence_ids": ["project-1"],
                "capability_matches": ["cap-1"],
            }
        return {
            "score": 94,
            "rubric": {
                "role_relevance": 24,
                "evidence": 23,
                "first_person": 15,
                "concision": 14,
                "credibility": 9,
                "action_readiness": 9,
            },
            "strengths": ["证据具体"],
            "problems": [],
            "rewrite_instructions": [],
        }


class FailingProvider(FakeProvider):
    def generate_json(self, system, user, schema, image_urls=None):
        raise ValueError("invalid model output")


class AiApplicationWorkflowTests(unittest.TestCase):
    def test_reviewer_feedback_accumulates_without_duplicates(self) -> None:
        self.assertEqual(
            _merge_feedback(["补充岗位判断", "压缩案例"], ["压缩案例", " 写清交付物  "]),
            ["补充岗位判断", "压缩案例", "写清交付物"],
        )

    def test_reviewer_feedback_keeps_recent_bounded_context(self) -> None:
        self.assertEqual(
            _merge_feedback(["旧要求1", "旧要求2"], ["新要求1", "新要求2"], limit=3),
            ["旧要求2", "新要求1", "新要求2"],
        )

    def test_low_quality_first_draft_is_rewritten_until_threshold(self) -> None:
        payload = {
            "quality_gate": {"passed": True, "checks": {}, "issues": []},
            "records": [{"title": "增长运营实习", "body": "负责增长分析与协作推进。"}],
        }
        profile = {
            "projects": [{
                "id": "project-1",
                "title": "校园活动增长",
                "organization": "学生团队",
                "actions": ["开展用户调研", "复盘转化数据", "协同团队迭代方案"],
                "results": [],
                "skills": ["数据分析", "协作"],
            }],
        }
        provider = FakeProvider()

        report = enrich_payload(payload, profile, threshold=90, max_attempts=3, provider=provider)

        record = payload["records"][0]
        self.assertEqual(report.passed, 1)
        self.assertEqual(provider.writer_calls, 2)
        self.assertEqual(record["cover_letter_evaluation"]["score"], 94)
        self.assertEqual(record["cover_letter_evaluation"]["attempts"], 2)
        self.assertEqual(record["application_info"]["application_routes"][0]["channel"], "email")
        self.assertEqual(record["application_info"]["application_routes"][0]["confidence"], 100)
        self.assertNotIn("简历", record["outreach"]["cover_letter"])
        self.assertNotIn("附件", record["outreach"]["cover_letter"])
        for section in ("application_routes", "responsibilities", "requirements"):
            for item in record["application_info"][section]:
                self.assertEqual(item["source_field"], "body")
                self.assertIn("offset_start", item)
                self.assertIn("offset_end", item)
        self.assertTrue(payload["quality_gate"]["checks"]["all_cover_letters_score_at_least_threshold"])

    def test_image_only_record_still_gets_image_enriched_job_card(self) -> None:
        payload = {
            "quality_gate": {"passed": True, "checks": {}, "issues": []},
            "records": [{
                "note_id": "image-only",
                "title": "招聘海报",
                "body": "",
                "media": {
                    "images": [{"url": "https://img.example/job.jpg", "alt": "数据分析实习", "source": "detail"}],
                },
            }],
        }
        profile = {"projects": []}

        report = enrich_payload(payload, profile, threshold=90, max_attempts=1, provider=FakeProvider())

        record = payload["records"][0]
        self.assertEqual(report.processed, 1)
        self.assertEqual(record["job_card"]["enrichment_status"], "image_enriched")
        self.assertTrue(record["job_card"]["image_context_used"])
        self.assertEqual(record["media"]["analysis"]["source"], "vision_model")
        self.assertEqual(record["application_info"]["responsibilities"][0]["source_field"], "image")
        self.assertEqual(record["outreach"]["runtime_status"], "fallback_missing_job_body")

    def test_failed_quality_issue_uses_exporter_check_contract(self) -> None:
        payload = {
            "quality_gate": {"passed": True, "checks": {}, "issues": []},
            "records": [{"title": "增长运营实习", "body": "负责增长分析与协作推进。"}],
        }
        profile = {
            "projects": [{
                "id": "project-1",
                "title": "校园活动增长",
                "organization": "学生团队",
                "actions": ["开展用户调研", "复盘转化数据"],
                "results": [],
                "skills": ["数据分析"],
            }],
        }

        report = enrich_payload(payload, profile, threshold=95, max_attempts=2, provider=FakeProvider())

        self.assertEqual(report.failed, 1)
        self.assertEqual(
            payload["quality_gate"]["issues"][-1]["check"],
            "all_cover_letters_score_at_least_threshold",
        )

    def test_every_scraped_record_is_processed_even_without_application_signal(self) -> None:
        payload = {
            "quality_gate": {"passed": True, "checks": {}, "issues": []},
            "records": [
                {"title": "数据分析实习招聘", "body": "招聘数据分析实习生，请投递邮箱 jobs@example.com"},
                {"title": "实习复盘", "body": "记录今天学习数据透视表的心得。"},
            ],
        }
        profile = {
            "projects": [{
                "id": "project-1",
                "title": "校园活动增长",
                "organization": "学生团队",
                "actions": ["开展用户调研", "复盘转化数据", "协同团队迭代方案"],
                "results": [],
                "skills": ["数据分析", "协作"],
            }],
        }

        report = enrich_payload(
            payload,
            profile,
            threshold=90,
            max_attempts=3,
            provider=FakeProvider(),
            require_application_signal=True,
        )

        self.assertEqual(report.processed, 2)
        self.assertEqual(report.skipped, 0)
        self.assertEqual(payload["records"][1]["ai_triage"]["status"], "processed")
        for record in payload["records"]:
            self.assertEqual(record["job_card"]["status"], "generated")
            self.assertTrue(record["quality"]["job_card_generated"])
            self.assertTrue(record["quality"]["outreach_generated"])
            self.assertTrue(all(record["outreach"][field] for field in ("greeting", "email_subject", "email_body", "cover_letter")))
        self.assertEqual(payload["ai_workflow"]["generationCoveragePercent"], 100.0)

    def test_progress_callback_and_per_record_model_failure_are_isolated(self) -> None:
        payload = {
            "quality_gate": {"passed": True, "checks": {}, "issues": []},
            "records": [{"title": "数据分析实习招聘", "body": "招聘实习生，请投递 jobs@example.com"}],
        }
        events = []

        report = enrich_payload(
            payload,
            {"projects": []},
            provider=FailingProvider(),
            require_application_signal=True,
            progress_callback=lambda current, total, status, record: events.append((current, total, status)),
        )

        self.assertEqual(report.processed, 1)
        self.assertEqual(report.failed, 1)
        self.assertEqual(events, [(1, 1, "failed")])
        record = payload["records"][0]
        self.assertEqual(record["outreach"]["runtime_status"], "fallback_model_error")
        self.assertEqual(record["job_card"]["status"], "generated")
        self.assertTrue(record["quality"]["outreach_generated"])
        self.assertTrue(all(record["outreach"][field] for field in ("greeting", "email_subject", "email_body", "cover_letter")))

    def test_missing_body_uses_search_card_and_still_generates_copy(self) -> None:
        payload = {
            "quality_gate": {"passed": True, "checks": {}, "issues": []},
            "records": [{
                "note_id": "card-only-1",
                "title": "数据分析实习",
                "source_card_text": "数据分析实习，负责报表整理，每周到岗五天",
                "body": "",
                "access_status": "detail_timeout",
            }],
        }
        provider = FakeProvider()

        report = enrich_payload(payload, {"projects": []}, provider=provider)

        record = payload["records"][0]
        self.assertEqual(report.processed, 1)
        self.assertEqual(report.skipped, 0)
        self.assertEqual(provider.writer_calls, 0)
        self.assertEqual(record["ai_triage"]["status"], "fallback_missing_job_body")
        self.assertEqual(record["job_card"]["parse_basis"], "search_card")
        self.assertTrue(record["application_info"]["responsibilities"])
        self.assertTrue(record["quality"]["outreach_generated"])
        self.assertEqual(payload["ai_workflow"]["jobCardsGenerated"], 1)
        self.assertEqual(payload["ai_workflow"]["applicationCopyGenerated"], 1)


if __name__ == "__main__":
    unittest.main()
