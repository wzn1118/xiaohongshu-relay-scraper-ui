from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from ai_application_workflow import (  # noqa: E402
    _deterministic_ocr_role,
    _deterministic_problems,
    _evaluate,
    _finalize_local_draft,
    _merge_feedback,
    _normalize_external_url,
    enrich_general_payload,
    enrich_payload,
    record_needs_completion,
    record_needs_content_completion,
)


class FakeProvider:
    provider = "test-provider"
    model = "fixture-model"

    def __init__(self) -> None:
        self.writer_calls = 0
        self.last_request_used_images = False

    def generate_json(self, system, user, schema, image_urls=None):
        required = set(schema.get("required", []))
        if required == {"visible_text"}:
            self.last_request_used_images = bool(image_urls)
            return {
                "visible_text": (
                    "数据分析实习\n"
                    "岗位职责：分析活动数据并推动优化\n"
                    "任职要求：具备数据分析和跨团队协作能力"
                ),
            }
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
                    "application_routes": [],
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
                "主题：应聘增长运营实习｜测试用户｜每周可实习5天\n"
                "尊敬的招聘负责人：\n"
                "您好！我是测试用户，希望申请增长运营实习。我曾负责校园活动的用户调研与数据复盘，"
                "从访谈记录和转化数据中定位关键流失环节，再与内容和执行成员共同调整触达节奏。这个过程"
                "让我形成了从目标拆解、事实验证到协同落地的工作方式。\n\n"
                "针对岗位中的增长分析与协作推进任务，我会先明确业务目标和衡量口径，再梳理用户反馈与"
                "转化数据，找到优先级最高的问题；随后与相关成员确认可执行的调整动作，并持续追踪结果，"
                "让每次复盘都能沉淀为下一轮行动依据。这样的工作方式与我在校园活动增长项目中的实践一致。\n\n"
                "目前我每周可实习5天，预计可连续实习6个月。希望有机会进一步了解团队当前的增长目标，"
                "并具体沟通我可以优先承担的数据复盘或协作推进任务。简历随信附上，感谢您的阅读，期待进一步沟通。\n\n"
                "此致\n敬礼！\n姓名：测试用户"
            )
            return {
                "greeting": "您好，我是测试用户，想应聘增长运营实习。我曾负责用户调研与转化数据复盘，目前每周可实习5天。请问岗位目前是否仍在招聘？",
                "email_subject": "应聘增长运营实习｜测试用户｜每周可实习5天",
                "email_body": "尊敬的招聘负责人：\n您好！我是测试用户，希望申请增长运营实习。\n\n我曾负责校园活动的用户调研与转化数据复盘，并协同团队根据反馈迭代执行方案，相关经历与岗位的增长分析和协作推进要求匹配。\n\n目前我每周可实习5天，可连续实习6个月。简历随信附上，感谢您的阅读，期待有机会进一步沟通！\n\n此致\n敬礼！\n测试用户",
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


class GeneralContentProvider:
    provider = "test-provider"
    model = "fixture-model"

    def __init__(self) -> None:
        self.last_request_used_images = False
        self.calls: list[str] = []

    def generate_json(self, system, user, schema, image_urls=None):
        required = set(schema.get("required", []))
        self.last_request_used_images = bool(image_urls)
        if required == {"visible_text", "visual_summary", "visual_signals"}:
            self.calls.append("vision")
            return {
                "visible_text": "展览时间：8月1日\n地点：城市美术馆",
                "visual_summary": "海报以城市建筑摄影为主画面。",
                "visual_signals": ["黑白建筑照片", "展览日期排版"],
            }
        if "eyebrow" in required:
            self.calls.append("presentation")
            return {
                "eyebrow": "CITY EXHIBITION INTELLIGENCE",
                "title": "城市展览内容观察",
                "description": "从正文与图片中整理展览主题、时间和现场线索。",
                "modules": [
                    {"id": "schedule", "title": "时间与地点", "question": "何时何地举办？"},
                    {"id": "highlights", "title": "展览亮点", "question": "有哪些值得关注的内容？"},
                ],
            }
        if "overview" in required:
            self.calls.append("analysis")
            return {
                "overview": "该内容介绍一场城市摄影展，正文与海报共同给出举办信息。",
                "content_type": "展览推荐",
                "relevance_score": 96,
                "relevance_reason": "正文和海报均直接围绕城市展览。",
                "topics": ["摄影展", "城市文化"],
                "entities": ["城市美术馆"],
                "image_insights": ["海报显示展览时间为8月1日"],
                "modules": [
                    {
                        "id": "schedule",
                        "title": "时间与地点",
                        "summary": "8月1日在城市美术馆举办。",
                        "items": ["8月1日", "城市美术馆"],
                        "evidence": ["展览时间：8月1日", "地点：城市美术馆"],
                    },
                    {
                        "id": "highlights",
                        "title": "展览亮点",
                        "summary": "聚焦城市摄影。",
                        "items": ["城市摄影"],
                        "evidence": ["本周城市摄影展"],
                    },
                ],
            }
        raise AssertionError(f"Unexpected schema: {required}")


class ImageApplicationProvider(FakeProvider):
    def generate_json(self, system, user, schema, image_urls=None):
        if "role_name" not in set(schema.get("required", [])):
            return super().generate_json(system, user, schema, image_urls)
        self.last_request_used_images = bool(image_urls)
        return {
            "role_name": "数据分析实习",
            "responsibilities": [{"text": "整理并分析业务数据", "priority": 1}],
            "requirements": [{"text": "熟悉 SQL", "priority": 1}],
            "application_routes": [],
            "capabilities": [],
            "image_analysis": {
                "status": "analyzed",
                "summary": "第 1 张海报包含投递邮箱和申请链接",
                "job_signals": ["数据分析实习"],
                "application_routes": [
                    {
                        "type": "email",
                        "value": "jobs@example.com",
                        "channel": "email",
                        "confidence": 98,
                        "evidence": "投递邮箱：jobs@example.com",
                        "source_image_index": 1,
                    },
                    {
                        "type": "link",
                        "value": "www.example.com/apply/42",
                        "channel": "link",
                        "confidence": 94,
                        "evidence": "www.example.com/apply/42",
                        "source_image_index": 1,
                    },
                    {
                        "type": "link",
                        "value": "https://blurred.example/apply",
                        "channel": "link",
                        "confidence": 61,
                        "evidence": "模糊链接",
                        "source_image_index": 1,
                    },
                    {
                        "type": "link",
                        "value": "javascript:alert(1)",
                        "channel": "link",
                        "confidence": 99,
                        "evidence": "javascript:alert(1)",
                        "source_image_index": 1,
                    },
                ],
            },
        }


class CrossVerifiedApplicationProvider(FakeProvider):
    def generate_json(self, system, user, schema, image_urls=None):
        if "role_name" not in set(schema.get("required", [])):
            return super().generate_json(system, user, schema, image_urls)
        self.last_request_used_images = bool(image_urls)
        route = {
            "type": "email",
            "value": "jobs@example.com",
            "channel": "email",
            "confidence": 99,
            "evidence": "jobs@example.com",
        }
        return {
            "role_name": "数据分析实习",
            "responsibilities": [],
            "requirements": [],
            "application_routes": [{**route, "source": "body"}],
            "capabilities": [],
            "image_analysis": {
                "status": "analyzed",
                "summary": "海报邮箱与正文一致",
                "job_signals": [],
                "application_routes": [{**route, "source_image_index": 1}],
            },
        }


class PosterOcrProvider(FakeProvider):
    def generate_json(self, system, user, schema, image_urls=None):
        if set(schema.get("required", [])) == {"visible_text"}:
            self.last_request_used_images = bool(image_urls)
            return {
                "visible_text": (
                    "职位描述\n"
                    "1. 参与数据产品迭代策划并推进落地；\n"
                    "2. 负责市场调研和竞品调研；\n"
                    "任职要求\n"
                    "1. 熟悉 SQL 和 Excel；\n"
                    "投递邮箱 jobs@example.com"
                ),
            }
        return super().generate_json(system, user, schema, image_urls)


class RochePosterOcrProvider(FakeProvider):
    def generate_json(self, system, user, schema, image_urls=None):
        if set(schema.get("required", [])) == {"visible_text"}:
            self.last_request_used_images = bool(image_urls)
            return {
                "visible_text": (
                    "【岗位】：实习医学信息沟通员1位\n"
                    "【发展】：前期负责市场数据收集和整理，协助大区日常事务性工作\n"
                    "【应聘条件】：沟通能力和执行力强\n"
                    "投递邮箱 jobs@example.com"
                ),
            }
        return super().generate_json(system, user, schema, image_urls)


class UnreadablePosterProvider(FakeProvider):
    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    def generate_json(self, system, user, schema, image_urls=None):
        self.calls += 1
        required = set(schema.get("required", []))
        if required != {"visible_text"}:
            raise AssertionError("Unreadable posters must not trigger an ungrounded second model call")
        self.last_request_used_images = bool(image_urls)
        return {"visible_text": "无"}


class AiApplicationWorkflowTests(unittest.TestCase):
    def test_general_mode_generates_keyword_modules_and_understands_images(self) -> None:
        payload = {
            "quality_gate": {"passed": True, "discovered_count": 1, "record_count": 1, "checks": {}, "issues": []},
            "records": [{
                "note_id": "content-1",
                "title": "本周城市摄影展",
                "body": "本周城市摄影展将展出多位创作者的作品。",
                "source_card_text": "城市摄影展览推荐",
                "media": {"images": [{"url": "https://img.example/poster.jpg", "alt": "展览海报"}]},
            }],
        }
        provider = GeneralContentProvider()

        report = enrich_general_payload(
            payload,
            "城市展览",
            provider=provider,
            content_preset="place",
            content_goal="整理适合周末到访的展览、时间与地点。",
        )

        self.assertEqual(report.processed, 1)
        self.assertEqual(report.passed, 1)
        self.assertEqual(payload["analysis_mode"], "general")
        self.assertEqual(payload["keyword"], "城市展览")
        self.assertEqual(payload["content_research"], {
            "preset": "place",
            "label": "地点清单",
            "goal": "整理适合周末到访的展览、时间与地点。",
        })
        self.assertEqual(payload["content_presentation"]["title"], "城市展览内容观察")
        record = payload["records"][0]
        self.assertEqual(record["media"]["analysis"]["source"], "vision_model")
        self.assertIn("展览时间", record["media"]["analysis"]["visible_text"])
        self.assertEqual(record["content_analysis"]["content_type"], "展览推荐")
        self.assertEqual(len(record["content_analysis"]["modules"]), 2)
        self.assertGreater(record["content_analysis"]["grounded_evidence_count"], 0)
        self.assertFalse(record_needs_content_completion(record))
        self.assertEqual(provider.calls, ["presentation", "vision", "analysis"])
        self.assertEqual(payload["content_insights"]["groundedRecords"], 1)
        self.assertGreater(payload["content_insights"]["coverageRate"], 0)
        self.assertTrue(payload["quality_gate"]["passed"])

    def test_general_mode_does_not_analyze_short_title_only_source(self) -> None:
        payload = {
            "quality_gate": {"passed": True, "discovered_count": 1, "record_count": 1, "checks": {}, "issues": []},
            "records": [{
                "note_id": "short-1",
                "title": "南韩第一亚比 1小时前",
                "body": "南韩第一亚比",
                "source_card_text": "",
                "media": {"images": []},
            }],
        }
        provider = GeneralContentProvider()

        report = enrich_general_payload(payload, "亚比女", provider=provider, content_preset="auto")

        self.assertEqual(payload["content_research"]["preset"], "people")
        self.assertEqual(report.passed, 0)
        self.assertEqual(payload["records"][0]["content_analysis"]["status"], "insufficient_source")
        self.assertEqual(payload["records"][0]["content_analysis"]["relevance_score"], 0)
        self.assertEqual(provider.calls, ["presentation"])
        self.assertFalse(payload["quality_gate"]["passed"])

    def test_general_mode_rejects_evidence_not_found_in_source(self) -> None:
        class UngroundedProvider(GeneralContentProvider):
            def generate_json(self, system, user, schema, image_urls=None):
                result = super().generate_json(system, user, schema, image_urls)
                if "overview" in set(schema.get("required", [])):
                    result["modules"] = [{
                        "id": "schedule",
                        "title": "时间与地点",
                        "summary": "虚构地点举办。",
                        "items": ["虚构地点"],
                        "evidence": ["原文中不存在的句子"],
                    }]
                return result

        payload = {
            "quality_gate": {"passed": True, "discovered_count": 1, "record_count": 1, "checks": {}, "issues": []},
            "records": [{
                "note_id": "ungrounded-1",
                "title": "城市摄影展",
                "body": "本周城市摄影展将展出多位创作者的作品，并介绍现场策展思路。",
                "source_card_text": "城市摄影展览推荐",
                "media": {"images": []},
            }],
        }

        report = enrich_general_payload(payload, "城市展览", provider=UngroundedProvider(), content_preset="place")

        analysis = payload["records"][0]["content_analysis"]
        self.assertEqual(report.passed, 0)
        self.assertEqual(analysis["status"], "ungrounded")
        self.assertEqual(analysis["grounded_evidence_count"], 0)
        self.assertEqual(analysis["relevance_score"], 0)
        self.assertTrue(record_needs_content_completion(payload["records"][0]))

    def test_poster_first_line_replaces_noisy_search_title_with_formal_role_name(self) -> None:
        role = _deterministic_ocr_role(
            {"title": "深圳/香港实习丨某公司 商业分析实习"},
            [(1, "某公司商业分析实习生(咨询业务)\nHC要求\n招聘2个日常实习HC\n1、深圳现场办公")],
        )

        self.assertEqual(role["role_name"], "某公司商业分析实习生(咨询业务)")

    def test_local_draft_uses_candidate_fields_for_greeting_and_subject(self) -> None:
        draft = _finalize_local_draft(
            {
                "greeting": "Candidate Name您好。",
                "email_subject": "Application",
            },
            {"role_name": "数据分析实习"},
            {
                "name": "Candidate Name",
                "school": "Example University",
                "major": "Data Science",
                "availabilityDays": "5",
            },
        )

        self.assertTrue(draft["greeting"].startswith("您好，我是Candidate Name"))
        self.assertIn("每周可实习5天", draft["greeting"])
        self.assertEqual(draft["email_subject"], "应聘数据分析实习｜Candidate Name｜每周可实习5天")

    def test_quality_gate_rejects_polluted_private_message_salutation(self) -> None:
        evidence = [{
            "id": "project-1",
            "label": "市场调研项目",
            "detail": "负责市场数据收集和整理；协同团队完成结果汇报",
            "skills": ["市场调研", "沟通协作"],
        }]
        draft = {
            "greeting": "小周同学 48分钟前您好，我是示例候选人，希望申请实习医学信息沟通员，期待进一步沟通。",
            "email_subject": "应聘实习医学信息沟通员｜示例候选人",
            "email_body": "您好，我是示例候选人，希望申请实习医学信息沟通员。我曾在市场调研项目中负责市场数据收集和整理，并协同团队完成结果汇报。相关经历能够支持岗位的信息整理与沟通协作工作，期待进一步沟通岗位目前的实际安排。",
            "cover_letter": (
                "主题：应聘实习医学信息沟通员｜示例候选人\n尊敬的招聘负责人：\n您好！我是示例候选人。"
                "我曾在市场调研项目中负责市场数据收集和整理，并协同团队完成结果汇报。"
                "这段经历让我能够围绕明确目标整理信息、核对事实并推进协作，也与岗位关注的信息整理和沟通执行直接相关。"
                "若有机会加入，我会先确认业务目标和交付口径，再把市场信息整理为团队可使用的材料，并及时同步进展和风险。"
                "我希望进一步了解团队当前的工作重点，并具体沟通可以优先承担的任务。感谢您的阅读，期待进一步沟通。"
                "\n\n此致\n敬礼！\n姓名：示例候选人"
            ),
            "used_evidence_ids": ["project-1"],
        }

        problems = _deterministic_problems(
            draft,
            {"role_name": "实习医学信息沟通员", "responsibilities": [], "requirements": []},
            evidence,
            {"name": "示例候选人"},
        )

        self.assertTrue(any("作者昵称" in problem for problem in problems))
        self.assertTrue(any("页面噪声" in problem for problem in problems))

    def test_local_model_uses_deterministic_quality_gate(self) -> None:
        class LocalProvider:
            provider = "local_qwen"

            def generate_json(self, *_args, **_kwargs):
                raise AssertionError("Local quality evaluation must not depend on another model response")

        evaluation = _evaluate(LocalProvider(), {}, [], {})

        self.assertLess(evaluation["score"], 90)
        self.assertEqual(sum(evaluation["rubric"].values()), evaluation["score"])
        self.assertTrue(evaluation["problems"])

    def test_quality_gate_rejects_unsupported_tools_and_metrics(self) -> None:
        evidence = [{
            "id": "project-1",
            "label": "校园活动增长",
            "detail": "开展用户调研；复盘转化数据；协同团队迭代方案",
            "skills": ["数据分析", "协作"],
        }]
        claim = (
            "我曾使用Python和SQL完成增长分析，并独立推动160次实验；"
            "这段经历让我能快速承担数据复盘与跨团队协作任务。"
        )
        draft = {
            "greeting": f"您好，我希望申请增长运营实习。{claim}",
            "email_subject": "应聘增长运营实习｜测试用户",
            "email_body": f"您好，我希望申请增长运营实习。{claim}期待进一步沟通团队当前最需要推进的问题。",
            "cover_letter": (
                "主题：应聘增长运营实习｜测试用户\n尊敬的招聘负责人：\n您好！我是测试用户。"
                f"{claim}{claim}{claim}希望进一步沟通团队当前最需要推进的问题。\n\n此致\n敬礼！\n姓名：测试用户"
            ),
            "used_evidence_ids": ["project-1"],
        }

        problems = _deterministic_problems(
            draft,
            {"role_name": "增长运营实习", "responsibilities": [], "requirements": []},
            evidence,
            {"name": "测试用户"},
        )

        self.assertTrue(any("未支持的工具" in problem for problem in problems))
        self.assertTrue(any("未支持的数字" in problem for problem in problems))

    def test_quality_gate_keeps_non_job_posts_out_of_ready_state(self) -> None:
        problems = _deterministic_problems(
            {
                "greeting": "您好，我希望进一步交流这次求职复盘中提到的经验和判断。",
                "email_subject": "求职复盘交流｜测试用户",
                "email_body": "您好，我阅读了这篇求职复盘，希望就其中的数据分析经验进一步交流，也愿意分享我在校园活动中的用户调研与转化数据复盘方法。",
                "cover_letter": (
                    "主题：求职复盘交流｜测试用户\n尊敬的招聘负责人：\n您好！我是测试用户。"
                    "我曾在校园活动中开展用户调研、复盘转化数据，并与团队协作调整执行方案。"
                    "我希望进一步交流这篇复盘中的方法，也愿意介绍自己的实践。"
                    "我会先明确交流目标，再整理事实和问题，确保沟通具体有效。"
                    "感谢您的阅读，期待进一步沟通。\n\n此致\n敬礼！\n姓名：测试用户"
                ),
                "used_evidence_ids": ["project-1"],
            },
            {"role_name": "求职复盘", "responsibilities": [], "requirements": []},
            [{"id": "project-1", "label": "校园活动", "detail": "用户调研；转化数据复盘"}],
            {"name": "测试用户"},
            {"title": "找实习完结：我的求职复盘", "body": "分享面试过程和上岸经历。"},
        )

        self.assertTrue(any("缺少可验证的招聘或投递信号" in problem for problem in problems))

    def test_external_link_normalization_rejects_unsafe_targets(self) -> None:
        self.assertEqual(_normalize_external_url("www.example.com/apply/42"), "https://www.example.com/apply/42")
        self.assertEqual(_normalize_external_url("javascript:alert(1)"), "")
        self.assertEqual(_normalize_external_url("http://127.0.0.1/private"), "")
        self.assertEqual(_normalize_external_url("https://user:secret@example.com/apply"), "")

    def test_application_method_in_image_extracts_and_verifies_routes(self) -> None:
        payload = {
            "quality_gate": {"passed": True, "checks": {}, "issues": []},
            "records": [{
                "note_id": "application-in-image",
                "title": "数据分析实习",
                "body": "岗位职责为业务数据分析，投递方式见图。",
                "media": {"images": [{"url": "https://img.example/job.jpg", "alt": "招聘海报", "source": "detail"}]},
            }],
        }
        report = enrich_payload(
            payload,
            {"projects": []},
            threshold=90,
            max_attempts=1,
            provider=ImageApplicationProvider(),
        )

        routes = payload["records"][0]["application_info"]["application_routes"]
        self.assertEqual(report.processed, 1)
        self.assertEqual({route["value"] for route in routes}, {
            "jobs@example.com",
            "https://www.example.com/apply/42",
            "https://blurred.example/apply",
        })
        self.assertTrue(all(route["source_field"] == "image" for route in routes))
        self.assertTrue(all(route["source_image_index"] == 1 for route in routes))
        actionable = {route["value"]: route["actionable"] for route in routes}
        self.assertTrue(actionable["jobs@example.com"])
        self.assertTrue(actionable["https://www.example.com/apply/42"])
        self.assertFalse(actionable["https://blurred.example/apply"])
        analysis = payload["records"][0]["media"]["analysis"]
        self.assertTrue(analysis["application_requested_in_image"])
        self.assertEqual(analysis["application_route_count"], 3)

    def test_same_route_in_body_and_image_is_cross_verified(self) -> None:
        payload = {
            "quality_gate": {"passed": True, "checks": {}, "issues": []},
            "records": [{
                "note_id": "cross-verified",
                "title": "数据分析实习",
                "body": "请将简历投递至 jobs@example.com，海报中也有投递方式。",
                "media": {"images": [{"url": "https://img.example/job.jpg", "alt": "招聘海报", "source": "detail"}]},
            }],
        }
        enrich_payload(payload, {"projects": []}, max_attempts=1, provider=CrossVerifiedApplicationProvider())

        routes = payload["records"][0]["application_info"]["application_routes"]
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0]["verification_status"], "cross_verified")
        self.assertEqual(routes[0]["source_fields"], ["body", "image"])
        self.assertTrue(routes[0]["actionable"])

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
            "claim_evidence_map": {"legacy": "unexpected-shape"},
            "records": [{"title": "增长运营实习", "body": "负责增长分析与协作推进。"}],
        }
        profile = {
            "candidate_application": {
                "name": "测试用户",
                "availabilityDays": "5",
                "internshipDuration": "6个月",
            },
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
        self.assertTrue(record["cover_letter_evaluation"]["modelPassed"])
        self.assertEqual(record["claim_validation"]["schemaVersion"], 1)
        self.assertEqual(record["claim_validation"]["status"], "passed")
        self.assertEqual(payload["claim_evidence_schema_version"], 1)
        self.assertEqual(payload["claim_evidence_map"][0]["noteId"], "record-1")
        self.assertEqual(record["application_info"]["application_routes"][0]["channel"], "email")
        self.assertEqual(record["application_info"]["application_routes"][0]["confidence"], 100)
        self.assertIn("简历随信附上", record["outreach"]["cover_letter"])
        self.assertNotIn("附件", record["outreach"]["cover_letter"])
        for section in ("application_routes", "responsibilities", "requirements"):
            for item in record["application_info"][section]:
                self.assertEqual(item["source_field"], "body")
                self.assertIn("offset_start", item)
                self.assertIn("offset_end", item)
        self.assertTrue(payload["quality_gate"]["checks"]["all_cover_letters_score_at_least_threshold"])
        self.assertTrue(payload["quality_gate"]["checks"]["all_generated_claims_evidence_valid"])

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
        self.assertEqual(record["outreach"]["runtime_status"], "image_enriched_missing_job_body")

    def test_image_only_record_uses_verified_ocr_text_to_complete_fields(self) -> None:
        payload = {
            "quality_gate": {"passed": True, "checks": {}, "issues": []},
            "records": [{
                "note_id": "poster-ocr",
                "title": "数据产品实习",
                "body": "",
                "media": {"images": [{"url": "https://img.example/job.webp", "source": "card"}]},
            }],
        }

        enrich_payload(payload, {"projects": []}, max_attempts=1, provider=PosterOcrProvider())

        record = payload["records"][0]
        self.assertEqual(
            [item["text"] for item in record["application_info"]["responsibilities"]],
            ["参与数据产品迭代策划并推进落地；", "负责市场调研和竞品调研；"],
        )
        self.assertEqual(
            [item["text"] for item in record["application_info"]["requirements"]],
            ["熟悉 SQL 和 Excel；"],
        )
        self.assertEqual(record["application_info"]["application_routes"][0]["value"], "jobs@example.com")
        self.assertEqual(record["media"]["analysis"]["source"], "vision_model")
        self.assertIn("参与数据产品迭代策划", record["media"]["analysis"]["visible_text"])
        self.assertEqual(record["outreach"]["runtime_status"], "image_enriched_missing_job_body")
        self.assertTrue(record_needs_completion(record))

    def test_caption_body_merges_cached_verified_ocr_into_job_card(self) -> None:
        caption = "深圳/香港实习丨腾讯 商业分析实习 2天前 福建"
        payload = {
            "quality_gate": {"passed": True, "checks": {}, "issues": []},
            "records": [{
                "note_id": "caption-with-poster",
                "title": "深圳/香港实习丨腾讯 商业分析实习",
                "body": caption,
                "job_card": {"parse_basis": "full_body", "enrichment_status": "ai_enriched"},
                "application_info": {
                    "contacts": [],
                    "application_routes": [],
                    "responsibilities": [{"text": caption}],
                    "requirements": [],
                },
                "media": {
                    "images": [{"url": "https://img.example/tencent.webp", "source": "card"}],
                    "analysis": {
                        "status": "analyzed",
                        "source": "vision_model",
                        "visible_text": (
                            "腾讯商业分析实习生(咨询业务)\n"
                            "HC要求\n"
                            "招聘2个日常实习HC\n"
                            "1、深圳滨海大厦onsite*1\n"
                            "2、香港客户项目地onsite*1(香港HC仅招香港院校在读同学，会说粤语/能完全听懂粤语的同学优先)"
                        ),
                    },
                },
            }],
        }
        record = payload["records"][0]
        events = []

        self.assertTrue(record_needs_completion(record))
        report = enrich_payload(
            payload,
            {"projects": []},
            max_attempts=1,
            provider=FakeProvider(),
            only_incomplete=True,
            progress_callback=lambda current, total, status, item: events.append({
                "current": current,
                "total": total,
                "status": status,
                "enrichment_status": (item.get("job_card") or {}).get("enrichment_status"),
                "requirements": [
                    fact.get("text")
                    for fact in (item.get("application_info") or {}).get("requirements", [])
                ],
            }),
        )

        requirements = [item["text"] for item in record["application_info"]["requirements"]]
        responsibilities = [item["text"] for item in record["application_info"]["responsibilities"]]
        self.assertEqual(report.processed, 1)
        self.assertEqual(record["job_card"]["enrichment_status"], "image_enriched")
        self.assertTrue(any("香港院校在读" in item for item in requirements))
        self.assertNotIn(caption, responsibilities)
        self.assertTrue(any(item.get("source_field") == "image" for item in record["application_info"]["requirements"]))
        self.assertTrue(record_needs_completion(record))
        self.assertEqual(events[0]["current"], 0)
        self.assertEqual(events[0]["total"], 1)
        self.assertEqual(events[0]["status"], "image_prefilled")
        self.assertEqual(events[0]["enrichment_status"], "image_enriched")
        self.assertTrue(any("香港院校在读" in item for item in events[0]["requirements"]))

    def test_poster_ocr_recognizes_common_candidate_and_role_headings(self) -> None:
        role = _deterministic_ocr_role(
            {"title": "招聘海报"},
            [(1, "项目候选人要求\n● 熟悉 SQL 和 Excel\n岗位描述：负责业务数据整理与分析")],
        )

        self.assertEqual([item["text"] for item in role["requirements"]], ["熟悉 SQL 和 Excel"])
        self.assertEqual([item["text"] for item in role["responsibilities"]], ["负责业务数据整理与分析"])

    def test_real_poster_labels_refresh_job_card_and_clean_private_message(self) -> None:
        payload = {
            "quality_gate": {"passed": True, "checks": {}, "issues": []},
            "records": [{
                "note_id": "poster-roche",
                "title": "招聘医学医药背景实习生",
                "card_author": "小周同学 48分钟前",
                "author": "小周同学",
                "body": "",
                "media": {"images": [{"url": "https://img.example/medical-job.webp", "source": "card"}]},
            }],
        }
        profile = {
            "candidate_application": {
                "name": "示例候选人",
                "school": "示例大学",
                "major": "公共管理",
                "availabilityDays": "5",
                "internshipDuration": "6个月",
            },
            "projects": [{
                "id": "project-1",
                "title": "市场调研项目",
                "actions": ["负责市场数据收集和整理", "协同团队完成结果汇报"],
                "skills": ["市场调研", "沟通协作"],
            }],
        }

        enrich_payload(payload, profile, max_attempts=1, provider=RochePosterOcrProvider())

        record = payload["records"][0]
        greeting = record["outreach"]["greeting"]
        self.assertEqual(record["job_card"]["role_name"], "实习医学信息沟通员")
        self.assertIn("市场数据收集和整理", record["application_info"]["responsibilities"][0]["text"])
        self.assertIn("沟通能力和执行力", record["application_info"]["requirements"][0]["text"])
        self.assertTrue(greeting.startswith("您好，我是示例候选人"))
        self.assertIn("实习医学信息沟通员", greeting)
        self.assertIn("是否仍在招聘", greeting)
        self.assertNotIn("小周同学", greeting)
        self.assertNotIn("48分钟前", greeting)

    def test_unreadable_poster_stops_after_one_grounded_ocr_call(self) -> None:
        payload = {
            "quality_gate": {"passed": True, "checks": {}, "issues": []},
            "records": [{
                "note_id": "unreadable-poster",
                "title": "招聘海报",
                "body": "",
                "media": {"images": [{"url": "https://img.example/unreadable.webp", "source": "card"}]},
            }],
        }
        provider = UnreadablePosterProvider()

        report = enrich_payload(payload, {"projects": []}, max_attempts=1, provider=provider)

        record = payload["records"][0]
        self.assertEqual(report.processed, 1)
        self.assertEqual(provider.calls, 1)
        self.assertEqual(record["media"]["analysis"]["source"], "none")
        self.assertEqual(record["job_card"]["enrichment_status"], "source_incomplete")
        self.assertEqual(record["outreach"]["runtime_status"], "fallback_missing_job_body")

    def test_explicit_completion_targets_skip_already_completed_records(self) -> None:
        payload = {
            "quality_gate": {"passed": True, "checks": {}, "issues": []},
            "records": [
                {"note_id": "complete", "title": "完整岗位", "body": "负责业务分析与协作推进。"},
                {"note_id": "target", "title": "待补全岗位", "body": "负责增长分析与协作推进。"},
            ],
        }
        events = []

        report = enrich_payload(
            payload,
            {"projects": []},
            max_attempts=3,
            provider=FakeProvider(),
            target_note_ids={"target"},
            progress_callback=lambda current, total, status, record: events.append((current, total, status)),
        )

        self.assertEqual(report.processed, 1)
        self.assertEqual(report.skipped, 1)
        self.assertEqual(events[0][:2], (1, 1))
        self.assertNotIn("job_card", payload["records"][0])
        self.assertEqual(payload["records"][1]["job_card"]["enrichment_status"], "ai_enriched")
        self.assertEqual(payload["ai_workflow"]["generationCoveragePercent"], 50.0)
        issue_messages = [item["message"] for item in payload["quality_gate"]["issues"]]
        self.assertIn("1 scraped jobs have no generated job card", issue_messages)
        self.assertIn("1 scraped jobs have no editable application copy", issue_messages)

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
            "candidate_application": {
                "name": "测试候选人",
                "availabilityDays": "5",
                "internshipDuration": "6个月",
            },
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
        self.assertEqual(events, [(1, 1, "needs_review")])
        record = payload["records"][0]
        self.assertEqual(record["outreach"]["runtime_status"], "fallback_model_error")
        self.assertEqual(record["outreach"]["status"], "needs_review")
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
