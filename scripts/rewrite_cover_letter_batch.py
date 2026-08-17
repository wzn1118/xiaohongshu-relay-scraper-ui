"""Generate many grounded cover letters in one external-model request."""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from ai_application_workflow import (
    _application_copy_source_hash,
    _normalize_application_context,
    _role_evidence_alignment,
    _signal_groups,
)
from ai_provider_runtime import AIProvider
from cover_letter_rewriter import (
    _bounded_cover_letter_subject,
    _split_cover_letter_subject,
    build_cover_letter_rewrite_input,
    cover_letter_char_count,
)

DEFAULT_ASCII_PROMPT = Path(__file__).resolve().parent / "prompts" / "cover_letter_batch_ascii_en.txt"

ASCII_BATCH_INSTRUCTIONS = (
    "Generate complete, role-specific outreach in Simplified Chinese from the supplied evidence brief. "
    "Keep TARGET_ROLE and CANDIDATE_NAME as literal markers. Use only supplied evidence facts and ids. "
    "Never use generic AI cliches such as bi huan, fu neng, zhua shou, quan lian lu, or gao du pi pei. "
    "Write in first person and never refer to the applicant as hou xuan ren."
)

GENERATED_TEXT_REPLACEMENTS = (
    ("我相信凭借我的能力一定能够", "我会"),
    ("怀着极大热情", "希望"),
    ("怀着满腔热情", "希望"),
    ("完美契合", "相关"),
    ("高度匹配", "相关"),
    ("深感荣幸", "希望"),
    ("全链路", "从分析到交付"),
    ("闭环", "完整推进"),
    ("赋能", "支持"),
    ("抓手", "具体做法"),
    ("候选人", "任职者"),
)

EMAIL_NEXT_STEP_PATTERN = re.compile(
    r"(?:(?:期待|希望|方便|愿意).{0,32}(?:沟通|交流|面试|进一步了解)|"
    r"(?:welcome|hope|available).{0,24}(?:interview|discuss|conversation|talk))",
    re.I,
)
EMAIL_NEXT_STEP_SENTENCE = "如方便，期待与您进一步沟通。"

ASCII_EVIDENCE_FACTS = {
    "exp_2023_jhdf": (
        "Platform and user operations at China Digital Culture Group: conducted one-to-one user research, "
        "identified four core user scenarios, created contributor guidance, improved content structure, "
        "increased average reading time by 30 percent and completion rate by 77 percent, converted more "
        "than 4,000 private-community users, and raised weekly new content to more than 30 items."
    ),
    "exp_2023_cns": (
        "Brand public-relations internship at China News Service, with practical brand communication and "
        "business communication work."
    ),
    "exp_2022_xinhua": (
        "Marketing internship at the Xinhua News Agency national key laboratory, including marketing and "
        "data-analysis practice."
    ),
    "exp_2021_yd": (
        "User-operations internship at NetEase Youdao, including user operations and data-analysis practice."
    ),
    "exp_2026_ast": (
        "Led Asteria Analyst, a multi-agent data-analysis and report-delivery product: planned a seven-step "
        "workflow from data upload to report generation, designed exception handling and release gates, "
        "defined agent collaboration, delivered the PRD, architecture, and acceptance criteria, and built "
        "a traceable path from raw data to formal PDF reports. The open-source project received 259 stars."
    ),
    "exp_2026_xhs": (
        "Led a job-information collection and application-preparation workbench from zero to one: identified "
        "job-seeker pain points, designed structured role analysis, AI copy generation, and application "
        "preparation, wrote the PRD and interaction specification, and delivered 34 UI modules across eight "
        "agent stages with a defined acceptance system."
    ),
    "exp_2026_hg": (
        "Led Hegel Salon, an AI-assisted philosophy reading product: designed a six-step research workflow, "
        "separated source text, model output, and human judgment, built comprehension evaluation and quality "
        "improvement mechanisms, and delivered a multi-device Web application. The project received 98 stars."
    ),
    "exp_2025_manchester": (
        "Led a University of Manchester program-transfer consulting project: identified an underserved market, "
        "designed a lightweight service, acquired users through Xiaohongshu and communities, served eight paid "
        "cases, generated CNY 16,800 in revenue, reached more than 3,000 targeted users, and received more than "
        "50 consultations."
    ),
}

ROLE_CAPABILITY_RULES = (
    ("ai_product", "AI product design, model evaluation, prompt workflows, and intelligent process improvement", ("ai", "aigc", "大模型", "模型", "prompt", "智能化", "agent")),
    ("user_research", "user research, interviews, surveys, usability analysis, and insight synthesis", ("用户研究", "用研", "访谈", "问卷", "焦点小组", "可用性", "用户洞察", "需求挖掘")),
    ("data_analysis", "data monitoring, quantitative analysis, reporting, and evidence-based optimization", ("数据", "分析", "统计", "监测", "复盘", "指标", "报表", "报告", "sql", "excel", "r语言", "spss")),
    ("content", "content strategy, copywriting, short-video production, editing, and publishing", ("内容", "文案", "短视频", "图文", "剪辑", "脚本", "选题", "拍摄", "新媒体")),
    ("product", "product discovery, requirements analysis, PRD delivery, iteration, testing, and launch follow-through", ("产品", "需求", "prd", "版本", "迭代", "功能", "开发", "测试", "上线", "交互")),
    ("operations", "user, platform, community, and campaign operations with feedback-driven iteration", ("运营", "社群", "社区", "用户增长", "活跃", "留存", "转化", "活动")),
    ("marketing", "marketing strategy, brand communication, channel growth, and campaign execution", ("市场", "营销", "品牌", "推广", "公关", "投放", "增长", "传播")),
    ("commerce", "commercialization, business development, customer communication, and conversion", ("商业化", "商务", "客户", "销售", "营收", "gmv", "渠道", "合作")),
    ("research", "structured research, competitive analysis, strategic synthesis, and professional reporting", ("调研", "研究", "竞品", "战略", "行业", "政策", "咨询")),
    ("project", "cross-functional project coordination, delivery ownership, documentation, and execution", ("项目", "协同", "协调", "对接", "推进", "交付", "流程", "文档")),
)

