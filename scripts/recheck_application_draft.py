from __future__ import annotations

import json
import sys
from typing import Any, Callable

from ai_application_workflow import (
    AIProvider,
    _application_copy_source_hash,
    _deterministic_problems,
    _evaluate,
    _human_quality_dimensions,
    _merge_feedback,
    _rubric_for_score,
)
from cover_letter_rewriter import _candidate_evidence
from evidence_claim_validator import validate_generated_claims
from job_role_title import normalize_role_title
from codex_runtime_outreach import _subject_rule


MAX_INPUT_BYTES = 2 * 1024 * 1024
TEXT_FIELDS = ("greeting", "email_subject", "email_body", "cover_letter")
RUBRIC_FIELDS = (
    "role_relevance",
    "evidence",
    "first_person",
    "concision",
    "credibility",
    "action_readiness",
)


def _object(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _object_list(value: Any) -> list[dict[str, Any]]:
    return [dict(item) for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _text_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [text for item in value if (text := str(item or "").strip())]


def _threshold(payload: dict[str, Any], record: dict[str, Any]) -> int:
    evaluation = _object(record.get("cover_letter_evaluation"))
    raw = payload.get("threshold", evaluation.get("threshold", 90))
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = 90
    return max(90, value)


def _role_from_record(record: dict[str, Any]) -> dict[str, Any]:
    application = _object(record.get("application_info"))
    job_card = _object(record.get("job_card"))
    media = _object(record.get("media"))
    media_analysis = _object(media.get("analysis"))
    raw_role_name = str(job_card.get("role_name") or record.get("title") or "").strip()
    quality_subject_rule = _object(record.get("qualitySubjectRule"))
    subject_rule = _subject_rule(record)
    subject_fields = _text_list(quality_subject_rule.get("fields"))
    subject_rule_detected = bool(quality_subject_rule.get("detected", subject_rule.get("detected")))
    return {
        "role_name": normalize_role_title(raw_role_name) or raw_role_name,
        "responsibilities": _object_list(application.get("responsibilities")),
        "requirements": _object_list(application.get("requirements")),
        "application_routes": _object_list(application.get("application_routes")),
        "capabilities": _object_list(record.get("job_capabilities")),
        "image_analysis": media_analysis,
        "subject_rule_detected": subject_rule_detected,
        "subject_requires_candidate_name": (
            "candidateName" in subject_fields if subject_rule_detected else True
        ),
    }


def _candidate_profile(payload: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    source = _object(payload.get("candidateProfile"))
    if not source:
        source = _object(record.get("candidateProfile"))
    if not source:
        source = _object(record.get("candidate_application"))
    normalized = dict(source)
    for key in (
        "name",
        "school",
        "degree",
        "major",
        "phoneWeChat",
        "email",
        "availabilityDays",
        "internshipDuration",
    ):
        if key in normalized:
            normalized[key] = str(normalized.get(key) or "").strip()
    return normalized


def _draft_with_grounding(record: dict[str, Any], draft: dict[str, Any]) -> dict[str, Any]:
    grounded = dict(_object(record.get("outreach")))
    for field in TEXT_FIELDS:
        grounded[field] = str(draft.get(field) or "").strip()
    for field in ("used_evidence_ids", "capability_matches"):
        if field in draft:
            grounded[field] = list(draft.get(field) or [])
    return grounded


def _attachment_context(payload: dict[str, Any], record: dict[str, Any]) -> Any:
    for key in ("attachmentContext", "attachments"):
        if key in payload:
            value = payload.get(key)
            return value if key == "attachmentContext" else {"attachments": value}
    for key in ("attachmentContext", "applicationAttachments", "application_attachments"):
        if key in record:
            value = record.get(key)
            return value if key == "attachmentContext" else {"attachments": value}
    return None


def evaluate_payload(
    payload: dict[str, Any],
    provider_factory: Callable[[], AIProvider] = AIProvider,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Input must be a JSON object")
    record = payload.get("record")
    draft = payload.get("draft")
    if not isinstance(record, dict) or not isinstance(draft, dict):
        raise ValueError("record and draft must be JSON objects")

    role = _role_from_record(record)
    candidate_profile = _candidate_profile(payload, record)
    evidence = _candidate_evidence(record, candidate_profile)
    checked_draft = _draft_with_grounding(record, draft)
    attachment_context = _attachment_context(payload, record)
    current_source_hash = _application_copy_source_hash(record, candidate_profile, evidence)
    outreach = _object(record.get("outreach"))
    stored_source_hash = str(
        payload.get("sourceHash")
        or draft.get("sourceHash")
        or outreach.get("sourceHash")
        or ""
    ).strip()
    legacy_source_hash_inferred = not bool(stored_source_hash)
    source_review_required = bool(stored_source_hash and stored_source_hash != current_source_hash)
    threshold = _threshold(payload, record)
    human_quality = _human_quality_dimensions(
        checked_draft,
        role,
        evidence,
        candidate_profile,
        attachment_context,
    )
    deterministic = _deterministic_problems(
        checked_draft,
        role,
        evidence,
        candidate_profile,
        record,
    )
    human_quality_problems = [
        problem
        for dimension in human_quality.values()
        if not bool(dimension.get("passed"))
        for problem in _text_list(dimension.get("problems"))
    ]
    deterministic = _merge_feedback(deterministic, human_quality_problems)
    if source_review_required:
        deterministic = _merge_feedback(
            deterministic,
            ["岗位或候选人证据已变化，当前保存的投递文案需要重新复核"],
        )

    evaluation_mode = str(payload.get("evaluationMode") or "ai_plus_deterministic").strip().lower()
    if evaluation_mode == "deterministic_strict":
        strict_score = 100 if not deterministic else 89
        evaluation = {
            "score": strict_score,
            "rubric": _rubric_for_score(strict_score),
            "strengths": ["已执行长度、结构、岗位匹配、证据绑定、事实声明和来源版本门禁"],
            "problems": list(deterministic),
            "rewrite_instructions": list(deterministic),
        }
    elif attachment_context is None:
        evaluation = _object(_evaluate(
            provider_factory(),
            role,
            evidence,
            checked_draft,
            candidate_profile,
        ))
    else:
        evaluation = _object(_evaluate(
            provider_factory(),
            role,
            evidence,
            checked_draft,
            candidate_profile,
            attachment_context,
        ))

    try:
        score = min(100, max(0, int(evaluation.get("score", 0))))
    except (TypeError, ValueError):
        score = 0
    problems = _text_list(evaluation.get("problems"))
    instructions = _text_list(evaluation.get("rewrite_instructions"))
    if deterministic:
        score = min(score, 89)
        problems = _merge_feedback(problems, deterministic)
        instructions = _merge_feedback(instructions, deterministic)

    rubric = _object(evaluation.get("rubric"))
    try:
        rubric_values = {field: int(rubric.get(field, 0)) for field in RUBRIC_FIELDS}
    except (TypeError, ValueError):
        rubric_values = {}
    if set(rubric_values) != set(RUBRIC_FIELDS) or sum(rubric_values.values()) != score:
        rubric_values = _rubric_for_score(score)
    if deterministic:
        rubric_values = _rubric_for_score(score)

    claim_validation = validate_generated_claims(
        record,
        profile=candidate_profile,
        candidate_profile={**_object(record.get("candidate_application")), **candidate_profile},
        draft=checked_draft,
    )
    if not claim_validation["hardFactsPassed"]:
        invalid_claims = [
            item["text"]
            for item in claim_validation["claims"]
            if item["validationStatus"] != "valid"
        ]
        detail = "、".join(invalid_claims[:3]) or "存在无法绑定到当前原始证据的事实"
        claim_problem = (
            f"生成事实校验需要人工复核：{detail}"
            if claim_validation["status"] == "needsHumanReview"
            else f"生成事实未通过原始证据片段校验：{detail}"
        )
        problems = _merge_feedback(problems, [claim_problem])
        instructions = _merge_feedback(instructions, [claim_problem])
        score = min(score, 89)
        rubric_values = _rubric_for_score(score)

    model_passed = score >= threshold

    return {
        "score": score,
        "rubric": rubric_values,
        "strengths": _text_list(evaluation.get("strengths")),
        "problems": problems,
        "rewrite_instructions": instructions,
        "threshold": threshold,
        "modelPassed": model_passed,
        "passed": model_passed and claim_validation["hardFactsPassed"],
        "attempt": 1,
        "attempts": 1,
        "claim_validation": claim_validation,
        "claims": claim_validation["claims"],
        "human_quality": human_quality,
        "sourceHash": current_source_hash,
        "sourceHashStatus": "changed" if source_review_required else ("legacy_inferred" if legacy_source_hash_inferred else "current"),
        "sourceReviewRequired": source_review_required,
        "legacySourceHashInferred": legacy_source_hash_inferred,
        "evaluationMode": evaluation_mode,
    }


def main() -> int:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError("Input exceeds the maximum allowed size")
    if not raw.strip():
        raise ValueError("Input is required")
    payload = json.loads(raw.decode("utf-8"))
    result = evaluate_payload(payload)
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
        sys.stderr.write(f"Draft quality check failed: {error}\n")
        raise SystemExit(2) from error
