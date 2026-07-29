import argparse
import importlib.util
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urlsplit
from urllib.request import Request, urlopen

from collection_pacing import (
    DEFAULT_NOTE_DELAY_SECONDS,
    DEFAULT_RANDOM_DELAY_MAX_SECONDS,
    DEFAULT_RANDOM_DELAY_MIN_SECONDS,
    DEFAULT_SPEED_MODE,
    validate_collection_pacing,
)


DEFAULT_KEYWORD = "运营 实习 继任"
DEFAULT_SOURCE = "web_note_detail_r10"
DEFAULT_TYPE = "51"
DEFAULT_RELAY_PORT = 18800
DEFAULT_BROWSER_PROFILE = "openclaw"
DEFAULT_FEISHU_TARGET = "ou_bb2d07e6088e0e8a33041bb05f91dfb9"
CODEX_ANALYSIS_TIMEOUT_SECONDS = 45
NOISE_TITLES = {"赞", "1", "2", "3", "dd", "ddd", "蹲", "mark", "滴滴", "求"}
_STRUCTURED_HELPERS = None


def log(message: str) -> None:
    print(message, flush=True)


def skill_dir() -> Path:
    return Path(__file__).resolve().parent.parent


def scripts_dir() -> Path:
    return skill_dir() / "scripts"


def default_output_dir() -> Path:
    return Path.cwd() / "output" / "xiaohongshu-relay-scrape"


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def build_search_url(keyword: str, source: str, result_type: str) -> str:
    encoded_keyword = quote(keyword, safe="")
    return (
        "https://www.xiaohongshu.com/search_result/"
        f"?keyword={encoded_keyword}&source={source}&type={result_type}"
    )


def get_gateway_token() -> str:
    configured_path = os.environ.get("OPENCLAW_CONFIG_PATH", "").strip()
    token = Path(configured_path) if configured_path else (Path.home() / ".openclaw" / "openclaw.json")
    if token.exists():
        try:
            payload = json.loads(token.read_text(encoding="utf-8"))
            config_token = payload.get("gateway", {}).get("auth", {}).get("token", "").strip()
            if config_token:
                return config_token
        except Exception:
            pass
    if configured_path:
        return ""

    gateway_cmd = Path.home() / ".openclaw" / "gateway.cmd"
    if gateway_cmd.exists():
        text = gateway_cmd.read_text(encoding="utf-8", errors="ignore")
        marker = 'OPENCLAW_GATEWAY_TOKEN='
        if marker in text:
            for line in text.splitlines():
                if marker in line:
                    value = line.split(marker, 1)[1].strip().strip('"')
                    if value:
                        return value

    env_token = shutil.os.environ.get("OPENCLAW_GATEWAY_TOKEN", "").strip()
    if env_token:
        return env_token

    return ""


def get_relay_headers(relay_port: int) -> dict[str, str]:
    gateway_token = get_gateway_token()
    if not gateway_token:
        return {}
    relay_token = hmac.new(
        gateway_token.encode("utf-8"),
        f"openclaw-extension-relay-v1:{relay_port}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {"x-openclaw-relay-token": relay_token}


def probe_relay(relay_port: int) -> tuple[bool, list[dict]]:
    header_options = [get_relay_headers(relay_port), {}]
    seen = set()
    for headers in header_options:
        marker = tuple(sorted(headers.items()))
        if marker in seen:
            continue
        seen.add(marker)
        version_request = Request(f"http://127.0.0.1:{relay_port}/json/version", headers=headers)
        list_request = Request(f"http://127.0.0.1:{relay_port}/json/list", headers=headers)
        try:
            with urlopen(version_request, timeout=3) as response:
                version_payload = json.loads(response.read().decode("utf-8"))
            with urlopen(list_request, timeout=3) as response:
                tabs = json.loads(response.read().decode("utf-8"))
            browser_name = version_payload.get("Browser", "")
            return bool(browser_name), tabs
        except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError):
            continue
    return False, []


def resolve_cli_command(command: list[str]) -> list[str]:
    resolved_command = command[:]
    if resolved_command and resolved_command[0].lower() == "openclaw":
        executable = shutil.which("openclaw.cmd") or shutil.which("openclaw.exe") or shutil.which("openclaw")
        if not executable:
            raise RuntimeError("Could not find the openclaw executable on PATH.")
        resolved_command[0] = executable
    if resolved_command and resolved_command[0].lower() == "codex":
        executable = shutil.which("codex.cmd") or shutil.which("codex.exe") or shutil.which("codex")
        if not executable:
            raise RuntimeError("Could not find the codex executable on PATH.")
        resolved_command[0] = executable
    return resolved_command


