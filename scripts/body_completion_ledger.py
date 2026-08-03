from __future__ import annotations

import copy
import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable


LEDGER_SCHEMA_VERSION = 1
LEDGER_FILENAME = "body-completion-ledger.json"
BODY_STATUSES = frozenset((
    "discovered",
    "queued",
    "attempted",
    "succeeded",
    "failed",
    "not_attempted",
    "blocked",
    "cancelled",
))
TERMINAL_STATUSES = frozenset((
    "succeeded", "failed", "not_attempted", "blocked", "cancelled",
))
RETRYABLE_BLOCK_REASONS = frozenset((
    "rate_limited",
    "security_verification",
    "security_verification_timeout",
))
PROMOTION_FIXTURE = "body-ledger-fixed-fixture-v1"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def record_key(record: dict[str, Any]) -> str:
    return str(record.get("note_id") or record.get("noteId") or record.get("note_url") or "").strip()


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.{os.getpid()}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        try:
            directory_fd = os.open(path.parent, os.O_RDONLY)
        except OSError:
            directory_fd = None
        if directory_fd is not None:
            try:
                os.fsync(directory_fd)
            except OSError:
                pass
            finally:
                os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def _new_record(note_id: str, now: str) -> dict[str, Any]:
    return {
        "noteId": note_id,
        "discoveredAt": now,
        "bodyStatus": "discovered",
        "status": "discovered",
        "attemptCount": 0,
        "firstAttemptAt": None,
        "lastAttemptAt": None,
        "completedAt": None,
        "failureCode": "",
        "failureMessage": "",
        "recoverable": True,
        "stopReason": "",
        "updatedAt": now,
        "requestIds": [],
        "completedRequestIds": [],
    }


def normalize_record(note_id: str, value: dict[str, Any], now: str) -> dict[str, Any]:
    record = _new_record(note_id, now)
    record.update(copy.deepcopy(value))
    status = str(record.get("bodyStatus") or record.get("status") or "not_attempted")
    if status == "completed":
        status = "succeeded"
    if status not in BODY_STATUSES:
        status = "not_attempted"
    record["noteId"] = note_id
    record["bodyStatus"] = status
    record["status"] = status
    record["attemptCount"] = max(0, int(record.get("attemptCount") or 0))
    record["recoverable"] = bool(record.get("recoverable", status != "succeeded"))
    record["requestIds"] = list(dict.fromkeys(
        str(item) for item in record.get("requestIds", []) if str(item)
    ))
    record["completedRequestIds"] = list(dict.fromkeys(
        str(item) for item in record.get("completedRequestIds", []) if str(item)
    ))
    for field in (
        "discoveredAt", "firstAttemptAt", "lastAttemptAt", "completedAt", "updatedAt",
    ):
        record.setdefault(field, None)
    for field in ("failureCode", "failureMessage", "stopReason"):
        record[field] = str(record.get(field) or "")
    return record


def summarize_records(records: dict[str, dict[str, Any]]) -> dict[str, Any]:
    counts = {status: 0 for status in BODY_STATUSES}
    attempted_count = 0
    for record in records.values():
        status = str(record.get("bodyStatus") or record.get("status") or "not_attempted")
        counts[status if status in counts else "not_attempted"] += 1
        if int(record.get("attemptCount") or 0) > 0 or status in {
            "succeeded", "failed", "blocked", "cancelled",
        }:
            attempted_count += 1
    pending_count = counts["discovered"] + counts["queued"] + counts["attempted"]
    terminal_count = sum(counts[status] for status in TERMINAL_STATUSES)
    discovered_count = len(records)
    completion_rate = round(
        (counts["succeeded"] / discovered_count) * 100,
        2,
    ) if discovered_count else 100.0
    return {
        "discoveredCount": discovered_count,
        "attemptedCount": attempted_count,
        "succeededCount": counts["succeeded"],
        "failedCount": counts["failed"],
        "notAttemptedCount": counts["not_attempted"],
        "blockedCount": counts["blocked"],
        "cancelledCount": counts["cancelled"],
        "pendingCount": pending_count,
        "completionRatePercent": completion_rate,
        "statusCounts": counts,
        "conservation": {
            "left": discovered_count,
            "right": terminal_count + pending_count,
            "valid": discovered_count == terminal_count + pending_count,
            "terminal": pending_count == 0 and discovered_count == terminal_count,
            "formula": (
                "discovered = succeeded + failed + not_attempted + blocked + "
                "cancelled + pending"
            ),
        },
    }


