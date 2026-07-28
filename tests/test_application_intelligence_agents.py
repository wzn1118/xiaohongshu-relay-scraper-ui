from __future__ import annotations

import json
import hashlib
import io
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from application_intelligence_agents import (  # noqa: E402
    ApplicationInfoAgent,
    ApplicationIntelligencePipeline,
    normalize_publish_time,
    run_pipeline,
)
from run_project_workflow import (  # noqa: E402
    DEFAULT_CANDIDATE_PROFILE,
    PROJECT_ROOT,
    build_workflow_summary,
    emit_stage,
    resolve_project_path,
    rewrite_limit,
    rewrite_unlimited_args,
    write_project_manifest,
)
from codex_runtime_outreach import CodexRuntimeOutreachAgent  # noqa: E402
from parallel_body_completion import contains_security_verification, record_is_complete, record_key  # noqa: E402


TZ = timezone(timedelta(hours=8), name="Asia/Shanghai")
COLLECTED = datetime(2026, 7, 28, 9, 31, 42, tzinfo=TZ)
PROFILE = {
    "name": "示例用户",
    "evidence_items": [
        {
            "id": "github-ai-project",
            "category": "project",
            "label": "AI Agent 项目",
            "detail": "使用 Python、Codex 和 Agent 工作流完成数据分析自动化。",
            "source": "https://github.com/example/project",
        },
        {
            "id": "marketing-experience",
            "category": "experience",
            "label": "内容营销经历",
            "detail": "负责社交媒体内容运营、市场调研和英文沟通。",
            "source": "resume.pdf",
        },
    ],
}


