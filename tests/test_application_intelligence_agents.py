from __future__ import annotations

import json
import hashlib
import io
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock


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
from codex_runtime_outreach import CodexRuntimeOutreachAgent, _prompt  # noqa: E402
import parallel_body_completion as body_completion  # noqa: E402
import run_project_workflow as workflow  # noqa: E402
from parallel_body_completion import (  # noqa: E402
    contains_security_verification,
    detail_url_candidates,
    record_is_complete,
    record_key,
)


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
        record = result.payload["records"][0]
        self.assertFalse(record["quality"]["body_present"])
        self.assertEqual(record["outreach"]["status"], "needs_review")
        self.assertEqual(record["outreach"]["runtime_status"], "fallback_missing_job_body")
        self.assertEqual(record["job_card"]["parse_basis"], "search_card")
        self.assertEqual(record["job_card"]["status"], "generated")
        self.assertTrue(record["quality"]["job_card_generated"])
        self.assertTrue(record["quality"]["outreach_generated"])
        self.assertTrue(all(record["outreach"][field] for field in ("greeting", "email_subject", "email_body", "cover_letter")))
        self.assertTrue(result.payload["quality_gate"]["checks"]["all_scraped_jobs_have_job_cards"])
        self.assertTrue(result.payload["quality_gate"]["checks"]["all_scraped_jobs_have_application_copy"])

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

    def test_cover_letter_prompt_includes_runtime_candidate_profile(self) -> None:
        prompt = _prompt(
            [{"note_id": "n1", "title": "Data analyst intern", "body": "Role evidence."}],
            "",
            {
                "name": "Example Candidate",
                "school": "Example University",
                "major": "Data Analytics",
                "degreeYear": "Year 2",
                "phoneWeChat": "contact-placeholder",
                "email": "candidate@example.com",
                "availabilityDays": "5",
                "internshipDuration": "6 months",
            },
        )
        self.assertIn("Example Candidate", prompt)
        self.assertIn("Example University", prompt)
        self.assertIn("candidate@example.com", prompt)
        self.assertIn("每周可实习", prompt)
        self.assertIn("6 months", prompt)

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
        self.assertEqual(len(result.payload["records"]), 2)
        self.assertEqual(gate["job_cards_generated"], 2)
        self.assertEqual(gate["application_copy_generated"], 2)
        self.assertTrue(gate["checks"]["all_scraped_jobs_have_job_cards"])
        self.assertTrue(gate["checks"]["all_scraped_jobs_have_application_copy"])

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
            self.assertEqual(result.payload["codex_runtime"]["prompt_version"], "xhs-outreach-v3")
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
        legacy_false_success = {
            "note_id": "n1",
            "body": "访问频繁，请稍后再试",
            "access_status": "detail_ok",
        }
        self.assertEqual(record_key(complete), "n1")
        self.assertTrue(record_is_complete(complete))
        self.assertFalse(record_is_complete(fallback))
        self.assertFalse(record_is_complete(legacy_false_success))
        self.assertTrue(contains_security_verification("请完成安全验证后继续"))
        self.assertFalse(contains_security_verification("岗位详情正常展示"))

    def test_parallel_completion_prioritizes_and_deduplicates_detail_urls(self) -> None:
        card = {
            "explore_url": "https://example.com/explore/n1",
            "search_result_url": "https://example.com/search/n1",
            "note_url": "https://example.com/explore/n1",
        }
        self.assertEqual(
            detail_url_candidates(card),
            ["https://example.com/explore/n1", "https://example.com/search/n1"],
        )

    def test_security_timeout_stops_new_access_and_preserves_checkpoint(self) -> None:
        class FakeLocator:
            def inner_text(self, **_kwargs):
                return "请完成安全验证后继续"

        class FakePage:
            def locator(self, _selector):
                return FakeLocator()

            def close(self):
                return None

        class FakeContext:
            def new_page(self):
                return FakePage()

        class FakePlaywright:
            def __enter__(self):
                return object()

            def __exit__(self, *_args):
                return False

        calls = []
        context = FakeContext()

        class FakeUpstream:
            @staticmethod
            def connect_browser(_playwright, _relay_port):
                return object()

            @staticmethod
            def get_or_create_context(_browser):
                return context

            @staticmethod
            def scrape_note(_page, card, **_kwargs):
                calls.append(card["note_id"])
                raise RuntimeError("请完成安全验证后继续")

        playwright_package = types.ModuleType("playwright")
        playwright_sync = types.ModuleType("playwright.sync_api")
        playwright_sync.sync_playwright = FakePlaywright

        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            cards = [
                {"note_id": "n1", "note_url": "https://example.test/explore/n1"},
                {"note_id": "n2", "note_url": "https://example.test/explore/n2"},
            ]
            (output / "xiaohongshu_cards_latest.json").write_text(
                json.dumps(cards, ensure_ascii=False),
                encoding="utf-8",
            )
            monotonic_values = iter((0.0, 10.0, 20.0, 30.0))
            original_loader = body_completion.load_upstream
            original_monotonic = body_completion.time.monotonic
            original_sleep = body_completion.time.sleep
            try:
                body_completion.load_upstream = lambda _path: FakeUpstream()
                body_completion.time.monotonic = lambda: next(monotonic_values)
                body_completion.time.sleep = lambda _seconds: None
                with mock.patch.dict(
                    sys.modules,
                    {"playwright": playwright_package, "playwright.sync_api": playwright_sync},
                ):
                    summary = body_completion.complete_bodies(
                        output,
                        relay_port=18792,
                        workers=2,
                        attempts=3,
                        security_verification_timeout_seconds=5,
                    )
            finally:
                body_completion.load_upstream = original_loader
                body_completion.time.monotonic = original_monotonic
                body_completion.time.sleep = original_sleep

            self.assertEqual(summary["stopReason"], "security_verification_timeout")
            self.assertTrue(summary["newAccessStopped"])
            self.assertEqual(summary["securityVerification"]["status"], "timed_out")
            self.assertEqual(summary["securityVerification"]["recoveryAction"], "manual_verification_then_resume")
            self.assertLessEqual(len(calls), 2)
            self.assertEqual(
                json.loads((output / "xiaohongshu_notes_latest.json").read_text(encoding="utf-8")),
                [],
            )

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
        self.assertEqual(summary["jobCardsGenerated"], 2)
        self.assertEqual(summary["applicationCopyGenerated"], 2)
        self.assertEqual(summary["generationCoveragePercent"], 100.0)
        self.assertEqual(summary["applicationInfo"], 2)
        self.assertEqual(summary["draftsGenerated"], 2)
        self.assertEqual(len(summary["agentStages"]), 8)

    def test_workflow_summary_does_not_misclassify_generic_partial_collection(self) -> None:
        cards = [{"note_id": "n1", "title": "AI one"}]
        result = ApplicationIntelligencePipeline(PROFILE, now=COLLECTED).run(cards, [])
        summary = build_workflow_summary(
            result.payload,
            {"transitionedToAnalysis": True, "stopReason": "scrape_runner_failed"},
        )

        self.assertEqual(summary["status"], "completed_partial")
        self.assertEqual(summary["analysisMode"], "partial_collection")
        self.assertEqual(summary["collectionStopReason"], "scrape_runner_failed")
        self.assertEqual(summary["securityVerification"], {})

    def test_workflow_summary_marks_only_explicit_security_timeout(self) -> None:
        cards = [{"note_id": "n1", "title": "AI one"}]
        result = ApplicationIntelligencePipeline(PROFILE, now=COLLECTED).run(cards, [])
        summary = build_workflow_summary(
            result.payload,
            {
                "transitionedToAnalysis": True,
                "stopReason": "security_verification_timeout",
                "securityVerification": {"status": "timed_out", "timeoutSeconds": 90},
            },
        )

        self.assertEqual(summary["analysisMode"], "security_timeout_partial")
        self.assertEqual(summary["securityVerification"]["status"], "timed_out")

    def test_search_security_exit_materializes_partial_results_for_resume(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "run" / "artifacts"
            output.mkdir(parents=True)
            profile = Path(temporary) / "profile.json"
            profile.write_text(json.dumps(PROFILE, ensure_ascii=False), encoding="utf-8")
            (output / "xiaohongshu_cards_latest.json").write_text(
                json.dumps(
                    [{"note_id": "n1", "note_url": "https://example.test/n1", "title": "AI 岗位"}],
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (output / "security-restriction.json").write_text(
                json.dumps(
                    {
                        "status": "timed_out",
                        "phase": "search_discovery",
                        "timeoutSeconds": 600,
                        "recoveryAction": "manual_verification_then_resume",
                    }
                ),
                encoding="utf-8",
            )

            with mock.patch.object(workflow, "resolve_upstream_runner", return_value=Path("runner.py")):
                with mock.patch.object(
                    workflow.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess(["runner"], 3),
                ):
                    return_code = workflow.main(
                        [
                            "--output-dir",
                            str(output),
                            "--candidate-profile",
                            str(profile),
                        ]
                    )

            summary = json.loads((output / "workflow-summary.json").read_text(encoding="utf-8"))
            self.assertEqual(return_code, 3)
            self.assertEqual(summary["analysisMode"], "security_timeout_partial")
            self.assertEqual(summary["collectionStopReason"], "security_verification_timeout")
            self.assertEqual(summary["securityVerification"]["phase"], "search_discovery")
            self.assertEqual(summary["jobCardsGenerated"], 1)
            self.assertEqual(summary["applicationCopyGenerated"], 1)

    def test_project_manifest_hashes_every_artifact_except_itself(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            (output / "nested").mkdir()
            (output / "one.json").write_text('{"ok":true}', encoding="utf-8")
            (output / "nested" / "two.csv").write_text("a,b\n1,2\n", encoding="utf-8")
            (output / "workflow.stderr.log").write_text("", encoding="utf-8")
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
