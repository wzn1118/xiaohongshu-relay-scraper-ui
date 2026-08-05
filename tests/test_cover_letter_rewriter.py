from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from cover_letter_rewriter import (
    _local_evidence_locked_result,
    _local_fact_rewrite_control,
    _local_review_floor_passes,
    build_cover_letter_rewrite_input,
    cover_letter_char_count,
    rewrite_cover_letter,
)


def fixture_record() -> dict:
    return {
        "title": "应聘成都内容运营实习生/剪辑实习生招继任｜王梓楠",
        "body": "内容运营实习负责选题策划、数据复盘，要求理解用户需求。",
        "application_info": {
            "role_name": "内容运营实习",
            "responsibilities": [
                {"text": "围绕目标用户完成内容选题与策划", "priority": 1},
                {"text": "跟踪发布数据并完成效果复盘", "priority": 2},
            ],
            "requirements": ["理解用户需求", "能够使用数据改进内容"],
        },
        "job_card": {"role_name": "内容运营实习"},
        "fit_evidence": [{
            "id": "content-project",
            "category": "project",
            "label": "内容研究项目",
            "detail": "我整理用户反馈并据此调整选题，随后复盘阅读和互动数据。",
            "first_person_claim": "我围绕用户反馈调整选题，并复盘阅读和互动数据。",
            "outcomes": ["形成可复用的选题复盘记录"],
        }],
    }


def valid_result() -> dict:
    responsibility_one = "针对内容选题与策划职责，我会先拆分目标用户、使用场景和信息需求，再形成可验证的选题假设。"
    responsibility_two = "针对发布数据复盘职责，我会预先定义观察指标，记录结果与预期的差异，并把结论转成下一轮内容调整。"
    sections = [
        "我申请内容运营实习岗位，是因为这项工作要求把用户理解、内容判断和结果验证连成连续的执行过程，并持续跟进发布后的变化。",
        "在内容研究项目中，我围绕真实用户反馈调整过选题，并持续复盘阅读与互动数据；这段经历让我形成了先确认问题、再设计表达、最后验证效果的工作习惯。",
        responsibility_one,
        "我会先梳理用户在不同场景下需要解决的问题，比较已有内容覆盖的空白，再明确每条内容希望推动的认知或行动。选题进入制作前，我会写清核心观点、证据来源、内容结构和验收标准，让后续协作有统一依据。",
        "进入具体制作环节后，我会根据渠道特征安排开头信息密度、叙事顺序和行动引导，同时保留版本记录，便于判断到底是哪项改动影响了结果。需要与设计或剪辑协作时，我会用目标用户、关键信息和交付时间组织需求，减少只凭感觉来回修改。",
        responsibility_two,
        "复盘时，我会把曝光、阅读、停留、互动或转化等可获得指标放回内容目标中解释，不用单一数字代替结论。如果表现低于预期，我会分别检查选题是否成立、标题是否准确、结构是否清晰、发布时机是否合适，并为下一轮只保留少量可验证变量。",
        "我也会把评论与私信中的高频问题整理成用户语言，和量化表现交叉判断。数据告诉我哪里发生变化，用户原话帮助我理解变化原因，两者结合后再决定继续放大、调整角度还是停止投入，这能避免为了追求短期波动而损害内容质量。",
        "对于岗位要求的用户理解，我会把它落实为持续更新的问题清单、内容假设和验证记录。已有证据能支持我在用户反馈与数据复盘上的实践；对于尚未发生的团队流程，我只会把上述做法作为入职后的执行计划，并在了解业务目标后再校准优先级。",
        "我希望进一步了解团队目前服务的核心用户、主要内容渠道和最需要改善的指标，也愿意用一项真实任务展示从需求拆解、选题策划、协作推进到效果复盘的完整过程。感谢您审阅我的申请，期待有机会继续沟通。",
    ]
    cover = "主题：内容运营实习申请｜用户洞察与数据复盘\n尊敬的招聘负责人：\n\n" + "\n\n".join(sections)
    while cover_letter_char_count(cover + "\n\n此致\n敬礼") < 850:
        cover += "\n\n我会把每次判断的依据、执行动作和结果变化记录下来，使经验能够被团队复用，也使后续优化可以被核验。"
    cover += "\n\n此致\n敬礼"
    evidence_sentence = sections[1]
    return {
        "email_subject": "内容运营实习申请｜用户洞察与数据复盘",
        "cover_letter": cover,
        "used_evidence_ids": ["content-project"],
        "evidence_coverage": [{
            "evidence_id": "content-project",
            "evidence_sentence": evidence_sentence,
        }],
        "responsibility_coverage": [
            {
                "responsibility_id": "responsibility-1",
                "responsibility": "围绕目标用户完成内容选题与策划",
                "response_sentence": responsibility_one,
                "evidence_ids": ["content-project"],
            },
            {
                "responsibility_id": "responsibility-2",
                "responsibility": "跟踪发布数据并完成效果复盘",
                "response_sentence": responsibility_two,
                "evidence_ids": ["content-project"],
            },
        ],
    }


