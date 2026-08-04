from __future__ import annotations

import json
import os
import sys
import threading
import time
import types
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from unittest import mock

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from body_completion_ledger import (  # noqa: E402
    BODY_STATUSES,
    LEDGER_FILENAME,
    PROMOTION_FIXTURE,
    BodyCompletionLedger,
    load_ledger,
)
import parallel_body_completion as body_completion  # noqa: E402
from run_project_workflow import (  # noqa: E402
    canonical_body_metrics,
    checkpoint_body_summary,
    write_project_manifest,
)


REQUIRED_FIELDS = {
    "noteId",
    "discoveredAt",
    "bodyStatus",
    "attemptCount",
    "firstAttemptAt",
    "lastAttemptAt",
    "completedAt",
    "failureCode",
    "failureMessage",
    "recoverable",
    "stopReason",
    "updatedAt",
}


class StepClock:
    def __init__(self) -> None:
        self.value = 0

    def __call__(self) -> str:
        self.value += 1
        return f"2026-08-01T00:00:{self.value:02d}Z"


def cards(*note_ids: str) -> list[dict[str, str]]:
    return [
        {"note_id": note_id, "note_url": f"https://example.test/explore/{note_id}"}
        for note_id in note_ids
    ]


def test_workflow_progress_counts_are_mutually_exclusive_and_clear_blocked() -> None:
    target_keys = {"done", "blocked", "pending"}
    attempted_keys = {"done", "blocked"}
    outcomes = {"done": "succeeded", "blocked": "blocked"}

    blocked = body_completion.workflow_progress_counts(
        target_keys=target_keys,
        attempted_keys=attempted_keys,
        outcomes=outcomes,
        reused=4,
    )

    assert blocked == {
        "unit": "body",
        "done": 2,
        "total": 3,
        "succeeded": 1,
        "reused": 4,
        "retryable": 1,
        "failed": 0,
        "blocked": 1,
    }
    assert sum(blocked[name] for name in ("succeeded", "retryable", "failed", "blocked")) == 3

    outcomes["blocked"] = "succeeded"
    recovered = body_completion.workflow_progress_counts(
        target_keys=target_keys,
        attempted_keys=attempted_keys,
        outcomes=outcomes,
    )

    assert recovered["succeeded"] == 2
    assert recovered["retryable"] == 1
    assert recovered["failed"] == 0
    assert recovered["blocked"] == 0


def test_workflow_progress_counts_distinguish_retryable_and_terminal_failures() -> None:
    assert body_completion.classify_workflow_outcome(
        succeeded=False,
        failure_code="detail_timeout",
    ) == "retryable"
    assert body_completion.classify_workflow_outcome(
        succeeded=False,
        failure_code="detail_unavailable",
    ) == "failed"

    progress = body_completion.workflow_progress_counts(
        target_keys={"retry", "terminal"},
        attempted_keys={"retry", "terminal"},
        outcomes={"retry": "retryable", "terminal": "failed"},
    )

    assert progress["done"] == 2
    assert progress["retryable"] == 1
    assert progress["failed"] == 1
    assert progress["blocked"] == 0


def test_pending_retry_priority_defers_rate_limited_notes() -> None:
    candidates = cards("rate-limited", "failed", "fresh")
    ledger_records = {
        "rate-limited": {"attemptCount": 3, "failureCode": "detail_rate_limited"},
        "failed": {"attemptCount": 1, "failureCode": "detail_timeout"},
        "fresh": {"attemptCount": 0, "failureCode": ""},
    }

    ordered = sorted(
        candidates,
        key=lambda card: body_completion.pending_retry_priority(card, ledger_records),
    )

    assert [card["note_id"] for card in ordered] == ["fresh", "failed", "rate-limited"]


def test_adaptive_pacer_backs_off_and_recovers_after_stable_successes() -> None:
    pacer = body_completion.AdaptivePacer(enabled=True, max_delay_seconds=20)

    assert pacer.next_delay(
        speed_mode="steady",
        note_delay_seconds=1,
        random_delay_min_seconds=1,
        random_delay_max_seconds=1,
    ) == 1
    pacer.observe(False)
    pacer.observe(False)
    assert pacer.next_delay(
        speed_mode="steady",
        note_delay_seconds=1,
        random_delay_min_seconds=1,
        random_delay_max_seconds=1,
    ) == 4

    for _ in range(5):
        pacer.observe(True)

    assert pacer.snapshot()["failureLevel"] == 1
    assert pacer.next_delay(
        speed_mode="steady",
        note_delay_seconds=1,
        random_delay_min_seconds=1,
        random_delay_max_seconds=1,
    ) == 2


def test_adaptive_pacer_shortens_batch_pause_only_after_clean_streak() -> None:
    pacer = body_completion.AdaptivePacer(enabled=True, max_delay_seconds=20)

    assert pacer.healthy_batch_pause_scale() == 1.0
    for _ in range(12):
        pacer.observe(True)
    assert pacer.healthy_batch_pause_scale() == 0.75
    assert pacer.next_delay(
        speed_mode="steady",
        note_delay_seconds=1,
        random_delay_min_seconds=1,
        random_delay_max_seconds=1,
    ) == 0.75
    for _ in range(12):
        pacer.observe(True)
    assert pacer.healthy_batch_pause_scale() == 0.5
    assert pacer.next_delay(
        speed_mode="steady",
        note_delay_seconds=1,
        random_delay_min_seconds=1,
        random_delay_max_seconds=1,
    ) == 0.5

    pacer.observe(False)
    assert pacer.healthy_batch_pause_scale() == 1.0
    assert pacer.next_delay(
        speed_mode="steady",
        note_delay_seconds=1,
        random_delay_min_seconds=1,
        random_delay_max_seconds=1,
    ) == 2


def test_rate_limit_recovery_escalates_spacing_and_resets_after_stable_successes() -> None:
    recovery = body_completion.RateLimitRecovery(
        initial_delay_seconds=0,
        max_delay_seconds=0,
        max_retries=2,
        recovery_spacing_seconds=5,
        max_recovery_spacing_seconds=20,
        stable_successes=2,
    )

    first = recovery.register_rate_limit()
    assert first == {
        "recoverable": True,
        "attempt": 1,
        "maxRetries": 2,
        "waitSeconds": 0,
    }
    assert recovery.next_spacing() == 5
    assert recovery.observe_success() is False
    assert recovery.observe_success() is True
    assert recovery.next_spacing() == 0

    recovery.register_rate_limit()
    second = recovery.register_rate_limit()
    assert second["recoverable"] is True
    assert second["attempt"] == 2
    assert recovery.next_spacing() == 10
    exhausted = recovery.register_rate_limit()
    assert exhausted["recoverable"] is False
    assert recovery.snapshot()["exhausted"] is True


