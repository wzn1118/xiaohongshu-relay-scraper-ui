from __future__ import annotations

import json
import sys
import unittest
from difflib import SequenceMatcher
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from rewrite_cover_letter_batch import (  # noqa: E402
    _assemble_generated_item,
    _build_job,
    _compact_evidence,
    _compact_profile,
    _compact_profile_ascii,
    _normalize_result,
    _plain_cover_letter_request,
    _prompt_job,
    _schema,
)
from ai_application_workflow import _application_copy_source_hash, _normalize_application_context  # noqa: E402
from cover_letter_rewriter import build_cover_letter_rewrite_input  # noqa: E402


NOTE_ID = "6a7020c00000000005033be5"


def json_ascii(value: object) -> bool:
    return all(ord(character) < 128 for character in json.dumps(value, ensure_ascii=False))


def fixture_job() -> dict:
    return {
        "note_id": NOTE_ID,
        "candidate_name": "王梓楠",
        "role": {"role_name": "内容运营实习生"},
        "JOB_RESPONSIBILITIES": [{"text": "内容策划与数据复盘"}],
        "JOB_REQUIREMENTS": [{"text": "短视频剪辑"}],
        "allowed_evidence_ids": ["exp-1", "project-1"],
        "minimum_distinct_evidence": 2,
        "minimum_resume_evidence": 1,
        "resume_evidence_ids": ["exp-1", "project-1"],
        "source_hash": "a" * 64,
    }


def valid_result() -> dict:
    cover = (
        "尊敬的招聘负责人：\n"
        "我申请内容运营实习生岗位。我是王梓楠，以下说明我与岗位职责直接相关的经历。\n"
        + "我在真实项目中负责内容策划、素材整理、发布协同与数据复盘，并依据反馈调整后续内容。" * 24
        + "我每周可实习4天，可连续实习3个月，期待有机会进一步沟通岗位重点与工作安排。\n"
        "此致\n敬礼\n王梓楠"
    )
    return {
        "note_id": NOTE_ID,
        "greeting": "您好，我是王梓楠，想应聘内容运营实习生。我做过内容策划与数据复盘，希望方便进一步沟通岗位安排。",
        "email_subject": "任意主题",
        "email_body": (
            "您好，我是王梓楠，申请内容运营实习生岗位。我在真实项目中负责内容策划、素材整理和数据复盘，"
            "并根据反馈持续调整内容方向；相关经历可由简历中的项目记录核验。我每周可实习4天，可连续实习3个月，"
            "如果岗位仍在招聘，希望方便进一步沟通具体职责或安排面试，谢谢。"
        ),
        "cover_letter": cover,
        "used_evidence_ids": ["exp-1", "project-1"],
        "capability_matches": [
            "岗位职责：内容策划与数据复盘；证据 exp-1；可迁移价值：按反馈调整内容",
            "岗位职责：短视频剪辑；证据 project-1；可迁移价值：完成素材整理和发布协同",
        ],
        "evidence_coverage": [],
        "responsibility_coverage": [],
    }


