from __future__ import annotations

import hashlib
import json
import re
from typing import Any


SCHEMA_VERSION = 1
VALIDATOR_NAME = "deterministic-evidence-span-v1"
OUTREACH_TEXT_FIELDS = ("greeting", "email_subject", "email_body", "cover_letter")

SUBJECTIVE_PATTERN = re.compile(
    r"(?:精通|擅长|经验丰富|丰富经验|行业领先|顶尖|卓越|资深|专家级|熟练掌握)"
    r"[^，。；;！？!?\n]{0,28}",
    re.I,
)
TECHNOLOGY_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])(?:Python|SQL|Excel|Power\s*BI|Tableau|R语言|JavaScript|TypeScript|"
    r"React|Vue|Node(?:\.js)?|Git|Docker|Kubernetes|AWS|Azure|GCP)(?![A-Za-z0-9])",
    re.I,
)
PRODUCT_CONTEXT_PATTERN = re.compile(
    r"(?:使用|运用|基于)\s*([A-Za-z][A-Za-z0-9.+#/-]{1,24})",
    re.I,
)
CONTEXT_ENTITY_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("person", re.compile(r"(?:我是|姓名[：:])([^，。；;！？!?\n]{2,24})")),
    ("school", re.compile(r"(?:就读于|毕业于)([^，。；;！？!?\n]{2,36}?(?:大学|学院|学校))")),
    ("company", re.compile(r"(?:任职于|就职于|加入)([^，。；;！？!?\n]{2,36}?(?:公司|集团|科技|咨询|银行|实验室|团队))")),
    ("company", re.compile(r"(?:曾在|在)([^，。；;！？!?\n]{2,36}?(?:公司|集团|银行|实验室))(?:工作|任职|实习|期间|负责|参与|[，。])")),
    ("job", re.compile(r"(?:应聘|申请|担任)([^，。；;！？!?\n]{2,36}?(?:实习生|分析师|工程师|顾问|经理|岗位|实习))")),
    ("project", re.compile(r"(?:参与|负责|推进|完成)([^，。；;！？!?\n]{2,36}?(?:项目|计划))")),
)

# Generic work descriptions are not project names. Treating them as named
# projects makes a factual-claim checker reject otherwise grounded copy.
GENERIC_PROJECT_DESCRIPTORS = frozenset({
    "\u76f8\u5173", "\u8be5", "\u8fd9\u4e2a", "\u4e00\u4e2a", "\u591a\u4e2a", "\u5177\u4f53", "\u5b9e\u9645",
    "\u5b8c\u6574", "\u6e05\u6670", "\u6709\u5e8f", "\u590d\u6742", "\u8de8\u90e8\u95e8", "\u5168\u6d41\u7a0b", "\u4e0d\u540c",
    "\u82e5\u5e72", "\u4e00\u9879", "\u5404\u7c7b", "\u9879\u76ee\u7ba1\u7406",
})


NUMERIC_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("money", re.compile(
        r"(?<![\d.])(?:人民币|RMB|CNY|USD|¥|￥|\$)?\s*"
        r"\d+(?:,\d{3})*(?:\.\d+)?\s*(?:亿元|万元|元|美元|美金|USD|CNY)(?![\d.])",
        re.I,
    )),
    ("percentage", re.compile(r"(?<![\d.])\d+(?:\.\d+)?\s*[%％](?![\d.])")),
    ("date", re.compile(
        r"(?<!\d)(?:\d{4}年\d{1,2}月(?:\d{1,2}日)?|\d{1,2}月\d{1,2}日|"
        r"\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?)(?!\d)"
    )),
    ("duration", re.compile(
        r"(?<![\d.])\d+(?:\.\d+)?\s*(?:年|个月|周|天|小时|分钟|"
        r"years?|months?|weeks?|days?|hours?|minutes?)(?![A-Za-z0-9_.])",
        re.I,
    )),
    ("decimal", re.compile(r"(?<![\d.])\d+\.\d+(?![\d.])")),
    ("integer", re.compile(r"(?<![\d.])\d+(?![\d.])")),
)
QUANTIFIED_PATTERN = re.compile(
    r"(?:提升|增长|降低|减少|达到|完成|覆盖|服务|负责|推动|节省|缩短|实现)"
    r"[^，。；;！？!?\n]{0,12}?\d+(?:,\d{3})*(?:\.\d+)?\s*"
    r"(?:[%％]|亿元|万元|元|个|次|名|人|家)",
    re.I,
)