def test_rate_limit_recovery_warm_start_spaces_a_resumed_throttled_task() -> None:
    clock = {"now": 100.0}
    waits: list[float] = []

    class AdvancingStopEvent:
        @staticmethod
        def is_set() -> bool:
            return False

        @staticmethod
        def wait(timeout: float) -> bool:
            waits.append(timeout)
            clock["now"] += timeout
            return False

    recovery = body_completion.RateLimitRecovery(
        recovery_spacing_seconds=30,
        max_recovery_spacing_seconds=120,
        stable_successes=3,
    )

    with mock.patch.object(body_completion.time, "monotonic", side_effect=lambda: clock["now"]):
        assert recovery.warm_start() is True
        assert recovery.wait_until_probe(AdvancingStopEvent()) is True

    assert sum(waits) == pytest.approx(30)
    assert recovery.next_spacing() == 30
    assert recovery.snapshot()["warmStarted"] is True
    assert recovery.snapshot()["stableSuccesses"] == 3

    for _ in range(2):
        assert recovery.observe_success() is False
    assert recovery.observe_success() is True
    assert recovery.next_spacing() == 0
    assert recovery.snapshot()["warmStarted"] is False


def test_rate_limit_recovery_manual_probe_skips_remaining_cooldown(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    marker = tmp_path / ".rate-limit-recover.request"
    recovery = body_completion.RateLimitRecovery(
        recovery_spacing_seconds=30,
        manual_recovery_path=marker,
    )

    assert recovery.warm_start() is True
    marker.write_text("manual\n", encoding="utf-8")
    started = time.monotonic()
    assert recovery.wait_until_probe(threading.Event()) is True

    assert not marker.exists()
    assert time.monotonic() - started < 1
    assert "BODY_RATE_LIMIT manual_probe attempt=1/6" in capsys.readouterr().out


def test_rate_limit_recovery_warm_start_hands_repeat_limit_back_to_job_manager() -> None:
    recovery = body_completion.RateLimitRecovery(
        initial_delay_seconds=120,
        max_delay_seconds=900,
        max_retries=6,
        recovery_spacing_seconds=30,
        stable_successes=3,
    )

    assert recovery.warm_start() is True
    outcome = recovery.register_rate_limit()

    assert outcome == {
        "recoverable": False,
        "attempt": 1,
        "maxRetries": 6,
        "waitSeconds": 0.0,
    }
    assert recovery.snapshot()["exhausted"] is True


def test_rate_limit_recovery_requires_consecutive_network_successes() -> None:
    recovery = body_completion.RateLimitRecovery(stable_successes=3)

    assert recovery.warm_start() is True
    assert recovery.observe_success() is False
    assert recovery.snapshot()["successStreak"] == 1
    assert recovery.observe_failure() is True
    assert recovery.snapshot()["successStreak"] == 0
    assert recovery.observe_success() is False
    assert recovery.observe_success() is False
    assert recovery.snapshot()["cleared"] is False
    assert recovery.observe_success() is True
    assert recovery.snapshot()["cleared"] is True


def test_rate_limit_summary_does_not_claim_recovery_below_threshold() -> None:
    recovery = body_completion.RateLimitRecovery(stable_successes=3)

    assert recovery.warm_start() is True
    assert recovery.observe_success() is False
    assert recovery.observe_success() is False
    state = recovery.snapshot()

    assert state["successStreak"] == 2
    assert state["cleared"] is False
    assert body_completion.rate_limit_summary_status("", state) == "waiting"
    assert body_completion.rate_limit_summary_status("rate_limited", state) == "stopped"


def test_lightweight_detail_page_blocks_only_heavy_resources() -> None:
    decisions: dict[str, str] = {}

    class FakeRequest:
        def __init__(self, resource_type: str) -> None:
            self.resource_type = resource_type

    class FakeRoute:
        def __init__(self, resource_type: str) -> None:
            self.request = FakeRequest(resource_type)

        def abort(self) -> None:
            decisions[self.request.resource_type] = "abort"

        def continue_(self) -> None:
            decisions[self.request.resource_type] = "continue"

    class FakePage:
        handler = None

        def route(self, pattern: str, handler) -> None:
            assert pattern == "**/*"
            self.handler = handler

    page = FakePage()
    body_completion.configure_lightweight_detail_page(page)
    assert page.handler is not None

    for resource_type in ("image", "media", "font", "script", "xhr", "document"):
        page.handler(FakeRoute(resource_type))

    assert decisions == {
        "image": "abort",
        "media": "abort",
        "font": "abort",
        "script": "continue",
        "xhr": "continue",
        "document": "continue",
    }


def test_body_completion_reuses_complete_bodies_from_sibling_jobs(tmp_path: Path) -> None:
    jobs_root = tmp_path / "data" / "jobs"
    current = jobs_root / "current-job" / "artifacts"
    previous = jobs_root / "previous-job" / "artifacts"
    current.mkdir(parents=True)
    previous.mkdir(parents=True)
    (current / "xiaohongshu_cards_latest.json").write_text(
        json.dumps(cards("n1", "n2")),
        encoding="utf-8",
    )
    (current / "xiaohongshu_notes_latest.json").write_text(
        json.dumps([{
            "note_id": "n1",
            "note_url": "https://example.test/explore/n1",
            "title": "current",
            "body": "current body",
            "access_status": "detail_ok",
        }]),
        encoding="utf-8",
    )
    (previous / "xiaohongshu_notes_latest.json").write_text(
        json.dumps([{
            "note_id": "n2",
            "note_url": "https://example.test/explore/n2",
            "title": "cached",
            "body": "cached full body",
            "access_status": "detail_ok",
            "scraped_at": "2026-08-02T10:00:00",
        }]),
        encoding="utf-8",
    )

    summary = body_completion.complete_bodies(
        current,
        relay_port=18792,
        workers=1,
        attempts=1,
        upstream_scraper=tmp_path / "browser-must-not-start.py",
    )

    notes = json.loads((current / "xiaohongshu_notes_latest.json").read_text(encoding="utf-8"))
    reused = next(record for record in notes if record["note_id"] == "n2")
    ledger = load_ledger(current / LEDGER_FILENAME)
    assert summary["passed"] is True
    assert summary["completeBodies"] == 2
    assert summary["bodyCache"]["reusedBodies"] == 1
    assert summary["bodyCache"]["networkRequestsAvoided"] == 1
    assert reused["body"] == "cached full body"
    assert reused["body_cache_hit"] is True
    assert reused["body_cache_source_job"] == "previous-job"
    assert reused["body_cache_original_scraped_at"] == "2026-08-02T10:00:00"
    assert ledger is not None
    assert ledger["records"]["n2"]["status"] == "succeeded"


def test_body_cache_reuse_excludes_incomplete_and_expired_records(tmp_path: Path) -> None:
    jobs_root = tmp_path / "data" / "jobs"
    current = jobs_root / "current-job" / "artifacts"
    incomplete = jobs_root / "incomplete-job" / "artifacts"
    expired = jobs_root / "expired-job" / "artifacts"
    current.mkdir(parents=True)
    incomplete.mkdir(parents=True)
    expired.mkdir(parents=True)
    incomplete_path = incomplete / "xiaohongshu_notes_latest.json"
    expired_path = expired / "xiaohongshu_notes_latest.json"
    incomplete_path.write_text(
        json.dumps([{
            "note_id": "n1",
            "body": "card text only",
            "access_status": "detail_unavailable",
        }]),
        encoding="utf-8",
    )
    expired_path.write_text(
        json.dumps([{
            "note_id": "n2",
            "body": "old full body",
            "access_status": "detail_ok",
        }]),
        encoding="utf-8",
    )
    old_timestamp = time.time() - (31 * 86400)
    os.utime(expired_path, (old_timestamp, old_timestamp))

    reusable, stats = body_completion.load_reusable_body_records(
        current,
        {"n1", "n2"},
        max_age_days=30,
    )

    assert reusable == {}
    assert stats["eligibleBodies"] == 0


def test_cache_only_recency_scope_reduces_network_queue_and_can_expand(tmp_path: Path) -> None:
    jobs_root = tmp_path / "data" / "jobs"
    current = jobs_root / "current-job" / "artifacts"
    previous = jobs_root / "previous-job" / "artifacts"
    current.mkdir(parents=True)
    previous.mkdir(parents=True)
    scoped_cards = [
        {**cards("recent")[0], "publish_time": "08-01"},
        {**cards("cached")[0], "publish_time": "07-31"},
        {**cards("old")[0], "publish_time": "07-01"},
        {**cards("unknown")[0], "publish_time": ""},
    ]
    cards_path = current / "xiaohongshu_cards_latest.json"
    cards_path.write_text(json.dumps(scoped_cards), encoding="utf-8")
    collected_at = datetime(2026, 8, 2, 12, 0).timestamp()
    os.utime(cards_path, (collected_at, collected_at))
    (current / "xiaohongshu_notes_latest.json").write_text(
        json.dumps([{
            "note_id": "recent",
            "note_url": "https://example.test/explore/recent",
            "title": "current",
            "body": "current body",
            "access_status": "detail_ok",
        }]),
        encoding="utf-8",
    )
    (previous / "xiaohongshu_notes_latest.json").write_text(
        json.dumps([{
            "note_id": "cached",
            "note_url": "https://example.test/explore/cached",
            "title": "cached",
            "body": "cached body",
            "access_status": "detail_ok",
        }]),
        encoding="utf-8",
    )
    BodyCompletionLedger.open(current, scoped_cards)

    summary = body_completion.complete_bodies(
        current,
        relay_port=18792,
        max_age_days=14,
        cache_only=True,
        upstream_scraper=tmp_path / "browser-must-not-start.py",
    )

    assert summary["scope"]["maxAgeDays"] == 14
    assert summary["scope"]["sourceCards"] == 4
    assert summary["scope"]["eligibleCards"] == 3
    assert summary["scope"]["excludedOlderCards"] == 1
    assert summary["scope"]["unknownDateCards"] == 1
    assert summary["scope"]["referenceTime"].startswith("2026-08-02T12:00:00")
    assert summary["scope"]["outOfScopeArtifact"] == "xiaohongshu_cards_out_of_scope.json"
    assert summary["completeBodies"] == 2
    assert summary["missingBodies"] == 1
    assert summary["bodyCache"]["networkRequestsAvoided"] == 1
    assert summary["bodySucceeded"] == 2
    assert summary["bodyNotAttempted"] == 1
    assert [item["note_id"] for item in json.loads(cards_path.read_text(encoding="utf-8"))] == [
        "recent", "cached", "unknown",
    ]
    assert [item["note_id"] for item in json.loads((current / "xiaohongshu_cards_out_of_scope.json").read_text(encoding="utf-8"))] == ["old"]

    expanded = body_completion.complete_bodies(
        current,
        relay_port=18792,
        max_age_days=0,
        cache_only=True,
        upstream_scraper=tmp_path / "browser-must-not-start.py",
    )
    assert expanded["cards"] == 4
    assert expanded["scope"]["excludedOlderCards"] == 0
    assert not (current / "xiaohongshu_cards_out_of_scope.json").exists()


def finish(
    ledger: BodyCompletionLedger,
    note_id: str,
    status: str,
    *,
    reason: str = "request_failed",
    recoverable: bool = True,
) -> None:
    request_id = f"request-{note_id}"
    assert ledger.start_attempt(note_id, request_id)
    assert ledger.finish_attempt(
        note_id,
        request_id,
        status,
        failure_code="" if status == "succeeded" else reason,
        recoverable=recoverable,
        stop_reason="" if status == "succeeded" else reason,
    )


def test_discovery_creates_one_durable_record_per_unique_note(tmp_path: Path) -> None:
    ledger = BodyCompletionLedger.open(
        tmp_path,
        [*cards("n1", "n2"), {"note_id": "n1", "title": "duplicate"}],
        clock=StepClock(),
    )

    payload = ledger.snapshot()
    assert set(payload["records"]) == {"n1", "n2"}
    assert set(payload["records"]["n1"]) >= REQUIRED_FIELDS
    assert {item["bodyStatus"] for item in payload["records"].values()} == {"discovered"}
    assert payload["summary"]["attemptedCount"] == 0
    assert payload["summary"]["conservation"]["valid"] is True
    assert (tmp_path / LEDGER_FILENAME).is_file()


def test_progress_counts_only_cards_with_real_attempts() -> None:
    assert body_completion.processed_attempt_count(
        ["completed", "failed", "pending-a", "pending-b"],
        {"completed", "failed", "outside-task"},
    ) == 2


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"access_status": "detail_playwright_error"}, True),
        ({
            "access_status": "detail_worker_error",
            "worker_error": "Target page, context or browser has been closed",
        }, True),
        ({"access_status": "detail_rate_limited"}, False),
        ({"access_status": "detail_note_mismatch"}, False),
        ({"access_status": "detail_empty"}, False),
    ],
)
def test_fresh_page_retry_only_handles_recoverable_browser_failures(
    payload: dict[str, str],
    expected: bool,
) -> None:
    assert body_completion.should_retry_on_fresh_page(payload) is expected


