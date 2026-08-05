"""Contracts for candidate snapshots, model generation, and draft writeback.

The module deliberately keeps resume binaries out of the model request.  A model
gets stable artifact references (name, hash, page count) plus the structured
evidence extracted from the profile; the application keeps the original files
for the later attachment step.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote
from urllib.request import Request, urlopen


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _bounded(value: Any, limit: int) -> str:
    return _text(value)[:limit]


def _canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _candidate_application(profile: dict[str, Any]) -> dict[str, str]:
    for key in ("candidate_application", "candidateProfile"):
        value = profile.get(key)
        if isinstance(value, dict):
            return {
                field: _bounded(value.get(field), 160)
                for field in (
                    "name",
                    "school",
                    "major",
                    "degreeYear",
                    "availabilityDays",
                    "internshipDuration",
                )
                if _text(value.get(field))
            }
    candidate = profile.get("candidate")
    if isinstance(candidate, dict):
        return {
            field: _bounded(candidate.get(field), 160)
            for field in ("name", "school", "major", "degreeYear")
            if _text(candidate.get(field))
        }
    return {
        field: _bounded(profile.get(field), 160)
        for field in ("name", "school", "major", "degreeYear", "availabilityDays", "internshipDuration")
        if _text(profile.get(field))
    }


def _source_artifact(source: dict[str, Any], index: int, output_dir: Path | None) -> dict[str, Any]:
    source_id = _bounded(source.get("id"), 100) or f"resume-{index}"
    filename = _bounded(source.get("filename") or source.get("name"), 240)
    path_value = _text(source.get("path"))
    file_path = Path(path_value) if path_value else None
    digest = _text(source.get("sha256")).lower()
    if not digest and file_path and file_path.is_file():
        hasher = hashlib.sha256()
        with file_path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                hasher.update(chunk)
        digest = hasher.hexdigest()
    if not digest and output_dir and filename:
        candidate = output_dir / "profiles" / "sources" / filename
        if candidate.is_file():
            digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
    result: dict[str, Any] = {
        "id": source_id,
        "filename": filename,
        "variant": _bounded(source.get("variant"), 120),
        "sha256": digest,
        "pages": int(source.get("pages")) if str(source.get("pages", "")).isdigit() else None,
    }
    return {key: value for key, value in result.items() if value not in (None, "")}


def build_profile_snapshot(profile: dict[str, Any], output_dir: Path | None = None) -> dict[str, Any]:
    """Create a deterministic, model-safe profile snapshot.

    The snapshot contains evidence and references, never the raw PDF bytes or
    local absolute paths.  Its id changes whenever the profile evidence or
    source hashes change, which makes cache and writeback provenance explicit.
    """

    if not isinstance(profile, dict):
        raise ValueError("candidate profile must be an object")
    evidence_items: list[dict[str, Any]] = []

    # Preserve each resume experience as one atomic evidence block.  The
    # condensed evidence_items remain useful for retrieval, but the full
    # structured claims are what let a model write concrete, resume-grounded
    # application copy without merging facts across employers.
    raw_experiences = profile.get("experience")
    has_full_experiences = False
    if isinstance(raw_experiences, list):
        for index, item in enumerate(raw_experiences, start=1):
            if not isinstance(item, dict):
                continue
            organization = _bounded(item.get("organization"), 180)
            claims: list[str] = []
            sources: list[str] = []
            for claim in item.get("claims", []) if isinstance(item.get("claims"), list) else []:
                if not isinstance(claim, dict) or claim.get("conflict") is True:
                    continue
                value = _bounded(claim.get("claim"), 700)
                if value:
                    claims.append(value)
                claim_sources = claim.get("evidence")
                if isinstance(claim_sources, list):
                    sources.extend(_bounded(source, 80) for source in claim_sources if _text(source))
                elif _text(claim_sources):
                    sources.append(_bounded(claim_sources, 80))
            if not organization or not claims:
                continue
            period = item.get("period") if isinstance(item.get("period"), dict) else {}
            period_text = "-".join(
                value for value in (_bounded(period.get("start"), 20), _bounded(period.get("end"), 20)) if value
            )
            evidence_items.append({
                "id": f"resume-experience-{index}",
                "category": "完整简历经历",
                "label": f"{organization}工作经历",
                "organization": organization,
                "period": period_text,
                "detail": _bounded("候选人简历记载：" + "；".join(claims), 3600),
                "source": ";".join(dict.fromkeys(sources))[:500],
            })
            has_full_experiences = True

    raw_skills = profile.get("skills")
    if isinstance(raw_skills, list):
        skill_details = [
            "：".join(value for value in (_bounded(item.get("skill"), 120), _bounded(item.get("detail"), 360)) if value)
            for item in raw_skills
            if isinstance(item, dict) and (_text(item.get("skill")) or _text(item.get("detail")))
        ]
        if skill_details:
            evidence_items.append({
                "id": "resume-skills",
                "category": "个人技能",
                "label": "个人技能与工具",
                "detail": _bounded("候选人简历记载：" + "；".join(skill_details), 1800),
                "source": "resume:skills",
            })

    raw_education = profile.get("education")
    if isinstance(raw_education, list):
        for index, item in enumerate(raw_education, start=1):
            if not isinstance(item, dict) or not _text(item.get("institution")):
                continue
            institution = _bounded(item.get("institution"), 180)
            detail = "，".join(
                value
                for value in (
                    institution,
                    _bounded(item.get("degree"), 80),
                    _bounded(item.get("field"), 120),
                )
                if value
            )
            period = item.get("period") if isinstance(item.get("period"), dict) else {}
            period_text = "至".join(
                value for value in (_bounded(period.get("start"), 20), _bounded(period.get("end"), 20)) if value
            )
            if period_text:
                detail += f"，就读时间{period_text}"
            evidence_items.append({
                "id": f"resume-education-{index}",
                "category": "教育经历",
                "label": f"{institution}教育经历",
                "organization": institution,
                "detail": f"候选人简历记载：{detail}。",
                "source": "resume:education",
            })

    raw_evidence = profile.get("evidence_items")
    if isinstance(raw_evidence, list):
        for index, item in enumerate(raw_evidence, start=1):
            if not isinstance(item, dict):
                continue
            if has_full_experiences and _bounded(item.get("id"), 120).casefold().startswith("resume-"):
                continue
            evidence = {
                "id": _bounded(item.get("id"), 120) or f"evidence-{index}",
                "category": _bounded(item.get("category"), 120),
                "label": _bounded(item.get("label") or item.get("title"), 180),
                "organization": _bounded(item.get("organization"), 180),
                "detail": _bounded(item.get("detail") or item.get("description") or item.get("text"), 1400),
                "first_person_claim": _bounded(item.get("first_person_claim"), 1400),
                "skills": [_bounded(value, 120) for value in item.get("skills", []) if _text(value)][:12]
                if isinstance(item.get("skills"), list)
                else [],
                "outcomes": [_bounded(value, 160) for value in item.get("outcomes", []) if _text(value)][:12]
                if isinstance(item.get("outcomes"), list)
                else [],
                "role_axis": _bounded(item.get("role_axis"), 80),
                "source": _bounded(item.get("source"), 300),
            }
            if evidence["detail"] or evidence["first_person_claim"]:
                evidence_items.append({key: value for key, value in evidence.items() if value not in ("", [], None)})

    raw_sources = profile.get("sources")
    resume_artifacts = [
        _source_artifact(item, index, output_dir)
        for index, item in enumerate(raw_sources, start=1)
        if isinstance(item, dict)
    ] if isinstance(raw_sources, list) else []

    candidate = _candidate_application(profile)
    snapshot_body = {
        "schemaVersion": "1.0",
        "candidate": candidate,
        "evidence": evidence_items,
        "resumeArtifacts": resume_artifacts,
        "provenancePolicy": {
            key: _bounded(value, 220)
            for key, value in (profile.get("provenance_policy") or {}).items()
            if isinstance(key, str) and _text(value)
        } if isinstance(profile.get("provenance_policy"), dict) else {},
    }
    snapshot = {
        **snapshot_body,
        "profileSnapshotId": _canonical_hash(snapshot_body),
        "createdAt": _bounded(profile.get("generated_at") or profile.get("generatedAt"), 40),
    }
    return snapshot


def build_generation_payload(
    records: list[dict[str, Any]],
    profile_snapshot: dict[str, Any],
    *,
    run_id: str = "",
    prompt_version: str = "",
    model: str = "",
    provider: str = "",
) -> dict[str, Any]:
    """Build the small writeback payload from validated outreach records."""

    resolved_run_id = _bounded(run_id, 160) or f"generation-{int(time.time())}"
    items: list[dict[str, Any]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        note_id = _bounded(record.get("note_id"), 160)
        outreach = record.get("outreach")
        if not note_id or not isinstance(outreach, dict) or _text(outreach.get("status")) != "ready":
            continue
        if any(not _text(outreach.get(field)) for field in ("greeting", "email_subject", "email_body", "cover_letter")):
            continue
        resume_artifact_ids = [
            _bounded(artifact.get("id"), 100)
            for artifact in profile_snapshot.get("resumeArtifacts", [])
            if isinstance(artifact, dict) and _text(artifact.get("id"))
        ][:6]
        recommended_resume_id = _bounded(outreach.get("recommended_resume"), 120)
        if recommended_resume_id not in resume_artifact_ids:
            recommended_resume_id = ""
        item: dict[str, Any] = {
            "noteId": note_id,
            "outreach": {
                field: _text(outreach.get(field))
                for field in ("greeting", "email_subject", "email_body", "cover_letter")
            },
            "generation": {
                "runId": resolved_run_id,
                "promptVersion": _bounded(prompt_version, 120),
                "model": _bounded(model, 160),
                "provider": _bounded(provider, 120),
                "profileSnapshotId": _bounded(profile_snapshot.get("profileSnapshotId"), 128),
                "resumeArtifactIds": resume_artifact_ids,
                "inputHash": _canonical_hash({
                    "noteId": note_id,
                    "title": record.get("title"),
                    "jobCard": record.get("job_card"),
                    "applicationInfo": record.get("application_info"),
                    "profileSnapshotId": profile_snapshot.get("profileSnapshotId"),
                }),
                "usedEvidenceIds": [
                    _bounded(value, 120)
                    for value in outreach.get("used_evidence_ids", [])
                    if _text(value)
                ][:2] if isinstance(outreach.get("used_evidence_ids"), list) else [],
                "recommendedResumeId": recommended_resume_id,
                "resumeReason": _bounded(outreach.get("resume_reason"), 600) if recommended_resume_id else "",
                "status": "validated",
            },
        }
        draft_version = record.get("draftVersion")
        if isinstance(draft_version, dict) and isinstance(draft_version.get("version"), int):
            item["baseVersion"] = draft_version["version"]
            if _text(draft_version.get("draftId")):
                item["draftId"] = _text(draft_version["draftId"])
        items.append(item)
    return {
        "runId": resolved_run_id,
        "promptVersion": _bounded(prompt_version, 120),
        "model": _bounded(model, 160),
        "provider": _bounded(provider, 120),
        "profileSnapshotId": _bounded(profile_snapshot.get("profileSnapshotId"), 128),
        "items": items,
    }


def generation_writeback_endpoint(base_or_endpoint: str, job_id: str = "") -> str:
    value = _text(base_or_endpoint).rstrip("/")
    if not value:
        return ""
    if "/application-generation/writeback" in value:
        return value
    if not _text(job_id):
        raise ValueError("writeback_job_id is required when writeback_url is an API base URL")
    return f"{value}/api/jobs/{quote(_text(job_id), safe='')}/application-generation/writeback"


def post_generation_writeback(
    endpoint: str,
    payload: dict[str, Any],
    *,
    timeout_seconds: int = 30,
    opener: Callable[..., Any] = urlopen,
) -> dict[str, Any]:
    if not _text(endpoint):
        raise ValueError("writeback endpoint is required")
    request = Request(
        endpoint,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with opener(request, timeout=max(5, min(int(timeout_seconds), 180))) as response:
        raw = response.read()
    result = json.loads(raw.decode("utf-8"))
    if not isinstance(result, dict):
        raise ValueError("writeback response must be a JSON object")
    return result


def writeback_generated_drafts(
    payload: dict[str, Any],
    *,
    writeback_url: str,
    writeback_job_id: str = "",
    timeout_seconds: int = 30,
    post: Callable[..., dict[str, Any]] = post_generation_writeback,
) -> dict[str, Any]:
    endpoint = generation_writeback_endpoint(writeback_url, writeback_job_id)
    if not endpoint:
        return {"status": "disabled", "requested": 0, "saved": 0, "items": []}
    items = payload.get("items", []) if isinstance(payload, dict) else []
    if not items:
        return {"status": "skipped_empty", "requested": 0, "saved": 0, "items": []}
    try:
        result = post(endpoint, payload, timeout_seconds=timeout_seconds)
    except Exception as error:  # noqa: BLE001 - pipeline records the failed run and continues.
        return {
            "status": "failed",
            "requested": len(payload.get("items", [])) if isinstance(payload, dict) else 0,
            "saved": 0,
            "error": str(error)[:800],
            "items": [],
        }
    return result