def _hash_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _text_values(value: Any) -> list[str]:
    if isinstance(value, dict):
        result: list[str] = []
        for key in sorted(value):
            result.extend(_text_values(value[key]))
        return result
    if isinstance(value, list):
        result = []
        for item in value:
            result.extend(_text_values(item))
        return result
    if value is None or isinstance(value, bool):
        return []
    text = str(value).strip()
    return [text] if text else []


def _source_content(value: Any) -> str:
    return "\n".join(dict.fromkeys(_text_values(value)))


def _meaningful_profile_item(item: dict[str, Any]) -> dict[str, Any]:
    fields = (
        "label",
        "detail",
        "description",
        "text",
        "title",
        "name",
        "role",
        "organization",
        "company",
        "project",
        "school",
        "major",
        "degreeYear",
        "actions",
        "results",
        "achievements",
        "skills",
        "summary",
    )
    return {key: item[key] for key in fields if item.get(key) not in (None, "", [], {})}


def _source(
    evidence_id: str,
    value: Any,
    source_type: str,
    version: Any = "",
) -> dict[str, str] | None:
    content = _source_content(value)
    if not content:
        return None
    source_hash = _hash_text(content)
    return {
        "evidenceId": evidence_id,
        "sourceType": source_type,
        "content": content,
        "sourceVersion": str(version or f"sha256:{source_hash[:16]}"),
        "sourceHash": source_hash,
    }