def rich_candidate_profile() -> dict:
    evidence = [
        {
            "id": "resume-user-research",
            "category": "用户研究",
            "label": "基金会用户研究与直播活动",
            "source": "resume:ops:p1",
            "detail": "通过访谈和问卷收集 520 位用户反馈，归纳需求并策划活动，同时执行 25 场公开直播。",
        },
        {
            "id": "resume-community",
            "category": "社群运营",
            "label": "垂类达人社群与 KOL 共创",
            "source": "resume:mkt:p1",
            "detail": "从零搭建垂类达人社群，挖掘 30 余位 KOL 合作并组织内容共创。",
        },
        {
            "id": "resume-monitoring",
            "category": "数据分析",
            "label": "海外用户研究与自动化监测",
            "source": "resume:ops:p1",
            "detail": "围绕海外用户反馈和竞品分析搭建数据监测工具，并参与社区运营。",
        },
    ]
    return {
        "name": "示例用户",
        "school": "示例大学",
        "evidence_items": evidence,
        "profile_snapshot": {
            "profileSnapshotId": "profile-snapshot-resume-1",
            "evidence": evidence,
            "resumeArtifacts": [{"id": "resume-ops", "filename": "运营简历.pdf"}],
        },
    }


def rich_valid_result() -> dict:
    result = valid_result()
    research_sentence = "在基金会用户研究与直播活动中，我通过访谈和问卷收集 520 位用户反馈，归纳真实需求并据此策划活动，同时独立推进 25 场公开直播。"
    community_sentence = "在垂类达人社群与 KOL 共创经历中，我从零搭建达人社群，挖掘 30 余位 KOL 合作并组织内容共创，把用户洞察转成可协作的选题和内容交付。"
    result["cover_letter"] = result["cover_letter"].replace(
        "\n\n此致\n敬礼",
        f"\n\n{research_sentence}\n\n{community_sentence}\n\n此致\n敬礼",
    )
    result["used_evidence_ids"] = [
        "content-project",
        "resume-user-research",
        "resume-community",
    ]
    result["evidence_coverage"].extend([
        {"evidence_id": "resume-user-research", "evidence_sentence": research_sentence},
        {"evidence_id": "resume-community", "evidence_sentence": community_sentence},
    ])
    return result


class CapturingProvider:
    def __init__(self, results: list[dict]):
        self.results = list(results)
        self.calls: list[dict] = []

    def generate_json(self, system: str, user: str, schema: dict) -> dict:
        self.calls.append({"system": system, "payload": json.loads(user), "schema": schema})
        return self.results.pop(0)


class LocalCapturingProvider(CapturingProvider):
    provider = "local_qwen"

    def generate_text(self, system: str, user: str) -> str:
        self.calls.append({"system": system, "payload": json.loads(user), "schema": None})
        result = self.results.pop(0)
        if isinstance(result, dict):
            return str(result.get("cover_letter") or "")
        return str(result)


