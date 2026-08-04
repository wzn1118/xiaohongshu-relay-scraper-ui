from __future__ import annotations

import unittest

from scripts.codex_runtime_outreach import (
    CodexRuntimeOutreachAgent,
    _output_schema,
    _prompt,
    _record_input,
)


class CodexRuntimePromptTests(unittest.TestCase):
    def setUp(self) -> None:
        self.agent = object.__new__(CodexRuntimeOutreachAgent)
        self.agent.builtin_provider = None
        self.source = {
            "note_id": "n1",
            "title": "数据分析实习",
            "responsibilities": ["分析用户数据并输出报告"],
            "requirements": ["熟悉 Python"],
            "candidate_evidence": [
                {
                    "id": "e1",
                    "label": "用户数据分析项目",
                    "detail": "使用 Python 清洗用户数据并输出分析报告",
                    "first_person_claim": "我使用 Python 清洗用户数据并输出分析报告",
                }
            ],
        }

    def _valid_output(self) -> dict[str, object]:
        return {
            "note_id": "n1",
            "greeting": "您好，我是张三，想应聘「数据分析实习」。我曾使用 Python 清洗用户数据并输出分析报告。请问岗位目前是否仍在招聘？",
            "email_subject": "数据分析实习申请｜张三｜Python 数据分析",
            "email_body": (
                "尊敬的招聘负责人：\n"
                "您好！我是张三，希望申请数据分析实习。\n"
                "我曾使用 Python 清洗用户数据并输出分析报告，这段经历对应岗位的用户数据分析与报告交付。\n"
                "期待进一步沟通岗位当前的数据任务。"
            ),
            "cover_letter": (
                "主题：数据分析实习申请｜张三｜Python 数据分析\n"
                "尊敬的招聘负责人：\n"
                "您好！我是张三，希望申请数据分析实习。\n\n"
                "我曾使用 Python 清洗用户数据并输出分析报告，过程中先整理数据口径，再检查异常信息，最后把分析结果整理成可阅读的报告。这段经历让我形成了从问题拆解、数据处理到结论表达的完整工作习惯，也与岗位需要分析用户数据并输出报告的职责直接对应。\n\n"
                "如果有机会加入，我会先确认团队对指标和报告的判断口径，再从具体任务开始核验数据、记录过程并及时同步结论，确保交付内容能够服务后续讨论。期待进一步了解岗位当前最需要推进的工作。\n\n"
                "此致\n敬礼！\n"
                "姓名：张三"
            ),
            "used_evidence_ids": ["e1"],
            "requirement_matches": [
                "分析用户数据并输出报告 -> e1 -> 使用 Python 清洗用户数据并输出分析报告"
            ],
        }

    def _ai_product_source(self) -> dict[str, object]:
        return {
            "note_id": "n1",
            "title": "美团 AI产品运营",
            "responsibilities": [
                "负责数据分析产品 BA Agent 的日常运营，统筹拉新、留存、召回",
                "分析用户 query 与高频场景，维护案例库并监控产品核心指标",
            ],
            "requirements": ["熟练使用 AI 工具辅助工作"],
            "candidate_evidence": [
                {
                    "id": "e_ai",
                    "role_axis": "ai_product",
                    "label": "Asteria 数据分析交付系统",
                    "detail": "从0到1搭建Asteria数据分析交付系统，统一7类输入、6类场景和3层报告输出",
                    "first_person_claim": "我从0到1搭建Asteria数据分析交付系统，统一7类输入、6类场景和3层报告输出",
                },
                {
                    "id": "e_insight",
                    "role_axis": "user_insight",
                    "label": "用户洞察与策略转化",
                    "detail": "开展1v1深访并沉淀4类核心用户需求与场景，将洞察转化为内容策略",
                    "first_person_claim": "我开展1v1深访并沉淀4类核心用户需求与场景，将洞察转化为内容策略",
                },
            ],
        }

    def _valid_ai_product_output(self) -> dict[str, object]:
        return {
            "note_id": "n1",
            "greeting": (
                "您好，我是张三，想应聘美团 AI产品运营。我曾从0到1搭建Asteria数据分析交付系统，"
                "并把多类输入与场景纳入统一产品链路。请问 BA Agent 岗位目前是否仍在招聘？"
            ),
            "email_subject": "美团 AI产品运营申请｜张三｜AI 产品建设与用户洞察",
            "email_body": (
                "尊敬的招聘负责人：\n您好！我是张三，希望申请美团 AI产品运营。"
                "我曾从0到1搭建Asteria数据分析交付系统，统一7类输入、6类场景和3层报告输出；"
                "也通过1v1深访沉淀4类用户需求与场景，并将洞察转化为内容策略。"
                "这些实践能支持我围绕 BA Agent 的用户 query、案例沉淀与数据复盘推进运营。期待进一步沟通。"
            ),
            "cover_letter": (
                "主题：美团 AI产品运营申请｜张三｜AI 产品建设与用户洞察\n"
                "尊敬的招聘负责人：\n"
                "您好！我是张三，希望申请美团 AI产品运营。对 BA Agent 而言，运营不只是拉新或组织活动，"
                "更需要把用户使用信号持续反馈到产品判断中。\n\n"
                "我曾从0到1搭建Asteria数据分析交付系统，将分散分析纳入统一产品链路，统一7类输入、6类场景和3层报告输出；"
                "也开展1v1深访，沉淀4类核心用户需求与场景，并将洞察转化为内容策略。两段实践共同证明，"
                "我能从真实问题中建立分类，再把结论变成可执行、可复用的产品与运营结构，而不是停留在信息收集。\n\n"
                "如果加入，我会从用户 query 与反馈入手，识别痛点和高频场景，据此维护案例库、判断运营优先级并设计运营动作；"
                "随后观察用户数、活跃、留存与召回等核心指标，通过实验验证、复盘和迭代，把结果继续反馈到 BA Agent 的场景建设与运营策略中。"
                "期待进一步沟通团队当前最需要验证的用户场景。\n\n"
                "此致\n敬礼！\n姓名：张三"
            ),
            "used_evidence_ids": ["e_ai", "e_insight"],
            "requirement_matches": [
                "BA Agent 产品运营与数据驱动 -> e_ai -> 搭建Asteria系统并统一7类输入、6类场景和3层报告输出",
                "分析用户 query 与高频场景 -> e_insight -> 1v1深访并沉淀4类核心用户需求与场景",
            ],
        }

    def test_prompt_requires_matrix_and_does_not_offer_copyable_placeholders(self) -> None:
        prompt = _prompt(
            [
                {
                    **self.source,
                    "candidate_evidence": [
                        {
                            **self.source["candidate_evidence"][0],
                            "matched_terms": ["Python", "用户数据"],
                        }
                    ],
                }
            ],
            "张三",
            {"name": "张三", "availabilityDays": "5", "internshipDuration": "6个月"},
        )

        self.assertIn("阶段 2｜匹配矩阵", prompt)
        self.assertIn("岗位能力点 -> evidence id -> 证据中的具体动作/对象/结果", prompt)
        self.assertIn("first_person_claim", prompt)
        self.assertIn("AI 产品工作机制", prompt)
        self.assertIn("query/用户反馈 -> 痛点与场景分类", prompt)
        self.assertIn("禁止按经历逐段罗列", prompt)
        self.assertIn("在市场营销实习期间", prompt)
        self.assertIn("证据段必须从可核验动作或项目对象起笔", prompt)
        self.assertNotIn("我是学校、专业、年级/学历学生姓名", prompt)
        self.assertNotIn("目前我每周可实习可用天数天", prompt)

    def test_record_input_preserves_evidence_skills_and_outcomes(self) -> None:
        normalized = _record_input({
            "note_id": "n1",
            "title": "数据分析实习",
            "application_info": {},
            "fit_evidence": [{
                **self.source["candidate_evidence"][0],
                "skills": ["Python", "数据清洗"],
                "outcomes": ["输出用户分析报告"],
                "role_axis": "ai_product",
            }],
        })

        evidence = normalized["candidate_evidence"][0]
        self.assertEqual(evidence["skills"], ["Python", "数据清洗"])
        self.assertEqual(evidence["outcomes"], ["输出用户分析报告"])
        self.assertEqual(evidence["role_axis"], "ai_product")

    def test_output_schema_matches_runtime_length_contract(self) -> None:
        properties = _output_schema()["properties"]["items"]["items"]["properties"]

        self.assertEqual((properties["greeting"]["minLength"], properties["greeting"]["maxLength"]), (30, 180))
        self.assertEqual((properties["email_body"]["minLength"], properties["email_body"]["maxLength"]), (80, 300))
        self.assertEqual((properties["cover_letter"]["minLength"], properties["cover_letter"]["maxLength"]), (280, 520))
        self.assertEqual(properties["used_evidence_ids"]["maxItems"], 2)
        self.assertTrue(properties["used_evidence_ids"]["uniqueItems"])

    def test_output_schema_can_constrain_runtime_ids_to_exact_input_values(self) -> None:
        schema = _output_schema(note_ids=["n1"], evidence_ids=["evidence-full-id"])
        properties = schema["properties"]["items"]["items"]["properties"]

        self.assertEqual(properties["note_id"]["enum"], ["n1"])
        self.assertEqual(properties["used_evidence_ids"]["items"]["enum"], ["evidence-full-id"])

    def test_record_input_strips_social_post_prefix_from_role_title(self) -> None:
        normalized = _record_input({
            "note_id": "n1",
            "title": "给自己找实习继任--美团 AI产品运营",
            "application_info": {},
            "fit_evidence": [],
        })

        self.assertEqual(normalized["title"], "美团 AI产品运营")

    def test_semantically_grounded_copy_passes(self) -> None:
        result = self.agent._validate_output(self._valid_output(), self.source)

        self.assertEqual(result["used_evidence_ids"], ["e1"])
        self.assertTrue(result["requirement_matches"])

    def test_generic_internship_framing_is_rejected(self) -> None:
        output = self._valid_output()
        for field in ("greeting", "email_body", "cover_letter"):
            output[field] = str(output[field]).replace("我曾", "在市场营销实习期间，我")

        with self.assertRaisesRegex(ValueError, "generic internship framing"):
            self.agent._validate_output(output, self.source)

    def test_ai_product_cover_uses_product_evidence_and_complete_operating_loop(self) -> None:
        output = self._valid_ai_product_output()

        result = self.agent._validate_output(output, self._ai_product_source())

        self.assertEqual(result["used_evidence_ids"], ["e_ai", "e_insight"])
        self.assertEqual(result["status"], "ready")

    def test_ai_product_cover_cannot_skip_available_product_evidence(self) -> None:
        output = self._valid_ai_product_output()
        output["used_evidence_ids"] = ["e_insight"]
        output["requirement_matches"] = [
            "分析用户 query 与高频场景 -> e_insight -> 1v1深访并沉淀4类核心用户需求与场景"
        ]

        with self.assertRaisesRegex(ValueError, "without AI-product evidence"):
            self.agent._validate_output(output, self._ai_product_source())

    def test_ai_product_cover_rejects_experience_catalog_structure(self) -> None:
        output = self._valid_ai_product_output()
        output["cover_letter"] = str(output["cover_letter"]).replace(
            "我曾从0到1搭建Asteria数据分析交付系统",
            "在AI产品方面，我曾从0到1搭建Asteria数据分析交付系统",
        ).replace(
            "也开展1v1深访",
            "\n在用户洞察方面，我也开展1v1深访",
        )

        with self.assertRaisesRegex(ValueError, "experience catalog"):
            self.agent._validate_output(output, self._ai_product_source())

    def test_ai_product_cover_rejects_project_by_project_catalog_structure(self) -> None:
        output = self._valid_ai_product_output()
        output["cover_letter"] = str(output["cover_letter"]).replace(
            "我曾从0到1搭建Asteria数据分析交付系统",
            "我在 Asteria 项目中从0到1搭建数据分析交付系统",
        ).replace(
            "也开展1v1深访",
            "\n我在用户调研项目中开展1v1深访",
        )

        with self.assertRaisesRegex(ValueError, "experience catalog"):
            self.agent._validate_output(output, self._ai_product_source())

    def test_used_evidence_must_be_unique_and_limited_to_two(self) -> None:
        source = self._ai_product_source()
        source["candidate_evidence"].append({
            "id": "e_ops",
            "role_axis": "operations",
            "label": "社群运营",
            "detail": "从0到1运营150人社群",
            "first_person_claim": "我从0到1运营150人社群",
        })

        for used_ids in (["e_ai", "e_ai"], ["e_ai", "e_insight", "e_ops"]):
            with self.subTest(used_ids=used_ids):
                output = self._valid_ai_product_output()
                output["used_evidence_ids"] = used_ids
                with self.assertRaisesRegex(ValueError, "invalid candidate evidence reference"):
                    self.agent._validate_output(output, source)

    def test_ai_product_cover_requires_a_concrete_product_fact_anchor(self) -> None:
        output = self._valid_ai_product_output()
        output["cover_letter"] = str(output["cover_letter"]).replace(
            "我曾从0到1搭建Asteria数据分析交付系统，将分散分析纳入统一产品链路，统一7类输入、6类场景和3层报告输出；",
            "我做过数据分析与 Agent 项目，也尝试把分散分析纳入统一工作方式；",
        )

        with self.assertRaisesRegex(ValueError, "concrete AI-product fact anchor"):
            self.agent._validate_output(output, self._ai_product_source())

    def test_agent_engineering_role_does_not_require_product_operations_loop(self) -> None:
        source = {
            **self.source,
            "title": "Agent 研发实习",
            "responsibilities": ["使用 Python 处理用户数据并开发 Agent 模块"],
            "requirements": ["熟悉 Python"],
        }
        output = self._valid_output()
        for field in ("greeting", "email_subject", "email_body", "cover_letter"):
            output[field] = str(output[field]).replace("数据分析实习", "Agent 研发实习")
        output["requirement_matches"] = [
            "使用 Python 处理用户数据并开发 Agent 模块 -> e1 -> 使用 Python 清洗用户数据并输出分析报告"
        ]

        result = self.agent._validate_output(output, source)

        self.assertEqual(result["status"], "ready")

    def test_generic_copy_without_job_or_evidence_signal_is_rejected(self) -> None:
        output = self._valid_output()
        output.update(
            {
                "greeting": "您好，我是张三，希望申请实习岗位。我愿意认真学习并配合团队工作，请问岗位目前是否仍在招聘？",
                "email_subject": "实习申请｜张三",
                "email_body": (
                    "尊敬的招聘负责人：\n"
                    "您好！我是张三，希望申请实习岗位。\n"
                    "我具备认真负责的态度，愿意学习并配合团队完成工作。\n"
                    "期待进一步沟通岗位安排。"
                ),
                "cover_letter": (
                    "主题：实习申请｜张三\n"
                    "尊敬的招聘负责人：\n"
                    "您好！我是张三，希望申请实习岗位。\n\n"
                    "我愿意认真学习，配合团队完成工作，并在执行过程中及时沟通进展。\n\n"
                    "如果有机会加入，我会先了解工作目标和交付要求，再按计划完成任务并及时同步。期待进一步沟通岗位安排和团队需求。\n\n"
                    "此致\n敬礼！\n"
                    "姓名：张三"
                ),
                "requirement_matches": ["岗位要求 -> e1 -> 相关经历"],
            }
        )

        with self.assertRaisesRegex(ValueError, "job-specific signal"):
            self.agent._validate_output(output, self.source)

    def test_role_with_requirements_cannot_omit_requirement_matches(self) -> None:
        output = self._valid_output()
        output["requirement_matches"] = []

        with self.assertRaisesRegex(ValueError, "no requirement-to-evidence matches"):
            self.agent._validate_output(output, self.source)

    def test_grounded_greeting_cannot_mask_generic_cover_letter(self) -> None:
        output = self._valid_output()
        generic_paragraph = (
            "我会先了解团队目标和任务边界，确认优先级与交付节奏，再按计划推进具体事项。"
            "执行过程中我会主动同步进度、记录反馈，并根据实际情况调整安排，确保沟通清楚、推进稳定。"
        )
        output["cover_letter"] = (
            "主题：实习申请｜张三\n"
            "尊敬的招聘负责人：\n"
            "您好！我是张三，希望申请这个职位。\n\n"
            f"{generic_paragraph}{generic_paragraph}{generic_paragraph}\n\n"
            "期待进一步了解团队当前的任务安排，也希望有机会就工作重点进行沟通。\n\n"
            "此致\n敬礼！\n姓名：张三"
        )
        self.assertTrue(280 <= len(str(output["cover_letter"])) <= 520)

        with self.assertRaisesRegex(ValueError, "Cover Letter without a job-specific signal"):
            self.agent._validate_output(output, self.source)

    def test_requirement_match_must_reference_used_evidence_id(self) -> None:
        for invalid_match in (
            "分析用户数据并输出报告 -> 相关经历 -> 使用 Python 清洗用户数据并输出分析报告",
            "分析用户数据并输出报告 -> e999 -> 使用 Python 清洗用户数据并输出分析报告",
        ):
            with self.subTest(invalid_match=invalid_match):
                output = self._valid_output()
                output["requirement_matches"] = [invalid_match]
                with self.assertRaisesRegex(ValueError, "invalid evidence reference"):
                    self.agent._validate_output(output, self.source)

    def test_exact_short_role_name_is_a_valid_job_signal(self) -> None:
        source = {**self.source, "title": "BI", "responsibilities": [], "requirements": []}
        output = self._valid_output()
        for field in ("greeting", "email_subject", "email_body", "cover_letter"):
            output[field] = str(output[field]).replace("数据分析实习", "BI")
        output["cover_letter"] = str(output["cover_letter"]).replace(
            "此致",
            "这段 Python 数据处理与报告交付经历也能支持 BI 工作中的数据核验和结论表达。\n\n此致",
        )
        output["requirement_matches"] = []

        result = self.agent._validate_output(output, source)

        self.assertEqual(result["status"], "ready")

    def test_one_invalid_item_does_not_discard_valid_batch_outputs(self) -> None:
        agent = object.__new__(CodexRuntimeOutreachAgent)
        agent.builtin_provider = None
        agent.cli_bin = "fake-codex"
        agent.batch_size = 8
        agent.candidate_profile = {}
        agent.cache = {"entries": {}}
        valid = self._valid_output()
        invalid = {**self._valid_output(), "note_id": "n2", "used_evidence_ids": ["missing"]}
        agent._run_batch = lambda batch: [valid, invalid]
        agent._save_cache = lambda: None

        def record(note_id: str) -> dict[str, object]:
            return {
                "note_id": note_id,
                "title": "数据分析实习",
                "body": "招聘数据分析实习，负责分析用户数据并输出报告。",
                "quality": {"body_present": True},
                "application_info": {
                    "responsibilities": [{"text": "分析用户数据并输出报告"}],
                    "requirements": [{"text": "熟悉 Python"}],
                },
                "fit_evidence": self.source["candidate_evidence"],
                "outreach": {},
            }

        records = [record("n1"), record("n2")]
        report = agent.enrich(records)

        self.assertEqual((report.generated, report.failed, report.status), (1, 1, "partial"))
        self.assertEqual(records[0]["outreach"]["status"], "ready")
        self.assertEqual(records[1]["outreach"]["status"], "blocked_codex_runtime")


if __name__ == "__main__":
    unittest.main()