def run_command(command: list[str], *, expect_json: bool = False, check: bool = True) -> str | dict:
    resolved_command = resolve_cli_command(command)

    attempts = 3 if resolved_command and "openclaw" in Path(resolved_command[0]).name.lower() else 1
    completed = None
    for attempt in range(1, attempts + 1):
        completed = subprocess.run(
            resolved_command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        stderr = completed.stderr.strip()
        stdout = completed.stdout.strip()
        transient_gateway_error = "gateway closed (1006" in stderr.lower() or "gateway closed (1006" in stdout.lower()
        if completed.returncode == 0 or not transient_gateway_error or attempt == attempts:
            break
        time.sleep(2)

    stdout = completed.stdout.strip()
    stderr = completed.stderr.strip()

    if check and completed.returncode != 0:
        parts = []
        if stdout:
            parts.append(stdout)
        if stderr:
            parts.append(stderr)
        message = "\n".join(parts) or f"Command failed with exit code {completed.returncode}"
        raise RuntimeError(message)

    if expect_json:
        if not stdout:
            raise RuntimeError(f"No JSON output from command: {' '.join(resolved_command)}")
        return json.loads(stdout)

    return stdout


def run_command_with_timeout(command: list[str], timeout_seconds: int) -> tuple[int | None, str, str, bool]:
    resolved_command = resolve_cli_command(command)
    process = subprocess.Popen(
        resolved_command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
        return process.returncode, stdout.strip(), stderr.strip(), False
    except subprocess.TimeoutExpired:
        try:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
        except Exception:
            try:
                process.kill()
            except Exception:
                pass
        stdout, stderr = process.communicate()
        return process.returncode, (stdout or "").strip(), (stderr or "").strip(), True


def openclaw_browser_command(browser_profile: str, *args: str) -> list[str]:
    command = ["openclaw", "browser"]
    if browser_profile:
        command.extend(["--browser-profile", browser_profile])
    command.extend(args)
    return command


def managed_browser_script() -> Path:
    configured = os.environ.get("XHS_MANAGED_BROWSER_SCRIPT", "").strip()
    candidates = [
        Path(configured) if configured else None,
        Path(__file__).resolve().parents[3] / "scripts" / "start-managed-browser.mjs",
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError("Could not locate the project-managed browser launcher.")


def start_managed_browser(relay_port: int, browser_profile: str) -> bool:
    node = os.environ.get("XHS_NODE_BIN", "").strip() or shutil.which("node")
    if not node:
        return False
    try:
        project_root = managed_browser_script().parents[1]
        data_dir = Path(os.environ.get("XHS_BROWSER_DATA_DIR", str(project_root / "data" / "browser")))
        command = [
            node,
            str(managed_browser_script()),
            "--port",
            str(relay_port),
            "--profile",
            browser_profile or DEFAULT_BROWSER_PROFILE,
            "--data-dir",
            str(data_dir),
        ]
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=35,
            check=False,
        )
        if completed.returncode != 0:
            return False
        running, tabs = probe_relay(relay_port)
        return running and bool(tabs)
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return False


def attempt_relay_recovery(relay_port: int) -> None:
    log(f"Relay port {relay_port} is down. Attempting automatic recovery...")

    if not (get_gateway_token() or shutil.which("openclaw.cmd") or shutil.which("openclaw.exe") or shutil.which("openclaw")):
        return
    try:
        run_command(["openclaw", "doctor", "--repair", "--force", "--yes"], check=False)
    except Exception:
        pass

    time.sleep(5)


def ensure_relay(
    search_url: str,
    relay_port: int,
    browser_profile: str,
    window_title_keyword: str,
    auto_attach: bool,
    attach_timeout_seconds: int,
) -> list[dict]:
    running, tabs = probe_relay(relay_port)

    if running and tabs:
        return tabs

    if start_managed_browser(relay_port, browser_profile):
        running, tabs = probe_relay(relay_port)
        if running and tabs:
            return tabs

    log("Browser session is not fully ready yet. Trying best-effort recovery...")

    attempt_relay_recovery(relay_port)
    running, tabs = probe_relay(relay_port)
    if running and tabs:
        return tabs

    if browser_profile:
        try:
            run_command(openclaw_browser_command(browser_profile, "start", "--json"), check=False)
        except Exception:
            pass

        # Only dedicated browser profiles should auto-open a page. For an
        # already attached Edge window we must reuse the user's existing tab.
        try:
            run_command(openclaw_browser_command(browser_profile, "open", search_url), check=False)
            time.sleep(2)
        except Exception:
            pass

    running, tabs = probe_relay(relay_port)
    if running and tabs:
        return tabs

    if auto_attach:
        helper = scripts_dir() / "enable_openclaw_relay.ps1"
        helper_command = [
            "powershell",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(helper),
            "-WindowTitleKeyword",
            window_title_keyword,
            "-TargetUrl",
            search_url,
            "-RelayPort",
            str(relay_port),
        ]
        run_command(helper_command, check=False)
        time.sleep(3)

    running, tabs = probe_relay(relay_port)
    if running and tabs:
        return tabs

    log(
        "Browser session is up but no Xiaohongshu tab is attached yet. "
        "If needed, focus the target browser tab and click the OpenClaw Browser Relay toolbar icon once. "
        f"Waiting up to {attach_timeout_seconds} seconds..."
    )
    deadline = time.time() + attach_timeout_seconds
    while time.time() < deadline:
        time.sleep(2)
        running, tabs = probe_relay(relay_port)
        if running and tabs:
            return tabs

    raise RuntimeError(
        "Browser session still has no attached Xiaohongshu tab after waiting. "
        "Please focus the Xiaohongshu tab, click the OpenClaw Browser Relay icon once, and retry."
    )


def should_resume(args: argparse.Namespace, output_dir: Path) -> bool:
    if args.fresh:
        return False
    if args.resume:
        return True
    return (output_dir / "xiaohongshu_notes_latest.json").exists() or (output_dir / "xiaohongshu_cards_latest.json").exists()


@dataclass
class AnalysisArtifacts:
    summary_path: Path
    summary_text: str
    analysis_path: Path
    analysis_text: str
    docx_path: Path
    structured_xlsx_path: Path | None = None


def resolve_query_label(keyword: str, search_url: str) -> str:
    stripped_keyword = keyword.strip()
    if stripped_keyword and any(character not in {"?", " "} for character in stripped_keyword):
        return stripped_keyword

    stripped_url = search_url.strip()
    if stripped_url:
        try:
            params = parse_qs(urlsplit(stripped_url).query)
            values = params.get("keyword", [])
            if values:
                decoded = unquote(values[0]).strip()
                if decoded:
                    return decoded
        except Exception:
            pass

    return stripped_url or stripped_keyword or DEFAULT_KEYWORD


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def latest_notes_json_path(output_dir: Path) -> Path | None:
    for name in ("xiaohongshu_notes_latest_dedup.json", "xiaohongshu_notes_latest.json"):
        candidate = output_dir / name
        if candidate.exists():
            return candidate
    return None


def load_notes_payload(output_dir: Path) -> tuple[Path | None, list[dict]]:
    latest_json = latest_notes_json_path(output_dir)
    if latest_json is None:
        return None, []

    try:
        payload = json.loads(latest_json.read_text(encoding="utf-8"))
    except Exception:
        return latest_json, []

    if not isinstance(payload, list):
        return latest_json, []

    normalized: list[dict] = []
    for item in payload:
        if isinstance(item, dict):
            normalized.append(item)
    return latest_json, normalized


def collect_payload_stats(payload: list[dict]) -> tuple[int, dict[str, int], list[str]]:
    total = len(payload)
    status_counts: dict[str, int] = {}
    top_titles: list[str] = []

    for item in payload:
        status = item.get("access_status", "") or "unknown"
        status_counts[status] = status_counts.get(status, 0) + 1
        title = (item.get("title", "") or item.get("card_title", "") or "").strip()
        if title and title not in top_titles and len(top_titles) < 8:
            top_titles.append(title)

    return total, status_counts, top_titles


def summarize_text(value: str, limit: int = 80) -> str:
    compact = " ".join(value.split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1].rstrip() + "…"


def build_signal_rows(payload: list[dict], *, limit: int = 12) -> list[str]:
    rows: list[str] = []
    for item in payload:
        title = summarize_text((item.get("title", "") or item.get("card_title", "") or "").strip(), limit=50)
        if not title:
            continue
        author = summarize_text((item.get("author", "") or item.get("card_author", "") or "").strip(), limit=24)
        publish_time = summarize_text((item.get("publish_time", "") or item.get("card_publish_time", "") or "").strip(), limit=24)
        access_status = summarize_text((item.get("access_status", "") or "unknown").strip(), limit=18)
        note_url = (item.get("note_url", "") or item.get("card_search_result_url", "") or item.get("card_explore_url", "")).strip()
        parts = [f"标题：{title}"]
        if author:
            parts.append(f"作者：{author}")
        if publish_time:
            parts.append(f"时间：{publish_time}")
        if access_status:
            parts.append(f"状态：{access_status}")
        if note_url:
            parts.append(f"链接：{note_url}")
        rows.append("- " + " | ".join(parts))
        if len(rows) >= limit:
            break
    return rows


def load_structured_helpers():
    global _STRUCTURED_HELPERS
    if _STRUCTURED_HELPERS is not None:
        return _STRUCTURED_HELPERS
    module_path = scripts_dir() / "build_structured_excel.py"
    spec = importlib.util.spec_from_file_location("structured_builder_runtime", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load structured builder helpers from {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _STRUCTURED_HELPERS = module
    return module


def is_noise_title(title: str) -> bool:
    normalized = title.strip().lower()
    if not normalized:
        return True
    if normalized in NOISE_TITLES:
        return True
    return len(normalized) <= 1


def estimate_publish_time_for_analysis(item: dict) -> str:
    try:
        return load_structured_helpers().estimate_publish_time(item) or ""
    except Exception:
        return ""


def extract_city_for_analysis(item: dict) -> str:
    try:
        return load_structured_helpers().extract_city(item) or ""
    except Exception:
        return ""


def extract_company_for_analysis(item: dict) -> str:
    try:
        helpers = load_structured_helpers()
        combined = " ".join(
            [
                item.get("title", "") or "",
                item.get("source_card_text", "") or "",
                item.get("body", "") or "",
                item.get("tags", "") or "",
            ]
        )
        return helpers.normalize_company(combined) or ""
    except Exception:
        return ""


def extract_role_for_analysis(item: dict) -> str:
    try:
        return load_structured_helpers().extract_role(item) or ""
    except Exception:
        return ""


def extract_arrival_for_analysis(item: dict) -> str:
    try:
        return load_structured_helpers().extract_arrival(item) or ""
    except Exception:
        return ""


def extract_delivery_methods_for_analysis(item: dict) -> str:
    try:
        return load_structured_helpers().detect_delivery_methods(item) or ""
    except Exception:
        return ""


def extract_delivery_contact_for_analysis(item: dict) -> str:
    try:
        return load_structured_helpers().extract_delivery_contact(item) or ""
    except Exception:
        return ""


def extract_emails_for_analysis(item: dict) -> str:
    try:
        helpers = load_structured_helpers()
        text = "\n".join(
            [
                item.get("title", "") or "",
                item.get("body", "") or "",
                item.get("source_card_text", "") or "",
                item.get("card_text_segments", "") or "",
            ]
        )
        return helpers.extract_emails(text) or ""
    except Exception:
        return ""


def parse_estimated_datetime(value: str) -> datetime | None:
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M")
    except ValueError:
        return None


def summarize_counter(counter: Counter, *, limit: int = 5) -> str:
    if not counter:
        return ""
    return "，".join(f"{key} {value} 条" for key, value in counter.most_common(limit))


def build_priority_lead_rows(payload: list[dict], *, limit: int = 12) -> list[dict[str, str]]:
    leads: list[tuple[float, datetime, dict[str, str]]] = []
    for item in payload:
        title = (item.get("title", "") or item.get("card_title", "") or "").strip()
        if is_noise_title(title):
            continue
        estimated = estimate_publish_time_for_analysis(item)
        estimated_dt = parse_estimated_datetime(estimated)
        if estimated_dt is None:
            continue
        company = extract_company_for_analysis(item)
        city = extract_city_for_analysis(item)
        role = extract_role_for_analysis(item)
        arrival = extract_arrival_for_analysis(item)
        methods = extract_delivery_methods_for_analysis(item)
        contact = extract_delivery_contact_for_analysis(item)
        body = (item.get("body", "") or item.get("source_card_text", "") or "").strip()
        urgency = any(keyword in (title + body) for keyword in ("急招", "继任", "尽快到岗", "ASAP", "一周内到岗", "4月"))
        note_url = (item.get("note_url", "") or item.get("card_search_result_url", "") or "").strip()

        score = 0.0
        age_hours = max((datetime.now() - estimated_dt).total_seconds() / 3600, 0.0)
        score += max(0.0, 100.0 - age_hours)
        if urgency:
            score += 20.0
        if methods:
            score += 12.0
        if "邮箱" in methods:
            score += 8.0
        if arrival:
            score += 6.0
        if item.get("access_status") == "detail_ok":
            score += 4.0

        leads.append(
            (
                score,
                estimated_dt,
                {
                    "estimated": estimated,
                    "title": title,
                    "company": company,
                    "city": city,
                    "role": role,
                    "arrival": arrival,
                    "methods": methods,
                    "contact": contact,
                    "note_url": note_url,
                },
            )
        )
    leads.sort(key=lambda item: (item[0], item[1]), reverse=True)
    deduped_rows: list[dict[str, str]] = []
    seen: set[str] = set()
    for _, _, row in leads:
        title_key = row["title"]
        if title_key in seen:
            continue
        seen.add(title_key)
        deduped_rows.append(row)
        if len(deduped_rows) >= limit:
            break
    return deduped_rows


def build_recent_lead_lines(payload: list[dict], *, limit: int = 5) -> list[str]:
    lines: list[str] = []
    for row in build_priority_lead_rows(payload, limit=limit):
        clues = [value for value in [row["company"], row["city"], row["role"], row["methods"], row["arrival"]] if value]
        line = f"- {row['estimated']} | {row['title']}"
        if clues:
            line += f"（{'；'.join(clues)}）"
        if row["contact"]:
            line += f" | 联系：{row['contact']}"
        if row["note_url"]:
            line += f" | {row['note_url']}"
        lines.append(line)
    return lines


def build_keyword_bucket_counter(payload: list[dict], buckets: dict[str, list[str]]) -> Counter:
    counter: Counter = Counter()
    for item in payload:
        text = " ".join(
            [
                item.get("title", "") or "",
                item.get("body", "") or "",
                item.get("source_card_text", "") or "",
                item.get("tags", "") or "",
            ]
        )
        for label, keywords in buckets.items():
            if any(keyword.lower() in text.lower() for keyword in keywords):
                counter[label] += 1
    return counter


def build_codex_summary(output_dir: Path, query_label: str) -> tuple[Path, str]:
    latest_json, payload = load_notes_payload(output_dir)
    total, status_counts, top_titles = collect_payload_stats(payload)
    structured_workbook = output_dir / "xiaohongshu_notes_structured.xlsx"
    signal_rows = build_signal_rows(payload)

    lines = [
        "# Xiaohongshu Scrape Summary",
        "",
        f"- Query: {query_label}",
        f"- Output directory: {output_dir}",
        f"- Primary JSON: {latest_json if latest_json else 'Not found'}",
        f"- Structured workbook: {structured_workbook if structured_workbook.exists() else 'Not found'}",
        f"- Total rows: {total}",
        "",
        "## Access Status",
    ]
    if status_counts:
        for key, value in sorted(status_counts.items()):
            lines.append(f"- {key}: {value}")
    else:
        lines.append("- No rows were produced")

    lines.extend(["", "## Sample Titles"])
    if top_titles:
        for title in top_titles:
            lines.append(f"- {title}")
    else:
        lines.append("- No titles available")

    lines.extend(["", "## Sample Signals"])
    if signal_rows:
        lines.extend(signal_rows)
    else:
        lines.append("- No structured signals available")

    summary_path = output_dir / "codex_delivery_summary.md"
    summary_text = "\n".join(lines) + "\n"
    summary_path.write_text(summary_text, encoding="utf-8")
    return summary_path, summary_text


def build_codex_analysis_prompt(summary_path: Path, query_label: str) -> str:
    prompt_lines = [
        "你正在为一轮小红书抓取结果生成简要分析。",
        f"查询词: {query_label}",
        f"请只阅读这个摘要文件: {summary_path}",
    ]

    prompt_lines.extend(
        [
            "",
            "请输出简洁中文 Markdown，不要加代码块，结构如下：",
            "# 抓取简析",
            "## 结果概览",
            "- 说明总量、抓取质量和整体判断",
            "## 值得关注的线索",
            "- 提炼 3 到 5 条最值得看的岗位 / 面经 / 招聘信号",
            "## 建议动作",
            "- 给 2 到 3 条下一步建议",
            "",
            "要求：",
            "1. 只基于文件内容，不要编造。",
            "2. 尽量引用具体标题、公司、城市、作者或发布时间等可见信号。",
            "3. 语言简洁，偏产品情报/信息整理风格。",
            "4. 如果样本不足或质量下降，直接点明原因。",
        ]
    )
    return "\n".join(prompt_lines)


def build_fallback_analysis(query_label: str, output_dir: Path, payload: list[dict]) -> str:
    total, status_counts, top_titles = collect_payload_stats(payload)
    detail_ok = status_counts.get("detail_ok", 0)
    detail_ok_rate = (detail_ok / total * 100) if total else 0.0
    unexpected_error_count = status_counts.get("detail_unexpected_error", 0)
    noisy_titles = sum(
        1
        for item in payload
        if is_noise_title((item.get("title", "") or item.get("card_title", "") or "").strip())
    )
    company_counter: Counter = Counter()
    city_counter: Counter = Counter()
    delivery_counter: Counter = Counter()
    contactable_count = 0
    direct_email_count = 0
    recent_24h = 0
    recent_72h = 0
    now = datetime.now()
    role_bucket_counter = build_keyword_bucket_counter(
        payload,
        {
            "内容/用户运营": ["内容运营", "用户运营", "社群运营", "社区运营", "新媒体", "会员运营"],
            "产品/策略运营": ["产品运营", "策略运营", "行业运营", "项目运营", "平台运营", "增长运营"],
            "商业化/广告运营": ["商业化", "广告", "投放", "品牌", "营销", "客户"],
            "电商/采销/商家运营": ["电商", "采销", "商家", "直播", "达人", "商品", "类目"],
        },
    )
    requirement_bucket_counter = build_keyword_bucket_counter(
        payload,
        {
            "数据分析/Excel/SQL": ["sql", "excel", "数据分析", "透视表", "hive", "python", "看板", "数据处理"],
            "内容策划/文案": ["内容", "文案", "选题", "公众号", "素材", "社媒", "新媒体"],
            "活动/用户增长": ["活动", "拉新", "促活", "召回", "用户增长", "社群"],
            "商业化/广告理解": ["商业化", "广告", "品牌", "营销", "投放", "媒介"],
            "英语/国际化": ["英语", "雅思", "托福", "海外", "国际化", "tiktok", "出海"],
            "AI/工具使用": ["ai", "aigc", "genai", "chatgpt", "大模型"],
        },
    )
    for item in payload:
        company = extract_company_for_analysis(item)
        city = extract_city_for_analysis(item)
        methods = extract_delivery_methods_for_analysis(item)
        contact = extract_delivery_contact_for_analysis(item)
        emails = extract_emails_for_analysis(item)
        if company:
            company_counter[company] += 1
        if city:
            city_counter[city] += 1
        if methods:
            contactable_count += 1
            for method in methods.split(" | "):
                delivery_counter[method] += 1
        if emails:
            direct_email_count += 1
        estimated = estimate_publish_time_for_analysis(item)
        estimated_dt = parse_estimated_datetime(estimated)
        if estimated_dt is None:
            continue
        age_hours = (now - estimated_dt).total_seconds() / 3600
        if age_hours <= 24:
            recent_24h += 1
        if age_hours <= 72:
            recent_72h += 1
    recent_leads = build_recent_lead_lines(payload)
    priority_rows = build_priority_lead_rows(payload, limit=10)

    lines = [
        "# 抓取深度分析",
        "",
        "## 结果概览",
        f"- 查询词：{query_label}",
        f"- 当前结果量：{total} 条。",
        f"- 可直接读正文的记录：{detail_ok} 条，完整率约 {detail_ok_rate:.1f}%。",
    ]
    if status_counts:
        status_text = "，".join(f"{key} {value} 条" for key, value in sorted(status_counts.items()))
        lines.append(f"- 抓取状态分布：{status_text}。")
    else:
        lines.append("- 当前没有可用明细，建议先检查 Relay 和搜索词。")
    if recent_24h or recent_72h:
        lines.append(f"- 时间上看，近 24 小时新增约 {recent_24h} 条，近 72 小时约 {recent_72h} 条，说明这个词下仍有持续更新。")
    if city_counter:
        lines.append(f"- 城市分布主要集中在：{summarize_counter(city_counter, limit=5)}。")
    if company_counter:
        lines.append(f"- 公司侧出现频率较高的是：{summarize_counter(company_counter, limit=6)}。")
    if role_bucket_counter:
        lines.append(f"- 岗位类型上，内容/用户、产品/策略、商业化、电商采销四类最常见，分布约为：{summarize_counter(role_bucket_counter, limit=4)}。")
    if requirement_bucket_counter:
        lines.append(f"- 要求画像里出现频率最高的是：{summarize_counter(requirement_bucket_counter, limit=6)}。")
    if noisy_titles:
        lines.append(f"- 标题噪音约 {noisy_titles} 条（如“赞”“1”这类互动贴），建议优先在表格里过滤。")
    if unexpected_error_count:
        lines.append(f"- 另有 {unexpected_error_count} 条落在 `detail_unexpected_error`，说明这轮仍有少量详情页未稳定拿全。")

    lines.extend(["", "## 投递方式"])
    if delivery_counter:
        lines.append(f"- 具备明确投递动作的岗位约 {contactable_count} 条，占总量约 {contactable_count / total * 100:.1f}%。")
        lines.append(f"- 投递方式分布：{summarize_counter(delivery_counter, limit=6)}。")
        lines.append(f"- 其中可直接邮箱投递的岗位约 {direct_email_count} 条，适合优先批量触达。")
    else:
        lines.append("- 当前没有识别出明确的投递方式，建议回表格逐条复核正文。")

    lines.extend(["", "## 工作画像"])
    if requirement_bucket_counter:
        lines.append("- 这批岗位不是单一“发帖招人”，而是能看出比较明确的工作结构：")
        for label, count in requirement_bucket_counter.most_common(6):
            lines.append(f"- {label}：约 {count} 条，说明这是这一轮最常见的能力要求。")
    if role_bucket_counter:
        lines.append("- 从岗位类型看，当前最值得优先筛的是：")
        for label, count in role_bucket_counter.most_common(4):
            lines.append(f"- {label}：约 {count} 条。")

    lines.extend(["", "## 高优先级岗位池"])
    if priority_rows:
        for row in priority_rows:
            details = [value for value in [row["company"], row["city"], row["role"], row["arrival"], row["methods"]] if value]
            line = f"- {row['estimated']} | {row['title']}"
            if details:
                line += f"（{'；'.join(details)}）"
            if row["contact"]:
                line += f" | 联系：{row['contact']}"
            if row["note_url"]:
                line += f" | {row['note_url']}"
            lines.append(line)
    else:
        lines.append("- 暂无可提炼的高优先级岗位。")

    lines.extend(["", "## 值得关注的线索"])
    if recent_leads:
        lines.extend(recent_leads)
    elif top_titles:
        for title in top_titles[:5]:
            lines.append(f"- {title}")
    else:
        lines.append("- 暂无可提炼标题，建议重新抓取或扩大关键词。")

    lines.extend(
        [
            "",
            "## 建议动作",
            "- 第一优先级建议直接在结构化表里筛 `投递方式=邮箱`，这部分最适合今天就批量投递。",
            "- 第二优先级建议把北京、上海、字节、小红书、网易、京东这几组交叉筛出来，先看近 24 小时且带明确到岗时间的岗位。",
            "- 第三优先级建议对 `detail_unexpected_error` 的 15 条做二次补抓，避免错过有价值但正文未拿全的帖子。",
            f"- 如需沉淀给外部协同，可直接使用 {output_dir / 'xiaohongshu_notes_structured.xlsx'}。",
            "- 如果后续还要扩量，不建议只继续滚动同一关键词，应该改成“城市 + 运营 + 实习 + 继任”的扩词批量抓取。",
        ]
    )
    return "\n".join(lines) + "\n"


def has_fresh_partial_output(output_dir: Path, run_started_at: float) -> tuple[Path | None, list[dict]]:
    latest_json, payload = load_notes_payload(output_dir)
    if latest_json is None or not latest_json.exists():
        return None, []
    if latest_json.stat().st_mtime + 2 < run_started_at:
        return None, []
    return latest_json, payload


def build_failure_markdown(output_dir: Path, query_label: str, error_message: str, run_started_at: float) -> tuple[Path, str, Path | None, list[dict]]:
    latest_json, payload = has_fresh_partial_output(output_dir, run_started_at)
    total, status_counts, top_titles = collect_payload_stats(payload)
    summary_path = output_dir / "scrape_failure_summary.md"
    lines = [
        "# Xiaohongshu Scrape Failure",
        "",
        f"- Query: {query_label}",
        f"- Output directory: {output_dir}",
        f"- Failed at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"- Error: {error_message}",
    ]
    if latest_json is not None:
        lines.append(f"- Partial data file: {latest_json}")
        lines.append(f"- Partial row count: {total}")
        if status_counts:
            lines.append("- Partial access status:")
            for key, value in sorted(status_counts.items()):
                lines.append(f"  - {key}: {value}")
    else:
        lines.append("- Partial data file: None detected for this failed run")
    summary_text = "\n".join(lines) + "\n"
    summary_path.write_text(summary_text, encoding="utf-8")

    report_lines = [
        "# 抓取失败报告",
        "",
        "## 失败概览",
        f"- 查询词：{query_label}",
        f"- 失败时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"- 输出目录：{output_dir}",
        f"- 错误原因：{error_message}",
    ]
    if latest_json is not None:
        report_lines.extend(
            [
                "",
                "## 已落盘的部分结果",
                f"- 已检测到本轮失败前写出的 JSON：{latest_json}",
                f"- 当前已落盘记录数：{total} 条。",
            ]
        )
        if status_counts:
            status_text = "，".join(f"{key} {value} 条" for key, value in sorted(status_counts.items()))
            report_lines.append(f"- 已落盘状态分布：{status_text}。")
        if top_titles:
            report_lines.append("- 已落盘样本标题：")
            for title in top_titles[:5]:
                report_lines.append(f"- {title}")
    else:
        report_lines.extend(
            [
                "",
                "## 已落盘的部分结果",
                "- 这次失败发生在正常导出之前，当前没有检测到属于本轮的新 JSON 落盘。",
            ]
        )
    report_lines.extend(
        [
            "",
            "## 为什么没有正常发送",
            "- 当前脚本原本只会在抓取与后处理全部成功后，才继续生成 Codex 分析并发送到飞书。",
            "- 这次属于失败态中断，所以成功态发送链路没有被触发。",
        ]
    )
    report_text = "\n".join(report_lines) + "\n"
    report_path = output_dir / "scrape_failure_report.md"
    report_path.write_text(report_text, encoding="utf-8")
    return summary_path, report_text, latest_json, payload


def strip_wrapping_code_fence(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```") and stripped.endswith("```"):
        lines = stripped.splitlines()
        if len(lines) >= 3:
            return "\n".join(lines[1:-1]).strip()
    return stripped


def is_valid_codex_analysis(text: str, query_label: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return False
    required_markers = ("# 抓取简析", "## 结果概览", "## 值得关注的线索")
    if not all(marker in stripped for marker in required_markers):
        return False
    if query_label and query_label not in stripped:
        return False
    invalid_markers = (
        "简要分析已写入",
        "当前环境没有可用的 Python 解释器",
    )
    return not any(marker in stripped for marker in invalid_markers)


def run_codex_analysis(output_dir: Path, query_label: str) -> tuple[Path, str]:
    summary_path, summary_text = build_codex_summary(output_dir, query_label)
    _, payload = load_notes_payload(output_dir)
    analysis_path = output_dir / "codex_analysis.md"
    prompt = build_codex_analysis_prompt(summary_path, query_label)
    command = [
        "codex",
        "exec",
        "--skip-git-repo-check",
        "--full-auto",
        "-C",
        str(project_root()),
        "-o",
        str(analysis_path),
    ]
    command.append("--ephemeral")
    if not is_relative_to(output_dir, project_root()):
        command.extend(["--add-dir", str(output_dir)])
    command.append(prompt)
    _, _, _, timed_out = run_command_with_timeout(command, CODEX_ANALYSIS_TIMEOUT_SECONDS)
    if timed_out:
        log(
            "Codex analysis command reached the timeout window. "
            "Falling back to the deterministic summary template instead of blocking the delivery flow."
        )
    if not timed_out and analysis_path.exists():
        analysis_text = strip_wrapping_code_fence(analysis_path.read_text(encoding="utf-8", errors="replace"))
        if is_valid_codex_analysis(analysis_text, query_label):
            analysis_path.write_text(analysis_text + "\n", encoding="utf-8")
            return analysis_path, analysis_text + "\n"
        log("Codex returned an unexpected analysis shape. Falling back to the deterministic summary template.")

    fallback_text = build_fallback_analysis(query_label, output_dir, payload)
    analysis_path.write_text(fallback_text, encoding="utf-8")
    summary_path.write_text(summary_text, encoding="utf-8")
    return analysis_path, fallback_text


def apply_document_base_style(document) -> None:
    from docx.shared import Pt

    normal_style = document.styles["Normal"]
    normal_style.font.name = "Microsoft YaHei"
    normal_style.font.size = Pt(10.5)
    title_style = document.styles["Title"]
    title_style.font.name = "Microsoft YaHei"
    title_style.font.size = Pt(18)
    heading_one = document.styles["Heading 1"]
    heading_one.font.name = "Microsoft YaHei"
    heading_one.font.size = Pt(14)
    heading_two = document.styles["Heading 2"]
    heading_two.font.name = "Microsoft YaHei"
    heading_two.font.size = Pt(12)


def build_markdown_docx(title_text: str, output_dir: Path, query_label: str, markdown_text: str, filename: str) -> Path:
    try:
        from docx import Document
        from docx.enum.text import WD_PARAGRAPH_ALIGNMENT
        from docx.shared import Pt
    except ImportError as exc:
        raise RuntimeError("python-docx is required to generate the Feishu delivery document.") from exc

    document = Document()
    apply_document_base_style(document)

    title = document.add_paragraph(style="Title")
    title.alignment = WD_PARAGRAPH_ALIGNMENT.CENTER
    title.add_run(title_text)

    meta = document.add_paragraph()
    meta.alignment = WD_PARAGRAPH_ALIGNMENT.CENTER
    meta.add_run(f"查询词：{query_label}\n").font.size = Pt(10.5)
    meta.add_run(f"生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n").font.size = Pt(10.5)
    meta.add_run(f"输出目录：{output_dir}").font.size = Pt(10.5)

    document.add_paragraph("")
    add_markdown_to_document(document, markdown_text)

    docx_path = output_dir / filename
    document.save(docx_path)
    return docx_path


def add_markdown_to_document(document, markdown_text: str) -> None:
    for raw_line in markdown_text.splitlines():
        line = raw_line.strip()
        if not line:
            document.add_paragraph("")
            continue
        if line.startswith("# "):
            document.add_heading(line[2:].strip(), level=1)
            continue
        if line.startswith("## "):
            document.add_heading(line[3:].strip(), level=2)
            continue
        if line.startswith("- "):
            document.add_paragraph(line[2:].strip(), style="List Bullet")
            continue
        document.add_paragraph(line)


def build_analysis_docx(output_dir: Path, query_label: str, analysis_text: str) -> Path:
    docx_path = build_markdown_docx("小红书抓取简要分析", output_dir, query_label, analysis_text, "codex_analysis.docx")
    try:
        from docx import Document
    except ImportError:
        return docx_path
    document = Document(docx_path)
    appendix = document.add_paragraph("")
    appendix.add_run("附：").bold = True
    appendix.add_run(f"结构化结果默认位于 {output_dir / 'xiaohongshu_notes_structured.xlsx'}")
    document.save(docx_path)
    return docx_path


def prepare_feishu_media_path(docx_path: Path) -> Path:
    delivery_dir = Path.home() / ".openclaw" / "media" / "feishu_delivery"
    delivery_dir.mkdir(parents=True, exist_ok=True)
    target_path = delivery_dir / docx_path.name
    shutil.copy2(docx_path, target_path)
    return target_path


def send_feishu_document(*, feishu_target: str, media_path: Path, message: str = "") -> str:
    command = [
        "openclaw",
        "message",
        "send",
        "--channel",
        "feishu",
        "--target",
        feishu_target,
        "--media",
        str(media_path),
        "--json",
    ]
    if message.strip():
        command.extend(["--message", message])
    resolved_command = resolve_cli_command(command)
    completed = subprocess.run(
        resolved_command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    combined_output = "\n".join(
        part for part in [completed.stdout.strip(), completed.stderr.strip()] if part
    )
    failure_markers = (
        "sendMediaFeishu failed",
        "LocalMediaAccessError",
        '"result": null',
    )
    if any(marker in combined_output for marker in failure_markers):
        raise RuntimeError(combined_output or "Feishu delivery failed.")
    message_id_match = re.search(r'"messageId"\s*:\s*"([^"]+)"', combined_output)
    if not message_id_match:
        message_id_match = re.search(r'Message ID:\s*([A-Za-z0-9_]+)', combined_output)
    if not message_id_match:
        raise RuntimeError(
            "Feishu delivery did not return a messageId.\n"
            + (combined_output or "No OpenClaw output was captured.")
        )
    message_id = message_id_match.group(1)
    log(f"Feishu delivery succeeded: {message_id}")
    return message_id


def generate_analysis_artifacts(output_dir: Path, query_label: str) -> AnalysisArtifacts:
    summary_path, summary_text = build_codex_summary(output_dir, query_label)
    analysis_path, analysis_text = run_codex_analysis(output_dir, query_label)
    docx_path = build_analysis_docx(output_dir, query_label, analysis_text)
    structured_xlsx_path = output_dir / "xiaohongshu_notes_structured.xlsx"
    return AnalysisArtifacts(
        summary_path=summary_path,
        summary_text=summary_text,
        analysis_path=analysis_path,
        analysis_text=analysis_text,
        docx_path=docx_path,
        structured_xlsx_path=structured_xlsx_path if structured_xlsx_path.exists() else None,
    )


def generate_failure_artifacts(output_dir: Path, query_label: str, error_message: str, run_started_at: float) -> AnalysisArtifacts:
    summary_path, report_text, _, _ = build_failure_markdown(output_dir, query_label, error_message, run_started_at)
    analysis_path = output_dir / "scrape_failure_report.md"
    docx_path = build_markdown_docx("小红书抓取失败报告", output_dir, query_label, report_text, "scrape_failure_report.docx")
    structured_xlsx_path = output_dir / "xiaohongshu_notes_structured.xlsx"
    return AnalysisArtifacts(
        summary_path=summary_path,
        summary_text=summary_path.read_text(encoding="utf-8"),
        analysis_path=analysis_path,
        analysis_text=report_text,
        docx_path=docx_path,
        structured_xlsx_path=structured_xlsx_path if structured_xlsx_path.exists() else None,
    )


def deliver_results_to_codex(artifacts: AnalysisArtifacts, query_label: str) -> None:
    prompt = "\n".join(
        [
            "一轮小红书抓取已经完成。",
            f"查询词：{query_label}",
            f"请先阅读摘要文件：{artifacts.summary_path}",
            f"请再阅读现成的分析文件：{artifacts.analysis_path}",
            "",
            "请在桌面端给出一版简短结论，重点回答：",
            "1. 这轮结果是否健康",
            "2. 最值得优先看的 3 条线索",
            "3. 接下来该继续扩词还是先看现有结果",
        ]
    )
    command = [
        "codex",
        "exec",
        "--skip-git-repo-check",
        "--full-auto",
        "-C",
        str(project_root()),
    ]
    artifact_dir = artifacts.analysis_path.parent
    if not is_relative_to(artifact_dir, project_root()):
        command.extend(["--add-dir", str(artifact_dir)])
    command.append(prompt)
    resolved_command = resolve_cli_command(command)
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.Popen(
        resolved_command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        creationflags=creationflags,
    )


def deliver_failure_to_codex(artifacts: AnalysisArtifacts, query_label: str) -> None:
    prompt = "\n".join(
        [
            "一轮小红书抓取失败了。",
            f"查询词：{query_label}",
            f"请先阅读失败摘要：{artifacts.summary_path}",
            f"再阅读失败报告：{artifacts.analysis_path}",
            "",
            "请在桌面端给出一版很短的排障结论，重点回答：",
            "1. 为什么这次没走到正常发送",
            "2. 当前是否已经有部分结果落盘",
            "3. 下一步最值得优先修什么",
        ]
    )
    command = [
        "codex",
        "exec",
        "--skip-git-repo-check",
        "--full-auto",
        "-C",
        str(project_root()),
    ]
    artifact_dir = artifacts.analysis_path.parent
    if not is_relative_to(artifact_dir, project_root()):
        command.extend(["--add-dir", str(artifact_dir)])
    command.append(prompt)
    resolved_command = resolve_cli_command(command)
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.Popen(
        resolved_command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        creationflags=creationflags,
    )


def deliver_results_to_feishu(artifacts: AnalysisArtifacts, query_label: str, feishu_target: str) -> None:
    if artifacts.structured_xlsx_path and artifacts.structured_xlsx_path.exists():
        send_feishu_document(
            feishu_target=feishu_target,
            media_path=prepare_feishu_media_path(artifacts.structured_xlsx_path),
        )
    send_feishu_document(
        feishu_target=feishu_target,
        media_path=prepare_feishu_media_path(artifacts.docx_path),
    )
    prompt = "\n".join(
        [
            "小红书抓取分析已生成",
            f"查询词：{query_label}",
            f"分析 Markdown：{artifacts.analysis_path}",
            f"分析文档：{artifacts.docx_path.name}",
            f"结构化表：{artifacts.structured_xlsx_path.name if artifacts.structured_xlsx_path else '未生成'}",
        ]
    )
    run_command(
        [
            "openclaw",
            "message",
            "send",
            "--channel",
            "feishu",
            "--target",
            feishu_target,
            "--message",
            prompt,
        ],
        check=False,
    )


def deliver_failure_to_feishu(artifacts: AnalysisArtifacts, query_label: str, feishu_target: str) -> None:
    if artifacts.structured_xlsx_path and artifacts.structured_xlsx_path.exists():
        send_feishu_document(
            feishu_target=feishu_target,
            media_path=prepare_feishu_media_path(artifacts.structured_xlsx_path),
        )
    send_feishu_document(
        feishu_target=feishu_target,
        media_path=prepare_feishu_media_path(artifacts.docx_path),
    )
    prompt = "\n".join(
        [
            "小红书抓取失败，已附排障文档",
            f"查询词：{query_label}",
            f"失败报告：{artifacts.analysis_path}",
            f"失败文档：{artifacts.docx_path.name}",
            f"结构化表：{artifacts.structured_xlsx_path.name if artifacts.structured_xlsx_path else '未生成'}",
        ]
    )
    run_command(
        [
            "openclaw",
            "message",
            "send",
            "--channel",
            "feishu",
            "--target",
            feishu_target,
            "--message",
            prompt,
        ],
        check=False,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="One-command Xiaohongshu relay scrape with keyword and export controls.")
    parser.add_argument("--keyword", default=DEFAULT_KEYWORD, help="Search keyword used to build the Xiaohongshu search URL.")
    parser.add_argument("--search-url", default="", help="Optional explicit search URL. Overrides --keyword.")
    parser.add_argument("--source", default=DEFAULT_SOURCE, help="search_result source parameter.")
    parser.add_argument("--type", dest="result_type", default=DEFAULT_TYPE, help="search_result type parameter.")
    parser.add_argument("--browser-profile", default=DEFAULT_BROWSER_PROFILE, help="OpenClaw browser profile name. Leave empty to reuse the current attached Edge session.")
    parser.add_argument("--relay-port", type=int, default=DEFAULT_RELAY_PORT)
    parser.add_argument("--window-title-keyword", default="小红书", help="Best-effort Edge window title keyword for auto-attach.")
    parser.add_argument("--attach-timeout-seconds", type=int, default=45, help="How long to wait for a manual relay attach before failing.")
    parser.add_argument("--output-dir", default=str(default_output_dir()))
    parser.add_argument("--max-scrolls", type=int, default=40)
    parser.add_argument("--stable-rounds", type=int, default=4)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--goto-timeout-ms", type=int, default=15000)
    parser.add_argument("--note-delay-seconds", type=float, default=DEFAULT_NOTE_DELAY_SECONDS)
    parser.add_argument("--speed-mode", choices=("steady", "random"), default=DEFAULT_SPEED_MODE)
    parser.add_argument("--random-delay-min-seconds", type=float, default=DEFAULT_RANDOM_DELAY_MIN_SECONDS)
    parser.add_argument("--random-delay-max-seconds", type=float, default=DEFAULT_RANDOM_DELAY_MAX_SECONDS)
    parser.add_argument("--resume", action="store_true", help="Force resume mode.")
    parser.add_argument("--fresh", action="store_true", help="Ignore existing checkpoints and start a fresh scrape.")
    parser.add_argument("--skip-postprocess", action="store_true")
    parser.add_argument("--no-auto-attach", action="store_true", help="Skip the best-effort relay attach helper.")
    parser.add_argument("--check-only", action="store_true", help="Only verify relay readiness and print the planned run configuration.")
    parser.add_argument("--send-to-codex", action="store_true", help="Ask Codex to generate a brief analysis and keep it visible in the local desktop session.")
    parser.add_argument("--send-to-feishu", action="store_true", help="Generate a Codex analysis DOCX and send it to Feishu via the local OpenClaw bot.")
    parser.add_argument("--feishu-target", default=DEFAULT_FEISHU_TARGET, help="Feishu target open_id/chat target for analysis delivery.")
    args = parser.parse_args()
    try:
        validate_collection_pacing(
            args.speed_mode,
            args.note_delay_seconds,
            args.random_delay_min_seconds,
            args.random_delay_max_seconds,
        )
    except ValueError as exc:
        parser.error(str(exc))
    return args


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    run_started_at = time.time()

    search_url = args.search_url or build_search_url(args.keyword, args.source, args.result_type)
    query_label = resolve_query_label(args.keyword, search_url)
    resume_mode = should_resume(args, output_dir)
    use_card_cache = resume_mode and (output_dir / "xiaohongshu_cards_latest.json").exists()

    log(f"Search URL: {search_url}")
    log(f"Output directory: {output_dir}")
    log(f"Resume mode: {resume_mode}")
    log(f"Use card cache: {use_card_cache}")

    tabs = ensure_relay(
        search_url=search_url,
        relay_port=args.relay_port,
        browser_profile=args.browser_profile,
        window_title_keyword=args.window_title_keyword,
        auto_attach=not args.no_auto_attach,
        attach_timeout_seconds=args.attach_timeout_seconds,
    )
    log(f"Attached relay tabs: {len(tabs)}")
    for tab in tabs[:3]:
        log(f"- {tab.get('title', '')} | {tab.get('url', '')}")

    if args.check_only:
        return 0

    scrape_command = [
        sys.executable,
        str(scripts_dir() / "scrape_xiaohongshu_search.py"),
        "--search-url",
        search_url,
        "--relay-port",
        str(args.relay_port),
        "--output-dir",
        str(output_dir),
        "--max-scrolls",
        str(args.max_scrolls),
        "--stable-rounds",
        str(args.stable_rounds),
        "--limit",
        str(args.limit),
        "--goto-timeout-ms",
        str(args.goto_timeout_ms),
        "--note-delay-seconds",
        str(args.note_delay_seconds),
        "--speed-mode",
        args.speed_mode,
        "--random-delay-min-seconds",
        str(args.random_delay_min_seconds),
        "--random-delay-max-seconds",
        str(args.random_delay_max_seconds),
    ]
    if resume_mode:
        scrape_command.append("--resume")
    if use_card_cache:
        scrape_command.append("--use-card-cache")

    try:
        log("Running scraper...")
        run_command(scrape_command, check=True)

        if not args.skip_postprocess:
            latest_json = output_dir / "xiaohongshu_notes_latest.json"
            postprocess_command = [
                sys.executable,
                str(scripts_dir() / "build_structured_excel.py"),
                "--input-json",
                str(latest_json),
                "--output-dir",
                str(output_dir),
            ]
            log("Running post-process exports...")
            run_command(postprocess_command, check=True)
    except Exception as exc:
        error_message = str(exc).strip() or repr(exc)
        log("Scrape run failed before normal delivery.")
        log(error_message)

        failure_artifacts: AnalysisArtifacts | None = None
        if args.send_to_codex or args.send_to_feishu:
            log("Generating failure delivery artifacts...")
            failure_artifacts = generate_failure_artifacts(output_dir, query_label, error_message, run_started_at)
            log(f"Failure report saved: {failure_artifacts.analysis_path}")
            log(f"Failure report DOCX saved: {failure_artifacts.docx_path}")

        if args.send_to_codex and failure_artifacts is not None:
            log("Dispatching failure report to Codex desktop...")
            deliver_failure_to_codex(failure_artifacts, query_label)

        if args.send_to_feishu and failure_artifacts is not None:
            log("Sending failure report DOCX to Feishu...")
            deliver_failure_to_feishu(failure_artifacts, query_label, args.feishu_target)

        return 1

    artifacts: AnalysisArtifacts | None = None
    if args.send_to_codex or args.send_to_feishu:
        log("Generating Codex analysis artifacts...")
        artifacts = generate_analysis_artifacts(output_dir, query_label)
        log(f"Codex analysis saved: {artifacts.analysis_path}")
        log(f"Analysis DOCX saved: {artifacts.docx_path}")

    if args.send_to_codex and artifacts is not None:
        log("Dispatching analysis to Codex desktop...")
        deliver_results_to_codex(artifacts, query_label)

    if args.send_to_feishu and artifacts is not None:
        log("Sending analysis DOCX to Feishu...")
        deliver_results_to_feishu(artifacts, query_label, args.feishu_target)

    log("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
