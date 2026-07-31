from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from workflow_state import (  # noqa: E402
    WorkflowStateConflict,
    WorkflowStateError,
    WorkflowStateSession,
    analysis_source_hash,
    open_workflow_state_from_args,
)
import run_project_workflow as workflow  # noqa: E402
import workflow_state as workflow_state_module  # noqa: E402


def state_fixture(tmp_path: Path, *, revision: int = 4):
    job_dir = tmp_path / "job-123"
    output_dir = job_dir / "artifacts"
    output_dir.mkdir(parents=True)
    state_path = job_dir / "workflow-state.json"
    state = {
        "schemaVersion": 2,
        "jobId": job_dir.name,
        "revision": revision,
        "status": "running",
        "activeAttemptId": "attempt-2",
        "resumeCount": 1,
        "customRootField": {"preserve": True},
        "stages": {
            "discovery": {"status": "partial", "cursor": "cursor-1"},
            "bodyCompletion": {"status": "not_started", "records": {}},
            "analysis": {"status": "not_started", "records": {}},
            "audience": {"status": "not_started", "posts": {}, "users": {}},
            "artifacts": {"status": "not_started", "generatedFiles": []},
        },
        "attempts": [
            {"attemptId": "attempt-1", "status": "interrupted", "custom": "old"},
            {"attemptId": "attempt-2", "status": "running", "custom": "active"},
        ],
    }
    state_path.write_text(json.dumps(state), encoding="utf-8")
    return output_dir, state_path, state


def open_session(output_dir: Path, state_path: Path, *, revision: int = 4, scope: str = "full"):
    return WorkflowStateSession.open(
        output_dir=output_dir,
        state_path=state_path,
        attempt_id="attempt-2",
        resume_scope=scope,
        expected_revision=revision,
    )


def test_stage_update_is_revision_checked_and_preserves_unknown_fields(tmp_path: Path) -> None:
    output_dir, state_path, _ = state_fixture(tmp_path)
    session = open_session(output_dir, state_path)

    session.update_stage("discovery", {
        "status": "running",
        "discoveredIds": ["note-1", "note-2", "note-3"],
        "discoveredCount": 3,
    })

    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    assert persisted["revision"] == 5
    assert persisted["customRootField"] == {"preserve": True}
    assert persisted["stages"]["discovery"]["cursor"] == "cursor-1"
    assert persisted["stages"]["discovery"]["discoveredCount"] == 3
    assert persisted["attempts"][0]["custom"] == "old"
    assert persisted["attempts"][1]["custom"] == "active"
    assert persisted["attempts"][1]["checkpointRevisionAtEnd"] == 5
    assert not list(state_path.parent.glob("*.tmp"))


def test_legacy_schema2_fields_are_normalized_and_persisted_canonically(tmp_path: Path) -> None:
    output_dir, state_path, state = state_fixture(tmp_path)
    state["stages"]["audience"] = {
        "status": "completed",
        "posts": {"note-1": {"commentStatus": "complete"}},
        "users": {"user-1": {"profileStatus": "complete"}},
        "postsComplete": 1,
        "profilesComplete": 1,
    }
    state_path.write_text(json.dumps(state), encoding="utf-8")

    session = open_session(output_dir, state_path)
    assert session.state["stages"]["audience"]["postsCompleted"] == 1
    assert session.state["stages"]["audience"]["usersCompleted"] == 1
    assert session.state["stages"]["bodyCompletion"]["totalCount"] == 0
    assert session.state["stages"]["artifacts"]["failedFiles"] == []

    session.update_stage("discovery", {"status": "running"})
    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    assert persisted["stages"]["audience"]["postsCompleted"] == 1
    assert persisted["stages"]["audience"]["usersCompleted"] == 1
    assert persisted["stages"]["artifacts"]["failedFiles"] == []