class RewriteCoverLetterBatchTests(unittest.TestCase):
    def test_prepared_job_card_role_overrides_stale_application_placeholder(self) -> None:
        record = {
            "note_id": NOTE_ID,
            "title": "招聘内容运营实习生",
            "body": "招聘内容运营实习生，负责内容策划和数据复盘。",
            "job_card": {"role_name": "内容运营实习生"},
            "application_info": {
                "role_name": "当前岗位",
                "responsibilities": [{"text": "内容策划和数据复盘"}],
            },
            "fit_evidence": [
                {"id": "exp-1", "label": "真实项目", "detail": "完成内容策划和数据复盘"},
            ],
            "outreach": {},
        }

        job = _build_job({"record": record}, {"name": "王梓楠"}, "")

        self.assertEqual(job["TARGET_ROLE"], "内容运营实习生")
        self.assertEqual(job["role"]["role_name"], "内容运营实习生")

    def test_source_hash_includes_the_same_default_application_context_as_quality_recheck(self) -> None:
        record = {
            "note_id": NOTE_ID,
            "title": "内容运营实习生",
            "body": "招聘内容运营实习生，负责内容策划和复盘。",
            "application_info": {"responsibilities": [{"text": "内容策划和复盘"}]},
            "fit_evidence": [{"id": "exp-1", "label": "真实项目", "detail": "完成内容策划和数据复盘"}],
            "outreach": {},
        }
        profile = {"name": "王梓楠"}

        job = _build_job({"record": record}, profile, "")
        payload = build_cover_letter_rewrite_input(
            record,
            {"greeting": "", "email_subject": "", "email_body": "", "cover_letter": ""},
            "",
            profile,
            _normalize_application_context({}),
        )
        source_record = {**record, "applicationContext": _normalize_application_context({})}

        self.assertEqual(
            job["source_hash"],
            _application_copy_source_hash(source_record, profile, payload["candidate"]["evidence"]),
        )

    def test_plain_cover_request_is_ascii_and_compact(self) -> None:
        job = fixture_job()
        job.update({
            "ROLE_CAPABILITIES": [{"code": "content", "capability": "content strategy"}],
            "PROMPT_RESPONSIBILITIES": [{"id": "responsibility-1", "capability": "content planning"}],
            "PROMPT_EVIDENCE": [
                {"id": "exp-1", "fact": "Led a verified content project with measurable results."},
                {"id": "project-1", "fact": "Delivered a verified workflow and acceptance system."},
            ],
        })

        system, user = _plain_cover_letter_request(
            job,
            {"application_profile": {"name_marker": "CANDIDATE_NAME", "education": ["University"]}},
        )

        self.assertTrue(json_ascii(system))
        self.assertTrue(json_ascii(user))
        self.assertNotIn("response_format", user)
        self.assertIn("Candidate: CANDIDATE_NAME", user)
        self.assertIn("Target role: TARGET_ROLE", user)
        self.assertIn("five substantial paragraphs", system)
        self.assertLess(len(system) + len(user), 1_500)

    def test_assembles_local_contract_around_generated_cover_letter(self) -> None:
        job = fixture_job()
        job.update({
            "TARGET_ROLE": job["role"]["role_name"],
            "ROLE_CAPABILITIES": [{"code": "content", "capability": "content strategy"}],
            "JOB_RESPONSIBILITIES": [{"id": "responsibility-1", "text": "内容策划与数据复盘"}],
        })

        assembled = _assemble_generated_item(job, valid_result()["cover_letter"])
        normalized = _normalize_result(assembled, {NOTE_ID: job})

        self.assertIsNotNone(normalized)
        assert normalized is not None
        self.assertEqual(normalized["used_evidence_ids"], ["exp-1", "project-1"])
        self.assertIn("exp-1", normalized["capability_matches"][0])
        self.assertGreaterEqual(len(normalized["email_body"]), 120)
        self.assertLessEqual(len(normalized["email_body"]), 260)
        self.assertNotIn("附件", normalized["email_body"])
        self.assertNotIn("随信", normalized["email_body"])
        self.assertNotIn("也能用于推进", normalized["email_body"])

    def test_assembled_emails_use_role_specific_generated_evidence(self) -> None:
        first_job = fixture_job()
        first_job.update({
            "TARGET_ROLE": "内容运营实习生",
            "ROLE_CAPABILITIES": [{"code": "content", "capability": "content strategy"}],
        })
        second_job = {
            **first_job,
            "note_id": "note-data-role",
            "TARGET_ROLE": "数据分析实习生",
            "role": {"role_name": "数据分析实习生"},
            "JOB_RESPONSIBILITIES": [{"text": "搭建业务指标并复盘转化效果"}],
            "ROLE_CAPABILITIES": [{"code": "data_analysis", "capability": "data analysis"}],
        }
        first_cover = valid_result()["cover_letter"]
        second_cover = first_cover.replace(
            "我在真实项目中负责内容策划、素材整理、发布协同与数据复盘",
            "我通过真实项目搭建指标口径、分析转化数据并交付复盘报告",
        )

        first = _assemble_generated_item(first_job, first_cover)["email_body"]
        second = _assemble_generated_item(second_job, second_cover)["email_body"]

        self.assertIn("内容策划、素材整理", first)
        self.assertIn("搭建指标口径", second)
        self.assertLess(SequenceMatcher(None, first, second).ratio(), 0.82)

    def test_assembled_email_removes_source_headings_and_applicant_meta_narration(self) -> None:
        job = fixture_job()
        job.update({
            "TARGET_ROLE": "内容推荐实习生",
            "role": {"role_name": "内容推荐实习生"},
            "JOB_RESPONSIBILITIES": [{
                "text": "【岗位名称】爱奇艺 - TV端内容推荐实习生 【Base 地点】北京 📌 核心工作职责 -参与内容推荐产品设计工作",
            }],
            "ROLE_CAPABILITIES": [{"code": "content", "capability": "content strategy"}],
        })
        cover = valid_result()["cover_letter"].replace(
            "我在真实项目中负责",
            "这样的职责要求候选人能够负责",
        )

        assembled = _assemble_generated_item(job, cover)
        normalized = _normalize_result(assembled, {NOTE_ID: job})

        self.assertIsNotNone(normalized)
        assert normalized is not None
        visible = "\n".join(normalized[field] for field in ("email_body", "cover_letter"))
        self.assertNotIn("参与内容推荐产品设计工作", normalized["email_body"])
        self.assertNotIn("岗位名称", visible)
        self.assertNotIn("Base 地点", visible)
        self.assertNotIn("候选人", visible)
        self.assertIn("任职者", normalized["cover_letter"])

    def test_assembled_email_excludes_cohort_and_submission_instructions(self) -> None:
        job = fixture_job()
        job.update({
            "TARGET_ROLE": "用户研究相关实习",
            "role": {"role_name": "用户研究相关实习"},
            "JOB_RESPONSIBILITIES": [{
                "text": "希望是28届及以后的同学，可私信我要投递邮箱，或直接发我简历图片，以下是岗位描述⬇",
            }],
            "ROLE_CAPABILITIES": [{"code": "user_research", "capability": "user research"}],
        })

        assembled = _assemble_generated_item(job, valid_result()["cover_letter"])

        self.assertNotIn("28", assembled["email_body"])
        self.assertNotIn("私信", assembled["email_body"])
        self.assertNotIn("投递邮箱", assembled["email_body"])
        self.assertIn("用户研究与需求洞察", assembled["email_body"])

    def test_compacts_profile_to_sendable_candidate_facts(self) -> None:
        compact = _compact_profile({
            "display_name": "不应作为姓名",
            "candidate_application": {
                "name": "王梓楠",
                "school": "曼彻斯特大学",
                "major": "全球发展",
                "availabilityDays": "每周4天",
                "internshipDuration": "3个月",
            },
            "summary": "求职定位" * 100,
            "sourceFiles": ["private-resume.pdf"],
        })

        self.assertEqual(compact["name"], "王梓楠")
        self.assertNotIn("sourceFiles", compact)
        self.assertNotIn("summary", compact)

    def test_provider_profile_uses_ascii_facts_and_local_markers(self) -> None:
        compact = _compact_profile_ascii({
            "candidate_application": {
                "name": "王梓楠",
                "school": "曼彻斯特大学",
                "major": "全球发展",
                "degreeYear": "硕士在读，预计2026年毕业",
            },
        })

        self.assertEqual(compact["name_marker"], "CANDIDATE_NAME")
        self.assertIn("University of Manchester", compact["education"])
        self.assertIn("Global Development", compact["education"])
        self.assertTrue(json_ascii(compact))

    def test_provider_job_excludes_raw_chinese_local_fields(self) -> None:
        job = fixture_job()
        job.update({
            "TARGET_ROLE": "内容运营实习生",
            "candidate_name": "王梓楠",
            "ROLE_CAPABILITIES": [{"code": "content", "capability": "content strategy"}],
            "PROMPT_RESPONSIBILITIES": [{"id": "responsibility-1", "capability": "content strategy"}],
            "PROMPT_REQUIREMENTS": [{"id": "requirement-1", "capability": "data analysis"}],
            "PROMPT_EVIDENCE": [{"id": "exp-1", "fact": "Led a grounded content project.", "is_resume_evidence": True}],
            "required_responsibility_ids": ["responsibility-1"],
        })

        prompt_job = _prompt_job(job)

        self.assertEqual(prompt_job["target_role_marker"], "TARGET_ROLE")
        self.assertNotIn("candidate_name", prompt_job)
        self.assertNotIn("source_hash", prompt_job)
        self.assertTrue(json_ascii(prompt_job))

    def test_selects_job_fit_evidence_without_lowering_minimums(self) -> None:
        evidence = [
            {"id": f"exp-{index}", "label": f"经历{index}", "detail": "真实行动和结果" * 100}
            for index in range(1, 9)
        ]
        record = {
            "fit_evidence": [
                {"id": "exp-3", "label": "匹配经历3", "detail": "岗位相关证据" * 100},
                {"id": "exp-1", "label": "匹配经历1", "detail": "岗位相关证据" * 100},
                {"id": "exp-2", "label": "匹配经历2", "detail": "岗位相关证据" * 100},
            ]
        }
        contract = {
            "allowed_evidence_ids": [value["id"] for value in evidence],
            "resume_evidence_ids": ["exp-1", "exp-2", "exp-3", "exp-4"],
            "minimum_distinct_evidence": 3,
            "minimum_resume_evidence": 2,
        }

        compact = _compact_evidence(record, evidence, contract)

        self.assertEqual([value["id"] for value in compact], ["exp-3", "exp-1", "exp-2"])
        self.assertGreaterEqual(sum(value["is_resume_evidence"] for value in compact), 2)
        self.assertTrue(all(len(value["detail"]) <= 180 for value in compact))

    def test_prioritizes_evidence_aligned_with_role_over_weak_fit_tail(self) -> None:
        evidence = [
            {"id": "ai-product", "label": "AI 产品项目", "detail": "负责 AI 产品需求、Agent 流程和产品迭代"},
            {"id": "user-ops", "label": "用户运营", "detail": "负责用户运营和数据分析"},
            {"id": "marketing", "label": "市场营销", "detail": "参与市场营销工作"},
            {"id": "automation", "label": "自动化项目", "detail": "交付 AI 自动化工作流和前后端开发"},
        ]
        record = {"fit_evidence": evidence[:3]}
        contract = {
            "allowed_evidence_ids": [value["id"] for value in evidence],
            "resume_evidence_ids": [value["id"] for value in evidence],
            "minimum_distinct_evidence": 3,
            "minimum_resume_evidence": 2,
        }
        role = {
            "role_name": "AI 产品经理",
            "responsibilities": [{"text": "负责 AI 产品需求分析和 Agent 工作流迭代"}],
            "requirements": [],
        }

        compact = _compact_evidence(record, evidence, contract, role)

        selected = [value["id"] for value in compact]
        self.assertEqual(selected[:2], ["ai-product", "automation"])
        self.assertNotIn("marketing", selected)

    def test_capability_matches_bind_every_selected_evidence_to_role_signal(self) -> None:
        job = fixture_job()
        job.update({
            "TARGET_ROLE": "AI 产品经理",
            "role": {"role_name": "AI 产品经理"},
            "JOB_RESPONSIBILITIES": [{"id": "r1", "text": "负责 AI 产品需求与 Agent 工作流迭代"}],
            "ROLE_CAPABILITIES": [{"code": "ai_product", "capability": "AI product design"}],
            "EVIDENCE": [
                {"id": "exp-1", "label": "AI 产品项目", "detail": "负责 AI 产品需求和 Agent 工作流"},
                {"id": "project-1", "label": "自动化项目", "detail": "交付 AI 自动化流程"},
            ],
            "EVIDENCE_ROLE_GROUPS": {
                "exp-1": ["product", "engineering_automation"],
                "project-1": ["engineering_automation"],
            },
        })

        assembled = _assemble_generated_item(job, valid_result()["cover_letter"])

        self.assertEqual(len(assembled["capability_matches"]), 2)
        self.assertTrue(all(
            evidence_id in assembled["capability_matches"][index]
            for index, evidence_id in enumerate(job["allowed_evidence_ids"])
        ))
        self.assertTrue(all("AI" in value for value in assembled["capability_matches"]))

    def test_schema_requires_complete_outreach_and_capability_mapping(self) -> None:
        required = set(_schema(1)["properties"]["items"]["items"]["required"])
        self.assertTrue({
            "greeting", "email_subject", "email_body", "cover_letter",
            "used_evidence_ids", "capability_matches",
        }.issubset(required))

    def test_normalizes_complete_quality_gate_result(self) -> None:
        normalized = _normalize_result(valid_result(), {NOTE_ID: fixture_job()})

        self.assertIsNotNone(normalized)
        assert normalized is not None
        self.assertEqual(normalized["email_subject"], "应聘内容运营实习生｜王梓楠")
        self.assertEqual(normalized["used_evidence_ids"], ["exp-1", "project-1"])
        self.assertEqual(len(normalized["capability_matches"]), 2)
        self.assertEqual(normalized["source_hash"], "a" * 64)
        self.assertGreaterEqual(normalized["char_count"], 800)
        self.assertLessEqual(normalized["char_count"], 1600)

    def test_restores_verified_local_role_and_candidate_markers(self) -> None:
        result = valid_result()
        result["greeting"] = result["greeting"].replace("王梓楠", "CANDIDATE_NAME").replace("内容运营实习生", "TARGET_ROLE")
        result["email_body"] = result["email_body"].replace("王梓楠", "CANDIDATE_NAME").replace("内容运营实习生", "TARGET_ROLE")
        result["cover_letter"] = result["cover_letter"].replace("王梓楠", "CANDIDATE_NAME").replace("内容运营实习生", "TARGET_ROLE")
        result["capability_matches"] = [
            value.replace("内容运营实习生", "TARGET_ROLE") for value in result["capability_matches"]
        ]

        normalized = _normalize_result(result, {NOTE_ID: fixture_job()})

        self.assertIsNotNone(normalized)
        assert normalized is not None
        self.assertIn("王梓楠", normalized["cover_letter"])
        self.assertIn("内容运营实习生", normalized["greeting"])
        self.assertNotIn("CANDIDATE_NAME", normalized["cover_letter"])
        self.assertNotIn("TARGET_ROLE", normalized["email_body"])

    def test_replaces_generic_role_placeholder_and_ai_cliches_locally(self) -> None:
        result = valid_result()
        for field in ("greeting", "email_body", "cover_letter"):
            result[field] = (
                result[field]
                .replace("内容运营实习生", "当前岗位")
                .replace("数据复盘", "数据闭环")
            )

        normalized = _normalize_result(result, {NOTE_ID: fixture_job()})

        self.assertIsNotNone(normalized)
        assert normalized is not None
        human_text = "\n".join(
            normalized[field]
            for field in ("greeting", "email_subject", "email_body", "cover_letter")
        )
        self.assertNotIn("当前岗位", human_text)
        self.assertNotIn("闭环", human_text)
        self.assertIn("内容运营实习生", human_text)
        self.assertIn("完整推进", human_text)

    def test_rejects_result_without_required_resume_evidence(self) -> None:
        result = valid_result()
        result["used_evidence_ids"] = ["not-allowed"]

        self.assertIsNone(_normalize_result(result, {NOTE_ID: fixture_job()}))

    def test_rejects_unbound_capability_mapping(self) -> None:
        result = valid_result()
        result["capability_matches"] = ["岗位职责：内容策划；可迁移价值：按反馈调整内容"]
        rejected: list[dict] = []

        self.assertIsNone(_normalize_result(result, {NOTE_ID: fixture_job()}, rejected))
        self.assertIn("证据 ID", rejected[0]["problems"][0])


if __name__ == "__main__":
    unittest.main()
