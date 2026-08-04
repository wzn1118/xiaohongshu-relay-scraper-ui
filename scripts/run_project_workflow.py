from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from application_intelligence_agents import run_pipeline, write_pipeline_artifacts
from artifact_io import atomic_write_json
from ai_application_workflow import (
    enrich_general_payload,
    enrich_payload,
    record_needs_completion,
    record_needs_content_completion,
)
from ai_provider_runtime import AIProvider
from audience_collection import collect_audience, normalize_audience_post_status
from expansion_collection import collect_expansion
from body_completion_ledger import BodyCompletionLedger, LEDGER_FILENAME, load_ledger
from note_identity import record_identity_keys, record_key as canonical_record_key
from parallel_body_completion import complete_bodies
from workflow_state import (
    WorkflowStateSession,
    analysis_source_hash,
    open_workflow_state_from_args,
    stable_hash,
)


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CANDIDATE_PROFILE = PROJECT_ROOT / "profiles/candidate_profile.json"


def resolve_upstream_runner(explicit: str = "") -> Path:
    candidates = [
        Path(explicit) if explicit else None,
        Path(os.environ["XHS_UPSTREAM_RUNNER"]) if os.environ.get("XHS_UPSTREAM_RUNNER") else None,
        PROJECT_ROOT / "vendor/xiaohongshu-relay-scrape/scripts/run_xiaohongshu_relay_scrape.py",
        Path(os.environ["CODEX_HOME"]) / "skills/xiaohongshu-relay-scrape/scripts/run_xiaohongshu_relay_scrape.py"
        if os.environ.get("CODEX_HOME")
        else None,
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError(
        "Could not locate the upstream Xiaohongshu relay runner. Set XHS_UPSTREAM_RUNNER "
        "or install the xiaohongshu-relay-scrape skill under CODEX_HOME."
    )


def resolve_upstream_scraper(upstream_runner: Path) -> Path:
    candidates = [
        Path(os.environ["XHS_UPSTREAM_SCRAPER"]) if os.environ.get("XHS_UPSTREAM_SCRAPER") else None,
        upstream_runner.parent / "scrape_xiaohongshu_search.py",
        PROJECT_ROOT / "vendor/xiaohongshu-relay-scrape/scripts/scrape_xiaohongshu_search.py",
        Path(os.environ["CODEX_HOME"]) / "skills/xiaohongshu-relay-scrape/scripts/scrape_xiaohongshu_search.py"
        if os.environ.get("CODEX_HOME")
        else None,
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return candidate.resolve()
    return upstream_runner.parent / "scrape_xiaohongshu_search.py"


def rewrite_unlimited_args(arguments: list[str]) -> list[str]:
    rewritten: list[str] = []
    skip_next = False
    for argument in arguments:
        if skip_next:
            skip_next = False
            continue
        if argument == "--limit":
            skip_next = True
            continue
        if argument.startswith("--limit="):
            continue
        rewritten.append(argument)
    return rewritten + ["--limit", "0"]


def rewrite_limit(arguments: list[str], limit: int) -> list[str]:
    """Keep the historical argument helper available to integrations and tests."""
    rewritten = rewrite_unlimited_args(arguments)
    return rewritten[:-2] + ["--limit", str(limit)]


def option_value(arguments: list[str], name: str) -> str:
    for index, argument in enumerate(arguments):
        if argument == name and index + 1 < len(arguments):
            return arguments[index + 1]
        if argument.startswith(f"{name}="):
            return argument.split("=", 1)[1]
    return ""


def parse_wrapper_args(arguments: list[str]) -> tuple[argparse.Namespace, list[str]]:
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("--analysis-mode", choices=("job", "general"), default="job")
    parser.add_argument(
        "--content-preset",
        choices=("auto", "experience", "people", "trend", "product", "place", "custom"),
        default="auto",
    )
    parser.add_argument("--content-goal", default="")
    parser.add_argument("--candidate-profile", default=str(DEFAULT_CANDIDATE_PROFILE))
    parser.add_argument("--analyze-checkpoint", action="store_true")
    parser.add_argument("--complete-missing-only", action="store_true")
    parser.add_argument("--body-only", action="store_true")
    parser.add_argument("--collect-audience", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--audience-only", action="store_true")
    parser.add_argument("--discover-more", action="store_true")
    parser.add_argument("--expansion-config-json", default="")
    parser.add_argument("--upstream-runner", default="")
    parser.add_argument("--security-verification-timeout-seconds", type=int, default=600)
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
        default=False,
    )
    parser.add_argument("--rate-limit-initial-delay-seconds", type=float, default=120)
    parser.add_argument("--rate-limit-max-delay-seconds", type=float, default=900)
    parser.add_argument("--rate-limit-max-retries", type=int, default=6)
    parser.add_argument("--rate-limit-recovery-spacing-seconds", type=float, default=30)
    parser.add_argument("--rate-limit-max-recovery-spacing-seconds", type=float, default=120)
    parser.add_argument("--rate-limit-stable-successes", type=int, default=3)
    parser.add_argument(
        "--reuse-body-cache",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--body-cache-max-age-days", type=int, default=30)
    parser.add_argument("--codex-runtime", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--codex-cli-bin", default="")
    parser.add_argument("--codex-batch-size", type=int, default=8)
    parser.add_argument("--codex-timeout-seconds", type=int, default=300)
    parser.add_argument("--cover-letter-threshold", type=int, default=90)
    parser.add_argument("--cover-letter-max-attempts", type=int, default=4)
    parser.add_argument(
        "--resume-scope",
        choices=("full", "discovery", "body_completion", "analysis", "audience", "artifacts"),
    )
    parser.add_argument("--attempt-id")
    parser.add_argument("--resume-checkpoint-dir", action="append", default=[])
    parser.add_argument("--state-path")
    parser.add_argument("--expected-state-revision", type=int)
    return parser.parse_known_args(arguments)


def build_ai_provider(wrapper: argparse.Namespace) -> AIProvider:
    return AIProvider(
        timeout=wrapper.codex_timeout_seconds,
        total_timeout=wrapper.codex_timeout_seconds,
    )


def expansion_config(wrapper: argparse.Namespace) -> dict[str, Any] | None:
    if not wrapper.expansion_config_json:
        return None
    try:
        value = json.loads(wrapper.expansion_config_json)
    except json.JSONDecodeError as error:
        raise ValueError("--expansion-config-json must be valid JSON") from error
    if not isinstance(value, dict):
        raise ValueError("--expansion-config-json must contain an object")
    return value if value.get("enabled") is True else None


def collect_configured_audience(
    wrapper: argparse.Namespace,
    output_dir: Path,
    arguments: list[str],
    upstream_scraper: Path,
    *,
    progress_callback: Any = None,
) -> dict[str, Any]:
    common = {
        "checkpoint_dirs": wrapper.resume_checkpoint_dir,
        "attempt_id": wrapper.attempt_id or "",
        "relay_port": int(option_value(arguments, "--relay-port") or 18800),
        "goto_timeout_ms": int(option_value(arguments, "--goto-timeout-ms") or 15000),
        "note_delay_seconds": float(option_value(arguments, "--note-delay-seconds") or 1.2),
        "stable_rounds": int(option_value(arguments, "--stable-rounds") or 5),
        "upstream_scraper": upstream_scraper,
        "progress_callback": progress_callback,
    }
    configured_expansion = expansion_config(wrapper)
    if configured_expansion is not None:
        return collect_expansion(
            output_dir,
            config=configured_expansion,
            keyword=option_value(arguments, "--keyword"),
            **common,
        )
    return collect_audience(
        output_dir,
        security_verification_timeout_seconds=wrapper.security_verification_timeout_seconds,
        **common,
    )


def add_flag_once(arguments: list[str], flag: str) -> list[str]:
    return list(arguments) if flag in arguments else [*arguments, flag]


def add_option_once(arguments: list[str], name: str, value: str) -> list[str]:
    if option_value(arguments, name):
        return list(arguments)
    return [*arguments, name, value]


def replace_option(arguments: list[str], name: str, value: str) -> list[str]:
    rewritten: list[str] = []
    skip_next = False
    for argument in arguments:
        if skip_next:
            skip_next = False
            continue
        if argument == name:
            skip_next = True
            continue
        if argument.startswith(f"{name}="):
            continue
        rewritten.append(argument)
    return [*rewritten, name, value]


def replace_collection_mode(arguments: list[str], mode: str) -> list[str]:
    if mode not in {"--fresh", "--resume"}:
        raise ValueError("collection mode must be --fresh or --resume")
    return [argument for argument in arguments if argument not in {"--fresh", "--resume"}] + [mode]


def resolve_project_path(value: str) -> Path:
    candidate = Path(value)
    return (candidate if candidate.is_absolute() else PROJECT_ROOT / candidate).resolve()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def atomic_json(path: Path, payload: Any) -> None:
    atomic_write_json(path, payload)


def can_complete_from_checkpoint(output_dir: Path, complete_missing_only: bool) -> bool:
    return complete_missing_only and all(
        (output_dir / filename).is_file()
        for filename in ("xiaohongshu_cards_latest.json", "xiaohongshu_notes_latest.json")
    )


def _body_metrics_from_counts(
    *,
    discovered: int,
    attempted: int,
    succeeded: int,
    failed: int,
    not_attempted: int,
    blocked: int,
    cancelled: int,
    pending: int,
    statistics_source: str,
    status_counts: dict[str, Any] | None = None,
) -> dict[str, Any]:
    right = succeeded + failed + not_attempted + blocked + cancelled + pending
    return {
        "schemaVersion": 1,
        "statisticsSource": statistics_source,
        "legacyInferred": statistics_source == "legacyInferred",
        "discovered": discovered,
        "attempted": attempted,
        "succeeded": succeeded,
        "failed": failed,
        "notAttempted": not_attempted,
        "blocked": blocked,
        "cancelled": cancelled,
        "pending": pending,
        "completionRatePercent": round((succeeded / discovered) * 100, 2) if discovered else 100.0,
        "statusCounts": status_counts or {},
        "conservation": {
            "left": discovered,
            "right": right,
            "valid": discovered == right,
            "terminal": pending == 0 and discovered == right,
            "formula": (
                "discovered = succeeded + failed + not_attempted + blocked + "
                "cancelled + pending"
            ),
        },
    }


def canonical_body_metrics(
    body_summary: dict[str, Any],
    quality_gate: dict[str, Any],
) -> dict[str, Any]:
    formal = body_summary.get("bodyMetrics")
    if isinstance(formal, dict) and all(
        field in formal
        for field in (
            "discovered", "attempted", "succeeded", "failed",
            "notAttempted", "blocked", "cancelled", "pending",
        )
    ):
        source = str(formal.get("statisticsSource") or "bodyCompletionLedger")
        return {
            **formal,
            "statisticsSource": source,
            "legacyInferred": source == "legacyInferred",
        }

    ledger = body_summary.get("bodyCompletionLedger")
    ledger_summary = ledger.get("summary") if isinstance(ledger, dict) else None
    if isinstance(ledger_summary, dict):
        source = str(body_summary.get("statisticsSource") or "bodyCompletionLedger")
        return _body_metrics_from_counts(
            discovered=int(ledger_summary.get("discoveredCount") or 0),
            attempted=int(ledger_summary.get("attemptedCount") or 0),
            succeeded=int(ledger_summary.get("succeededCount") or 0),
            failed=int(ledger_summary.get("failedCount") or 0),
            not_attempted=int(ledger_summary.get("notAttemptedCount") or 0),
            blocked=int(ledger_summary.get("blockedCount") or 0),
            cancelled=int(ledger_summary.get("cancelledCount") or 0),
            pending=int(ledger_summary.get("pendingCount") or 0),
            statistics_source=source,
            status_counts=ledger_summary.get("statusCounts")
            if isinstance(ledger_summary.get("statusCounts"), dict) else None,
        )

    # Old jobs did not persist request-start events. Preserve their readability,
    # but expose the reconstruction explicitly instead of presenting it as exact.
    discovered = int(body_summary.get("cardsDiscovered", quality_gate["discovered_count"]) or 0)
    succeeded = int(body_summary.get("bodySucceeded", quality_gate["body_count"]) or 0)
    failed = int(body_summary.get("bodyFailed") or 0)
    blocked = int(body_summary.get("bodyBlocked") or 0)
    cancelled = int(body_summary.get("bodyCancelled") or 0)
    pending = int(body_summary.get("bodyPending") or 0)
    accounted = succeeded + failed + blocked + cancelled + pending
    not_attempted = int(body_summary["bodyNotAttempted"]) if "bodyNotAttempted" in body_summary else max(0, discovered - accounted)
    minimum_attempted = succeeded + failed + blocked + cancelled
    attempted = int(body_summary["bodyAttempted"]) if "bodyAttempted" in body_summary else minimum_attempted
    attempted = max(attempted, minimum_attempted)
    return _body_metrics_from_counts(
        discovered=discovered,
        attempted=attempted,
        succeeded=succeeded,
        failed=failed,
        not_attempted=not_attempted,
        blocked=blocked,
        cancelled=cancelled,
        pending=pending,
        statistics_source="legacyInferred",
    )


def checkpoint_body_summary(output_dir: Path, *, stop_reason: str) -> dict[str, Any]:
    def load_list(filename: str) -> list[dict[str, Any]]:
        try:
            payload = json.loads((output_dir / filename).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        return [item for item in payload if isinstance(item, dict)] if isinstance(payload, list) else []

    cards = load_list("xiaohongshu_cards_latest.json")
    notes = load_list("xiaohongshu_notes_latest.json")
    ledger = load_ledger(output_dir / LEDGER_FILENAME)
    if ledger is not None:
        counts = ledger["summary"]
        metrics = ledger["bodyMetrics"]
        return {
            "transitionedToAnalysis": True,
            "stopReason": stop_reason,
            "cardsDiscovered": counts["discoveredCount"],
            "bodyAttempted": counts["attemptedCount"],
            "bodySucceeded": counts["succeededCount"],
            "bodyFailed": counts["failedCount"],
            "bodyNotAttempted": counts["notAttemptedCount"],
            "bodyBlocked": counts["blockedCount"],
            "bodyCancelled": counts["cancelledCount"],
            "missingBodies": max(0, counts["discoveredCount"] - counts["succeededCount"]),
            "statisticsSource": ledger.get("statisticsSource", "bodyCompletionLedger"),
            "legacyInferred": bool(ledger.get("legacyInferred")),
            "bodyMetrics": metrics,
            "bodyCompletionLedger": ledger,
            "checkpointFallback": True,
        }
    completed = sum(
        1
        for note in notes
        if str(note.get("access_status") or "") == "detail_ok" and str(note.get("body") or "").strip()
    )
    legacy_summary = {
        "transitionedToAnalysis": True,
        "stopReason": stop_reason,
        "cardsDiscovered": len(cards),
        "bodyAttempted": completed,
        "bodySucceeded": completed,
        "bodyFailed": 0,
        "bodyNotAttempted": max(0, len(cards) - completed),
        "bodyBlocked": 0,
        "bodyCancelled": 0,
        "missingBodies": max(0, len(cards) - completed),
        "statisticsSource": "legacyInferred",
        "legacyInferred": True,
        "checkpointFallback": True,
    }
    legacy_summary["bodyMetrics"] = canonical_body_metrics(legacy_summary, {
        "discovered_count": len(cards),
        "body_count": completed,
    })
    return legacy_summary


def collect_body_checkpoint(
    output_dir: Path,
    *,
    scrape_failed: bool,
    checkpoint_fallback: bool,
    relay_port: int,
    goto_timeout_ms: int,
    security_verification_timeout_seconds: int,
    speed_mode: str,
    note_delay_seconds: float,
    random_delay_min_seconds: float,
    random_delay_max_seconds: float,
    upstream_scraper: Path,
    page_recovery_delay_seconds: float = 0,
    body_batch_size: int = 0,
    body_batch_pause_min_seconds: float = 0,
    body_batch_pause_max_seconds: float = 0,
    proactive_rest_every: int = 0,
    proactive_rest_seconds: float = 0,
    adaptive_pacing: bool = False,
    adaptive_max_delay_seconds: float = 20,
    block_heavy_resources: bool = False,
    rate_limit_auto_recovery: bool = False,
    rate_limit_initial_delay_seconds: float = 120,
    rate_limit_max_delay_seconds: float = 900,
    rate_limit_max_retries: int = 6,
    rate_limit_recovery_spacing_seconds: float = 30,
    rate_limit_max_recovery_spacing_seconds: float = 120,
    rate_limit_stable_successes: int = 3,
    reuse_body_cache: bool = True,
    body_cache_max_age_days: int = 30,
    max_age_days: int = 0,
    progress_callback: Any = None,
    attempt_id: str = "",
) -> dict[str, Any]:
    if scrape_failed and not checkpoint_fallback:
        return checkpoint_body_summary(output_dir, stop_reason="relay_connection_failed")
    return complete_bodies(
        output_dir,
        relay_port=relay_port,
        workers=1,
        attempts=3,
        goto_timeout_ms=goto_timeout_ms,
        security_verification_timeout_seconds=security_verification_timeout_seconds,
        speed_mode=speed_mode,
        note_delay_seconds=note_delay_seconds,
        random_delay_min_seconds=random_delay_min_seconds,
        random_delay_max_seconds=random_delay_max_seconds,
        page_recovery_delay_seconds=page_recovery_delay_seconds,
        body_batch_size=body_batch_size,
        body_batch_pause_min_seconds=body_batch_pause_min_seconds,
        body_batch_pause_max_seconds=body_batch_pause_max_seconds,
        proactive_rest_every=proactive_rest_every,
        proactive_rest_seconds=proactive_rest_seconds,
        adaptive_pacing=adaptive_pacing,
        adaptive_max_delay_seconds=adaptive_max_delay_seconds,
        block_heavy_resources=block_heavy_resources,
        rate_limit_auto_recovery=rate_limit_auto_recovery,
        rate_limit_initial_delay_seconds=rate_limit_initial_delay_seconds,
        rate_limit_max_delay_seconds=rate_limit_max_delay_seconds,
        rate_limit_max_retries=rate_limit_max_retries,
        rate_limit_recovery_spacing_seconds=rate_limit_recovery_spacing_seconds,
        rate_limit_max_recovery_spacing_seconds=rate_limit_max_recovery_spacing_seconds,
        rate_limit_stable_successes=rate_limit_stable_successes,
        reuse_body_cache=reuse_body_cache,
        body_cache_max_age_days=body_cache_max_age_days,
        max_age_days=max_age_days,
        upstream_scraper=upstream_scraper,
        progress_callback=progress_callback,
        attempt_id=attempt_id,
    )


def load_application_checkpoint(output_dir: Path) -> dict[str, Any] | None:
    for filename in ("application_intelligence.checkpoint.json", "application_intelligence.json"):
        path = output_dir / filename
        if not path.is_file():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict) and isinstance(payload.get("records"), list):
            return payload
    return None


def reuse_completed_records(
    payload: dict[str, Any],
    previous: dict[str, Any] | None,
    analysis_mode: str = "job",
) -> int:
    if not previous:
        return 0
    previous_by_id = {
        canonical_record_key(record): record
        for record in previous.get("records", [])
        if isinstance(record, dict) and canonical_record_key(record)
    }
    reused = 0
    records = payload.get("records", [])
    needs_completion = record_needs_content_completion if analysis_mode == "general" else record_needs_completion
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            continue
        prior = previous_by_id.get(canonical_record_key(record))
        if not prior:
            continue
        prior_analysis = prior.get("media", {}).get("analysis", {})
        current_media = record.setdefault("media", {})
        current_analysis = current_media.get("analysis", {})
        source_unchanged = analysis_source_hash(record) == analysis_source_hash(prior)
        prior_media_source = {
            key: value
            for key, value in prior.get("media", {}).items()
            if key != "analysis"
        }
        current_media_source = {
            key: value
            for key, value in current_media.items()
            if key != "analysis"
        }
        non_media_source_unchanged = analysis_source_hash({
            **record,
            "media": None,
        }) == analysis_source_hash({
            **prior,
            "media": None,
        })
        can_reuse_cached_media = (
            source_unchanged
            or (
                needs_completion(prior)
                and non_media_source_unchanged
                and (not prior_media_source or prior_media_source == current_media_source)
            )
        )
        if (
            can_reuse_cached_media
            and isinstance(prior_analysis, dict)
            and prior_analysis.get("status") == "analyzed"
            and str(prior_analysis.get("visible_text") or "").strip()
            and not str(current_analysis.get("visible_text") or "").strip()
        ):
            current_media["analysis"] = prior_analysis.copy()
        if not source_unchanged:
            continue
        if needs_completion(prior):
            continue
        records[index] = prior
        reused += 1
    return reused


def completion_target_ids(
    payload: dict[str, Any],
    previous: dict[str, Any] | None,
    analysis_mode: str = "job",
) -> set[str]:
    needs_completion = record_needs_content_completion if analysis_mode == "general" else record_needs_completion
    previous_records = {
        canonical_record_key(record): record
        for record in (previous or {}).get("records", [])
        if isinstance(record, dict) and canonical_record_key(record)
    }
    targets = {
        note_id
        for note_id, record in previous_records.items()
        if needs_completion(record)
    }
    for record in payload.get("records", []):
        if not isinstance(record, dict):
            continue
        note_id = canonical_record_key(record)
        if not note_id:
            continue
        prior = previous_records.get(note_id)
        if (
            prior is None
            or analysis_source_hash(record) != analysis_source_hash(prior)
            or (needs_completion(record) and needs_completion(prior))
        ):
            targets.add(note_id)
    return targets


def merge_and_persist_analysis(
    output_dir: Path,
    payload: dict[str, Any],
    previous: dict[str, Any] | None,
    analysis_mode: str,
    *,
    only_incomplete: bool,
) -> tuple[set[str] | None, int]:
    target_note_ids: set[str] | None = None
    reused = 0
    if only_incomplete:
        reused = reuse_completed_records(payload, previous, analysis_mode)
        target_note_ids = completion_target_ids(payload, previous, analysis_mode)
    write_pipeline_artifacts(output_dir, payload)
    return target_note_ids, reused


def body_collection_deferred_reason(body_summary: dict[str, Any] | None) -> str:
    if not isinstance(body_summary, dict):
        return ""
    try:
        missing_bodies = max(0, int(body_summary.get("missingBodies") or 0))
    except (TypeError, ValueError):
        missing_bodies = 0
    if missing_bodies == 0:
        return ""

    stop_reason = str(body_summary.get("stopReason") or "").strip()
    if stop_reason:
        return stop_reason
    rate_limit = body_summary.get("rateLimit")
    if isinstance(rate_limit, dict) and rate_limit.get("status") == "stopped":
        return "rate_limited"
    security_verification = body_summary.get("securityVerification")
    if isinstance(security_verification, dict) and security_verification.get("status") == "timed_out":
        return "security_verification_timeout"
    return "missing_bodies"


def mark_ai_deferred(payload: dict[str, Any], body_summary: dict[str, Any] | None) -> str:
    reason = body_collection_deferred_reason(body_summary)
    if not reason:
        return ""
    runtime = payload.get("codex_runtime")
    if not isinstance(runtime, dict):
        runtime = {}
    payload["codex_runtime"] = {
        **runtime,
        "status": "deferred_missing_bodies",
        "reason": reason,
        "missing_bodies": int((body_summary or {}).get("missingBodies") or 0),
    }
    return reason


def partition_job_ai_targets(
    payload: dict[str, Any],
    requested_target_ids: set[str] | None,
    body_summary: dict[str, Any] | None,
) -> tuple[set[str] | None, str, int, bool]:
    records = [record for record in payload.get("records", []) if isinstance(record, dict)]
    gate = payload.get("quality_gate") if isinstance(payload.get("quality_gate"), dict) else {}
    body_metrics = canonical_body_metrics(body_summary or {}, gate)

    desired_records = (
        records
        if requested_target_ids is None
        else [record for record in records if canonical_record_key(record) in requested_target_ids]
    )
    ready_records = [record for record in desired_records if str(record.get("body") or "").strip()]
    ready_target_ids = {
        canonical_record_key(record)
        for record in ready_records
        if canonical_record_key(record)
    }
    full_body_count = sum(1 for record in records if str(record.get("body") or "").strip())
    contract = payload.get("publication_contract") if isinstance(payload.get("publication_contract"), dict) else {}
    target_count = max(
        len(records),
        int(body_metrics.get("discovered") or 0),
        int(gate.get("discovered_count") or 0),
        int(contract.get("candidate_count") or 0),
    )
    ready_count = min(target_count, full_body_count)
    pending_count = max(0, target_count - ready_count)
    reason = body_collection_deferred_reason(body_summary) if pending_count else ""
    if pending_count and not reason:
        reason = "missing_bodies"
    fully_deferred = pending_count > 0 and not ready_records
    payload["source_coverage"] = {
        "status": "partial" if pending_count else "complete",
        "reason": reason,
        "targetCount": target_count,
        "readyCount": ready_count,
        "pendingCount": pending_count,
        "totalRecordCount": len(records),
        "fullBodyCount": full_body_count,
        "statisticsSource": body_metrics.get("statisticsSource") or "qualityGate",
    }
    if fully_deferred:
        mark_ai_deferred(payload, body_summary)

    if requested_target_ids is None and pending_count == 0:
        return None, reason, pending_count, fully_deferred
    return ready_target_ids, reason, pending_count, fully_deferred


def build_workflow_summary(payload: dict[str, Any], body_summary: dict[str, Any] | None = None) -> dict[str, Any]:
    gate = payload["quality_gate"]
    records = payload["records"]
    body_summary = body_summary or {}
    body_metrics = canonical_body_metrics(body_summary, gate)
    time_normalized = sum(1 for record in records if record["publish_time"]["value"])
    exact_time = sum(
        1
        for record in records
        if record["publish_time"]["value"]
        and not record["publish_time"]["is_estimated"]
        and record["publish_time"]["precision"] in {"day", "minute"}
    )
    estimated_time = sum(1 for record in records if record["publish_time"]["is_estimated"])
    contacts = sum(len(record["application_info"]["contacts"]) for record in records)
    routes = sum(len(record["application_info"]["application_routes"]) for record in records)
    responsibilities = sum(len(record["application_info"]["responsibilities"]) for record in records)
    requirements = sum(len(record["application_info"]["requirements"]) for record in records)
    greetings = sum(1 for record in records if record["outreach"]["greeting"])
    emails = sum(1 for record in records if record["outreach"]["email_body"])
    cover_letters = sum(1 for record in records if record["outreach"].get("cover_letter"))
    job_cards = sum(1 for record in records if isinstance(record.get("job_card"), dict))
    application_copy = sum(
        1
        for record in records
        if all(
            str(record.get("outreach", {}).get(field) or "").strip()
            for field in ("greeting", "email_subject", "email_body", "cover_letter")
        )
    )
    runtime = payload.get("codex_runtime", {})
    task_mode = "general" if payload.get("analysis_mode") == "general" else "job"
    ai_deferred = runtime.get("status") == "deferred_missing_bodies"
    stored_source_coverage = payload.get("source_coverage")
    if isinstance(stored_source_coverage, dict):
        source_coverage = dict(stored_source_coverage)
    else:
        full_body_count = sum(1 for record in records if str(record.get("body") or "").strip())
        pending_count = max(0, len(records) - full_body_count)
        source_coverage = {
            "status": "partial" if pending_count else "complete",
            "reason": body_collection_deferred_reason(body_summary) if pending_count else "",
            "targetCount": len(records),
            "readyCount": full_body_count,
            "pendingCount": pending_count,
            "totalRecordCount": len(records),
            "fullBodyCount": full_body_count,
        }
    source_pending_count = max(0, int(source_coverage.get("pendingCount") or 0))
    source_pending = source_pending_count > 0
    partial_analysis = bool(
        body_summary.get("transitionedToAnalysis")
        or int(body_summary.get("missingBodies") or 0) > 0
        or source_pending
    )
    collection_stop_reason = str(body_summary.get("stopReason") or "")
    security_verification = body_summary.get("securityVerification")
    if not isinstance(security_verification, dict):
        security_verification = {}
    security_timeout = (
        collection_stop_reason == "security_verification_timeout"
        or security_verification.get("status") == "timed_out"
    )
    rate_limit = body_summary.get("rateLimit")
    if not isinstance(rate_limit, dict):
        rate_limit = {}
    rate_limited = collection_stop_reason == "rate_limited" or rate_limit.get("status") == "stopped"
    analysis_mode = (
        "security_timeout_partial"
        if security_timeout
        else "rate_limited_partial"
        if rate_limited
        else "partial_collection"
        if partial_analysis
        else "full_collection"
    )
    agent_stages = [
        {"index": 1, "total": 8, "id": "coverage-agent", "label": "full-body-coverage", "status": "partial" if partial_analysis else "completed"},
        {"index": 2, "total": 8, "id": "time-agent", "label": "time-normalization", "status": "completed"},
        {"index": 3, "total": 8, "id": "keyword-blueprint-agent" if task_mode == "general" else "profile-memory-agent", "label": "keyword-blueprint" if task_mode == "general" else "background-memory", "status": "completed"},
        {"index": 4, "total": 8, "id": "image-content-agent" if task_mode == "general" else "application-info-agent", "label": "image-and-content" if task_mode == "general" else "responsibilities-requirements-and-routes", "status": "completed"},
        {"index": 5, "total": 8, "id": "dynamic-module-agent" if task_mode == "general" else "capability-agent", "label": "dynamic-modules" if task_mode == "general" else "job-capabilities", "status": "completed"},
        {"index": 6, "total": 8, "id": "content-analysis-agent" if task_mode == "general" else "ai-writer-agent", "label": "ai-content-analysis" if task_mode == "general" else "per-link-outreach", "status": "deferred" if ai_deferred else "partial" if source_pending else runtime.get("status", "disabled")},
        {"index": 7, "total": 8, "id": "content-quality-agent" if task_mode == "general" else "employer-review-agent", "label": "content-quality-check" if task_mode == "general" else "score-and-rewrite", "status": "deferred" if ai_deferred else "pending" if source_pending else runtime.get("status", "disabled")},
        {
            "index": 8,
            "total": 8,
            "id": "quality-gate-agent",
            "label": "quality-gate-and-artifacts",
            "status": "pending" if source_pending else "passed" if gate["passed"] else "failed",
        },
    ]
    source_pending_issues = [{
        "check": "full_body_coverage",
        "code": "SOURCE_BODY_COMPLETION_PENDING",
        "message": f"{source_pending_count} records are waiting for full-body collection before final AI quality review",
    }] if source_pending else []
    return {
        "schemaVersion": 1,
        "runner": "xiaohongshu-project-workflow",
        "status": "completed_partial" if partial_analysis else "succeeded" if gate["passed"] else "failed",
        "analysisMode": analysis_mode,
        "taskMode": task_mode,
        "collectionStopReason": collection_stop_reason,
        "securityVerification": security_verification,
        "rateLimit": rate_limit,
        "generatedAt": utc_now(),
        "cardsDiscovered": body_metrics["discovered"],
        "notesCollected": gate["record_count"],
        "bodiesCaptured": gate["body_count"],
        "bodyCoveragePercent": body_metrics["completionRatePercent"],
        "timeNormalizedCount": time_normalized,
        "exactTimeCount": exact_time,
        "estimatedTimeCount": estimated_time,
        "contactsFound": contacts,
        "applicationRoutesFound": routes,
        "responsibilitiesExtracted": responsibilities,
        "requirementsExtracted": requirements,
        "greetingsGenerated": greetings,
        "emailsGenerated": emails,
        "coverLettersGenerated": cover_letters,
        "jobCardsGenerated": job_cards,
        "applicationCopyGenerated": application_copy,
        "generationCoveragePercent": round((application_copy / len(records)) * 100, 2) if records else 100.0,
        "applicationDetailsExtracted": contacts + routes + responsibilities + requirements,
        "codexRuntime": runtime,
        "sourceCoverage": source_coverage,
        "qualityPending": source_pending,
        "checks": gate["checks"],
        "issues": source_pending_issues if source_pending else gate["issues"],
        "agentStages": agent_stages,
        "discovered": body_metrics["discovered"],
        "bodyAttempted": body_metrics["attempted"],
        "bodySucceeded": body_metrics["succeeded"],
        "bodyFailed": body_metrics["failed"],
        "bodyNotAttempted": body_metrics["notAttempted"],
        "bodyBlocked": body_metrics["blocked"],
        "bodyCancelled": body_metrics["cancelled"],
        "bodyStatisticsSource": body_metrics["statisticsSource"],
        "legacyInferred": body_metrics["legacyInferred"],
        "bodyMetrics": body_metrics,
        "bodyCompletionLedger": body_summary.get("bodyCompletionLedger"),
        "timesNormalized": time_normalized,
        "applicationInfo": job_cards,
        "draftsGenerated": application_copy,
        "qualityPassed": 1 if gate["passed"] and not source_pending else 0,
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_project_manifest(output_dir: Path, summary: dict[str, Any]) -> Path:
    manifest_path = output_dir / "artifact-manifest.json"
    artifacts: list[dict[str, Any]] = []
    for path in sorted(output_dir.rglob("*"), key=lambda item: item.as_posix().casefold()):
        if path == manifest_path or not path.is_file():
            continue
        if path.is_symlink():
            raise RuntimeError(f"Refusing to publish symlink artifact: {path}")
        if path.stat().st_size == 0:
            continue
        relative = path.relative_to(output_dir).as_posix()
        artifacts.append({"path": relative, "bytes": path.stat().st_size, "sha256": sha256(path)})
    manifest = {
        "schemaVersion": 1,
        "runId": output_dir.parent.name,
        "runner": "xiaohongshu-project-workflow",
        "status": summary.get("status") or ("succeeded" if summary["checks"] and all(summary["checks"].values()) else "failed"),
        "startedAt": "",
        "updatedAt": utc_now(),
        "recordCount": summary["notesCollected"],
        "bodyCount": summary["bodiesCaptured"],
        "message": "" if not summary["issues"] else "; ".join(item["message"] for item in summary["issues"]),
        "artifacts": artifacts,
    }
    atomic_json(manifest_path, manifest)
    return manifest_path


def emit_stage(index: int, label: str, status: str = "completed") -> None:
    print(f"AGENT_STAGE {index}/8 {label} {status}", flush=True)


def merge_audience_summary(output_dir: Path, audience: dict[str, Any]) -> dict[str, Any]:
    summary_path = output_dir / "workflow-summary.json"
    summary = load_json_object(summary_path)
    notes = load_json_array(output_dir / "xiaohongshu_notes_latest.json")
    bodies = sum(1 for item in notes if str(item.get("body") or "").strip())
    summary.setdefault("schemaVersion", 1)
    summary.setdefault("runner", "xiaohongshu-project-workflow")
    summary.setdefault("checks", {})
    summary.setdefault("issues", [])
    summary.setdefault("notesCollected", len(notes))
    summary.setdefault("bodiesCaptured", bodies)
    summary.setdefault("generatedAt", utc_now())
    summary["audience"] = audience
    if audience.get("status") != "complete":
        summary["status"] = "completed_partial"
    atomic_json(summary_path, summary)
    return summary


def load_json_object(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def load_json_array(path: Path) -> list[dict[str, Any]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return [item for item in payload if isinstance(item, dict)] if isinstance(payload, list) else []


def pending_audience_summary(output_dir: Path, stop_reason: str) -> dict[str, Any]:
    posts = load_json_array(output_dir / "audience-posts.json")
    comments = load_json_array(output_dir / "audience-comments.json")
    users = load_json_array(output_dir / "audience-users.json")
    notes = load_json_array(output_dir / "xiaohongshu_notes_latest.json")
    post_statuses = [normalize_audience_post_status(item) for item in posts]
    summary = {
        "schemaVersion": 1,
        "status": "partial" if comments else "pending",
        "postsTotal": len(posts) or len(notes),
        "postsComplete": post_statuses.count("complete"),
        "postsPending": post_statuses.count("pending") + max(0, len(notes) - len(posts)),
        "postsPartial": post_statuses.count("partial"),
        "postsFailed": sum(1 for item in posts if item.get("status") == "failed"),
        "commentsCollected": len(comments),
        "topLevelComments": sum(1 for item in comments if not item.get("parent_comment_id")),
        "repliesCollected": sum(1 for item in comments if item.get("parent_comment_id")),
        "usersDiscovered": len(users),
        "profilesComplete": sum(1 for item in users if item.get("enrichment_status") == "complete"),
        "postCoveragePercent": 0,
        "profileCoveragePercent": 0,
        "stopReason": stop_reason,
        "generatedAt": utc_now(),
    }
    atomic_json(output_dir / "audience-summary.json", summary)
    return summary


def materialize_checkpoint(
    output_dir: Path,
    candidate_profile: Path,
    *,
    stop_reason: str,
    analysis_mode: str = "job",
    keyword: str = "",
    content_preset: str = "auto",
    content_goal: str = "",
    body_summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    print("[checkpoint-analysis] publishing body-backed records only", flush=True)
    notes_checkpoint = output_dir / "xiaohongshu_notes_latest.json"
    if not notes_checkpoint.exists():
        atomic_json(notes_checkpoint, [])
    effective_body_summary = checkpoint_body_summary(output_dir, stop_reason=stop_reason)
    if body_summary:
        effective_body_summary = {**effective_body_summary, **body_summary}
    result = run_pipeline(output_dir, candidate_profile, use_codex_runtime=False, persist=False)
    result.payload["analysis_mode"] = analysis_mode
    result.payload["keyword"] = keyword
    if analysis_mode == "general":
        result.payload["content_research"] = {
            "preset": content_preset,
            "goal": content_goal,
        }
    if analysis_mode == "job":
        partition_job_ai_targets(result.payload, None, effective_body_summary)
    write_pipeline_artifacts(output_dir, result.payload)
    summary = build_workflow_summary(
        result.payload,
        effective_body_summary,
    )
    atomic_json(output_dir / "workflow-summary.json", summary)
    write_project_manifest(output_dir, summary)
    print(
        "CHECKPOINT_ANALYSIS "
        f"records={len(result.payload['records'])} "
        f"job_cards={summary['jobCardsGenerated']} "
        f"application_copy={summary['applicationCopyGenerated']}",
        flush=True,
    )
    return summary


def discovery_checkpoint(output_dir: Path) -> dict[str, Any]:
    cards = load_json_array(output_dir / "xiaohongshu_cards_latest.json")
    discovered_ids = list(dict.fromkeys(
        canonical_record_key(item)
        for item in cards
        if canonical_record_key(item)
    ))
    return {
        # The upstream collector is scroll-based and exposes no durable cursor.
        # These explicit values distinguish that fallback from missing schema.
        "cursor": None,
        "scrollCount": 0,
        "stableRoundCount": 0,
        "discoveredIds": discovered_ids,
        "discoveredCount": len(discovered_ids),
        "stopReason": "",
        "lastCheckpointAt": utc_now(),
    }


def card_identity_keys(card: dict[str, Any]) -> list[str]:
    return record_identity_keys(card)


def merge_discovered_cards(
    existing_cards: list[dict[str, Any]],
    discovered_cards: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    identities: dict[str, int] = {}

    for source in [*existing_cards, *discovered_cards]:
        candidate = dict(source)
        keys = card_identity_keys(candidate)
        matched_index = next((identities[key] for key in keys if key in identities), None)
        if matched_index is None:
            matched_index = len(merged)
            merged.append(candidate)
        else:
            current = merged[matched_index]
            for field, value in candidate.items():
                if current.get(field) in (None, "", [], {}) and value not in (None, "", [], {}):
                    current[field] = value
        for key in card_identity_keys(merged[matched_index]):
            identities[key] = matched_index
        for key in keys:
            identities[key] = matched_index

    return merged


def merge_discovery_growth(output_dir: Path, growth_dir: Path) -> dict[str, int]:
    cards_path = output_dir / "xiaohongshu_cards_latest.json"
    existing_cards = load_json_array(cards_path)
    discovered_cards = load_json_array(growth_dir / "xiaohongshu_cards_latest.json")
    merged_cards = merge_discovered_cards(existing_cards, discovered_cards)
    atomic_json(cards_path, merged_cards)
    return {
        "existing": len(existing_cards),
        "discovered": len(discovered_cards),
        "added": max(0, len(merged_cards) - len(existing_cards)),
        "total": len(merged_cards),
    }


def run_discovery_process(
    command: list[str],
    *,
    output_dir: Path | None,
    state: WorkflowStateSession | None,
) -> int:
    if state is None or output_dir is None:
        return subprocess.run(command, check=False).returncode
    process = subprocess.Popen(command)
    previous_signature: tuple[int, int] | None = None
    try:
        while True:
            return_code = process.poll()
            patch = discovery_checkpoint(output_dir)
            signature = (int(patch["discoveredCount"]), len(patch["discoveredIds"]))
            if signature != previous_signature:
                state.update_stage("discovery", patch)
                cards = load_json_array(output_dir / "xiaohongshu_cards_latest.json")
                ledger = BodyCompletionLedger.open(
                    output_dir,
                    cards,
                    recover_interrupted=False,
                ).snapshot()
                state.checkpoint_body(
                    cards=cards,
                    complete_records=[],
                    failures=[],
                    attempted_ids=set(),
                    ledger=ledger,
                    status=state.stage_status("bodyCompletion"),
                )
                previous_signature = signature
            if return_code is not None:
                return return_code
            time.sleep(1.0)
    except BaseException:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
        raise


def body_state_callback(state: WorkflowStateSession | None):
    def callback(progress: dict[str, Any]) -> None:
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

    return callback


def audience_state_callback(state: WorkflowStateSession | None):
    def callback(progress: dict[str, Any]) -> None:
        if state is None:
            return
        state.checkpoint_audience(
            posts=progress["posts"],
            users=progress["users"],
            summary=progress["summary"],
            status=str(progress.get("status") or "running"),
        )

    return callback


def load_body_summary(output_dir: Path) -> dict[str, Any]:
    summary = load_json_object(output_dir / "parallel-body-summary.json")
    return summary or checkpoint_body_summary(output_dir, stop_reason="checkpoint_reused")


def finish_artifact_state(
    state: WorkflowStateSession | None,
    output_dir: Path,
    manifest_path: Path,
) -> None:
    if state is None:
        return
    manifest = load_json_object(manifest_path)
    generated_files = [
        str(item.get("path") or "")
        for item in manifest.get("artifacts", [])
        if isinstance(item, dict) and str(item.get("path") or "")
    ]
    state.finish_stage("artifacts", "completed", {
        "sourceRevision": state.revision,
        "manifestRevision": stable_hash(manifest),
        "generatedFiles": generated_files,
        "failedFiles": [],
    })


def fail_state_stage(state: WorkflowStateSession, stage: str, error: BaseException) -> None:
    try:
        state.finish_stage(stage, "failed", {
            "failureCode": type(error).__name__,
            "failureMessage": str(error)[:1000],
        })
    except BaseException:
        # Preserve the original error, especially when it is a revision conflict.
        pass


def main_stateful(
    wrapper: argparse.Namespace,
    upstream_arguments: list[str],
) -> int:
    unlimited_arguments = rewrite_unlimited_args(upstream_arguments)
    output_dir_value = option_value(unlimited_arguments, "--output-dir")
    if not output_dir_value:
        raise ValueError("--output-dir is required for workflow-state execution")
    output_dir = Path(output_dir_value).resolve()
    state = open_workflow_state_from_args(wrapper, output_dir)
    if state is None:
        raise ValueError("Workflow-state execution context is required")
    if wrapper.analyze_checkpoint:
        raise ValueError("--analyze-checkpoint cannot be combined with workflow-state execution")

    candidate_profile = Path(
        os.environ.get("XHS_PROFILE_PATH") or resolve_project_path(wrapper.candidate_profile)
    ).resolve()
    upstream = resolve_upstream_runner(wrapper.upstream_runner)
    upstream_scraper = resolve_upstream_scraper(upstream)
    resume_in_place = "--resume" in upstream_arguments or wrapper.complete_missing_only
    keyword = option_value(unlimited_arguments, "--keyword")
    check_only = "--check-only" in unlimited_arguments
    scrape_failed = False
    checkpoint_fallback = False
    discovery_ran = False

    force_discovery = bool(wrapper.discover_more)
    if state.should_run("discovery", force=force_discovery):
        discovery_ran = True
        state.start_stage("discovery")
        try:
            print(
                "[coverage-agent] discovering more latest cards" if force_discovery
                else "[coverage-agent] discovering all job cards before guarded body collection",
                flush=True,
            )
            scrape_arguments = add_flag_once(unlimited_arguments, "--skip-postprocess")
            scrape_arguments = add_flag_once(scrape_arguments, "--cards-only")
            scrape_arguments = add_option_once(
                scrape_arguments,
                "--security-verification-timeout-seconds",
                str(wrapper.security_verification_timeout_seconds),
            )
            if force_discovery:
                growth_dir = Path(tempfile.mkdtemp(prefix=".discovery-growth-", dir=output_dir.parent))
                try:
                    growth_arguments = replace_option(scrape_arguments, "--output-dir", str(growth_dir))
                    growth_arguments = replace_collection_mode(growth_arguments, "--fresh")
                    return_code = run_discovery_process(
                        [sys.executable, str(upstream), *growth_arguments],
                        output_dir=None,
                        state=None,
                    )
                    growth = merge_discovery_growth(output_dir, growth_dir)
                    print(
                        "DISCOVERY_GROWTH "
                        f"existing={growth['existing']} discovered={growth['discovered']} "
                        f"added={growth['added']} total={growth['total']}",
                        flush=True,
                    )
                finally:
                    shutil.rmtree(growth_dir, ignore_errors=True)
            else:
                return_code = run_discovery_process(
                    [sys.executable, str(upstream), *scrape_arguments],
                    output_dir=output_dir,
                    state=state,
                )
            scrape_failed = return_code != 0
            discovery = discovery_checkpoint(output_dir)
            discovery_status = (
                "completed" if not scrape_failed
                else "partial" if discovery["discoveredCount"]
                else "failed"
            )
            state.finish_stage("discovery", discovery_status, {
                **discovery,
                "failureCode": "" if not scrape_failed else f"runner_exit_{return_code}",
                "stopReason": "" if not scrape_failed else f"runner_exit_{return_code}",
            })
        except BaseException as error:
            fail_state_stage(state, "discovery", error)
            raise
    else:
        return_code = 0
        print(
            f"WORKFLOW_STAGE discovery skipped status={state.stage_status('discovery')}",
            flush=True,
        )

    if scrape_failed:
        checkpoint_fallback = bool(
            (output_dir / "xiaohongshu_cards_latest.json").is_file()
            and (resume_in_place or wrapper.complete_missing_only)
        )
        if checkpoint_fallback:
            print(
                f"SCRAPE_UNAVAILABLE continuing=checkpoint-completion exit_code={return_code}",
                flush=True,
            )
        elif state.resume_scope != "discovery" and not check_only:
            return return_code

    if check_only:
        return 0 if not scrape_failed else return_code
    if state.resume_scope == "discovery":
        return 0 if not scrape_failed else return_code

    body_summary = load_body_summary(output_dir)
    body_ran = state.should_run("bodyCompletion", force=discovery_ran)
    if body_ran:
        state.start_stage("bodyCompletion")
        try:
            body_summary = collect_body_checkpoint(
                output_dir,
                scrape_failed=scrape_failed,
                checkpoint_fallback=checkpoint_fallback,
                relay_port=int(option_value(unlimited_arguments, "--relay-port") or 18800),
                goto_timeout_ms=int(option_value(unlimited_arguments, "--goto-timeout-ms") or 15000),
                security_verification_timeout_seconds=wrapper.security_verification_timeout_seconds,
                speed_mode=str(option_value(unlimited_arguments, "--speed-mode") or "random"),
                note_delay_seconds=float(option_value(unlimited_arguments, "--note-delay-seconds") or 1.2),
                random_delay_min_seconds=float(option_value(unlimited_arguments, "--random-delay-min-seconds") or 0.8),
                random_delay_max_seconds=float(option_value(unlimited_arguments, "--random-delay-max-seconds") or 2.4),
                page_recovery_delay_seconds=wrapper.page_recovery_delay_seconds,
                body_batch_size=wrapper.body_batch_size,
                body_batch_pause_min_seconds=wrapper.body_batch_pause_min_seconds,
                body_batch_pause_max_seconds=wrapper.body_batch_pause_max_seconds,
                proactive_rest_every=wrapper.proactive_rest_every,
                proactive_rest_seconds=wrapper.proactive_rest_seconds,
                adaptive_pacing=wrapper.adaptive_pacing,
                adaptive_max_delay_seconds=wrapper.adaptive_max_delay_seconds,
                block_heavy_resources=wrapper.block_heavy_resources,
                rate_limit_auto_recovery=wrapper.rate_limit_auto_recovery,
                rate_limit_initial_delay_seconds=wrapper.rate_limit_initial_delay_seconds,
                rate_limit_max_delay_seconds=wrapper.rate_limit_max_delay_seconds,
                rate_limit_max_retries=wrapper.rate_limit_max_retries,
                rate_limit_recovery_spacing_seconds=wrapper.rate_limit_recovery_spacing_seconds,
                rate_limit_max_recovery_spacing_seconds=wrapper.rate_limit_max_recovery_spacing_seconds,
                rate_limit_stable_successes=wrapper.rate_limit_stable_successes,
                reuse_body_cache=wrapper.reuse_body_cache,
                body_cache_max_age_days=wrapper.body_cache_max_age_days,
                max_age_days=int(option_value(unlimited_arguments, "--max-age-days") or 0),
                upstream_scraper=upstream_scraper,
                progress_callback=body_state_callback(state),
                attempt_id=str(wrapper.attempt_id or ""),
            )
            body_status = (
                "completed" if body_summary.get("passed")
                else "blocked" if body_summary.get("stopReason")
                else "partial"
            )
            state.finish_stage("bodyCompletion", body_status, {
                "stopReason": str(body_summary.get("stopReason") or ""),
            })
        except KeyboardInterrupt:
            cards = load_json_array(output_dir / "xiaohongshu_cards_latest.json")
            BodyCompletionLedger.open(
                output_dir,
                cards,
                recover_interrupted=False,
            ).finalize_pending("user_cancelled")
            state.finish_stage("bodyCompletion", "cancelled", {
                "failureCode": "user_cancelled",
                "failureMessage": "",
                "stopReason": "user_cancelled",
            })
            raise
        except BaseException as error:
            fail_state_stage(state, "bodyCompletion", error)
            raise
    elif state.scope_selects("bodyCompletion"):
        print(
            f"WORKFLOW_STAGE bodyCompletion skipped status={state.stage_status('bodyCompletion')}",
            flush=True,
        )

    if body_ran and not scrape_failed and "--skip-postprocess" not in unlimited_arguments:
        postprocess = upstream.parent / "build_structured_excel.py"
        completed = subprocess.run(
            [
                sys.executable,
                str(postprocess),
                "--input-json",
                str(output_dir / "xiaohongshu_notes_latest.json"),
                "--output-dir",
                str(output_dir),
            ],
            check=False,
        )
        if completed.returncode != 0:
            return completed.returncode

    if wrapper.body_only:
        empty_gate = {"discovered_count": 0, "body_count": 0}
        body_metrics = canonical_body_metrics(body_summary, empty_gate)
        pending_count = max(0, int(body_metrics.get("discovered") or 0) - int(body_metrics.get("succeeded") or 0))
        rate_limit = body_summary.get("rateLimit")
        security_verification = body_summary.get("securityVerification")
        summary = {
            "schemaVersion": 1,
            "runner": "xiaohongshu-project-workflow",
            "status": "succeeded" if body_summary.get("passed") else "completed_partial",
            "taskMode": wrapper.analysis_mode,
            "analysisMode": "body_only",
            "bodyOnly": True,
            "collectionStopReason": str(body_summary.get("stopReason") or ""),
            "securityVerification": security_verification if isinstance(security_verification, dict) else {},
            "rateLimit": rate_limit if isinstance(rate_limit, dict) else {},
            "generatedAt": utc_now(),
            "cardsDiscovered": body_metrics["discovered"],
            "notesCollected": body_metrics["succeeded"],
            "bodiesCaptured": body_metrics["succeeded"],
            "bodyCoveragePercent": body_metrics["completionRatePercent"],
            "discovered": body_metrics["discovered"],
            "bodyAttempted": body_metrics["attempted"],
            "bodySucceeded": body_metrics["succeeded"],
            "bodyFailed": body_metrics["failed"],
            "bodyNotAttempted": body_metrics["notAttempted"],
            "bodyBlocked": body_metrics["blocked"],
            "bodyCancelled": body_metrics["cancelled"],
            "bodyStatisticsSource": body_metrics["statisticsSource"],
            "legacyInferred": body_metrics["legacyInferred"],
            "bodyMetrics": body_metrics,
            "bodyCompletionLedger": body_summary.get("bodyCompletionLedger"),
            "sourceCoverage": {
                "status": "partial" if pending_count else "complete",
                "reason": body_collection_deferred_reason(body_summary) if pending_count else "",
                "targetCount": body_metrics["discovered"],
                "readyCount": body_metrics["succeeded"],
                "pendingCount": pending_count,
                "totalRecordCount": body_metrics["discovered"],
                "fullBodyCount": body_metrics["succeeded"],
            },
            "qualityPending": pending_count > 0,
        }
        atomic_json(output_dir / "workflow-summary.json", summary)
        print(
            f"BODY_IMPORT_COMPLETE total={body_metrics['discovered']} "
            f"succeeded={body_metrics['succeeded']} pending={pending_count}",
            flush=True,
        )
        return 0 if body_summary.get("passed") else 3

    only_incomplete = resume_in_place or state.resume_scope != "full"
    previous_application = load_application_checkpoint(output_dir) if only_incomplete else None
    payload: dict[str, Any] | None = load_application_checkpoint(output_dir)
    deferred_reason = ""
    source_pending_reason = ""
    source_pending_count = 0
    analysis_ran = state.should_run("analysis", force=body_ran)
    if analysis_ran:
        state.start_stage("analysis")
        try:
            emit_stage(1, "full-body-coverage")
            result = run_pipeline(
                output_dir,
                candidate_profile,
                use_codex_runtime=False,
                codex_cli_bin=wrapper.codex_cli_bin,
                codex_batch_size=wrapper.codex_batch_size,
                codex_timeout_seconds=wrapper.codex_timeout_seconds,
                persist=False,
            )
            payload = result.payload
            payload["analysis_mode"] = wrapper.analysis_mode
            payload["keyword"] = keyword
            if wrapper.analysis_mode == "general":
                payload["content_research"] = {
                    "preset": wrapper.content_preset,
                    "goal": wrapper.content_goal,
                }
            target_note_ids, reused = merge_and_persist_analysis(
                output_dir,
                payload,
                previous_application,
                wrapper.analysis_mode,
                only_incomplete=only_incomplete,
            )
            if only_incomplete:
                print(f"COMPLETE_MISSING targets={len(target_note_ids)} reused={reused}", flush=True)
            if wrapper.analysis_mode == "job":
                target_note_ids, source_pending_reason, source_pending_count, fully_deferred = partition_job_ai_targets(
                    payload,
                    target_note_ids,
                    body_summary,
                )
                deferred_reason = source_pending_reason if fully_deferred else ""
            else:
                deferred_reason = mark_ai_deferred(payload, body_summary)
                source_pending_reason = deferred_reason
                source_pending_count = int(body_summary.get("missingBodies") or 0) if deferred_reason else 0
            if source_pending_reason:
                write_pipeline_artifacts(output_dir, payload)
                print(
                    f"AI_{'DEFERRED' if deferred_reason else 'PARTIAL'} reason={source_pending_reason} "
                    f"ready={len(target_note_ids or set())} pending={source_pending_count}",
                    flush=True,
                )
            state.checkpoint_analysis(payload)

            emit_stage(2, "time-normalization")
            emit_stage(3, "keyword-blueprint" if wrapper.analysis_mode == "general" else "background-memory")
            if wrapper.codex_runtime and not deferred_reason:
                ai_provider = build_ai_provider(wrapper)

                def checkpoint_ai_progress(
                    completed_count: int,
                    total: int,
                    status: str,
                    _record: dict[str, Any],
                ) -> None:
                    if completed_count % 5 == 0 or completed_count == total or status != "skipped":
                        print(f"AI_RECORD {completed_count}/{total} {status}", flush=True)
                    if completed_count % 5 == 0 or completed_count == total:
                        atomic_json(output_dir / "application_intelligence.checkpoint.json", payload)
                        state.checkpoint_analysis(payload)

                if wrapper.analysis_mode == "general":
                    report = enrich_general_payload(
                        payload,
                        keyword,
                        provider=ai_provider,
                        only_incomplete=only_incomplete,
                        progress_callback=checkpoint_ai_progress,
                        content_preset=wrapper.content_preset,
                        content_goal=wrapper.content_goal,
                    )
                else:
                    profile = json.loads(candidate_profile.read_text(encoding="utf-8"))
                    report = enrich_payload(
                        payload,
                        profile,
                        threshold=wrapper.cover_letter_threshold,
                        max_attempts=wrapper.cover_letter_max_attempts,
                        provider=ai_provider,
                        only_incomplete=only_incomplete,
                        target_note_ids=target_note_ids,
                        progress_callback=checkpoint_ai_progress,
                    )
                write_pipeline_artifacts(output_dir, payload)
                print(
                    f"[{'content-analysis-agent' if wrapper.analysis_mode == 'general' else 'employer-review-agent'}] "
                    f"processed={report.processed} skipped={report.skipped} "
                    f"passed={report.passed} failed={report.failed} attempts={report.attempts}",
                    flush=True,
                )

            if wrapper.analysis_mode == "general":
                emit_stage(4, "image-and-content")
                emit_stage(5, "dynamic-modules")
                emit_stage(6, "ai-content-analysis", "deferred" if deferred_reason else "partial" if source_pending_reason else payload["codex_runtime"]["status"])
                emit_stage(7, "content-quality-check", "deferred" if deferred_reason else "pending" if source_pending_reason else "passed" if payload["quality_gate"].get("passed") else "failed")
                remaining_analysis = sum(
                    1 for item in payload.get("records", [])
                    if isinstance(item, dict) and record_needs_content_completion(item)
                )
            else:
                emit_stage(4, "application-info")
                emit_stage(5, "job-capabilities")
                emit_stage(6, "ai-outreach", "deferred" if deferred_reason else "partial" if source_pending_reason else payload["codex_runtime"]["status"])
                emit_stage(7, "employer-score-and-rewrite", "deferred" if deferred_reason else "pending" if source_pending_reason else "passed" if payload["quality_gate"].get("cover_letter_quality_passed") else "failed")
                remaining_analysis = sum(
                    1 for item in payload.get("records", [])
                    if isinstance(item, dict) and record_needs_completion(item)
                )
            analysis_status = (
                "blocked" if deferred_reason
                else "partial" if source_pending_reason or remaining_analysis > 0
                else "completed"
            )
            state.checkpoint_analysis(payload, status=analysis_status)
            # `remainingCount` belongs to the analysis ledger.  The number of
            # notes that still need body collection is a separate upstream
            # metric and can differ from the number of incomplete analyses.
            analysis_stage_patch = {
                "stopReason": source_pending_reason,
                "sourcePendingCount": source_pending_count,
            }
            state.finish_stage("analysis", analysis_status, analysis_stage_patch)
        except BaseException as error:
            fail_state_stage(state, "analysis", error)
            raise
    elif state.scope_selects("analysis"):
        print(
            f"WORKFLOW_STAGE analysis skipped status={state.stage_status('analysis')}",
            flush=True,
        )

    if payload is not None and not deferred_reason:
        runtime = payload.get("codex_runtime")
        if isinstance(runtime, dict) and runtime.get("status") == "deferred_missing_bodies":
            deferred_reason = str(runtime.get("reason") or body_collection_deferred_reason(body_summary))
    if payload is not None:
        source_coverage = payload.get("source_coverage")
        if isinstance(source_coverage, dict) and int(source_coverage.get("pendingCount") or 0) > 0:
            source_pending_count = int(source_coverage.get("pendingCount") or 0)
            source_pending_reason = str(source_coverage.get("reason") or "missing_bodies")

    if payload is not None:
        gate = payload.get("quality_gate") if isinstance(payload.get("quality_gate"), dict) else {}
        print(
            "[quality-gate] "
            f"discovered={gate.get('discovered_count', 0)} records={gate.get('record_count', 0)} "
            f"full_bodies={gate.get('body_count', 0)} "
            f"status={'PENDING' if source_pending_reason else 'PASS' if gate.get('passed') else 'FAIL'}",
            flush=True,
        )
        if not source_pending_reason:
            for issue in gate.get("issues", []):
                if isinstance(issue, dict):
                    print(f"[quality-gate] {issue.get('message', '')}", flush=True)

    audience_summary = load_json_object(output_dir / "audience-summary.json") or None
    audience_ran = False
    audience_requested = wrapper.analysis_mode == "general" and wrapper.collect_audience
    if audience_requested and state.should_run("audience", force=analysis_ran):
        audience_ran = True
        state.start_stage("audience")
        try:
            collection_stop_reason = str(body_summary.get("stopReason") or "")
            if (
                collection_stop_reason in {"rate_limited", "security_verification_timeout"}
                and not wrapper.resume_checkpoint_dir
            ):
                audience_summary = pending_audience_summary(output_dir, collection_stop_reason)
                state.checkpoint_audience(
                    posts=load_json_array(output_dir / "audience-posts.json"),
                    users=load_json_array(output_dir / "audience-users.json"),
                    summary=audience_summary,
                    status="blocked",
                )
                print(
                    f"AUDIENCE_PENDING reason={collection_stop_reason}; resume after the Relay page is available",
                    flush=True,
                )
            else:
                audience_summary = collect_configured_audience(
                    wrapper,
                    output_dir,
                    unlimited_arguments,
                    upstream_scraper,
                    progress_callback=audience_state_callback(state),
                )
            audience_status = (
                "completed" if audience_summary.get("status") == "complete"
                else "blocked" if audience_summary.get("stopReason")
                else "partial"
            )
            state.finish_stage("audience", audience_status, {
                "stopReason": str(audience_summary.get("stopReason") or ""),
            })
        except BaseException as error:
            fail_state_stage(state, "audience", error)
            raise
    elif audience_requested and state.scope_selects("audience"):
        print(
            f"WORKFLOW_STAGE audience skipped status={state.stage_status('audience')}",
            flush=True,
        )

    summary = load_json_object(output_dir / "workflow-summary.json")
    if payload is not None:
        summary = build_workflow_summary(payload, body_summary)
    if audience_summary is not None:
        summary["audience"] = audience_summary
        if audience_summary.get("status") != "complete":
            summary["status"] = "completed_partial"

    artifact_force = analysis_ran or audience_ran
    if state.should_run("artifacts", force=artifact_force):
        state.start_stage("artifacts")
        try:
            if not summary:
                raise RuntimeError("Cannot rebuild artifacts without a workflow summary checkpoint")
            atomic_json(output_dir / "workflow-summary.json", summary)
            gate_passed = bool(payload and payload.get("quality_gate", {}).get("passed"))
            audience_passed = audience_summary is None or audience_summary.get("status") == "complete"
            passed = not source_pending_reason and gate_passed and audience_passed if payload is not None else audience_passed
            emit_stage(8, "quality-gate-and-artifacts", "pending" if source_pending_reason else "passed" if passed else "failed")
            manifest_path = write_project_manifest(output_dir, summary)
            finish_artifact_state(state, output_dir, manifest_path)
        except BaseException as error:
            fail_state_stage(state, "artifacts", error)
            raise
    else:
        prior_status = str(summary.get("status") or "")
        passed = prior_status not in {"failed", "completed_partial"}
        if audience_summary is not None:
            passed = passed and audience_summary.get("status") == "complete"
        if state.scope_selects("artifacts"):
            print(
                f"WORKFLOW_STAGE artifacts skipped status={state.stage_status('artifacts')}",
                flush=True,
            )
    return 0 if passed else 3


def main(arguments: list[str] | None = None) -> int:
    raw_arguments = list(sys.argv[1:] if arguments is None else arguments)
    wrapper, upstream_arguments = parse_wrapper_args(raw_arguments)
    workflow_state_values = (
        wrapper.resume_scope,
        wrapper.attempt_id,
        wrapper.state_path,
        wrapper.expected_state_revision,
    )
    if any(value not in (None, "") for value in workflow_state_values):
        return main_stateful(wrapper, upstream_arguments)
    unlimited_arguments = rewrite_unlimited_args(upstream_arguments)
    output_dir_value = option_value(unlimited_arguments, "--output-dir")
    candidate_profile = Path(os.environ.get("XHS_PROFILE_PATH") or resolve_project_path(wrapper.candidate_profile)).resolve()
    if wrapper.analyze_checkpoint:
        if not output_dir_value:
            raise ValueError("--output-dir is required for checkpoint analysis")
        output_dir = Path(output_dir_value).resolve()
        materialize_checkpoint(
            output_dir,
            candidate_profile,
            stop_reason="terminal_checkpoint",
            analysis_mode=wrapper.analysis_mode,
            keyword=option_value(upstream_arguments, "--keyword"),
            content_preset=wrapper.content_preset,
            content_goal=wrapper.content_goal,
        )
        return 0

    upstream = resolve_upstream_runner(wrapper.upstream_runner)
    if wrapper.audience_only:
        if not output_dir_value:
            raise ValueError("--output-dir is required for audience collection")
        output_dir = Path(output_dir_value).resolve()
        audience = collect_configured_audience(
            wrapper,
            output_dir,
            upstream_arguments,
            resolve_upstream_scraper(upstream),
        )
        summary = merge_audience_summary(output_dir, audience)
        write_project_manifest(output_dir, summary)
        return 0 if audience.get("status") == "complete" else 3
    print("[coverage-agent] discovering all job cards before guarded body collection", flush=True)
    scrape_arguments = add_flag_once(unlimited_arguments, "--skip-postprocess")
    scrape_arguments = add_flag_once(scrape_arguments, "--cards-only")
    scrape_arguments = add_option_once(
        scrape_arguments,
        "--security-verification-timeout-seconds",
        str(wrapper.security_verification_timeout_seconds),
    )
    completed = subprocess.run([sys.executable, str(upstream), *scrape_arguments], check=False)
    scrape_failed = completed.returncode != 0
    checkpoint_fallback = False
    if scrape_failed:
        checkpoint_fallback = bool(
            output_dir_value
            and can_complete_from_checkpoint(Path(output_dir_value).resolve(), wrapper.complete_missing_only)
        )
        if checkpoint_fallback:
            print(
                "SCRAPE_UNAVAILABLE continuing=checkpoint-completion "
                f"exit_code={completed.returncode}",
                flush=True,
            )
        else:
            if output_dir_value and "--check-only" not in unlimited_arguments:
                output_dir = Path(output_dir_value).resolve()
                if (output_dir / "xiaohongshu_cards_latest.json").is_file():
                    try:
                        restriction_path = output_dir / "security-restriction.json"
                        restriction = (
                            json.loads(restriction_path.read_text(encoding="utf-8"))
                            if restriction_path.is_file()
                            else {}
                        )
                        security_timeout = restriction.get("status") == "timed_out"
                        stop_reason = "security_verification_timeout" if security_timeout else "scrape_runner_failed"
                        materialize_checkpoint(
                            output_dir,
                            candidate_profile,
                            stop_reason=stop_reason,
                            analysis_mode=wrapper.analysis_mode,
                            keyword=option_value(unlimited_arguments, "--keyword"),
                            content_preset=wrapper.content_preset,
                            content_goal=wrapper.content_goal,
                            body_summary={
                                "transitionedToAnalysis": True,
                                "stopReason": stop_reason,
                                "newAccessStopped": security_timeout,
                                "securityVerification": restriction,
                            },
                        )
                    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
                        print(f"[checkpoint-analysis] failed: {error}", file=sys.stderr, flush=True)
            return completed.returncode
    if "--check-only" in unlimited_arguments or "--help" in unlimited_arguments or "-h" in unlimited_arguments:
        return 0

    if not output_dir_value:
        raise ValueError("--output-dir is required for project workflow enrichment")
    output_dir = Path(output_dir_value).resolve()
    previous_application = load_application_checkpoint(output_dir) if wrapper.complete_missing_only else None
    # A failed card-discovery pass can still leave a complete card checkpoint.
    # Retry missing bodies from that checkpoint instead of materializing every
    # uncollected card as a permanent fallback record.
    body_summary = collect_body_checkpoint(
        output_dir,
        scrape_failed=scrape_failed,
        checkpoint_fallback=checkpoint_fallback,
        relay_port=int(option_value(unlimited_arguments, "--relay-port") or 18800),
        goto_timeout_ms=int(option_value(unlimited_arguments, "--goto-timeout-ms") or 15000),
        security_verification_timeout_seconds=wrapper.security_verification_timeout_seconds,
        speed_mode=str(option_value(unlimited_arguments, "--speed-mode") or "random"),
        note_delay_seconds=float(option_value(unlimited_arguments, "--note-delay-seconds") or 1.2),
        random_delay_min_seconds=float(option_value(unlimited_arguments, "--random-delay-min-seconds") or 0.8),
        random_delay_max_seconds=float(option_value(unlimited_arguments, "--random-delay-max-seconds") or 2.4),
        page_recovery_delay_seconds=wrapper.page_recovery_delay_seconds,
        body_batch_size=wrapper.body_batch_size,
        body_batch_pause_min_seconds=wrapper.body_batch_pause_min_seconds,
        body_batch_pause_max_seconds=wrapper.body_batch_pause_max_seconds,
        proactive_rest_every=wrapper.proactive_rest_every,
        proactive_rest_seconds=wrapper.proactive_rest_seconds,
        adaptive_pacing=wrapper.adaptive_pacing,
        adaptive_max_delay_seconds=wrapper.adaptive_max_delay_seconds,
        block_heavy_resources=wrapper.block_heavy_resources,
        rate_limit_auto_recovery=wrapper.rate_limit_auto_recovery,
        rate_limit_initial_delay_seconds=wrapper.rate_limit_initial_delay_seconds,
        rate_limit_max_delay_seconds=wrapper.rate_limit_max_delay_seconds,
        rate_limit_max_retries=wrapper.rate_limit_max_retries,
        rate_limit_recovery_spacing_seconds=wrapper.rate_limit_recovery_spacing_seconds,
        rate_limit_max_recovery_spacing_seconds=wrapper.rate_limit_max_recovery_spacing_seconds,
        rate_limit_stable_successes=wrapper.rate_limit_stable_successes,
        reuse_body_cache=wrapper.reuse_body_cache,
        body_cache_max_age_days=wrapper.body_cache_max_age_days,
        max_age_days=int(option_value(unlimited_arguments, "--max-age-days") or 0),
        upstream_scraper=resolve_upstream_scraper(upstream),
        attempt_id=str(wrapper.attempt_id or ""),
    )
    if not scrape_failed and "--skip-postprocess" not in unlimited_arguments:
        postprocess = upstream.parent / "build_structured_excel.py"
        completed = subprocess.run(
            [
                sys.executable,
                str(postprocess),
                "--input-json",
                str(output_dir / "xiaohongshu_notes_latest.json"),
                "--output-dir",
                str(output_dir),
            ],
            check=False,
        )
        if completed.returncode != 0:
            return completed.returncode
    emit_stage(1, "full-body-coverage")
    result = run_pipeline(
        output_dir,
        candidate_profile,
        use_codex_runtime=False,
        codex_cli_bin=wrapper.codex_cli_bin,
        codex_batch_size=wrapper.codex_batch_size,
        codex_timeout_seconds=wrapper.codex_timeout_seconds,
        persist=False,
    )
    keyword = option_value(unlimited_arguments, "--keyword")
    result.payload["analysis_mode"] = wrapper.analysis_mode
    result.payload["keyword"] = keyword
    if wrapper.analysis_mode == "general":
        result.payload["content_research"] = {
            "preset": wrapper.content_preset,
            "goal": wrapper.content_goal,
        }
    target_note_ids, reused = merge_and_persist_analysis(
        output_dir,
        result.payload,
        previous_application,
        wrapper.analysis_mode,
        only_incomplete=wrapper.complete_missing_only,
    )
    if wrapper.complete_missing_only:
        print(f"COMPLETE_MISSING targets={len(target_note_ids)} reused={reused}", flush=True)
    source_pending_reason = ""
    source_pending_count = 0
    if wrapper.analysis_mode == "job":
        target_note_ids, source_pending_reason, source_pending_count, fully_deferred = partition_job_ai_targets(
            result.payload,
            target_note_ids,
            body_summary,
        )
        deferred_reason = source_pending_reason if fully_deferred else ""
    else:
        deferred_reason = mark_ai_deferred(result.payload, body_summary)
        source_pending_reason = deferred_reason
        source_pending_count = int(body_summary.get("missingBodies") or 0) if deferred_reason else 0
    if source_pending_reason:
        write_pipeline_artifacts(output_dir, result.payload)
        print(
            f"AI_{'DEFERRED' if deferred_reason else 'PARTIAL'} reason={source_pending_reason} "
            f"ready={len(target_note_ids or set())} pending={source_pending_count}",
            flush=True,
        )
    emit_stage(2, "time-normalization")
    emit_stage(3, "keyword-blueprint" if wrapper.analysis_mode == "general" else "background-memory")
    if wrapper.codex_runtime and not deferred_reason:
        ai_provider = build_ai_provider(wrapper)

        def checkpoint_ai_progress(completed: int, total: int, status: str, _record: dict[str, Any]) -> None:
            if completed % 5 == 0 or completed == total or status != "skipped":
                print(f"AI_RECORD {completed}/{total} {status}", flush=True)
            if completed % 5 == 0 or completed == total:
                atomic_json(output_dir / "application_intelligence.checkpoint.json", result.payload)

        if wrapper.analysis_mode == "general":
            report = enrich_general_payload(
                result.payload,
                keyword,
                provider=ai_provider,
                only_incomplete=wrapper.complete_missing_only,
                progress_callback=checkpoint_ai_progress,
                content_preset=wrapper.content_preset,
                content_goal=wrapper.content_goal,
            )
        else:
            profile = json.loads(candidate_profile.read_text(encoding="utf-8"))
            report = enrich_payload(
                result.payload,
                profile,
                threshold=wrapper.cover_letter_threshold,
                max_attempts=wrapper.cover_letter_max_attempts,
                provider=ai_provider,
                only_incomplete=wrapper.complete_missing_only,
                target_note_ids=target_note_ids,
                progress_callback=checkpoint_ai_progress,
            )
        write_pipeline_artifacts(output_dir, result.payload)
        print(
            f"[{'content-analysis-agent' if wrapper.analysis_mode == 'general' else 'employer-review-agent'}] "
            f"processed={report.processed} skipped={report.skipped} "
            f"passed={report.passed} failed={report.failed} attempts={report.attempts}",
            flush=True,
        )
    if wrapper.analysis_mode == "general":
        emit_stage(4, "image-and-content")
        emit_stage(5, "dynamic-modules")
        emit_stage(6, "ai-content-analysis", "deferred" if deferred_reason else "partial" if source_pending_reason else result.payload["codex_runtime"]["status"])
        emit_stage(7, "content-quality-check", "deferred" if deferred_reason else "pending" if source_pending_reason else "passed" if result.payload["quality_gate"].get("passed") else "failed")
    else:
        emit_stage(4, "application-info")
        emit_stage(5, "job-capabilities")
        emit_stage(6, "ai-outreach", "deferred" if deferred_reason else "partial" if source_pending_reason else result.payload["codex_runtime"]["status"])
        emit_stage(7, "employer-score-and-rewrite", "deferred" if deferred_reason else "pending" if source_pending_reason else "passed" if result.payload["quality_gate"].get("cover_letter_quality_passed") else "failed")
    gate = result.payload["quality_gate"]
    print(
        "[quality-gate] "
        f"discovered={gate['discovered_count']} records={gate['record_count']} "
        f"full_bodies={gate['body_count']} "
        f"status={'PENDING' if source_pending_reason else 'PASS' if gate['passed'] else 'FAIL'}",
        flush=True,
    )
    if not source_pending_reason:
        for issue in gate["issues"]:
            print(f"[quality-gate] {issue['message']}", flush=True)
    audience_summary: dict[str, Any] | None = None
    if wrapper.analysis_mode == "general" and wrapper.collect_audience:
        collection_stop_reason = str(body_summary.get("stopReason") or "")
        if (
            collection_stop_reason in {"rate_limited", "security_verification_timeout"}
            and not wrapper.resume_checkpoint_dir
        ):
            audience_summary = pending_audience_summary(output_dir, collection_stop_reason)
            print(
                f"AUDIENCE_PENDING reason={collection_stop_reason}; resume after the Relay page is available",
                flush=True,
            )
        else:
            audience_summary = collect_configured_audience(
                wrapper,
                output_dir,
                unlimited_arguments,
                resolve_upstream_scraper(upstream),
            )
    summary = build_workflow_summary(result.payload, body_summary)
    if audience_summary is not None:
        summary["audience"] = audience_summary
        if audience_summary.get("status") != "complete":
            summary["status"] = "completed_partial"
    atomic_json(output_dir / "workflow-summary.json", summary)
    result.passed = bool(not source_pending_reason and gate["passed"] and (audience_summary is None or audience_summary.get("status") == "complete"))
    emit_stage(8, "quality-gate-and-artifacts", "pending" if source_pending_reason else "passed" if result.passed else "failed")
    write_project_manifest(output_dir, summary)
    return 0 if result.passed else 3


if __name__ == "__main__":
    raise SystemExit(main())
