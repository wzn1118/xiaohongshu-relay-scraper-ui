from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from evidence_claim_validator import (  # noqa: E402
    build_evidence_sources,
    claim_validation_is_current,
    validate_claim_binding,
    validate_generated_claims,
)
import recheck_application_draft as recheck  # noqa: E402


def fixture_profile() -> dict:
    return {
        "candidate_application": {
            "name": "林舟",
            "school": "远航大学",
            "availabilityDays": "5",
            "internshipDuration": "6个月",
        },
        "experiences": [{
            "id": "experience-1",
            "organization": "星海科技公司",
            "title": "数据分析实习生",
            "actions": ["使用Python和SQL分析转化数据"],
            "results": ["将转化率提升30.5%", "完成2个分析看板", "模型评分4.75"],
            "skills": ["Python", "SQL", "数据分析"],
        }],
        "projects": [{
            "id": "project-1",
            "title": "增长洞察平台项目",
            "organization": "星海科技公司",
            "actions": ["管理人民币12.50万元预算"],
            "results": ["项目周期6个月", "截止日期为2026年8月15日"],
            "skills": ["Python", "SQL"],
        }],
    }


def fixture_record() -> dict:
    return {
        "note_id": "note-1",
        "title": "数据分析实习生",
        "body": "星海科技公司招聘数据分析实习生，负责数据分析与增长洞察。",
        "job_card": {"role_name": "数据分析实习生"},
        "application_info": {
            "responsibilities": [{"text": "负责数据分析与增长洞察"}],
            "requirements": [{"text": "使用Python和SQL"}],
        },
        "fit_evidence": [{
            "id": "project-1",
            "label": "增长洞察平台项目",
            "detail": (
                "使用Python和SQL分析转化数据；将转化率提升30.5%；"
                "管理人民币12.50万元预算；项目周期6个月；截止日期为2026年8月15日"
            ),
            "skills": ["Python", "SQL", "数据分析"],
        }],
    }


def grounded_draft() -> dict:
    return {
        "greeting": "您好，我是林舟，申请数据分析实习生。",
        "email_subject": "数据分析实习生申请",
        "email_body": (
            "我就读于远航大学，曾任职于星海科技公司，参与增长洞察平台项目，"
            "使用Python和SQL。"
        ),
        "cover_letter": (
            "我将转化率提升30.5%，管理人民币12.50万元预算，"
            "完成2个分析看板，模型评分4.75，项目周期6个月，截止日期为2026年8月15日。"
        ),
    }