def _summary_projection(summary: dict[str, Any], attempted_count: int) -> dict[str, int | float]:
    return {
        "discovered": summary["discoveredCount"],
        "attempted": attempted_count,
        "succeeded": summary["succeededCount"],
        "failed": summary["failedCount"],
        "notAttempted": summary["notAttemptedCount"],
        "blocked": summary["blockedCount"],
        "cancelled": summary["cancelledCount"],
        "pending": summary["pendingCount"],
        "completionRatePercent": summary["completionRatePercent"],
    }


def legacy_summary(records: dict[str, dict[str, Any]]) -> dict[str, int | float]:
    summary = summarize_records(records)
    return _summary_projection(summary, summary["discoveredCount"])


def ledger_summary(records: dict[str, dict[str, Any]]) -> dict[str, int | float]:
    summary = summarize_records(records)
    return _summary_projection(summary, summary["attemptedCount"])


def body_metrics(
    records: dict[str, dict[str, Any]],
    *,
    statistics_source: str,
) -> dict[str, Any]:
    summary = summarize_records(records)
    return {
        "schemaVersion": 1,
        "statisticsSource": statistics_source,
        "legacyInferred": statistics_source == "legacyInferred",
        **_summary_projection(summary, summary["attemptedCount"]),
        "statusCounts": copy.deepcopy(summary["statusCounts"]),
        "conservation": copy.deepcopy(summary["conservation"]),
    }


