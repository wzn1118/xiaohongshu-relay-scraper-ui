from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from application_intelligence_agents import OutreachWriterAgent, build_job_card  # noqa: E402
from codex_runtime_outreach import _resolve_email_subject  # noqa: E402
from job_role_title import normalize_role_title  # noqa: E402


class JobRoleTitleTests(unittest.TestCase):
    def test_keeps_content_recommendation_intern_role(self) -> None:
        self.assertEqual(
            normalize_role_title("内容推荐实习生"),
            "内容推荐实习生",
        )

    def test_noisy_application_subject_becomes_role_only(self) -> None:
        self.assertEqual(
            normalize_role_title("应聘成都内容运营实习生/剪辑实习生招继任｜王梓楠"),
            "内容运营实习生/剪辑实习生",
        )

    def test_recruitment_prefix_supports_multiple_roles(self) -> None:
        self.assertEqual(
            normalize_role_title("招聘｜内容运营实习生｜剪辑实习生"),
            "内容运营实习生/剪辑实习生",
        )

    def test_genuine_role_name_and_specialization_are_preserved(self) -> None:
        for value in (
            "商业分析实习生（咨询业务）",
            "某公司商业分析实习生(咨询业务)",
            "商业分析实习生｜咨询业务",
            "成都内容运营实习生",
        ):
            with self.subTest(value=value):
                self.assertEqual(normalize_role_title(value), value)

    def test_job_card_keeps_raw_title_without_promoting_it_to_role_name(self) -> None:
        raw_title = "成都内容运营实习生/剪辑实习生招继任"

        job_card = build_job_card(
            {"title": raw_title, "note_url": "https://example.test/note/1"},
            {"contacts": [], "application_routes": [], "responsibilities": [], "requirements": []},
            body_present=False,
        )

        self.assertEqual(job_card["title"], raw_title)
        self.assertEqual(job_card["role_name"], "")

    def test_writer_and_explicit_subject_never_reuse_noisy_title(self) -> None:
        raw_title = "应聘成都内容运营实习生/剪辑实习生招继任｜王梓楠"
        writer = OutreachWriterAgent({
            "candidate_application": {
                "name": "王梓楠",
                "availabilityDays": "5",
            },
        })

        outreach = writer.run(
            {"title": raw_title, "job_card": {"role_name": "内容运营实习生/剪辑实习生"}},
            {"responsibilities": [], "requirements": []},
            [],
        )
        explicit_subject = _resolve_email_subject(
            "",
            {"title": "内容运营实习生/剪辑实习生", "body_excerpt": "邮件标题：姓名-应聘岗位"},
            "王梓楠",
            {"name": "王梓楠"},
        )

        raw_title_subject = _resolve_email_subject(
            "",
            {"title": "", "body_excerpt": ""},
            "王梓楠",
            {"name": "王梓楠"},
        )

        self.assertIn("内容运营实习生/剪辑实习生", outreach["email_subject"])
        self.assertNotIn("招继任", outreach["email_subject"])
        self.assertNotIn("成都", outreach["greeting"])
        self.assertEqual(explicit_subject, "王梓楠-内容运营实习生/剪辑实习生")
        self.assertEqual(raw_title_subject, "应聘岗位｜王梓楠")

    def test_rejects_recruitment_copy_and_generic_internship_labels(self) -> None:
        for value in (
            "急急急！有8月能来实习的吗？蹲继任",
            "实习找继任",
            "岗位职责：协助产品需求分析",
            "深圳/香港实习",
        ):
            with self.subTest(value=value):
                self.assertEqual(normalize_role_title(value), "")

        self.assertEqual(
            normalize_role_title("小红书产品运营实习生｜组招继任"),
            "小红书产品运营实习生",
        )


if __name__ == "__main__":
    unittest.main()