class EvidenceClaimValidatorTests(unittest.TestCase):
    def test_fit_evidence_project_label_handles_completion_particle(self) -> None:
        record = {
            "note_id": "fit-project-1",
            "title": "内容运营实习生",
            "body": "招聘内容运营实习生。",
            "job_card": {"role_name": "内容运营实习生"},
            "fit_evidence": [{
                "id": "fit-project-evidence",
                "label": "曼彻斯特大学转专业咨询项目",
                "detail": "完成曼彻斯特大学转专业咨询项目",
            }],
        }
        profile = {"candidate_application": {"name": "王梓楠"}}

        result = validate_generated_claims(
            record,
            profile,
            profile["candidate_application"],
            {"cover_letter": "我完成了曼彻斯特大学转专业咨询项目。"},
        )

        self.assertEqual(result["status"], "passed")
        self.assertTrue(any(
            claim["claimType"] == "project"
            and claim["text"] == "曼彻斯特大学转专业咨询项目"
            and claim["validationStatus"] == "valid"
            for claim in result["claims"]
        ))

    def test_supported_hard_facts_bind_to_exact_spans_and_offsets(self) -> None:
        record = fixture_record()
        profile = fixture_profile()

        result = validate_generated_claims(
            record,
            profile,
            profile["candidate_application"],
            grounded_draft(),
        )

        self.assertEqual(result["schemaVersion"], 1)
        self.assertEqual(result["status"], "passed")
        self.assertTrue(result["hardFactsPassed"])
        claim_types = {claim["claimType"] for claim in result["claims"]}
        self.assertTrue({
            "person", "company", "school", "job", "project", "product", "skill",
            "integer", "decimal", "percentage", "money", "duration", "date",
            "quantified_achievement",
        }.issubset(claim_types))
        sources = {
            item["evidenceId"]: item["content"]
            for item in build_evidence_sources(record, profile, profile["candidate_application"])
        }
        required_fields = {
            "claimId", "text", "claimType", "evidenceId", "evidenceSpan",
            "evidenceStart", "evidenceEnd", "sourceVersion", "sourceHash",
            "validationStatus", "validationReason",
        }
        for claim in result["claims"]:
            self.assertTrue(required_fields.issubset(claim))
            self.assertEqual(claim["validationStatus"], "valid")
            source = sources[claim["evidenceId"]]
            self.assertEqual(
                source[claim["evidenceStart"]:claim["evidenceEnd"]],
                claim["evidenceSpan"],
            )
            self.assertEqual(claim["evidenceSpan"], claim["text"])

    def test_integer_decimal_percentage_money_date_and_duration_are_exact(self) -> None:
        record = fixture_record()
        profile = fixture_profile()
        supported = grounded_draft()
        supported["email_body"] += " 每周可实习5天。"
        result = validate_generated_claims(
            record, profile, profile["candidate_application"], supported,
        )
        self.assertTrue(result["hardFactsPassed"])
        numeric_types = {
            claim["claimType"]
            for claim in result["claims"]
            if claim["claimType"] in {"integer", "decimal", "percentage", "money", "date", "duration"}
        }
        self.assertTrue({
            "integer", "decimal", "percentage", "money", "date", "duration",
        }.issubset(numeric_types))

        for fabricated in ("31%", "30.50%", "人民币12.5万元", "7个月", "2026年8月16日"):
            draft = {field: "" for field in ("greeting", "email_subject", "email_body", "cover_letter")}
            draft["cover_letter"] = f"项目结果为{fabricated}。"
            invalid = validate_generated_claims(
                record, profile, profile["candidate_application"], draft,
            )
            self.assertEqual(invalid["status"], "failed", fabricated)
            self.assertTrue(any(
                claim["validationStatus"] == "failed" for claim in invalid["claims"]
            ), fabricated)

    def test_fabricated_entities_and_product_are_rejected(self) -> None:
        profile = fixture_profile()
        cases = (
            ("我就读于北辰大学。", "school"),
            ("我任职于云帆科技公司。", "company"),
            ("我申请推荐算法实习生。", "job"),
            ("我参与星图项目。", "project"),
            ("我使用Tableau。", "product"),
        )
        for text, expected_type in cases:
            result = validate_generated_claims(
                fixture_record(),
                profile,
                profile["candidate_application"],
                {"greeting": text},
            )
            self.assertEqual(result["status"], "failed", text)
            self.assertTrue(any(
                claim["claimType"] == expected_type and claim["validationStatus"] == "failed"
                for claim in result["claims"]
            ), text)

    def test_known_person_is_extracted_from_a_long_candidate_introduction(self) -> None:
        profile = fixture_profile()
        draft = {
            "cover_letter": "您好！我是远航大学数据分析专业硕士研究生林舟，申请数据分析实习生。",
        }

        result = validate_generated_claims(
            fixture_record(), profile, profile["candidate_application"], draft,
        )

        self.assertEqual(result["status"], "passed")
        person_claims = [
            claim for claim in result["claims"] if claim["claimType"] == "person"
        ]
        self.assertTrue(any(claim["text"] == "林舟" for claim in person_claims))
        self.assertFalse(any("硕士研究生" in claim["text"] for claim in person_claims))

    def test_supported_numeric_paraphrase_and_quoted_job_do_not_create_false_claims(self) -> None:
        record = fixture_record()
        profile = fixture_profile()
        draft = {
            "greeting": "您好，我想应聘「数据分析实习生」。",
            "email_body": "我推动转化率提升30.5%，负责社区冷启动与平台运营，完成2个分析看板。",
        }

        result = validate_generated_claims(
            record,
            profile,
            profile["candidate_application"],
            draft,
        )

        self.assertEqual(result["status"], "passed")
        self.assertFalse(any(claim["text"].startswith("「") for claim in result["claims"]))
        self.assertFalse(any(
            claim["claimType"] == "project" and claim["text"] == "社区冷启动与平台"
            for claim in result["claims"]
        ))
        self.assertTrue(any(
            claim["claimType"] == "percentage" and claim["text"] == "30.5%"
            for claim in result["claims"]
        ))

    def test_model_derived_fields_and_match_scores_cannot_become_evidence(self) -> None:
        record = fixture_record()
        record["job_card"]["role_name"] = "虚构战略岗位"
        record["fit_evidence"][0]["match_score"] = 73
        profile = fixture_profile()
        result = validate_generated_claims(
            record,
            profile,
            profile["candidate_application"],
            {"cover_letter": "我申请虚构战略岗位，并完成73个项目。"},
        )

        self.assertEqual(result["status"], "failed")
        self.assertTrue(any(
            claim["text"] == "虚构战略岗位" and claim["validationStatus"] == "failed"
            for claim in result["claims"]
        ))
        self.assertTrue(any(
            claim["text"] == "73" and claim["validationStatus"] == "failed"
            for claim in result["claims"]
        ))

    def test_verified_target_role_is_context_only_in_application_intent(self) -> None:
        record = fixture_record()
        profile = fixture_profile()
        target_role = "\u6570\u636e\u7b56\u7565 / \u5206\u6790\u5b9e\u4e60\u751f"
        record["job_card"]["role_name"] = target_role
        record["qualitySourceDisposition"] = {
            "status": "sendable",
            "roleName": target_role,
        }

        application_intent = validate_generated_claims(
            record,
            profile,
            profile["candidate_application"],
            {"greeting": "\u60a8\u597d\uff0c\u6211\u7533\u8bf7\u6570\u636e\u7b56\u7565/\u5206\u6790\u5b9e\u4e60\u751f\u3002"},
        )
        self.assertEqual(application_intent["status"], "passed")
        self.assertFalse(any(
            claim["claimType"] == "job" and claim["text"] == target_role
            for claim in application_intent["claims"]
        ))

        candidate_history = validate_generated_claims(
            record,
            profile,
            profile["candidate_application"],
            {"cover_letter": f"\u6211\u66fe\u62c5\u4efb{target_role}\u3002"},
        )
        self.assertEqual(candidate_history["status"], "failed")
        self.assertTrue(any(
            claim["claimType"] == "job"
            and claim["text"] == target_role
            and claim["validationStatus"] == "failed"
            for claim in candidate_history["claims"]
        ))

    def test_generic_project_descriptor_is_not_treated_as_a_project_name(self) -> None:
        profile = fixture_profile()
        generic = validate_generated_claims(
            fixture_record(),
            profile,
            profile["candidate_application"],
            {"cover_letter": "\u6211\u63a8\u8fdb\u6e05\u6670\u3001\u6709\u5e8f\u7684\u9879\u76ee\u3002"},
        )
        self.assertEqual(generic["status"], "passed")
        self.assertFalse(any(claim["claimType"] == "project" for claim in generic["claims"]))

        fabricated = validate_generated_claims(
            fixture_record(),
            profile,
            profile["candidate_application"],
            {"cover_letter": "\u6211\u63a8\u8fdb\u661f\u56fe\u9879\u76ee\u3002"},
        )
        self.assertEqual(fabricated["status"], "failed")
        self.assertTrue(any(
            claim["claimType"] == "project" and claim["validationStatus"] == "failed"
            for claim in fabricated["claims"]
        ))

    def test_subjective_proficiency_requires_human_review(self) -> None:
        profile = fixture_profile()
        result = validate_generated_claims(
            fixture_record(),
            profile,
            profile["candidate_application"],
            {"cover_letter": "我精通数据分析。"},
        )

        self.assertEqual(result["status"], "needsHumanReview")
        self.assertFalse(result["sendable"])
        self.assertTrue(any(
            claim["validationStatus"] == "needsHumanReview" for claim in result["claims"]
        ))

    def test_source_mutation_invalidates_previous_validation(self) -> None:
        record = fixture_record()
        profile = fixture_profile()
        validation = validate_generated_claims(
            record, profile, profile["candidate_application"], grounded_draft(),
        )
        self.assertTrue(claim_validation_is_current(
            validation, record, profile, profile["candidate_application"],
        ))

        mutated = copy.deepcopy(record)
        mutated["body"] += " 来源内容已更新。"
        self.assertFalse(claim_validation_is_current(
            validation, mutated, profile, profile["candidate_application"],
        ))

    def test_existing_evidence_id_cannot_mask_invalid_span_or_offsets(self) -> None:
        record = fixture_record()
        profile = fixture_profile()
        sources = build_evidence_sources(record, profile, profile["candidate_application"])
        validation = validate_generated_claims(
            record, profile, profile["candidate_application"], grounded_draft(),
        )
        claim = next(item for item in validation["claims"] if item["validationStatus"] == "valid")

        unsupported = {**claim, "evidenceSpan": f"{claim['evidenceSpan']}x"}
        self.assertFalse(validate_claim_binding(unsupported, sources)[0])
        missing_span = {**claim, "evidenceSpan": ""}
        self.assertFalse(validate_claim_binding(missing_span, sources)[0])
        wrong_offsets = {**claim, "evidenceStart": claim["evidenceStart"] + 1}
        self.assertFalse(validate_claim_binding(wrong_offsets, sources)[0])

        tampered = copy.deepcopy(validation)
        tampered["claims"][0] = wrong_offsets
        self.assertFalse(claim_validation_is_current(
            tampered, record, profile, profile["candidate_application"],
        ))

    def test_malformed_claim_collection_is_never_current(self) -> None:
        record = fixture_record()
        profile = fixture_profile()
        validation = validate_generated_claims(
            record, profile, profile["candidate_application"], grounded_draft(),
        )

        missing_list = {**validation, "claims": None}
        self.assertFalse(claim_validation_is_current(
            missing_list, record, profile, profile["candidate_application"],
        ))

        mixed_list = {**validation, "claims": [*validation["claims"], "invalid"]}
        self.assertFalse(claim_validation_is_current(
            mixed_list, record, profile, profile["candidate_application"],
        ))

    def test_all_three_copy_types_are_mapped_without_changing_legacy_ids(self) -> None:
        record = fixture_record()
        record["outreach"] = {
            "greeting": "我曾将转化率提升30.5%。",
            "email_subject": "数据分析实习生申请",
            "email_body": "我曾将转化率提升30.5%。",
            "cover_letter": "我曾将转化率提升30.5%。",
            "used_evidence_ids": ["project-1"],
        }
        original_ids = list(record["outreach"]["used_evidence_ids"])
        profile = fixture_profile()

        result = validate_generated_claims(record, profile, profile["candidate_application"])

        mapped_fields = {
            claim["outputField"]
            for claim in result["claims"]
            if claim["claimType"] == "percentage"
        }
        self.assertEqual(mapped_fields, {"greeting", "email_body", "cover_letter"})
        self.assertEqual(record["outreach"]["used_evidence_ids"], original_ids)
        self.assertTrue(result["legacyEvidenceIdsPreserved"])

    def test_legacy_artifact_without_claim_schema_remains_readable(self) -> None:
        legacy = {
            "note_id": "legacy-1",
            "title": "普通岗位",
            "body": "普通岗位正文",
            "outreach": {
                "greeting": "您好，期待沟通。",
                "used_evidence_ids": ["legacy-evidence-1"],
            },
        }
        before = copy.deepcopy(legacy)

        result = validate_generated_claims(legacy)

        self.assertEqual(result["schemaVersion"], 1)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(legacy, before)

    def test_legacy_scalar_profile_sections_remain_valid_evidence(self) -> None:
        profile = {
            "education": {"school": "清华大学", "major": "市场营销"},
            "experience": {"company": "示例科技", "title": "增长实习生"},
            "projects": {"id": "legacy-project", "title": "留存分析项目"},
            "skills": "SQL",
        }

        result = validate_generated_claims(
            fixture_record(),
            profile,
            {},
            {"cover_letter": "我在示例科技担任增长实习生，完成留存分析项目并使用SQL。"},
        )

        self.assertEqual(result["status"], "passed")
        self.assertTrue(all(claim["validationStatus"] == "valid" for claim in result["claims"]))

    def test_high_model_score_cannot_override_fabricated_fact(self) -> None:
        payload = {
            "record": fixture_record(),
            "draft": {
                **grounded_draft(),
                "email_body": "I improved conversion by 73%.",
            },
            "candidateProfile": fixture_profile()["candidate_application"],
            "threshold": 90,
        }
        model_evaluation = {
            "score": 99,
            "rubric": recheck._rubric_for_score(99),
            "strengths": ["Fluent"],
            "problems": [],
            "rewrite_instructions": [],
        }
        with patch.object(recheck, "_evaluate", return_value=model_evaluation), patch.object(
            recheck, "_deterministic_problems", return_value=[]
        ):
            result = recheck.evaluate_payload(payload, lambda: object())

        self.assertEqual(result["score"], 89)
        self.assertFalse(result["modelPassed"])
        self.assertFalse(result["passed"])
        self.assertEqual(result["claim_validation"]["status"], "failed")


if __name__ == "__main__":
    unittest.main()
