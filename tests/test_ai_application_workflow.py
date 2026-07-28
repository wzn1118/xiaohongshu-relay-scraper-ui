from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from ai_application_workflow import enrich_payload  # noqa: E402


class FakeProvider:
    provider = "test-provider"
    model = "fixture-model"

    def __init__(self) -> None:
        self.writer_calls = 0

    def generate_json(self, system, user, schema):
        required = set(schema.get("required", []))
        if "role_name" in required:
            return {
                "role_name": "增长运营实习",
                "responsibilities": [{"text": "分析活动数据并推动优化", "priority": 1}],
                "requirements": [{"text": "具备数据分析和跨团队协作能力", "priority": 1}],
                "application_routes": [{"type": "email", "value": "jobs@example.com"}],
                "capabilities": [{"id": "cap-1", "capability": "数据驱动运营", "why_it_matters": "支持增长决策", "priority": 5}],
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


class AiApplicationWorkflowTests(unittest.TestCase):
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
        self.assertNotIn("简历", record["outreach"]["cover_letter"])
        self.assertNotIn("附件", record["outreach"]["cover_letter"])
        for section in ("application_routes", "responsibilities", "requirements"):
            for item in record["application_info"][section]:
                self.assertEqual(item["source_field"], "body")
                self.assertIn("offset_start", item)
                self.assertIn("offset_end", item)
        self.assertTrue(payload["quality_gate"]["checks"]["all_cover_letters_score_at_least_threshold"])


if __name__ == "__main__":
    unittest.main()
