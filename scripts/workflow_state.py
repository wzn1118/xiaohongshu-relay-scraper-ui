from __future__ import annotations

import copy
import hashlib
import json
import os
import tempfile
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator


SCHEMA_VERSION = 2
STAGE_NAMES = ("discovery", "bodyCompletion", "analysis", "audience", "artifacts")
RESUME_SCOPE_STAGES = {
    "full": frozenset(STAGE_NAMES),
    "discovery": frozenset(("discovery",)),
    "body_completion": frozenset(("bodyCompletion", "analysis", "artifacts")),
    "analysis": frozenset(("analysis", "artifacts")),
    "audience": frozenset(("audience", "artifacts")),
    "artifacts": frozenset(("artifacts",)),
}
TERMINAL_STAGE_STATUSES = frozenset(("completed", "failed", "cancelled"))
STAGE_STATUSES = frozenset((
    "not_started",
    "running",
    "partial",
    "blocked",
    *TERMINAL_STAGE_STATUSES,
))
BODY_RECORD_STATUSES = frozenset((
    "not_attempted", "attempted", "succeeded", "failed", "blocked",
))
ANALYSIS_RECORD_STATUSES = frozenset((
    "not_started", "running", "partial", "completed", "failed", "blocked",
))
AUDIENCE_ENTRY_STATUSES = frozenset((
    "pending", "partial", "complete", "failed", "blocked",
))
STATE_LOCK_TIMEOUT_SECONDS = 10.0
STATE_LOCK_RETRY_SECONDS = 0.05
STATE_LOCK_STALE_SECONDS = 30.0


class WorkflowStateError(RuntimeError):
    code = "WORKFLOW_STATE_INVALID"


class WorkflowStateConflict(WorkflowStateError):
    code = "WORKFLOW_REVISION_CONFLICT"


class WorkflowStateLockTimeout(WorkflowStateConflict):
    code = "WORKFLOW_STATE_LOCK_TIMEOUT"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def stable_hash(value: Any) -> str:
    serialized = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def analysis_source_hash(record: dict[str, Any]) -> str:
    """Hash only source inputs, excluding derived media-analysis output."""
    media = record.get("media")
    if isinstance(media, dict):
        media = {
            key: value
            for key, value in media.items()
            if key != "analysis"
        } or None
    return stable_hash({
        "noteId": _record_id(record),
        "title": record.get("title") or record.get("card_title"),
        "noteUrl": (
            record.get("note_url")
            or record.get("search_result_url")
            or record.get("card_search_result_url")
        ),
        "body": record.get("body"),
        "sourceCardText": record.get("source_card_text"),
        "cardTextSegments": record.get("card_text_segments"),
        "accessStatus": record.get("access_status"),
        "publishTime": record.get("publish_time") or record.get("card_publish_time"),
        "cardAuthor": record.get("card_author"),
        "media": media,
    })