@pytest.mark.parametrize(
    ("payload", "payload_complete", "page_uses", "expected"),
    [
        ({"access_status": "detail_empty"}, False, 1, ""),
        ({"access_status": "detail_rate_limited"}, False, 1, ""),
        (
            {
                "access_status": "detail_worker_error",
                "worker_error": "Target page, context or browser has been closed",
            },
            False,
            1,
            "unhealthy_page",
        ),
        ({"access_status": "detail_ok"}, True, 40, "scheduled"),
    ],
)
def test_page_recycle_only_runs_on_unhealthy_or_scheduled_boundaries(
    payload: dict[str, str],
    payload_complete: bool,
    page_uses: int,
    expected: str,
) -> None:
    assert body_completion.page_recycle_reason(
        payload,
        payload_complete=payload_complete,
        page_uses=page_uses,
        page_recycle_every=40,
    ) == expected


@pytest.mark.parametrize(
    "record",
    [
        {"note_id": "stable-note"},
        {"note_url": "https://example.test/explore/stable-note?xsec_token=old"},
        {"search_result_url": "https://example.test/search_result/stable-note?xsec_token=new"},
        {"explore_url": "https://example.test/discovery/item/stable-note?source=web"},
        {"note_url": "https://example.test/detail?note_id=stable-note&token=volatile"},
    ],
)
def test_record_key_uses_stable_note_id_across_signed_url_variants(record: dict[str, str]) -> None:
    assert body_completion.record_key(record) == "stable-note"