CAPABILITY_LABELS = {
    "ai_product": "AI 产品设计与智能流程优化",
    "user_research": "用户研究与需求洞察",
    "data_analysis": "数据分析与复盘优化",
    "content": "内容策划与制作发布",
    "product": "产品需求、迭代与交付",
    "operations": "用户运营与活动运营",
    "marketing": "市场传播与品牌沟通",
    "commerce": "商业转化与客户沟通",
    "research": "行业研究与结构化分析",
    "project": "跨团队项目推进与交付",
    "execution": "结构化执行与可靠交付",
}

SIGNAL_GROUP_LABELS = {
    "data_analysis": "数据分析与指标复盘",
    "research_insight": "调研、访谈与信息洞察",
    "product": "产品需求、迭代与用户体验",
    "content": "内容策划与社交媒体运营",
    "growth_marketing": "增长、营销与转化",
    "user_operations": "用户与社群运营",
    "customer_sales": "客户、商务与渠道协作",
    "engineering_automation": "AI、工程与自动化",
    "design": "视觉、交互与体验设计",
    "finance": "财务、金融与投资分析",
    "medical": "医学、医药与临床业务",
    "global_language": "英语、海外与跨境协作",
    "communication": "沟通、协调与跨部门协作",
    "delivery": "项目推进、执行与交付",
}

SIGNAL_GROUP_WEIGHTS = {
    "engineering_automation": 5,
    "product": 4,
    "design": 4,
    "finance": 4,
    "medical": 4,
    "growth_marketing": 3,
    "user_operations": 3,
    "content": 3,
    "customer_sales": 3,
    "research_insight": 2,
    "data_analysis": 2,
    "global_language": 2,
    "communication": 1,
    "delivery": 1,
}

PLAIN_COVER_LETTER_SYSTEM = (
    "Write a detailed polished Simplified Chinese cover letter in five substantial paragraphs. "
    "Return plain text only. Use TARGET_ROLE and CANDIDATE_NAME literally. Use only supplied facts. "
    "Explain actions and transferable methods. Do not invent facts. Use 800-1000 Chinese characters."
)


def _text(value: Any) -> str:
    return str(value or "").strip()


def _trim(value: Any, limit: int) -> str:
    return _text(value)[:limit]


def _ascii_fragment(value: Any, limit: int = 120) -> str:
    return "".join(character for character in _text(value) if ord(character) < 128)[:limit].strip()


def _ascii_identifier(value: Any, fallback: str) -> str:
    text = _text(value)
    normalized = "".join(
        character if character.isascii() and (character.isalnum() or character in "._:-") else "-"
        for character in text
    ).strip("-")
    return normalized[:100] or fallback


def _capabilities_for_text(value: Any, limit: int = 3) -> list[dict[str, str]]:
    source = _text(value).lower()
    matches = [
        {"code": code, "capability": capability}
        for code, capability, keywords in ROLE_CAPABILITY_RULES
        if any(keyword.lower() in source for keyword in keywords)
    ]
    if not matches:
        matches = [{
            "code": "execution",
            "capability": "structured execution, clear communication, and reliable task delivery",
        }]
    return matches[:limit]


def _ascii_points(values: list[dict[str, str]], prefix: str) -> list[dict[str, str]]:
    points: list[dict[str, str]] = []
    for index, value in enumerate(values, start=1):
        capabilities = _capabilities_for_text(value.get("text"), 2)
        points.append({
            "id": _ascii_identifier(value.get("id"), f"{prefix}-{index}"),
            "capability": "; ".join(item["capability"] for item in capabilities),
        })
    return points


def _ascii_evidence(values: list[dict[str, Any]]) -> list[dict[str, Any]]:
    translated: list[dict[str, Any]] = []
    for index, value in enumerate(values, start=1):
        evidence_id = _ascii_identifier(value.get("id"), f"evidence-{index}")
        fact = ASCII_EVIDENCE_FACTS.get(evidence_id)
        if not fact:
            capabilities = _capabilities_for_text(
                f"{_text(value.get('label'))} {_text(value.get('detail'))}",
                3,
            )
            fact = (
                "The source profile records this experience as evidence of "
                + "; ".join(item["capability"] for item in capabilities)
                + ". Do not add organizations, dates, metrics, tools, or outcomes not present in this fact."
            )
        translated.append({
            "id": evidence_id,
            "fact": fact,
            "is_resume_evidence": bool(value.get("is_resume_evidence")),
        })
    return translated