def _read_object(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise WorkflowStateError(f"Workflow state does not exist: {path}") from error
    except json.JSONDecodeError as error:
        raise WorkflowStateError(f"Workflow state is not valid JSON: {path}") from error
    if not isinstance(payload, dict):
        raise WorkflowStateError(f"Workflow state root must be an object: {path}")
    return payload


def _write_json_atomically(path: Path, payload: dict[str, Any]) -> None:
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


def _lock_owner_is_alive(pid: Any) -> bool:
    try:
        owner_pid = int(pid)
    except (TypeError, ValueError):
        return False
    if owner_pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        process_query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        kernel32.GetExitCodeProcess.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel32.CloseHandle.restype = wintypes.BOOL
        handle = kernel32.OpenProcess(
            process_query_limited_information,
            False,
            owner_pid,
        )
        if not handle:
            return ctypes.get_last_error() == 5
        try:
            exit_code = wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return True
            return exit_code.value == still_active
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(owner_pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True
    return True


def _read_lock_metadata(lock_path: Path) -> dict[str, Any]:
    try:
        value = json.loads(lock_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _lock_age_seconds(lock_path: Path, metadata: dict[str, Any]) -> float:
    created_at = metadata.get("createdAt")
    if isinstance(created_at, str):
        try:
            created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            return max(0.0, (datetime.now(timezone.utc) - created).total_seconds())
        except ValueError:
            pass
    try:
        return max(0.0, time.time() - lock_path.stat().st_mtime)
    except OSError:
        return 0.0


def _restore_quarantined_lock(lock_path: Path, quarantine: Path) -> None:
    try:
        descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(quarantine.read_bytes())
            handle.flush()
            os.fsync(handle.fileno())
        quarantine.unlink(missing_ok=True)
    except BaseException:
        lock_path.unlink(missing_ok=True)
        raise


def _quarantine_lock(lock_path: Path, expected_token: Any) -> bool:
    quarantine = lock_path.with_name(
        f"{lock_path.name}.stale.{os.getpid()}.{uuid.uuid4().hex}"
    )
    try:
        os.replace(lock_path, quarantine)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    moved = _read_lock_metadata(quarantine)
    if moved.get("token") != expected_token:
        _restore_quarantined_lock(lock_path, quarantine)
        return False
    quarantine.unlink(missing_ok=True)
    return True


@contextmanager
def _workflow_state_lock(state_path: Path) -> Iterator[None]:
    lock_path = Path(f"{state_path}.lock")
    token = uuid.uuid4().hex
    deadline = time.monotonic() + STATE_LOCK_TIMEOUT_SECONDS
    metadata = {
        "pid": os.getpid(),
        "token": token,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    encoded = (json.dumps(metadata, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")

    while True:
        try:
            descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            current = _read_lock_metadata(lock_path)
            age = _lock_age_seconds(lock_path, current)
            owner_alive = _lock_owner_is_alive(current.get("pid")) if current else False
            if (current and not owner_alive) or age >= STATE_LOCK_STALE_SECONDS:
                if _quarantine_lock(lock_path, current.get("token")):
                    continue
            if time.monotonic() >= deadline:
                raise WorkflowStateLockTimeout(
                    f"Timed out waiting for workflow-state lock: {lock_path}"
                )
            time.sleep(STATE_LOCK_RETRY_SECONDS)
            continue

        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException:
            lock_path.unlink(missing_ok=True)
            raise
        break

    try:
        yield
    finally:
        current = _read_lock_metadata(lock_path)
        if current.get("token") == token:
            lock_path.unlink(missing_ok=True)


def _deep_merge(current: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    merged = copy.deepcopy(current)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def _empty_stages() -> dict[str, dict[str, Any]]:
    return {
        "discovery": {
            "status": "not_started",
            "cursor": None,
            "scrollCount": 0,
            "stableRoundCount": 0,
            "discoveredIds": [],
            "discoveredCount": 0,
            "stopReason": None,
            "lastCheckpointAt": None,
        },
        "bodyCompletion": {
            "status": "not_started",
            "records": {},
            "totalCount": 0,
            "completedCount": 0,
            "remainingCount": 0,
            "lastCheckpointAt": None,
        },
        "analysis": {
            "status": "not_started",
            "records": {},
            "totalCount": 0,
            "completedCount": 0,
            "remainingCount": 0,
            "lastCheckpointAt": None,
        },
        "audience": {
            "status": "not_started",
            "posts": {},
            "users": {},
            "postsTotal": 0,
            "postsCompleted": 0,
            "usersTotal": 0,
            "usersCompleted": 0,
            "stopReason": None,
            "lastCheckpointAt": None,
        },
        "artifacts": {
            "status": "not_started",
            "sourceRevision": None,
            "manifestRevision": None,
            "generatedFiles": [],
            "failedFiles": [],
            "lastCheckpointAt": None,
        },
    }


def _normalize_state(state: dict[str, Any]) -> dict[str, Any]:
    normalized = copy.deepcopy(state)
    stages = normalized.get("stages")
    if not isinstance(stages, dict):
        return normalized
    defaults = _empty_stages()
    for stage_name in STAGE_NAMES:
        original = stages.get(stage_name)
        if not isinstance(original, dict):
            continue
        stage = {**copy.deepcopy(defaults[stage_name]), **original}
        if stage_name == "discovery" and "discoveredCount" not in original:
            discovered_ids = stage.get("discoveredIds")
            stage["discoveredCount"] = len(discovered_ids) if isinstance(discovered_ids, list) else 0
        elif stage_name == "bodyCompletion":
            stage["records"] = _normalize_ledger(
                stage.get("records"),
                _normalize_body_record,
            )
            records = stage.get("records") if isinstance(stage.get("records"), dict) else {}
            if "totalCount" not in original:
                stage["totalCount"] = len(records)
            if "completedCount" not in original:
                stage["completedCount"] = sum(
                    _body_record_is_completed(record)
                    for record in records.values()
                )
            if "remainingCount" not in original:
                stage["remainingCount"] = max(
                    0,
                    stage["totalCount"] - stage["completedCount"],
                )
        elif stage_name == "analysis":
            stage["records"] = _normalize_ledger(
                stage.get("records"),
                _normalize_analysis_record,
            )
            records = stage.get("records") if isinstance(stage.get("records"), dict) else {}
            if "totalCount" not in original:
                stage["totalCount"] = len(records)
            if "completedCount" not in original:
                stage["completedCount"] = sum(
                    _analysis_record_is_completed(record)
                    for record in records.values()
                )
            if "remainingCount" not in original:
                stage["remainingCount"] = max(
                    0,
                    stage["totalCount"] - stage["completedCount"],
                )
        elif stage_name == "audience":
            stage["posts"] = _normalize_ledger(
                stage.get("posts"),
                _normalize_audience_post,
            )
            stage["users"] = _normalize_ledger(
                stage.get("users"),
                _normalize_audience_user,
            )
            posts = stage.get("posts") if isinstance(stage.get("posts"), dict) else {}
            users = stage.get("users") if isinstance(stage.get("users"), dict) else {}
            if "postsTotal" not in original:
                stage["postsTotal"] = len(posts)
            if "postsCompleted" not in original:
                stage["postsCompleted"] = (
                    original["postsComplete"]
                    if "postsComplete" in original
                    else sum(_post_is_completed(post) for post in posts.values())
                )
            if "usersTotal" not in original:
                stage["usersTotal"] = len(users)
            if "usersCompleted" not in original:
                stage["usersCompleted"] = (
                    original["profilesComplete"]
                    if "profilesComplete" in original
                    else sum(_user_is_completed(user) for user in users.values())
                )
        stages[stage_name] = stage
    return normalized


def _normalize_ledger(value: Any, normalize_entry: Callable[[dict[str, Any]], dict[str, Any]]) -> Any:
    if not isinstance(value, dict):
        return value
    return {
        key: normalize_entry(entry) if isinstance(entry, dict) else entry
        for key, entry in value.items()
    }


def _normalize_body_record(value: dict[str, Any]) -> dict[str, Any]:
    normalized = copy.deepcopy(value)
    status = normalized.get("status") or "not_attempted"
    normalized["status"] = "succeeded" if status == "completed" else status
    normalized["attemptCount"] = normalized.get("attemptCount", 0)
    return normalized


def _normalize_analysis_record(value: dict[str, Any]) -> dict[str, Any]:
    normalized = copy.deepcopy(value)
    status = normalized.get("analysisStatus") or normalized.get("status") or "not_started"
    normalized["analysisStatus"] = (
        "completed" if status in {"succeeded", "complete"} else status
    )
    normalized["attemptCount"] = normalized.get("attemptCount", 0)
    normalized["completedStages"] = normalized.get("completedStages") or []
    return normalized


def _normalize_audience_post(value: dict[str, Any]) -> dict[str, Any]:
    normalized = copy.deepcopy(value)
    status = normalized.get("commentStatus") or normalized.get("status") or "pending"
    normalized["commentStatus"] = (
        "complete" if status in {"completed", "succeeded"} else status
    )
    normalized["attemptCount"] = normalized.get("attemptCount", 0)
    normalized["commentsCollected"] = normalized.get(
        "commentsCollected",
        normalized.get("collected_comment_count", 0),
    )
    normalized["repliesCollected"] = normalized.get(
        "repliesCollected",
        normalized.get("reply_count", 0),
    )
    return normalized


def _normalize_audience_user(value: dict[str, Any]) -> dict[str, Any]:
    normalized = copy.deepcopy(value)
    status = (
        normalized.get("profileStatus")
        or normalized.get("enrichmentStatus")
        or normalized.get("enrichment_status")
        or normalized.get("status")
        or "pending"
    )
    normalized["profileStatus"] = (
        "complete" if status in {"completed", "succeeded"} else status
    )
    normalized["attemptCount"] = normalized.get("attemptCount", 0)
    return normalized


def _body_record_is_completed(record: Any) -> bool:
    return isinstance(record, dict) and record.get("status") == "succeeded"


def _analysis_record_is_completed(record: Any) -> bool:
    return isinstance(record, dict) and record.get("analysisStatus") == "completed"


def _post_is_completed(post: Any) -> bool:
    return isinstance(post, dict) and (
        post.get("commentStatus") or post.get("status")
    ) == "complete"


def _user_is_completed(user: Any) -> bool:
    return isinstance(user, dict) and (
        user.get("profileStatus") or user.get("enrichmentStatus") or user.get("status")
    ) == "complete"


def _require_ledger(value: Any, field_name: str) -> None:
    if not isinstance(value, dict) or any(
        not isinstance(entry, dict) for entry in value.values()
    ):
        raise WorkflowStateError(
            f"Workflow-state {field_name} must be an object ledger"
        )


def _require_string_list(value: Any, field_name: str) -> None:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise WorkflowStateError(
            f"Workflow-state {field_name} must be a string list"
        )


def _require_non_negative_integers(
    stage: dict[str, Any],
    fields: tuple[str, ...],
    stage_name: str,
) -> None:
    for field in fields:
        value = stage.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise WorkflowStateError(
                f"Workflow-state {stage_name}.{field} must be a non-negative integer"
            )


def _validate_body_records(records: dict[str, dict[str, Any]]) -> None:
    for record in records.values():
        if record.get("status") not in BODY_RECORD_STATUSES:
            raise WorkflowStateError("Workflow-state body record has an invalid status")
        _require_non_negative_entry_integers(record, ("attemptCount",), "body record")


def _validate_analysis_records(records: dict[str, dict[str, Any]]) -> None:
    for record in records.values():
        if record.get("analysisStatus") not in ANALYSIS_RECORD_STATUSES:
            raise WorkflowStateError("Workflow-state analysis record has an invalid status")
        _require_non_negative_entry_integers(record, ("attemptCount",), "analysis record")
        completed_stages = record.get("completedStages")
        if not isinstance(completed_stages, list) or any(
            isinstance(item, bool) or not isinstance(item, int) or item < 0
            for item in completed_stages
        ):
            raise WorkflowStateError(
                "Workflow-state analysis completedStages must contain non-negative integers"
            )


def _validate_audience_entries(
    posts: dict[str, dict[str, Any]],
    users: dict[str, dict[str, Any]],
) -> None:
    for post in posts.values():
        if post.get("commentStatus") not in AUDIENCE_ENTRY_STATUSES:
            raise WorkflowStateError("Workflow-state audience post has an invalid status")
        _require_non_negative_entry_integers(
            post,
            ("attemptCount", "commentsCollected", "repliesCollected"),
            "audience post",
        )
    for user in users.values():
        if user.get("profileStatus") not in AUDIENCE_ENTRY_STATUSES:
            raise WorkflowStateError("Workflow-state audience user has an invalid status")
        _require_non_negative_entry_integers(user, ("attemptCount",), "audience user")


def _require_non_negative_entry_integers(
    entry: dict[str, Any],
    fields: tuple[str, ...],
    entry_name: str,
) -> None:
    for field in fields:
        value = entry.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise WorkflowStateError(
                f"Workflow-state {entry_name}.{field} must be a non-negative integer"
            )


def _validate_aggregate_counts(
    stage: dict[str, Any],
    expected_total: int,
    expected_completed: int,
    stage_name: str,
) -> None:
    if (
        stage["totalCount"] != expected_total
        or stage["completedCount"] != expected_completed
        or stage["remainingCount"] != expected_total - expected_completed
    ):
        raise WorkflowStateError(
            f"Workflow-state {stage_name} aggregate counts do not match its ledger"
        )


class WorkflowStateSession:
    def __init__(
        self,
        *,
        output_dir: Path,
        state_path: Path,
        attempt_id: str,
        resume_scope: str,
        revision: int,
        state: dict[str, Any],
    ) -> None:
        self.output_dir = output_dir
        self.state_path = state_path
        self.attempt_id = attempt_id
        self.resume_scope = resume_scope
        self.revision = revision
        self.state = state

    @classmethod
    def open(
        cls,
        *,
        output_dir: Path,
        state_path: Path,
        attempt_id: str,
        resume_scope: str,
        expected_revision: int,
    ) -> "WorkflowStateSession":
        output_dir = output_dir.resolve()
        state_path = state_path.resolve()
        attempt_id = str(attempt_id or "").strip()
        if resume_scope not in RESUME_SCOPE_STAGES:
            raise WorkflowStateError(f"Unsupported resume scope: {resume_scope}")
        if not attempt_id:
            raise WorkflowStateError("Attempt id is required for workflow-state coordination")
        if state_path.parent != output_dir.parent:
            raise WorkflowStateError("Workflow state must belong to the original Job directory")
        state = _normalize_state(_read_object(state_path))
        cls._validate_state(
            state,
            state_path=state_path,
            output_dir=output_dir,
            attempt_id=attempt_id,
            expected_revision=expected_revision,
        )
        return cls(
            output_dir=output_dir,
            state_path=state_path,
            attempt_id=attempt_id,
            resume_scope=resume_scope,
            revision=expected_revision,
            state=state,
        )

    @staticmethod
    def _validate_state(
        state: dict[str, Any],
        *,
        state_path: Path,
        output_dir: Path,
        attempt_id: str,
        expected_revision: int,
    ) -> None:
        if state.get("schemaVersion") != SCHEMA_VERSION:
            raise WorkflowStateError(f"Unsupported workflow-state schema: {state_path}")
        if state.get("jobId") != output_dir.parent.name:
            raise WorkflowStateError("Workflow-state jobId does not match the original output directory")
        actual_revision = state.get("revision")
        if not isinstance(actual_revision, int) or actual_revision < 1:
            raise WorkflowStateError("Workflow-state revision must be a positive integer")
        if actual_revision != expected_revision:
            raise WorkflowStateConflict(
                f"Workflow state revision conflict: expected {expected_revision}, found {actual_revision}."
            )
        if state.get("activeAttemptId") != attempt_id:
            raise WorkflowStateError("Workflow-state activeAttemptId does not match this Runner attempt")
        attempts = state.get("attempts")
        if not isinstance(attempts, list) or not any(
            isinstance(item, dict) and item.get("attemptId") == attempt_id for item in attempts
        ):
            raise WorkflowStateError("Runner attempt is missing from workflow-state attempts")
        stages = state.get("stages")
        if not isinstance(stages, dict):
            raise WorkflowStateError("Workflow-state stages must be an object")
        for stage_name in STAGE_NAMES:
            stage = stages.get(stage_name)
            if not isinstance(stage, dict):
                raise WorkflowStateError(
                    f"Workflow-state stage {stage_name} must be an object"
                )
            if stage.get("status") not in STAGE_STATUSES:
                raise WorkflowStateError(
                    f"Workflow-state stage {stage_name} has an invalid status"
                )
            WorkflowStateSession._validate_stage_shape(stage_name, stage)

    @staticmethod
    def _validate_stage_shape(stage_name: str, stage: dict[str, Any]) -> None:
        if stage_name == "discovery":
            _require_string_list(stage.get("discoveredIds"), "discovery.discoveredIds")
            _require_non_negative_integers(
                stage,
                ("scrollCount", "stableRoundCount", "discoveredCount"),
                stage_name,
            )
            if stage["discoveredCount"] != len(stage["discoveredIds"]):
                raise WorkflowStateError(
                    "Workflow-state discovery count does not match discoveredIds"
                )
            return
        if stage_name == "bodyCompletion":
            _require_ledger(stage.get("records"), f"{stage_name}.records")
            _validate_body_records(stage["records"])
            _require_non_negative_integers(
                stage,
                ("totalCount", "completedCount", "remainingCount"),
                stage_name,
            )
            if stage["completedCount"] > stage["totalCount"]:
                raise WorkflowStateError(
                    f"Workflow-state {stage_name}.completedCount exceeds totalCount"
                )
            if stage["status"] == "completed" and (
                stage["completedCount"] != stage["totalCount"]
                or stage["remainingCount"] != 0
            ):
                raise WorkflowStateError(
                    f"Completed {stage_name} must have no remaining records"
                )
            _validate_aggregate_counts(
                stage,
                len(stage["records"]),
                sum(_body_record_is_completed(record) for record in stage["records"].values()),
                stage_name,
            )
            return
        if stage_name == "analysis":
            _require_ledger(stage.get("records"), f"{stage_name}.records")
            _validate_analysis_records(stage["records"])
            _require_non_negative_integers(
                stage,
                ("totalCount", "completedCount", "remainingCount"),
                stage_name,
            )
            if stage["completedCount"] > stage["totalCount"]:
                raise WorkflowStateError(
                    f"Workflow-state {stage_name}.completedCount exceeds totalCount"
                )
            if stage["status"] == "completed" and (
                stage["completedCount"] != stage["totalCount"]
                or stage["remainingCount"] != 0
            ):
                raise WorkflowStateError(
                    f"Completed {stage_name} must have no remaining records"
                )
            _validate_aggregate_counts(
                stage,
                len(stage["records"]),
                sum(_analysis_record_is_completed(record) for record in stage["records"].values()),
                stage_name,
            )
            return
        if stage_name == "audience":
            _require_ledger(stage.get("posts"), "audience.posts")
            _require_ledger(stage.get("users"), "audience.users")
            _validate_audience_entries(stage["posts"], stage["users"])
            _require_non_negative_integers(
                stage,
                ("postsTotal", "postsCompleted", "usersTotal", "usersCompleted"),
                stage_name,
            )
            if (
                stage["postsCompleted"] > stage["postsTotal"]
                or stage["usersCompleted"] > stage["usersTotal"]
            ):
                raise WorkflowStateError(
                    "Workflow-state audience completed count exceeds total"
                )
            if stage["status"] == "completed" and (
                stage["postsCompleted"] != stage["postsTotal"]
                or stage["usersCompleted"] != stage["usersTotal"]
            ):
                raise WorkflowStateError(
                    "Completed audience must include every post and user"
                )
            expected_posts_total = len(stage["posts"])
            expected_posts_completed = sum(
                _post_is_completed(post) for post in stage["posts"].values()
            )
            expected_users_total = len(stage["users"])
            expected_users_completed = sum(
                _user_is_completed(user) for user in stage["users"].values()
            )
            if (
                stage["postsTotal"] != expected_posts_total
                or stage["postsCompleted"] != expected_posts_completed
                or stage["usersTotal"] != expected_users_total
                or stage["usersCompleted"] != expected_users_completed
            ):
                raise WorkflowStateError(
                    "Workflow-state audience aggregate counts do not match its ledgers"
                )
            return
        _require_string_list(stage.get("generatedFiles"), "artifacts.generatedFiles")
        _require_string_list(stage.get("failedFiles"), "artifacts.failedFiles")
        if stage["status"] == "completed" and stage["failedFiles"]:
            raise WorkflowStateError(
                "Completed artifacts cannot contain failed files"
            )

    def scope_selects(self, stage: str) -> bool:
        if stage not in STAGE_NAMES:
            raise WorkflowStateError(f"Unsupported workflow stage: {stage}")
        return stage in RESUME_SCOPE_STAGES[self.resume_scope]

    def stage_status(self, stage: str) -> str:
        value = self.state.get("stages", {}).get(stage, {})
        return str(value.get("status") or "not_started") if isinstance(value, dict) else "not_started"

    def should_run(self, stage: str, *, force: bool = False) -> bool:
        return self.scope_selects(stage) and (force or self.stage_status(stage) != "completed")

    def start_stage(self, stage: str, patch: dict[str, Any] | None = None) -> dict[str, Any]:
        now = utc_now()
        values = {
            "status": "running",
            "attemptId": self.attempt_id,
            "lastCheckpointAt": now,
            **(patch or {}),
        }
        current = self.state.get("stages", {}).get(stage, {})
        if not isinstance(current, dict) or not current.get("startedAt"):
            values["startedAt"] = now
        return self.update_stage(stage, values)

    def finish_stage(
        self,
        stage: str,
        status: str,
        patch: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if status not in {"partial", "blocked", *TERMINAL_STAGE_STATUSES}:
            raise WorkflowStateError(f"Unsupported terminal stage status: {status}")
        now = utc_now()
        return self.update_stage(stage, {
            "status": status,
            "attemptId": self.attempt_id,
            "lastCheckpointAt": now,
            "finishedAt": now,
            **(patch or {}),
        })

    def update_stage(self, stage: str, patch: dict[str, Any]) -> dict[str, Any]:
        if stage not in STAGE_NAMES:
            raise WorkflowStateError(f"Unsupported workflow stage: {stage}")

        def mutate(next_state: dict[str, Any]) -> None:
            stages = next_state.setdefault("stages", {})
            existing = stages.get(stage)
            stages[stage] = _deep_merge(existing if isinstance(existing, dict) else {}, patch)

        return self._update(mutate)

    def checkpoint_body(
        self,
        *,
        cards: list[dict[str, Any]],
        complete_records: list[dict[str, Any]],
        failures: list[dict[str, Any]],
        attempted_ids: set[str],
        summary: dict[str, Any] | None = None,
        status: str = "running",
    ) -> dict[str, Any]:
        complete_ids = {_record_id(item) for item in complete_records if _record_id(item)}
        failures_by_id = {_record_id(item): item for item in failures if _record_id(item)}
        now = utc_now()

        def mutate(next_state: dict[str, Any]) -> None:
            stage = next_state.setdefault("stages", {}).setdefault("bodyCompletion", {})
            records = stage.setdefault("records", {})
            source_revision = int(next_state.get("revision") or self.revision)
            for card in cards:
                note_id = _record_id(card)
                if not note_id:
                    continue
                previous = records.get(note_id) if isinstance(records.get(note_id), dict) else {}
                record = copy.deepcopy(previous)
                attempted = note_id in attempted_ids
                if attempted and record.get("lastAttemptId") != self.attempt_id:
                    record["attemptCount"] = int(record.get("attemptCount") or 0) + 1
                    record.setdefault("firstAttemptAt", now)
                    record["lastAttemptAt"] = now
                    record["lastAttemptId"] = self.attempt_id
                failure = failures_by_id.get(note_id, {})
                failure_code = str(failure.get("access_status") or "")
                if note_id in complete_ids:
                    record.update({
                        "status": "succeeded",
                        "completedAt": record.get("completedAt") or now,
                        "failureCode": "",
                        "recoverable": False,
                    })
                elif failure:
                    blocked = "security" in failure_code or "rate_limit" in failure_code
                    record.update({
                        "status": "blocked" if blocked else "failed",
                        "failureCode": failure_code or "missing_record",
                        "recoverable": True,
                    })
                elif attempted:
                    record.update({"status": "attempted", "recoverable": True})
                else:
                    record.setdefault("status", "not_attempted")
                    record.setdefault("attemptCount", 0)
                    record.setdefault("recoverable", True)
                record["noteId"] = note_id
                record["sourceRevision"] = source_revision
                records[note_id] = record
            completed_count = sum(
                _body_record_is_completed(record) for record in records.values()
            )
            stage.update({
                "status": status,
                "attemptId": self.attempt_id,
                "lastCheckpointAt": now,
                "totalCount": len(records),
                "completedCount": completed_count,
                "remainingCount": len(records) - completed_count,
            })
            if summary:
                stage["stopReason"] = str(summary.get("stopReason") or "")

        return self._update(mutate)

    def checkpoint_analysis(
        self,
        payload: dict[str, Any],
        *,
        status: str = "running",
    ) -> dict[str, Any]:
        now = utc_now()

        def mutate(next_state: dict[str, Any]) -> None:
            stage = next_state.setdefault("stages", {}).setdefault("analysis", {})
            records = stage.setdefault("records", {})
            for item in payload.get("records", []):
                if not isinstance(item, dict):
                    continue
                record_id = _record_id(item)
                if not record_id:
                    continue
                previous = records.get(record_id) if isinstance(records.get(record_id), dict) else {}
                source_hash = analysis_source_hash(item)
                complete = not _analysis_record_incomplete(item, payload.get("analysis_mode"))
                entry = copy.deepcopy(previous)
                attempted = not complete or entry.get("sourceHash") != source_hash
                if attempted and entry.get("lastAttemptId") != self.attempt_id:
                    entry["attemptCount"] = int(entry.get("attemptCount") or 0) + 1
                    entry["lastAttemptId"] = self.attempt_id
                entry.update({
                    "recordId": record_id,
                    "sourceHash": source_hash,
                    "analysisStatus": "completed" if complete else "partial",
                    "completedStages": list(range(1, 9)) if complete else list(entry.get("completedStages") or []),
                    "lastCompletedStage": 8 if complete else entry.get("lastCompletedStage"),
                    "resultHash": stable_hash(item) if complete else str(entry.get("resultHash") or ""),
                    "failureCode": "" if complete else str(entry.get("failureCode") or "analysis_incomplete"),
                    "lastAttemptAt": now if attempted else entry.get("lastAttemptAt"),
                })
                records[record_id] = entry
            complete_count = sum(
                _analysis_record_is_completed(record) for record in records.values()
            )
            stage.update({
                "status": status,
                "attemptId": self.attempt_id,
                "lastCheckpointAt": now,
                "totalCount": len(records),
                "completedCount": complete_count,
                "remainingCount": len(records) - complete_count,
            })

        return self._update(mutate)

    def checkpoint_audience(
        self,
        *,
        posts: list[dict[str, Any]],
        users: list[dict[str, Any]],
        summary: dict[str, Any],
        status: str = "running",
    ) -> dict[str, Any]:
        now = utc_now()

        def mutate(next_state: dict[str, Any]) -> None:
            stage = next_state.setdefault("stages", {}).setdefault("audience", {})
            post_ledger = stage.setdefault("posts", {})
            user_ledger = stage.setdefault("users", {})
            for post in posts:
                post_id = str(post.get("post_id") or "").strip()
                if not post_id:
                    continue
                previous = post_ledger.get(post_id) if isinstance(post_ledger.get(post_id), dict) else {}
                entry = copy.deepcopy(previous)
                last_attempt_at = post.get("last_attempt_at") or post.get("last_collected_at")
                if entry.get("lastAttemptId") != self.attempt_id and last_attempt_at:
                    entry["attemptCount"] = int(entry.get("attemptCount") or 0) + 1
                    entry["lastAttemptId"] = self.attempt_id
                collected = int(post.get("collected_comment_count") or 0)
                comment_status = str(post.get("status") or "pending")
                entry.update({
                    "postId": post_id,
                    "commentStatus": comment_status,
                    "commentCursor": post.get("comment_cursor"),
                    "replyCursor": post.get("reply_cursor"),
                    "hasMore": comment_status != "complete",
                    "commentsCollected": collected,
                    "repliesCollected": int(post.get("reply_count") or 0),
                    "stopReason": str(post.get("failure_reason") or ""),
                    "lastAttemptAt": last_attempt_at or entry.get("lastAttemptAt"),
                })
                post_ledger[post_id] = entry
            for user in users:
                user_id = str(user.get("user_id") or "").strip()
                if not user_id:
                    continue
                previous = user_ledger.get(user_id) if isinstance(user_ledger.get(user_id), dict) else {}
                entry = copy.deepcopy(previous)
                last_attempt_at = user.get("last_attempt_at") or user.get("last_enriched_at")
                if entry.get("lastAttemptId") != self.attempt_id and last_attempt_at:
                    entry["attemptCount"] = int(entry.get("attemptCount") or 0) + 1
                    entry["lastAttemptId"] = self.attempt_id
                entry.update({
                    "userId": user_id,
                    "profileStatus": str(user.get("enrichment_status") or "pending"),
                    "lastAttemptAt": last_attempt_at or entry.get("lastAttemptAt"),
                    "failureCode": str(user.get("access_status") or ""),
                })
                user_ledger[user_id] = entry
            posts_completed = sum(
                _post_is_completed(post) for post in post_ledger.values()
            )
            users_completed = sum(
                _user_is_completed(user) for user in user_ledger.values()
            )
            stage.update({
                "status": status,
                "attemptId": self.attempt_id,
                "lastCheckpointAt": now,
                "stopReason": str(summary.get("stopReason") or ""),
                "postsTotal": len(post_ledger),
                "postsCompleted": posts_completed,
                "usersTotal": len(user_ledger),
                "usersCompleted": users_completed,
            })

        return self._update(mutate)

    def _update(self, mutate: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        with _workflow_state_lock(self.state_path):
            current = _normalize_state(_read_object(self.state_path))
            self._validate_state(
                current,
                state_path=self.state_path,
                output_dir=self.output_dir,
                attempt_id=self.attempt_id,
                expected_revision=self.revision,
            )
            next_state = copy.deepcopy(current)
            mutate(next_state)
            next_state = _normalize_state(next_state)
            next_revision = self.revision + 1
            next_state["schemaVersion"] = SCHEMA_VERSION
            next_state["jobId"] = current["jobId"]
            next_state["revision"] = next_revision
            next_state["updatedAt"] = utc_now()
            attempts = next_state.get("attempts", [])
            for attempt in attempts:
                if isinstance(attempt, dict) and attempt.get("attemptId") == self.attempt_id:
                    attempt["checkpointRevisionAtEnd"] = next_revision
                    attempt["lastCheckpointAt"] = next_state["updatedAt"]
                    break
            self._validate_state(
                next_state,
                state_path=self.state_path,
                output_dir=self.output_dir,
                attempt_id=self.attempt_id,
                expected_revision=next_revision,
            )
            _write_json_atomically(self.state_path, next_state)
        self.revision = next_revision
        self.state = next_state
        return copy.deepcopy(next_state)


def open_workflow_state_from_args(
    options: Any,
    output_dir: Path,
) -> WorkflowStateSession | None:
    values = {
        "resume_scope": getattr(options, "resume_scope", None),
        "attempt_id": getattr(options, "attempt_id", None),
        "state_path": getattr(options, "state_path", None),
        "expected_state_revision": getattr(options, "expected_state_revision", None),
    }
    present = [value not in (None, "") for value in values.values()]
    if not any(present):
        return None
    if not all(present):
        missing = [key for key, value in values.items() if value in (None, "")]
        raise WorkflowStateError(f"Incomplete Runner workflow-state arguments: {', '.join(missing)}")
    return WorkflowStateSession.open(
        output_dir=output_dir,
        state_path=Path(str(values["state_path"])),
        attempt_id=str(values["attempt_id"]),
        resume_scope=str(values["resume_scope"]),
        expected_revision=int(values["expected_state_revision"]),
    )


def _record_id(record: dict[str, Any]) -> str:
    return str(record.get("note_id") or record.get("noteId") or record.get("note_url") or "").strip()


def _analysis_record_incomplete(record: dict[str, Any], analysis_mode: Any) -> bool:
    from ai_application_workflow import record_needs_completion, record_needs_content_completion

    if str(analysis_mode or "") == "general":
        return record_needs_content_completion(record)
    return record_needs_completion(record)
