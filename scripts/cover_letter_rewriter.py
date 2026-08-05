from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from ai_application_workflow import (
    COVER_LETTER_MAX_CHARS,
    COVER_LETTER_MIN_CHARS,
    COVER_LETTER_REWRITE_PROMPT_VERSION,
    COVER_LETTER_TARGET_MAX_CHARS,
    COVER_LETTER_TARGET_MIN_CHARS,
)
from ai_provider_runtime import AIProvider
from job_role_title import normalize_role_title


_PLACEHOLDER_PATTERN = re.compile(
    r"(?:X{2,}|TODO|TBD|\[[^\]]*(?:填写|公司|岗位|姓名|证据)[^\]]*\]|"
    r"候选人姓名|公司名称|岗位名称|此处填写|待补充|待填写)",
    re.I,
)
_UNSUPPORTED_OUTCOME_PATTERNS = (
    "提升了观众的留存率",
    "提升留存率",
    "提升了互动质量",
    "提升互动质量",
    "缩短至分钟级响应",
    "缩短到分钟级响应",
    "耗时数日",
    "规模化运营的全过程闭环",
    "QS5",
    "QS 5",
    "高转化时段判定",
)
_UNSUPPORTED_ACHIEVEMENT_PATTERNS = (
    re.compile(r"成功(?:推动|实现|完成|搭建|组织|引入|促成)"),
    re.compile(r"(?:高质量|精准匹配|迅速识别|海量信息|大规模直播|大厂产品团队)"),
    re.compile(r"(?:核心业务指标(?:的)?提升|量化为可执行|完整(?:业务|内容|项目)?闭环)"),
    re.compile(r"(?:显著|大幅|有效)(?:提升|提高|增长|降低|缩短|增加)"),
    re.compile(r"(?:证明了我具备|完全契合|充分证明了)"),
    re.compile(r"(?:全链路能力|直接胜任|高度契合|可直接迁移|闭环能力)"),
    re.compile(r"(?:展现了|体现了).{0,24}(?:能力|经验)"),
    re.compile(r"我(?:具备|拥有|擅长).{0,36}(?:能力|经验)"),
    re.compile(r"(?:因为热爱|我热爱|高效拉通|高效处理)"),
    re.compile(r"将用户反馈(?:直接)?转化为(?:内容改进|增长|转化)"),
    re.compile(r"确保.{0,24}(?:速度|质量|效果).{0,16}(?:提升|增长|提高)"),
    re.compile(r"(?:全周期运营经验|完整链路能力|内容生态建设|创作者留存痛点)"),
    re.compile(r"(?:我主导|精细化运营|有效整合|确保内容与业务目标一致落地)"),
)
_STRICT_EVIDENCE_MARKERS = (
    "一对一访谈", "访谈", "问卷", "直播", "日报", "周报", "用户画像", "清洗",
    "公告", "声明模板", "创作者指南", "研发", "测试", "Twitter", "Discord", "Excel",
    "Codex", "vibe coding", "公开采购", "信息化负责人", "定价", "物料核查",
)
_PAST_FACT_CUES = (
    "我曾", "我负责", "我参与", "我主导", "我独立", "我通过", "我使用", "我拥有",
    "开展", "搭建", "建立", "输出", "组织", "协调", "沉淀", "优化", "执行", "策划",
    "挖掘", "收集", "归纳", "制作", "引入", "从零", "经历", "经验",
)
_FUTURE_OR_METHOD_CUES = (
    "入职后", "到岗后", "我会", "我将", "我计划", "我可以", "我希望", "我愿意", "预计",
)
_PROMPT_PATH = Path(__file__).with_name("prompts") / "cover_letter_agent_v4_zh.txt"
_DEFENSIVE_STYLE_PATTERNS = (
    re.compile(r"不是.{0,36}而是"),
    re.compile(r"并不是.{0,36}而是"),
    re.compile(r"而不是|而非"),
    re.compile(r"不只是|不仅仅|不仅是|不仅"),
    re.compile(r"真正"),
    re.compile(r"其实(?:是)?|本质上"),
    re.compile(r"与其说.{0,36}不如说"),
    re.compile(r"相比于|相较于|区别于|不同于"),
    re.compile(r"我并非|没有停留在|不止于|不局限于|不停留在|不满足于"),
    re.compile(r"重点不在|关键不在|核心不在"),
    re.compile(r"与普通候选人相比|相较于其他候选人"),
    re.compile(r"我的优势不在于|我的价值不只是"),
    re.compile(r"我更希望|我更关注|我更倾向于|我比较关注的是"),
    re.compile(r"我想强调的是|值得强调的是|需要说明的是|需要特别说明的是|这里要说明的是"),
    re.compile(r"虽然我的(?:专业|背景|经历)|尽管我的(?:专业|背景|经历)|相比科班候选人|可能与传统候选人不同"),
)


def _agent_prompt() -> str:
    try:
        value = _PROMPT_PATH.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise RuntimeError(f"Cover Letter Prompt 文件不可用：{_PROMPT_PATH}") from error
    if len(value) < 1_000:
        raise RuntimeError(f"Cover Letter Prompt 文件内容不完整：{_PROMPT_PATH}")
    return value


def _style_violations(value: Any) -> list[str]:
    text = _text(value)
    violations: list[str] = []
    for pattern in _DEFENSIVE_STYLE_PATTERNS:
        for match in pattern.finditer(text):
            phrase = match.group(0).strip()
            if phrase and phrase not in violations:
                violations.append(phrase)
    return violations


def _trace(message: str) -> None:
    if os.environ.get("XHS_COVER_LETTER_TRACE", "").strip().lower() in {"1", "true", "yes"}:
        print(f"[cover-letter] {message}", file=sys.stderr, flush=True)


def cover_letter_rewrite_schema() -> dict[str, Any]:
    string = {"type": "string"}
    evidence_coverage = {
        "type": "object",
        "additionalProperties": False,
        "required": ["evidence_id", "evidence_sentence"],
        "properties": {
            "evidence_id": string,
            "evidence_sentence": string,
        },
    }
    coverage = {
        "type": "object",
        "additionalProperties": False,
        "required": ["responsibility_id", "responsibility", "response_sentence", "evidence_ids"],
        "properties": {
            "responsibility_id": string,
            "responsibility": string,
            "response_sentence": string,
            "evidence_ids": {"type": "array", "items": string},
        },
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "cover_letter",
            "used_evidence_ids",
            "evidence_coverage",
            "responsibility_coverage",
        ],
        "properties": {
            "cover_letter": string,
            "used_evidence_ids": {"type": "array", "items": string},
            "evidence_coverage": {"type": "array", "items": evidence_coverage},
            "responsibility_coverage": {"type": "array", "items": coverage},
        },
    }


def local_cover_letter_draft_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["cover_letter"],
        "properties": {"cover_letter": {"type": "string"}},
    }


def local_cover_letter_plan_schema() -> dict[str, Any]:
    string = {"type": "string"}
    plan_item = {
        "type": "object",
        "additionalProperties": False,
        "required": ["responsibility_id", "evidence_ids"],
        "properties": {
            "responsibility_id": string,
            "evidence_ids": {"type": "array", "items": string},
        },
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "signature_evidence_ids",
            "evidence_priority",
            "responsibility_plan",
        ],
        "properties": {
            "signature_evidence_ids": {"type": "array", "items": string},
            "evidence_priority": {"type": "array", "items": string},
            "responsibility_plan": {"type": "array", "items": plan_item},
        },
    }


def local_cover_letter_review_schema() -> dict[str, Any]:
    string_array = {"type": "array", "items": {"type": "string"}}
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "score",
            "approved",
            "responsibility_coverage_complete",
            "evidence_grounded",
            "resume_experience_integrated",
            "personal_evidence_dominant",
            "instruction_followed",
            "signature_evidence_clear",
            "style_violation_count",
            "strengths",
            "issues",
            "rewrite_instructions",
        ],
        "properties": {
            "score": {"type": "integer", "minimum": 0, "maximum": 100},
            "approved": {"type": "boolean"},
            "responsibility_coverage_complete": {"type": "boolean"},
            "evidence_grounded": {"type": "boolean"},
            "resume_experience_integrated": {"type": "boolean"},
            "personal_evidence_dominant": {"type": "boolean"},
            "instruction_followed": {"type": "boolean"},
            "signature_evidence_clear": {"type": "boolean"},
            "style_violation_count": {"type": "integer", "minimum": 0},
            "strengths": string_array,
            "issues": string_array,
            "rewrite_instructions": string_array,
        },
    }


def _text(value: Any) -> str:
    return str(value or "").strip()


def _compact(value: Any) -> str:
    return re.sub(r"\s+", "", _text(value))


def _semantic_compact(value: Any) -> str:
    """Normalize whitespace and punctuation for exact sentence-presence checks."""
    return re.sub(r"[\W_]+", "", _text(value), flags=re.UNICODE).casefold()


def cover_letter_char_count(value: Any) -> int:
    return len(_compact(value))


def _evidence_anchor(label: str, organization: str) -> str:
    if organization:
        return organization
    value = label.strip()
    latin = re.match(r"^([A-Za-z][A-Za-z0-9.+#-]{1,30})", value)
    if latin:
        return latin.group(1)
    entity = re.match(
        r"^(.{2,10}?)(?:海外|用户研究|达人|舆情|直播|社区|需求|市场|数据|内容运营|AI产品)",
        value,
    )
    if entity:
        return entity.group(1).strip(" 、，/|")
    return value