class CoverLetterRewriterTests(unittest.TestCase):
    def test_local_review_floor_relaxes_only_score(self) -> None:
        review = {
            "score": 84,
            "approved": True,
            "responsibility_coverage_complete": True,
            "evidence_grounded": True,
            "resume_experience_integrated": True,
            "personal_evidence_dominant": True,
            "instruction_followed": True,
            "signature_evidence_clear": True,
            "style_violation_count": 0,
        }

        self.assertTrue(_local_review_floor_passes(review, valid_result()))
        review["evidence_grounded"] = False
        self.assertFalse(_local_review_floor_passes(review, valid_result()))

    def test_input_carries_role_responsibilities_current_draft_and_exact_user_instruction(self) -> None:
        payload = build_cover_letter_rewrite_input(
            fixture_record(),
            {"cover_letter": "旧稿", "email_subject": "旧主题"},
            "更突出数据分析，并减少套话",
            {"name": "示例用户", "availabilityDays": "5"},
            {"channel": "email", "resumeAttached": True},
        )

        self.assertEqual(payload["role"]["role_name"], "内容运营实习")
        self.assertEqual(len(payload["role"]["responsibilities"]), 2)
        self.assertEqual(payload["current_draft"]["cover_letter"], "旧稿")
        self.assertEqual(payload["rewrite_request"]["user_instructions"], "更突出数据分析，并减少套话")
        self.assertEqual(payload["quality_contract"]["minimum_non_whitespace_characters"], 800)
        self.assertEqual(payload["candidate"]["evidence"][0]["id"], "content-project")

    def test_input_preserves_uploaded_resume_evidence_and_provenance(self) -> None:
        payload = build_cover_letter_rewrite_input(
            fixture_record(),
            {"cover_letter": "旧稿"},
            "结合我的个人经历",
            rich_candidate_profile(),
            {"channel": "email", "resumeAttached": True},
        )

        self.assertEqual(payload["candidate"]["profile_snapshot_id"], "profile-snapshot-resume-1")
        self.assertEqual(payload["candidate"]["resume_artifacts"][0]["id"], "resume-ops")
        self.assertIn("resume-user-research", payload["quality_contract"]["resume_evidence_ids"])
        self.assertEqual(payload["quality_contract"]["minimum_resume_evidence"], 2)
        self.assertTrue(payload["candidate"]["evidence"][1]["is_resume_evidence"])

    def test_input_reads_root_level_role_responsibilities(self) -> None:
        record = fixture_record()
        record["application_info"] = {"role_name": "内容运营实习"}
        record["responsibilities"] = ["负责短视频脚本、剪辑协作及多平台内容发布"]
        record["requirements"] = ["具备内容运营经验"]

        payload = build_cover_letter_rewrite_input(record, {}, "结合真实经历")

        self.assertEqual(payload["role"]["responsibilities"][0]["text"], "负责短视频脚本、剪辑协作及多平台内容发布")
        self.assertEqual(payload["role"]["requirements"][0]["text"], "具备内容运营经验")

    def test_input_infers_role_from_structured_recruitment_body_when_social_title_is_noise(self) -> None:
        payload = build_cover_letter_rewrite_input(
            {
                "title": "实习找继任",
                "body": (
                    "中信保诚资管有限公司 债权业务事业部实习生 8月底之前到岗 "
                    "【工作内容】1. 协助团队进行金融市场数据的收集、整理与分析；"
                    "【任职要求】金融、金融工程、数学、经济类相关专业。"
                ),
            },
            {},
            "结合岗位职责与候选人简历",
            {},
            {},
        )

        self.assertEqual(payload["role"]["role_name"], "债权业务事业部实习生")

    def test_quality_gate_rejects_generic_copy_when_resume_experience_is_available(self) -> None:
        provider = CapturingProvider([valid_result(), rich_valid_result()])

        result = rewrite_cover_letter(
            provider,
            fixture_record(),
            {"cover_letter": "旧稿"},
            "必须结合我的个人经历",
            rich_candidate_profile(),
        )

        self.assertEqual(result["attempts"], 2)
        errors = provider.calls[1]["payload"]["correction"]["validation_errors"]
        self.assertTrue(any("上传简历" in item for item in errors))
        self.assertIn("resume-user-research", result["used_evidence_ids"])
        self.assertIn("resume-community", result["used_evidence_ids"])

    def test_invalid_first_result_is_retried_with_validation_feedback(self) -> None:
        short = {
            "cover_letter": "主题：内容运营实习申请\n尊敬的招聘负责人：\n我想申请这个岗位。\n此致\n敬礼",
            "used_evidence_ids": [],
            "responsibility_coverage": [],
        }
        provider = CapturingProvider([short, valid_result()])

        result = rewrite_cover_letter(
            provider,
            fixture_record(),
            {"cover_letter": "旧稿"},
            "请突出数据复盘",
            {"name": "示例用户"},
            {"channel": "email"},
        )

        self.assertEqual(result["attempts"], 2)
        self.assertGreaterEqual(result["char_count"], 800)
        self.assertEqual(len(provider.calls), 2)
        self.assertEqual(provider.calls[0]["payload"]["rewrite_request"]["user_instructions"], "请突出数据复盘")
        self.assertTrue(provider.calls[1]["payload"]["correction"]["validation_errors"])
        self.assertIn("Signature Evidence", provider.calls[0]["system"])
        self.assertIn("完成初稿后不要立即输出。", provider.calls[0]["system"])
        self.assertIn("高级求职投递 Agent", provider.calls[0]["system"])

    def test_quality_gate_rejects_internal_evidence_token(self) -> None:
        leaked = valid_result()
        leaked["cover_letter"] = leaked["cover_letter"].replace(
            "\n\n",
            "\n\nexp_2022_xinhua ",
            1,
        )
        provider = CapturingProvider([leaked, valid_result()])

        result = rewrite_cover_letter(provider, fixture_record(), {}, "保持事实准确")

        self.assertEqual(result["attempts"], 2)
        errors = provider.calls[1]["payload"]["correction"]["validation_errors"]
        self.assertTrue(any("internal evidence identifier" in item for item in errors))

    def test_quality_gate_rejects_defensive_contrast_style(self) -> None:
        defensive = valid_result()
        defensive["cover_letter"] = defensive["cover_letter"].replace(
            "\n\n此致\n敬礼",
            "\n\n这项工作不是简单完成内容发布，而是建立持续优化闭环。\n\n此致\n敬礼",
        )
        provider = CapturingProvider([defensive, valid_result()])

        result = rewrite_cover_letter(provider, fixture_record(), {}, "表达直接，不要防御性句式")

        self.assertEqual(result["attempts"], 2)
        errors = provider.calls[1]["payload"]["correction"]["validation_errors"]
        self.assertTrue(any("防御性或对照式禁句" in item for item in errors))
        self.assertEqual(result["style_violation_count"], 0)

    def test_quality_gate_rejects_number_attached_to_wrong_resume_experience(self) -> None:
        invalid = rich_valid_result()
        invalid["cover_letter"] = invalid["cover_letter"].replace(
            "在垂类达人社群与 KOL 共创经历中，我从零搭建达人社群",
            "在垂类达人社群与 KOL 共创经历中，我独立执行 25 场直播并从零搭建达人社群",
        )
        provider = CapturingProvider([invalid, rich_valid_result()])

        result = rewrite_cover_letter(
            provider, fixture_record(), {}, "结合真实简历", rich_candidate_profile()
        )

        self.assertEqual(result["attempts"], 2)
        errors = provider.calls[1]["payload"]["correction"]["validation_errors"]
        self.assertTrue(any("数字 25 的经历归属错误" in item for item in errors))

    def test_quality_gate_rejects_action_merged_from_another_resume_experience(self) -> None:
        invalid = rich_valid_result()
        invalid["cover_letter"] = invalid["cover_letter"].replace(
            "在垂类达人社群与 KOL 共创经历中，我从零搭建达人社群",
            "在垂类达人社群与 KOL 共创经历中，我通过访谈理解需求并从零搭建达人社群",
        )
        provider = CapturingProvider([invalid, rich_valid_result()])

        result = rewrite_cover_letter(
            provider, fixture_record(), {}, "结合真实简历", rich_candidate_profile()
        )

        self.assertEqual(result["attempts"], 2)
        errors = provider.calls[1]["payload"]["correction"]["validation_errors"]
        self.assertTrue(any("把“访谈”拼接到了另一段经历" in item for item in errors))

    def test_quality_gate_rejects_unsupported_achievement_language(self) -> None:
        invalid = valid_result()
        invalid["cover_letter"] = invalid["cover_letter"].replace(
            "形成了先确认问题",
            "成功推动高质量内容交付，也形成了先确认问题",
        )
        provider = CapturingProvider([invalid, valid_result()])

        result = rewrite_cover_letter(provider, fixture_record(), {}, "只写真实成果")

        self.assertEqual(result["attempts"], 2)
        errors = provider.calls[1]["payload"]["correction"]["validation_errors"]
        self.assertTrue(any("未支持的成果或能力判断" in item for item in errors))

    def test_quality_gate_rejects_repeated_resume_experience_in_one_paragraph(self) -> None:
        invalid = rich_valid_result()
        repeated = invalid["evidence_coverage"][1]["evidence_sentence"]
        invalid["cover_letter"] = invalid["cover_letter"].replace(
            repeated,
            f"{repeated}{repeated}",
            1,
        )
        provider = CapturingProvider([invalid, rich_valid_result()])

        result = rewrite_cover_letter(
            provider,
            fixture_record(),
            {},
            "结合真实简历且不要重复经历",
            rich_candidate_profile(),
        )

        self.assertEqual(result["attempts"], 2)
        errors = provider.calls[1]["payload"]["correction"]["validation_errors"]
        self.assertTrue(any("同一段重复展开了候选人经历" in item for item in errors))

    def test_failed_quality_gate_returns_error_instead_of_generic_fallback(self) -> None:
        short = {
            "cover_letter": "主题：内容运营实习申请\n尊敬的招聘负责人：\n我想申请。\n此致\n敬礼",
            "used_evidence_ids": [],
            "responsibility_coverage": [],
        }
        provider = CapturingProvider([short, short])

        with self.assertRaisesRegex(ValueError, "未通过保存门槛"):
            rewrite_cover_letter(provider, fixture_record(), {}, "重写", max_attempts=2)

    def test_quality_gate_accepts_punctuation_only_sentence_differences(self) -> None:
        generated = valid_result()
        response_sentence = generated["responsibility_coverage"][0]["response_sentence"]
        punctuation_variant = response_sentence.replace("，", ",").replace("。", ".")
        generated["cover_letter"] = generated["cover_letter"].replace(
            response_sentence,
            punctuation_variant,
        )
        provider = CapturingProvider([generated])

        result = rewrite_cover_letter(provider, fixture_record(), {}, "重写")

        self.assertEqual(result["attempts"], 1)
        self.assertGreaterEqual(result["char_count"], 800)

    def test_advanced_model_structure_is_normalized_from_grounded_body(self) -> None:
        generated = rich_valid_result()
        generated["cover_letter"] = generated["cover_letter"].replace("主题：", "", 1)
        generated["used_evidence_ids"].remove("resume-community")
        generated["evidence_coverage"] = [
            item
            for item in generated["evidence_coverage"]
            if item["evidence_id"] != "resume-community"
        ]
        provider = CapturingProvider([generated])

        result = rewrite_cover_letter(
            provider,
            fixture_record(),
            {},
            "结合真实简历",
            rich_candidate_profile(),
        )

        self.assertEqual(result["attempts"], 1)
        self.assertTrue(result["cover_letter"].startswith("尊敬的招聘负责人："))
        self.assertEqual(result["email_subject"], "内容运营实习申请｜用户洞察与数据复盘")
        self.assertIn("resume-community", result["used_evidence_ids"])
        self.assertTrue(any(
            item["evidence_id"] == "resume-community"
            for item in result["evidence_coverage"]
        ))

    def test_structure_normalizer_repairs_punctuation_only_salutation_and_closing(self) -> None:
        generated = valid_result()
        generated["cover_letter"] = generated["cover_letter"].replace(
            "尊敬的招聘负责人：", "尊敬的招聘负责人，", 1
        ).replace("\n\n此致\n敬礼", "\n\n此致敬礼", 1)
        provider = CapturingProvider([generated])

        result = rewrite_cover_letter(provider, fixture_record(), {}, "重写")

        self.assertIn("尊敬的招聘负责人：", result["cover_letter"])
        self.assertNotRegex(result["cover_letter"], r"^\s*主题[：:]")
        self.assertTrue(result["cover_letter"].endswith("此致\n敬礼"))

    def test_local_model_runs_role_plan_write_and_quality_review(self) -> None:
        plan = {
            "role_summary": "招聘方需要能基于用户反馈完成内容策划与复盘的人。",
            "top_requirements": [
                {"requirement": "用户洞察", "priority": 1, "matched_evidence_ids": ["content-project"]},
                {"requirement": "数据复盘", "priority": 2, "matched_evidence_ids": ["content-project"]},
            ],
            "signature_evidence_ids": ["content-project"],
            "evidence_gaps": [],
            "narrative_strategy": "以用户反馈形成选题，再用数据复盘验证。",
            "positioning": "用用户反馈与数据复盘证明内容运营方法。",
            "evidence_priority": ["content-project"],
            "responsibility_plan": [
                {
                    "responsibility_id": "responsibility-1",
                    "response_angle": "用真实用户反馈形成选题假设。",
                    "evidence_ids": ["content-project"],
                    "fact_boundary": "只引用已提供的内容研究项目。",
                },
                {
                    "responsibility_id": "responsibility-2",
                    "response_angle": "说明数据复盘方法与下一轮调整。",
                    "evidence_ids": ["content-project"],
                    "fact_boundary": "不补造具体增长数字。",
                },
            ],
            "instruction_application": "重点展开数据复盘，删除套话。",
        }
        review = {
            "score": 94,
            "approved": True,
            "responsibility_coverage_complete": True,
            "evidence_grounded": True,
            "resume_experience_integrated": True,
            "personal_evidence_dominant": True,
            "instruction_followed": True,
            "signature_evidence_clear": True,
            "style_violation_count": 0,
            "strengths": ["职责与证据映射具体。"],
            "issues": [],
            "rewrite_instructions": [],
        }
        provider = LocalCapturingProvider([plan, valid_result(), review])

        result = rewrite_cover_letter(
            provider,
            fixture_record(),
            {"cover_letter": "旧稿"},
            "重点展开数据复盘，删除套话",
            {"name": "示例用户"},
            {"channel": "email"},
        )

        self.assertEqual(result["generation_strategy"], "local_plan_write_review")
        self.assertEqual(result["model_calls"], 3)
        self.assertEqual(result["review_score"], 94)
        self.assertEqual(len(provider.calls), 3)
        self.assertIn("local_role_evidence_plan", provider.calls[1]["payload"])
        self.assertEqual(provider.calls[1]["payload"]["local_role_evidence_plan"]["planning_gaps"], [])
        self.assertEqual(
            provider.calls[1]["payload"]["local_role_evidence_plan"]["signature_evidence_ids"],
            ["content-project"],
        )
        self.assertIn("Signature Evidence", provider.calls[1]["system"])
        self.assertIn("内部质量审核", provider.calls[1]["system"])
        self.assertNotIn("完成初稿后不要立即输出。", provider.calls[1]["system"])
        self.assertEqual(result["style_violation_count"], 0)

    def test_local_model_gets_targeted_length_repair_instead_of_equal_length_rewrite(self) -> None:
        plan = {
            "role_summary": "招聘方需要完成内容策划与效果复盘。",
            "top_requirements": [
                {"requirement": "用户洞察", "priority": 1, "matched_evidence_ids": ["content-project"]},
                {"requirement": "数据复盘", "priority": 2, "matched_evidence_ids": ["content-project"]},
            ],
            "signature_evidence_ids": ["content-project"],
            "evidence_gaps": [],
            "narrative_strategy": "以内容研究项目贯穿选题与复盘。",
            "positioning": "用用户反馈与数据复盘证明内容运营方法。",
            "evidence_priority": ["content-project"],
            "responsibility_plan": [
                {"responsibility_id": "responsibility-1", "response_angle": "用户反馈形成选题。", "evidence_ids": ["content-project"], "fact_boundary": "不补造数字。"},
                {"responsibility_id": "responsibility-2", "response_angle": "复盘数据并迭代。", "evidence_ids": ["content-project"], "fact_boundary": "不补造数字。"},
            ],
            "instruction_application": "重点写数据复盘。",
        }
        short = valid_result()
        short["cover_letter"] = short["cover_letter"][:760] + "\n\n此致\n敬礼"
        review = {
            "score": 95,
            "approved": True,
            "responsibility_coverage_complete": True,
            "evidence_grounded": True,
            "resume_experience_integrated": True,
            "personal_evidence_dominant": True,
            "instruction_followed": True,
            "signature_evidence_clear": True,
            "style_violation_count": 0,
            "strengths": ["岗位专属。"],
            "issues": [],
            "rewrite_instructions": [],
        }
        provider = LocalCapturingProvider([plan, short, valid_result(), review])

        result = rewrite_cover_letter(
            provider,
            fixture_record(),
            {"cover_letter": "旧稿"},
            "重点写数据复盘",
            max_attempts=2,
        )

        self.assertEqual(result["attempts"], 2)
        correction = provider.calls[2]["payload"]["correction"]
        self.assertLess(correction["current_non_whitespace_characters"], 800)
        self.assertGreaterEqual(correction["minimum_net_increase"], 80)
        self.assertEqual(correction["target_non_whitespace_characters"], 1200)
        self.assertIn("个人经历", correction["instruction"])

    def test_fact_error_forces_fresh_atomic_evidence_rewrite(self) -> None:
        payload = build_cover_letter_rewrite_input(
            fixture_record(),
            {"cover_letter": ""},
            "结合真实经历",
            {"evidence_items": [{
                "id": "resume-content",
                "label": "示例公司内容运营",
                "organization": "示例公司",
                "detail": "在示例公司访谈用户并输出选题方案。",
                "source": "resume:p1",
            }]},
            {},
        )
        plan = {"required_evidence_ids": ["resume-content"]}

        correction = _local_fact_rewrite_control(
            payload,
            plan,
            ["过往事实访谈缺少经历主体"],
            2,
        )

        self.assertEqual(correction["rewrite_mode"], "discard_rejected_draft_and_rewrite_from_scratch")
        self.assertEqual(correction["atomic_evidence_blocks"][0]["required_anchor"], "示例公司")
        self.assertNotIn("previous_result", correction)

    def test_evidence_locked_result_keeps_each_resume_fact_with_its_company(self) -> None:
        record = fixture_record()
        profile = {
            "name": "示例用户",
            "evidence_items": [
                {
                    "id": "resume-work-a",
                    "category": "完整简历经历",
                    "label": "甲公司工作经历",
                    "organization": "甲公司",
                    "detail": "候选人简历记载：访谈20位用户并输出3份选题方案；简历称完成10次内容复盘。",
                    "source": "resume:a",
                },
                {
                    "id": "resume-work-b",
                    "category": "完整简历经历",
                    "label": "乙公司工作经历",
                    "organization": "乙公司",
                    "detail": "候选人简历记载：制作12条短视频脚本；使用Excel整理6期发布数据。",
                    "source": "resume:b",
                },
                {
                    "id": "resume-work-c",
                    "category": "完整简历经历",
                    "label": "丙公司工作经历",
                    "organization": "丙公司",
                    "detail": "候选人简历记载：联动8位KOL并运营社群；协调产品和设计处理4项问题。",
                    "source": "resume:c",
                },
            ],
        }
        payload = build_cover_letter_rewrite_input(record, {}, "结合真实简历", profile, {})
        plan = {
            "required_evidence_ids": ["resume-work-a", "resume-work-b", "resume-work-c"],
            "responsibility_plan": [
                {"responsibility_id": "responsibility-1", "evidence_ids": ["resume-work-a"]},
                {"responsibility_id": "responsibility-2", "evidence_ids": ["resume-work-b"]},
            ],
        }

        result = _local_evidence_locked_result(payload, plan)
        body = result["cover_letter"]
        paragraphs = body.split("\n\n")

        self.assertTrue(any("甲公司" in value and "20位用户" in value and "10次" in value for value in paragraphs))
        self.assertTrue(any("乙公司" in value and "12条" in value and "6期" in value for value in paragraphs))
        self.assertTrue(any("丙公司" in value and "8位KOL" in value and "4项" in value for value in paragraphs))
        self.assertNotIn("简历称", body)
        self.assertNotIn("候选人简历记载", body)
        self.assertIn("甲公司、乙公司、丙公司", paragraphs[1])
        self.assertNotIn("玩家反馈与内容监测", body)
        self.assertNotIn("用户深访与达人共创", body)
        self.assertNotIn("直播话术与数据复盘", body)
        self.assertNotIn("我会把每次任务中的目标、动作、交付物和反馈分别记录下来", body)


if __name__ == "__main__":
    unittest.main()