def _compact_profile_ascii(profile: dict[str, Any]) -> dict[str, Any]:
    compact = _compact_profile(profile)
    school = _text(compact.get("school"))
    major = _text(compact.get("major"))
    degree_year = _text(compact.get("degreeYear"))
    education: list[str] = []
    if "曼彻斯特" in school:
        education.append("University of Manchester")
    elif value := _ascii_fragment(school, 80):
        education.append(value)
    if "全球发展" in major:
        education.append("Global Development")
    elif value := _ascii_fragment(major, 80):
        education.append(value)
    if "硕士" in degree_year and "2026" in degree_year:
        education.append("Master's student with expected graduation in 2026")
    elif value := _ascii_fragment(degree_year, 100):
        education.append(value)
    return {
        "name_marker": "CANDIDATE_NAME",
        "education": education,
    }


def _prompt_job(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "note_id": _ascii_identifier(job.get("note_id"), "missing-note-id"),
        "target_role_marker": "TARGET_ROLE",
        "role_capabilities": job.get("ROLE_CAPABILITIES", []),
        "responsibilities": job.get("PROMPT_RESPONSIBILITIES", []),
        "requirements": job.get("PROMPT_REQUIREMENTS", []),
        "EVIDENCE": job.get("PROMPT_EVIDENCE", []),
        "allowed_evidence_ids": [
            _ascii_identifier(value, "evidence") for value in job.get("allowed_evidence_ids", [])
        ],
        "minimum_distinct_evidence": int(job.get("minimum_distinct_evidence") or 0),
        "minimum_resume_evidence": int(job.get("minimum_resume_evidence") or 0),
        "resume_evidence_ids": [
            _ascii_identifier(value, "evidence") for value in job.get("resume_evidence_ids", [])
        ],
        "required_responsibility_ids": [
            _ascii_identifier(value, "responsibility")
            for value in job.get("required_responsibility_ids", [])
        ],
    }


def _assert_ascii(value: Any, label: str) -> None:
    serialized = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    first = next((character for character in serialized if ord(character) >= 128), "")
    if first:
        raise ValueError(f"{label} must be ASCII-only; found code point U+{ord(first):04X}")


def _plain_cover_letter_request(
    job: dict[str, Any],
    shared_candidate: dict[str, Any],
) -> tuple[str, str]:
    profile = shared_candidate.get("application_profile", {})
    education = "; ".join(
        _ascii_fragment(value, 80)
        for value in profile.get("education", [])[:3]
        if _ascii_fragment(value, 80)
    )
    capabilities = "; ".join(
        _ascii_fragment(value.get("capability"), 80)
        for value in job.get("ROLE_CAPABILITIES", [])[:3]
        if _ascii_fragment(value.get("capability"), 80)
    )
    facts = [
        _ascii_fragment(value.get("fact"), 180)
        for value in job.get("PROMPT_EVIDENCE", [])[:3]
        if _ascii_fragment(value.get("fact"), 180)
    ]
    request_lines = [
        "Write the complete letter now.",
        "Candidate: CANDIDATE_NAME.",
        f"Education: {education or 'Not supplied.'}",
        "Target role: TARGET_ROLE.",
        f"Role needs: {capabilities or 'structured execution and clear communication.'}",
        "Verified facts:",
        *[f"- {fact}" for fact in facts],
        "Connect the facts to TARGET_ROLE without adding any company, date, metric, tool, or outcome.",
        "Start with a formal Chinese hiring-manager salutation and end with a formal Chinese closing plus CANDIDATE_NAME.",
    ]
    request = "\n".join(request_lines)
    _assert_ascii(PLAIN_COVER_LETTER_SYSTEM, "plain-text system prompt")
    _assert_ascii(request, "plain-text provider request")
    return PLAIN_COVER_LETTER_SYSTEM, request


def _clean_generated_cover_letter(value: Any) -> str:
    text = _text(value).replace("\r\n", "\n")
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
    if text.endswith("```"):
        text = text[:-3].rstrip()
    salutation = "尊敬的招聘负责人"
    start = text.find(salutation)
    if start >= 0:
        text = text[start:]
    elif text:
        text = f"{salutation}：\n\n{text}"
    if "TARGET_ROLE" not in text:
        first_break = text.find("\n")
        insert_at = first_break + 1 if first_break >= 0 else len(text)
        text = f"{text[:insert_at]}\n我希望申请 TARGET_ROLE。\n{text[insert_at:]}".strip()
    if "此致" not in text or "敬礼" not in text:
        text = f"{text.rstrip()}\n\n此致\n敬礼"
    if "CANDIDATE_NAME" not in text:
        text = f"{text.rstrip()}\nCANDIDATE_NAME"
    return text.strip()


def _humanize_generated_text(value: Any, role_name: str) -> str:
    """Resolve model placeholders and deterministic high-frequency AI wording."""
    text = _text(value).replace("当前岗位", role_name)
    for source, replacement in GENERATED_TEXT_REPLACEMENTS:
        text = text.replace(source, replacement)
    while "。。" in text:
        text = text.replace("。。", "。")
    return text


