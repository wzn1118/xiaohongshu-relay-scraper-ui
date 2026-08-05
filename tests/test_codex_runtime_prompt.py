from __future__ import annotations

import unittest

from scripts.codex_runtime_outreach import (
    COVER_LETTER_MAX_CHARS,
    COVER_LETTER_MIN_CHARS,
    COVER_LETTER_TARGET_MAX_CHARS,
    COVER_LETTER_TARGET_MIN_CHARS,
    CodexRuntimeOutreachAgent,
    _output_schema,
    _prompt,
    _record_input,
    _resolve_email_subject,
    _subject_rule,
)


def _with_cover_letter_depth(cover_letter: str, paragraphs: list[str]) -> str:
    marker = "\n\n此致"
    depth = "\n\n".join(paragraphs)
    return cover_letter.replace(marker, f"\n\n{depth}{marker}")


class CodexRuntimePromptTests(unittest.TestCase):
    def setUp(self) -> None:
        self.agent = object.__new__(CodexRuntimeOutreachAgent)
        self.agent.builtin_provider = None
        self.agent.candidate_name = "张三"
        self.agent.candidate_profile = {"name": "张三"}
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
            "cover_letter": _with_cover_letter_depth(
                (
                    "主题：数据分析实习申请｜张三｜Python 数据分析\n"
                    "尊敬的招聘负责人：\n"
                    "您好！我是张三，希望申请数据分析实习。\n\n"
                    "我曾使用 Python 清洗用户数据并输出分析报告，过程中先整理数据口径，再检查异常信息，最后把分析结果整理成可阅读的报告。这段经历让我形成了从问题拆解、数据处理到结论表达的完整工作习惯，也与岗位需要分析用户数据并输出报告的职责直接对应。\n\n"
                    "如果有机会加入，我会先确认团队对指标和报告的判断口径，再从具体任务开始核验数据、记录过程并及时同步结论，确保交付内容能够服务后续讨论。"
                    "我也会根据反馈持续复盘数据口径与报告表达，确保结论准确、可追踪。期待进一步了解岗位当前最需要推进的工作。\n\n"
                    "此致\n敬礼！\n"
                    "姓名：张三"
                ),
                [
                    "我理解这项工作的首要职责不是机械汇总数字，而是把业务问题转换成可检查的数据任务。面对用户数据分析，我会先明确分析对象、时间范围、指标定义和使用场景，再确认原始数据能否支持判断。这样可以让后续清洗、计算和结论始终围绕同一个问题推进，也让报告接收者清楚每项结论适用于什么范围。",
                    "针对岗位强调的 Python 能力，我能提供的直接证据是已经用 Python 完成用户数据清洗和报告输出。我不会把一次项目经历写成对所有工具的熟练掌握，但这段经历证明我能把处理规则落实为可执行步骤，并在发现缺失、重复或异常记录时回到口径核对，而不是直接给出缺少依据的结论。",
                    "在报告交付环节，我会把关键指标、处理过程、主要发现和限制条件分开表达。对影响判断的异常值，我会保留核验记录；对暂时无法确认的原因，我会标注待验证项，并说明下一步需要补充的数据。这样的交付既便于负责人快速阅读，也便于团队在复盘时追踪结论如何产生。",
                    "如果职责还包括与业务同学沟通分析需求，我会先复述问题和预期决策，确认双方理解一致，再开始处理数据。阶段性结果出来后，我会用简短示例说明口径差异可能造成的影响，及时收集反馈并调整报告重点，减少分析完成后才发现方向偏差的返工。",
                    "对于持续性的用户数据任务，我会建立任务清单与检查节点：开始前记录输入和目标，处理中检查字段质量与计算逻辑，交付前核对图表、文字和数字是否一致，交付后记录新增问题。即使当前证据没有覆盖团队的全部内部流程，我也会用这些明确步骤进入工作，而不是把尚未做过的内容写成既有成果。",
                    "我希望进一步了解团队当前的数据来源、报告使用者以及最优先解决的用户问题，从而判断应先提升数据质量、分析效率还是结论表达。若有机会沟通，我也愿意围绕一项真实任务说明自己的拆解思路，并根据团队反馈调整执行顺序和交付形式。",
                ],
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
        output = {
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
        output["cover_letter"] = _with_cover_letter_depth(
            str(output["cover_letter"]),
            [
                "我理解这一岗位的优先职责，是让 BA Agent 的真实使用信号进入稳定的运营决策，而不是把运营理解为单次活动。用户提出的 query、失败反馈和重复追问都应被整理成可分析的问题单元，再结合使用阶段判断它们影响的是首次体验、持续使用还是召回，这样团队才能把资源放到影响最大的环节。",
                "已有的产品建设与用户洞察经验可以分别支撑这条链路的两个部分：前者让我理解输入、场景和输出需要统一结构，后者让我知道不能只看表面反馈，而要追问用户目标、使用环境和未被满足的需求。写入求职信的每项事实都只用于说明这种可迁移的方法，不把岗位尚未提供的数据写成我的历史成果。",
                "针对案例沉淀与运营优先级，我会先按用户任务、问题类型、发生频率和影响程度建立分类，再把高价值问题转成案例补充、内容引导或产品反馈。每项动作都明确服务对象、预期变化和验证窗口，避免案例库只增加数量却不能帮助用户完成任务，也避免运营动作与产品问题彼此脱节。",
                "针对拉新、留存和召回，我会区分不同阶段的用户行为：拉新关注用户是否理解产品价值并完成首次关键动作，留存关注核心场景能否稳定得到结果，召回则要识别离开的原因和重新触达的条件。若当前证据没有这些历史指标，我只会把它们写成入职后的观察与实验计划，并在获得真实数据后再确定基线和目标。",
                "执行中我会把用户反馈、场景分类、运营动作和指标变化保留在同一复盘记录中，定期检查哪些判断得到验证、哪些动作没有产生预期影响，以及下一轮应调整产品能力还是运营表达。希望进一步了解团队当前最优先验证的 BA Agent 用户场景、已有的数据口径和运营节奏，以便围绕真实问题展开更具体的讨论。",
            ],
        )
        return output

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
        self.assertIn("岗位能力点 -> evidence id -> 证据中的具体行动/交付物/结果 -> 可迁移价值", prompt)
        self.assertIn("first_person_claim", prompt)
        self.assertIn("AI 产品工作机制", prompt)
        self.assertIn("query/用户反馈 -> 痛点与场景分类", prompt)
        self.assertIn("email_subject 必须先从当前 JOB_INPUT", prompt)
        self.assertIn("正文核心要求", prompt)
        self.assertIn("第一行必须是“主题：”加上完全相同的 email_subject", prompt)
        self.assertIn("禁止按经历逐段罗列", prompt)
        self.assertIn("在市场营销实习期间", prompt)
        self.assertIn("证据段必须从可核验动作或项目对象起笔", prompt)
        self.assertIn("全部有效职责（最多六条）", prompt)
        self.assertIn("priority 最靠前的核心职责", prompt)
        self.assertIn("具体行动/交付物/结果 -> 可迁移价值", prompt)
        self.assertIn("目标 900-1200 个非空白字符", prompt)
        self.assertIn("使用 2-5 条互补证据", prompt)
        self.assertIn("通用回退句或其近义改写凑字", prompt)
        self.assertNotIn("我是学校、专业、年级/学历学生姓名", prompt)
        self.assertNotIn("目前我每周可实习可用天数天", prompt)

    def test_explicit_subject_rule_overrides_model_subject(self) -> None:
        source = {
            "title": "AI产品经理",
            "body_excerpt": "请以“姓名-学校-应聘岗位-每周实习天数”作为邮件标题。",
            "requirements": [],
            "responsibilities": [],
        }
        self.assertEqual(
            _subject_rule(source)["fields"],
            ["candidateName", "school", "jobTitle", "availabilityDays"],
        )
        self.assertEqual(
            _resolve_email_subject(
                "模型自拟标题",
                source,
                "张三",
                {"school": "曼彻斯特大学", "availabilityDays": "4"},
            ),
            "张三-曼彻斯特大学-AI产品经理-每周4天",
        )

    def test_fixed_subject_rule_is_kept_literal(self) -> None:
        source = {
            "title": "AI产品经理",
            "body_excerpt": "邮件标题要求：AI产品经理实习申请",
            "requirements": [],
            "responsibilities": [],
        }
        rule = _subject_rule(source)
        self.assertTrue(rule["literal"])
        self.assertEqual(_resolve_email_subject("其他标题", source, "张三", {}), "AI产品经理实习申请")

        source["body_excerpt"] = "邮件的标题要求：姓名-学校-应聘岗位"
        self.assertEqual(_subject_rule(source)["fields"], ["candidateName", "school", "jobTitle"])
        source["body_excerpt"] = "标题请使用‘姓名-学校-应聘岗位’"
        self.assertEqual(_subject_rule(source)["fields"], ["candidateName", "school", "jobTitle"])
        self.assertEqual(
            _resolve_email_subject("其他标题", source, "张三", {"school": "曼彻斯特大学"}),
            "张三-曼彻斯特大学-AI产品经理",
        )

    def test_subject_rule_excludes_attachment_and_follow_up_copy(self) -> None:
        source = {
            "title": "视觉设计实习",
            "body_excerpt": "邮件标题：[辉瑞实习]姓名+年级学校+入职时间+一周几天，需附上简历和作品集，作品集可提供海报、长图文等相关设计作品",
            "requirements": [],
            "responsibilities": [],
        }
        self.assertEqual(
            _subject_rule(source)["template"],
            "[辉瑞实习]姓名+年级学校+入职时间+一周几天",
        )

        source["body_excerpt"] = "标题格式：姓名-学校-到岗时间-实习时长 合适会尽快安排面试！"
        self.assertEqual(
            _subject_rule(source)["template"],
            "姓名-学校-到岗时间-实习时长",
        )

        source["body_excerpt"] = "简历命名：学校-姓名-到岗时间\n投递邮箱 talent@example.com"
        self.assertFalse(_subject_rule(source)["detected"])

        source["body_excerpt"] = "请将PDF版本简历按照以下格式命名：姓名-学校-每周可实习时间-可实习月份\n投递邮箱 talent@example.com"
        self.assertFalse(_subject_rule(source)["detected"])

        source["body_excerpt"] = "邮件及简历标题请命名为：姓名-学校-到岗时间"
        self.assertEqual(_subject_rule(source)["template"], "姓名-学校-到岗时间")

        source["body_excerpt"] = (
            "投递主题：应聘岗位｜姓名｜每周实习天数\n"
            "简历命名为：姓名-岗位-简历"
        )
        self.assertEqual(
            _subject_rule(source)["template"],
            "应聘岗位｜姓名｜每周实习天数",
        )

    def test_subject_rule_fills_real_profile_aliases_and_splits_arrival(self) -> None:
        source = {
            "title": "AI产品经理",
            "body_excerpt": "邮件标题：姓名-届数-最快入职时间-持续时长-一周几天-手机号",
            "requirements": [],
            "responsibilities": [],
        }
        profile = {
            "name": "王梓楠",
            "degreeYear": "2026-12",
            "availabilityDays": "4",
            "internshipDuration": "6个月，2周内到岗",
            "contact": {"phone": "13811817014"},
        }
        self.assertEqual(
            _subject_rule(source)["fields"],
            [
                "candidateName",
                "degreeYear",
                "arrivalDate",
                "internshipDuration",
                "availabilityDays",
                "phone",
            ],
        )
        self.assertEqual(
            _resolve_email_subject("模型自拟标题", source, "王梓楠", profile),
            "王梓楠-2026-12-2周内到岗-6个月-每周4天-13811817014",
        )

    def test_subject_rule_rejects_non_email_title_statements(self) -> None:
        source = {
            "title": "AI产品经理",
            "body_excerpt": "今天的课程主题是「AI产品经理辩论」。",
            "requirements": [],
            "responsibilities": [],
        }
        self.assertFalse(_subject_rule(source)["detected"])
        source["body_excerpt"] = "标题是我许愿的hh。。"
        self.assertFalse(_subject_rule(source)["detected"])

    def test_subject_rule_keeps_undergraduate_and_graduate_education_distinct(self) -> None:
        source = {
            "title": "AI产品经理",
            "body_excerpt": "邮件标题：姓名-年级-本科学校专业-硕士学校专业-可实习时间-联系电话",
            "requirements": [],
            "responsibilities": [],
        }
        profile = {
            "name": "王梓楠",
            "degreeYear": "2026-12",
            "internshipDuration": "6个月，2周内到岗",
            "phone": "13811817014",
            "education": [
                {"degree": "本科", "institution": "首都经济贸易大学", "field": "电子商务"},
                {"degree": "硕士", "institution": "曼彻斯特大学", "field": "全球发展"},
            ],
        }
        self.assertEqual(
            _subject_rule(source)["fields"],
            [
                "candidateName",
                "degreeYear",
                "undergraduateEducation",
                "graduateEducation",
                "internshipDuration",
                "phone",
            ],
        )
        self.assertEqual(
            _resolve_email_subject("模型自拟标题", source, "王梓楠", profile),
            "王梓楠-2026-12-首都经济贸易大学电子商务-曼彻斯特大学全球发展-6个月-13811817014",
        )

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
        self.assertEqual(
            (properties["cover_letter"]["minLength"], properties["cover_letter"]["maxLength"]),
            (COVER_LETTER_MIN_CHARS, COVER_LETTER_MAX_CHARS),
        )
        self.assertEqual(
            (COVER_LETTER_TARGET_MIN_CHARS, COVER_LETTER_TARGET_MAX_CHARS),
            (900, 1200),
        )
        self.assertEqual(properties["used_evidence_ids"]["maxItems"], 5)
        self.assertTrue(properties["used_evidence_ids"]["uniqueItems"])

    def test_output_schema_can_constrain_runtime_ids_to_exact_input_values(self) -> None:
        schema = _output_schema(note_ids=["n1"], evidence_ids=["evidence-full-id"])
        properties = schema["properties"]["items"]["items"]["properties"]

        self.assertEqual(properties["note_id"]["enum"], ["n1"])
        self.assertEqual(properties["used_evidence_ids"]["items"]["enum"], ["evidence-full-id"])

    def test_record_input_uses_reviewed_role_instead_of_social_post_title(self) -> None:
        normalized = _record_input({
            "note_id": "n1",
            "title": "给自己找实习继任--美团 AI产品运营",
            "job_card": {"role_name": "AI产品运营"},
            "application_info": {},
            "fit_evidence": [],
        })

        self.assertEqual(normalized["title"], "AI产品运营")

        missing_role = _record_input({
            "note_id": "n2",
            "title": "给自己找实习继任--美团 AI产品运营",
            "application_info": {},
            "fit_evidence": [],
        })
        self.assertEqual(missing_role["title"], "")

    def test_semantically_grounded_copy_passes(self) -> None:
        result = self.agent._validate_output(self._valid_output(), self.source)

        self.assertEqual(result["used_evidence_ids"], ["e1"])
        self.assertTrue(result["requirement_matches"])

    def test_cover_letter_below_800_non_whitespace_characters_is_rejected(self) -> None:
        output = self._valid_output()
        output["cover_letter"] = str(output["cover_letter"])[:700]

        with self.assertRaisesRegex(ValueError, "strict length contract"):
            self.agent._validate_output(output, self.source)

    def test_cover_letter_fallback_boilerplate_is_rejected(self) -> None:
        output = self._valid_output()
        output["cover_letter"] = str(output["cover_letter"]).replace(
            "此致",
            "我与该岗位高度匹配，也期待为团队贡献力量。\n\n此致",
        )

        with self.assertRaisesRegex(ValueError, "fallback boilerplate"):
            self.agent._validate_output(output, self.source)

    def test_email_subject_is_standardized_and_synced_to_cover_letter(self) -> None:
        output = self._valid_output()
        output["email_subject"] = "以可复核的AI产品机制提升chatbot场景与评测效率"
        output["cover_letter"] = str(output["cover_letter"]).replace(
            "主题：数据分析实习申请｜张三｜Python 数据分析",
            "主题：以可复核的AI产品机制提升chatbot场景与评测效率",
        ) + "\n我会持续复盘交付结果并根据反馈优化方案。"

        result = self.agent._validate_output(output, self.source)

        expected = "应聘数据分析实习｜分析用户数据并输出报告｜张三"
        self.assertEqual(result["email_subject"], expected)
        self.assertTrue(result["cover_letter"].startswith(f"主题：{expected}\n"))

    def test_email_subject_normalizes_role_prefix_and_availability_unit(self) -> None:
        self.agent.candidate_profile = {"name": "张三", "availabilityDays": "5天"}
        source = {**self.source, "title": "应聘数据分析实习"}

        result = self.agent._validate_output(self._valid_output(), source)

        expected = "应聘数据分析实习｜分析用户数据并输出报告｜张三｜每周可实习5天"
        self.assertEqual(result["email_subject"], expected)
        self.assertTrue(result["cover_letter"].startswith(f"主题：{expected}\n"))

    def test_email_subject_normalizes_internal_requirement_separator(self) -> None:
        source = {**self.source, "responsibilities": ["负责数据分析｜报告输出"]}

        result = self.agent._validate_output(self._valid_output(), source)

        expected = "应聘数据分析实习｜数据分析 报告输出｜张三"
        self.assertEqual(result["email_subject"], expected)
        self.assertTrue(result["cover_letter"].startswith(f"主题：{expected}\n"))

    def test_email_subject_omits_capability_suffix_when_candidate_name_is_missing(self) -> None:
        self.agent.candidate_name = ""
        self.agent.candidate_profile = {}

        result = self.agent._validate_output(self._valid_output(), self.source)

        expected = "应聘数据分析实习｜分析用户数据并输出报告"
        self.assertEqual(result["email_subject"], expected)
        self.assertTrue(result["cover_letter"].startswith(f"主题：{expected}\n"))
        self.assertNotIn("Python 数据分析", result["email_subject"])

    def test_email_subject_drops_unverified_suffix_without_name_or_job_focus(self) -> None:
        self.agent.candidate_name = ""
        self.agent.candidate_profile = {}
        source = {**self.source, "responsibilities": [], "requirements": [], "body_excerpt": ""}

        result = self.agent._validate_output(self._valid_output(), source)

        self.assertEqual(result["email_subject"], "应聘数据分析实习")
        self.assertNotIn("张三", result["email_subject"])
        self.assertNotIn("Python 数据分析", result["email_subject"])

    def test_cover_letter_discards_a_separate_value_proposition_headline(self) -> None:
        output = self._valid_output()
        output["cover_letter"] = str(output["cover_letter"]).replace(
            "主题：数据分析实习申请｜张三｜Python 数据分析",
            "以可复核的数据分析提高报告交付质量",
        )

        result = self.agent._validate_output(output, self.source)

        self.assertTrue(
            result["cover_letter"].startswith(
                "主题：应聘数据分析实习｜分析用户数据并输出报告｜张三\n尊敬的招聘负责人："
            )
        )
        self.assertNotIn("以可复核的数据分析提高报告交付质量", result["cover_letter"])

    def test_cover_letter_preserves_first_body_paragraph_when_subject_is_missing(self) -> None:
        output = self._valid_output()
        original_lines = str(output["cover_letter"]).splitlines()
        output["cover_letter"] = "核心正文第一段，不是标题。\n" + "\n".join(original_lines[1:])

        result = self.agent._validate_output(output, self.source)

        expected_subject = "应聘数据分析实习｜分析用户数据并输出报告｜张三"
        self.assertTrue(
            result["cover_letter"].startswith(
                f"主题：{expected_subject}\n核心正文第一段，不是标题。\n尊敬的招聘负责人："
            )
        )

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

    def test_used_evidence_must_be_unique_and_limited_to_five(self) -> None:
        source = self._ai_product_source()
        source["candidate_evidence"].extend([
            {
                "id": f"e_extra_{index}",
                "role_axis": "operations",
                "label": f"运营证据{index}",
                "detail": f"完成运营任务{index}",
                "first_person_claim": f"我完成运营任务{index}",
            }
            for index in range(1, 5)
        ])

        for used_ids in (
            ["e_ai", "e_ai"],
            ["e_ai", "e_insight", "e_extra_1", "e_extra_2", "e_extra_3", "e_extra_4"],
        ):
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
            f"{generic_paragraph * 10}\n\n"
            "期待进一步了解团队当前的任务安排，也希望有机会就工作重点进行沟通。\n\n"
            "此致\n敬礼！\n姓名：张三"
        )
        cover_chars = len("".join(str(output["cover_letter"]).split()))
        self.assertTrue(COVER_LETTER_MIN_CHARS <= cover_chars <= COVER_LETTER_MAX_CHARS)

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
        agent.candidate_name = "张三"
        agent.candidate_profile = {"name": "张三"}
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
