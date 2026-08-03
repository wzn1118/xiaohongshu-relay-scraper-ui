from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import os
import queue
import random
import re
import sys
import threading
import time
import uuid
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from body_completion_ledger import BodyCompletionLedger, LEDGER_FILENAME
from workflow_state import open_workflow_state_from_args


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def default_upstream_scraper() -> Path:
    candidates = [
        Path(os.environ["XHS_UPSTREAM_SCRAPER"]) if os.environ.get("XHS_UPSTREAM_SCRAPER") else None,
        PROJECT_ROOT / "vendor/xiaohongshu-relay-scrape/scripts/scrape_xiaohongshu_search.py",
        Path(os.environ["CODEX_HOME"]) / "skills/xiaohongshu-relay-scrape/scripts/scrape_xiaohongshu_search.py"
        if os.environ.get("CODEX_HOME")
        else None,
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return candidate.resolve()
    return PROJECT_ROOT / "vendor/xiaohongshu-relay-scrape/scripts/scrape_xiaohongshu_search.py"


DEFAULT_UPSTREAM_SCRAPER = default_upstream_scraper()
FAILURE_STATUSES = {
    "detail_empty",
    "detail_login_required",
    "detail_rate_limited",
    "detail_security_verification",
    "detail_unavailable",
    "detail_timeout",
    "detail_playwright_error",
    "detail_unexpected_error",
    "missing_record",
}
SECURITY_VERIFICATION_MARKERS = (
    "安全验证",
    "请完成验证",
    "验证后继续",
    "拖动滑块",
    "滑块验证",
    "captcha",
)
RATE_LIMIT_MARKERS = (
    "访问频繁",
    "请稍后再试",
    "error_code=300013",
    "detail_rate_limited",
)
PAGE_RECYCLE_STATUSES = {"detail_playwright_error"}
PAGE_CLOSED_MARKERS = (
    "target page, context or browser has been closed",
    "page has been closed",
    "context has been closed",
    "browser has been closed",
)
HEAVY_RESOURCE_TYPES = {"image", "media", "font"}


class AdaptivePacer:
    """Increase spacing after failures, then recover speed after stable successes."""

    def __init__(self, *, enabled: bool, max_delay_seconds: float = 20) -> None:
        self.enabled = bool(enabled)
        self.max_delay_seconds = max(0.0, float(max_delay_seconds))
        self.failure_level = 0
        self.success_streak = 0
        self._lock = threading.Lock()

    def observe(self, succeeded: bool) -> None:
        if not self.enabled:
            return
        with self._lock:
            if succeeded:
                self.success_streak += 1
                if self.success_streak >= 5 and self.failure_level > 0:
                    self.failure_level -= 1
                    self.success_streak = 0
                return
            self.failure_level = min(4, self.failure_level + 1)
            self.success_streak = 0

    def next_delay(
        self,
        *,
        speed_mode: str,
        note_delay_seconds: float,
        random_delay_min_seconds: float,
        random_delay_max_seconds: float,
    ) -> float:
        if str(speed_mode).strip().casefold() == "steady":
            base_delay = max(0.0, float(note_delay_seconds))
        else:
            lower = max(0.0, float(random_delay_min_seconds))
            upper = max(lower, float(random_delay_max_seconds))
            base_delay = random.uniform(lower, upper)
        with self._lock:
            level = self.failure_level if self.enabled else 0
            success_streak = self.success_streak if self.enabled else 0
        healthy_scale = 1.0
        if level == 0:
            if success_streak >= 24:
                healthy_scale = 0.5
            elif success_streak >= 12:
                healthy_scale = 0.75
        multiplier = (1, 2, 4, 6, 8)[level]
        delay = base_delay * healthy_scale * multiplier
        return min(delay, self.max_delay_seconds) if self.max_delay_seconds > 0 else delay

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "enabled": self.enabled,
                "failureLevel": self.failure_level,
                "successStreak": self.success_streak,
                "maxDelaySeconds": self.max_delay_seconds,
            }

    def healthy_batch_pause_scale(self) -> float:
        """Shorten coarse batch pauses only after a sustained clean run."""
        if not self.enabled:
            return 1.0
        with self._lock:
            if self.failure_level > 0:
                return 1.0
            if self.success_streak >= 24:
                return 0.5
            if self.success_streak >= 12:
                return 0.75
            return 1.0


class RateLimitRecovery:
    """Keep one body task alive while a platform throttle cools down."""

    def __init__(
        self,
        *,
        enabled: bool = True,
        initial_delay_seconds: float = 120,
        max_delay_seconds: float = 900,
        max_retries: int = 6,
        recovery_spacing_seconds: float = 30,
        max_recovery_spacing_seconds: float = 120,
        stable_successes: int = 3,
    ) -> None:
        self.enabled = bool(enabled)
        self.initial_delay_seconds = max(0.0, float(initial_delay_seconds))
        self.max_delay_seconds = max(self.initial_delay_seconds, float(max_delay_seconds))
        self.max_retries = max(0, int(max_retries))
        self.recovery_spacing_seconds = max(0.0, float(recovery_spacing_seconds))
        self.max_recovery_spacing_seconds = max(
            self.recovery_spacing_seconds,
            float(max_recovery_spacing_seconds),
        )
        self.stable_successes = max(1, int(stable_successes))
        self.detected_count = 0
        self.recovery_attempts = 0
        self.episode_attempts = 0
        self.success_streak = 0
        self.blocked_until = 0.0
        self.exhausted = False
        self._probe_pending = False
        self._lock = threading.Lock()

    def register_rate_limit(self) -> dict[str, Any]:
        with self._lock:
            self.detected_count += 1
            if not self.enabled or self.episode_attempts >= self.max_retries:
                self.exhausted = True
                return {
                    "recoverable": False,
                    "attempt": self.episode_attempts,
                    "maxRetries": self.max_retries,
                    "waitSeconds": 0.0,
                }
            self.episode_attempts += 1
            self.recovery_attempts += 1
            self.success_streak = 0
            wait_seconds = min(
                self.max_delay_seconds,
                self.initial_delay_seconds * (2 ** (self.episode_attempts - 1)),
            )
            self.blocked_until = max(self.blocked_until, time.monotonic() + wait_seconds)
            self._probe_pending = True
            return {
                "recoverable": True,
                "attempt": self.episode_attempts,
                "maxRetries": self.max_retries,
                "waitSeconds": wait_seconds,
            }

    def wait_until_probe(self, stop_event: threading.Event) -> bool:
        last_reported_bucket: int | None = None
        while not stop_event.is_set():
            with self._lock:
                remaining = max(0.0, self.blocked_until - time.monotonic())
                attempt = self.episode_attempts
                probe_pending = self._probe_pending
                if remaining <= 0 and probe_pending:
                    self._probe_pending = False
            if remaining <= 0:
                if probe_pending:
                    print(
                        f"BODY_RATE_LIMIT probe attempt={attempt}/{self.max_retries}",
                        flush=True,
                    )
                return True
            bucket = int(remaining // 15)
            if bucket != last_reported_bucket:
                print(
                    "BODY_RATE_LIMIT waiting "
                    f"attempt={attempt}/{self.max_retries} remaining={remaining:.1f}s",
                    flush=True,
                )
                last_reported_bucket = bucket
            if stop_event.wait(min(5.0, remaining)):
                return False
        return False

    def observe_success(self) -> bool:
        with self._lock:
            if self.episode_attempts <= 0:
                return False
            self.success_streak += 1
            if self.success_streak < self.stable_successes:
                return False
            self.episode_attempts = 0
            self.success_streak = 0
            self.blocked_until = 0.0
            self.exhausted = False
            return True

    def next_spacing(self) -> float:
        with self._lock:
            if self.episode_attempts <= 0:
                return 0.0
            return min(
                self.max_recovery_spacing_seconds,
                self.recovery_spacing_seconds * (2 ** (self.episode_attempts - 1)),
            )

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "enabled": self.enabled,
                "detectedCount": self.detected_count,
                "recoveryAttempts": self.recovery_attempts,
                "episodeAttempts": self.episode_attempts,
                "maxRetries": self.max_retries,
                "initialDelaySeconds": self.initial_delay_seconds,
                "maxDelaySeconds": self.max_delay_seconds,
                "recoverySpacingSeconds": self.recovery_spacing_seconds,
                "maxRecoverySpacingSeconds": self.max_recovery_spacing_seconds,
                "stableSuccesses": self.stable_successes,
                "successStreak": self.success_streak,
                "exhausted": self.exhausted,
            }