def test_record_key_strips_volatile_query_when_only_a_generic_url_exists() -> None:
    left = body_completion.record_key(
        {"note_url": "https://EXAMPLE.test/detail/path?xsec_token=old#fragment"}
    )
    right = body_completion.record_key(
        {"note_url": "https://example.test/detail/path?xsec_token=new"}
    )

    assert left == "https://example.test/detail/path"
    assert right == left


def test_ledger_migrates_signed_url_keys_before_resume(tmp_path: Path) -> None:
    old_url = "https://example.test/explore/stable-note?xsec_token=old"
    legacy = BodyCompletionLedger.open(tmp_path, [{"note_url": old_url}])
    assert legacy.start_attempt(old_url, "legacy-request")
    assert legacy.finish_attempt(
        old_url,
        "legacy-request",
        "failed",
        failure_code="detail_timeout",
        recoverable=True,
    )

    resumed = BodyCompletionLedger.open(
        tmp_path,
        [{"note_url": "https://example.test/search_result/stable-note?xsec_token=new"}],
        key_resolver=body_completion.record_key,
    )

    assert set(resumed.records) == {"stable-note"}
    assert resumed.records["stable-note"]["attemptCount"] == 1
    assert resumed.start_attempt("stable-note", "resumed-request")


def test_request_start_is_persisted_before_result_and_duplicate_events_are_idempotent(
    tmp_path: Path,
) -> None:
    ledger = BodyCompletionLedger.open(tmp_path, cards("n1"), clock=StepClock())
    assert ledger.start_attempt("n1", "request-1")
    persisted = load_ledger(tmp_path / LEDGER_FILENAME)
    assert persisted is not None
    assert persisted["records"]["n1"]["bodyStatus"] == "attempted"
    assert persisted["records"]["n1"]["attemptCount"] == 1

    assert ledger.start_attempt("n1", "request-1") is False
    assert ledger.finish_attempt("n1", "request-1", "succeeded", recoverable=False)
    assert ledger.finish_attempt("n1", "request-1", "succeeded", recoverable=False) is False
    assert ledger.start_attempt("n1", "request-after-success") is False
    record = ledger.snapshot()["records"]["n1"]
    assert record["bodyStatus"] == "succeeded"
    assert record["attemptCount"] == 1
    assert ledger.can_resume("n1") is False


def test_result_cannot_be_recorded_before_request_start(tmp_path: Path) -> None:
    ledger = BodyCompletionLedger.open(tmp_path, cards("n1"))
    with pytest.raises(ValueError, match="before its attempted event"):
        ledger.finish_attempt("n1", "missing-request", "failed")


def test_user_cancel_only_cancels_an_in_flight_request(tmp_path: Path) -> None:
    ledger = BodyCompletionLedger.open(tmp_path, cards("in-flight", "queued", "unseen"))
    ledger.queue(["in-flight", "queued"])
    assert ledger.start_attempt("in-flight", "request-in-flight")

    ledger.finalize_pending("user_cancelled")

    records = ledger.records
    assert records["in-flight"]["bodyStatus"] == "cancelled"
    assert records["in-flight"]["attemptCount"] == 1
    assert records["queued"]["bodyStatus"] == "not_attempted"
    assert records["queued"]["attemptCount"] == 0
    assert records["unseen"]["bodyStatus"] == "not_attempted"
    assert records["unseen"]["attemptCount"] == 0
    assert all(record["stopReason"] == "user_cancelled" for record in records.values())


def test_terminal_statuses_obey_conservation_and_keep_distinct_stop_reasons(tmp_path: Path) -> None:
    ledger = BodyCompletionLedger.open(tmp_path, cards("ok", "failed", "blocked", "cancelled", "limit"))
    finish(ledger, "ok", "succeeded", recoverable=False)
    finish(ledger, "failed", "failed", reason="request_timeout")
    finish(ledger, "blocked", "blocked", reason="security_verification")
    finish(ledger, "cancelled", "cancelled", reason="user_cancelled")
    ledger.finalize_pending("attempt_limit_reached")

    payload = ledger.snapshot()
    summary = payload["summary"]
    assert summary["statusCounts"] == {
        "discovered": 0,
        "queued": 0,
        "attempted": 0,
        "succeeded": 1,
        "failed": 1,
        "not_attempted": 1,
        "blocked": 1,
        "cancelled": 1,
    }
    assert summary["conservation"] == {
        "left": 5,
        "right": 5,
        "valid": True,
        "terminal": True,
        "formula": "discovered = succeeded + failed + not_attempted + blocked + cancelled + pending",
    }
    records = payload["records"]
    assert records["failed"]["stopReason"] == "request_timeout"
    assert records["blocked"]["stopReason"] == "security_verification"
    assert records["cancelled"]["stopReason"] == "user_cancelled"
    assert records["limit"]["stopReason"] == "attempt_limit_reached"


