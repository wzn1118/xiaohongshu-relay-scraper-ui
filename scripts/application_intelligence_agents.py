from __future__ import annotations

import csv
import json
import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from codex_runtime_outreach import PROMPT_VERSION


SHANGHAI = timezone(timedelta(hours=8), name="Asia/Shanghai")
TIME_FIELDS = ("publish_time", "card_publish_time", "card_text_segments", "source_card_text", "card_author")
TEXT_FIELDS = ("body", "title", "source_card_text", "card_text_segments")
ILLEGAL_SHEET_CHARACTERS = re.compile(r"[\x00-\x08\x0B-\x0C\x0E-\x1F]")


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _sheet_safe(value: Any) -> Any:
    if isinstance(value, str):
        value = ILLEGAL_SHEET_CHARACTERS.sub("", value)
        if value.startswith(("=", "+", "-", "@")):
            return "'" + value
    return value


def _aware_datetime(value: Any, fallback: datetime) -> tuple[datetime, str]:
    raw = _text(value)
    if not raw:
        return fallback, "pipeline_fallback"
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=SHANGHAI)
        return parsed.astimezone(SHANGHAI), "scraped_at"
    except ValueError:
        return fallback, "pipeline_fallback_invalid_scraped_at"


def _iso_minute(value: datetime) -> str:
    return value.replace(second=0, microsecond=0).isoformat(timespec="minutes")


def _time_source(note: dict[str, Any]) -> tuple[str, str]:
    marker = re.compile(
        r"(?:今天|昨天|前天|\d+\s*(?:天|小时|分钟)前|"
        r"\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}|"
        r"\d{1,2}\s*[-/.月]\s*\d{1,2})"
    )
    for field in TIME_FIELDS:
        value = _text(note.get(field))
        if not value:
            continue
        if field in {"publish_time", "card_publish_time"} or marker.search(value):
            match = marker.search(value)
            if field not in {"publish_time", "card_publish_time"} and match:
                value = value[match.start() :]
            return value, field
    return "", ""


def normalize_publish_time(raw: str, collected_at: datetime, source_field: str = "publish_time") -> dict[str, Any]:
    value = re.sub(r"\s+", " ", raw.strip())
    value = re.sub(r"\s+(?:北京|上海|广东|浙江|江苏|四川|湖北|湖南|海外)$", "", value)
    result: dict[str, Any] = {
        "raw": raw,
        "value": "",
        "timezone": "Asia/Shanghai",
        "precision": "unknown",
        "method": "unparsed",
        "is_estimated": False,
        "source_field": source_field,
        "collected_at": collected_at.isoformat(timespec="seconds"),
    }
    if not value:
        result["method"] = "missing"
        return result

    relative_named = re.search(r"(?P<label>今天|昨天|前天)(?:\s+(?P<hour>\d{1,2}):(?P<minute>\d{2}))?", value)
    if relative_named:
        days = {"今天": 0, "昨天": 1, "前天": 2}[relative_named.group("label")]
        target_date = collected_at.date() - timedelta(days=days)
        if relative_named.group("hour") is not None:
            target = datetime.combine(
                target_date,
                time(int(relative_named.group("hour")), int(relative_named.group("minute"))),
                tzinfo=SHANGHAI,
            )
            result.update(
                value=_iso_minute(target),
                precision="minute",
                method="relative_named_with_clock",
                is_estimated=False,
            )
        else:
            result.update(
                value=target_date.isoformat(),
                precision="day",
                method="relative_named_date_only",
                is_estimated=False,
            )
        return result

    relative = re.search(r"(?P<count>\d+)\s*(?P<unit>天|小时|分钟)前", value)
    if relative:
        count = int(relative.group("count"))
        unit = relative.group("unit")
        if unit == "天":
            target_date = collected_at.date() - timedelta(days=count)
            result.update(
                value=target_date.isoformat(),
                precision="day",
                method="relative_days_date_only",
                is_estimated=False,
            )
            return result
        delta = {
            "小时": timedelta(hours=count),
            "分钟": timedelta(minutes=count),
        }[unit]
        target = collected_at - delta
        result.update(
            value=_iso_minute(target),
            precision={"小时": "relative_hour", "分钟": "relative_minute"}[unit],
            method=f"relative_{unit}",
            is_estimated=True,
        )
        return result

    absolute = re.search(
        r"(?:(?P<year>\d{4})\s*[-/.年]\s*)?"
        r"(?P<month>\d{1,2})\s*[-/.月]\s*(?P<day>\d{1,2})(?:日)?"
        r"(?:\s+(?P<hour>\d{1,2}):(?P<minute>\d{2}))?",
        value,
    )
    if absolute:
        year = int(absolute.group("year") or collected_at.year)
        try:
            target_date = date(year, int(absolute.group("month")), int(absolute.group("day")))
        except ValueError:
            result["method"] = "invalid_absolute_date"
            return result
        if absolute.group("year") is None and target_date > collected_at.date():
            target_date = date(year - 1, target_date.month, target_date.day)
        if absolute.group("hour") is None:
            result.update(
                value=target_date.isoformat(),
                precision="day",
                method="absolute_date",
                is_estimated=False,
            )
            return result
        target = datetime.combine(
            target_date,
            time(int(absolute.group("hour")), int(absolute.group("minute"))),
            tzinfo=SHANGHAI,
        )
        result.update(
            value=_iso_minute(target),
            precision="minute",
            method="absolute_datetime",
            is_estimated=False,
        )
        return result

    return result


