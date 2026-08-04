import unittest
from pathlib import Path

from scripts.application_generation import (
    build_generation_payload,
    build_profile_snapshot,
    generation_writeback_endpoint,
    writeback_generated_drafts,
)


class ApplicationGenerationTests(unittest.TestCase):
    def setUp(self):
        self.profile = {
            "generated_at": "2026-08-04T10:00:00+08:00",
            "candidate": {"name": "测试候选人", "school": "测试大学"},
            "evidence_items": [{
                "id": "e-ai",
                "category": "project",
                "label": "AI 数据工作台",
                "detail": "从零搭建数据分析交付流程，沉淀用户 query 与案例分类。",
                "role_axis": "ai_product",
            }],
            "sources": [{
                "id": "mkt",
                "filename": "resume-mkt.pdf",
                "path": "C:/does-not-exist/resume-mkt.pdf",
                "sha256": "A" * 64,
                "pages": 1,
            }],
        }

    def test_snapshot_is_stable_and_omits_local_path(self):
        first = build_profile_snapshot(self.profile, Path("C:/artifacts"))
        second = build_profile_snapshot(self.profile, Path("C:/other"))
        self.assertEqual(first["profileSnapshotId"], second["profileSnapshotId"])
        self.assertNotIn("path", first["resumeArtifacts"][0])
        self.assertEqual(first["resumeArtifacts"][0]["sha256"], "a" * 64)

    def test_generation_payload_only_contains_ready_records(self):
        snapshot = build_profile_snapshot(self.profile)
        payload = build_generation_payload([
            {
                "note_id": "note-1",
                "title": "AI 产品运营",
                "application_info": {"requirements": ["用户研究"]},
                "outreach": {
                    "status": "ready",
                    "greeting": "你好，我是测试候选人，申请 AI 产品运营。",
                    "email_subject": "AI 产品运营申请",
                    "email_body": "你好，我曾围绕用户 query 建立分析交付流程，期待沟通岗位当前重点。",
                    "cover_letter": "主题：AI 产品运营申请\n" + "正文" * 150,
                    "used_evidence_ids": ["e-ai"],
                    "recommended_resume": "mkt",
                },
            },
            {"note_id": "note-2", "outreach": {"status": "blocked_codex_runtime"}},
        ], snapshot, run_id="run-1", prompt_version="v11")
        self.assertEqual(payload["runId"], "run-1")
        self.assertEqual([item["noteId"] for item in payload["items"]], ["note-1"])
        self.assertEqual(payload["items"][0]["generation"]["usedEvidenceIds"], ["e-ai"])
        self.assertEqual(payload["items"][0]["generation"]["recommendedResumeId"], "mkt")

        rebuilt = build_generation_payload([
            {
                "note_id": "note-1",
                "title": "AI 产品运营",
                "outreach": {
                    "status": "ready",
                    "greeting": "你好，我是测试候选人，申请 AI 产品运营。",
                    "email_subject": "AI 产品运营申请",
                    "email_body": "你好，我曾围绕用户 query 建立分析交付流程，期待沟通岗位当前重点。",
                    "cover_letter": "主题：AI 产品运营申请\n" + "正文" * 150,
                    "recommended_resume": "stale-id",
                    "resume_reason": "旧版本",
                },
            },
        ], snapshot, run_id="run-2")
        self.assertEqual(rebuilt["items"][0]["generation"]["recommendedResumeId"], "")
        self.assertEqual(rebuilt["items"][0]["generation"]["resumeReason"], "")

    def test_endpoint_and_writeback_status(self):
        endpoint = generation_writeback_endpoint("http://127.0.0.1:5173", "20260804100000-abcdef12")
        self.assertEqual(endpoint, "http://127.0.0.1:5173/api/jobs/20260804100000-abcdef12/application-generation/writeback")
        seen = {}

        def fake_post(url, payload, *, timeout_seconds):
            seen["url"] = url
            seen["payload"] = payload
            return {"status": "completed", "requested": 1, "saved": 1, "items": [{"noteId": "note-1", "status": "saved"}]}

        result = writeback_generated_drafts(
            {"runId": "run-1", "items": [{"noteId": "note-1"}]},
            writeback_url=endpoint,
            post=fake_post,
        )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(seen["url"], endpoint)

    def test_empty_generation_skips_writeback_request(self):
        def unexpected_post(*_args, **_kwargs):
            raise AssertionError("empty payload should not be posted")

        result = writeback_generated_drafts(
            {"runId": "run-empty", "items": []},
            writeback_url="http://127.0.0.1:5173/api/jobs/job-1/application-generation/writeback",
            post=unexpected_post,
        )

        self.assertEqual(result, {"status": "skipped_empty", "requested": 0, "saved": 0, "items": []})


if __name__ == "__main__":
    unittest.main()