def configure_lightweight_detail_page(page: Any) -> None:
    """Skip heavy visual resources while preserving DOM attributes and API calls."""

    def handle_route(route: Any) -> None:
        if str(route.request.resource_type or "").casefold() in HEAVY_RESOURCE_TYPES:
            route.abort()
            return
        route.continue_()

    page.route("**/*", handle_route)


def contains_security_verification(value: Any) -> bool:
    text = str(value or "").casefold()
    return any(marker.casefold() in text for marker in SECURITY_VERIFICATION_MARKERS)


def contains_rate_limit(value: Any) -> bool:
    text = str(value or "").casefold()
    return any(marker.casefold() in text for marker in RATE_LIMIT_MARKERS)


def should_retry_on_fresh_page(payload: dict[str, Any]) -> bool:
    status = str(payload.get("access_status") or "").strip().casefold()
    if status in PAGE_RECYCLE_STATUSES:
        return True
    if status != "detail_worker_error":
        return False
    text = json.dumps(payload, ensure_ascii=False).casefold()
    return any(marker in text for marker in PAGE_CLOSED_MARKERS)


def processed_attempt_count(card_keys: list[str], attempted_keys: set[str]) -> int:
    return len(set(card_keys).intersection(attempted_keys))


def record_key(record: dict[str, Any]) -> str:
    return str(record.get("note_id") or record.get("note_url") or "").strip()


def pending_retry_priority(
    card: dict[str, Any],
    ledger_records: dict[str, dict[str, Any]],
) -> tuple[int, int]:
    """Keep fresh work ahead of retries, with rate-limited notes last."""
    record = ledger_records.get(record_key(card), {})
    failure_code = str(record.get("failureCode") or "").strip().casefold()
    attempt_count = max(0, int(record.get("attemptCount") or 0))
    return (int(failure_code == "detail_rate_limited"), attempt_count)