def test_resume_selects_only_unattempted_recoverable_failures_and_retryable_blocks(
    tmp_path: Path,
) -> None:
    ledger = BodyCompletionLedger.open(
        tmp_path,
        cards("unattempted", "retry-failure", "fatal-failure", "security", "policy", "done"),
    )
    finish(ledger, "retry-failure", "failed", recoverable=True)
    finish(ledger, "fatal-failure", "failed", recoverable=False)
    finish(ledger, "security", "blocked", reason="security_verification", recoverable=True)
    finish(ledger, "policy", "blocked", reason="policy_block", recoverable=True)
    finish(ledger, "done", "succeeded", recoverable=False)

    eligible = {note_id for note_id in ledger.records if ledger.can_resume(note_id)}
    assert eligible == {"unattempted", "retry-failure", "security"}
    assert ledger.start_attempt("fatal-failure", "request-after-fatal") is False
    assert ledger.start_attempt("policy", "request-after-policy-block") is False


def test_restart_recovers_in_flight_and_queued_records_without_double_counting(tmp_path: Path) -> None:
    first = BodyCompletionLedger.open(tmp_path, cards("in-flight", "queued", "done"))
    first.queue(["in-flight", "queued", "done"])
    assert first.start_attempt("in-flight", "request-in-flight")
    finish(first, "done", "succeeded", recoverable=False)

    restarted = BodyCompletionLedger.open(tmp_path, cards("in-flight", "queued", "done"))
    records = restarted.records
    assert records["in-flight"]["bodyStatus"] == "failed"
    assert records["in-flight"]["stopReason"] == "task_interrupted"
    assert records["in-flight"]["attemptCount"] == 1
    assert records["queued"]["bodyStatus"] == "not_attempted"
    assert records["done"]["bodyStatus"] == "succeeded"
    assert restarted.can_resume("in-flight")
    assert restarted.can_resume("queued")
    assert not restarted.can_resume("done")

    restarted_again = BodyCompletionLedger.open(tmp_path, cards("in-flight", "queued", "done"))
    assert restarted_again.records["in-flight"]["attemptCount"] == 1


def test_scope_change_archives_and_restores_ledger_records(tmp_path: Path) -> None:
    all_cards = cards("recent", "old")
    initial = BodyCompletionLedger.open(tmp_path, all_cards)
    finish(initial, "old", "failed", reason="detail_timeout", recoverable=True)

    scoped = BodyCompletionLedger.open(tmp_path, cards("recent"))
    scoped_payload = scoped.snapshot()
    assert set(scoped_payload["records"]) == {"recent"}
    assert scoped_payload["summary"]["discoveredCount"] == 1
    assert scoped_payload["scopeExcludedRecords"]["old"]["attemptCount"] == 1

    restored = BodyCompletionLedger.open(tmp_path, all_cards)
    restored_payload = restored.snapshot()
    assert set(restored_payload["records"]) == {"recent", "old"}
    assert restored_payload["records"]["old"]["bodyStatus"] == "failed"
    assert restored_payload["records"]["old"]["attemptCount"] == 1
    assert restored_payload["scopeExcludedRecords"] == {}


def test_discovery_observer_does_not_reclassify_live_attempt(tmp_path: Path) -> None:
    ledger = BodyCompletionLedger.open(tmp_path, cards("n1"))
    assert ledger.start_attempt("n1", "request-1")
    observed = BodyCompletionLedger.open(
        tmp_path,
        cards("n1", "n2"),
        recover_interrupted=False,
    )
    assert observed.records["n1"]["bodyStatus"] == "attempted"
    assert observed.records["n2"]["bodyStatus"] == "discovered"


def test_legacy_job_exposes_an_explicitly_inferred_attempt_lower_bound(tmp_path: Path) -> None:
    legacy_notes = [{"note_id": "ok", "body": "full body", "access_status": "detail_ok"}]
    legacy_failures = [{"note_id": "failed", "access_status": "detail_timeout"}]
    ledger = BodyCompletionLedger.open(
        tmp_path,
        cards("ok", "failed", "missing"),
        legacy_notes,
        legacy_failures,
    )

    payload = ledger.snapshot()
    assert payload["statisticsSource"] == "legacyInferred"
    assert payload["legacyInferred"] is True
    assert payload["bodyMetrics"]["legacyInferred"] is True
    assert payload["summary"]["attemptedCount"] == 2
    assert payload["records"]["ok"]["bodyStatus"] == "succeeded"
    assert payload["records"]["failed"]["bodyStatus"] == "failed"
    assert payload["records"]["missing"]["bodyStatus"] == "discovered"


def test_shadow_comparison_records_expected_legacy_difference(tmp_path: Path) -> None:
    ledger = BodyCompletionLedger.open(tmp_path, cards("attempted", "not-attempted"))
    finish(ledger, "attempted", "failed")
    ledger.finalize_pending("attempt_limit_reached")

    shadow = ledger.snapshot()["shadowComparison"]
    assert shadow["mode"] == "promoted"
    assert shadow["promotionFixture"] == PROMOTION_FIXTURE
    assert shadow["legacy"]["attempted"] == 2
    assert shadow["ledger"]["attempted"] == 1
    for field in (
        "discovered", "succeeded", "failed", "notAttempted", "blocked",
        "cancelled", "pending", "completionRatePercent",
    ):
        assert shadow["legacy"][field] == shadow["ledger"][field]
    assert shadow["matches"] is False