def _ensure_email_communication_next_step(value: Any) -> str:
    """Keep the saved email within the delivery contract after model cleanup."""
    email_body = _text(value).strip()
    compact = re.sub(r"\s+", "", email_body)
    if EMAIL_NEXT_STEP_PATTERN.search(compact):
        return email_body

    if len(email_body) + 2 + len(EMAIL_NEXT_STEP_SENTENCE) <= 260:
        return f"{email_body}\n\n{EMAIL_NEXT_STEP_SENTENCE}".strip()

    # A response at the upper bound may not have room for a new paragraph. Preserve
    # its opening evidence statement and reserve the final sentence for the next step.
    normalized = re.sub(r"\s+", " ", email_body).strip()
    prefix_limit = max(0, 260 - len(EMAIL_NEXT_STEP_SENTENCE) - 1)
    prefix = normalized[:prefix_limit].rstrip("，；：,;:。.!！?？ ")
    return f"{prefix} {EMAIL_NEXT_STEP_SENTENCE}".strip()


def _clean_role_focus(value: Any) -> str:
    """Remove source-card headings before inserting a responsibility into prose."""
    text = _text(value)
    marker = re.search(r"(?:核心工作职责|工作职责|岗位职责)\s*[-—:：]?\s*", text)
    if marker:
        text = text[marker.end():]
    text = re.sub(
        r"[【\[]\s*(?:岗位名称|Base\s*地点|工作地点|岗位地点)\s*[】\]]",
        "",
        text,
        flags=re.I,
    )
    text = re.sub(r"^[\s📌•·\-—:：]+", "", text)
    return text.strip()


def _capability_summary(job: dict[str, Any], limit: int = 3) -> str:
    labels = [
        CAPABILITY_LABELS.get(_text(value.get("code")), "")
        for value in job.get("ROLE_CAPABILITIES", [])
        if isinstance(value, dict)
    ]
    labels = list(dict.fromkeys(value for value in labels if value))[:limit]
    return "、".join(labels) or "结构化分析、沟通协作与任务交付"


def _email_role_focus(points: list[Any], capabilities: str) -> str:
    """Choose a real responsibility, excluding recruitment-card instructions."""
    recruitment_meta = re.compile(
        r"(?:可私信|投递邮箱|简历图片|以下(?:是)?岗位描述|岗位描述[⬇↓]|希望.{0,12}(?:届|同学))",
        re.I,
    )
    for point in points:
        value = point.get("text") if isinstance(point, dict) else point
        cleaned = _clean_role_focus(value)
        if not cleaned or recruitment_meta.search(cleaned) or re.search(r"\d", cleaned):
            continue
        return _trim(cleaned, 42)
    return _trim(f"围绕{capabilities}完成岗位核心任务", 42)


def _email_evidence_snippet(cover_letter: str, note_id: str, limit: int = 92) -> str:
    sentences = [
        value.strip()
        for value in re.split(r"(?<=[。！？!?])|\n+", cover_letter)
        if 24 <= len(value.strip()) <= 150
    ]
    excluded = ("尊敬的", "此致", "敬礼", "谨此应聘", "感谢您审阅", "期待有机会")
    evidence_sentences = [
        value
        for value in sentences
        if not any(term in value for term in excluded)
        and any(term in value for term in ("负责", "设计", "规划", "通过", "完成", "推动", "开展", "承担"))
    ]
    candidates = evidence_sentences or [
        value for value in sentences if not any(term in value for term in excluded)
    ]
    if not candidates:
        return "我有可由项目记录核验的相关行动和交付经历"
    seed = sum(ord(character) for character in note_id)
    selected = candidates[seed % len(candidates)]
    return selected[:limit].rstrip("，；：,;: ")


def _best_role_point_for_evidence(
    points: list[Any],
    evidence: dict[str, Any],
    overlap_groups: list[str],
    role_name: str,
) -> tuple[str, str]:
    evidence_groups = _signal_groups(
        f"{_text(evidence.get('label'))} {_text(evidence.get('detail'))}"
    )
    overlap = set(overlap_groups)
    ranked: list[tuple[int, int, str, str]] = []
    for index, point in enumerate(points):
        point_text = _clean_role_focus(point.get("text") if isinstance(point, dict) else point)
        if not point_text:
            continue
        point_groups = _signal_groups(point_text)
        score = len(point_groups & evidence_groups & overlap) * 4 + len(point_groups & overlap)
        point_id = _text(point.get("id")) if isinstance(point, dict) else f"responsibility-{index + 1}"
        ranked.append((score, -index, point_text, point_id))
    ranked.sort(reverse=True)
    if ranked and ranked[0][0] > 0:
        return _trim(ranked[0][2], 90), ranked[0][3]
    return _trim(role_name, 90), "role-focus"