def deduplicate_cards(cards: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    unique: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    duplicates = 0
    for card in cards:
        key = record_key(card)
        if not key:
            raise ValueError("Card checkpoints must have non-empty note identifiers")
        if key not in unique:
            unique[key] = dict(card)
            order.append(key)
            continue
        duplicates += 1
        merged = unique[key]
        for field, value in card.items():
            if value not in (None, "", [], {}) and merged.get(field) in (None, "", [], {}):
                merged[field] = value
        ranks = [
            int(value)
            for value in (merged.get("card_rank"), card.get("card_rank"))
            if str(value or "").isdigit() and int(value) > 0
        ]
        if ranks:
            merged["card_rank"] = min(ranks)
    return [unique[key] for key in order], duplicates


def record_is_complete(record: dict[str, Any]) -> bool:
    detail_text = " ".join(
        str(record.get(field) or "")
        for field in ("note_url", "title", "body")
    )
    return (
        bool(record_key(record))
        and bool(str(record.get("body") or "").strip())
        and str(record.get("access_status") or "").strip() == "detail_ok"
        and not contains_security_verification(detail_text)
        and not contains_rate_limit(detail_text)
    )


def infer_card_publish_datetime(
    card: dict[str, Any],
    reference: datetime,
) -> datetime | None:
    """Parse the compact publish labels emitted by the search result cards."""

    text = str(card.get("publish_time") or card.get("card_publish_time") or "").strip()
    if not text:
        return None
    if text.startswith("\u521a\u521a"):
        return reference
    match = re.search(r"(\d+)\s*\u5206\u949f\u524d", text)
    if match:
        return reference - timedelta(minutes=int(match.group(1)))
    match = re.search(r"(\d+)\s*\u5c0f\u65f6\u524d", text)
    if match:
        return reference - timedelta(hours=int(match.group(1)))
    match = re.search(r"(\d+)\s*\u5929\u524d", text)
    if match:
        return reference - timedelta(days=int(match.group(1)))
    if text.startswith("\u6628\u5929"):
        return reference - timedelta(days=1)
    if text.startswith("\u524d\u5929"):
        return reference - timedelta(days=2)

    match = re.search(r"(?<!\d)(\d{4})[-/.\u5e74](\d{1,2})[-/.\u6708](\d{1,2})", text)
    if match:
        try:
            return reference.replace(
                year=int(match.group(1)),
                month=int(match.group(2)),
                day=int(match.group(3)),
                hour=0,
                minute=0,
                second=0,
                microsecond=0,
            )
        except ValueError:
            return None
    match = re.search(r"(?<!\d)(\d{1,2})[-/.\u6708](\d{1,2})(?:\u65e5)?", text)
    if not match:
        return None
    try:
        candidate = reference.replace(
            month=int(match.group(1)),
            day=int(match.group(2)),
            hour=0,
            minute=0,
            second=0,
            microsecond=0,
        )
    except ValueError:
        return None
    if candidate > reference + timedelta(days=1):
        candidate = candidate.replace(year=candidate.year - 1)
    return candidate


def filter_cards_by_recency(
    cards: list[dict[str, Any]],
    max_age_days: int,
    *,
    reference: datetime,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    """Keep unknown dates, while excluding cards known to be older than the scope."""

    if max_age_days <= 0:
        return list(cards), [], 0
    cutoff = reference - timedelta(days=max_age_days)
    kept: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    unknown = 0
    for card in cards:
        published_at = infer_card_publish_datetime(card, reference)
        if published_at is None:
            unknown += 1
            kept.append(card)
        elif published_at >= cutoff:
            kept.append(card)
        else:
            excluded.append(card)
    return kept, excluded, unknown


def detail_url_candidates(card: dict[str, Any]) -> list[str]:
    """Return normalized detail URLs for compatibility and diagnostics.

    The upstream scraper owns navigation fallback so each card is still handed
    to it only once by the body-completion worker.
    """
    candidates = [
        card.get("search_result_url", ""),
        card.get("note_url", ""),
        card.get("explore_url", ""),
    ]
    return list(dict.fromkeys(str(url).strip() for url in candidates if str(url).strip()))


def infer_body_cache_root(output_dir: Path) -> Path | None:
    """Return the shared jobs directory for a standard job artifact path."""

    if output_dir.name.casefold() != "artifacts":
        return None
    jobs_root = output_dir.parent.parent
    if jobs_root.name.casefold() != "jobs" or not jobs_root.is_dir():
        return None
    return jobs_root


def load_reusable_body_records(
    output_dir: Path,
    card_keys: set[str],
    *,
    max_age_days: int = 30,
) -> tuple[dict[str, tuple[dict[str, Any], str]], dict[str, Any]]:
    """Load fresh, complete note bodies from sibling jobs without network access."""

    jobs_root = infer_body_cache_root(output_dir)
    stats: dict[str, Any] = {
        "enabled": jobs_root is not None,
        "root": str(jobs_root) if jobs_root is not None else "",
        "maxAgeDays": max(0, int(max_age_days)),
        "scannedJobs": 0,
        "eligibleBodies": 0,
        "reusedBodies": 0,
        "networkRequestsAvoided": 0,
    }
    if jobs_root is None or not card_keys:
        return {}, stats

    max_age_days = max(0, int(max_age_days))
    cutoff = time.time() - (max_age_days * 86400) if max_age_days else 0.0
    current_job_dir = output_dir.parent.resolve()
    selected: dict[str, tuple[dict[str, Any], str]] = {}
    selected_scores: dict[str, tuple[float, str, int]] = {}
    try:
        job_dirs = [path for path in jobs_root.iterdir() if path.is_dir()]
    except OSError:
        return {}, stats

    for job_dir in job_dirs:
        try:
            if job_dir.resolve() == current_job_dir:
                continue
        except OSError:
            continue
        notes_path = job_dir / "artifacts" / "xiaohongshu_notes_latest.json"
        try:
            modified_at = notes_path.stat().st_mtime
        except OSError:
            continue
        if cutoff and modified_at < cutoff:
            continue
        try:
            records = load_json_list(notes_path)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        stats["scannedJobs"] += 1
        for record in records:
            key = record_key(record)
            if key not in card_keys or not record_is_complete(record):
                continue
            stats["eligibleBodies"] += 1
            score = (
                modified_at,
                str(record.get("scraped_at") or ""),
                len(str(record.get("body") or "")),
            )
            if score <= selected_scores.get(key, (-1.0, "", -1)):
                continue
            selected[key] = (dict(record), job_dir.name)
            selected_scores[key] = score
    return selected, stats


def materialize_reused_body(
    card: dict[str, Any],
    cached_record: dict[str, Any],
    *,
    source_job_id: str,
) -> dict[str, Any]:
    """Combine cached detail data with metadata from the current result card."""

    merged = dict(cached_record)
    for field, value in card.items():
        if field.startswith("card_") or field in {
            "source_card_text",
            "search_result_url",
            "explore_url",
            "card_link_urls",
            "card_image_urls",
            "card_text_segments",
        }:
            if value not in (None, "", [], {}):
                merged[field] = value
        elif field not in merged:
            merged[field] = value
    merged["note_id"] = card.get("note_id") or cached_record.get("note_id") or ""
    merged["body_cache_hit"] = True
    merged["body_cache_source_job"] = source_job_id
    merged["body_cache_original_scraped_at"] = str(cached_record.get("scraped_at") or "")
    merged["body_cache_reused_at"] = utc_now()
    return merged


def load_json_list(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list) or not all(isinstance(item, dict) for item in payload):
        raise ValueError(f"Expected a JSON object array: {path}")
    return payload


def atomic_json(path: Path, payload: Any) -> None:
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def write_csv(records: list[dict[str, Any]], path: Path) -> None:
    if not records:
        path.write_text("", encoding="utf-8")
        return
    fieldnames = list(records[0])
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(records)


def load_upstream(path: Path):
    resolved = path.resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"Upstream scraper was not found: {resolved}")
    module_dir = str(resolved.parent)
    if module_dir not in sys.path:
        sys.path.insert(0, module_dir)
    spec = importlib.util.spec_from_file_location("xiaohongshu_parallel_upstream", resolved)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load upstream scraper: {resolved}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def complete_bodies(
    output_dir: Path,
    *,
    relay_port: int,
    workers: int = 1,
    attempts: int = 3,
    goto_timeout_ms: int = 15000,
    checkpoint_every: int = 10,
    page_recycle_every: int = 20,
    page_recovery_delay_seconds: float = 0,
    body_batch_size: int = 0,
    body_batch_pause_min_seconds: float = 0,
    body_batch_pause_max_seconds: float = 0,
    proactive_rest_every: int = 0,
    proactive_rest_seconds: float = 0,
    adaptive_pacing: bool = False,
    adaptive_max_delay_seconds: float = 20,
    block_heavy_resources: bool = False,
    rate_limit_auto_recovery: bool = True,
    rate_limit_initial_delay_seconds: float = 120,
    rate_limit_max_delay_seconds: float = 900,
    rate_limit_max_retries: int = 6,
    rate_limit_recovery_spacing_seconds: float = 30,
    rate_limit_max_recovery_spacing_seconds: float = 120,
    rate_limit_stable_successes: int = 3,
    security_verification_timeout_seconds: int = 600,
    speed_mode: str = "random",
    note_delay_seconds: float = 1.2,
    random_delay_min_seconds: float = 0.8,
    random_delay_max_seconds: float = 2.4,
    reuse_body_cache: bool = True,
    body_cache_max_age_days: int = 30,
    max_age_days: int = 0,
    cache_only: bool = False,
    upstream_scraper: Path = DEFAULT_UPSTREAM_SCRAPER,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    output_dir = output_dir.resolve()
    cards_path = output_dir / "xiaohongshu_cards_latest.json"
    notes_path = output_dir / "xiaohongshu_notes_latest.json"
    csv_path = output_dir / "xiaohongshu_notes_latest.csv"
    failures_path = output_dir / "parallel_body_failures.json"
    summary_path = output_dir / "parallel-body-summary.json"
    out_of_scope_path = output_dir / "xiaohongshu_cards_out_of_scope.json"
    cards = load_json_list(cards_path)
    archived_out_of_scope = (
        load_json_list(out_of_scope_path) if out_of_scope_path.exists() else []
    )
    if archived_out_of_scope:
        cards.extend(archived_out_of_scope)
    if not cards:
        raise ValueError("The card checkpoint is empty")
    original_card_count = len(cards)
    cards, duplicate_count = deduplicate_cards(cards)
    if duplicate_count:
        atomic_json(cards_path, cards)
        print(
            f"CARD_CHECKPOINT_NORMALIZED before={original_card_count} after={len(cards)} duplicates={duplicate_count}",
            flush=True,
        )
    source_card_count = len(cards)
    max_age_days = max(0, min(int(max_age_days), 365))
    scope_reference: datetime | None = None
    if summary_path.exists():
        try:
            previous_summary = json.loads(summary_path.read_text(encoding="utf-8"))
            reference_value = previous_summary.get("scope", {}).get("referenceTime")
            if reference_value:
                scope_reference = datetime.fromisoformat(str(reference_value))
        except (OSError, ValueError, json.JSONDecodeError, AttributeError):
            scope_reference = None
    if scope_reference is None:
        try:
            scope_reference = datetime.fromtimestamp(cards_path.stat().st_mtime).astimezone()
        except OSError:
            scope_reference = datetime.now().astimezone()
    cards, out_of_scope_cards, unknown_date_count = filter_cards_by_recency(
        cards,
        max_age_days,
        reference=scope_reference,
    )
    if max_age_days > 0:
        atomic_json(out_of_scope_path, out_of_scope_cards)
        if len(cards) != source_card_count:
            atomic_json(cards_path, cards)
        print(
            "BODY_SCOPE "
            f"max_age_days={max_age_days} source={source_card_count} "
            f"eligible={len(cards)} excluded={len(out_of_scope_cards)} "
            f"unknown={unknown_date_count}",
            flush=True,
        )
    else:
        out_of_scope_path.unlink(missing_ok=True)
    if not cards:
        raise ValueError("No cards remain inside the requested time range")
    card_keys = [record_key(card) for card in cards]
    if len(set(card_keys)) != len(card_keys):
        raise ValueError("Card checkpoints must have unique note identifiers")

    existing = load_json_list(notes_path) if notes_path.exists() else []
    existing_failures = load_json_list(failures_path) if failures_path.exists() else []
    complete_by_key = {record_key(record): record for record in existing if record_is_complete(record)}
    card_key_set = set(card_keys)
    card_by_key = dict(zip(card_keys, cards, strict=False))
    complete_by_key = {key: value for key, value in complete_by_key.items() if key in card_key_set}
    body_cache_stats: dict[str, Any] = {
        "enabled": bool(reuse_body_cache),
        "root": "",
        "maxAgeDays": max(0, int(body_cache_max_age_days)),
        "scannedJobs": 0,
        "eligibleBodies": 0,
        "reusedBodies": 0,
        "networkRequestsAvoided": 0,
    }
    if reuse_body_cache:
        cached_by_key, body_cache_stats = load_reusable_body_records(
            output_dir,
            card_key_set,
            max_age_days=body_cache_max_age_days,
        )
        for key, (cached_record, source_job_id) in cached_by_key.items():
            if key in complete_by_key:
                continue
            complete_by_key[key] = materialize_reused_body(
                card_by_key[key],
                cached_record,
                source_job_id=source_job_id,
            )
            body_cache_stats["reusedBodies"] += 1
        body_cache_stats["networkRequestsAvoided"] = body_cache_stats["reusedBodies"]
        if body_cache_stats["reusedBodies"]:
            print(
                "BODY_CACHE_REUSE "
                f"matched={body_cache_stats['reusedBodies']} "
                f"complete={len(complete_by_key)}/{len(cards)} "
                f"scanned_jobs={body_cache_stats['scannedJobs']}",
                flush=True,
            )
    last_failures = {
        record_key(record): record
        for record in existing_failures
        if record_key(record) in card_key_set and record_key(record) not in complete_by_key
    }
    ledger = BodyCompletionLedger.open(
        output_dir,
        cards,
        complete_by_key.values(),
        existing_failures,
    )
    ledger_records = ledger.records
    attempted_keys = {
        key for key, record in ledger_records.items()
        if int(record.get("attemptCount") or 0) > 0
    }
    round_progress: dict[int, int] = {}
    upstream = None
    lock = threading.RLock()
    stop_event = threading.Event()
    security_gate = threading.Event()
    security_gate.set()
    successful_since_checkpoint = 0
    security_detected_at = ""
    security_status = "not_detected"
    security_owner_id: int | None = None
    rate_limit_detected_at = ""
    stop_reason = ""
    checkpoint_error: BaseException | None = None
    invocation_id = uuid.uuid4().hex
    body_requests_since_pause = 0
    body_requests_since_proactive_rest = 0
    pacer = AdaptivePacer(
        enabled=adaptive_pacing,
        max_delay_seconds=adaptive_max_delay_seconds,
    )
    rate_limit_recovery = RateLimitRecovery(
        enabled=rate_limit_auto_recovery,
        initial_delay_seconds=rate_limit_initial_delay_seconds,
        max_delay_seconds=rate_limit_max_delay_seconds,
        max_retries=rate_limit_max_retries,
        recovery_spacing_seconds=rate_limit_recovery_spacing_seconds,
        max_recovery_spacing_seconds=rate_limit_max_recovery_spacing_seconds,
        stable_successes=rate_limit_stable_successes,
    )

    def next_body_delay() -> float:
        return pacer.next_delay(
            speed_mode=speed_mode,
            note_delay_seconds=note_delay_seconds,
            random_delay_min_seconds=random_delay_min_seconds,
            random_delay_max_seconds=random_delay_max_seconds,
        )

    source_search_url = next(
        (str(record.get("source_search_url")) for record in existing if record.get("source_search_url")),
        "https://www.xiaohongshu.com/search_result/",
    )

    def ordered_complete() -> list[dict[str, Any]]:
        return [complete_by_key[key] for key in card_keys if key in complete_by_key]

    def notify_progress(
        *,
        event: str,
        status: str = "running",
        summary: dict[str, Any] | None = None,
    ) -> None:
        nonlocal checkpoint_error
        if progress_callback is None:
            return
        try:
            progress_callback({
                "event": event,
                "cards": [dict(item) for item in cards],
                "completeRecords": [dict(item) for item in ordered_complete()],
                "failures": [dict(item) for item in last_failures.values()],
                "attemptedIds": sorted(attempted_keys),
                "ledger": ledger.snapshot(),
                "status": status,
                "summary": summary,
                "lastCheckpointAt": utc_now(),
            })
        except BaseException as error:
            checkpoint_error = error
            stop_event.set()
            security_gate.set()
            raise

    def checkpoint(force: bool = False, *, event: str = "checkpoint") -> None:
        nonlocal successful_since_checkpoint, checkpoint_error
        if not force and successful_since_checkpoint < checkpoint_every:
            return
        records = ordered_complete()
        atomic_json(notes_path, records)
        successful_since_checkpoint = 0
        notify_progress(event=event)
        print(f"PARALLEL_BODY {len(records)}/{len(cards)} checkpoint", flush=True)

    def finish_request(
        key: str,
        request_id: str,
        payload: dict[str, Any],
        status: str,
        *,
        stop_reason_value: str,
        recoverable: bool,
    ) -> None:
        if not request_id:
            return
        failure_code = str(payload.get("access_status") or "missing_record")
        failure_message = str(payload.get("worker_error") or payload.get("error") or "")
        with lock:
            ledger.finish_attempt(
                key,
                request_id,
                status,
                failure_code=failure_code,
                failure_message=failure_message,
                recoverable=recoverable,
                stop_reason=stop_reason_value,
            )
            notify_progress(event="attempt_finished")

    def scrape_with_url_fallback(page: Any, card: dict[str, Any]) -> tuple[dict[str, Any], str]:
        key = record_key(card)
        request_id = f"{invocation_id}:{key}:{uuid.uuid4().hex}"
        with lock:
            if not ledger.start_attempt(key, request_id):
                raise RuntimeError(f"Body request is not eligible for ledger transition: {key}")
            attempted_keys.add(key)
            notify_progress(event="attempt_started")
        try:
            # The upstream scraper already owns signed-URL -> explore fallback.
            # Calling it once avoids multiplying navigation attempts in this layer.
            record = upstream.scrape_note(
                page,
                dict(card),
                goto_timeout_ms=goto_timeout_ms,
                source_search_url=source_search_url,
            )
            payload = asdict(record) if record is not None else {}
        except Exception as error:  # noqa: BLE001
            payload = {
                "note_id": card.get("note_id", ""),
                "note_url": card.get("note_url", ""),
                "body": "",
                "access_status": "detail_worker_error",
                "worker_error": str(error),
            }
        payload.setdefault("note_id", card.get("note_id", ""))
        payload.setdefault("note_url", card.get("note_url", ""))
        return payload, request_id

    def run_worker(
        worker_id: int,
        work: queue.Queue[dict[str, Any]],
        round_number: int,
        round_total: int,
    ) -> None:
        nonlocal successful_since_checkpoint, security_detected_at, security_status, security_owner_id
        nonlocal rate_limit_detected_at, stop_reason, body_requests_since_pause
        nonlocal body_requests_since_proactive_rest
        try:
            from playwright.sync_api import sync_playwright

            print(f"PARALLEL_WORKER {worker_id} connecting", flush=True)
            with sync_playwright() as playwright:
                browser = upstream.connect_browser(playwright, relay_port)
                context = upstream.get_or_create_context(browser)
                page = context.new_page()
                if block_heavy_resources:
                    configure_lightweight_detail_page(page)
                page_uses = 0

                def recycle_page(reason: str) -> None:
                    nonlocal browser, context, page, page_uses
                    try:
                        page.close()
                    except Exception:  # noqa: BLE001
                        pass
                    try:
                        replacement = context.new_page()
                    except Exception:  # noqa: BLE001
                        browser = upstream.connect_browser(playwright, relay_port)
                        context = upstream.get_or_create_context(browser)
                        replacement = context.new_page()
                    if block_heavy_resources:
                        configure_lightweight_detail_page(replacement)
                    page = replacement
                    page_uses = 0
                    print(f"PARALLEL_WORKER {worker_id} recycled-page reason={reason}", flush=True)

                print(f"PARALLEL_WORKER {worker_id} ready", flush=True)
                try:
                    while True:
                        while not security_gate.wait(timeout=0.25):
                            if stop_event.is_set():
                                break
                        if stop_event.is_set():
                            break
                        if not rate_limit_recovery.wait_until_probe(stop_event):
                            break
                        try:
                            card = work.get_nowait()
                        except queue.Empty:
                            break
                        if stop_event.is_set():
                            work.task_done()
                            break
                        key = record_key(card)
                        request_id = ""
                        page_retry = 0
                        recycled_for_retry = False
                        while True:
                            try:
                                payload, request_id = scrape_with_url_fallback(page, card)
                            except Exception as error:  # noqa: BLE001
                                payload = {
                                    "note_id": card.get("note_id", ""),
                                    "note_url": card.get("note_url", ""),
                                    "body": "",
                                    "access_status": "detail_worker_error",
                                    "worker_error": str(error),
                                }
                            if not should_retry_on_fresh_page(payload) or page_retry >= 1:
                                break
                            finish_request(
                                key,
                                request_id,
                                payload,
                                "failed",
                                stop_reason_value="page_recycled",
                                recoverable=True,
                            )
                            with lock:
                                last_failures[key] = payload
                            page_retry += 1
                            print(
                                f"PARALLEL_RETRY note={key} reason=page_closed attempt={page_retry}/1",
                                flush=True,
                            )
                            try:
                                recycle_page("page_closed_retry")
                                recycled_for_retry = True
                            except Exception as recycle_error:  # noqa: BLE001
                                payload = {
                                    "note_id": card.get("note_id", ""),
                                    "note_url": card.get("note_url", ""),
                                    "body": "",
                                    "access_status": "detail_worker_error",
                                    "worker_error": f"Could not recreate relay page: {recycle_error}",
                                }
                                request_id = ""
                                break
                            if page_recovery_delay_seconds > 0:
                                print(
                                    "PARALLEL_PAGE_RECOVERY "
                                    f"note={key} wait={page_recovery_delay_seconds:.1f}s",
                                    flush=True,
                                )
                                if stop_event.wait(page_recovery_delay_seconds):
                                    break
                        # Another worker may have timed out while this request was
                        # in flight. Discard the late result before it mutates the
                        # checkpoint or advances to another card.
                        if stop_event.is_set():
                            finish_request(
                                key,
                                request_id,
                                payload,
                                "cancelled",
                                stop_reason_value=stop_reason or "task_interrupted",
                                recoverable=True,
                            )
                            work.task_done()
                            break
                        if not record_is_complete(payload):
                            challenge_text = json.dumps(payload, ensure_ascii=False)
                            if not (
                                contains_rate_limit(challenge_text)
                                or contains_security_verification(challenge_text)
                            ):
                                try:
                                    challenge_text += "\n" + page.locator("body").inner_text(timeout=3000)
                                except Exception:  # noqa: BLE001
                                    pass
                            if contains_rate_limit(challenge_text):
                                pacer.observe(False)
                                with lock:
                                    body_requests_since_proactive_rest = 0
                                finish_request(
                                    key,
                                    request_id,
                                    payload,
                                    "blocked",
                                    stop_reason_value="rate_limited",
                                    recoverable=True,
                                )
                                with lock:
                                    last_failures[key] = payload
                                    rate_limit_detected_at = rate_limit_detected_at or utc_now()
                                recovery = rate_limit_recovery.register_rate_limit()
                                if recovery["recoverable"]:
                                    with lock:
                                        ledger.queue([key])
                                        checkpoint(force=True, event="rate_limit_cooldown")
                                    print(
                                        "BODY_RATE_LIMIT cooldown "
                                        f"attempt={recovery['attempt']}/{recovery['maxRetries']} "
                                        f"wait={recovery['waitSeconds']:.1f}s note={key}",
                                        flush=True,
                                    )
                                    try:
                                        recycle_page("rate_limit_cooldown")
                                    except Exception as recycle_error:  # noqa: BLE001
                                        print(
                                            f"PARALLEL_WORKER {worker_id} rate-limit recycle failed: {recycle_error}",
                                            flush=True,
                                        )
                                    work.put(card)
                                    work.task_done()
                                    continue
                                with lock:
                                    stop_reason = "rate_limited"
                                    stop_event.set()
                                    security_gate.set()
                                    checkpoint(force=True)
                                print(
                                    "BODY_RATE_LIMIT exhausted "
                                    f"attempts={recovery['attempt']}/{recovery['maxRetries']}",
                                    flush=True,
                                )
                                print(
                                    "RATE_LIMIT detected; stopping new collection and preserving checkpoint",
                                    flush=True,
                                )
                                work.task_done()
                                break
                            if contains_security_verification(challenge_text):
                                finish_request(
                                    key,
                                    request_id,
                                    payload,
                                    "blocked",
                                    stop_reason_value="security_verification",
                                    recoverable=True,
                                )
                                owns_verification = False
                                with lock:
                                    last_failures[key] = payload
                                    if security_owner_id is None and not stop_event.is_set():
                                        security_owner_id = worker_id
                                        owns_verification = True
                                        if not security_detected_at:
                                            security_detected_at = utc_now()
                                        security_status = "waiting"
                                        security_gate.clear()
                                if not owns_verification:
                                    print(
                                        f"SECURITY_VERIFICATION worker={worker_id} paused; verifier={security_owner_id}",
                                        flush=True,
                                    )
                                    work.put(card)
                                    work.task_done()
                                    continue
                                print(
                                    "SECURITY_VERIFICATION detected "
                                    f"timeout={security_verification_timeout_seconds}s; "
                                    "new collection paused while waiting for manual completion",
                                    flush=True,
                                )
                                deadline = time.monotonic() + security_verification_timeout_seconds
                                cleared = False
                                while time.monotonic() < deadline and not stop_event.is_set():
                                    time.sleep(min(5, max(0.1, deadline - time.monotonic())))
                                    try:
                                        visible_text = page.locator("body").inner_text(timeout=3000)
                                    except Exception:  # noqa: BLE001
                                        visible_text = challenge_text
                                    if not contains_security_verification(visible_text):
                                        cleared = True
                                        break
                                if cleared:
                                    with lock:
                                        security_status = "cleared"
                                        security_owner_id = None
                                        security_gate.set()
                                    print("SECURITY_VERIFICATION cleared; resuming collection", flush=True)
                                    work.put(card)
                                    work.task_done()
                                    continue
                                with lock:
                                    security_status = "timed_out"
                                    stop_reason = "security_verification_timeout"
                                    ledger.annotate_terminal(
                                        key,
                                        failure_code="detail_security_verification",
                                        recoverable=True,
                                        stop_reason="security_verification_timeout",
                                    )
                                    stop_event.set()
                                    security_gate.set()
                                    checkpoint(force=True)
                                print(
                                    "SECURITY_VERIFICATION timed_out; stopping new collection and preserving checkpoint",
                                    flush=True,
                                )
                                work.task_done()
                                break
                        payload_complete = record_is_complete(payload)
                        if payload_complete:
                            finish_request(
                                key,
                                request_id,
                                payload,
                                "succeeded",
                                stop_reason_value="",
                                recoverable=False,
                            )
                            if rate_limit_recovery.observe_success():
                                print(
                                    "BODY_RATE_LIMIT cleared "
                                    f"stable_successes={rate_limit_recovery.stable_successes}",
                                    flush=True,
                                )
                        else:
                            failure_code = str(payload.get("access_status") or "missing_record")
                            finish_request(
                                key,
                                request_id,
                                payload,
                                "failed",
                                stop_reason_value=(
                                    "request_timeout" if "timeout" in failure_code else "request_failed"
                                ),
                                recoverable=True,
                            )
                        pacer.observe(payload_complete)
                        with lock:
                            attempted_keys.add(key)
                            round_progress[round_number] = round_progress.get(round_number, 0) + 1
                            if payload_complete:
                                complete_by_key[key] = payload
                                last_failures.pop(key, None)
                                successful_since_checkpoint += 1
                                checkpoint()
                            else:
                                last_failures[key] = payload
                            processed_count = processed_attempt_count(card_keys, attempted_keys)
                            complete_count = len(complete_by_key)
                            round_processed = round_progress[round_number]
                        print(
                            "PARALLEL_PROGRESS "
                            f"processed={processed_count} total={len(cards)} complete={complete_count} "
                            f"status={payload.get('access_status') or 'missing_record'} "
                            f"round={round_number} round_processed={round_processed} round_total={round_total}",
                            flush=True,
                        )
                        page_uses += 1
                        retry_page_is_unhealthy = should_retry_on_fresh_page(payload)
                        recycle_failed_page = not payload_complete and (
                            not recycled_for_retry or retry_page_is_unhealthy
                        )
                        if page_uses >= page_recycle_every or recycle_failed_page:
                            recycle_page("scheduled" if page_uses >= page_recycle_every else "failed_record")
                        work.task_done()
                        if stop_event.is_set():
                            break
                        pause_seconds = 0.0
                        proactive_pause_seconds = 0.0
                        with lock:
                            more_in_round = round_progress.get(round_number, 0) < round_total
                            if body_batch_size > 0:
                                body_requests_since_pause += 1
                                if body_requests_since_pause >= body_batch_size:
                                    body_requests_since_pause = 0
                                    if more_in_round:
                                        pause_scale = pacer.healthy_batch_pause_scale()
                                        pause_seconds = random.uniform(
                                            body_batch_pause_min_seconds,
                                            body_batch_pause_max_seconds,
                                        ) * pause_scale
                            if more_in_round and proactive_rest_every > 0:
                                body_requests_since_proactive_rest += 1
                                if body_requests_since_proactive_rest >= proactive_rest_every:
                                    body_requests_since_proactive_rest = 0
                                    proactive_pause_seconds = proactive_rest_seconds
                        if pause_seconds > 0:
                            print(
                                "PARALLEL_BATCH_PAUSE "
                                f"size={body_batch_size} wait={pause_seconds:.1f}s "
                                f"scale={pacer.healthy_batch_pause_scale():.2f}",
                                flush=True,
                            )
                            if stop_event.wait(pause_seconds):
                                break
                        if proactive_pause_seconds > 0:
                            print(
                                "BODY_PROACTIVE_COOLDOWN "
                                f"every={proactive_rest_every} wait={proactive_pause_seconds:.1f}s",
                                flush=True,
                            )
                            if stop_event.wait(proactive_pause_seconds):
                                break
                        delay = max(
                            next_body_delay() if more_in_round else 0.0,
                            rate_limit_recovery.next_spacing() if more_in_round else 0.0,
                        )
                        adaptive_state = pacer.snapshot()
                        if adaptive_state["enabled"] and adaptive_state["failureLevel"] > 0:
                            print(
                                "PARALLEL_ADAPTIVE_PACING "
                                f"level={adaptive_state['failureLevel']} wait={delay:.1f}s",
                                flush=True,
                            )
                        if delay > 0 and stop_event.wait(delay):
                            break
                finally:
                    try:
                        page.close()
                    except Exception:  # noqa: BLE001
                        pass
        except Exception as error:  # noqa: BLE001
            print(f"PARALLEL_WORKER {worker_id} failed: {error}", flush=True)

    workers = max(1, min(int(workers), 8))
    attempts = max(1, min(int(attempts), 5))
    page_recovery_delay_seconds = max(0.0, float(page_recovery_delay_seconds))
    body_batch_size = max(0, int(body_batch_size))
    body_batch_pause_min_seconds = max(0.0, float(body_batch_pause_min_seconds))
    body_batch_pause_max_seconds = max(
        body_batch_pause_min_seconds,
        float(body_batch_pause_max_seconds),
    )
    proactive_rest_every = max(0, int(proactive_rest_every))
    proactive_rest_seconds = max(0.0, float(proactive_rest_seconds))
    adaptive_max_delay_seconds = max(0.0, float(adaptive_max_delay_seconds))
    rate_limit_initial_delay_seconds = max(0.0, float(rate_limit_initial_delay_seconds))
    rate_limit_max_delay_seconds = max(
        rate_limit_initial_delay_seconds,
        float(rate_limit_max_delay_seconds),
    )
    rate_limit_max_retries = max(0, min(int(rate_limit_max_retries), 20))
    rate_limit_recovery_spacing_seconds = max(0.0, float(rate_limit_recovery_spacing_seconds))
    rate_limit_max_recovery_spacing_seconds = max(
        rate_limit_recovery_spacing_seconds,
        float(rate_limit_max_recovery_spacing_seconds),
    )
    rate_limit_stable_successes = max(1, min(int(rate_limit_stable_successes), 20))
    security_verification_timeout_seconds = max(5, min(int(security_verification_timeout_seconds), 3600))
    started_at = utc_now()
    checkpoint(force=True, event="discovered")
    attempt_numbers = range(0) if cache_only else range(1, attempts + 1)
    for attempt in attempt_numbers:
        if stop_event.is_set():
            break
        pending = sorted(
            (
                card for card in cards
                if record_key(card) not in complete_by_key and ledger.can_resume(record_key(card))
            ),
            key=lambda card: pending_retry_priority(card, ledger_records),
        )
        if not pending:
            break
        ledger.queue(record_key(card) for card in pending)
        notify_progress(event="queued")
        if upstream is None:
            try:
                upstream = load_upstream(upstream_scraper)
            except BaseException:
                ledger.finalize_pending("task_interrupted")
                notify_progress(event="interrupted", status="failed")
                raise
        print(
            f"PARALLEL_ROUND {attempt}/{attempts} pending={len(pending)} workers={workers}",
            flush=True,
        )
        work: queue.Queue[dict[str, Any]] = queue.Queue()
        for card in pending:
            work.put(card)
        threads = [
            threading.Thread(
                target=run_worker,
                args=(worker_id, work, attempt, len(pending)),
                daemon=True,
            )
            for worker_id in range(1, workers + 1)
        ]
        for thread in threads:
            thread.start()
            time.sleep(0.75)
        for thread in threads:
            thread.join()
        if checkpoint_error is not None:
            ledger.finalize_pending("task_interrupted")
            raise checkpoint_error
        checkpoint(force=True)
        if stop_event.is_set():
            break

    records = ordered_complete()
    write_csv(records, csv_path)
    missing = [key for key in card_keys if key not in complete_by_key]
    if missing and not stop_reason:
        stop_reason = "cache_only" if cache_only else "attempt_limit_reached"
    ledger.finalize_pending(stop_reason or "completed")
    ledger_payload = ledger.snapshot()
    ledger_counts = ledger_payload["summary"]
    failure_payload = (
        [last_failures[key] for key in missing if key in last_failures]
        if cache_only
        else [last_failures.get(key, {"note_id": key, "access_status": "missing_record"}) for key in missing]
    )
    if failure_payload:
        atomic_json(failures_path, failure_payload)
    else:
        failures_path.unlink(missing_ok=True)
    status_counts: dict[str, int] = {}
    for failure in failure_payload:
        status = str(failure.get("access_status") or "missing_record")
        status_counts[status] = status_counts.get(status, 0) + 1
    rate_limit_state = rate_limit_recovery.snapshot()
    summary = {
        "schemaVersion": 2,
        "startedAt": started_at,
        "finishedAt": utc_now(),
        "cards": len(cards),
        "sourceCards": source_card_count,
        "completeBodies": len(records),
        "missingBodies": len(missing),
        "bodyAttempted": ledger_counts["attemptedCount"],
        "bodySucceeded": ledger_counts["succeededCount"],
        "bodyFailed": ledger_counts["failedCount"],
        "bodyNotAttempted": ledger_counts["notAttemptedCount"],
        "bodyBlocked": ledger_counts["blockedCount"],
        "bodyCancelled": ledger_counts["cancelledCount"],
        "statisticsSource": ledger_payload["statisticsSource"],
        "legacyInferred": ledger_payload["legacyInferred"],
        "bodyMetrics": ledger_payload["bodyMetrics"],
        "bodyCompletionLedger": {
            "schemaVersion": ledger_payload["schemaVersion"],
            "artifact": LEDGER_FILENAME,
            "summary": ledger_counts,
            "shadowComparison": ledger_payload["shadowComparison"],
        },
        "workers": workers,
        "pacing": {
            "mode": speed_mode,
            "noteDelaySeconds": note_delay_seconds,
            "randomDelayMinSeconds": random_delay_min_seconds,
            "randomDelayMaxSeconds": random_delay_max_seconds,
            "pageRecoveryDelaySeconds": page_recovery_delay_seconds,
            "bodyBatchSize": body_batch_size,
            "bodyBatchPauseMinSeconds": body_batch_pause_min_seconds,
            "bodyBatchPauseMaxSeconds": body_batch_pause_max_seconds,
            "proactiveRestEvery": proactive_rest_every,
            "proactiveRestSeconds": proactive_rest_seconds,
            "adaptive": pacer.snapshot(),
            "blockHeavyResources": bool(block_heavy_resources),
            "rateLimitRecovery": rate_limit_state,
        },
        "bodyCache": body_cache_stats,
        "scope": {
            "maxAgeDays": max_age_days,
            "sourceCards": source_card_count,
            "eligibleCards": len(cards),
            "excludedOlderCards": len(out_of_scope_cards),
            "unknownDateCards": unknown_date_count,
            "referenceTime": scope_reference.isoformat(timespec="seconds"),
            "outOfScopeArtifact": out_of_scope_path.name if max_age_days > 0 else "",
        },
        "attempts": attempts,
        "failureStatuses": status_counts,
        "collectionStatus": "partial" if missing else "completed",
        "partial": bool(missing),
        "workersExited": True,
        "queueConsumptionStopped": stop_event.is_set(),
        "readyForPartialAnalysis": bool(missing and stop_reason and not cache_only),
        "transitionedToAnalysis": False,
        "newAccessStopped": stop_reason in {"security_verification_timeout", "rate_limited"},
        "stopReason": stop_reason,
        "rateLimit": {
            "detectedAt": rate_limit_detected_at,
            "status": (
                "stopped" if stop_reason == "rate_limited"
                else "cleared" if rate_limit_state["detectedCount"] > 0
                else "not_detected"
            ),
            "recoveryAction": "wait_then_resume" if stop_reason == "rate_limited" else "",
            **rate_limit_state,
        },
        "securityVerification": {
            "detectedAt": security_detected_at,
            "timeoutSeconds": security_verification_timeout_seconds,
            "status": security_status,
            "recoveryAction": "manual_verification_then_resume" if security_status == "timed_out" else "",
        },
        "passed": not missing,
    }
    atomic_json(summary_path, summary)
    notify_progress(
        event="completed",
        status="completed" if not missing else "partial" if cache_only else "blocked" if stop_reason else "partial",
        summary=summary,
    )
    print(
        f"PARALLEL_COMPLETE cards={len(cards)} bodies={len(records)} missing={len(missing)}",
        flush=True,
    )
    return summary


def parse_args(arguments: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Complete Xiaohongshu note bodies with isolated relay pages.")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--relay-port", type=int, default=18792)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--goto-timeout-ms", type=int, default=15000)
    parser.add_argument("--checkpoint-every", type=int, default=10)
    parser.add_argument("--page-recycle-every", type=int, default=20)
    parser.add_argument("--page-recovery-delay-seconds", type=float, default=0)
    parser.add_argument("--body-batch-size", type=int, default=0)
    parser.add_argument("--body-batch-pause-min-seconds", type=float, default=0)
    parser.add_argument("--body-batch-pause-max-seconds", type=float, default=0)
    parser.add_argument("--proactive-rest-every", type=int, default=0)
    parser.add_argument("--proactive-rest-seconds", type=float, default=0)
    parser.add_argument("--adaptive-pacing", action="store_true")
    parser.add_argument("--adaptive-max-delay-seconds", type=float, default=20)
    parser.add_argument("--block-heavy-resources", action="store_true")
    parser.add_argument(
        "--rate-limit-auto-recovery",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--rate-limit-initial-delay-seconds", type=float, default=120)
    parser.add_argument("--rate-limit-max-delay-seconds", type=float, default=900)
    parser.add_argument("--rate-limit-max-retries", type=int, default=6)
    parser.add_argument("--rate-limit-recovery-spacing-seconds", type=float, default=30)
    parser.add_argument("--rate-limit-max-recovery-spacing-seconds", type=float, default=120)
    parser.add_argument("--rate-limit-stable-successes", type=int, default=3)
    parser.add_argument("--security-verification-timeout-seconds", type=int, default=600)
    parser.add_argument("--speed-mode", choices=("steady", "random"), default="random")
    parser.add_argument("--note-delay-seconds", type=float, default=1.2)
    parser.add_argument("--random-delay-min-seconds", type=float, default=0.8)
    parser.add_argument("--random-delay-max-seconds", type=float, default=2.4)
    parser.add_argument(
        "--reuse-body-cache",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--body-cache-max-age-days", type=int, default=30)
    parser.add_argument("--max-age-days", type=int, default=0)
    parser.add_argument("--cache-only", action="store_true")
    parser.add_argument("--upstream-scraper", default=str(DEFAULT_UPSTREAM_SCRAPER))
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--resume-scope", choices=("full", "body_completion"))
    parser.add_argument("--attempt-id")
    parser.add_argument("--state-path")
    parser.add_argument("--expected-state-revision", type=int)
    return parser.parse_args(arguments)


def main(arguments: list[str] | None = None) -> int:
    args = parse_args(arguments)
    output_dir = Path(args.output_dir).resolve()
    state = open_workflow_state_from_args(args, output_dir)
    if state is not None:
        if not state.should_run("bodyCompletion"):
            summary_path = output_dir / "parallel-body-summary.json"
            try:
                summary = json.loads(summary_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                summary = {}
            return 0 if summary.get("passed", True) else 3
        state.start_stage("bodyCompletion")

    def update_state(progress: dict[str, Any]) -> None:
        if state is None:
            return
        state.checkpoint_body(
            cards=progress["cards"],
            complete_records=progress["completeRecords"],
            failures=progress["failures"],
            attempted_ids=set(progress["attemptedIds"]),
            ledger=progress.get("ledger"),
            summary=progress.get("summary"),
            status=str(progress.get("status") or "running"),
        )

    try:
        summary = complete_bodies(
            output_dir,
            relay_port=args.relay_port,
            workers=args.workers,
            attempts=args.attempts,
            goto_timeout_ms=args.goto_timeout_ms,
            checkpoint_every=args.checkpoint_every,
            page_recycle_every=max(1, args.page_recycle_every),
            page_recovery_delay_seconds=args.page_recovery_delay_seconds,
            body_batch_size=args.body_batch_size,
            body_batch_pause_min_seconds=args.body_batch_pause_min_seconds,
            body_batch_pause_max_seconds=args.body_batch_pause_max_seconds,
            proactive_rest_every=args.proactive_rest_every,
            proactive_rest_seconds=args.proactive_rest_seconds,
            adaptive_pacing=args.adaptive_pacing,
            adaptive_max_delay_seconds=args.adaptive_max_delay_seconds,
            block_heavy_resources=args.block_heavy_resources,
            rate_limit_auto_recovery=args.rate_limit_auto_recovery,
            rate_limit_initial_delay_seconds=args.rate_limit_initial_delay_seconds,
            rate_limit_max_delay_seconds=args.rate_limit_max_delay_seconds,
            rate_limit_max_retries=args.rate_limit_max_retries,
            rate_limit_recovery_spacing_seconds=args.rate_limit_recovery_spacing_seconds,
            rate_limit_max_recovery_spacing_seconds=args.rate_limit_max_recovery_spacing_seconds,
            rate_limit_stable_successes=args.rate_limit_stable_successes,
            security_verification_timeout_seconds=args.security_verification_timeout_seconds,
            speed_mode=args.speed_mode,
            note_delay_seconds=args.note_delay_seconds,
            random_delay_min_seconds=args.random_delay_min_seconds,
            random_delay_max_seconds=args.random_delay_max_seconds,
            reuse_body_cache=args.reuse_body_cache,
            body_cache_max_age_days=args.body_cache_max_age_days,
            max_age_days=args.max_age_days,
            cache_only=args.cache_only,
            upstream_scraper=Path(args.upstream_scraper),
            progress_callback=update_state,
        )
    except BaseException as error:
        if isinstance(error, KeyboardInterrupt):
            try:
                cards = load_json_list(output_dir / "xiaohongshu_cards_latest.json")
                BodyCompletionLedger.open(
                    output_dir,
                    cards,
                    recover_interrupted=False,
                ).finalize_pending("user_cancelled")
            except BaseException:
                pass
        if state is not None:
            try:
                state.finish_stage("bodyCompletion", "cancelled" if isinstance(error, KeyboardInterrupt) else "failed", {
                    "failureCode": "user_cancelled" if isinstance(error, KeyboardInterrupt) else type(error).__name__,
                    "failureMessage": str(error)[:1000],
                })
            except BaseException:
                pass
        raise
    if state is not None:
        status = "completed" if summary["passed"] else "blocked" if summary.get("stopReason") else "partial"
        state.finish_stage("bodyCompletion", status, {"stopReason": summary.get("stopReason") or ""})
    return 0 if summary["passed"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