def build_evidence_sources(
    record: dict[str, Any],
    profile: dict[str, Any] | None = None,
    candidate_profile: dict[str, Any] | None = None,
) -> list[dict[str, str]]:
    """Build immutable source documents without replacing legacy evidence IDs."""
    note_id = str(record.get("note_id") or record.get("id") or "record")
    record_version = record.get("source_version") or record.get("sourceVersion") or ""
    media = record.get("media") if isinstance(record.get("media"), dict) else {}
    media_analysis = media.get("analysis") if isinstance(media.get("analysis"), dict) else {}
    verified_media = {
        key: media_analysis.get(key)
        for key in ("visible_text", "summary", "job_signals", "application_routes")
        if media_analysis.get(key)
    }
    candidates: list[dict[str, str] | None] = [
        _source(f"record:{note_id}:title", record.get("title"), "record_title", record_version),
        _source(f"record:{note_id}:body", record.get("body"), "record_body", record_version),
        _source(
            f"record:{note_id}:source-card",
            record.get("source_card_text"),
            "source_card_text",
            record_version,
        ),
        _source(f"record:{note_id}:media", verified_media, "verified_media", record_version),
    ]

    resolved_profile = profile if isinstance(profile, dict) else {}
    resolved_candidate = candidate_profile if isinstance(candidate_profile, dict) else {}
    if not resolved_candidate:
        for key in ("candidate_application", "candidateProfile"):
            value = resolved_profile.get(key)
            if isinstance(value, dict):
                resolved_candidate = value
                break
    candidate_evidence = {
        key: resolved_candidate[key]
        for key in (
            "name",
            "school",
            "major",
            "degreeYear",
            "phoneWeChat",
            "email",
            "availabilityDays",
            "internshipDuration",
        )
        if resolved_candidate.get(key) not in (None, "")
    }
    candidate_phrases: list[str] = []
    availability = str(resolved_candidate.get("availabilityDays") or "").strip()
    if availability:
        candidate_phrases.append(f"每周可实习{availability}天")
    internship_duration = str(resolved_candidate.get("internshipDuration") or "").strip()
    if internship_duration:
        candidate_phrases.append(f"预计可连续实习{internship_duration}")
    if candidate_phrases:
        candidate_evidence["evidencePhrases"] = candidate_phrases
    candidates.append(_source("candidate-profile", candidate_evidence, "candidate_profile"))

    education = resolved_profile.get("education")
    education_items = education if isinstance(education, list) else ([education] if education is not None else [])
    for index, item in enumerate(education_items, start=1):
        value = _meaningful_profile_item(item) if isinstance(item, dict) else item
        candidates.append(_source(f"education-{index}", value, "candidate_education"))
    for section in (
        "evidence",
        "evidence_items",
        "experience",
        "experiences",
        "projects",
        "github_projects",
        "skills",
    ):
        value = resolved_profile.get(section)
        items = value if isinstance(value, list) else ([value] if value is not None else [])
        for index, item in enumerate(items, start=1):
            if not isinstance(item, dict):
                candidates.append(_source(f"{section}-{index}", item, f"candidate_{section}"))
                continue
            evidence_id = str(item.get("id") or f"{section}-{index}")
            candidates.append(_source(
                evidence_id,
                _meaningful_profile_item(item),
                f"candidate_{section}",
                item.get("sourceVersion") or item.get("version") or "",
            ))

    fit_evidence = record.get("fit_evidence")
    if isinstance(fit_evidence, list):
        for index, item in enumerate(fit_evidence, start=1):
            if not isinstance(item, dict):
                continue
            evidence_id = str(item.get("id") or f"fit-evidence-{index}")
            candidates.append(_source(
                evidence_id,
                _meaningful_profile_item(item),
                "fit_evidence",
                item.get("sourceVersion") or item.get("version") or "",
            ))

    merged: dict[str, dict[str, str]] = {}
    for item in candidates:
        if item is None:
            continue
        evidence_id = item["evidenceId"]
        previous = merged.get(evidence_id)
        if previous is None:
            merged[evidence_id] = item
            continue
        combined = "\n".join(dict.fromkeys((previous["content"], item["content"])))
        combined_hash = _hash_text(combined)
        previous.update({
            "content": combined,
            "sourceVersion": f"sha256:{combined_hash[:16]}",
            "sourceHash": combined_hash,
        })
    return list(merged.values())


