from __future__ import annotations

import json
import sys
import types
from dataclasses import dataclass
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
        ({"access_status": "detail_empty"}, False),
    ],
)
def test_fresh_page_retry_only_handles_recoverable_browser_failures(
    payload: dict[str, str],
    expected: bool,
) -> None:
    assert body_completion.should_retry_on_fresh_page(payload) is expected


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