def _evidence_excerpt(text: str, start: int, end: int, radius: int = 45) -> str:
    return text[max(0, start - radius) : min(len(text), end + radius)].strip()


def _provenance_item(kind: str, value: str, field: str, text: str, start: int, end: int) -> dict[str, Any]:
    return {
        "type": kind,
        "value": value,
        "source_field": field,
        "evidence": _evidence_excerpt(text, start, end),
        "offset_start": start,
        "offset_end": end,
    }


class ApplicationInfoAgent:
    EMAIL_RE = re.compile(r"(?<![\w.+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![\w.-])", re.I)
    WECHAT_RE = re.compile(r"(?:微信|vx|v信|wechat)\s*(?:号|ID)?\s*[:：]?\s*([A-Za-z][A-Za-z0-9_-]{5,19})", re.I)
    PHONE_RE = re.compile(r"(?:电话|手机|联系)\s*[:：]?\s*(1[3-9]\d{9})(?!\d)")
    URL_RE = re.compile(r"https?://[^\s|，。；;]+", re.I)
    REQUIREMENT_CUES = (
        "要求",
        "适合",
        "希望",
        "需要",
        "优先",
        "熟练",
        "擅长",
        "英语",
        "每周",
        "到岗",
        "实习",
        "base",
        "经验",
        "专业",
        "学历",
        "能力",
    )
    RESPONSIBILITY_CUES = (
        "岗位职责",
        "工作职责",
        "工作内容",
        "职责",
        "负责",
        "协助",
        "参与",
        "支持",
        "跟进",
        "维护",
        "运营",
        "策划",
        "分析",
        "撰写",
        "对接",
    )

    def run(self, note: dict[str, Any]) -> dict[str, Any]:
        contacts: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        routes: list[dict[str, Any]] = []

        for field in TEXT_FIELDS:
            text = _text(note.get(field))
            if not text:
                continue
            patterns: tuple[tuple[str, re.Pattern[str], int], ...] = (
                ("email", self.EMAIL_RE, 0),
                ("wechat", self.WECHAT_RE, 1),
                ("phone", self.PHONE_RE, 1),
                ("url", self.URL_RE, 0),
            )
            for kind, pattern, group in patterns:
                for match in pattern.finditer(text):
                    found = match.group(group)
                    key = (kind, found.lower())
                    if key in seen:
                        continue
                    seen.add(key)
                    contacts.append(_provenance_item(kind, found, field, text, match.start(group), match.end(group)))
            for label, route_pattern in (
                ("xiaohongshu_dm", r"(?:私信|私我|评论区|评论留言)"),
                ("email", r"(?:邮箱|邮件|简历投递)"),
                ("official_site", r"(?:官网|招聘网站|招聘系统)"),
            ):
                match = re.search(route_pattern, text, re.I)
                if match and not any(item["type"] == label for item in routes):
                    routes.append(_provenance_item(label, label, field, text, match.start(), match.end()))

        requirements: list[dict[str, Any]] = []
        responsibilities: list[dict[str, Any]] = []
        body = _text(note.get("body"))
        for match in re.finditer(r"[^。！？；;\n]+[。！？；;]?", body):
            sentence = match.group(0).strip()
            lowered = sentence.lower()
            if len(sentence) < 4:
                continue
            item = {
                "text": sentence,
                "source_field": "body",
                "evidence": sentence,
                "offset_start": match.start(),
                "offset_end": match.end(),
            }
            is_requirement = any(cue in lowered for cue in self.REQUIREMENT_CUES)
            is_responsibility = any(cue in lowered for cue in self.RESPONSIBILITY_CUES)
            if is_requirement:
                requirements.append(item)
            if is_responsibility:
                responsibilities.append(item)

        return {
            "contacts": contacts,
            "application_routes": routes,
            "responsibilities": responsibilities,
            "requirements": requirements,
        }