def _assemble_generated_item(job: dict[str, Any], cover_letter: str) -> dict[str, Any]:
    role_name = _text(job.get("TARGET_ROLE")) or "当前岗位"
    candidate_name = _text(job.get("candidate_name")) or "候选人"
    capabilities = _capability_summary(job)
    greeting = (
        f"您好，我是{candidate_name}，想应聘{role_name}。"
        f"我的经历与岗位所需的{capabilities}直接相关，相关行动和结果均有项目记录可核验，期待进一步沟通团队需求与工作安排。"
    )
    if len(greeting) > 180:
        greeting = f"您好，我是{candidate_name}，想应聘{role_name}。我有与岗位职责相关的真实项目经历，期待进一步沟通团队需求与工作安排。"
    points = job.get("JOB_RESPONSIBILITIES") or job.get("JOB_REQUIREMENTS") or []
    evidence_snippet = _email_evidence_snippet(cover_letter, _text(job.get("note_id")))
    variant = sum(ord(char) for char in _text(job.get("note_id"))) % 4
    evidence_connections = (
        f"这段经历与岗位需要的{capabilities}相关，具体行动与结果均来自简历中的项目记录。",
        f"简历中的这项项目记录呈现了我在{capabilities}方面承担的工作以及相应结果。",
        f"其中的行动和结果对应岗位关注的{capabilities}，相关内容可在简历项目经历中核验。",
        f"我承担的工作与{capabilities}直接相关，过程和结果已记录在简历项目经历中。",
    )
    next_steps = (
        "若岗位仍在招聘，期待围绕一项实际任务沟通职责重点、协作方式和交付标准，谢谢。",
        "如有进一步沟通机会，我希望结合具体工作说明自己的推进方式，也了解团队当前最看重的交付目标，谢谢。",
        "期待就岗位当前任务、协作节奏和成果标准进一步交流，谢谢。",
        "若我的经历符合岗位方向，期待了解入职后的首要任务及评价标准，谢谢。",
    )
    email_body = (
        f"您好，我是{candidate_name}，申请{role_name}。\n\n"
        f"{evidence_snippet}。{evidence_connections[variant]}\n\n"
        f"{next_steps[variant]}"
    )
    if len(email_body) > 260:
        evidence_snippet = evidence_snippet[:60].rstrip("，；：,;: ")
        email_body = (
            f"您好，我是{candidate_name}，申请{role_name}。\n\n"
            f"{evidence_snippet}。这项实践与{capabilities}相关，行动和结果可由简历项目核验。\n\n"
            f"{next_steps[variant]}"
        )
    evidence_values = [
        value for value in job.get("EVIDENCE", [])
        if isinstance(value, dict) and _text(value.get("id"))
    ]
    evidence_by_id = {_text(value.get("id")): value for value in evidence_values}
    used = list(dict.fromkeys(_text(value) for value in job.get("allowed_evidence_ids", []) if _text(value)))[:8]
    overlap_by_id = job.get("EVIDENCE_ROLE_GROUPS") if isinstance(job.get("EVIDENCE_ROLE_GROUPS"), dict) else {}
    capability_matches: list[str] = []
    responsibility_coverage: list[dict[str, str]] = []
    role_points = [*points, *(job.get("JOB_REQUIREMENTS") or [])]
    for evidence_id in used:
        evidence = evidence_by_id.get(evidence_id, {})
        overlap_groups = [
            _text(value) for value in overlap_by_id.get(evidence_id, []) if _text(value)
        ]
        point_text, responsibility_id = _best_role_point_for_evidence(
            role_points,
            evidence,
            overlap_groups,
            role_name,
        )
        group_text = "、".join(
            SIGNAL_GROUP_LABELS.get(value, value) for value in overlap_groups
        ) or capabilities
        evidence_label = _trim(evidence.get("label"), 48) or "已核验经历"
        capability_matches.append(
            f"岗位职责：{point_text}；证据 {evidence_id}（{evidence_label}）；"
            f"直接对应：{group_text}。"
        )
        responsibility_coverage.append({
            "responsibility_id": responsibility_id,
            "evidence_id": evidence_id,
        })
    return {
        "note_id": _text(job.get("note_id")),
        "greeting": greeting,
        "email_subject": f"应聘{role_name}｜{candidate_name}",
        "email_body": email_body,
        "cover_letter": _clean_generated_cover_letter(cover_letter),
        "used_evidence_ids": used,
        "capability_matches": capability_matches,
        "evidence_coverage": [{"evidence_id": evidence_id} for evidence_id in used],
        "responsibility_coverage": responsibility_coverage,
    }


def _compact_profile(profile: dict[str, Any]) -> dict[str, Any]:
    """Keep only candidate facts that can be used in the generated copy."""
    application = profile.get("candidate_application")
    values = {
        **(application if isinstance(application, dict) else {}),
        **profile,
    }
    aliases = {
        "name": ("name", "candidateName"),
        "school": ("school", "university"),
        "major": ("major", "programme", "program"),
        "degreeYear": ("degreeYear", "degree_year"),
        "availabilityDays": ("availabilityDays", "availability_days"),
        "internshipDuration": ("internshipDuration", "internship_duration"),
    }
    limits = {
        "name": 40,
        "school": 80,
        "major": 80,
        "degreeYear": 100,
        "availabilityDays": 40,
        "internshipDuration": 60,
    }
    compact: dict[str, Any] = {}
    for target, keys in aliases.items():
        value = next((_text(values.get(key)) for key in keys if _text(values.get(key))), "")
        if value:
            compact[target] = value[:limits[target]]
    return compact