@pytest.mark.parametrize(
    ("stage_name", "patch", "message"),
    [
        ("discovery", {"status": "done"}, "invalid status"),
        ("bodyCompletion", {"remainingCount": -1}, "non-negative integer"),
        ("audience", {"posts": []}, "object ledger"),
        (
            "analysis",
            {
                "status": "completed",
                "totalCount": 2,
                "completedCount": 1,
                "remainingCount": 1,
            },
            "no remaining records",
        ),
        (
            "artifacts",
            {"status": "completed", "failedFiles": ["broken.json"]},
            "cannot contain failed files",
        ),
        (
            "discovery",
            {"discoveredIds": [], "discoveredCount": 1},
            "does not match discoveredIds",
        ),
        (
            "bodyCompletion",
            {
                "status": "completed",
                "records": {"note-1": {"status": "failed"}},
                "totalCount": 1,
                "completedCount": 1,
                "remainingCount": 0,
            },
            "aggregate counts do not match its ledger",
        ),
        (
            "analysis",
            {
                "status": "completed",
                "records": {"note-1": {"analysisStatus": "partial"}},
                "totalCount": 1,
                "completedCount": 1,
                "remainingCount": 0,
            },
            "aggregate counts do not match its ledger",
        ),
        (
            "audience",
            {
                "status": "completed",
                "posts": {"note-1": {"commentStatus": "partial"}},
                "postsTotal": 1,
                "postsCompleted": 1,
            },
            "aggregate counts do not match its ledgers",
        ),
        (
            "bodyCompletion",
            {
                "records": {"note-1": {"status": "mystery"}},
                "totalCount": 1,
                "remainingCount": 1,
            },
            "body record has an invalid status",
        ),
        (
            "analysis",
            {
                "records": {"note-1": {"analysisStatus": "partial", "attemptCount": -1}},
                "totalCount": 1,
                "remainingCount": 1,
            },
            "attemptCount must be a non-negative integer",
        ),
    ],
)
def test_stage_update_rejects_invalid_shape_before_commit(
    tmp_path: Path,
    stage_name: str,
    patch: dict,
    message: str,
) -> None:
    output_dir, state_path, _ = state_fixture(tmp_path)
    session = open_session(output_dir, state_path)

    with pytest.raises(WorkflowStateError, match=message):
        session.update_stage(stage_name, patch)

    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    assert persisted["revision"] == 4
    assert persisted["stages"][stage_name] != {
        **persisted["stages"][stage_name],
        **patch,
    }


def test_stale_runner_cannot_overwrite_a_newer_revision(tmp_path: Path) -> None:
    output_dir, state_path, _ = state_fixture(tmp_path)
    first = open_session(output_dir, state_path)
    stale = open_session(output_dir, state_path)
    first.update_stage("discovery", {"discoveredIds": ["note-1"], "discoveredCount": 1})

    with pytest.raises(WorkflowStateConflict, match="expected 4, found 5"):
        stale.update_stage(
            "discovery",
            {"discoveredIds": ["note-1", "note-2"], "discoveredCount": 2},
        )

    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    assert persisted["stages"]["discovery"]["discoveredCount"] == 1