def _string_values(value: Any) -> Iterable[str]:
    if isinstance(value, str) and value.strip():
        yield value.strip()
    elif isinstance(value, list):
        for item in value:
            yield from _string_values(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from _string_values(item)


def _candidate_application_profile(profile: dict[str, Any]) -> dict[str, str]:
    for key in ("candidate_application", "candidateProfile"):
        value = profile.get(key)
        if isinstance(value, dict):
            return {
                field: _text(value.get(field))
                for field in (
                    "name",
                    "school",
                    "major",
                    "degreeYear",
                    "phoneWeChat",
                    "email",
                    "availabilityDays",
                    "internshipDuration",
                )
            }
    return {}


def _candidate_name(profile: dict[str, Any]) -> str:
    application_profile = _candidate_application_profile(profile)
    if application_profile.get("name"):
        return application_profile["name"]
    for key in ("name", "display_name", "chinese_name", "candidate_name"):
        value = _text(profile.get(key))
        if value:
            return value
    candidate = profile.get("candidate")
    if isinstance(candidate, dict):
        return _candidate_name(candidate)
    return "候选人"


def load_candidate_evidence(profile: dict[str, Any]) -> list[dict[str, str]]:
    explicit = profile.get("evidence_items")
    if isinstance(explicit, list):
        result = []
        for index, item in enumerate(explicit, start=1):
            if not isinstance(item, dict):
                continue
            detail = _text(item.get("detail") or item.get("description") or item.get("text"))
            if not detail:
                continue
            result.append(
                {
                    "id": _text(item.get("id")) or f"evidence-{index}",
                    "category": _text(item.get("category")) or "evidence",
                    "label": _text(item.get("label") or item.get("title")) or detail[:36],
                    "detail": detail,
                    "source": _text(item.get("source") or item.get("url")),
                }
            )
        return result

    result: list[dict[str, str]] = []
    sections = ("education", "experience", "experiences", "projects", "github_projects", "skills")
    for section in sections:
        value = profile.get(section)
        if value is None:
            continue
        items = value if isinstance(value, list) else [value]
        for item in items:
            if isinstance(item, dict):
                label = next((_text(item.get(key)) for key in ("title", "name", "role", "company", "project") if _text(item.get(key))), section)
                details = [text for text in _string_values(item) if text != label]
                detail = "；".join(dict.fromkeys(details))
                source = next((_text(item.get(key)) for key in ("source", "source_pdf", "url", "github_url") if _text(item.get(key))), "")
            else:
                label = section
                detail = _text(item)
                source = ""
            if not detail:
                continue
            result.append(
                {
                    "id": f"{section}-{len(result) + 1}",
                    "category": section,
                    "label": label,
                    "detail": detail,
                    "source": source,
                }
            )
    return result


MATCH_TERMS = (
    "ai",
    "codex",
    "python",
    "sql",
    "excel",
    "数据分析",
    "用户运营",
    "内容运营",
    "产品运营",
    "品牌",
    "市场",
    "营销",
    "社群",
    "增长",
    "海外",
    "英语",
    "github",
    "项目",
    "调研",
    "kol",
    "小红书",
    "自动化",
    "agent",
    "社交媒体",
    "活动",
    "文案",
)


def _match_score(target: str, evidence: dict[str, str]) -> int:
    target_lower = target.lower()
    evidence_lower = f"{evidence['label']} {evidence['detail']}".lower()
    score = sum(3 for term in MATCH_TERMS if term in target_lower and term in evidence_lower)
    target_words = set(re.findall(r"[a-z][a-z0-9+#.-]{1,}|[\u4e00-\u9fff]{2,4}", target_lower, re.I))
    evidence_words = set(re.findall(r"[a-z][a-z0-9+#.-]{1,}|[\u4e00-\u9fff]{2,4}", evidence_lower, re.I))
    score += min(len(target_words & evidence_words), 8)
    return score


class FitEvidenceAgent:
    def __init__(self, profile: dict[str, Any]):
        self.profile = profile
        self.evidence = load_candidate_evidence(profile)

    def run(self, note: dict[str, Any], requirements: list[dict[str, Any]]) -> list[dict[str, Any]]:
        target = " ".join(
            [_text(note.get("title")), _text(note.get("body"))]
            + [_text(item.get("text")) for item in requirements]
        )
        ranked = sorted(
            ((max(_match_score(target, item), 0), item) for item in self.evidence),
            key=lambda pair: (-pair[0], pair[1]["id"]),
        )
        positive = [dict(item, match_score=score) for score, item in ranked if score > 0]
        if positive:
            return [dict(item, match_basis="keyword_match") for item in positive[:3]]

        # A zero-score note still needs a truthful draft. Prefer a general skills
        # item and label it explicitly instead of presenting it as a role match.
        general = next(
            (
                item
                for item in self.evidence
                if item.get("category") == "skills" or "skill" in item.get("id", "").lower()
            ),
            self.evidence[0] if self.evidence else None,
        )
        return [dict(general, match_score=0, match_basis="general_background")] if general else []


class OutreachWriterAgent:
    def __init__(self, profile: dict[str, Any]):
        self.profile = profile
        self.name = _candidate_name(profile)

    def run(
        self,
        note: dict[str, Any],
        application_info: dict[str, Any],
        fit_evidence: list[dict[str, Any]],
    ) -> dict[str, Any]:
        title = _text(note.get("title")) or "实习岗位"
        author = _text(note.get("author")) or _text(note.get("card_author"))
        author = re.sub(r"\s+(?:昨天|前天|\d+天前|\d{1,2}:\d{2}).*$", "", author).strip()
        salutation = f"{author}您好" if author else "您好"
        greeting = f"{salutation}，我希望就「{title}」进一步沟通。"
        evidence_ids = [item["id"] for item in fit_evidence]
        if not fit_evidence:
            return {
                "greeting": greeting,
                "email_subject": f"应聘「{title}」-{self.name}",
                "email_body": "",
                "cover_letter": "",
                "used_evidence_ids": [],
                "requirement_matches": [],
                "recommended_resume": "",
                "resume_reason": "",
                "generation_mode": "deterministic",
                "runtime_status": "not_requested",
                "status": "blocked_missing_candidate_evidence",
            }

        evidence_lines = []
        for item in fit_evidence:
            detail = re.sub(r"^(?:多份|三份)?简历(?:共同)?(?:确认|显示|记载)的?", "", _text(item.get("detail"))).strip()
            evidence_lines.append(f"我在{item['label']}中{detail}")
        requirements = application_info.get("requirements", [])
        source_links = [item["source"] for item in fit_evidence if _text(item.get("source")).lower().startswith(("https://", "http://"))]
        source_block = ""
        if source_links:
            source_block = "\n可核验项目：\n" + "\n".join(f"- {url}" for url in dict.fromkeys(source_links)) + "\n"
        email_body = (
            f"{salutation}：\n\n"
            + "\n".join(evidence_lines)
            + "\n\n"
            + f"我期待把这些工作方法用于实际任务，并就团队当前目标进一步沟通。{source_block}\n"
            + f"谢谢！\n{self.name}"
        )
        return {
            "greeting": greeting,
            "email_subject": f"应聘「{title}」-{self.name}",
            "email_body": email_body,
            "cover_letter": email_body,
            "used_evidence_ids": evidence_ids,
            "requirement_matches": [
                f"{_text(item.get('text'))}：对应证据 {fit_evidence[0]['id']}"
                for item in requirements[:2]
            ],
            "recommended_resume": "",
            "resume_reason": "",
            "generation_mode": "deterministic",
            "runtime_status": "not_requested",
            "status": "ready",
        }


def _record_key(item: dict[str, Any]) -> str:
    return _text(item.get("note_id")) or _text(item.get("note_url")) or _text(item.get("search_result_url")) or _text(item.get("card_search_result_url"))


@dataclass
class PipelineResult:
    payload: dict[str, Any]
    passed: bool


class ApplicationIntelligencePipeline:
    def __init__(
        self,
        profile: dict[str, Any],
        now: datetime | None = None,
        *,
        runtime_agent: Any = None,
        runtime_required: bool = False,
        runtime_initialization_error: str = "",
    ):
        self.profile = profile
        self.now = now or datetime.now(SHANGHAI)
        if self.now.tzinfo is None:
            self.now = self.now.replace(tzinfo=SHANGHAI)
        else:
            self.now = self.now.astimezone(SHANGHAI)
        self.info_agent = ApplicationInfoAgent()
        self.fit_agent = FitEvidenceAgent(profile)
        self.writer_agent = OutreachWriterAgent(profile)
        self.runtime_agent = runtime_agent
        self.runtime_required = runtime_required
        self.runtime_initialization_error = runtime_initialization_error

    def run(self, cards: list[dict[str, Any]], notes: list[dict[str, Any]]) -> PipelineResult:
        note_by_key = {_record_key(note): note for note in notes if _record_key(note)}
        unique_cards: list[dict[str, Any]] = []
        seen_card_keys: set[str] = set()
        for card in cards:
            key = _record_key(card)
            if key and key in seen_card_keys:
                continue
            if key:
                seen_card_keys.add(key)
            unique_cards.append(card)
        merged: list[tuple[dict[str, Any], bool]] = []
        used_keys: set[str] = set()
        for card in unique_cards:
            key = _record_key(card)
            note = note_by_key.get(key)
            if note is None and _text(card.get("note_id")):
                note = next((candidate for candidate in notes if _text(candidate.get("note_id")) == _text(card.get("note_id"))), None)
            if note is None:
                merged.append((dict(card), False))
            else:
                merged.append((note, True))
                used_keys.add(_record_key(note))
        for note in notes:
            if _record_key(note) not in used_keys:
                merged.append((note, True))

        results: list[dict[str, Any]] = []
        unparsed_times = 0
        empty_bodies = 0
        missing_records = 0
        missing_scraped_at = 0

        for note, has_record in merged:
            collected_at, collection_method = _aware_datetime(note.get("scraped_at"), self.now)
            if collection_method != "scraped_at":
                missing_scraped_at += 1
            raw_time, source_field = _time_source(note)
            normalized_time = normalize_publish_time(raw_time, collected_at, source_field) if raw_time else {
                "raw": "",
                "value": "",
                "timezone": "Asia/Shanghai",
                "precision": "unknown",
                "method": "missing",
                "is_estimated": False,
                "source_field": "",
                "collected_at": collected_at.isoformat(timespec="seconds"),
            }
            if raw_time and not normalized_time["value"]:
                unparsed_times += 1
            info = self.info_agent.run(note)
            fit = self.fit_agent.run(note, info["requirements"])
            outreach = self.writer_agent.run(note, info, fit)

            access_status = _text(note.get("access_status"))
            failed_detail_statuses = {
                "detail_unavailable",
                "detail_timeout",
                "detail_playwright_error",
                "detail_unexpected_error",
                "missing_record",
            }
            body_present = bool(_text(note.get("body"))) and access_status not in failed_detail_statuses
            if not has_record:
                missing_records += 1
            if not body_present:
                empty_bodies += 1
                outreach.update(
                    greeting="",
                    email_body="",
                    cover_letter="",
                    status="blocked_missing_job_body",
                    runtime_status="not_eligible",
                )
            results.append(
                {
                    "note_id": _text(note.get("note_id")),
                    "title": _text(note.get("title")) or _text(note.get("card_title")),
                    "note_url": _text(note.get("note_url")) or _text(note.get("search_result_url")) or _text(note.get("card_search_result_url")),
                    "body": _text(note.get("body")),
                    "access_status": access_status or ("missing_record" if not has_record else "unknown"),
                    "collected_at": collected_at.isoformat(timespec="seconds"),
                    "collection_time_source": collection_method,
                    "publish_time": normalized_time,
                    "application_info": info,
                    "fit_evidence": fit,
                    "outreach": outreach,
                    "quality": {
                        "discovered_record_present": has_record,
                        "body_present": body_present,
                        "time_normalized_when_present": not raw_time or bool(normalized_time["value"]),
                        "provenance_valid": True,
                    },
                }
            )

        if self.runtime_agent is not None:
            runtime_report = self.runtime_agent.enrich(results).as_dict()
        elif self.runtime_required:
            eligible = sum(1 for item in results if item["quality"]["body_present"])
            for record in results:
                if record["quality"]["body_present"]:
                    record["outreach"].update(
                        generation_mode="deterministic_fallback",
                        runtime_status="failed",
                        status="blocked_codex_runtime",
                    )
            runtime_report = {
                "enabled": True,
                "status": "failed",
                "cli": "",
                "prompt_version": PROMPT_VERSION,
                "requested": eligible,
                "generated": 0,
                "cached": 0,
                "failed": eligible,
                "failures": [{"note_id": "runtime", "error": self.runtime_initialization_error}],
            }
        else:
            runtime_report = {
                "enabled": False,
                "status": "disabled",
                "cli": "",
                "prompt_version": PROMPT_VERSION,
                "requested": 0,
                "generated": 0,
                "cached": 0,
                "failed": 0,
                "failures": [],
            }

        invalid_provenance = 0
        blocked_drafts = 0
        valid_evidence_ids = {item["id"] for item in self.fit_agent.evidence}
        for record in results:
            outreach = record["outreach"]
            if outreach["status"] != "ready":
                blocked_drafts += 1
            record_valid = not any(
                item not in valid_evidence_ids for item in outreach.get("used_evidence_ids", [])
            )
            for item in (
                record["application_info"]["contacts"]
                + record["application_info"]["application_routes"]
                + record["application_info"]["requirements"]
                + record["application_info"]["responsibilities"]
            ):
                if not item.get("source_field") or not item.get("evidence"):
                    record_valid = False
            record["quality"]["provenance_valid"] = record_valid
            if not record_valid:
                invalid_provenance += 1

        discovered_count = len(unique_cards) if cards else len(notes)
        record_keys = {_record_key(note) for note in notes if _record_key(note)}
        card_keys = {_record_key(card) for card in cards if _record_key(card)}
        covered_discovered = len(card_keys & record_keys) if cards else len(record_keys)
        issues = []
        checks = {
            "all_discovered_notes_have_records": missing_records == 0 and covered_discovered == discovered_count,
            "all_records_have_bodies": empty_bodies == 0,
            "all_relative_or_absolute_times_normalized": unparsed_times == 0,
            "all_records_have_source_collection_time": missing_scraped_at == 0,
            "all_extractions_and_drafts_have_provenance": invalid_provenance == 0,
            "candidate_evidence_loaded": bool(self.fit_agent.evidence),
            "all_outreach_drafts_ready": blocked_drafts == 0,
        }
        if self.runtime_required:
            checks["all_outreach_generated_by_codex_runtime"] = (
                runtime_report["failed"] == 0
                and runtime_report["requested"] == runtime_report["generated"] + runtime_report["cached"]
            )
        messages = {
            "all_discovered_notes_have_records": f"{missing_records} discovered notes have no extracted record",
            "all_records_have_bodies": f"{empty_bodies} discovered notes have no full body",
            "all_relative_or_absolute_times_normalized": f"{unparsed_times} supplied time labels could not be normalized",
            "all_records_have_source_collection_time": f"{missing_scraped_at} records lack source scraped_at and use a marked fallback",
            "all_extractions_and_drafts_have_provenance": f"{invalid_provenance} provenance references are invalid",
            "candidate_evidence_loaded": "candidate profile contains no usable resume or GitHub evidence",
            "all_outreach_drafts_ready": f"{blocked_drafts} outreach drafts are blocked",
            "all_outreach_generated_by_codex_runtime": (
                f"Codex Runtime generated or reused {runtime_report['generated'] + runtime_report['cached']} "
                f"of {runtime_report['requested']} eligible drafts"
            ),
        }
        for check, passed in checks.items():
            if not passed:
                issues.append({"check": check, "message": messages[check]})
        passed = all(checks.values())
        summary = {
            "passed": passed,
            "generated_at": self.now.isoformat(timespec="seconds"),
            "timezone": "Asia/Shanghai",
            "discovered_count": discovered_count,
            "record_count": len(notes),
            "covered_discovered_count": covered_discovered,
            "body_count": sum(1 for item in results if item["quality"]["body_present"]),
            "coverage_rate": (covered_discovered / discovered_count) if discovered_count else 1.0,
            "body_coverage_rate": (sum(1 for item in results if item["quality"]["body_present"]) / discovered_count) if discovered_count else 1.0,
            "checks": checks,
            "issues": issues,
        }
        return PipelineResult(
            payload={
                "schema_version": "1.1",
                "candidate_name": _candidate_name(self.profile),
                "agents": [
                    {"id": "coverage-agent", "status": "completed", "output": "discovery and body coverage"},
                    {"id": "time-agent", "status": "completed", "output": "Asia/Shanghai publication time"},
                    {"id": "application-info-agent", "status": "completed", "output": "responsibilities, requirements, contacts, and routes with provenance"},
                    {"id": "fit-evidence-agent", "status": "completed", "output": "resume and GitHub evidence matches"},
                    {"id": "outreach-writer-agent", "status": runtime_report["status"], "output": "per-note greeting, email, and cover letter through Codex Runtime"},
                    {"id": "quality-gate-agent", "status": "passed" if passed else "failed", "output": "coverage and provenance checks"},
                ],
                "quality_gate": summary,
                "codex_runtime": runtime_report,
                "records": results,
            },
            passed=passed,
        )


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def find_notes_path(output_dir: Path) -> Path:
    for name in ("xiaohongshu_notes_latest.json", "xiaohongshu_notes_latest_dedup.json"):
        candidate = output_dir / name
        if candidate.exists():
            return candidate
    raise FileNotFoundError(f"No latest notes JSON found under {output_dir}")


def run_pipeline(
    output_dir: Path,
    candidate_profile_path: Path,
    now: datetime | None = None,
    *,
    use_codex_runtime: bool = False,
    codex_cli_bin: str = "",
    codex_batch_size: int = 8,
    codex_timeout_seconds: int = 300,
) -> PipelineResult:
    cards = _load_json(output_dir / "xiaohongshu_cards_latest.json", [])
    notes = _load_json(find_notes_path(output_dir), [])
    profile = _load_json(candidate_profile_path, {})
    if not isinstance(cards, list) or not isinstance(notes, list) or not isinstance(profile, dict):
        raise ValueError("Cards and notes must be JSON arrays; candidate profile must be a JSON object")
    runtime_agent = None
    runtime_error = ""
    if use_codex_runtime:
        try:
            from codex_runtime_outreach import CodexRuntimeOutreachAgent

            runtime_agent = CodexRuntimeOutreachAgent(
                output_dir,
                candidate_name=_candidate_name(profile),
                candidate_profile=_candidate_application_profile(profile),
                cli_bin=codex_cli_bin,
                batch_size=codex_batch_size,
                timeout_seconds=codex_timeout_seconds,
            )
        except (OSError, ValueError) as error:
            runtime_error = str(error)
    result = ApplicationIntelligencePipeline(
        profile,
        now=now,
        runtime_agent=runtime_agent,
        runtime_required=use_codex_runtime,
        runtime_initialization_error=runtime_error,
    ).run(cards, notes)
    write_pipeline_artifacts(output_dir, result.payload)
    return result


def write_pipeline_artifacts(output_dir: Path, payload: dict[str, Any]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "application_intelligence.json"
    temp_json = json_path.with_suffix(".json.tmp")
    temp_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_json.replace(json_path)

    summary = payload["quality_gate"]
    summary_path = output_dir / "application_intelligence_summary.json"
    temp_summary = summary_path.with_suffix(".json.tmp")
    temp_summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_summary.replace(summary_path)
    coverage_path = output_dir / "coverage_report.json"
    temp_coverage = coverage_path.with_suffix(".json.tmp")
    temp_coverage.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_coverage.replace(coverage_path)

    csv_path = output_dir / "application_intelligence.csv"
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=(
                "note_id",
                "title",
                "note_url",
                "collected_at",
                "publish_time_raw",
                "publish_time_normalized",
                "publish_time_precision",
                "contact_values",
                "application_routes",
                "responsibilities",
                "requirements",
                "greeting",
                "email_subject",
                "email_body",
                "cover_letter",
                "recommended_resume",
                "generation_mode",
                "runtime_status",
                "quality_status",
            ),
        )
        writer.writeheader()
        for record in payload["records"]:
            contacts = record["application_info"]["contacts"]
            routes = record["application_info"]["application_routes"]
            responsibilities = record["application_info"]["responsibilities"]
            requirements = record["application_info"]["requirements"]
            writer.writerow(
                {key: _sheet_safe(value) for key, value in {
                    "note_id": record["note_id"],
                    "title": record["title"],
                    "note_url": record["note_url"],
                    "collected_at": record["collected_at"],
                    "publish_time_raw": record["publish_time"]["raw"],
                    "publish_time_normalized": record["publish_time"]["value"],
                    "publish_time_precision": record["publish_time"]["precision"],
                    "contact_values": " | ".join(f"{item['type']}:{item['value']}" for item in contacts),
                    "application_routes": " | ".join(item["type"] for item in routes),
                    "responsibilities": " | ".join(item["text"] for item in responsibilities),
                    "requirements": " | ".join(item["text"] for item in requirements),
                    "greeting": record["outreach"]["greeting"],
                    "email_subject": record["outreach"]["email_subject"],
                    "email_body": record["outreach"]["email_body"],
                    "cover_letter": record["outreach"].get("cover_letter", ""),
                    "recommended_resume": record["outreach"].get("recommended_resume", ""),
                    "generation_mode": record["outreach"].get("generation_mode", ""),
                    "runtime_status": record["outreach"].get("runtime_status", ""),
                    "quality_status": "pass" if all(record["quality"].values()) else "needs_review",
                }.items()}
            )

    markdown_path = output_dir / "application_intelligence_report.md"
    lines = [
        "# Application Intelligence Quality Report",
        "",
        f"- Gate: {'PASS' if summary['passed'] else 'FAIL'}",
        f"- Discovered: {summary['discovered_count']}",
        f"- Extracted records: {summary['record_count']}",
        f"- Full bodies: {summary['body_count']}",
        f"- Discovery coverage: {summary['coverage_rate']:.1%}",
        f"- Body coverage: {summary['body_coverage_rate']:.1%}",
        "",
        "## Checks",
    ]
    lines.extend(f"- [{'x' if passed else ' '}] {name}" for name, passed in summary["checks"].items())
    if summary["issues"]:
        lines.extend(["", "## Issues"])
        lines.extend(f"- {item['message']}" for item in summary["issues"])
    markdown_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    _write_xlsx(output_dir / "application_intelligence.xlsx", payload)


def _write_xlsx(path: Path, payload: dict[str, Any]) -> None:
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
    except ImportError as exc:
        raise RuntimeError("openpyxl is required to write application_intelligence.xlsx") from exc

    workbook = Workbook()
    applications = workbook.active
    applications.title = "Applications"
    application_headers = [
        "note_id",
        "title",
        "note_url",
        "access_status",
        "collected_at",
        "publish_time_raw",
        "publish_time_normalized",
        "publish_time_precision",
        "publish_time_is_estimated",
        "body",
        "greeting",
        "email_subject",
        "email_body",
        "cover_letter",
        "recommended_resume",
        "resume_reason",
        "generation_mode",
        "runtime_status",
        "draft_status",
    ]
    applications.append(application_headers)
    for record in payload["records"]:
        applications.append(
            [_sheet_safe(value) for value in [
                record["note_id"],
                record["title"],
                record["note_url"],
                record["access_status"],
                record["collected_at"],
                record["publish_time"]["raw"],
                record["publish_time"]["value"],
                record["publish_time"]["precision"],
                record["publish_time"]["is_estimated"],
                record["body"],
                record["outreach"]["greeting"],
                record["outreach"]["email_subject"],
                record["outreach"]["email_body"],
                record["outreach"].get("cover_letter", ""),
                record["outreach"].get("recommended_resume", ""),
                record["outreach"].get("resume_reason", ""),
                record["outreach"].get("generation_mode", ""),
                record["outreach"].get("runtime_status", ""),
                record["outreach"]["status"],
            ]]
        )

    contacts = workbook.create_sheet("Contacts")
    contacts.append(["note_id", "type", "value", "source_field", "evidence", "offset_start", "offset_end"])
    requirements = workbook.create_sheet("Requirements")
    requirements.append(["note_id", "requirement", "source_field", "evidence", "offset_start", "offset_end"])
    responsibilities = workbook.create_sheet("Responsibilities")
    responsibilities.append(["note_id", "responsibility", "source_field", "evidence", "offset_start", "offset_end"])
    evidence = workbook.create_sheet("Fit Evidence")
    evidence.append(["note_id", "evidence_id", "category", "label", "detail", "source", "match_score"])
    for record in payload["records"]:
        for item in record["application_info"]["contacts"] + record["application_info"]["application_routes"]:
            contacts.append(
                [_sheet_safe(value) for value in [
                    record["note_id"],
                    item["type"],
                    item["value"],
                    item["source_field"],
                    item["evidence"],
                    item.get("offset_start", -1),
                    item.get("offset_end", -1),
                ]]
            )
        for item in record["application_info"]["requirements"]:
            requirements.append(
                [_sheet_safe(value) for value in [
                    record["note_id"],
                    item["text"],
                    item["source_field"],
                    item["evidence"],
                    item.get("offset_start", -1),
                    item.get("offset_end", -1),
                ]]
            )
        for item in record["application_info"]["responsibilities"]:
            responsibilities.append(
                [_sheet_safe(value) for value in [
                    record["note_id"],
                    item["text"],
                    item["source_field"],
                    item["evidence"],
                    item.get("offset_start", -1),
                    item.get("offset_end", -1),
                ]]
            )
        for item in record["fit_evidence"]:
            evidence.append(
                [_sheet_safe(value) for value in [
                    record["note_id"],
                    item["id"],
                    item["category"],
                    item["label"],
                    item["detail"],
                    item["source"],
                    item["match_score"],
                ]]
            )

    quality = workbook.create_sheet("Quality Gate")
    quality.append(["check", "passed", "detail"])
    issue_by_check = {
        item.get("check") or item.get("code") or "unknown": item.get("message", "")
        for item in payload["quality_gate"]["issues"]
    }
    for check, passed in payload["quality_gate"]["checks"].items():
        quality.append([check, passed, issue_by_check.get(check, "")])
    quality.append([])
    for field in ("generated_at", "timezone", "discovered_count", "record_count", "covered_discovered_count", "body_count", "coverage_rate", "body_coverage_rate"):
        quality.append([field, payload["quality_gate"][field], ""])

    header_fill = PatternFill("solid", fgColor="1F4E78")
    header_font = Font(color="FFFFFF", bold=True)
    for sheet in workbook.worksheets:
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = sheet.dimensions
        for cell in sheet[1]:
            cell.fill = header_fill
            cell.font = header_font
        for row in sheet.iter_rows():
            for cell in row:
                cell.alignment = Alignment(vertical="top", wrap_text=True)
        for column in sheet.columns:
            letter = column[0].column_letter
            max_width = max((len(str(cell.value or "")) for cell in column), default=8)
            sheet.column_dimensions[letter].width = min(max(max_width + 2, 10), 48)

    temporary_path = path.with_suffix(".xlsx.tmp")
    workbook.save(temporary_path)
    temporary_path.replace(path)