class TimeNormalizationTests(unittest.TestCase):
    def test_relative_and_absolute_time_normalization(self) -> None:
        cases = {
            "昨天 20:05 北京": ("2026-07-27T20:05+08:00", "minute", False),
            "前天 08:10": ("2026-07-26T08:10+08:00", "minute", False),
            "3天前": ("2026-07-25", "day", False),
            "6天前": ("2026-07-22", "day", False),
            "2小时前": ("2026-07-28T07:31+08:00", "relative_hour", True),
            "15分钟前": ("2026-07-28T09:16+08:00", "relative_minute", True),
            "2026-07-27 18:30": ("2026-07-27T18:30+08:00", "minute", False),
            "7月27日 12:00": ("2026-07-27T12:00+08:00", "minute", False),
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                result = normalize_publish_time(raw, COLLECTED)
                self.assertEqual((result["value"], result["precision"], result["is_estimated"]), expected)

    def test_date_only_does_not_invent_clock_time(self) -> None:
        result = normalize_publish_time("昨天", COLLECTED)
        self.assertEqual(result["value"], "2026-07-27")
        self.assertEqual(result["precision"], "day")


class ApplicationAgentTests(unittest.TestCase):
    def test_extracts_application_data_with_provenance(self) -> None:
        note = {
            "body": "岗位职责：负责内容运营和数据分析。要求英语好，熟练使用Codex，每周到岗4天。简历投递：jobs@example.com，也可以私信我。微信：hire_2026",
            "title": "AI产品运营实习",
        }
        result = ApplicationInfoAgent().run(note)
        self.assertEqual({item["type"] for item in result["contacts"]}, {"email", "wechat"})
        self.assertTrue(result["requirements"])
        self.assertTrue(result["responsibilities"])
        self.assertTrue(all(item["source_field"] and item["evidence"] for item in result["contacts"]))
        self.assertTrue(all(item["source_field"] == "body" for item in result["requirements"]))

    def test_complete_pipeline_uses_only_loaded_evidence(self) -> None:
        card = {"note_id": "n1", "title": "AI产品运营实习", "note_url": "https://example/n1"}
        note = {
            **card,
            "body": "要求英语好，擅长Codex和AI工具。请投递到 jobs@example.com",
            "publish_time": "昨天 20:05 北京",
            "scraped_at": "2026-07-28T09:31:42",
            "access_status": "detail_ok",
        }
        result = ApplicationIntelligencePipeline(PROFILE, now=COLLECTED).run([card], [note])
        self.assertTrue(result.passed)
        record = result.payload["records"][0]
        self.assertEqual(record["publish_time"]["value"], "2026-07-27T20:05+08:00")
        self.assertIn("Codex", record["outreach"]["email_body"])
        self.assertTrue(set(record["outreach"]["used_evidence_ids"]) <= {"github-ai-project", "marketing-experience"})

    def test_unmatched_note_uses_explicit_general_background(self) -> None:
        profile = {
            "name": "示例用户",
            "evidence_items": [
                {
                    "id": "resume-skills",
                    "category": "skills",
                    "label": "英语、数据与内容工具",
                    "detail": "三份简历共同确认的英语、Excel 和内容工具背景。",
                    "source": "resume.pdf",
                }
            ],
        }
        card = {"note_id": "n1", "title": "法务实习", "note_url": "https://example/n1"}
        note = {
            **card,
            "body": "请按正文中的方式申请。",
            "scraped_at": "2026-07-28T09:31:42",
            "access_status": "detail_ok",
        }
        result = ApplicationIntelligencePipeline(profile, now=COLLECTED).run([card], [note])
        self.assertTrue(result.passed)
        outreach = result.payload["records"][0]["outreach"]
        self.assertEqual(outreach["status"], "ready")
        self.assertNotIn("简历", outreach["email_body"])
        self.assertNotIn("附件", outreach["email_body"])
        self.assertNotIn("岗位方向与我的经历", outreach["greeting"])

    def test_card_fallback_is_not_counted_as_full_body(self) -> None:
        card = {"note_id": "n1", "title": "AI实习", "note_url": "https://example/n1"}
        note = {
            **card,
            "body": "搜索卡片摘要",
            "scraped_at": "2026-07-28T09:31:42",
            "access_status": "detail_timeout",
        }
        result = ApplicationIntelligencePipeline(PROFILE, now=COLLECTED).run([card], [note])
        self.assertFalse(result.passed)
        self.assertEqual(result.payload["quality_gate"]["body_count"], 0)
        self.assertFalse(result.payload["records"][0]["quality"]["body_present"])
        self.assertEqual(result.payload["records"][0]["outreach"]["status"], "blocked_missing_job_body")

    def test_codex_runtime_applies_structured_per_link_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            fake_cli = output / "codex.cmd"
            fake_cli.write_text("@echo off\n", encoding="utf-8")

            def fake_run(command, **kwargs):
                response_path = Path(command[command.index("--output-last-message") + 1])
                response_path.write_text(
                    json.dumps({"items": [{
                        "note_id": "n1",
                        "greeting": "您好，我留意到内容运营实习岗位，相关内容策划与数据分析经历和岗位需求匹配。",
                        "email_subject": "应聘内容运营实习-示例用户",
                        "email_body": "您好：\n我希望申请内容运营实习。我的内容营销经历包含社交媒体内容运营、市场调研和英文沟通，可对应岗位要求。附件为简历，谢谢。",
                        "cover_letter": "您好：\n我申请内容运营实习。岗位强调内容策划与数据分析，我在内容营销经历中负责社交媒体内容运营与市场调研，并可使用英语进行沟通。期待进一步交流，谢谢。",
                        "used_evidence_ids": ["marketing-experience"],
                        "requirement_matches": ["内容运营对应内容营销经历"],
                        "recommended_resume": "用户运营",
                        "resume_reason": "岗位核心职责为内容运营。",
                    }]}, ensure_ascii=False),
                    encoding="utf-8",
                )
                return subprocess.CompletedProcess(command, 0, "", "")

            record = {
                "note_id": "n1",
                "note_url": "https://example/n1",
                "title": "内容运营实习",
                "body": "负责内容策划，要求具备数据分析能力。",
                "publish_time": {"value": "2026-07-22"},
                "application_info": {"responsibilities": [], "requirements": [], "application_routes": [], "contacts": []},
                "fit_evidence": [PROFILE["evidence_items"][1]],
                "quality": {"body_present": True},
                "outreach": {},
            }
            agent = CodexRuntimeOutreachAgent(output, candidate_name="示例用户", cli_bin=str(fake_cli), run_command=fake_run)
            report = agent.enrich([record])
            self.assertEqual(report.generated, 1)
            self.assertEqual(record["outreach"]["generation_mode"], "codex_cli_runtime")
            self.assertEqual(record["outreach"]["recommended_resume"], "")

    def test_quality_gate_detects_partial_collection_and_missing_body(self) -> None:
        cards = [
            {"note_id": "n1", "title": "one"},
            {"note_id": "n2", "title": "two"},
        ]
        notes = [
            {
                "note_id": "n1",
                "title": "one",
                "body": "",
                "scraped_at": "2026-07-28T09:31:42",
            }
        ]
        result = ApplicationIntelligencePipeline(PROFILE, now=COLLECTED).run(cards, notes)
        self.assertFalse(result.passed)
        gate = result.payload["quality_gate"]
        self.assertEqual(gate["discovered_count"], 2)
        self.assertEqual(gate["covered_discovered_count"], 1)
        self.assertFalse(gate["checks"]["all_discovered_notes_have_records"])
        self.assertFalse(gate["checks"]["all_records_have_bodies"])

    def test_writes_all_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            (output / "xiaohongshu_cards_latest.json").write_text(
                json.dumps([{"note_id": "n1", "title": "AI实习"}], ensure_ascii=False), encoding="utf-8"
            )
            (output / "xiaohongshu_notes_latest.json").write_text(
                json.dumps(
                    [
                        {
                            "note_id": "n1",
                            "title": "AI实习",
                            "body": "\x05=需要Python经验，邮箱 jobs@example.com",
                            "scraped_at": "2026-07-28T09:31:42",
                        }
                    ],
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            profile_path = output / "candidate.json"
            profile_path.write_text(json.dumps(PROFILE, ensure_ascii=False), encoding="utf-8")
            result = run_pipeline(output, profile_path, now=COLLECTED)
            self.assertTrue(result.passed)
            self.assertEqual(result.payload["codex_runtime"]["prompt_version"], "xhs-outreach-v2")
            for name in (
                "application_intelligence.json",
                "application_intelligence.csv",
                "application_intelligence.xlsx",
                "application_intelligence_summary.json",
                "application_intelligence_report.md",
                "coverage_report.json",
            ):
                self.assertTrue((output / name).is_file(), name)
            payload = json.loads((output / "application_intelligence.json").read_text(encoding="utf-8"))
            self.assertTrue(payload["records"][0]["body"].startswith("\x05="))
            from openpyxl import load_workbook

            workbook = load_workbook(output / "application_intelligence.xlsx", read_only=True)
            self.assertEqual(workbook["Applications"]["J2"].value[:2], "'=")
            workbook.close()


class WorkflowWrapperTests(unittest.TestCase):
    def test_limit_is_always_rewritten_to_unlimited(self) -> None:
        self.assertEqual(
            rewrite_unlimited_args(["--limit", "20", "--max-scrolls", "40"]),
            ["--max-scrolls", "40", "--limit", "0"],
        )
        self.assertEqual(rewrite_unlimited_args(["--limit=200"]), ["--limit", "0"])

    def test_bootstrap_limit_is_internal_and_bounded(self) -> None:
        self.assertEqual(
            rewrite_limit(["--limit", "20", "--max-scrolls", "40"], 1),
            ["--max-scrolls", "40", "--limit", "1"],
        )

    def test_parallel_completion_requires_full_detail_body(self) -> None:
        complete = {"note_id": "n1", "body": "full body", "access_status": "detail_ok"}
        fallback = {"note_id": "n1", "body": "card text", "access_status": "detail_timeout"}
        self.assertEqual(record_key(complete), "n1")
        self.assertTrue(record_is_complete(complete))
        self.assertFalse(record_is_complete(fallback))
        self.assertTrue(contains_security_verification("请完成安全验证后继续"))
        self.assertFalse(contains_security_verification("岗位详情正常展示"))

    def test_default_candidate_profile_is_project_relative(self) -> None:
        self.assertEqual(DEFAULT_CANDIDATE_PROFILE, PROJECT_ROOT / "profiles/candidate_profile.json")
        self.assertEqual(resolve_project_path("profiles/candidate_profile.json"), DEFAULT_CANDIDATE_PROFILE.resolve())

    def test_stage_lines_follow_job_manager_contract(self) -> None:
        stream = io.StringIO()
        with redirect_stdout(stream):
            for index, label in enumerate(("coverage", "time", "memory", "info", "capabilities", "outreach", "review", "quality"), start=1):
                emit_stage(index, label)
        lines = stream.getvalue().splitlines()
        self.assertEqual(len(lines), 8)
        self.assertEqual(lines[0], "AGENT_STAGE 1/8 coverage completed")
        self.assertEqual(lines[-1], "AGENT_STAGE 8/8 quality completed")

    def test_workflow_summary_exposes_frontend_metrics(self) -> None:
        cards = [{"note_id": "n1", "title": "AI one"}, {"note_id": "n2", "title": "AI two"}]
        notes = [
            {
                "note_id": "n1",
                "title": "AI one",
                "body": "要求熟练使用Codex，邮箱 jobs@example.com",
                "publish_time": "昨天 20:05",
                "scraped_at": "2026-07-28T09:31:42",
            },
            {
                "note_id": "n2",
                "title": "AI two",
                "body": "需要AI项目经验，可以私信。",
                "publish_time": "2小时前",
                "scraped_at": "2026-07-28T09:31:42",
            },
        ]
        result = ApplicationIntelligencePipeline(PROFILE, now=COLLECTED).run(cards, notes)
        summary = build_workflow_summary(result.payload)
        self.assertEqual(summary["cardsDiscovered"], 2)
        self.assertEqual(summary["notesCollected"], 2)
        self.assertEqual(summary["bodiesCaptured"], 2)
        self.assertEqual(summary["bodyCoveragePercent"], 100.0)
        self.assertEqual(summary["timeNormalizedCount"], 2)
        self.assertEqual(summary["exactTimeCount"], 1)
        self.assertEqual(summary["estimatedTimeCount"], 1)
        self.assertGreaterEqual(summary["contactsFound"], 1)
        self.assertEqual(summary["greetingsGenerated"], 2)
        self.assertEqual(summary["emailsGenerated"], 2)
        self.assertEqual(len(summary["agentStages"]), 8)

    def test_project_manifest_hashes_every_artifact_except_itself(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            (output / "nested").mkdir()
            (output / "one.json").write_text('{"ok":true}', encoding="utf-8")
            (output / "nested" / "two.csv").write_text("a,b\n1,2\n", encoding="utf-8")
            (output / "artifact-manifest.json").write_text("stale", encoding="utf-8")
            summary = {
                "checks": {"coverage": True, "quality": True},
                "issues": [],
                "notesCollected": 2,
                "bodiesCaptured": 2,
            }
            manifest_path = write_project_manifest(output, summary)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["runner"], "xiaohongshu-project-workflow")
            self.assertEqual(manifest["status"], "succeeded")
            self.assertEqual({item["path"] for item in manifest["artifacts"]}, {"one.json", "nested/two.csv"})
            for item in manifest["artifacts"]:
                artifact = output / Path(item["path"])
                self.assertEqual(item["bytes"], artifact.stat().st_size)
                self.assertEqual(item["sha256"], hashlib.sha256(artifact.read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