def test_formal_metrics_use_ledger_counts_and_legacy_metrics_are_explicit() -> None:
    exact = canonical_body_metrics({
        "statisticsSource": "bodyCompletionLedger",
        "bodyCompletionLedger": {
            "summary": {
                "discoveredCount": 7,
                "attemptedCount": 4,
                "succeededCount": 2,
                "failedCount": 1,
                "notAttemptedCount": 1,
                "blockedCount": 1,
                "cancelledCount": 1,
                "pendingCount": 1,
            },
        },
    }, {"discovered_count": 99, "body_count": 88})
    assert exact == {
        "schemaVersion": 1,
        "statisticsSource": "bodyCompletionLedger",
        "legacyInferred": False,
        "discovered": 7,
        "attempted": 4,
        "succeeded": 2,
        "failed": 1,
        "notAttempted": 1,
        "blocked": 1,
        "cancelled": 1,
        "pending": 1,
        "completionRatePercent": 28.57,
        "statusCounts": {},
        "conservation": {
            "left": 7,
            "right": 7,
            "valid": True,
            "terminal": False,
            "formula": "discovered = succeeded + failed + not_attempted + blocked + cancelled + pending",
        },
    }

    legacy = canonical_body_metrics(
        {
            "cardsDiscovered": 4,
            "bodyAttempted": 0,
            "bodySucceeded": 2,
            "bodyCancelled": 1,
        },
        {"discovered_count": 4, "body_count": 2},
    )
    assert legacy["legacyInferred"] is True
    assert legacy["statisticsSource"] == "legacyInferred"
    assert legacy["attempted"] == 3
    assert legacy["notAttempted"] == 1
    assert legacy["conservation"]["valid"] is True


def test_ledger_is_exposed_in_summary_and_artifact_manifest(tmp_path: Path) -> None:
    (tmp_path / "xiaohongshu_cards_latest.json").write_text(
        json.dumps(cards("n1", "n2")),
        encoding="utf-8",
    )
    (tmp_path / "xiaohongshu_notes_latest.json").write_text("[]", encoding="utf-8")
    ledger = BodyCompletionLedger.open(tmp_path, cards("n1", "n2"))
    ledger.finalize_pending("attempt_limit_reached")

    summary = checkpoint_body_summary(tmp_path, stop_reason="checkpoint_reused")
    assert summary["statisticsSource"] == "bodyCompletionLedger"
    assert summary["legacyInferred"] is False
    assert summary["bodyMetrics"]["conservation"]["valid"] is True
    assert summary["bodyAttempted"] == 0
    assert summary["bodyNotAttempted"] == 2
    summary.update({
        "status": "completed_partial",
        "checks": {},
        "notesCollected": 0,
        "bodiesCaptured": 0,
        "issues": [],
    })
    manifest = json.loads(write_project_manifest(tmp_path, summary).read_text(encoding="utf-8"))
    artifact = next(item for item in manifest["artifacts"] if item["path"] == LEDGER_FILENAME)
    assert artifact["bytes"] > 0
    assert len(artifact["sha256"]) == 64


@dataclass
class FakeNote:
    note_id: str
    note_url: str
    title: str
    body: str
    access_status: str
    source_marker: str


