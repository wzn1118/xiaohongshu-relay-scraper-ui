from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import os
import queue
import sys
import threading
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def default_upstream_scraper() -> Path:
    candidates = [
        Path(os.environ["XHS_UPSTREAM_SCRAPER"]) if os.environ.get("XHS_UPSTREAM_SCRAPER") else None,
        PROJECT_ROOT / "vendor/xiaohongshu-relay-scrape/scrape_xiaohongshu_search.py",
        Path(os.environ["CODEX_HOME"]) / "skills/xiaohongshu-relay-scrape/scripts/scrape_xiaohongshu_search.py"
        if os.environ.get("CODEX_HOME")
        else None,
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return candidate.resolve()
    return PROJECT_ROOT / "vendor/xiaohongshu-relay-scrape/scrape_xiaohongshu_search.py"


DEFAULT_UPSTREAM_SCRAPER = default_upstream_scraper()
FAILURE_STATUSES = {
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
    "访问频繁",
    "异常访问",
    "captcha",
)


def contains_security_verification(value: Any) -> bool:
    text = str(value or "").casefold()
    return any(marker.casefold() in text for marker in SECURITY_VERIFICATION_MARKERS)


def record_key(record: dict[str, Any]) -> str:
    return str(record.get("note_id") or record.get("note_url") or "").strip()


def record_is_complete(record: dict[str, Any]) -> bool:
    return (
        bool(record_key(record))
        and bool(str(record.get("body") or "").strip())
        and str(record.get("access_status") or "").strip() == "detail_ok"
    )


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
    upstream_scraper: Path = DEFAULT_UPSTREAM_SCRAPER,
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
    card_keys = [record_key(card) for card in cards]
    if any(not key for key in card_keys) or len(set(card_keys)) != len(card_keys):
        raise ValueError("Card checkpoints must have unique note identifiers")

    existing = load_json_list(notes_path) if notes_path.exists() else []
    complete_by_key = {record_key(record): record for record in existing if record_is_complete(record)}
    complete_by_key = {key: value for key, value in complete_by_key.items() if key in set(card_keys)}
    last_failures: dict[str, dict[str, Any]] = {}
    upstream = None
    lock = threading.Lock()
    stop_event = threading.Event()
    successful_since_checkpoint = 0
    security_detected_at = ""
    security_status = "not_detected"
    stop_reason = ""

    source_search_url = next(
        (str(record.get("source_search_url")) for record in existing if record.get("source_search_url")),
        "https://www.xiaohongshu.com/search_result/",
    )

    def ordered_complete() -> list[dict[str, Any]]:
        return [complete_by_key[key] for key in card_keys if key in complete_by_key]

    def checkpoint(force: bool = False) -> None:
        nonlocal successful_since_checkpoint
        if not force and successful_since_checkpoint < checkpoint_every:
            return
        records = ordered_complete()
        atomic_json(notes_path, records)
        successful_since_checkpoint = 0
        print(f"PARALLEL_BODY {len(records)}/{len(cards)} checkpoint", flush=True)

    def run_worker(worker_id: int, work: queue.Queue[dict[str, Any]]) -> None:
        nonlocal successful_since_checkpoint, security_detected_at, security_status, stop_reason
        try:
            from playwright.sync_api import sync_playwright

            print(f"PARALLEL_WORKER {worker_id} connecting", flush=True)
            with sync_playwright() as playwright:
                browser = upstream.connect_browser(playwright, relay_port)
                context = upstream.get_or_create_context(browser)
                page = context.new_page()
                page_uses = 0
                print(f"PARALLEL_WORKER {worker_id} ready", flush=True)
                try:
                    while True:
                        if stop_event.is_set():
                            break
                        try:
                            card = work.get_nowait()
                        except queue.Empty:
                            break
                        key = record_key(card)
                        try:
                            record = upstream.scrape_note(
                                page,
                                card,
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
                        if not record_is_complete(payload):
                            challenge_text = json.dumps(payload, ensure_ascii=False)
                            try:
                                challenge_text += "\n" + page.locator("body").inner_text(timeout=3000)
                            except Exception:  # noqa: BLE001
                                pass
                            if contains_security_verification(challenge_text):
                                with lock:
                                    if not security_detected_at:
                                        security_detected_at = utc_now()
                                    security_status = "waiting"
                                print(
                                    "SECURITY_VERIFICATION detected "
                                    f"timeout={security_verification_timeout_seconds}s; waiting for manual completion",
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
                                    print("SECURITY_VERIFICATION cleared; resuming collection", flush=True)
                                    work.put(card)
                                    work.task_done()
                                    continue
                                with lock:
                                    security_status = "timed_out"
                                    stop_reason = "security_verification_timeout"
                                stop_event.set()
                                print(
                                    "SECURITY_VERIFICATION timed_out; preserving checkpoint and transitioning to analysis",
                                    flush=True,
                                )
                        with lock:
                            if record_is_complete(payload):
                                complete_by_key[key] = payload
                                last_failures.pop(key, None)
                                successful_since_checkpoint += 1
                                checkpoint()
                            else:
                                last_failures[key] = payload
                        page_uses += 1
                        if page_uses >= page_recycle_every or not record_is_complete(payload):
                            replacement = context.new_page()
                            try:
                                page.close()
                            except Exception:  # noqa: BLE001
                                pass
                            page = replacement
                            page_uses = 0
                            print(f"PARALLEL_WORKER {worker_id} recycled-page", flush=True)
                        work.task_done()
                        if stop_event.is_set():
                            break
                finally:
                    page.close()
        except Exception as error:  # noqa: BLE001
            print(f"PARALLEL_WORKER {worker_id} failed: {error}", flush=True)

    workers = max(1, min(int(workers), 8))
    attempts = max(1, min(int(attempts), 5))
    security_verification_timeout_seconds = max(60, min(int(security_verification_timeout_seconds), 3600))
    started_at = utc_now()
    for attempt in range(1, attempts + 1):
        if stop_event.is_set():
            break
        pending = [card for card in cards if record_key(card) not in complete_by_key]
        if not pending:
            break
        if upstream is None:
            upstream = load_upstream(upstream_scraper)
        print(
            f"PARALLEL_ROUND {attempt}/{attempts} pending={len(pending)} workers={workers}",
            flush=True,
        )
        work: queue.Queue[dict[str, Any]] = queue.Queue()
        for card in pending:
            work.put(card)
        threads = [
            threading.Thread(target=run_worker, args=(worker_id, work), daemon=True)
            for worker_id in range(1, workers + 1)
        ]
        for thread in threads:
            thread.start()
            time.sleep(0.75)
        for thread in threads:
            thread.join()
        checkpoint(force=True)
        if stop_event.is_set():
            break

    records = ordered_complete()
    write_csv(records, csv_path)
    missing = [key for key in card_keys if key not in complete_by_key]
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
        "workers": workers,
        "attempts": attempts,
        "failureStatuses": status_counts,
        "transitionedToAnalysis": stop_reason == "security_verification_timeout",
        "stopReason": stop_reason,
        "securityVerification": {
            "detectedAt": security_detected_at,
            "timeoutSeconds": security_verification_timeout_seconds,
            "status": security_status,
        },
        "passed": not missing,
    }
    atomic_json(summary_path, summary)
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
    parser.add_argument("--upstream-scraper", default=str(DEFAULT_UPSTREAM_SCRAPER))
    return parser.parse_args(arguments)


def main(arguments: list[str] | None = None) -> int:
    args = parse_args(arguments)
    summary = complete_bodies(
        Path(args.output_dir),
        relay_port=args.relay_port,
        workers=args.workers,
        attempts=args.attempts,
        goto_timeout_ms=args.goto_timeout_ms,
        checkpoint_every=args.checkpoint_every,
        page_recycle_every=max(1, args.page_recycle_every),
        security_verification_timeout_seconds=args.security_verification_timeout_seconds,
        upstream_scraper=Path(args.upstream_scraper),
    )
    return 0 if summary["passed"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