def _source_set_hash(sources: list[dict[str, str]]) -> str:
    canonical = json.dumps(
        [
            {
                "evidenceId": item["evidenceId"],
                "sourceVersion": item["sourceVersion"],
                "sourceHash": item["sourceHash"],
            }
            for item in sorted(sources, key=lambda source: source["evidenceId"])
        ],
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return _hash_text(canonical)


def _entity_lexicon(
    record: dict[str, Any],
    profile: dict[str, Any],
    candidate_profile: dict[str, Any],
    sources: list[dict[str, str]],
) -> dict[str, set[str]]:
    lexicon = {
        kind: set()
        for kind in ("person", "company", "school", "job", "project", "product", "skill")
    }

    def add(kind: str, value: Any) -> None:
        text = str(value or "").strip()
        if len(text) >= 2:
            lexicon[kind].add(text)

    add("school", candidate_profile.get("school"))
    add("person", candidate_profile.get("name"))
    add("job", record.get("title"))
    job_card = record.get("job_card") if isinstance(record.get("job_card"), dict) else {}
    add("job", job_card.get("role_name"))
    education = profile.get("education")
    education_items = education if isinstance(education, list) else ([education] if education is not None else [])
    for item in education_items:
        if isinstance(item, dict):
            add("school", item.get("school") or item.get("organization"))
    profile_skills = profile.get("skills")
    skill_items = profile_skills if isinstance(profile_skills, list) else ([profile_skills] if profile_skills is not None else [])
    for skill in skill_items:
        add("skill", skill)
    for section in ("experience", "experiences", "projects", "github_projects"):
        value = profile.get(section)
        items = value if isinstance(value, list) else ([value] if value is not None else [])
        for item in items:
            if not isinstance(item, dict):
                continue
            add("company", item.get("organization") or item.get("company"))
            add("project" if section in {"projects", "github_projects"} else "job", item.get("title"))
            skills = item.get("skills")
            skill_values = skills if isinstance(skills, list) else ([skills] if skills is not None else [])
            for skill in skill_values:
                add("skill", skill)
    for item in record.get("fit_evidence", []):
        if not isinstance(item, dict):
            continue
        evidence_label = item.get("label") or item.get("title") or item.get("name")
        if re.search(r"(?:项目|计划)$", str(evidence_label or "").strip()):
            add("project", evidence_label)
        skills = item.get("skills")
        skill_values = skills if isinstance(skills, list) else ([skills] if skills is not None else [])
        for skill in skill_values:
            add("skill", skill)
    source_text = "\n".join(item["content"] for item in sources)
    for match in TECHNOLOGY_PATTERN.finditer(source_text):
        add("product", match.group(0))
        add("skill", match.group(0))
    return lexicon


def _overlaps(span: tuple[int, int], occupied: list[tuple[int, int]]) -> bool:
    return any(span[0] < end and start < span[1] for start, end in occupied)


def _is_generic_project_reference(value: str) -> bool:
    normalized = str(value or "").strip()
    if not normalized.endswith(("\u9879\u76ee", "\u8ba1\u5212")):
        return False
    descriptor_text = normalized[:-2].rstrip("\u7684").strip()
    if not descriptor_text:
        return True
    descriptors = [
        item.strip()
        for item in re.split(r"[\s\u3001\uff0c,/\u548c\u4e0e\u53ca\u7684]+", descriptor_text)
        if item.strip()
    ]
    return bool(descriptors) and all(item in GENERIC_PROJECT_DESCRIPTORS for item in descriptors)


def _is_verified_target_role_reference(
    raw_claim: dict[str, Any],
    draft: dict[str, Any],
    record: dict[str, Any],
) -> bool:
    """Allow a verified job-posting target in application-intent wording only."""
    if raw_claim.get("claimType") != "job":
        return False
    disposition = record.get("qualitySourceDisposition")
    if not isinstance(disposition, dict) or disposition.get("status") != "sendable":
        return False
    target_role = str(disposition.get("roleName") or "").strip()
    claim_text = str(raw_claim.get("text") or "").strip()
    normalized_target = re.sub(r"\s*[/\uff0f]\s*", "/", target_role)
    normalized_claim = re.sub(r"\s*[/\uff0f]\s*", "/", claim_text)
    if not target_role or not claim_text or normalized_claim != normalized_target:
        return False
    field = str(raw_claim.get("field") or "")
    text = str(draft.get(field) or "")
    start = raw_claim.get("outputStart")
    if field not in OUTREACH_TEXT_FIELDS or not isinstance(start, int) or start < 0:
        return False
    prefix = text[max(0, start - 32):start]
    return bool(re.search(r"(?:\u7533\u8bf7|\u5e94\u8058|\u6295\u9012|\u7ade\u8058|\u62a5\u7533)\s*$", prefix))


def _extract_claims(
    draft: dict[str, Any],
    lexicon: dict[str, set[str]],
    sources: list[dict[str, str]] | None = None,
) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    seen: set[tuple[str, str, int]] = set()
    for field in OUTREACH_TEXT_FIELDS:
        text = str(draft.get(field) or "")
        occupied: list[tuple[int, int]] = []

        def append(kind: str, value: str, start: int, review: bool = False) -> None:
            normalized = value.strip()
            if not normalized:
                return
            adjusted = start + value.find(normalized)
            key = (field, kind, adjusted)
            if key in seen:
                return
            seen.add(key)
            claims.append({
                "field": field,
                "text": normalized,
                "claimType": kind,
                "outputStart": adjusted,
                "outputEnd": adjusted + len(normalized),
                "requiresHumanReview": review,
            })

        for match in SUBJECTIVE_PATTERN.finditer(text):
            append("other_hard_fact", match.group(0), match.start(), review=True)

        for match in QUANTIFIED_PATTERN.finditer(text):
            # Individual numbers are validated below. Keep this richer claim only
            # when its complete wording is present in the evidence, otherwise a
            # harmless action-verb paraphrase would fail a second, stricter check.
            if _find_evidence(match.group(0).strip(), sources or []) is not None:
                append("quantified_achievement", match.group(0), match.start())

        for kind, pattern in NUMERIC_PATTERNS:
            for match in pattern.finditer(text):
                span = match.span()
                if _overlaps(span, occupied):
                    continue
                occupied.append(span)
                append(kind, match.group(0), match.start())

        for kind, values in lexicon.items():
            for value in sorted(values, key=len, reverse=True):
                for match in re.finditer(re.escape(value), text, re.I if value.isascii() else 0):
                    append(kind, match.group(0), match.start())

        for match in TECHNOLOGY_PATTERN.finditer(text):
            append("product", match.group(0), match.start())
            append("skill", match.group(0), match.start())

        for match in PRODUCT_CONTEXT_PATTERN.finditer(text):
            append("product", match.group(1), match.start(1))

        for kind, pattern in CONTEXT_ENTITY_PATTERNS:
            for match in pattern.finditer(text):
                raw = match.group(1)
                cleaned = raw.strip(" \t\r\n\"'“”‘’「」『』【】（）()[]<>《》：:，,。.;；!?！？")
                if kind == "project":
                    cleaned = re.sub(r"^(?:了|过)(?=.{2,})", "", cleaned)
                if not cleaned:
                    continue
                if kind == "project" and _is_generic_project_reference(cleaned):
                    continue
                known_entities = [
                    value
                    for value in sorted(lexicon.get(kind, set()), key=len, reverse=True)
                    if value in cleaned
                ]
                if known_entities:
                    for value in known_entities:
                        append(kind, value, match.start(1) + raw.find(value))
                else:
                    append(kind, cleaned, match.start(1) + raw.find(cleaned))
    return claims


def _find_evidence(text: str, sources: list[dict[str, str]]) -> tuple[dict[str, str], int] | None:
    for source in sources:
        start = source["content"].find(text)
        if start >= 0:
            return source, start
    return None


def validate_claim_binding(
    claim: dict[str, Any],
    sources: list[dict[str, str]],
) -> tuple[bool, str]:
    source = next(
        (item for item in sources if item["evidenceId"] == claim.get("evidenceId")),
        None,
    )
    if source is None:
        return False, "Evidence ID does not resolve to a current source."
    if claim.get("sourceVersion") != source["sourceVersion"]:
        return False, "Claim source version does not match the current evidence source."
    if claim.get("sourceHash") != source["sourceHash"]:
        return False, "Claim source hash does not match the current evidence source."
    span = claim.get("evidenceSpan")
    if not isinstance(span, str) or not span:
        return False, "Evidence span is missing."
    start = claim.get("evidenceStart")
    end = claim.get("evidenceEnd")
    if (
        isinstance(start, bool)
        or isinstance(end, bool)
        or not isinstance(start, int)
        or not isinstance(end, int)
        or start < 0
        or end <= start
        or end > len(source["content"])
    ):
        return False, "Evidence offsets are invalid."
    if source["content"][start:end] != span:
        return False, "Evidence offsets do not select the declared span."
    if span != claim.get("text"):
        return False, "Evidence span does not exactly support the claim text."
    return True, "Exact text and offsets verified against the current evidence source."


def validate_generated_claims(
    record: dict[str, Any],
    profile: dict[str, Any] | None = None,
    candidate_profile: dict[str, Any] | None = None,
    draft: dict[str, Any] | None = None,
) -> dict[str, Any]:
    resolved_profile = profile if isinstance(profile, dict) else {}
    resolved_candidate = candidate_profile if isinstance(candidate_profile, dict) else {}
    sources = build_evidence_sources(record, resolved_profile, resolved_candidate)
    source_set_hash = _source_set_hash(sources)
    lexicon = _entity_lexicon(record, resolved_profile, resolved_candidate, sources)
    raw_claims = _extract_claims(draft or record.get("outreach") or {}, lexicon, sources)
    claims: list[dict[str, Any]] = []
    failed = review = 0
    for raw in raw_claims:
        if _is_verified_target_role_reference(raw, draft or record.get("outreach") or {}, record):
            continue
        claim_seed = f"{raw['field']}:{raw['claimType']}:{raw['outputStart']}:{raw['text']}"
        match = _find_evidence(raw["text"], sources)
        if raw["requiresHumanReview"]:
            status = "needsHumanReview"
            reason = "Subjective proficiency or superiority wording requires human verification."
            review += 1
        elif match is None:
            status = "failed"
            reason = "Exact claim text does not exist in any current evidence source."
            failed += 1
        else:
            status = "valid"
            reason = "Exact text and offsets verified against the current evidence source."
        source, start = match if match is not None else ({}, -1)
        evidence_span = source.get("content", "")[start:start + len(raw["text"])] if start >= 0 else ""
        claims.append({
            "claimId": f"claim-{_hash_text(claim_seed)[:16]}",
            "text": raw["text"],
            "claimType": raw["claimType"],
            "evidenceId": source.get("evidenceId", ""),
            "evidenceSpan": evidence_span,
            "evidenceStart": start,
            "evidenceEnd": start + len(evidence_span) if start >= 0 else -1,
            "sourceVersion": source.get("sourceVersion", ""),
            "sourceHash": source.get("sourceHash", ""),
            "validationStatus": status,
            "validationReason": reason,
            "outputField": raw["field"],
            "outputStart": raw["outputStart"],
            "outputEnd": raw["outputEnd"],
        })
    status = "failed" if failed else "needsHumanReview" if review else "passed"
    return {
        "schemaVersion": SCHEMA_VERSION,
        "validator": VALIDATOR_NAME,
        "sourceSetHash": source_set_hash,
        "status": status,
        "hardFactsPassed": status == "passed",
        "sendable": status == "passed",
        "counts": {
            "total": len(claims),
            "valid": len(claims) - failed - review,
            "failed": failed,
            "needsHumanReview": review,
        },
        "sourceBindings": [
            {
                "evidenceId": item["evidenceId"],
                "sourceVersion": item["sourceVersion"],
                "sourceHash": item["sourceHash"],
            }
            for item in sources
        ],
        "claims": claims,
        "legacyEvidenceIdsPreserved": True,
    }


def claim_validation_is_current(
    validation: dict[str, Any],
    record: dict[str, Any],
    profile: dict[str, Any] | None = None,
    candidate_profile: dict[str, Any] | None = None,
) -> bool:
    if not isinstance(validation, dict) or validation.get("schemaVersion") != SCHEMA_VERSION:
        return False
    sources = build_evidence_sources(record, profile, candidate_profile)
    if validation.get("sourceSetHash") != _source_set_hash(sources):
        return False
    claims = validation.get("claims")
    if not isinstance(claims, list):
        return False
    return all(
        isinstance(claim, dict)
        and (
            claim.get("validationStatus") != "valid"
            or validate_claim_binding(claim, sources)[0]
        )
        for claim in claims
    )