def test_body_completion_warm_start_gates_the_first_resumed_request(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    scrape_calls: list[str] = []
    probe_states: list[tuple[bool, float]] = []

    class FakePage:
        def close(self) -> None:
            return None

    class FakeContext:
        def new_page(self) -> FakePage:
            return FakePage()

    class FakePlaywright:
        def __enter__(self):
            return object()

        def __exit__(self, *_args):
            return False

    class FakeUpstream:
        @staticmethod
        def connect_browser(_playwright, _relay_port: int):
            return object()

        @staticmethod
        def get_or_create_context(_browser):
            return FakeContext()

        @staticmethod
        def scrape_note(_page, card, **_kwargs):
            assert probe_states
            scrape_calls.append(card["note_id"])
            return FakeNote(
                note_id=card["note_id"],
                note_url=card["note_url"],
                title="recovered",
                body=f"full body for {card['note_id']}",
                access_status="detail_ok",
                source_marker="warm-start-fixture",
            )

    playwright_package = types.ModuleType("playwright")
    playwright_sync = types.ModuleType("playwright.sync_api")
    playwright_sync.sync_playwright = FakePlaywright
    (tmp_path / "xiaohongshu_cards_latest.json").write_text(
        json.dumps(cards("n1", "n2", "n3")),
        encoding="utf-8",
    )
    (tmp_path / "parallel-body-summary.json").write_text(
        json.dumps({
            "stopReason": "rate_limited",
            "rateLimit": {"status": "stopped", "exhausted": True},
        }),
        encoding="utf-8",
    )

    original_wait_until_probe = body_completion.RateLimitRecovery.wait_until_probe

    def advance_probe(self, stop_event) -> bool:
        with self._lock:
            remaining = max(0.0, self.blocked_until - time.monotonic())
            probe_states.append((self.warm_started, remaining))
            self.blocked_until = time.monotonic()
            self.recovery_spacing_seconds = 0.0
            self.max_recovery_spacing_seconds = 0.0
        return original_wait_until_probe(self, stop_event)

    with mock.patch.object(body_completion, "load_upstream", return_value=FakeUpstream()), mock.patch.object(
        body_completion.RateLimitRecovery,
        "wait_until_probe",
        advance_probe,
    ), mock.patch.dict(
        sys.modules,
        {"playwright": playwright_package, "playwright.sync_api": playwright_sync},
    ):
        summary = body_completion.complete_bodies(
            tmp_path,
            relay_port=18792,
            workers=1,
            attempts=1,
            speed_mode="steady",
            note_delay_seconds=0,
            rate_limit_auto_recovery=True,
            rate_limit_recovery_spacing_seconds=30,
            rate_limit_max_recovery_spacing_seconds=120,
            rate_limit_stable_successes=3,
            reuse_body_cache=False,
            upstream_scraper=tmp_path / "fake-upstream.py",
        )

    output = capsys.readouterr().out
    assert probe_states[0][0] is True
    assert 0 < probe_states[0][1] <= 30
    assert scrape_calls == ["n1", "n2", "n3"]
    assert "BODY_RATE_LIMIT warm-start attempt=1/6 spacing=30.0s stable_successes=3" in output
    assert summary["rateLimit"]["status"] == "cleared"
    assert summary["rateLimit"]["resumedFromRateLimit"] is True


def test_body_completion_keeps_relay_call_path_fields_and_success_resume_idempotent(
    tmp_path: Path,
) -> None:
    requested_paths: list[Path] = []
    scrape_calls: list[str] = []

    class FakePage:
        def close(self) -> None:
            return None

    class FakeContext:
        def new_page(self) -> FakePage:
            return FakePage()

    class FakePlaywright:
        def __enter__(self):
            return object()

        def __exit__(self, *_args):
            return False

    class FakeUpstream:
        @staticmethod
        def connect_browser(_playwright, relay_port: int):
            assert relay_port == 18792
            return object()

        @staticmethod
        def get_or_create_context(_browser):
            return FakeContext()

        @staticmethod
        def scrape_note(_page, card, **kwargs):
            scrape_calls.append(card["note_id"])
            assert kwargs["goto_timeout_ms"] == 4321
            attempted = load_ledger(tmp_path / LEDGER_FILENAME)
            assert attempted is not None
            assert attempted["records"][card["note_id"]]["bodyStatus"] == "attempted"
            return FakeNote(
                note_id=card["note_id"],
                note_url=card["note_url"],
                title="preserved title",
                body="preserved full body",
                access_status="detail_ok",
                source_marker="relay-production-shape",
            )

    def load_fake(path: Path):
        requested_paths.append(path)
        return FakeUpstream()

    playwright_package = types.ModuleType("playwright")
    playwright_sync = types.ModuleType("playwright.sync_api")
    playwright_sync.sync_playwright = FakePlaywright
    (tmp_path / "xiaohongshu_cards_latest.json").write_text(
        json.dumps(cards("n1")),
        encoding="utf-8",
    )
    upstream_path = tmp_path / "relay-production.py"
    with mock.patch.object(body_completion, "load_upstream", side_effect=load_fake), mock.patch.dict(
        sys.modules,
        {"playwright": playwright_package, "playwright.sync_api": playwright_sync},
    ):
        first = body_completion.complete_bodies(
            tmp_path,
            relay_port=18792,
            workers=1,
            attempts=1,
            goto_timeout_ms=4321,
            speed_mode="steady",
            note_delay_seconds=0,
            upstream_scraper=upstream_path,
        )
        second = body_completion.complete_bodies(
            tmp_path,
            relay_port=18792,
            workers=1,
            attempts=1,
            goto_timeout_ms=4321,
            speed_mode="steady",
            note_delay_seconds=0,
            upstream_scraper=upstream_path,
        )

    assert requested_paths == [upstream_path]
    assert scrape_calls == ["n1"]
    assert first["bodyAttempted"] == second["bodyAttempted"] == 1
    assert first["bodySucceeded"] == second["bodySucceeded"] == 1
    assert second["passed"] is True
    notes = json.loads((tmp_path / "xiaohongshu_notes_latest.json").read_text(encoding="utf-8"))
    assert notes == [{
        "note_id": "n1",
        "note_url": "https://example.test/explore/n1",
        "title": "preserved title",
        "body": "preserved full body",
        "access_status": "detail_ok",
        "source_marker": "relay-production-shape",
    }]
    assert set(first["bodyCompletionLedger"]) == {
        "schemaVersion", "artifact", "summary", "shadowComparison",
    }
    assert set(BODY_STATUSES) == {
        "discovered", "queued", "attempted", "succeeded", "failed",
        "not_attempted", "blocked", "cancelled",
    }


def test_body_completion_retries_same_card_after_playwright_page_failure(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    scrape_calls: list[str] = []
    created_pages: list[object] = []

    class FakePage:
        def close(self) -> None:
            return None

    class FakeContext:
        def new_page(self) -> FakePage:
            page = FakePage()
            created_pages.append(page)
            return page

    class FakePlaywright:
        def __enter__(self):
            return object()

        def __exit__(self, *_args):
            return False

    class FakeUpstream:
        @staticmethod
        def connect_browser(_playwright, _relay_port: int):
            return object()

        @staticmethod
        def get_or_create_context(_browser):
            return FakeContext()

        @staticmethod
        def scrape_note(_page, card, **_kwargs):
            scrape_calls.append(card["note_id"])
            if len(scrape_calls) == 1:
                return FakeNote(
                    note_id=card["note_id"],
                    note_url=card["note_url"],
                    title="retry me",
                    body="",
                    access_status="detail_playwright_error",
                    source_marker="closed-page",
                )
            return FakeNote(
                note_id=card["note_id"],
                note_url=card["note_url"],
                title="recovered",
                body="full body after page recreation",
                access_status="detail_ok",
                source_marker="fresh-page",
            )

    playwright_package = types.ModuleType("playwright")
    playwright_sync = types.ModuleType("playwright.sync_api")
    playwright_sync.sync_playwright = FakePlaywright
    (tmp_path / "xiaohongshu_cards_latest.json").write_text(
        json.dumps(cards("n1")),
        encoding="utf-8",
    )
    with mock.patch.object(body_completion, "load_upstream", return_value=FakeUpstream()), mock.patch.dict(
        sys.modules,
        {"playwright": playwright_package, "playwright.sync_api": playwright_sync},
    ):
        summary = body_completion.complete_bodies(
            tmp_path,
            relay_port=18792,
            workers=1,
            attempts=1,
            speed_mode="steady",
            note_delay_seconds=0,
            upstream_scraper=tmp_path / "fake-upstream.py",
        )

    output = capsys.readouterr().out
    assert scrape_calls == ["n1", "n1"]
    assert len(created_pages) == 2
    assert "PARALLEL_RETRY note=n1 reason=page_closed attempt=1/1" in output
    assert "PARALLEL_PROGRESS processed=1 total=1 complete=1" in output
    assert summary["bodyAttempted"] == 1
    assert summary["bodySucceeded"] == 1
    assert summary["passed"] is True


def test_failed_retry_reuses_the_replacement_page_without_second_recycle(
    tmp_path: Path,
) -> None:
    created_pages: list[object] = []
    scrape_calls = 0

    class FakeBody:
        def inner_text(self, **_kwargs) -> str:
            return ""

    class FakePage:
        def close(self) -> None:
            return None

        def locator(self, selector: str) -> FakeBody:
            assert selector == "body"
            return FakeBody()

    class FakeContext:
        def new_page(self) -> FakePage:
            page = FakePage()
            created_pages.append(page)
            return page

    class FakePlaywright:
        def __enter__(self):
            return object()

        def __exit__(self, *_args):
            return False

    class FakeUpstream:
        @staticmethod
        def connect_browser(_playwright, _relay_port: int):
            return object()

        @staticmethod
        def get_or_create_context(_browser):
            return FakeContext()

        @staticmethod
        def scrape_note(_page, card, **_kwargs):
            nonlocal scrape_calls
            scrape_calls += 1
            return FakeNote(
                note_id=card["note_id"],
                note_url=card["note_url"],
                title="still unavailable",
                body="",
                access_status=("detail_playwright_error" if scrape_calls == 1 else "detail_empty"),
                source_marker="fixture",
            )

    playwright_package = types.ModuleType("playwright")
    playwright_sync = types.ModuleType("playwright.sync_api")
    playwright_sync.sync_playwright = FakePlaywright
    (tmp_path / "xiaohongshu_cards_latest.json").write_text(
        json.dumps(cards("n1")),
        encoding="utf-8",
    )

    with mock.patch.object(body_completion, "load_upstream", return_value=FakeUpstream()), mock.patch.dict(
        sys.modules,
        {"playwright": playwright_package, "playwright.sync_api": playwright_sync},
    ):
        summary = body_completion.complete_bodies(
            tmp_path,
            relay_port=18792,
            workers=1,
            attempts=1,
            speed_mode="steady",
            note_delay_seconds=0,
            upstream_scraper=tmp_path / "fake-upstream.py",
        )

    assert scrape_calls == 2
    assert len(created_pages) == 2
    assert summary["bodyFailed"] == 1


def test_body_completion_recovers_rate_limit_inside_same_task(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    scrape_calls: list[str] = []

    class FakePage:
        def close(self) -> None:
            return None

    class FakeContext:
        def new_page(self) -> FakePage:
            return FakePage()

    class FakePlaywright:
        def __enter__(self):
            return object()

        def __exit__(self, *_args):
            return False

    class FakeUpstream:
        @staticmethod
        def connect_browser(_playwright, _relay_port: int):
            return object()

        @staticmethod
        def get_or_create_context(_browser):
            return FakeContext()

        @staticmethod
        def scrape_note(_page, card, **_kwargs):
            note_id = card["note_id"]
            scrape_calls.append(note_id)
            if note_id == "n1" and scrape_calls.count("n1") == 1:
                return FakeNote(
                    note_id=note_id,
                    note_url=card["note_url"],
                    title="rate limited",
                    body="",
                    access_status="detail_rate_limited",
                    source_marker="fixture",
                )
            return FakeNote(
                note_id=note_id,
                note_url=card["note_url"],
                title="recovered",
                body=f"full body for {note_id}",
                access_status="detail_ok",
                source_marker="fixture",
            )

    playwright_package = types.ModuleType("playwright")
    playwright_sync = types.ModuleType("playwright.sync_api")
    playwright_sync.sync_playwright = FakePlaywright
    (tmp_path / "xiaohongshu_cards_latest.json").write_text(
        json.dumps(cards("n1", "n2")),
        encoding="utf-8",
    )

    with mock.patch.object(body_completion, "load_upstream", return_value=FakeUpstream()), mock.patch.dict(
        sys.modules,
        {"playwright": playwright_package, "playwright.sync_api": playwright_sync},
    ):
        summary = body_completion.complete_bodies(
            tmp_path,
            relay_port=18792,
            workers=1,
            attempts=1,
            speed_mode="steady",
            note_delay_seconds=0,
            rate_limit_initial_delay_seconds=0,
            rate_limit_max_delay_seconds=0,
            rate_limit_recovery_spacing_seconds=0,
            rate_limit_max_recovery_spacing_seconds=0,
            rate_limit_stable_successes=1,
            rate_limit_auto_recovery=True,
            upstream_scraper=tmp_path / "fake-upstream.py",
        )

    output = capsys.readouterr().out
    ledger = load_ledger(tmp_path / LEDGER_FILENAME)
    assert scrape_calls == ["n1", "n2", "n1"]
    assert "BODY_RATE_LIMIT cooldown attempt=1/6 wait=0.0s note=n1" in output
    assert "BODY_RATE_LIMIT probe attempt=1/6" in output
    assert "BODY_RATE_LIMIT cleared stable_successes=1" in output
    assert "RATE_LIMIT detected; stopping" not in output
    assert summary["passed"] is True
    assert summary["rateLimit"]["status"] == "cleared"
    assert summary["rateLimit"]["detectedCount"] == 1
    assert summary["queueConsumptionStopped"] is False
    assert ledger is not None
    assert ledger["records"]["n1"]["attemptCount"] == 2
    assert ledger["records"]["n2"]["attemptCount"] == 1


def test_body_completion_delegates_url_fallback_once_to_upstream(tmp_path: Path) -> None:
    scrape_calls: list[dict[str, str]] = []

    class FakePage:
        def close(self) -> None:
            return None

    class FakeContext:
        def new_page(self) -> FakePage:
            return FakePage()

    class FakePlaywright:
        def __enter__(self):
            return object()

        def __exit__(self, *_args):
            return False

    class FakeUpstream:
        @staticmethod
        def connect_browser(_playwright, _relay_port: int):
            return object()

        @staticmethod
        def get_or_create_context(_browser):
            return FakeContext()

        @staticmethod
        def scrape_note(_page, card, **_kwargs):
            scrape_calls.append(card)
            return FakeNote(
                note_id=card["note_id"],
                note_url=card["note_url"],
                title="unavailable",
                body="",
                access_status="detail_unavailable",
                source_marker="upstream-owned-fallback",
            )

    playwright_package = types.ModuleType("playwright")
    playwright_sync = types.ModuleType("playwright.sync_api")
    playwright_sync.sync_playwright = FakePlaywright
    imported = [{
        "note_id": "n1",
        "search_result_url": "https://example.test/search_result/n1?xsec_token=token",
        "note_url": "https://example.test/search_result/n1?xsec_token=token",
        "explore_url": "https://example.test/explore/n1",
    }]
    (tmp_path / "xiaohongshu_cards_latest.json").write_text(json.dumps(imported), encoding="utf-8")

    with mock.patch.object(body_completion, "load_upstream", return_value=FakeUpstream()), mock.patch.dict(
        sys.modules,
        {"playwright": playwright_package, "playwright.sync_api": playwright_sync},
    ):
        summary = body_completion.complete_bodies(
            tmp_path,
            relay_port=18792,
            workers=1,
            attempts=1,
            speed_mode="steady",
            note_delay_seconds=0,
            upstream_scraper=tmp_path / "fake-upstream.py",
        )

    assert len(scrape_calls) == 1
    assert scrape_calls[0]["explore_url"].endswith("/explore/n1")
    assert summary["bodyAttempted"] == 1
    assert summary["bodyFailed"] == 1