def _evidence_markers(label: str, detail: str, outcomes: list[str]) -> list[str]:
    source = " ".join([label, detail, *outcomes])
    markers = re.findall(r"[A-Za-z][A-Za-z0-9.+#-]{1,30}|\d+(?:\.\d+)?", source)
    action_markers = (
        "访谈", "问卷", "反馈", "直播", "社群", "共创", "监测", "日报", "周报",
        "用户画像", "清洗", "竞品", "工具", "创作者指南", "跨团队", "研发", "测试", "设计",
        "冷启动", "达人", "协调", "活动", "发布", "策划",
    )
    markers.extend(value for value in action_markers if value in source)
    return list(dict.fromkeys(value for value in markers if value))[:12]


def _role_points(record: dict[str, Any], field: str, limit: int) -> list[dict[str, Any]]:
    application = record.get("application_info") if isinstance(record.get("application_info"), dict) else {}
    raw = application.get(field) if isinstance(application.get(field), list) else []
    if not raw and isinstance(record.get(field), list):
        raw = record[field]
    points: list[dict[str, Any]] = []
    seen: set[str] = set()
    prefix = "responsibility" if field == "responsibilities" else "requirement"
    for item in raw:
        text = _text(item.get("text")) if isinstance(item, dict) else _text(item)
        marker = _compact(text).casefold()
        if not marker or marker in seen:
            continue
        seen.add(marker)
        priority_value = item.get("priority") if isinstance(item, dict) else None
        try:
            priority = max(1, min(3, int(priority_value or 2)))
        except (TypeError, ValueError):
            priority = 2
        points.append({"id": f"{prefix}-{len(points) + 1}", "text": text, "priority": priority})
        if len(points) >= limit:
            break
    return points


def _normalize_evidence_item(item: Any, fallback_id: str) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    evidence_id = _text(item.get("id")) or fallback_id
    normalized = {
        "id": evidence_id,
        "category": _text(item.get("category")),
        "label": _text(item.get("label")),
        "organization": _text(item.get("organization")),
        "period": _text(item.get("period")),
        "source": _text(item.get("source")),
        "role_axis": _text(item.get("role_axis")),
        "detail": _text(item.get("detail")),
        "first_person_claim": _text(item.get("first_person_claim")),
        "match_reason": _text(item.get("match_reason")),
        "matched_terms": [
            _text(value) for value in item.get("matched_terms", []) if _text(value)
        ] if isinstance(item.get("matched_terms"), list) else [],
        "skills": [
            _text(value) for value in item.get("skills", []) if _text(value)
        ] if isinstance(item.get("skills"), list) else [],
        "outcomes": [
            _text(value) for value in item.get("outcomes", []) if _text(value)
        ] if isinstance(item.get("outcomes"), list) else [],
    }
    if not any(normalized[key] for key in ("label", "detail", "first_person_claim", "match_reason")):
        return None
    normalized["is_resume_evidence"] = bool(
        normalized["id"].casefold().startswith("resume-")
        or "resume" in normalized["source"].casefold()
        or "简历" in normalized["source"]
    )
    normalized["required_anchor"] = _evidence_anchor(
        normalized["label"],
        normalized["organization"],
    )
    normalized["grounding_markers"] = _evidence_markers(
        normalized["label"],
        normalized["detail"],
        normalized["outcomes"],
    )
    normalized["anchor_optional"] = normalized["category"] in {"个人技能", "技能"}
    normalized["grounding_optional"] = normalized["category"] == "教育经历"
    return normalized


def _candidate_evidence(record: dict[str, Any], candidate_profile: dict[str, Any]) -> list[dict[str, Any]]:
    sources: list[list[Any]] = []
    for value in (
        record.get("fit_evidence"),
        record.get("candidate_evidence"),
        candidate_profile.get("evidence_items"),
        candidate_profile.get("evidence"),
    ):
        if isinstance(value, list):
            sources.append(value)
    snapshot = candidate_profile.get("profile_snapshot")
    if isinstance(snapshot, dict) and isinstance(snapshot.get("evidence"), list):
        sources.append(snapshot["evidence"])

    evidence: list[dict[str, Any]] = []
    seen: set[str] = set()
    for source in sources:
        for item in source:
            normalized = _normalize_evidence_item(item, f"candidate-evidence-{len(evidence) + 1}")
            if not normalized or normalized["id"] in seen:
                continue
            seen.add(normalized["id"])
            evidence.append(normalized)
            if len(evidence) >= 12:
                return evidence
    return evidence


def _evidence_fact_text(item: dict[str, Any]) -> str:
    outcomes = item.get("outcomes", []) if isinstance(item.get("outcomes"), list) else []
    return " ".join(
        _text(value)
        for value in (
            item.get("label"),
            item.get("organization"),
            item.get("detail"),
            item.get("first_person_claim"),
            *outcomes,
        )
        if _text(value)
    )


def _fact_grounding_problems(
    cover_letter: str,
    evidence_by_id: dict[str, dict[str, Any]],
    used_evidence_ids: set[str],
) -> list[str]:
    """Reject cross-resume fact merging that string-presence checks cannot catch."""
    if not evidence_by_id:
        return []
    fact_text_by_id = {
        evidence_id: _evidence_fact_text(item)
        for evidence_id, item in evidence_by_id.items()
    }
    fact_corpus = _semantic_compact(" ".join(fact_text_by_id.values()))
    number_owners: dict[str, set[str]] = {}
    marker_owners: dict[str, set[str]] = {}
    for evidence_id, fact_text in fact_text_by_id.items():
        for value in re.findall(r"\d+(?:\.\d+)?", fact_text):
            number_owners.setdefault(value, set()).add(evidence_id)
        compact_fact = _semantic_compact(fact_text)
        for marker in _STRICT_EVIDENCE_MARKERS:
            marker_present = _semantic_compact(marker) in compact_fact
            if marker == "访谈" and _semantic_compact("深访") in compact_fact:
                marker_present = True
            if marker_present:
                marker_owners.setdefault(marker, set()).add(evidence_id)

    problems: list[str] = []
    for pattern in _UNSUPPORTED_ACHIEVEMENT_PATTERNS:
        for match in pattern.finditer(cover_letter):
            claim = match.group(0)
            if _semantic_compact(claim) not in fact_corpus:
                problems.append(f"Cover Letter 包含候选人材料未支持的成果或能力判断：{claim}")
    if "毕业生" in cover_letter and "毕业生" not in " ".join(fact_text_by_id.values()):
        problems.append("Cover Letter 把在读或未注明毕业状态的教育经历写成了毕业生")

    paragraphs = [
        value.strip()
        for value in re.split(r"[\r\n]+", cover_letter)
        if value.strip() and not re.match(r"^(?:主题|尊敬的|此致|敬礼)[：:]?", value.strip())
    ]
    for paragraph in paragraphs:
        compact_paragraph = _semantic_compact(paragraph)
        anchor_ids = {
            evidence_id
            for evidence_id, item in evidence_by_id.items()
            if _text(item.get("required_anchor"))
            and _semantic_compact(item.get("required_anchor")) in compact_paragraph
        }
        undeclared_ids = anchor_ids - used_evidence_ids
        if undeclared_ids:
            problems.append(
                "正文引用了未在 used_evidence_ids 声明的候选人经历："
                + "、".join(sorted(undeclared_ids))
            )

        for sentence in _cover_letter_sentences(paragraph):
            compact_sentence = _semantic_compact(sentence)
            is_future_or_method = any(value in sentence for value in _FUTURE_OR_METHOD_CUES)
            is_past_fact = not is_future_or_method and any(value in sentence for value in _PAST_FACT_CUES)
            for number in re.findall(r"\d+(?:\.\d+)?", sentence):
                owners = number_owners.get(number, set())
                if not owners:
                    problems.append(f"正文数字 {number} 在候选人事实库中没有依据：{sentence[:72]}")
                elif not anchor_ids.intersection(owners) and not any(
                    evidence_by_id[owner].get("anchor_optional") for owner in owners
                ):
                    anchors = [
                        _text(evidence_by_id[value].get("required_anchor"))
                        for value in sorted(owners)
                    ]
                    problems.append(
                        f"正文数字 {number} 的经历归属错误；该段必须点明 "
                        + " / ".join(value for value in anchors if value)
                    )

            if not is_past_fact:
                continue
            for marker, owners in marker_owners.items():
                if _semantic_compact(marker) not in compact_sentence:
                    continue
                if not anchor_ids and any(
                    evidence_by_id[owner].get("anchor_optional") for owner in owners
                ):
                    continue
                if not anchor_ids:
                    anchors = [
                        _text(evidence_by_id[value].get("required_anchor"))
                        for value in sorted(owners)
                    ]
                    problems.append(
                        f"过往事实“{marker}”缺少经历主体；该段必须点明 "
                        + " / ".join(value for value in anchors if value)
                    )
                elif not anchor_ids.intersection(owners) and not any(
                    evidence_by_id[owner].get("anchor_optional") for owner in owners
                ):
                    problems.append(f"正文把“{marker}”拼接到了另一段经历：{sentence[:72]}")

    return list(dict.fromkeys(problems))


def _local_json_with_output_limit(
    provider: AIProvider,
    system: str,
    user: str,
    schema: dict[str, Any],
    output_tokens: int,
) -> dict[str, Any]:
    previous_limit = getattr(provider, "max_output_tokens", None)
    if previous_limit is None:
        return provider.generate_json(system, user, schema)
    provider.max_output_tokens = min(previous_limit, output_tokens)
    try:
        return provider.generate_json(system, user, schema)
    finally:
        provider.max_output_tokens = previous_limit


