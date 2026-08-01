from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import os
import queue
import random
import sys
import threading
import time
import uuid
from dataclasses import asdict
from datetime import datetime, timezone
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


def detail_url_candidates(card: dict[str, Any]) -> list[str]:
    candidates = [
        card.get("search_result_url", ""),
        card.get("note_url", ""),
        card.get("explore_url", ""),
    ]
    return list(dict.fromkeys(str(url).strip() for url in candidates if str(url).strip()))


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
    security_verification_timeout_seconds: int = 600,
    speed_mode: str = "random",
    note_delay_seconds: float = 1.2,
    random_delay_min_seconds: float = 0.8,
    random_delay_max_seconds: float = 2.4,
    upstream_scraper: Path = DEFAULT_UPSTREAM_SCRAPER,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    output_dir = output_dir.resolve()
    cards_path = output_dir / "xiaohongshu_cards_latest.json"
    notes_path = output_dir / "xiaohongshu_notes_latest.json"
    csv_path = output_dir / "xiaohongshu_notes_latest.csv"
    failures_path = output_dir / "parallel_body_failures.json"
    summary_path = output_dir / "parallel-body-summary.json"
    cards = load_json_list(cards_path)
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
    card_keys = [record_key(card) for card in cards]
    if len(set(card_keys)) != len(card_keys):
        raise ValueError("Card checkpoints must have unique note identifiers")

    existing = load_json_list(notes_path) if notes_path.exists() else []
    existing_failures = load_json_list(failures_path) if failures_path.exists() else []
    complete_by_key = {record_key(record): record for record in existing if record_is_complete(record)}
    complete_by_key = {key: value for key, value in complete_by_key.items() if key in set(card_keys)}
    last_failures = {
        record_key(record): record
        for record in existing_failures
        if record_key(record) in set(card_keys)
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

    def next_body_delay() -> float:
        if str(speed_mode).strip().casefold() == "steady":
            return max(0.0, float(note_delay_seconds))
        lower = max(0.0, float(random_delay_min_seconds))
        upper = max(lower, float(random_delay_max_seconds))
        return random.uniform(lower, upper)

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
        last_payload: dict[str, Any] = {}
        attempted_urls: list[str] = []
        last_request_id = ""
        key = record_key(card)
        target_urls = detail_url_candidates(card)
        for target_index, target_url in enumerate(target_urls):
            attempted_urls.append(target_url)
            candidate = dict(card)
            candidate["search_result_url"] = target_url
            candidate["note_url"] = target_url
            request_id = f"{invocation_id}:{key}:{uuid.uuid4().hex}"
            with lock:
                if not ledger.start_attempt(key, request_id):
                    raise RuntimeError(f"Body request is not eligible for ledger transition: {key}")
                attempted_keys.add(key)
                notify_progress(event="attempt_started")
            last_request_id = request_id
            try:
                record = upstream.scrape_note(
                    page,
                    candidate,
                    goto_timeout_ms=goto_timeout_ms,
                    source_search_url=source_search_url,
                )
                last_payload = asdict(record) if record is not None else {}
            except Exception as error:  # noqa: BLE001
                last_payload = {
                    "note_id": card.get("note_id", ""),
                    "note_url": target_url,
                    "body": "",
                    "access_status": "detail_worker_error",
                    "worker_error": str(error),
                }
            challenge_text = json.dumps(last_payload, ensure_ascii=False)
            if contains_rate_limit(challenge_text) or contains_security_verification(challenge_text):
                last_payload["attempted_detail_urls"] = attempted_urls
                return last_payload, request_id
            if record_is_complete(last_payload):
                return last_payload, request_id
            if target_index < len(target_urls) - 1:
                failure_code = str(last_payload.get("access_status") or "missing_record")
                finish_request(
                    key,
                    request_id,
                    last_payload,
                    "failed",
                    stop_reason_value="request_timeout" if "timeout" in failure_code else "request_failed",
                    recoverable=True,
                )
            else:
                return last_payload, request_id
        last_payload.setdefault("note_id", card.get("note_id", ""))
        last_payload.setdefault("note_url", card.get("note_url", ""))
        last_payload["attempted_detail_urls"] = attempted_urls
        return last_payload, last_request_id

    def run_worker(
        worker_id: int,
        work: queue.Queue[dict[str, Any]],
        round_number: int,
        round_total: int,
    ) -> None:
        nonlocal successful_since_checkpoint, security_detected_at, security_status, security_owner_id
        nonlocal rate_limit_detected_at, stop_reason
        try:
            from playwright.sync_api import sync_playwright

            print(f"PARALLEL_WORKER {worker_id} connecting", flush=True)
            with sync_playwright() as playwright:
                browser = upstream.connect_browser(playwright, relay_port)
                context = upstream.get_or_create_context(browser)
                page = context.new_page()
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
                            try:
                                challenge_text += "\n" + page.locator("body").inner_text(timeout=3000)
                            except Exception:  # noqa: BLE001
                                pass
                            if contains_rate_limit(challenge_text):
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
                                    stop_reason = "rate_limited"
                                    stop_event.set()
                                    security_gate.set()
                                    checkpoint(force=True)
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
                        if record_is_complete(payload):
                            finish_request(
                                key,
                                request_id,
                                payload,
                                "succeeded",
                                stop_reason_value="",
                                recoverable=False,
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
                        with lock:
                            attempted_keys.add(key)
                            round_progress[round_number] = round_progress.get(round_number, 0) + 1
                            if record_is_complete(payload):
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
                        if page_uses >= page_recycle_every or not record_is_complete(payload):
                            recycle_page("scheduled" if page_uses >= page_recycle_every else "failed_record")
                        work.task_done()
                        if stop_event.is_set():
                            break
                        delay = next_body_delay()
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
    security_verification_timeout_seconds = max(5, min(int(security_verification_timeout_seconds), 3600))
    started_at = utc_now()
    checkpoint(force=True, event="discovered")
    for attempt in range(1, attempts + 1):
        if stop_event.is_set():
            break
        pending = [
            card for card in cards
            if record_key(card) not in complete_by_key and ledger.can_resume(record_key(card))
        ]
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
        stop_reason = "attempt_limit_reached"
    ledger.finalize_pending(stop_reason or "completed")
    ledger_payload = ledger.snapshot()
    ledger_counts = ledger_payload["summary"]
    failure_payload = [last_failures.get(key, {"note_id": key, "access_status": "missing_record"}) for key in missing]
    if failure_payload:
        atomic_json(failures_path, failure_payload)
    else:
        failures_path.unlink(missing_ok=True)
    status_counts: dict[str, int] = {}
    for failure in failure_payload:
        status = str(failure.get("access_status") or "missing_record")
        status_counts[status] = status_counts.get(status, 0) + 1
    summary = {
        "schemaVersion": 2,
        "startedAt": started_at,
        "finishedAt": utc_now(),
        "cards": len(cards),
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
        },
        "attempts": attempts,
        "failureStatuses": status_counts,
        "collectionStatus": "partial" if missing else "completed",
        "partial": bool(missing),
        "workersExited": True,
        "queueConsumptionStopped": stop_event.is_set(),
        "readyForPartialAnalysis": bool(missing and stop_reason),
        "transitionedToAnalysis": False,
        "newAccessStopped": stop_reason in {"security_verification_timeout", "rate_limited"},
        "stopReason": stop_reason,
        "rateLimit": {
            "detectedAt": rate_limit_detected_at,
            "status": "stopped" if stop_reason == "rate_limited" else "not_detected",
            "recoveryAction": "wait_then_resume" if stop_reason == "rate_limited" else "",
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
        status="completed" if not missing else "blocked" if stop_reason else "partial",
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
    parser.add_argument("--security-verification-timeout-seconds", type=int, default=600)
    parser.add_argument("--speed-mode", choices=("steady", "random"), default="random")
    parser.add_argument("--note-delay-seconds", type=float, default=1.2)
    parser.add_argument("--random-delay-min-seconds", type=float, default=0.8)
    parser.add_argument("--random-delay-max-seconds", type=float, default=2.4)
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
            security_verification_timeout_seconds=args.security_verification_timeout_seconds,
            speed_mode=args.speed_mode,
            note_delay_seconds=args.note_delay_seconds,
            random_delay_min_seconds=args.random_delay_min_seconds,
            random_delay_max_seconds=args.random_delay_max_seconds,
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
