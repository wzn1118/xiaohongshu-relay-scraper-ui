"""Generate many grounded cover letters in one external-model request."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from ai_provider_runtime import AIProvider
from cover_letter_rewriter import (
    _FULL_PROMPT_PATH,
    _bounded_cover_letter_subject,
    _split_cover_letter_subject,
    build_cover_letter_rewrite_input,
    cover_letter_char_count,
)

ATTACHMENT_PROMPT = Path(r"E:\CodexHome\attachments\f4f62188-7681-40cb-89b3-e9e81c4b104d\pasted-text.txt")


def _text(value: Any) -> str:
    return str(value or "").strip()


def _load_prompt(path_value: str = "") -> str:
    path = Path(path_value) if _text(path_value) else ATTACHMENT_PROMPT
    if not path.exists():
        path = _FULL_PROMPT_PATH
    return path.read_text(encoding="utf-8").strip()


def _outreach(record: dict[str, Any]) -> dict[str, Any]:
    value = record.get("outreach")
    return value if isinstance(value, dict) else {}


def _build_job(entry: dict[str, Any], candidate_profile: dict[str, Any], instructions: str) -> dict[str, Any]:
    record = entry.get("record") if isinstance(entry.get("record"), dict) else entry
    outreach = _outreach(record)
    application_context = outreach.get("applicationContext")
    payload = build_cover_letter_rewrite_input(
        record,
        {
            "greeting": _text(outreach.get("greeting")),
            "email_subject": _text(outreach.get("email_subject")),
            "email_body": _text(outreach.get("email_body")),
            "cover_letter": _text(outreach.get("cover_letter")),
        },
        instructions,
        candidate_profile,
        application_context if isinstance(application_context, dict) else {},
    )
    return {
        "note_id": _text(entry.get("note_id") or record.get("note_id")),
        "TARGET_ROLE": payload["role"].get("role_name", "当前岗位"),
        "candidate_name": _text(payload["candidate"].get("application_profile", {}).get("name")),
        "role": {
            "role_name": payload["role"].get("role_name", "当前岗位"),
            "source_post_title": payload["role"].get("source_post_title", ""),
        },
        "JOB_DESCRIPTION": payload["role"].get("source_body_excerpt", "")[:1200],
        "JOB_RESPONSIBILITIES": payload["role"].get("responsibilities", []),
        "JOB_REQUIREMENTS": payload["role"].get("requirements", []),
        "allowed_evidence_ids": payload["quality_contract"].get("allowed_evidence_ids", []),
        "required_responsibility_ids": payload["quality_contract"].get("required_responsibility_ids", []),
    }


def _schema(count: int) -> dict[str, Any]:
    item = {
        "type": "object",
        "additionalProperties": False,
        "required": ["note_id", "email_subject", "cover_letter", "used_evidence_ids", "evidence_coverage", "responsibility_coverage"],
        "properties": {
            "note_id": {"type": "string", "minLength": 1},
            "email_subject": {"type": "string", "minLength": 4, "maxLength": 240},
            "cover_letter": {"type": "string", "minLength": 800, "maxLength": 2600},
            "used_evidence_ids": {"type": "array", "items": {"type": "string"}},
            "evidence_coverage": {"type": "array", "items": {"type": "object"}},
            "responsibility_coverage": {"type": "array", "items": {"type": "object"}},
        },
    }
    return {"type": "object", "additionalProperties": False, "required": ["items"], "properties": {"items": {"type": "array", "minItems": count, "maxItems": count, "items": item}}}


def _normalize_result(item: dict[str, Any], jobs_by_id: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    note_id = _text(item.get("note_id") or item.get("noteId"))
    job = jobs_by_id.get(note_id)
    if not note_id or not job:
        return None
    subject = _text(item.get("email_subject") or item.get("subject"))
    body = _text(item.get("cover_letter") or item.get("email_body") or item.get("body"))
    payload_for_job = {"role": job.get("role", {}), "candidate": {"application_profile": {}}}
    embedded_subject, body = _split_cover_letter_subject(body, payload_for_job)
    if not subject:
        subject = embedded_subject
    role_name = _text(job.get("role", {}).get("role_name")) or "当前岗位"
    candidate_name = _text(job.get("candidate_name")) or "候选人"
    subject = _bounded_cover_letter_subject(f"应聘{role_name}｜{candidate_name}", payload_for_job, {"positioning": "个人经历与岗位匹配"})
    used = item.get("used_evidence_ids") if isinstance(item.get("used_evidence_ids"), list) else []
    allowed = set(job.get("allowed_evidence_ids", []))
    used = [_text(value) for value in used if _text(value) in allowed]
    chars = cover_letter_char_count(body)
    if chars < 800 or chars > 1600 or not body.startswith("尊敬的招聘负责人"):
        return None
    return {
        "note_id": note_id,
        "email_subject": subject,
        "cover_letter": body,
        "used_evidence_ids": list(dict.fromkeys(used))[:8],
        "evidence_coverage": item.get("evidence_coverage") if isinstance(item.get("evidence_coverage"), list) else [],
        "responsibility_coverage": item.get("responsibility_coverage") if isinstance(item.get("responsibility_coverage"), list) else [],
        "char_count": chars,
    }


def main() -> int:
    try:
        request = json.load(sys.stdin)
        entries = request.get("items") if isinstance(request, dict) else None
        if not isinstance(entries, list) or not entries or len(entries) > 300:
            raise ValueError("items must contain 1-300 entries")
        candidate_profile = request.get("candidateProfile") if isinstance(request.get("candidateProfile"), dict) else {}
        instructions = _text(request.get("instructions")) or "结合岗位职责与候选人简历经历，生成可直接发送的专属求职邮件。"
        jobs = [_build_job(entry, candidate_profile, instructions) for entry in entries if isinstance(entry, dict)]
        if len(jobs) != len(entries) or any(not job["note_id"] for job in jobs):
            raise ValueError("every batch item must include a note_id")
        first_record = entries[0].get("record") if isinstance(entries[0], dict) and isinstance(entries[0].get("record"), dict) else entries[0]
        first_outreach = _outreach(first_record if isinstance(first_record, dict) else {})
        first_payload = build_cover_letter_rewrite_input(
            first_record if isinstance(first_record, dict) else {}, first_outreach, instructions,
            candidate_profile, first_outreach.get("applicationContext") if isinstance(first_outreach.get("applicationContext"), dict) else {},
        )
        shared_candidate = {
            "application_profile": first_payload["candidate"].get("application_profile", {}),
            "evidence": first_payload["candidate"].get("evidence", []),
            "profile_snapshot_id": first_payload["candidate"].get("profile_snapshot_id", ""),
            "resume_artifacts": first_payload["candidate"].get("resume_artifacts", []),
        }
        prompt = _load_prompt(_text(request.get("promptPath")))
        override = (
            "批处理输出协议（覆盖上文格式）：输入 jobs 数组中的每个 note_id 都必须输出且只能输出一次，严格原样保留 note_id。"
            "返回一个 JSON 对象，顶层只有 items。每条包含 note_id、email_subject、cover_letter、used_evidence_ids、"
            "evidence_coverage、responsibility_coverage。email_subject 是独立邮件主题；cover_letter 只能是正文，"
            "不得出现主题或 Subject 首行，必须以尊敬的招聘负责人：开始并包含此致、敬礼，正文不少于 800 个非空白字符且不超过 1600 个非空白字符。"
            "每个 jobs 条目里的 JOB_DESCRIPTION、JOB_RESPONSIBILITIES、JOB_REQUIREMENTS 就是该岗位的完整输入，禁止声称岗位没有职责或要求。"
            "正文第一段必须原样出现 TARGET_ROLE；每封信至少明确回应两条 JOB_RESPONSIBILITIES 或 JOB_REQUIREMENTS，"
            "至少引用其中两条职责的关键动作词（例如达人脚本/视频审核、图文视频策划、素材库、视频剪辑、内容数据复盘），"
            "必须把岗位动作写进候选人的经历匹配段落，而不是只写泛泛的入职后计划。"
            "每封信必须引用 candidate.evidence 中真实存在的证据 id；严禁编造简历没有的公司、职责、工具、数字或结果。"
            "不要省略任何岗位，不要合并岗位。"
        )
        user = json.dumps({"candidate": shared_candidate, "jobs": jobs, "instructions": instructions}, ensure_ascii=False)
        provider = AIProvider(
            provider=os.environ.get("XHS_AI_PROVIDER", "relay"), api_key=os.environ.get("XHS_AI_API_KEY", ""),
            base_url=os.environ.get("XHS_AI_BASE_URL", ""), model=os.environ.get("XHS_AI_MODEL", "gpt-5.6-sol"),
            wire_api=os.environ.get("XHS_AI_WIRE_API", "chat_completions"), timeout=int(os.environ.get("XHS_AI_TIMEOUT_SECONDS", "1800")),
            max_output_tokens=int(os.environ.get("XHS_AI_MAX_OUTPUT_TOKENS", "131072")),
        )
        # Put the batch contract first so it is not diluted by the long
        # reference prompt; the attachment remains included verbatim below.
        raw = provider.generate_json(override + "\n\n" + prompt, user, _schema(len(jobs)))
        generated = raw.get("items") if isinstance(raw, dict) and isinstance(raw.get("items"), list) else []
        jobs_by_id = {job["note_id"]: job for job in jobs}
        normalized = [_normalize_result(item, jobs_by_id) for item in generated if isinstance(item, dict)]
        normalized = [item for item in normalized if item]
        print(json.dumps({"items": normalized, "requested": len(jobs), "generated": len(normalized), "provider": provider.provider, "model": provider.last_request_model or provider.model, "wire_api": provider.wire_api, "profile_snapshot_id": shared_candidate.get("profile_snapshot_id", "")}, ensure_ascii=False))
        return 0 if len(normalized) == len(jobs) else 2
    except Exception as error:  # noqa: BLE001 - caller records the batch failure.
        print(json.dumps({"error": str(error)[:1200]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