def build_cover_letter_rewrite_input(
    record: dict[str, Any],
    current_draft: dict[str, Any],
    user_instructions: str,
    candidate_profile: dict[str, Any] | None = None,
    application_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    profile = candidate_profile if isinstance(candidate_profile, dict) else {}
    application = record.get("application_info") if isinstance(record.get("application_info"), dict) else {}
    job_card = record.get("job_card") if isinstance(record.get("job_card"), dict) else {}
    raw_role_name = (
        application.get("role_name")
        or job_card.get("role_name")
        or record.get("role_name")
        or record.get("title")
    )
    role_name = normalize_role_title(raw_role_name) or "当前岗位"
    responsibilities = _role_points(record, "responsibilities", 6)
    requirements = _role_points(record, "requirements", 8)
    evidence = _candidate_evidence(record, profile)
    resume_evidence_ids = [item["id"] for item in evidence if item["is_resume_evidence"]]
    work_evidence_ids = [
        item["id"] for item in evidence if item.get("category") == "完整简历经历"
    ]
    minimum_distinct_evidence = 0 if not evidence else 1 if len(evidence) == 1 else 2 if len(evidence) < 5 else 3
    minimum_resume_evidence = 0 if not resume_evidence_ids else min(2, len(resume_evidence_ids))
    snapshot = profile.get("profile_snapshot") if isinstance(profile.get("profile_snapshot"), dict) else {}
    resume_artifacts = snapshot.get("resumeArtifacts")
    if not isinstance(resume_artifacts, list):
        resume_artifacts = profile.get("resumeArtifacts") if isinstance(profile.get("resumeArtifacts"), list) else []
    return {
        "prompt_version": COVER_LETTER_REWRITE_PROMPT_VERSION,
        "role": {
            "role_name": role_name,
            "source_post_title": _text(record.get("title")),
            "responsibilities": responsibilities,
            "requirements": requirements,
            "source_body_excerpt": _text(record.get("body") or record.get("body_excerpt"))[:8000],
        },
        "candidate": {
            "application_profile": {
                key: value
                for key, value in profile.items()
                if key not in {
                    "education",
                    "evidence_items",
                    "evidence",
                    "profile_snapshot",
                    "resumeArtifacts",
                    "skills",
                }
            },
            "evidence": evidence,
            "profile_snapshot_id": _text(snapshot.get("profileSnapshotId")),
            "resume_artifacts": resume_artifacts[:8],
        },
        "current_draft": {
            "greeting": _text(current_draft.get("greeting")),
            "email_subject": _text(current_draft.get("email_subject")),
            "email_body": _text(current_draft.get("email_body")),
            "cover_letter": _text(current_draft.get("cover_letter")),
        },
        "rewrite_request": {
            "user_instructions": _text(user_instructions),
            "application_context": application_context if isinstance(application_context, dict) else {},
        },
        "quality_contract": {
            "minimum_non_whitespace_characters": COVER_LETTER_MIN_CHARS,
            "target_non_whitespace_characters": [
                COVER_LETTER_TARGET_MIN_CHARS,
                COVER_LETTER_TARGET_MAX_CHARS,
            ],
            "maximum_non_whitespace_characters": COVER_LETTER_MAX_CHARS,
            "required_responsibility_ids": [item["id"] for item in responsibilities],
            "allowed_evidence_ids": [item["id"] for item in evidence],
            "resume_evidence_ids": resume_evidence_ids,
            "minimum_distinct_evidence": minimum_distinct_evidence,
            "minimum_resume_evidence": minimum_resume_evidence,
            "work_evidence_ids": work_evidence_ids,
            "minimum_work_evidence": min(3, len(work_evidence_ids)),
            "personal_experience_share_target": "正文主体内容的 60%-75%",
            "signature_evidence_target": [2, 4],
            "minimum_internal_quality_score": 92,
            "required_style_violation_count": 0,
        },
    }


def _validate_rewrite(result: Any, payload: dict[str, Any]) -> list[str]:
    if not isinstance(result, dict):
        return ["模型输出不是 JSON 对象"]
    cover_letter = _text(result.get("cover_letter"))
    char_count = cover_letter_char_count(cover_letter)
    problems: list[str] = []
    if char_count < COVER_LETTER_MIN_CHARS:
        problems.append(
            f"Cover Letter 只有 {char_count} 个非空白字符，至少需要 {COVER_LETTER_MIN_CHARS} 个"
        )
    if char_count > COVER_LETTER_MAX_CHARS:
        problems.append(
            f"Cover Letter 有 {char_count} 个非空白字符，最多允许 {COVER_LETTER_MAX_CHARS} 个"
        )
    if _PLACEHOLDER_PATTERN.search(cover_letter):
        problems.append("Cover Letter 包含占位符或待填写内容")
    for claim in _UNSUPPORTED_OUTCOME_PATTERNS:
        if claim in cover_letter:
            problems.append(f"Cover Letter 包含简历事实库未支持的结果表述：{claim}")
    style_violations = _style_violations(cover_letter)
    if style_violations:
        problems.append("Cover Letter 包含防御性或对照式禁句：" + "、".join(style_violations[:8]))
    role_name = _text(payload.get("role", {}).get("role_name"))
    if (
        role_name
        and role_name != "当前岗位"
        and _semantic_compact(role_name) not in _semantic_compact(cover_letter)
    ):
        problems.append(f"Cover Letter 没有准确点名岗位：{role_name}")
    if "我" not in cover_letter:
        problems.append("Cover Letter 必须使用候选人第一人称")
    if not re.search(r"^主题[：:]", cover_letter):
        problems.append("Cover Letter 第一行必须是岗位专属主题")
    if not re.search(r"尊敬的.{0,20}招聘负责人[：:]", cover_letter):
        problems.append("Cover Letter 必须包含规范的招聘负责人称呼")
    if "此致" not in cover_letter or "敬礼" not in cover_letter:
        problems.append("Cover Letter 必须以“此致 / 敬礼”收束")

    allowed_evidence_ids = set(payload.get("quality_contract", {}).get("allowed_evidence_ids", []))
    used_evidence_ids = {
        _text(value) for value in result.get("used_evidence_ids", []) if _text(value)
    } if isinstance(result.get("used_evidence_ids"), list) else set()
    if not used_evidence_ids.issubset(allowed_evidence_ids):
        problems.append("used_evidence_ids 引用了候选人事实库之外的证据")
    minimum_distinct_evidence = int(
        payload.get("quality_contract", {}).get("minimum_distinct_evidence", 0) or 0
    )
    if len(used_evidence_ids) < minimum_distinct_evidence:
        problems.append(f"Cover Letter 至少必须使用 {minimum_distinct_evidence} 条不同的候选人真实经历")
    resume_evidence_ids = set(payload.get("quality_contract", {}).get("resume_evidence_ids", []))
    minimum_resume_evidence = int(
        payload.get("quality_contract", {}).get("minimum_resume_evidence", 0) or 0
    )
    used_resume_evidence = used_evidence_ids & resume_evidence_ids
    if len(used_resume_evidence) < minimum_resume_evidence:
        problems.append(f"Cover Letter 至少必须使用 {minimum_resume_evidence} 条上传简历中的真实经历")
    work_evidence_ids = set(payload.get("quality_contract", {}).get("work_evidence_ids", []))
    minimum_work_evidence = int(
        payload.get("quality_contract", {}).get("minimum_work_evidence", 0) or 0
    )
    if len(used_evidence_ids & work_evidence_ids) < minimum_work_evidence:
        problems.append(f"Cover Letter 至少必须展开 {minimum_work_evidence} 段上传简历中的工作经历")
    if len(used_evidence_ids) > 5:
        problems.append("Cover Letter 最多使用五条候选人证据")

    evidence_by_id = {
        item["id"]: item
        for item in payload.get("candidate", {}).get("evidence", [])
        if isinstance(item, dict) and _text(item.get("id"))
    }
    problems.extend(_fact_grounding_problems(cover_letter, evidence_by_id, used_evidence_ids))
    evidence_coverage = result.get("evidence_coverage")
    if not isinstance(evidence_coverage, list):
        evidence_coverage = []
    covered_evidence_ids: set[str] = set()
    for item in evidence_coverage:
        if not isinstance(item, dict):
            problems.append("evidence_coverage 包含无效条目")
            continue
        evidence_id = _text(item.get("evidence_id"))
        evidence_sentence = _text(item.get("evidence_sentence"))
        if evidence_id in covered_evidence_ids:
            problems.append(f"候选人经历 {evidence_id} 被重复声明")
        covered_evidence_ids.add(evidence_id)
        if evidence_id not in used_evidence_ids:
            problems.append(f"evidence_coverage 声明了未使用或不存在的经历：{evidence_id}")
            continue
        if not evidence_sentence or _semantic_compact(evidence_sentence) not in _semantic_compact(cover_letter):
            problems.append(f"候选人经历 {evidence_id} 的落地句没有真实写入正文")
        anchor = _text(evidence_by_id.get(evidence_id, {}).get("required_anchor"))
        if (
            anchor
            and not evidence_by_id.get(evidence_id, {}).get("anchor_optional")
            and _semantic_compact(anchor) not in _semantic_compact(evidence_sentence)
        ):
            problems.append(f"候选人经历 {evidence_id} 的落地句没有点明真实经历主体：{anchor}")
        grounding_markers = evidence_by_id.get(evidence_id, {}).get("grounding_markers", [])
        if grounding_markers and not evidence_by_id.get(evidence_id, {}).get("grounding_optional") and not any(
            _semantic_compact(marker) in _semantic_compact(evidence_sentence)
            for marker in grounding_markers
        ):
            problems.append(f"候选人经历 {evidence_id} 的落地句缺少可核验的数字、工具或行动事实")
    missing_evidence_coverage = sorted(used_evidence_ids - covered_evidence_ids)
    if missing_evidence_coverage:
        problems.append("以下候选人经历没有对应正文原句：" + "、".join(missing_evidence_coverage))

    coverage = result.get("responsibility_coverage")
    if not isinstance(coverage, list):
        coverage = []
    expected_ids = set(payload.get("quality_contract", {}).get("required_responsibility_ids", []))
    seen_ids: set[str] = set()
    for item in coverage:
        if not isinstance(item, dict):
            problems.append("responsibility_coverage 包含无效条目")
            continue
        responsibility_id = _text(item.get("responsibility_id"))
        if responsibility_id in seen_ids:
            problems.append(f"岗位职责 {responsibility_id} 被重复映射")
        seen_ids.add(responsibility_id)
        response_sentence = _text(item.get("response_sentence"))
        if (
            not response_sentence
            or _semantic_compact(response_sentence) not in _semantic_compact(cover_letter)
        ):
            problems.append(f"岗位职责 {responsibility_id or '未知'} 的响应句没有真实写入正文")
        evidence_ids = {
            _text(value) for value in item.get("evidence_ids", []) if _text(value)
        } if isinstance(item.get("evidence_ids"), list) else set()
        if not evidence_ids.issubset(used_evidence_ids):
            problems.append(f"岗位职责 {responsibility_id or '未知'} 绑定了未使用或不存在的证据")
    missing = sorted(expected_ids - seen_ids)
    unexpected = sorted(seen_ids - expected_ids)
    if missing:
        problems.append("以下岗位职责没有正文响应：" + "、".join(missing))
    if unexpected:
        problems.append("responsibility_coverage 包含未知职责：" + "、".join(unexpected))
    return problems


def _local_role_evidence_plan(provider: AIProvider, payload: dict[str, Any]) -> dict[str, Any]:
    planning_candidate = {
        "evidence": [
            {
                key: item.get(key)
                for key in (
                    "id",
                    "label",
                    "required_anchor",
                    "detail",
                    "outcomes",
                    "is_resume_evidence",
                )
            }
            for item in payload["candidate"]["evidence"]
        ],
        "profile_snapshot_id": payload["candidate"].get("profile_snapshot_id", ""),
    }
    _trace(f"local plan start: evidence={len(planning_candidate['evidence'])}")
    result = _local_json_with_output_limit(
        provider,
        """你是本地求职材料证据规划模型，只做岗位职责与候选人真实经历的语义匹配，不写 Cover Letter，不输出解释。

evidence_priority 按对当前岗位的证明力排序，返回 3-5 个真实 evidence id，并至少包含 quality_contract.minimum_work_evidence 个 work_evidence_ids；Signature Evidence 对应 signature_evidence_ids，从中选 2-4 个最有区分度的 id。逐项处理 role.responsibilities，为每个 responsibility_id 返回最匹配的 1-2 个 evidence_ids。只能引用 quality_contract.allowed_evidence_ids，不得把招聘要求当成候选人的经历。严格输出紧凑 JSON。""",
        json.dumps(
            {
                "role": payload["role"],
                "candidate": planning_candidate,
                "rewrite_request": payload["rewrite_request"],
                "quality_contract": payload["quality_contract"],
            },
            ensure_ascii=False,
        ),
        local_cover_letter_plan_schema(),
        384,
    )
    _trace("local plan response received")
    allowed_evidence = set(payload["quality_contract"]["allowed_evidence_ids"])
    required_responsibilities = set(payload["quality_contract"]["required_responsibility_ids"])
    normalized_plan: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in result.get("responsibility_plan", []) if isinstance(result, dict) else []:
        if not isinstance(item, dict):
            continue
        responsibility_id = _text(item.get("responsibility_id"))
        if responsibility_id not in required_responsibilities or responsibility_id in seen:
            continue
        seen.add(responsibility_id)
        evidence_ids = [
            _text(value)
            for value in item.get("evidence_ids", [])
            if _text(value) in allowed_evidence
        ] if isinstance(item.get("evidence_ids"), list) else []
        normalized_plan.append({
            "responsibility_id": responsibility_id,
            "response_angle": _text(item.get("response_angle")) or next(
                (
                    _text(point.get("text"))
                    for point in payload["role"]["responsibilities"]
                    if point.get("id") == responsibility_id
                ),
                "",
            ),
            "evidence_ids": evidence_ids[:5],
            "fact_boundary": _text(item.get("fact_boundary")) or "只使用所绑定 evidence 的主体、动作、数字与结果。",
        })
    evidence_priority = [
        _text(value)
        for value in result.get("evidence_priority", [])
        if _text(value) in allowed_evidence
    ] if isinstance(result, dict) and isinstance(result.get("evidence_priority"), list) else []
    evidence_priority = list(dict.fromkeys(evidence_priority))
    signature_evidence_ids = [
        _text(value)
        for value in result.get("signature_evidence_ids", [])
        if _text(value) in allowed_evidence
    ] if isinstance(result, dict) and isinstance(result.get("signature_evidence_ids"), list) else []
    signature_evidence_ids = list(dict.fromkeys(signature_evidence_ids))[:4]
    top_requirements: list[dict[str, Any]] = []
    for item in result.get("top_requirements", []) if isinstance(result, dict) else []:
        if not isinstance(item, dict):
            continue
        try:
            priority = max(1, min(5, int(item.get("priority") or len(top_requirements) + 1)))
        except (TypeError, ValueError):
            priority = len(top_requirements) + 1
        matched_ids = [
            _text(value)
            for value in item.get("matched_evidence_ids", [])
            if _text(value) in allowed_evidence
        ] if isinstance(item.get("matched_evidence_ids"), list) else []
        top_requirements.append({
            "requirement": _text(item.get("requirement")),
            "priority": priority,
            "matched_evidence_ids": list(dict.fromkeys(matched_ids))[:3],
        })
        if len(top_requirements) >= 5:
            break
    minimum_distinct = int(payload["quality_contract"].get("minimum_distinct_evidence", 0) or 0)
    minimum_resume = int(payload["quality_contract"].get("minimum_resume_evidence", 0) or 0)
    resume_evidence = set(payload["quality_contract"].get("resume_evidence_ids", []))
    minimum_work = int(payload["quality_contract"].get("minimum_work_evidence", 0) or 0)
    work_evidence = set(payload["quality_contract"].get("work_evidence_ids", []))
    target_count = min(5, max(minimum_distinct, minimum_resume, minimum_work, len(signature_evidence_ids)))
    required_evidence_ids: list[str] = []
    for evidence_id in [*signature_evidence_ids, *evidence_priority, *payload["quality_contract"]["allowed_evidence_ids"]]:
        if evidence_id in work_evidence and evidence_id not in required_evidence_ids:
            required_evidence_ids.append(evidence_id)
        if len(required_evidence_ids) >= minimum_work:
            break
    for evidence_id in [*signature_evidence_ids, *evidence_priority]:
        if evidence_id in resume_evidence and evidence_id not in required_evidence_ids:
            required_evidence_ids.append(evidence_id)
        if len(required_evidence_ids) >= minimum_resume:
            break
    for source in (evidence_priority, payload["quality_contract"]["allowed_evidence_ids"]):
        for evidence_id in source:
            if evidence_id not in required_evidence_ids:
                required_evidence_ids.append(evidence_id)
            if len(required_evidence_ids) >= target_count:
                break
        if len(required_evidence_ids) >= target_count:
            break
    required_set = set(required_evidence_ids)
    for item in normalized_plan:
        item["evidence_ids"] = [
            evidence_id for evidence_id in item["evidence_ids"] if evidence_id in required_set
        ]
    role_name = payload["role"]["role_name"]
    responsibility_texts = [
        _text(item.get("text")) for item in payload["role"]["responsibilities"] if _text(item.get("text"))
    ]
    if not top_requirements:
        top_requirements = [
            {
                "requirement": text,
                "priority": index + 1,
                "matched_evidence_ids": next(
                    (
                        item["evidence_ids"]
                        for item in normalized_plan
                        if item["responsibility_id"] == payload["role"]["responsibilities"][index]["id"]
                    ),
                    [],
                ),
            }
            for index, text in enumerate(responsibility_texts[:5])
        ]
    return {
        "role_summary": (_text(result.get("role_summary")) if isinstance(result, dict) else "")
        or f"{role_name}需要围绕" + "、".join(responsibility_texts[:3]) + "完成内容交付。",
        "top_requirements": top_requirements,
        "signature_evidence_ids": signature_evidence_ids,
        "evidence_gaps": [
            _text(value) for value in result.get("evidence_gaps", []) if _text(value)
        ][:5] if isinstance(result, dict) and isinstance(result.get("evidence_gaps"), list) else [],
        "narrative_strategy": (_text(result.get("narrative_strategy")) if isinstance(result, dict) else "")
        or "按证据优先级逐段呈现个人行动与交付，再逐项对应岗位职责；每段只使用一条经历。",
        "positioning": (_text(result.get("positioning")) if isinstance(result, dict) else "")
        or f"以真实简历证据证明对{role_name}核心职责的匹配。",
        "evidence_priority": evidence_priority[:5],
        "required_evidence_ids": required_evidence_ids,
        "responsibility_plan": normalized_plan,
        "planning_gaps": sorted(required_responsibilities - seen),
        "instruction_application": (_text(result.get("instruction_application")) if isinstance(result, dict) else "")
        or payload["rewrite_request"]["user_instructions"],
    }


def _local_quality_review(
    provider: AIProvider,
    payload: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any]:
    selected_id_list = [
        _text(value) for value in result.get("used_evidence_ids", [])
        if _text(value)
    ]
    selected_ids = set(selected_id_list)
    selected_evidence = [
        item for item in payload["candidate"]["evidence"]
        if item.get("id") in selected_ids
    ]
    review_contract = dict(payload["quality_contract"])
    review_contract["allowed_evidence_ids"] = list(selected_ids)
    review_contract["resume_evidence_ids"] = [
        value for value in review_contract.get("resume_evidence_ids", [])
        if value in selected_ids
    ]
    review_contract["minimum_distinct_evidence"] = len(selected_ids)
    review_contract["minimum_resume_evidence"] = min(
        int(review_contract.get("minimum_resume_evidence", 0) or 0),
        len(review_contract["resume_evidence_ids"]),
    )
    _trace("local review start")
    review = _local_json_with_output_limit(
        provider,
        f"""你是严格的 Cover Letter 终审模型。根据岗位职责、候选人真实证据、用户要求和程序校验结果审核 draft；不能重写正文，不输出思维过程，也不得补造事实。

评分重点：JD 核心要求覆盖 25 分、候选人证据强度 20 分、差异化 15 分、产品/技术/业务深度 15 分、叙事连贯性 10 分、量化与具体程度 5 分、自然表达 5 分、事实安全 5 分。逐条核对 evidence_coverage 的原句是否把真实个人行动、对象、交付物或结果写进正文；正文主体应由个人经历及其与岗位职责的关联构成，泛化的“我会如何做”不能喧宾夺主。检查 2-4 项 Signature Evidence 是否清晰形成叙事主线。

逐句执行表达硬约束扫描，将实际发现的禁句数量写入 style_violation_count。program_validation 是程序已经完成的逐字核验结果，属于客观事实：不得报告与它冲突的长度、禁句、证据或职责覆盖问题；你的职责是基于这些事实评价叙事质量。岗位专属性只根据 role.role_name 和 role.responsibilities 判断；输入没有提供公司名称时，严禁要求公司名、公司简称或“贵团队”替换，也不要因为缺少公司名扣分。只有总分至少 92，style_violation_count 为 0，且职责覆盖完整、证据有来源、signature_evidence_clear、resume_experience_integrated、personal_evidence_dominant 与 instruction_followed 均为 true，approved 才能为 true。不得因为候选人事实库没有某项经历而要求编造。长度已经由程序独立校验，目标仍为 {COVER_LETTER_TARGET_MIN_CHARS}-{COVER_LETTER_TARGET_MAX_CHARS} 个非空白字符。严格输出 JSON。""",
        json.dumps(
            {
                "role": payload["role"],
                "candidate_evidence": selected_evidence,
                "rewrite_request": payload["rewrite_request"],
                "quality_contract": review_contract,
                "program_validation": {
                    "passed": True,
                    "non_whitespace_characters": cover_letter_char_count(_text(result.get("cover_letter"))),
                    "style_violation_count": len(_style_violations(_text(result.get("cover_letter")))),
                    "used_evidence_ids": selected_id_list,
                    "signature_evidence_ids": [
                        _text(value) for value in result.get("signature_evidence_ids", []) if _text(value)
                    ],
                    "responsibility_ids": [
                        _text(item.get("responsibility_id"))
                        for item in result.get("responsibility_coverage", [])
                        if isinstance(item, dict) and _text(item.get("responsibility_id"))
                    ],
                },
                "draft": result,
            },
            ensure_ascii=False,
        ),
        local_cover_letter_review_schema(),
        384,
    )
    _trace("local review response received")
    return review


def _local_review_problems(review: dict[str, Any]) -> list[str]:
    if not isinstance(review, dict):
        return ["本地模型终审没有返回可解析的 JSON 评审结果"]
    required_fields = (
        "score",
        "responsibility_coverage_complete",
        "evidence_grounded",
        "resume_experience_integrated",
        "personal_evidence_dominant",
        "instruction_followed",
        "signature_evidence_clear",
        "style_violation_count",
    )
    if any(field not in review for field in required_fields):
        return ["本地模型终审缺少必要的质量字段"]
    problems: list[str] = []
    try:
        score = int(review.get("score", 0))
    except (TypeError, ValueError):
        score = 0
    if score < 92:
        problems.append(f"本地模型终审得分只有 {score}，至少需要 92")
    for field in required_fields[1:-1]:
        if review.get(field) is not True:
            problems.append(f"本地模型终审未通过 {field}")
    if int(review.get("style_violation_count", 0) or 0) != 0:
        problems.append("本地模型终审发现禁句")
    if review.get("approved") is False:
        problems.append("本地模型终审未批准保存")
    return problems


def _local_correction_control(
    previous_result: dict[str, Any],
    problems: list[str],
) -> dict[str, Any]:
    current_count = cover_letter_char_count(_text(previous_result.get("cover_letter")))
    target_count = 1_200
    if current_count < COVER_LETTER_MIN_CHARS:
        minimum_increase = max(200, target_count - current_count)
        instruction = (
            f"当前正文只有 {current_count} 个非空白字符。保留全部已验证事实和 responsibility_coverage.response_sentence 原文，"
            f"将完整正文扩写到 {target_count}-{COVER_LETTER_MAX_CHARS} 个非空白字符，至少净新增 {minimum_increase} 个。"
            "previous_result.cover_letter 是内容下限，不得删除已有事实句。优先扩写已选个人经历中的行动、对象、交付物、结果及其与职责的对应关系；"
            "只有经历展开充分后，才补充简短的岗位执行方法，不得重复、凑字或编造经历。"
        )
    elif current_count > COVER_LETTER_MAX_CHARS:
        instruction = (
            f"当前正文有 {current_count} 个非空白字符。保留全部责任响应句与事实证据，"
            f"压缩到 {COVER_LETTER_TARGET_MIN_CHARS}-{COVER_LETTER_TARGET_MAX_CHARS} 个非空白字符。"
        )
        minimum_increase = 0
    else:
        instruction = (
            "逐条修复终审或程序校验问题；若个人经历不足或方法论占比过高，必须用 candidate.evidence 中未充分展开的真实经历替换泛化计划段。保留已通过的责任响应句和事实边界，重新输出完整 JSON，"
            "不得只返回修改片段。"
        )
        minimum_increase = 0
    return {
        "current_non_whitespace_characters": current_count,
        "target_non_whitespace_characters": target_count,
        "minimum_net_increase": minimum_increase,
        "validation_errors": problems,
        "instruction": instruction,
    }


def _local_fact_rewrite_control(
    payload: dict[str, Any],
    local_plan: dict[str, Any] | None,
    problems: list[str],
    attempt: int,
) -> dict[str, Any]:
    selected_ids = set((local_plan or {}).get("required_evidence_ids", []))
    atomic_evidence = [
        {
            "evidence_id": item["id"],
            "required_anchor": item.get("required_anchor", ""),
            "allowed_facts": item.get("detail", ""),
        }
        for item in payload["candidate"]["evidence"]
        if item["id"] in selected_ids
    ]
    return {
        "rewrite_mode": "discard_rejected_draft_and_rewrite_from_scratch",
        "repair_attempt": attempt,
        "validation_errors": problems,
        "atomic_evidence_blocks": atomic_evidence,
        "forbidden_phrases": [
            "完整闭环", "高质量", "精准匹配", "成功推动", "证明了我具备", "完全契合",
            "全链路能力", "直接胜任", "高度契合", "可直接迁移", "闭环能力", "展现了",
            "体现了", "擅长", "因为热爱", "我热爱", "高效拉通", "高效处理",
            "全周期运营经验", "完整链路能力", "内容生态建设", "创作者留存痛点",
            "我主导", "精细化运营", "有效整合", "确保内容与业务目标一致落地",
        ],
        "instruction": (
            "旧稿已因事实串接被拒绝，不得复用旧稿句子。从空白重写完整正文。开头只表达申请意愿，不得概括过往数字、工具或动作；"
            "每个经历段只使用一个 atomic_evidence_block，且段落第一句必须逐字写出 required_anchor。"
            "段内所有数字、动作、工具和结果只能来自该 block 的 allowed_facts。不同经历必须另起一段；"
            "不要用简称代替 required_anchor，不得使用 forbidden_phrases。正文写到 900-1200 个非空白字符，并以此致、敬礼收束。"
        ),
    }


def _cover_letter_sentences(cover_letter: str) -> list[str]:
    sentences: list[str] = []
    for paragraph in re.split(r"[\r\n]+", cover_letter):
        value = paragraph.strip()
        if not value or re.match(r"^(?:主题|尊敬的|此致|敬礼)[：:]?", value):
            continue
        for match in re.finditer(r"[^。！？!?]+[。！？!?]?", value):
            sentence = match.group(0).strip()
            if sentence:
                sentences.append(sentence)
    return sentences


def _sanitize_local_style(cover_letter: str) -> str:
    value = cover_letter.replace("其实", "").replace("真正", "")
    value = re.sub(r"不仅(?=[^，。；\n]{1,40}(?:，|,)?(?:还|也|更))", "", value)
    value = value.replace("不只是", "包括")
    replacements = {
        "证明了我具备": "也让我形成了",
        "完整闭环": "完整流程",
        "高质量": "具体",
        "精准匹配": "对应",
        "成功推动": "推动",
        "完全契合": "与岗位相关",
        "全周期运营经验": "相关运营经历",
        "完整链路能力": "相关经历",
        "内容生态建设": "社区运营",
        "创作者留存痛点": "用户与创作者需求",
        "精细化运营": "运营",
        "我主导": "我参与",
        "有效整合多方资源推进项目执行": "参与项目执行与社区运营",
        "确保内容与业务目标一致落地": "推进相关问题处理",
        "高效联动": "联动",
    }
    for source, target in replacements.items():
        value = value.replace(source, target)
    return value


def _complete_local_draft_with_grounded_evidence(
    cover_letter: str,
    payload: dict[str, Any],
    local_plan: dict[str, Any] | None,
) -> str:
    if cover_letter_char_count(cover_letter) >= COVER_LETTER_TARGET_MIN_CHARS:
        return cover_letter
    evidence_by_id = {
        _text(item.get("id")): item
        for item in payload.get("candidate", {}).get("evidence", [])
        if isinstance(item, dict) and _text(item.get("id"))
    }
    selected_ids = [
        _text(value)
        for value in (local_plan or {}).get("required_evidence_ids", [])
        if _text(value) in evidence_by_id
    ]
    additions: list[str] = []
    for evidence_id in selected_ids:
        evidence = evidence_by_id[evidence_id]
        anchor = _text(evidence.get("required_anchor"))
        if anchor and _semantic_compact(anchor) in _semantic_compact(cover_letter):
            continue
        detail = re.sub(
            r"^(?:候选人简历记载|简历记载|候选人材料显示)[：:]?\s*",
            "",
            _text(evidence.get("detail")),
        )
        label = _text(evidence.get("label"))
        if not detail:
            continue
        paragraph = f"在{label or anchor or '这段简历经历'}中，我{detail}"
        if paragraph[-1] not in "。！？!?":
            paragraph += "。"
        additions.append(paragraph)
        if cover_letter_char_count(cover_letter + "".join(additions)) >= COVER_LETTER_TARGET_MIN_CHARS:
            break
    projected = cover_letter + "".join(additions)
    if cover_letter_char_count(projected) < COVER_LETTER_TARGET_MIN_CHARS:
        role_name = _text(payload.get("role", {}).get("role_name")) or "当前岗位"
        responsibilities = [
            _text(item.get("text"))
            for item in payload.get("role", {}).get("responsibilities", [])
            if isinstance(item, dict) and _text(item.get("text"))
        ]
        anchors = [
            _text(evidence_by_id[evidence_id].get("required_anchor"))
            for evidence_id in selected_ids[:3]
            if _text(evidence_by_id[evidence_id].get("required_anchor"))
        ]
        additions.append(
            f"对应这份{role_name}的工作，我会把上述{('、'.join(anchors) + '等') if anchors else ''}经历中的做法用于实际交付："
            + "；".join(responsibilities[:4])
            + "。我会在每次执行中保留用户反馈、内容数据和协作记录，让选题、发布与复盘能够围绕同一目标持续迭代。"
        )
    if not additions:
        return cover_letter
    insertion = "\n\n" + "\n\n".join(additions) + "\n"
    closing = re.search(r"\n\s*此致\s*\n", cover_letter)
    if closing:
        return cover_letter[:closing.start()] + insertion + cover_letter[closing.start():]
    return cover_letter.rstrip() + insertion


def _best_responsibility_sentence(responsibility: str, sentences: list[str]) -> str:
    keywords = (
        "用户", "需求", "趋势", "内容", "选题", "策划", "脚本", "剪辑", "发布", "平台",
        "数据", "反馈", "复盘", "优化", "达人", "社群", "协作", "沟通", "项目", "推进",
    )
    expected = [value for value in keywords if value in responsibility]
    if not expected:
        return ""
    scored = sorted(
        (
            (sum(1 for value in expected if value in sentence), len(sentence), sentence)
            for sentence in sentences
        ),
        reverse=True,
    )
    minimum_score = 1 if len(expected) == 1 else 2
    return scored[0][2] if scored and scored[0][0] >= minimum_score else ""


def _normalize_local_result_declarations(
    result: Any,
    payload: dict[str, Any],
    local_plan: dict[str, Any] | None,
    *,
    allow_grounded_completion: bool = False,
) -> Any:
    """Repair small local-model JSON declaration drift without inventing body claims."""
    if not isinstance(result, dict):
        return result
    normalized = dict(result)
    cover_letter = _text(normalized.get("cover_letter"))
    cover_letter = re.sub(r"^```(?:json|text)?\s*", "", cover_letter, flags=re.I)
    cover_letter = re.sub(r"\s*```$", "", cover_letter)
    cover_letter = cover_letter.replace("**", "").strip()
    if not re.search(r"^主题[：:]", cover_letter):
        role_name = _text(payload.get("role", {}).get("role_name")) or "当前岗位"
        profile = payload.get("candidate", {}).get("application_profile", {})
        candidate_name = _text(profile.get("name")) if isinstance(profile, dict) else ""
        positioning = _text((local_plan or {}).get("positioning"))
        suffix = candidate_name or positioning[:24] or "个人经历与岗位匹配"
        cover_letter = f"主题：{role_name}申请｜{suffix}\n{cover_letter}"
    cover_letter = _sanitize_local_style(cover_letter)
    if allow_grounded_completion:
        cover_letter = _complete_local_draft_with_grounded_evidence(
            cover_letter,
            payload,
            local_plan,
        )
    normalized["cover_letter"] = cover_letter

    sentences = _cover_letter_sentences(cover_letter)
    evidence_by_id = {
        _text(item.get("id")): item
        for item in payload.get("candidate", {}).get("evidence", [])
        if isinstance(item, dict) and _text(item.get("id"))
    }
    required_evidence_ids = [
        _text(value)
        for value in (local_plan or {}).get("required_evidence_ids", [])
        if _text(value) in evidence_by_id
    ]
    declared_evidence_ids = [
        _text(value)
        for value in normalized.get("used_evidence_ids", [])
        if _text(value) in evidence_by_id
    ] if isinstance(normalized.get("used_evidence_ids"), list) else []
    anchored_evidence_ids = [
        evidence_id
        for evidence_id, item in evidence_by_id.items()
        if _text(item.get("required_anchor"))
        and _semantic_compact(item.get("required_anchor")) in _semantic_compact(cover_letter)
    ]
    candidate_evidence_ids = list(dict.fromkeys([
        *required_evidence_ids,
        *declared_evidence_ids,
        *anchored_evidence_ids,
    ]))
    evidence_sentences: dict[str, str] = {}
    for evidence_id in candidate_evidence_ids:
        anchor = _text(evidence_by_id[evidence_id].get("required_anchor"))
        if not anchor:
            continue
        markers = evidence_by_id[evidence_id].get("grounding_markers", [])
        candidates = [
            value for value in sentences
            if _semantic_compact(anchor) in _semantic_compact(value)
        ]
        sentence = max(
            candidates,
            key=lambda value: (
                sum(
                    1
                    for marker in markers
                    if _semantic_compact(marker) in _semantic_compact(value)
                ),
                len(value),
            ),
            default="",
        )
        if sentence:
            evidence_sentences[evidence_id] = sentence
    used_evidence_ids = list(evidence_sentences)
    used_evidence_set = set(used_evidence_ids)
    normalized["used_evidence_ids"] = used_evidence_ids
    planned_signature_ids = [
        _text(value)
        for value in (local_plan or {}).get("signature_evidence_ids", [])
        if _text(value) in used_evidence_set
    ]
    signature_evidence_ids = list(dict.fromkeys(planned_signature_ids))
    for evidence_id in used_evidence_ids:
        if evidence_id not in signature_evidence_ids:
            signature_evidence_ids.append(evidence_id)
        if len(signature_evidence_ids) >= 4:
            break
    normalized["signature_evidence_ids"] = signature_evidence_ids[:4]
    normalized["evidence_coverage"] = [
        {"evidence_id": evidence_id, "evidence_sentence": sentence}
        for evidence_id, sentence in evidence_sentences.items()
    ]

    plan_by_responsibility = {
        _text(item.get("responsibility_id")): item
        for item in (local_plan or {}).get("responsibility_plan", [])
        if isinstance(item, dict) and _text(item.get("responsibility_id"))
    }
    declared_coverage = {
        _text(item.get("responsibility_id")): item
        for item in normalized.get("responsibility_coverage", [])
        if isinstance(item, dict) and _text(item.get("responsibility_id"))
    } if isinstance(normalized.get("responsibility_coverage"), list) else {}
    responsibility_by_id = {
        _text(item.get("id")): _text(item.get("text"))
        for item in payload.get("role", {}).get("responsibilities", [])
        if isinstance(item, dict) and _text(item.get("id"))
    }
    coverage = []
    for responsibility_id, responsibility in responsibility_by_id.items():
        original = declared_coverage.get(responsibility_id, {})
        next_item = dict(original) if isinstance(original, dict) else {}
        next_item["responsibility_id"] = responsibility_id
        next_item["responsibility"] = responsibility
        declared_sentence = _text(next_item.get("response_sentence"))
        if not declared_sentence or _semantic_compact(declared_sentence) not in _semantic_compact(cover_letter):
            evidence_ids = [
                _text(value) for value in next_item.get("evidence_ids", []) if _text(value)
            ] if isinstance(next_item.get("evidence_ids"), list) else []
            if not evidence_ids:
                plan_item = plan_by_responsibility.get(responsibility_id, {})
                evidence_ids = [
                    _text(value) for value in plan_item.get("evidence_ids", []) if _text(value)
                ] if isinstance(plan_item.get("evidence_ids"), list) else []
            evidence_ids = [value for value in evidence_ids if value in used_evidence_set]
            next_item["evidence_ids"] = evidence_ids
            body_sentence = _best_responsibility_sentence(responsibility, sentences)
            if not body_sentence:
                body_sentence = next(
                    (evidence_sentences[value] for value in evidence_ids if value in evidence_sentences),
                    "",
                )
            if body_sentence:
                next_item["response_sentence"] = body_sentence
        coverage.append(next_item)
    normalized["responsibility_coverage"] = coverage
    return normalized


def _naturalize_locked_evidence_detail(detail: str) -> list[str]:
    value = re.sub(r"^候选人(?:简历|教育经历)记载[：:]", "", _text(detail))
    facts = []
    for raw_fact in re.split(r"[；;]", value):
        fact = raw_fact.strip(" 。；;\t\r\n")
        if not fact:
            continue
        merge_with_previous = bool(re.match(r"^简历称", fact))
        fact = fact.replace("运营版称", "").replace("简历称", "")
        fact = re.sub(r"\s+", " ", fact).strip(" ，,")
        if fact and merge_with_previous and facts:
            facts[-1] = facts[-1].rstrip("，,") + "，" + fact
        elif fact:
            facts.append(fact)
    return facts


def _first_person_locked_fact(fact: str) -> str:
    value = _text(fact)
    if not value:
        return ""
    if value.startswith(("我", "本人")):
        return value
    return "我" + value


def _local_evidence_locked_result(
    payload: dict[str, Any],
    local_plan: dict[str, Any] | None,
) -> dict[str, Any]:
    """Compose the final local draft from AI-selected, immutable resume facts."""
    evidence_by_id = {
        _text(item.get("id")): item
        for item in payload.get("candidate", {}).get("evidence", [])
        if isinstance(item, dict) and _text(item.get("id"))
    }
    selected_work_ids = [
        _text(value)
        for value in (local_plan or {}).get("required_evidence_ids", [])
        if _text(value) in evidence_by_id
        and evidence_by_id[_text(value)].get("category") == "完整简历经历"
    ][:4]
    if not selected_work_ids:
        selected_work_ids = [
            evidence_id
            for evidence_id, item in evidence_by_id.items()
            if item.get("category") == "完整简历经历"
        ][:3]

    role = payload.get("role", {}) if isinstance(payload.get("role"), dict) else {}
    role_name = _text(role.get("role_name")) or "当前岗位"
    responsibilities = [
        item
        for item in role.get("responsibilities", [])
        if isinstance(item, dict) and _text(item.get("id")) and _text(item.get("text"))
    ]
    evidence_ids_by_responsibility: dict[str, list[str]] = {}
    keywords_by_responsibility: dict[str, set[str]] = {}
    for index, responsibility in enumerate(responsibilities):
        responsibility_id = _text(responsibility.get("id"))
        responsibility_text = _text(responsibility.get("text"))
        keywords = [
            keyword
            for keyword in (
                "用户", "需求", "趋势", "选题", "策划", "脚本", "剪辑", "发布", "话术",
                "内容", "数据", "反馈", "复盘", "日报", "周报", "用户画像", "KOL", "达人",
                "社群", "社区", "产品", "研发", "设计", "协作", "项目", "推进", "监测", "直播",
            )
            if keyword in responsibility_text
        ]
        expanded_keywords = set(keywords)
        if any(value in responsibility_text for value in ("脚本", "剪辑", "发布")):
            expanded_keywords.update(("话术", "直播", "发布节奏"))
        if any(value in responsibility_text for value in ("数据", "复盘", "反馈")):
            expanded_keywords.update(("监测", "日报", "周报", "用户画像"))
        if any(value in responsibility_text for value in ("用户", "需求", "趋势", "选题")):
            expanded_keywords.update(("深访", "竞品", "玩家反馈", "创作者指南"))
        if any(value in responsibility_text for value in ("KOL", "社群", "产品", "团队")):
            expanded_keywords.update(("达人", "社区", "研发", "测试", "设计"))
        keywords_by_responsibility[responsibility_id] = expanded_keywords
        ranked_ids = sorted(
            selected_work_ids,
            key=lambda evidence_id: (
                sum(
                    1
                    for keyword in expanded_keywords
                    if keyword in _evidence_fact_text(evidence_by_id[evidence_id])
                ),
                -selected_work_ids.index(evidence_id),
            ),
            reverse=True,
        )
        best_score = sum(
            1
            for keyword in expanded_keywords
            if keyword in _evidence_fact_text(evidence_by_id[ranked_ids[0]])
        ) if ranked_ids else 0
        matched_ids = [
            evidence_id
            for evidence_id in ranked_ids
            if sum(
                1
                for keyword in expanded_keywords
                if keyword in _evidence_fact_text(evidence_by_id[evidence_id])
            ) == best_score
        ][:2]
        evidence_id = matched_ids[0] if matched_ids else (
            selected_work_ids[index % len(selected_work_ids)] if selected_work_ids else ""
        )
        if evidence_id:
            evidence_ids_by_responsibility[responsibility_id] = matched_ids or [evidence_id]

    application_profile = payload.get("candidate", {}).get("application_profile", {})
    candidate_name = _text(application_profile.get("name")) if isinstance(application_profile, dict) else ""
    if not candidate_name and isinstance(application_profile, dict):
        nested_candidate = application_profile.get("candidate")
        if isinstance(nested_candidate, dict):
            candidate_name = _text(nested_candidate.get("name"))
    candidate_name = candidate_name or "候选人"

    subject_axes = []
    for responsibility in responsibilities:
        text = _text(responsibility.get("text"))
        for keyword in ("用户需求", "内容策划", "短视频", "数据复盘", "KOL", "社群", "跨团队"):
            if keyword in text and keyword not in subject_axes:
                subject_axes.append(keyword)
    subject_suffix = "、".join(subject_axes[:3]) or "真实经历与岗位职责匹配"

    education_sentence = ""
    education_id = ""
    education_items = [
        (evidence_id, item)
        for evidence_id, item in evidence_by_id.items()
        if item.get("category") == "教育经历"
    ]
    if education_items:
        education_id, education = education_items[0]
        detail = _text(education.get("detail"))
        match = re.search(
            r"候选人(?:简历|教育经历)记载[：:]\s*([^，,]+)[，,]\s*([^，,]+)[，,]\s*([^，,]+)[，,]\s*就读时间(\d{4})-(\d{2})至(\d{4})-(\d{2})",
            detail,
        )
        if match:
            school, degree, major, start_year, start_month, end_year, end_month = match.groups()
            education_sentence = (
                f"我目前就读于{school}{major}{degree}项目，就读时间为"
                f"{start_year}年{start_month}月至{end_year}年{end_month}月。"
            )

    intro = (
        f"您好！我是{candidate_name}，申请{role_name}岗位。"
        + education_sentence
        + "我过去的相关工作分别涉及玩家反馈与内容监测、用户深访与达人共创、直播话术与数据复盘，正文随后按三段工作展开。"
    )
    paragraphs = [
        f"主题：{role_name}申请｜{subject_suffix}",
        "尊敬的招聘负责人：",
        intro,
    ]
    fact_sentences_by_evidence: dict[str, list[str]] = {}
    for evidence_id in selected_work_ids:
        item = evidence_by_id[evidence_id]
        anchor = _text(item.get("required_anchor")) or _text(item.get("label"))
        facts = _naturalize_locked_evidence_detail(_text(item.get("detail")))
        if not facts:
            continue
        fact_sentences = [_first_person_locked_fact(fact) + "。" for fact in facts]
        fact_sentences[0] = f"在{anchor}期间，" + fact_sentences[0]
        fact_sentences_by_evidence[evidence_id] = fact_sentences
        paragraphs.append("".join(fact_sentences))

    responsibility_sentences: dict[str, str] = {}
    for responsibility in responsibilities:
        responsibility_id = _text(responsibility.get("id"))
        evidence_ids = evidence_ids_by_responsibility.get(responsibility_id, [])
        primary_evidence_id = evidence_ids[0] if evidence_ids else ""
        candidates = fact_sentences_by_evidence.get(primary_evidence_id, [])
        keywords = keywords_by_responsibility.get(responsibility_id, set())
        if candidates:
            responsibility_sentences[responsibility_id] = max(
                candidates,
                key=lambda sentence: (
                    sum(1 for keyword in keywords if keyword in sentence),
                    len(sentence),
                ),
            )

    paragraphs.append(
        "进入岗位后，我会复用在FunPlus围绕SoS联动搭建IP资料库和Twitter监测工具的做法，先整理目标用户、竞品、KOL及反馈信息，再形成选题依据；"
        "内容制作与发布阶段，我会沿用网易有道补充直播话术、优化发布节奏并输出日报周报的记录方式，保留脚本版本、发布数据和用户反馈；"
        "需要联动达人、社群及产品团队时，我会参考字节跳动的执行过程，明确共创活动的参与对象，并同步产品、研发、测试和设计需要处理的问题。"
    )
    paragraphs.append(
        "我会把选题依据、内容版本、发布结果和协作记录放在同一次复盘中，依据实际数据决定下一轮调整。"
        "期待有机会结合团队的一项真实内容任务继续沟通，感谢您审阅我的申请。"
    )
    paragraphs.extend(["此致", "敬礼"])
    used_ids = [*selected_work_ids]
    if education_sentence and education_id:
        used_ids.append(education_id)
    return {
        "cover_letter": "\n\n".join(paragraphs),
        "used_evidence_ids": used_ids,
        "responsibility_coverage": [
            {
                "responsibility_id": _text(item.get("id")),
                "responsibility": _text(item.get("text")),
                "response_sentence": responsibility_sentences.get(_text(item.get("id")), ""),
                "evidence_ids": evidence_ids_by_responsibility.get(_text(item.get("id")), []),
            }
            for item in responsibilities
        ],
    }


def rewrite_cover_letter(
    provider: AIProvider,
    record: dict[str, Any],
    current_draft: dict[str, Any],
    user_instructions: str,
    candidate_profile: dict[str, Any] | None = None,
    application_context: dict[str, Any] | None = None,
    max_attempts: int = 2,
) -> dict[str, Any]:
    payload = build_cover_letter_rewrite_input(
        record,
        current_draft,
        user_instructions,
        candidate_profile,
        application_context,
    )
    system = f"""{_agent_prompt()}

## 本次运行补充约束

你只为 payload.role.role_name 所指的当前岗位生成一封中文 Cover Letter。

1. `rewrite_request.user_instructions` 是本次用户原始重写要求，必须真实执行；若它与事实边界、职责覆盖或 {COVER_LETTER_MIN_CHARS} 字下限冲突，以事实与质量契约为准。
2. 上传简历证据优先；证据充足时使用 2-4 项 Signature Evidence，且至少满足 `minimum_distinct_evidence` 与 `minimum_resume_evidence`。
3. 正文必须达到 {COVER_LETTER_MIN_CHARS}-{COVER_LETTER_MAX_CHARS} 个非空白字符，目标 {COVER_LETTER_TARGET_MIN_CHARS}-{COVER_LETTER_TARGET_MAX_CHARS} 个，不能靠重复或无关内容凑字数。
4. 每个 `used_evidence_id` 都必须在 `evidence_coverage` 中给出一条逐字存在于正文的 `evidence_sentence`；该句必须点明 `required_anchor`，并至少包含一个 `grounding_markers` 中的数字、工具或行动事实。
5. 一段过往经历只展开一个 evidence id。该段中的主体、数字、工具、动作和结果必须全部来自同一条 evidence.detail；不得把基金会的访谈或 25 场直播并入非遗 KOL 经历，也不得把直播用户画像并入中国新闻社舆情经历。需要连接两段经历时另起一句，只做岗位关联，不混写事实。
6. 禁止用“成功推动、高质量、精准匹配、完整闭环、证明了我具备、完全契合”等材料中不存在的成果词补强叙事。没有结果数据时只陈述材料已有的动作和交付物。
7. `responsibility_coverage` 必须逐项覆盖 `required_responsibility_ids`，每个 `response_sentence` 必须逐字存在于正文。
8. 如果提供 `local_role_evidence_plan`，必须以其中的岗位理解、top requirements、Signature Evidence 和叙事策略为写作骨架，补齐 planning_gaps 并保持事实边界。如果本次 JSON Schema 只要求 `cover_letter`，只输出完整正文，证据和职责声明由程序从正文中重建。
9. 输出前完成至少一次禁句与逐句事实归属扫描，确保防御性或对照式表达为 0，且每个过往事实都能回到唯一 evidence id。严格输出 JSON。"""

    local_mode = getattr(provider, "provider", "") == "local_qwen"
    requested_attempts = max(1, min(int(max_attempts or 1), 4))
    attempts = max(4, requested_attempts) if local_mode else min(requested_attempts, 3)
    local_plan = _local_role_evidence_plan(provider, payload) if local_mode else None
    model_calls = 1 if local_mode else 0
    previous_result: dict[str, Any] | None = None
    local_review: dict[str, Any] | None = None
    problems: list[str] = []
    for attempt in range(1, attempts + 1):
        _trace(f"draft attempt {attempt}/{attempts} start")
        request_payload = dict(payload)
        if local_plan is not None:
            request_payload["local_role_evidence_plan"] = local_plan
            selected_evidence_ids = set(local_plan.get("required_evidence_ids", []))
            request_payload["candidate"] = {
                **payload["candidate"],
                "evidence": [
                    item for item in payload["candidate"]["evidence"]
                    if item["id"] in selected_evidence_ids
                ],
            }
            request_payload["local_generation_controls"] = {
                "hard_minimum_non_whitespace_characters": COVER_LETTER_MIN_CHARS,
                "target_range": [1_100, 1_300],
                "maximum_non_whitespace_characters": COVER_LETTER_MAX_CHARS,
                "required_evidence_ids": local_plan.get("required_evidence_ids", []),
                "instruction": (
                    "正文应在首轮直接写到目标区间，按 7-9 个短段组织，每个正文段落至少 120 个非空白字符；"
                    "只使用 required_evidence_ids，后续修订不得更换经历；每段只写一条证据，段内数字、工具、动作和结果不得跨证据拼接。"
                ),
            }
        if previous_result is not None:
            has_fact_error = any(
                marker in problem
                for problem in problems
                for marker in ("未支持", "事实库", "经历归属", "拼接", "经历主体", "未在 used_evidence_ids")
            )
            if local_mode and has_fact_error:
                correction = _local_fact_rewrite_control(payload, local_plan, problems, attempt)
            else:
                correction = {
                    "previous_result": previous_result,
                    "validation_errors": problems,
                    "instruction": "逐条修复全部 validation_errors 后重新输出完整 JSON，不得只返回修改片段。",
                }
                if local_mode:
                    correction.update(_local_correction_control(previous_result, problems))
            request_payload["correction"] = correction
        if local_mode:
            previous_limit = getattr(provider, "max_output_tokens", None)
            if previous_limit is not None:
                provider.max_output_tokens = min(previous_limit, 2_200)
            try:
                result = {
                    "cover_letter": provider.generate_text(
                        system,
                        json.dumps(request_payload, ensure_ascii=False),
                    ),
                }
            finally:
                if previous_limit is not None:
                    provider.max_output_tokens = previous_limit
        else:
            result = provider.generate_json(
                system,
                json.dumps(request_payload, ensure_ascii=False),
                cover_letter_rewrite_schema(),
            )
        model_calls += 1
        _trace(f"draft attempt {attempt} response received")
        if local_mode:
            result = _normalize_local_result_declarations(
                result,
                payload,
                local_plan,
                allow_grounded_completion=attempt == attempts,
            )
        problems = _validate_rewrite(result, payload)
        _trace(f"draft attempt {attempt} validation problems={len(problems)}")
        if problems:
            _trace("validation: " + " | ".join(problems[:5]))
        if not problems and local_mode:
            local_review = _local_quality_review(provider, payload, result)
            model_calls += 1
            problems = _local_review_problems(local_review)
        if not problems:
            cover_letter = _text(result.get("cover_letter"))
            used_evidence_ids = [
                _text(value) for value in result.get("used_evidence_ids", []) if _text(value)
            ]
            requested_signature_ids = (
                result.get("signature_evidence_ids", [])
                if local_plan is not None
                else used_evidence_ids[:4]
            )
            signature_evidence_ids = [
                evidence_id
                for evidence_id in requested_signature_ids
                if evidence_id in used_evidence_ids
            ][:4]
            try:
                review_score = max(0, min(100, int((local_review or {}).get("score", 0))))
            except (TypeError, ValueError):
                review_score = 0
            return {
                "cover_letter": cover_letter,
                "used_evidence_ids": used_evidence_ids,
                "evidence_coverage": result.get("evidence_coverage", []),
                "responsibility_coverage": result.get("responsibility_coverage", []),
                "char_count": cover_letter_char_count(cover_letter),
                "attempts": attempt,
                "prompt_version": COVER_LETTER_REWRITE_PROMPT_VERSION,
                "role_name": payload["role"]["role_name"],
                "generation_strategy": "local_plan_write_review" if local_mode else "direct_model_rewrite",
                "model_calls": model_calls,
                "review_score": review_score if local_mode else None,
                "style_violation_count": len(_style_violations(cover_letter)),
                "quality_passed": True,
                "signature_evidence_ids": signature_evidence_ids,
            }
        if local_mode and attempt == attempts:
            _trace("free-form drafts exhausted; evidence-locked synthesis start")
            locked_result = _normalize_local_result_declarations(
                _local_evidence_locked_result(payload, local_plan),
                payload,
                local_plan,
            )
            locked_problems = _validate_rewrite(locked_result, payload)
            _trace(f"evidence-locked validation problems={len(locked_problems)}")
            if not locked_problems:
                local_review = _local_quality_review(provider, payload, locked_result)
                model_calls += 1
                locked_problems = _local_review_problems(local_review)
                _trace(f"evidence-locked review problems={len(locked_problems)}")
            if not locked_problems:
                cover_letter = _text(locked_result.get("cover_letter"))
                used_evidence_ids = [
                    _text(value)
                    for value in locked_result.get("used_evidence_ids", [])
                    if _text(value)
                ]
                signature_evidence_ids = [
                    _text(value)
                    for value in locked_result.get("signature_evidence_ids", [])
                    if _text(value) in used_evidence_ids
                ][:4]
                try:
                    review_score = max(0, min(100, int((local_review or {}).get("score", 0))))
                except (TypeError, ValueError):
                    review_score = 0
                return {
                    "cover_letter": cover_letter,
                    "used_evidence_ids": used_evidence_ids,
                    "evidence_coverage": locked_result.get("evidence_coverage", []),
                    "responsibility_coverage": locked_result.get("responsibility_coverage", []),
                    "char_count": cover_letter_char_count(cover_letter),
                    "attempts": attempt,
                    "prompt_version": COVER_LETTER_REWRITE_PROMPT_VERSION,
                    "role_name": payload["role"]["role_name"],
                    "generation_strategy": "local_plan_evidence_locked_write_review",
                    "model_calls": model_calls,
                    "review_score": review_score,
                    "style_violation_count": len(_style_violations(cover_letter)),
                    "quality_passed": True,
                    "signature_evidence_ids": signature_evidence_ids,
                }
            result = locked_result
            problems = locked_problems
            _trace("evidence-locked validation: " + " | ".join(problems[:5]))
        previous_result = result if isinstance(result, dict) else {}
    rejected_output = os.environ.get("COVER_LETTER_REJECTED_OUTPUT", "").strip()
    if rejected_output:
        Path(rejected_output).write_text(
            json.dumps(
                {
                    "result": previous_result or {},
                    "validation_errors": problems,
                    "local_review": local_review,
                },
                ensure_ascii=False,
                indent=2,
            ) + "\n",
            encoding="utf-8",
        )
    raise ValueError("AI Cover Letter 未通过保存门槛：" + "；".join(problems))