def _compact_evidence(
    record: dict[str, Any],
    candidate_evidence: list[dict[str, Any]],
    contract: dict[str, Any],
    role: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Select the smallest job-relevant evidence set that still satisfies the gate."""
    allowed = {_text(value) for value in contract.get("allowed_evidence_ids", []) if _text(value)}
    resume_ids = {_text(value) for value in contract.get("resume_evidence_ids", []) if _text(value)}
    evidence_by_id = {
        _text(value.get("id")): value
        for value in candidate_evidence
        if isinstance(value, dict) and _text(value.get("id")) in allowed
    }
    fit_values = record.get("fit_evidence") if isinstance(record.get("fit_evidence"), list) else []
    fit_by_id = {
        _text(value.get("id")): value
        for value in fit_values
        if isinstance(value, dict) and _text(value.get("id")) in allowed
    }
    source_rank = {
        evidence_id: index
        for index, evidence_id in enumerate(dict.fromkeys([*fit_by_id, *evidence_by_id]))
    }
    alignment = _role_evidence_alignment(role or {}, list(evidence_by_id.values()))
    overlap_by_id = alignment.get("overlap_by_id", {})
    core_overlap_by_id = alignment.get("core_overlap_by_id", {})

    def rank_key(evidence_id: str) -> tuple[int, int, int, int, int, int, int]:
        overlap = overlap_by_id.get(evidence_id, [])
        core_overlap = core_overlap_by_id.get(evidence_id, [])
        source = evidence_by_id.get(evidence_id, {})
        detail_length = len(_text(source.get("detail") or source.get("first_person_claim")))
        return (
            -sum(SIGNAL_GROUP_WEIGHTS.get(value, 1) for value in core_overlap),
            -len(core_overlap),
            -sum(SIGNAL_GROUP_WEIGHTS.get(value, 1) for value in overlap),
            -len(overlap),
            0 if evidence_id in fit_by_id else 1,
            -min(detail_length, 500),
            source_rank.get(evidence_id, 999),
        )

    aligned_ids = [
        evidence_id for evidence_id in source_rank
        if overlap_by_id.get(evidence_id)
    ]
    unaligned_ids = [
        evidence_id for evidence_id in source_rank
        if not overlap_by_id.get(evidence_id)
    ]
    ranked_ids = [
        *sorted(aligned_ids, key=rank_key),
        *sorted(unaligned_ids, key=rank_key),
    ]
    minimum_distinct = max(0, int(contract.get("minimum_distinct_evidence") or 0))
    minimum_resume = max(0, int(contract.get("minimum_resume_evidence") or 0))
    target_count = min(len(ranked_ids), max(3, minimum_distinct, minimum_resume))
    selected_ids = ranked_ids[:target_count]
    selected_resume = sum(1 for evidence_id in selected_ids if evidence_id in resume_ids)
    if selected_resume < minimum_resume:
        for evidence_id in ranked_ids[target_count:]:
            if evidence_id not in resume_ids:
                continue
            selected_ids.append(evidence_id)
            selected_resume += 1
            if selected_resume >= minimum_resume:
                break
    if len(selected_ids) < minimum_distinct or selected_resume < minimum_resume:
        raise ValueError("candidate evidence cannot satisfy the formal quality contract")

    compact: list[dict[str, Any]] = []
    for evidence_id in selected_ids:
        source = evidence_by_id.get(evidence_id, {})
        fit = fit_by_id.get(evidence_id, {})
        compact.append({
            "id": evidence_id,
            "label": _trim(fit.get("label") or source.get("label"), 70),
            "detail": _trim(fit.get("detail") or source.get("detail") or source.get("first_person_claim"), 180),
            "is_resume_evidence": evidence_id in resume_ids,
        })
    return compact


def _compact_points(values: Any, limit: int, text_limit: int) -> list[dict[str, str]]:
    if not isinstance(values, list):
        return []
    points: list[dict[str, str]] = []
    for index, value in enumerate(values[:limit], start=1):
        if isinstance(value, dict):
            point_id = _text(value.get("id")) or f"point-{index}"
            text = _trim(value.get("text") or value.get("value") or value.get("label"), text_limit)
        else:
            point_id = f"point-{index}"
            text = _trim(value, text_limit)
        if text:
            points.append({"id": point_id, "text": text})
    return points


def _load_prompt(path_value: str = "") -> str:
    path = Path(path_value) if _text(path_value) else DEFAULT_ASCII_PROMPT
    if not path.exists():
        path = DEFAULT_ASCII_PROMPT
    return path.read_text(encoding="utf-8").strip()


def _outreach(record: dict[str, Any]) -> dict[str, Any]:
    value = record.get("outreach")
    return value if isinstance(value, dict) else {}


def _build_job(entry: dict[str, Any], candidate_profile: dict[str, Any], instructions: str) -> dict[str, Any]:
    record = entry.get("record") if isinstance(entry.get("record"), dict) else entry
    outreach = _outreach(record)
    application_context = _normalize_application_context(outreach.get("applicationContext"))
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
        application_context,
    )
    candidate_evidence = payload["candidate"].get("evidence", [])
    contract = payload.get("quality_contract") if isinstance(payload.get("quality_contract"), dict) else {}
    selected_evidence = _compact_evidence(record, candidate_evidence, contract, payload.get("role"))
    selected_ids = [value["id"] for value in selected_evidence]
    resume_ids = [value["id"] for value in selected_evidence if value["is_resume_evidence"]]
    required_responsibility_ids = [
        _text(value) for value in contract.get("required_responsibility_ids", []) if _text(value)
    ]
    responsibility_limit = max(4, len(required_responsibility_ids))
    compact_candidate = _compact_profile(candidate_profile)
    role_name = _trim(payload["role"].get("role_name", "当前岗位"), 80)
    responsibilities = _compact_points(
        payload["role"].get("responsibilities", []), responsibility_limit, 90,
    )
    requirements = _compact_points(payload["role"].get("requirements", []), 4, 80)
    role_source = " ".join([
        role_name,
        *[value["text"] for value in responsibilities],
        *[value["text"] for value in requirements],
    ])
    evidence_alignment = _role_evidence_alignment(payload.get("role", {}), selected_evidence)
    source_record = dict(record)
    source_record["applicationContext"] = application_context
    return {
        "note_id": _text(entry.get("note_id") or record.get("note_id")),
        "TARGET_ROLE": role_name,
        "candidate_name": _text(compact_candidate.get("name") or payload["candidate"].get("application_profile", {}).get("name")),
        "role": {
            "role_name": role_name,
            "source_post_title": _trim(payload["role"].get("source_post_title", ""), 80),
        },
        "JOB_RESPONSIBILITIES": responsibilities,
        "JOB_REQUIREMENTS": requirements,
        "EVIDENCE": selected_evidence,
        "EVIDENCE_ROLE_GROUPS": evidence_alignment.get("overlap_by_id", {}),
        "ROLE_CAPABILITIES": _capabilities_for_text(role_source, 6),
        "PROMPT_RESPONSIBILITIES": _ascii_points(responsibilities, "responsibility"),
        "PROMPT_REQUIREMENTS": _ascii_points(requirements, "requirement"),
        "PROMPT_EVIDENCE": _ascii_evidence(selected_evidence),
        "allowed_evidence_ids": selected_ids,
        "minimum_distinct_evidence": contract.get("minimum_distinct_evidence", 0),
        "minimum_resume_evidence": contract.get("minimum_resume_evidence", 0),
        "resume_evidence_ids": resume_ids,
        "required_responsibility_ids": required_responsibility_ids,
        "source_hash": _application_copy_source_hash(source_record, candidate_profile, candidate_evidence),
    }


def _schema(count: int) -> dict[str, Any]:
    item = {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "note_id",
            "greeting",
            "email_subject",
            "email_body",
            "cover_letter",
            "used_evidence_ids",
            "capability_matches",
            "evidence_coverage",
            "responsibility_coverage",
        ],
        "properties": {
            "note_id": {"type": "string", "minLength": 1},
            "greeting": {"type": "string", "minLength": 30, "maxLength": 180},
            "email_subject": {"type": "string", "minLength": 8, "maxLength": 120},
            "email_body": {"type": "string", "minLength": 120, "maxLength": 260},
            "cover_letter": {"type": "string", "minLength": 800, "maxLength": 1600},
            "used_evidence_ids": {"type": "array", "items": {"type": "string"}},
            "capability_matches": {"type": "array", "items": {"type": "string"}},
            "evidence_coverage": {"type": "array", "items": {"type": "object"}},
            "responsibility_coverage": {"type": "array", "items": {"type": "object"}},
        },
    }
    return {"type": "object", "additionalProperties": False, "required": ["items"], "properties": {"items": {"type": "array", "minItems": count, "maxItems": count, "items": item}}}


def _normalize_result(
    item: dict[str, Any],
    jobs_by_id: dict[str, dict[str, Any]],
    rejected: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    note_id = _text(item.get("note_id") or item.get("noteId"))
    job = jobs_by_id.get(note_id)
    if not note_id or not job:
        return None
    role_name = _text(job.get("role", {}).get("role_name")) or "当前岗位"
    candidate_name = _text(job.get("candidate_name")) or "候选人"

    def restore_local_markers(value: Any) -> str:
        restored = (
            _text(value)
            .replace("TARGET_ROLE", role_name)
            .replace("CANDIDATE_NAME", candidate_name)
        )
        return _humanize_generated_text(restored, role_name)

    greeting = restore_local_markers(item.get("greeting"))
    subject = restore_local_markers(item.get("email_subject") or item.get("subject"))
    email_body = _ensure_email_communication_next_step(
        restore_local_markers(item.get("email_body"))
    )
    body = restore_local_markers(item.get("cover_letter") or item.get("body"))
    payload_for_job = {"role": job.get("role", {}), "candidate": {"application_profile": {}}}
    embedded_subject, body = _split_cover_letter_subject(body, payload_for_job)
    if not subject:
        subject = embedded_subject
    subject = _bounded_cover_letter_subject(f"应聘{role_name}｜{candidate_name}", payload_for_job, {"positioning": "个人经历与岗位匹配"})
    used = item.get("used_evidence_ids") if isinstance(item.get("used_evidence_ids"), list) else []
    allowed = set(job.get("allowed_evidence_ids", []))
    used = [_text(value) for value in used if _text(value) in allowed]
    used = list(dict.fromkeys(used))[:8]
    minimum_distinct = max(0, int(job.get("minimum_distinct_evidence") or 0))
    minimum_resume = max(0, int(job.get("minimum_resume_evidence") or 0))
    resume_evidence_ids = set(job.get("resume_evidence_ids", []))
    capability_matches = [
        restore_local_markers(value)
        for value in item.get("capability_matches", [])
        if _text(value)
    ] if isinstance(item.get("capability_matches"), list) else []
    capability_matches = list(dict.fromkeys(capability_matches))[:12]
    role_has_points = bool(job.get("JOB_RESPONSIBILITIES") or job.get("JOB_REQUIREMENTS"))
    chars = cover_letter_char_count(body)
    email_paragraphs = [part.strip() for part in email_body.replace("\r\n", "\n").split("\n\n") if part.strip()]
    problems: list[str] = []
    if len(used) < minimum_distinct:
        problems.append(f"used_evidence_ids 至少需要 {minimum_distinct} 条有效证据，当前 {len(used)} 条")
    if len(set(used) & resume_evidence_ids) < minimum_resume:
        problems.append(f"used_evidence_ids 至少需要 {minimum_resume} 条简历证据")
    if not greeting.startswith("您好，我是"):
        problems.append("greeting 必须以“您好，我是”开场")
    if "我" not in greeting:
        problems.append("greeting 必须使用第一人称")
    if not 30 <= len(greeting) <= 180:
        problems.append(f"greeting 当前 {len(greeting)} 字，必须为 30-180 字")
    if "我" not in email_body:
        problems.append("email_body 必须使用第一人称")
    if not 120 <= len(email_body) <= 260:
        problems.append(f"email_body 当前 {len(email_body)} 字，必须为 120-260 字")
    if len(email_paragraphs) > 4:
        problems.append(f"email_body 当前 {len(email_paragraphs)} 段，最多四段")
    if not 800 <= chars <= 1600:
        problems.append(f"cover_letter 当前 {chars} 个非空白字符，必须为 800-1600 个")
    if not body.startswith("尊敬的招聘负责人"):
        problems.append("cover_letter 必须以“尊敬的招聘负责人”开场")
    if "我" not in body:
        problems.append("cover_letter 必须使用第一人称")
    if "此致" not in body or "敬礼" not in body:
        problems.append("cover_letter 必须包含“此致”和“敬礼”")
    if candidate_name not in body:
        problems.append(f"cover_letter 必须包含候选人姓名：{candidate_name}")
    if role_name not in subject and role_name not in greeting:
        problems.append(f"email_subject 或 greeting 必须准确点名岗位：{role_name}")
    if role_has_points and not capability_matches:
        problems.append("岗位有职责或要求时 capability_matches 不得为空")
    if any(not any(evidence_id in match for evidence_id in used) for match in capability_matches):
        problems.append("每条 capability_matches 都必须绑定 used_evidence_ids 中的证据 ID")
    if problems:
        if rejected is not None:
            rejected.append({"note_id": note_id, "problems": problems})
        return None
    return {
        "note_id": note_id,
        "greeting": greeting,
        "email_subject": subject,
        "email_body": email_body,
        "cover_letter": body,
        "used_evidence_ids": used,
        "capability_matches": capability_matches,
        "source_hash": _text(job.get("source_hash")),
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
        instructions = ASCII_BATCH_INSTRUCTIONS
        jobs = [_build_job(entry, candidate_profile, instructions) for entry in entries if isinstance(entry, dict)]
        if len(jobs) != len(entries) or any(not job["note_id"] for job in jobs):
            raise ValueError("every batch item must include a note_id")
        first_record = entries[0].get("record") if isinstance(entries[0], dict) and isinstance(entries[0].get("record"), dict) else entries[0]
        first_outreach = _outreach(first_record if isinstance(first_record, dict) else {})
        first_payload = build_cover_letter_rewrite_input(
            first_record if isinstance(first_record, dict) else {}, first_outreach, instructions,
            candidate_profile, first_outreach.get("applicationContext") if isinstance(first_outreach.get("applicationContext"), dict) else {},
        )
        merged_profile = {
            **(first_payload["candidate"].get("application_profile", {}) or {}),
            **candidate_profile,
        }
        shared_candidate = {
            "application_profile": _compact_profile_ascii(merged_profile),
            "profile_snapshot_id": _ascii_identifier(
                first_payload["candidate"].get("profile_snapshot_id", ""),
                "current-profile",
            ),
        }
        provider = AIProvider(
            provider=os.environ.get("XHS_AI_PROVIDER", "relay"), api_key=os.environ.get("XHS_AI_API_KEY", ""),
            base_url=os.environ.get("XHS_AI_BASE_URL", ""), model=os.environ.get("XHS_AI_MODEL", "gpt-5.6-sol"),
            wire_api=os.environ.get("XHS_AI_WIRE_API", "chat_completions"), timeout=int(os.environ.get("XHS_AI_TIMEOUT_SECONDS", "1800")),
            max_output_tokens=int(os.environ.get("XHS_AI_MAX_OUTPUT_TOKENS", "131072")),
        )
        jobs_by_id = {job["note_id"]: job for job in jobs}
        rejected: list[dict[str, Any]] = []
        generated: list[dict[str, Any]] = []
        for job in jobs:
            system_prompt, user_prompt = _plain_cover_letter_request(job, shared_candidate)
            cover_letter = provider.generate_text(system_prompt, user_prompt)
            generated.append(_assemble_generated_item(job, cover_letter))
        normalized = [_normalize_result(item, jobs_by_id, rejected) for item in generated]
        normalized = [item for item in normalized if item]
        print(json.dumps({"items": normalized, "rejected": rejected, "requested": len(jobs), "generated": len(normalized), "provider": provider.provider, "model": provider.last_request_model or provider.model, "wire_api": provider.wire_api, "profile_snapshot_id": shared_candidate.get("profile_snapshot_id", "")}, ensure_ascii=False))
        return 0 if len(normalized) == len(jobs) else 2
    except Exception as error:  # noqa: BLE001 - caller records the batch failure.
        print(json.dumps({"error": str(error)[:1200]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