def load_ledger(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or int(payload.get("schemaVersion") or 0) != LEDGER_SCHEMA_VERSION:
        return None
    raw_records = payload.get("records")
    if not isinstance(raw_records, dict):
        return None
    now = utc_now()
    payload["records"] = {
        str(note_id): normalize_record(str(note_id), record, now)
        for note_id, record in raw_records.items()
        if str(note_id) and isinstance(record, dict)
    }
    raw_excluded = payload.get("scopeExcludedRecords")
    payload["scopeExcludedRecords"] = {
        str(note_id): normalize_record(str(note_id), record, now)
        for note_id, record in (raw_excluded.items() if isinstance(raw_excluded, dict) else ())
        if str(note_id) and isinstance(record, dict)
    }
    statistics_source = str(payload.get("statisticsSource") or "bodyCompletionLedger")
    payload["statisticsSource"] = statistics_source
    payload["legacyInferred"] = statistics_source == "legacyInferred"
    payload["summary"] = summarize_records(payload["records"])
    payload["bodyMetrics"] = body_metrics(
        payload["records"],
        statistics_source=statistics_source,
    )
    return payload


class BodyCompletionLedger:
    def __init__(
        self,
        path: Path,
        payload: dict[str, Any],
        *,
        clock: Callable[[], str] = utc_now,
    ) -> None:
        self.path = path.resolve()
        self._payload = payload
        self._clock = clock
        self._lock = threading.RLock()

    @classmethod
    def open(
        cls,
        output_dir: Path,
        cards: Iterable[dict[str, Any]],
        complete_records: Iterable[dict[str, Any]] = (),
        failures: Iterable[dict[str, Any]] = (),
        *,
        clock: Callable[[], str] = utc_now,
        recover_interrupted: bool = True,
    ) -> "BodyCompletionLedger":
        path = output_dir.resolve() / LEDGER_FILENAME
        loaded = load_ledger(path)
        now = clock()
        cards = list(cards)
        active_ids = {record_key(card) for card in cards if record_key(card)}
        completed_by_id = {
            record_key(item): item for item in complete_records if record_key(item)
        }
        failures_by_id = {
            record_key(item): item for item in failures if record_key(item)
        }
        if loaded is None:
            legacy_inferred = bool(completed_by_id or failures_by_id)
            payload: dict[str, Any] = {
                "schemaVersion": LEDGER_SCHEMA_VERSION,
                "statisticsSource": "legacyInferred" if legacy_inferred else "bodyCompletionLedger",
                "legacyInferred": legacy_inferred,
                "createdAt": now,
                "updatedAt": now,
                "records": {},
                "scopeExcludedRecords": {},
            }
            for card in cards:
                note_id = record_key(card)
                if not note_id or note_id in payload["records"]:
                    continue
                record = _new_record(note_id, now)
                if note_id in completed_by_id:
                    record.update({
                        "bodyStatus": "succeeded",
                        "status": "succeeded",
                        "completedAt": now,
                        "recoverable": False,
                        "stopReason": "legacy_inferred_success",
                    })
                elif note_id in failures_by_id:
                    failure = failures_by_id[note_id]
                    failure_code = str(failure.get("access_status") or "legacy_failure")
                    blocked = "security" in failure_code or "rate_limit" in failure_code
                    record.update({
                        "bodyStatus": "blocked" if blocked else "failed",
                        "status": "blocked" if blocked else "failed",
                        "completedAt": now,
                        "failureCode": failure_code,
                        "failureMessage": str(failure.get("worker_error") or ""),
                        "recoverable": True,
                        "stopReason": "legacy_inferred_failure",
                    })
                payload["records"][note_id] = record
        else:
            payload = loaded
            records = payload["records"]
            excluded_records = payload.setdefault("scopeExcludedRecords", {})
            recovered = False
            for note_id in list(records):
                if note_id in active_ids:
                    continue
                excluded_records[note_id] = records.pop(note_id)
                recovered = True
            for note_id in list(excluded_records):
                if note_id not in active_ids:
                    continue
                records[note_id] = excluded_records.pop(note_id)
                recovered = True
            for note_id, completed in completed_by_id.items():
                record = records.get(note_id)
                if record is None or record["bodyStatus"] == "succeeded":
                    continue
                record.update({
                    "bodyStatus": "succeeded",
                    "status": "succeeded",
                    "completedAt": now,
                    "failureCode": "",
                    "failureMessage": "",
                    "recoverable": False,
                    "stopReason": "cache_reuse",
                    "updatedAt": now,
                })
                recovered = True
            if recover_interrupted:
                for record in records.values():
                    status = record["bodyStatus"]
                    if status == "attempted":
                        record.update({
                            "bodyStatus": "failed",
                            "status": "failed",
                            "completedAt": now,
                            "failureCode": "request_result_missing_after_restart",
                            "failureMessage": "The process ended after the request-start checkpoint.",
                            "recoverable": True,
                            "stopReason": "task_interrupted",
                            "updatedAt": now,
                        })
                        recovered = True
                    elif status in {"queued", "discovered"}:
                        record.update({
                            "bodyStatus": "not_attempted",
                            "status": "not_attempted",
                            "recoverable": True,
                            "stopReason": "task_interrupted",
                            "updatedAt": now,
                        })
                        recovered = True
        ledger = cls(path, payload, clock=clock)
        ledger.discover(cards)
        if loaded is not None and recovered:
            ledger._persist(now)
        return ledger

    @property
    def records(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            return copy.deepcopy(self._payload["records"])

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            self._refresh_derived()
            return copy.deepcopy(self._payload)

    def discover(self, cards: Iterable[dict[str, Any]]) -> None:
        with self._lock:
            now = self._clock()
            changed = False
            for card in cards:
                note_id = record_key(card)
                if note_id and note_id not in self._payload["records"]:
                    self._payload["records"][note_id] = _new_record(note_id, now)
                    changed = True
            if changed or not self.path.exists():
                self._persist(now)

    def can_resume(self, note_id: str) -> bool:
        with self._lock:
            record = self._payload["records"].get(note_id)
            if not isinstance(record, dict):
                return False
            status = record["bodyStatus"]
            if status in {"discovered", "queued", "not_attempted"}:
                return True
            if status == "failed":
                return bool(record.get("recoverable"))
            if status == "blocked":
                return bool(record.get("recoverable")) and record.get("stopReason") in RETRYABLE_BLOCK_REASONS
            return False

    def queue(self, note_ids: Iterable[str]) -> None:
        with self._lock:
            now = self._clock()
            changed = False
            for note_id in note_ids:
                if not self.can_resume(note_id):
                    continue
                record = self._payload["records"][note_id]
                if record["bodyStatus"] != "queued":
                    record.update({
                        "bodyStatus": "queued",
                        "status": "queued",
                        "completedAt": None,
                        "updatedAt": now,
                    })
                    changed = True
            if changed:
                self._persist(now)

    def start_attempt(self, note_id: str, request_id: str) -> bool:
        with self._lock:
            record = self._payload["records"].get(note_id)
            if not isinstance(record, dict) or not self.can_resume(note_id):
                return False
            if request_id in record["requestIds"]:
                return False
            now = self._clock()
            record["requestIds"].append(request_id)
            record.update({
                "bodyStatus": "attempted",
                "status": "attempted",
                "attemptCount": int(record.get("attemptCount") or 0) + 1,
                "firstAttemptAt": record.get("firstAttemptAt") or now,
                "lastAttemptAt": now,
                "completedAt": None,
                "failureCode": "",
                "failureMessage": "",
                "recoverable": True,
                "stopReason": "",
                "updatedAt": now,
                "lastRequestId": request_id,
            })
            self._persist(now)
            return True

    def finish_attempt(
        self,
        note_id: str,
        request_id: str,
        status: str,
        *,
        failure_code: str = "",
        failure_message: str = "",
        recoverable: bool | None = None,
        stop_reason: str = "",
    ) -> bool:
        if status not in {"succeeded", "failed", "blocked", "cancelled"}:
            raise ValueError(f"Unsupported request result status: {status}")
        with self._lock:
            record = self._payload["records"].get(note_id)
            if not isinstance(record, dict):
                raise KeyError(f"Unknown body ledger note: {note_id}")
            if request_id in record["completedRequestIds"]:
                return False
            if request_id not in record["requestIds"]:
                raise ValueError("A request result cannot be recorded before its attempted event")
            if record["bodyStatus"] == "succeeded":
                return False
            now = self._clock()
            record["completedRequestIds"].append(request_id)
            record.update({
                "bodyStatus": status,
                "status": status,
                "completedAt": now,
                "failureCode": "" if status == "succeeded" else str(failure_code or "request_failed"),
                "failureMessage": "" if status == "succeeded" else str(failure_message or ""),
                "recoverable": False if status == "succeeded" else bool(True if recoverable is None else recoverable),
                "stopReason": "" if status == "succeeded" else str(stop_reason or "request_failed"),
                "updatedAt": now,
            })
            self._persist(now)
            return True

    def annotate_terminal(
        self,
        note_id: str,
        *,
        failure_code: str | None = None,
        failure_message: str | None = None,
        recoverable: bool | None = None,
        stop_reason: str | None = None,
    ) -> bool:
        with self._lock:
            record = self._payload["records"].get(note_id)
            if not isinstance(record, dict) or record["bodyStatus"] not in TERMINAL_STATUSES:
                return False
            if record["bodyStatus"] == "succeeded":
                return False
            patch = {
                key: value
                for key, value in {
                    "failureCode": failure_code,
                    "failureMessage": failure_message,
                    "recoverable": recoverable,
                    "stopReason": stop_reason,
                }.items()
                if value is not None
            }
            if not patch or all(record.get(key) == value for key, value in patch.items()):
                return False
            now = self._clock()
            record.update(patch)
            record["updatedAt"] = now
            self._persist(now)
            return True

    def finalize_pending(self, stop_reason: str) -> None:
        with self._lock:
            now = self._clock()
            changed = False
            for record in self._payload["records"].values():
                status = record["bodyStatus"]
                if status in TERMINAL_STATUSES:
                    continue
                if stop_reason == "user_cancelled" and status == "attempted":
                    final_status = "cancelled"
                    failure_code = "user_cancelled"
                    recoverable = True
                elif status == "attempted":
                    final_status = "failed"
                    failure_code = "request_interrupted"
                    recoverable = True
                else:
                    final_status = "not_attempted"
                    failure_code = ""
                    recoverable = True
                record.update({
                    "bodyStatus": final_status,
                    "status": final_status,
                    "completedAt": now if final_status != "not_attempted" else None,
                    "failureCode": failure_code,
                    "failureMessage": "",
                    "recoverable": recoverable,
                    "stopReason": stop_reason,
                    "updatedAt": now,
                })
                changed = True
            if changed:
                self._persist(now)

    def _refresh_derived(self) -> None:
        records = self._payload["records"]
        ledger = ledger_summary(records)
        legacy = legacy_summary(records)
        differences = {
            key: {"legacy": legacy[key], "ledger": ledger[key]}
            for key in ledger
            if ledger[key] != legacy[key]
        }
        statistics_source = str(
            self._payload.get("statisticsSource") or "bodyCompletionLedger"
        )
        self._payload["legacyInferred"] = statistics_source == "legacyInferred"
        self._payload["summary"] = summarize_records(records)
        self._payload["bodyMetrics"] = body_metrics(
            records,
            statistics_source=statistics_source,
        )
        self._payload["shadowComparison"] = {
            "mode": "promoted",
            "promotionFixture": PROMOTION_FIXTURE,
            "legacy": legacy,
            "ledger": ledger,
            "matches": not differences,
            "differences": differences,
        }

    def _persist(self, now: str) -> None:
        self._payload["updatedAt"] = now
        self._refresh_derived()
        _atomic_json(self.path, self._payload)