def test_two_python_processes_cannot_commit_the_same_revision(tmp_path: Path) -> None:
    output_dir, state_path, _ = state_fixture(tmp_path)
    ready_paths = [tmp_path / "worker-1.ready", tmp_path / "worker-2.ready"]
    go_path = tmp_path / "workers.go"
    worker_source = """
import sys
import time
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from workflow_state import WorkflowStateConflict, WorkflowStateLockTimeout, WorkflowStateSession

session = WorkflowStateSession.open(
    output_dir=Path(sys.argv[2]),
    state_path=Path(sys.argv[3]),
    attempt_id="attempt-2",
    resume_scope="full",
    expected_revision=4,
)
Path(sys.argv[4]).write_text("ready", encoding="utf-8")
go_path = Path(sys.argv[5])
while not go_path.exists():
    time.sleep(0.01)
try:
    count = int(sys.argv[6])
    session.update_stage("discovery", {
        "discoveredIds": [f"note-{index}" for index in range(1, count + 1)],
        "discoveredCount": count,
    })
except WorkflowStateLockTimeout:
    raise SystemExit(43)
except WorkflowStateConflict:
    raise SystemExit(42)
"""
    processes = [
        subprocess.Popen(
            [
                sys.executable,
                "-c",
                worker_source,
                str(ROOT / "scripts"),
                str(output_dir),
                str(state_path),
                str(ready_path),
                str(go_path),
                str(index),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for index, ready_path in enumerate(ready_paths, start=1)
    ]
    try:
        deadline = time.monotonic() + 5
        while not all(path.exists() for path in ready_paths):
            if time.monotonic() >= deadline:
                details = [process.communicate(timeout=1) for process in processes]
                pytest.fail(f"workers did not become ready: {details}")
            time.sleep(0.01)
        go_path.write_text("go", encoding="utf-8")
        results = [process.communicate(timeout=10) for process in processes]
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)

    return_codes = sorted(process.returncode for process in processes)
    assert return_codes == [0, 42], results
    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    assert persisted["revision"] == 5
    assert persisted["stages"]["discovery"]["discoveredCount"] in {1, 2}
    assert not Path(f"{state_path}.lock").exists()


def test_live_process_lock_prevents_overlapping_state_write(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output_dir, state_path, _ = state_fixture(tmp_path)
    session = open_session(output_dir, state_path)
    lock_path = Path(f"{state_path}.lock")
    lock_path.write_text(json.dumps({
        "pid": os.getpid(),
        "token": "active-owner",
        "createdAt": "2999-01-01T00:00:00.000Z",
    }), encoding="utf-8")
    monkeypatch.setattr(workflow_state_module, "STATE_LOCK_TIMEOUT_SECONDS", 0.02)
    monkeypatch.setattr(workflow_state_module, "STATE_LOCK_RETRY_SECONDS", 0.005)

    with pytest.raises(workflow_state_module.WorkflowStateLockTimeout):
        session.update_stage("discovery", {
            "discoveredIds": [f"note-{index}" for index in range(99)],
            "discoveredCount": 99,
        })

    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    assert persisted["revision"] == 4
    assert json.loads(lock_path.read_text(encoding="utf-8"))["token"] == "active-owner"
    lock_path.unlink()


def test_dead_process_lock_is_quarantined_before_state_write(tmp_path: Path) -> None:
    output_dir, state_path, _ = state_fixture(tmp_path)
    session = open_session(output_dir, state_path)
    lock_path = Path(f"{state_path}.lock")
    lock_path.write_text(json.dumps({
        "pid": 2147483647,
        "token": "dead-owner",
        "createdAt": "2999-01-01T00:00:00.000Z",
    }), encoding="utf-8")

    session.update_stage(
        "discovery",
        {"discoveredIds": ["note-1", "note-2"], "discoveredCount": 2},
    )

    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    assert persisted["revision"] == 5
    assert persisted["stages"]["discovery"]["discoveredCount"] == 2
    assert not lock_path.exists()
    assert not list(state_path.parent.glob(f"{lock_path.name}.stale.*"))


def test_quarantine_restores_a_lock_when_observed_token_changed(tmp_path: Path) -> None:
    lock_path = tmp_path / "workflow-state.json.lock"
    lock_path.write_text(json.dumps({
        "pid": os.getpid(),
        "token": "replacement-owner",
        "createdAt": "2999-01-01T00:00:00.000Z",
    }), encoding="utf-8")

    removed = workflow_state_module._quarantine_lock(lock_path, "stale-owner")

    assert removed is False
    assert json.loads(lock_path.read_text(encoding="utf-8"))["token"] == "replacement-owner"
    assert not list(tmp_path.glob(f"{lock_path.name}.stale.*"))


def test_open_rejects_wrong_job_attempt_and_partial_context(tmp_path: Path) -> None:
    output_dir, state_path, state = state_fixture(tmp_path)
    state["activeAttemptId"] = "another-attempt"
    state_path.write_text(json.dumps(state), encoding="utf-8")
    with pytest.raises(WorkflowStateError, match="activeAttemptId"):
        open_session(output_dir, state_path)

    options = argparse.Namespace(
        resume_scope="full",
        attempt_id=None,
        state_path=str(state_path),
        expected_state_revision=4,
    )
    with pytest.raises(WorkflowStateError, match="Incomplete Runner workflow-state arguments"):
        open_workflow_state_from_args(options, output_dir)


def test_resume_scope_selects_only_the_declared_dependency_chain(tmp_path: Path) -> None:
    output_dir, state_path, _ = state_fixture(tmp_path)
    body = open_session(output_dir, state_path, scope="body_completion")
    assert body.scope_selects("bodyCompletion")
    assert body.scope_selects("analysis")
    assert body.scope_selects("artifacts")
    assert not body.scope_selects("discovery")
    assert not body.scope_selects("audience")


def test_wrapper_parser_keeps_upstream_resume_separate_from_resume_scope() -> None:
    options, upstream = workflow.parse_wrapper_args([
        "--resume",
        "--resume-scope", "audience",
        "--attempt-id", "attempt-2",
    ])
    assert options.resume_scope == "audience"
    assert options.attempt_id == "attempt-2"
    assert upstream == ["--resume"]


def test_body_checkpoint_keeps_succeeded_records_and_attempt_counts_idempotent(tmp_path: Path) -> None:
    output_dir, state_path, _ = state_fixture(tmp_path)
    session = open_session(output_dir, state_path)
    cards = [{"note_id": "note-1"}, {"note_id": "note-2"}]
    complete = [{"note_id": "note-1", "body": "complete"}]
    failures = [{"note_id": "note-2", "access_status": "detail_timeout"}]

    session.checkpoint_body(
        cards=cards,
        complete_records=complete,
        failures=failures,
        attempted_ids={"note-1", "note-2"},
    )
    session.checkpoint_body(
        cards=cards,
        complete_records=complete,
        failures=failures,
        attempted_ids={"note-1", "note-2"},
    )

    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    records = persisted["stages"]["bodyCompletion"]["records"]
    assert records["note-1"]["status"] == "succeeded"
    assert records["note-1"]["recoverable"] is False
    assert records["note-2"]["status"] == "failed"
    assert records["note-2"]["recoverable"] is True
    assert records["note-1"]["attemptCount"] == 1
    assert records["note-2"]["attemptCount"] == 1
    assert persisted["stages"]["bodyCompletion"]["remainingCount"] == 1


def test_body_checkpoint_persists_exact_ledger_diagnostics(tmp_path: Path) -> None:
    output_dir, state_path, _ = state_fixture(tmp_path)
    session = open_session(output_dir, state_path)
    ledger = {
        "schemaVersion": 1,
        "statisticsSource": "bodyCompletionLedger",
        "records": {
            "note-1": {
                "noteId": "note-1",
                "bodyStatus": "succeeded",
                "attemptCount": 1,
                "discoveredAt": "2026-08-01T00:00:00Z",
                "firstAttemptAt": "2026-08-01T00:00:01Z",
                "lastAttemptAt": "2026-08-01T00:00:01Z",
                "completedAt": "2026-08-01T00:00:02Z",
                "failureCode": "",
                "failureMessage": "",
                "recoverable": False,
                "stopReason": "",
                "updatedAt": "2026-08-01T00:00:02Z",
            },
            "note-2": {
                "noteId": "note-2",
                "bodyStatus": "not_attempted",
                "attemptCount": 0,
                "recoverable": True,
                "stopReason": "attempt_limit_reached",
            },
        },
    }

    session.checkpoint_body(
        cards=[],
        complete_records=[],
        failures=[],
        attempted_ids=set(),
        ledger=ledger,
        summary={"stopReason": "attempt_limit_reached"},
        status="blocked",
    )

    stage = json.loads(state_path.read_text(encoding="utf-8"))["stages"]["bodyCompletion"]
    assert stage["statisticsSource"] == "bodyCompletionLedger"
    assert stage["attemptedCount"] == 1
    assert stage["completedCount"] == 1
    assert stage["notAttemptedCount"] == 1
    assert stage["pendingCount"] == 0
    assert stage["conservationValid"] is True
    assert stage["records"]["note-1"]["firstAttemptAt"] == "2026-08-01T00:00:01Z"
    assert stage["records"]["note-2"]["stopReason"] == "attempt_limit_reached"


def test_audience_checkpoint_counts_started_attempts_once(tmp_path: Path) -> None:
    output_dir, state_path, _ = state_fixture(tmp_path)
    session = open_session(output_dir, state_path)
    attempted_at = "2026-07-31T10:00:00.000Z"
    posts = [{
        "post_id": "note-1",
        "status": "partial",
        "last_attempt_at": attempted_at,
        "failure_reason": "checkpoint_note_url_missing",
    }]
    users = [{
        "user_id": "user-1",
        "enrichment_status": "partial",
        "last_attempt_at": attempted_at,
        "access_status": "profile_url_missing",
    }]
    summary = {"postsTotal": 1, "usersDiscovered": 1}

    session.checkpoint_audience(posts=posts, users=users, summary=summary)
    session.checkpoint_audience(posts=posts, users=users, summary=summary)

    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    post = persisted["stages"]["audience"]["posts"]["note-1"]
    user = persisted["stages"]["audience"]["users"]["user-1"]
    assert post["attemptCount"] == 1
    assert post["lastAttemptAt"] == attempted_at
    assert post["stopReason"] == "checkpoint_note_url_missing"
    assert user["attemptCount"] == 1
    assert user["lastAttemptAt"] == attempted_at
    assert user["failureCode"] == "profile_url_missing"
    assert persisted["stages"]["audience"]["postsCompleted"] == 0
    assert persisted["stages"]["audience"]["usersCompleted"] == 0


def test_analysis_resume_reuses_only_unchanged_source_records() -> None:
    completed = {
        "note_id": "note-1",
        "title": "title",
        "body": "old body",
        "media": {"images": ["one.jpg"], "analysis": {"status": "analyzed", "visible_text": "text"}},
        "outreach": {"cover_letter": "ready"},
    }
    unchanged = {
        "note_id": "note-1",
        "title": "title",
        "body": "old body",
        "media": {"images": ["one.jpg"], "analysis": {}},
    }
    changed = {
        "note_id": "note-1",
        "title": "title",
        "body": "new body",
        "media": {"images": ["one.jpg"], "analysis": {}},
    }
    previous = {"records": [completed]}

    unchanged_payload = {"records": [unchanged]}
    assert workflow.reuse_completed_records(unchanged_payload, previous) == 1
    assert unchanged_payload["records"][0] is completed
    assert workflow.completion_target_ids(unchanged_payload, previous) == set()

    changed_payload = {"records": [changed]}
    assert workflow.reuse_completed_records(changed_payload, previous) == 0
    assert changed_payload["records"][0] is changed
    assert changed_payload["records"][0]["media"]["analysis"] == {}
    assert workflow.completion_target_ids(changed_payload, previous) == {"note-1"}


def test_analysis_source_hash_ignores_derived_media_analysis() -> None:
    before = {
        "note_id": "note-1",
        "title": "title",
        "body": "body",
        "media": {"images": ["one.jpg"], "analysis": {}},
    }
    after = {
        **before,
        "media": {"images": ["one.jpg"], "analysis": {"status": "analyzed", "visible_text": "derived"}},
    }
    assert analysis_source_hash(before) == analysis_source_hash(after)
    assert analysis_source_hash(before) != analysis_source_hash({**before, "body": "changed"})
    assert analysis_source_hash(before) != analysis_source_hash({
        **before,
        "source_card_text": "new card source",
    })
    assert analysis_source_hash(before) == analysis_source_hash({
        **before,
        "content_analysis": {"status": "completed", "overview": "derived"},
        "outreach": {"cover_letter": "derived"},
    })


def test_analysis_resume_merges_before_exactly_one_initial_persist(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    payload = {"records": [{"note_id": "note-1", "body": "fresh"}]}
    previous = {"records": [{"note_id": "note-1", "body": "complete"}]}

    def merge(_payload: dict, _previous: dict, _mode: str) -> int:
        events.append("merge")
        return 1

    def targets(_payload: dict, _previous: dict, _mode: str) -> set[str]:
        events.append("targets")
        return {"note-2"}

    def persist(_output_dir: Path, _payload: dict) -> None:
        events.append("persist")

    monkeypatch.setattr(workflow, "reuse_completed_records", merge)
    monkeypatch.setattr(workflow, "completion_target_ids", targets)
    monkeypatch.setattr(workflow, "write_pipeline_artifacts", persist)

    target_note_ids, reused = workflow.merge_and_persist_analysis(
        tmp_path,
        payload,
        previous,
        "job",
        only_incomplete=True,
    )

    assert events == ["merge", "targets", "persist"]
    assert target_note_ids == {"note-2"}
    assert reused == 1


def test_analysis_merge_failure_preserves_existing_artifact(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    artifact_path = tmp_path / "application_intelligence.json"
    original = '{"sentinel":"previous-run"}\n'
    artifact_path.write_text(original, encoding="utf-8")
    persist_calls: list[dict] = []

    def fail_merge(_payload: dict, _previous: dict, _mode: str) -> int:
        raise RuntimeError("merge failed")

    monkeypatch.setattr(workflow, "reuse_completed_records", fail_merge)
    monkeypatch.setattr(
        workflow,
        "write_pipeline_artifacts",
        lambda _output_dir, payload: persist_calls.append(payload),
    )

    with pytest.raises(RuntimeError, match="merge failed"):
        workflow.merge_and_persist_analysis(
            tmp_path,
            {"records": []},
            {"records": []},
            "job",
            only_incomplete=True,
        )

    assert persist_calls == []
    assert artifact_path.read_text(encoding="utf-8") == original


def test_analysis_checkpoint_does_not_mark_unchanged_complete_record_attempted(tmp_path: Path) -> None:
    output_dir, state_path, state = state_fixture(tmp_path)
    record = {"note_id": "note-1", "title": "title", "body": "complete body", "media": {}}
    state["stages"]["analysis"]["records"] = {
        "note-1": {
            "recordId": "note-1",
            "sourceHash": analysis_source_hash(record),
            "analysisStatus": "completed",
            "attemptCount": 1,
            "lastAttemptId": "attempt-1",
            "lastAttemptAt": "2026-07-30T10:00:00Z",
        },
    }
    state_path.write_text(json.dumps(state), encoding="utf-8")
    session = open_session(output_dir, state_path)

    session.checkpoint_analysis({"analysis_mode": "job", "records": [record]})

    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    ledger = persisted["stages"]["analysis"]["records"]["note-1"]
    assert ledger["attemptCount"] == 1
    assert ledger["lastAttemptId"] == "attempt-1"
    assert ledger["lastAttemptAt"] == "2026-07-30T10:00:00Z"


def test_discovery_checkpoint_has_complete_resume_schema(tmp_path: Path) -> None:
    (tmp_path / "xiaohongshu_cards_latest.json").write_text(
        json.dumps([{"note_id": "note-1"}, {"note_id": "note-1"}, {"note_id": "note-2"}]),
        encoding="utf-8",
    )

    checkpoint = workflow.discovery_checkpoint(tmp_path)

    assert checkpoint["cursor"] is None
    assert checkpoint["scrollCount"] == 0
    assert checkpoint["stableRoundCount"] == 0
    assert checkpoint["discoveredIds"] == ["note-1", "note-2"]
    assert checkpoint["discoveredCount"] == 2
    assert checkpoint["stopReason"] == ""


def test_audience_scope_reuses_original_output_without_starting_discovery(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output_dir, state_path, state = state_fixture(tmp_path)
    state["stages"]["discovery"]["status"] = "completed"
    state["stages"]["bodyCompletion"]["status"] = "completed"
    state["stages"]["analysis"]["status"] = "completed"
    state["stages"]["audience"]["status"] = "partial"
    state["stages"]["artifacts"]["status"] = "completed"
    state_path.write_text(json.dumps(state), encoding="utf-8")
    (output_dir / "workflow-summary.json").write_text(json.dumps({
        "schemaVersion": 1,
        "runner": "xiaohongshu-project-workflow",
        "status": "completed_partial",
        "checks": {},
        "issues": [],
        "notesCollected": 1,
        "bodiesCaptured": 1,
    }), encoding="utf-8")
    calls: list[Path] = []

    def fail_discovery(*_args, **_kwargs):
        raise AssertionError("audience supplementation must not start discovery")

    def fake_collect(output: Path, *, progress_callback=None, **_kwargs):
        calls.append(output)
        summary = {
            "status": "complete",
            "postsTotal": 1,
            "postsComplete": 1,
            "usersDiscovered": 1,
            "profilesComplete": 1,
            "stopReason": "",
        }
        if progress_callback:
            progress_callback({
                "posts": [{"post_id": "note-1", "status": "complete"}],
                "users": [{"user_id": "user-1", "enrichment_status": "complete"}],
                "summary": summary,
                "status": "completed",
            })
        return summary

    def fake_manifest(output: Path, _summary: dict):
        manifest = output / "artifact-manifest.json"
        manifest.write_text(json.dumps({"artifacts": []}), encoding="utf-8")
        return manifest

    monkeypatch.setattr(workflow, "resolve_upstream_runner", lambda _value="": tmp_path / "runner.py")
    monkeypatch.setattr(workflow, "resolve_upstream_scraper", lambda _value: tmp_path / "scraper.py")
    monkeypatch.setattr(workflow, "run_discovery_process", fail_discovery)
    monkeypatch.setattr(workflow, "run_pipeline", fail_discovery)
    monkeypatch.setattr(workflow, "collect_audience", fake_collect)
    monkeypatch.setattr(workflow, "write_project_manifest", fake_manifest)

    result = workflow.main([
        "--analysis-mode", "general",
        "--collect-audience",
        "--audience-only",
        "--resume",
        "--resume-scope", "audience",
        "--attempt-id", "attempt-2",
        "--state-path", str(state_path),
        "--expected-state-revision", "4",
        "--output-dir", str(output_dir),
    ])

    assert result == 0
    assert calls == [output_dir]
    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    assert persisted["jobId"] == output_dir.parent.name
    assert persisted["stages"]["discovery"]["status"] == "completed"
    assert persisted["stages"]["audience"]["status"] == "completed"
    assert persisted["stages"]["artifacts"]["status"] == "completed"
