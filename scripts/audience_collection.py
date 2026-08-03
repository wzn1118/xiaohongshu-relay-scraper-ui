from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

try:
    from workflow_state import open_workflow_state_from_args
except ModuleNotFoundError:
    from scripts.workflow_state import open_workflow_state_from_args

try:
    from artifact_io import atomic_write_json
except ModuleNotFoundError:
    from scripts.artifact_io import atomic_write_json

try:
    from audience_resume import (
        apply_response_checkpoint,
        checkpoint_metrics,
        choose_resume_strategy,
        exact_resume_supported,
        initialize_post_checkpoint,
        initialize_user_checkpoint,
        mark_post_attempt,
        mark_user_attempt,
        refresh_post_counts,
        resolve_anchor_observation,
        response_page_event,
        set_post_terminal,
        set_resume_strategy,
        set_user_terminal,
    )
except ModuleNotFoundError:
    from scripts.audience_resume import (
        apply_response_checkpoint,
        checkpoint_metrics,
        choose_resume_strategy,
        exact_resume_supported,
        initialize_post_checkpoint,
        initialize_user_checkpoint,
        mark_post_attempt,
        mark_user_attempt,
        refresh_post_counts,
        resolve_anchor_observation,
        response_page_event,
        set_post_terminal,
        set_resume_strategy,
        set_user_terminal,
    )


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_UPSTREAM_SCRAPER = PROJECT_ROOT / "vendor/xiaohongshu-relay-scrape/scripts/scrape_xiaohongshu_search.py"
COMMENT_RESPONSE_MARKERS = ("comment/page", "comment/sub", "comment/list", "/comment")
SECURITY_MARKERS = (
    "请完成验证",
    "拖动滑块",
    "滑块验证",
    "captcha",
    "人机验证",
    "验证后继续",
    "请选择最符合描述的两张图片",
)
RATE_LIMIT_MARKERS = ("访问频繁", "请稍后再试", "error_code=300013")
MORE_REPLY_PATTERN = re.compile(r"(?:展开|查看|更多|显示).{0,12}(?:回复|评论)|(?:回复|评论).{0,12}(?:更多|全部)")
COMMENT_EXHAUSTED_PATTERN = re.compile(r"没有更多(?:评论|回复)|已显示全部(?:评论|回复)|到底了|-\s*THE END\s*-")
COMMENT_EMPTY_PATTERN = re.compile(r"暂无评论|还没有评论|来抢沙发|成为第一个评论|这是一片荒地")
RESUMABLE_AUDIENCE_POST_STATUSES = frozenset({"pending", "partial", "failed"})
PROFILE_CATCHUP_BATCH_SIZE = 12
LEGACY_DUPLICATE_AVATAR_THRESHOLD = 8
# This asset was captured from the logged-in account/sidebar by the legacy
# generic `.avatar img` selector instead of from the viewed user profile.
KNOWN_NON_PROFILE_AVATAR_MARKERS = frozenset({"645b7e371fc3de4c930eff9d"})
LEGACY_SHELL_AVATAR_MARKERS = frozenset({
    "sidebar-account",
    "account-sidebar",
    "nav-account-avatar",
    "logged-in-account",
})
AUDIENCE_CHECKPOINT_FILENAMES = (
    "xiaohongshu_notes_latest.json",
    "audience-posts.json",
    "audience-comments.json",
    "audience-users.json",
    "audience-failures.json",
    "audience-summary.json",
)
CONTENT_INSIGHT_SOURCE_FILENAMES = (
    "application_intelligence.json",
    "xiaohongshu_cards_latest.json",
    "xiaohongshu_notes_latest.json",
)
AUDIENCE_READTHROUGH_SOURCE_FILENAMES = tuple(dict.fromkeys((
    *AUDIENCE_CHECKPOINT_FILENAMES,
    *CONTENT_INSIGHT_SOURCE_FILENAMES,
)))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _profile_progress(users_by_id: dict[str, dict[str, Any]]) -> tuple[int, int]:
    return (
        sum(1 for user in users_by_id.values() if user.get("enrichment_status") == "complete"),
        len(users_by_id),
    )


def atomic_json(path: Path, payload: Any) -> None:
    atomic_write_json(path, payload)


def load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _normalized_checkpoint_dirs(
    output_dir: Path,
    checkpoint_dirs: Iterable[str | Path],
) -> list[Path]:
    normalized: list[Path] = []
    seen = {output_dir.resolve()}
    for raw_path in checkpoint_dirs:
        checkpoint_dir = Path(raw_path).resolve()
        if checkpoint_dir in seen:
            continue
        if not checkpoint_dir.is_dir():
            raise ValueError(f"Audience resume checkpoint directory was not found: {checkpoint_dir}")
        seen.add(checkpoint_dir)
        normalized.append(checkpoint_dir)
    return normalized


def _copy_verified(source: Path, destination: Path) -> str:
    destination.parent.mkdir(parents=True, exist_ok=True)
    expected_hash = _file_sha256(source)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    try:
        with source.open("rb") as source_handle, temporary.open("wb") as destination_handle:
            shutil.copyfileobj(source_handle, destination_handle)
            destination_handle.flush()
            os.fsync(destination_handle.fileno())
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    if _file_sha256(destination) != expected_hash:
        raise OSError(f"Audience resume backup verification failed: {destination}")
    return expected_hash


def _verify_readthrough_sources(manifest: dict[str, Any]) -> None:
    for entry in manifest.get("sourceFiles", []):
        path = Path(str(entry.get("path") or ""))
        expected_hash = str(entry.get("sha256") or "")
        if not path.is_file() or not expected_hash or _file_sha256(path) != expected_hash:
            raise RuntimeError(f"Audience resume checkpoint changed during read-through: {path}")


def _prepare_readthrough_manifest(
    output_dir: Path,
    checkpoint_dirs: list[Path],
    attempt_id: str,
) -> tuple[Path | None, dict[str, Any] | None]:
    if not checkpoint_dirs:
        return None, None
    identity = attempt_id.strip() or hashlib.sha256(
        "\n".join(str(path) for path in checkpoint_dirs).encode("utf-8")
    ).hexdigest()[:16]
    safe_identity = re.sub(r"[^A-Za-z0-9._-]+", "_", identity)[:96] or "readthrough"
    # Keep recovery metadata beside the job artifacts so artifact enumeration
    # never exposes internal attempt backups as user-facing output.
    backup_dir = output_dir.parent / "attempts" / safe_identity / "readthrough-backup"
    manifest_path = backup_dir / "readthrough-manifest.json"
    existing_manifest = load_json(manifest_path, None)
    if isinstance(existing_manifest, dict):
        _verify_readthrough_sources(existing_manifest)
        return manifest_path, existing_manifest

    source_files: list[dict[str, str]] = []
    for checkpoint_dir in checkpoint_dirs:
        for filename in AUDIENCE_READTHROUGH_SOURCE_FILENAMES:
            source_path = checkpoint_dir / filename
            if source_path.is_file():
                source_files.append({
                    "checkpointDir": str(checkpoint_dir),
                    "filename": filename,
                    "path": str(source_path),
                    "sha256": _file_sha256(source_path),
                })

    target_backups: list[dict[str, str]] = []
    for filename in AUDIENCE_CHECKPOINT_FILENAMES:
        target_path = output_dir / filename
        if not target_path.is_file():
            continue
        backup_path = backup_dir / "target-before-readthrough" / filename
        target_backups.append({
            "filename": filename,
            "targetPath": str(target_path),
            "backupPath": str(backup_path),
            "sha256": _copy_verified(target_path, backup_path),
        })

    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "mode": "read_through",
        "status": "prepared",
        "attemptId": attempt_id,
        "createdAt": utc_now(),
        "targetOutputDir": str(output_dir),
        "checkpointDirs": [str(path) for path in checkpoint_dirs],
        "conflictPolicy": "target_fields_win; source_fills_missing; status_and_counts_are_monotonic",
        "rollbackDirectory": str(backup_dir / "target-before-readthrough"),
        "sourceFiles": source_files,
        "targetBackups": target_backups,
        "targetState": "prepared",
        "sourceIntegrity": "pending",
    }
    atomic_json(manifest_path, manifest)
    return manifest_path, manifest


def _rollback_readthrough_target(
    output_dir: Path,
    manifest_path: Path,
    manifest: dict[str, Any],
    error: BaseException,
) -> list[str]:
    current_manifest = load_json(manifest_path, manifest)
    if not isinstance(current_manifest, dict):
        current_manifest = dict(manifest)
    rollback_errors: list[str] = []
    restored_files: list[str] = []
    deleted_files: list[str] = []
    backed_up_names: set[str] = set()

    for entry in current_manifest.get("targetBackups", []):
        if not isinstance(entry, dict):
            continue
        filename = str(entry.get("filename") or "")
        if filename not in AUDIENCE_CHECKPOINT_FILENAMES:
            rollback_errors.append(f"invalid backup filename: {filename}")
            continue
        backed_up_names.add(filename)
        backup_path = Path(str(entry.get("backupPath") or ""))
        expected_hash = str(entry.get("sha256") or "")
        target_path = output_dir / filename
        try:
            if not backup_path.is_file() or not expected_hash:
                raise OSError(f"rollback backup is unavailable: {backup_path}")
            if _file_sha256(backup_path) != expected_hash:
                raise OSError(f"rollback backup hash mismatch: {backup_path}")
            _copy_verified(backup_path, target_path)
            if _file_sha256(target_path) != expected_hash:
                raise OSError(f"restored target hash mismatch: {target_path}")
            restored_files.append(filename)
        except OSError as rollback_error:
            rollback_errors.append(str(rollback_error))

    for filename in AUDIENCE_CHECKPOINT_FILENAMES:
        if filename in backed_up_names:
            continue
        target_path = output_dir / filename
        try:
            if target_path.exists():
                target_path.unlink()
                deleted_files.append(filename)
        except OSError as rollback_error:
            rollback_errors.append(str(rollback_error))

    source_integrity = "verified"
    source_integrity_error = ""
    try:
        _verify_readthrough_sources(current_manifest)
    except RuntimeError as integrity_error:
        source_integrity = "failed"
        source_integrity_error = str(integrity_error)

    rolled_back_manifest = {
        **current_manifest,
        "status": "rollback_failed" if rollback_errors else "rolled_back",
        "targetState": "rollback_failed" if rollback_errors else "rolled_back",
        "rollbackReason": f"{type(error).__name__}: {str(error)[:1000]}",
        "rolledBackAt": utc_now(),
        "restoredFiles": restored_files,
        "deletedFiles": deleted_files,
        "rollbackErrors": rollback_errors,
        "sourceIntegrity": source_integrity,
    }
    if source_integrity_error:
        rolled_back_manifest["sourceIntegrityError"] = source_integrity_error
    try:
        atomic_json(manifest_path, rolled_back_manifest)
    except OSError as manifest_error:
        rollback_errors.append(str(manifest_error))
    return rollback_errors


def _record_key(record: dict[str, Any], *fields: str) -> str:
    for field in fields:
        value = clean_text(record.get(field), 2000)
        if value:
            return value
    return ""


def _enrich_current_record(current: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(current)
    for field, value in incoming.items():
        if merged.get(field) in (None, "", [], {}) and value not in (None, "", [], {}):
            merged[field] = value
    return merged


def _content_post_url(record: dict[str, Any]) -> str:
    return clean_text(first_value(
        record,
        "note_url",
        "search_result_url",
        "explore_url",
        "card_search_result_url",
        "card_explore_url",
    ), 2000)


def _content_post_id(record: dict[str, Any]) -> str:
    note_url = _content_post_url(record)
    url_match = re.search(r"/(?:search_result|explore)/([^/?#]+)", note_url)
    if url_match:
        return clean_text(url_match.group(1), 200)
    return clean_text(first_value(record, "note_id", "id"), 200)


def _load_content_insight_records(
    output_dir: Path,
    checkpoint_dirs: list[Path],
    merged_notes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    directories = [output_dir, *checkpoint_dirs]
    application_groups: list[list[dict[str, Any]]] = []
    card_groups: list[list[dict[str, Any]]] = []
    note_groups: list[list[dict[str, Any]]] = []
    for directory in directories:
        application_payload = load_json(directory / "application_intelligence.json", {})
        application_records = application_payload.get("records", []) if isinstance(application_payload, dict) else []
        application_groups.append([
            item for item in application_records
            if isinstance(item, dict) and _content_post_id(item) and _content_post_url(item)
        ])

        cards_payload = load_json(directory / "xiaohongshu_cards_latest.json", [])
        cards = cards_payload if isinstance(cards_payload, list) else cards_payload.get("cards", []) if isinstance(cards_payload, dict) else []
        card_groups.append([
            item for item in cards
            if isinstance(item, dict) and _content_post_id(item) and _content_post_url(item)
        ])
        note_groups.append([
            item for item in load_json(directory / "xiaohongshu_notes_latest.json", [])
            if isinstance(item, dict) and _content_post_id(item) and _content_post_url(item)
        ])

    owner_records = next((group for group in application_groups if group), [])
    if not owner_records:
        owner_records = next((group for group in card_groups if group), [])
    if not owner_records:
        owner_records = [
            item for item in merged_notes
            if _content_post_id(item) and _content_post_url(item)
        ]

    metadata_by_id: dict[str, dict[str, Any]] = {}
    for record in [
        *[item for group in note_groups for item in group],
        *[item for group in card_groups for item in group],
    ]:
        post_id = _content_post_id(record)
        metadata_by_id[post_id] = _enrich_current_record(
            metadata_by_id.get(post_id, {}),
            record,
        )

    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for owner in owner_records:
        post_id = _content_post_id(owner)
        if not post_id or post_id in seen:
            continue
        seen.add(post_id)
        records.append(_enrich_current_record(owner, metadata_by_id.get(post_id, {})))
    return records


def load_upstream(path: Path):
    resolved = path.resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"Upstream scraper was not found: {resolved}")
    module_dir = str(resolved.parent)
    if module_dir not in sys.path:
        sys.path.insert(0, module_dir)
    spec = importlib.util.spec_from_file_location("xiaohongshu_audience_upstream", resolved)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load upstream scraper: {resolved}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def compact_count(value: Any) -> int | None:
    if value is None or value == "":
        return None
    text = str(value).strip().replace(",", "")
    match = re.search(r"(\d+(?:\.\d+)?)\s*([万千wWkK]?)", text)
    if not match:
        return None
    number = float(match.group(1))
    multiplier = {"万": 10000, "w": 10000, "W": 10000, "千": 1000, "k": 1000, "K": 1000}.get(match.group(2), 1)
    return int(number * multiplier)


def clean_text(value: Any, limit: int = 4000) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def first_value(source: dict[str, Any], *names: str) -> Any:
    for name in names:
        value = source.get(name)
        if value not in (None, "", [], {}):
            return value
    return ""


def profile_url(user_id: str, xsec_token: str = "") -> str:
    if not user_id:
        return ""
    suffix = f"?xsec_token={xsec_token}" if xsec_token else ""
    return f"https://www.xiaohongshu.com/user/profile/{user_id}{suffix}"


def avatar_fingerprint(value: Any) -> str:
    url = clean_text(value, 2000)
    if not url or not re.match(r"^https?://", url, re.IGNORECASE):
        return ""
    return url.split("?", 1)[0].rstrip("/").casefold()


def clean_avatar_url(value: Any) -> str:
    url = clean_text(value, 2000)
    fingerprint = avatar_fingerprint(url)
    if not fingerprint:
        return ""
    if any(marker in fingerprint for marker in KNOWN_NON_PROFILE_AVATAR_MARKERS):
        return ""
    return url


def legacy_duplicate_avatar_fingerprints(
    users: Iterable[dict[str, Any]],
    *,
    threshold: int = LEGACY_DUPLICATE_AVATAR_THRESHOLD,
) -> set[str]:
    """Find repeated avatars with evidence that they came from legacy shell chrome.

    Repetition alone is not corruption evidence: platform default avatars may be
    legitimately shared by many users.
    """
    counts = Counter(
        fingerprint
        for user in users
        if not clean_text(user.get("profile_avatar_source"), 80)
        for fingerprint in [avatar_fingerprint(user.get("avatar_url"))]
        if fingerprint
    )
    return {
        fingerprint
        for fingerprint, count in counts.items()
        if count >= max(2, int(threshold))
        and (
            any(marker in fingerprint for marker in KNOWN_NON_PROFILE_AVATAR_MARKERS)
            or any(marker in fingerprint for marker in LEGACY_SHELL_AVATAR_MARKERS)
        )
    }


def restore_legacy_avatar_urls(
    users_by_id: dict[str, dict[str, Any]],
    trusted_sources: Iterable[tuple[str, dict[str, Any]]],
    invalid_avatar_fingerprints: set[str],
) -> list[str]:
    """Restore polluted profile avatars from saved API/post checkpoints."""
    restored_ids: list[str] = []
    restored: set[str] = set()
    for source_name, incoming in trusted_sources:
        user_id = clean_text(first_value(incoming, "user_id", "userid", "id", "userId"), 160)
        current = users_by_id.get(user_id)
        if not user_id or not current or user_id in restored:
            continue
        current_raw = clean_text(current.get("avatar_url"), 2000)
        current_fingerprint = avatar_fingerprint(current_raw)
        current_invalid = (
            not clean_avatar_url(current_raw)
            or current_fingerprint in invalid_avatar_fingerprints
        )
        if not current_invalid:
            continue
        incoming_avatar = clean_avatar_url(
            first_value(incoming, "avatar_url", "avatar", "image", "imageb")
        )
        incoming_fingerprint = avatar_fingerprint(incoming_avatar)
        if not incoming_avatar or incoming_fingerprint in invalid_avatar_fingerprints:
            continue
        current["avatar_url"] = incoming_avatar
        current["profile_avatar_source"] = source_name
        missing_fields = [
            field
            for field in current.get("missing_profile_fields", [])
            if field != "avatar_url"
        ]
        if missing_fields:
            current["missing_profile_fields"] = missing_fields
        else:
            current.pop("missing_profile_fields", None)
        restored.add(user_id)
        restored_ids.append(user_id)
    return restored_ids


def normalize_user(raw: Any, *, role: str = "commenter") -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    user_id = clean_text(first_value(source, "user_id", "userid", "id", "userId"), 160)
    token = clean_text(first_value(source, "xsec_token", "xsecToken"), 800)
    name = clean_text(first_value(source, "nickname", "nick_name", "name", "display_name"), 200)
    avatar = clean_avatar_url(first_value(source, "image", "avatar", "avatar_url", "imageb"))
    url = clean_text(first_value(source, "profile_url", "user_url", "url"), 2000) or profile_url(user_id, token)
    stable = user_id or hashlib.sha256(f"{name}|{url}".encode("utf-8")).hexdigest()[:24]
    ip_location = clean_text(first_value(source, "ip_location"), 200)
    return {
        "user_id": stable,
        "display_name": name or "未命名用户",
        "profile_url": url,
        "avatar_url": avatar,
        "xhs_id": clean_text(first_value(source, "red_id", "xhs_id", "redId"), 200),
        "bio": clean_text(first_value(source, "desc", "description", "bio"), 1000),
        "ip_location": ip_location,
        "location": ip_location or clean_text(first_value(source, "location"), 200),
        "following_count": compact_count(first_value(source, "follows", "following_count")),
        "follower_count": compact_count(first_value(source, "fans", "follower_count")),
        "liked_and_collected_count": compact_count(first_value(source, "interaction", "liked_and_collected_count")),
        "roles": [role],
        "comment_count": 0,
        "post_ids": [],
        "enrichment_status": "pending" if url else "partial",
        "access_status": "discovered",
        "last_enriched_at": "",
    }


def merge_user(current: dict[str, Any] | None, incoming: dict[str, Any]) -> dict[str, Any]:
    if not current:
        merged = dict(incoming)
        merged["avatar_url"] = clean_avatar_url(merged.get("avatar_url"))
        return merged
    merged = dict(current)
    merged["avatar_url"] = clean_avatar_url(merged.get("avatar_url"))
    for field in (
        "display_name", "profile_url", "avatar_url", "xhs_id", "bio", "ip_location", "location",
        "following_count", "follower_count", "liked_and_collected_count",
    ):
        current_missing = merged.get(field) in (None, "", [], {})
        if field == "display_name" and merged.get(field) == "未命名用户":
            current_missing = True
        incoming_value = (
            clean_avatar_url(incoming.get(field))
            if field == "avatar_url"
            else incoming.get(field)
        )
        if incoming_value not in (None, "", [], {}) and current_missing:
            merged[field] = incoming_value
    merged["roles"] = sorted(set([*merged.get("roles", []), *incoming.get("roles", [])]))
    merged["post_ids"] = list(dict.fromkeys([*merged.get("post_ids", []), *incoming.get("post_ids", [])]))
    merged["comment_count"] = max(int(merged.get("comment_count") or 0), int(incoming.get("comment_count") or 0))
    return merged


def comment_records(payload: Any) -> Iterable[tuple[dict[str, Any], str]]:
    """Yield comment objects and inherited parent ids from nested API responses."""
    seen: set[int] = set()

    def walk(value: Any, inherited_parent: str = "") -> Iterable[tuple[dict[str, Any], str]]:
        if isinstance(value, list):
            for item in value:
                yield from walk(item, inherited_parent)
            return
        if not isinstance(value, dict):
            return
        identity = id(value)
        if identity in seen:
            return
        seen.add(identity)
        user = first_value(value, "user_info", "user", "userInfo")
        content = first_value(value, "content", "text", "comment_content")
        identifier = clean_text(first_value(value, "id", "comment_id", "commentId"), 200)
        is_comment = isinstance(user, dict) and content not in (None, "") and bool(identifier)
        if is_comment:
            yield value, inherited_parent
        child_parent = identifier if is_comment else inherited_parent
        child_fields = {"sub_comments", "subComments", "replies", "children", "comments"}
        for field, child in value.items():
            if field in {"user_info", "user", "userInfo"}:
                continue
            yield from walk(child, child_parent if field in child_fields else inherited_parent)

    yield from walk(payload)


def comment_objects(payload: Any) -> Iterable[dict[str, Any]]:
    for raw, _parent_id in comment_records(payload):
        yield raw


def normalize_comment(raw: dict[str, Any], *, post_id: str, note_url: str, parent_id: str = "") -> dict[str, Any]:
    user_raw = first_value(raw, "user_info", "user", "userInfo")
    user = normalize_user(user_raw, role="commenter")
    text = clean_text(first_value(raw, "content", "text", "comment_content"), 8000)
    comment_id = clean_text(first_value(raw, "id", "comment_id", "commentId"), 200)
    if not comment_id:
        comment_id = hashlib.sha256(f"{post_id}|{user['user_id']}|{text}".encode("utf-8")).hexdigest()[:32]
    parent = clean_text(first_value(raw, "parent_comment_id", "parent_id", "target_comment_id"), 200) or parent_id
    create_time = first_value(raw, "create_time", "createTime", "time", "publish_time")
    ip_location = clean_text(first_value(raw, "ip_location"), 200)
    return {
        "comment_id": comment_id,
        "post_id": post_id,
        "parent_comment_id": parent,
        "level": "reply" if parent else "comment",
        "text": text,
        "likes": compact_count(first_value(raw, "like_count", "likes", "likeCount")) or 0,
        "publish_time": clean_text(create_time, 200),
        "ip_location": ip_location,
        "location": ip_location,
        "source_url": note_url,
        "user": user,
        "collected_at": utc_now(),
    }


def extract_comments_from_payload(payload: Any, *, post_id: str, note_url: str) -> list[dict[str, Any]]:
    records: dict[str, dict[str, Any]] = {}
    for raw, parent_id in comment_records(payload):
        comment = normalize_comment(raw, post_id=post_id, note_url=note_url, parent_id=parent_id)
        records[comment["comment_id"]] = comment
    return list(records.values())


def parse_profile_snapshot(snapshot: dict[str, Any], existing: dict[str, Any]) -> dict[str, Any]:
    merged = dict(existing)
    merged["avatar_url"] = clean_avatar_url(merged.get("avatar_url"))
    identity_fields = ("display_name", "avatar_url", "xhs_id", "bio", "ip_location")
    metric_fields = ("following_count", "follower_count", "liked_and_collected_count")
    profile_verified = bool(snapshot.get("profile_loaded")) and any(
        clean_avatar_url(snapshot.get(field))
        if field == "avatar_url"
        else clean_text(snapshot.get(field), 2000)
        for field in identity_fields
    )
    if not profile_verified:
        merged["enrichment_status"] = "partial"
        merged["access_status"] = "profile_not_verified"
        merged["last_enriched_at"] = utc_now()
        return merged
    for field in identity_fields:
        value = (
            clean_avatar_url(snapshot.get(field))
            if field == "avatar_url"
            else clean_text(snapshot.get(field), 1000)
        )
        if value:
            merged[field] = value
            if field == "avatar_url":
                merged["profile_avatar_source"] = "profile_header"
    if merged.get("ip_location"):
        merged["location"] = merged["ip_location"]
    for field in metric_fields:
        value = compact_count(snapshot.get(field))
        if value is not None:
            merged[field] = value
    missing_metrics = [field for field in metric_fields if merged.get(field) is None]
    missing_fields = [*missing_metrics]
    if not clean_text(merged.get("ip_location"), 200):
        missing_fields.append("ip_location")
    if not clean_avatar_url(merged.get("avatar_url")):
        missing_fields.append("avatar_url")
    if missing_fields:
        merged["enrichment_status"] = "partial"
        merged["access_status"] = "profile_metrics_missing" if missing_metrics else "profile_fields_missing"
        merged["missing_profile_fields"] = missing_fields
        merged["last_enriched_at"] = utc_now()
        return merged
    merged["enrichment_status"] = "complete"
    merged["access_status"] = "public_profile_ok"
    merged.pop("missing_profile_fields", None)
    merged["last_enriched_at"] = utc_now()
    return merged


def invalidate_legacy_profile_snapshot(
    user: dict[str, Any],
    invalid_avatar_fingerprints: set[str] | None = None,
) -> bool:
    """Mark profiles affected by the old parent-container metric parser for refresh."""
    raw_avatar = clean_text(user.get("avatar_url"), 2000)
    fingerprint = avatar_fingerprint(raw_avatar)
    invalid_avatars = invalid_avatar_fingerprints or set()
    invalid_avatar = bool(raw_avatar) and (
        not clean_avatar_url(raw_avatar) or fingerprint in invalid_avatars
    )
    if invalid_avatar:
        user["avatar_url"] = ""
        user.pop("profile_avatar_source", None)
    if user.get("enrichment_status") != "complete" and not invalid_avatar:
        return False
    metrics = [
        user.get("following_count"),
        user.get("follower_count"),
        user.get("liked_and_collected_count"),
    ]
    duplicated_metrics = all(value is not None for value in metrics) and len(set(metrics)) == 1
    missing_metrics = any(value is None for value in metrics)
    missing_ip_location = not clean_text(user.get("ip_location"), 200)
    missing_avatar = not clean_avatar_url(user.get("avatar_url"))
    if not duplicated_metrics and not missing_metrics and not missing_ip_location and not missing_avatar:
        return False
    if duplicated_metrics:
        for field in ("following_count", "follower_count", "liked_and_collected_count"):
            user[field] = None
    user["missing_profile_fields"] = [
        field
        for field in (
            "following_count",
            "follower_count",
            "liked_and_collected_count",
            "ip_location",
            "avatar_url",
        )
        if user.get(field) is None
        or (field == "ip_location" and not clean_text(user.get(field), 200))
        or (field == "avatar_url" and not clean_avatar_url(user.get(field)))
    ]
    user["enrichment_status"] = "pending"
    user["access_status"] = "profile_refresh_required"
    user["profile_status"] = "not_started"
    user["failure_code"] = "profile_refresh_required"
    user["recoverable"] = True
    return True


def repair_audience_avatar_checkpoints(output_dir: Path) -> dict[str, Any]:
    """Repair legacy avatar pollution without repeating comment collection."""
    resolved = output_dir.resolve()
    users_path = resolved / "audience-users.json"
    posts_path = resolved / "audience-posts.json"
    comments_path = resolved / "audience-comments.json"
    summary_path = resolved / "audience-summary.json"
    users = [
        item for item in load_json(users_path, [])
        if isinstance(item, dict) and item.get("user_id")
    ]
    if not users:
        raise ValueError(f"Audience users checkpoint was not found: {users_path}")
    users_by_id = {str(item["user_id"]): item for item in users}
    invalid_avatars = legacy_duplicate_avatar_fingerprints(users)
    affected_ids = {
        str(user["user_id"])
        for user in users
        if (
            not clean_avatar_url(user.get("avatar_url"))
            or avatar_fingerprint(user.get("avatar_url")) in invalid_avatars
        )
    }
    comments = [item for item in load_json(comments_path, []) if isinstance(item, dict)]
    posts = [item for item in load_json(posts_path, []) if isinstance(item, dict)]
    trusted_sources = [
        ("comment_api", comment["user"])
        for comment in comments
        if isinstance(comment.get("user"), dict)
    ]
    trusted_sources.extend(
        ("post_checkpoint", post["author"])
        for post in posts
        if isinstance(post.get("author"), dict)
    )
    restored_ids = restore_legacy_avatar_urls(
        users_by_id,
        trusted_sources,
        invalid_avatars,
    )
    refresh_ids = [
        user_id
        for user_id in affected_ids
        if user_id not in restored_ids
        and invalidate_legacy_profile_snapshot(users_by_id[user_id], invalid_avatars)
    ]

    backup_path = resolved / ".avatar-repair-backup" / "audience-users.json"
    if not backup_path.exists():
        _copy_verified(users_path, backup_path)
    sorted_users = sorted(
        users_by_id.values(),
        key=lambda item: (-int(item.get("comment_count") or 0), item.get("display_name", "")),
    )
    atomic_json(users_path, sorted_users)

    summary = load_json(summary_path, {})
    if isinstance(summary, dict):
        profiles_complete, profiles_total = _profile_progress(users_by_id)
        summary["usersDiscovered"] = profiles_total
        summary["profilesComplete"] = profiles_complete
        summary["profileCoveragePercent"] = round(
            (profiles_complete / profiles_total * 100) if profiles_total else 0,
            2,
        )
        summary["generatedAt"] = utc_now()
        atomic_json(summary_path, summary)

    return {
        "affected": len(affected_ids),
        "restored": len(restored_ids),
        "scheduledForRelayRefresh": len(refresh_ids),
        "duplicateAvatarFingerprints": len(invalid_avatars),
        "backupPath": str(backup_path),
    }


def _challenge_status(text: str) -> str:
    folded = text.casefold()
    if any(marker.casefold() in folded for marker in RATE_LIMIT_MARKERS):
        return "rate_limited"
    if any(marker.casefold() in folded for marker in SECURITY_MARKERS):
        return "security_verification"
    # "安全验证" is also ordinary post text. Treat the generic phrase as a
    # challenge only when the page itself looks like a short verification view.
    if "安全验证" in folded:
        first_line, _, remainder = text.partition("\n")
        url = first_line.casefold() if "://" in first_line else ""
        body = clean_text(remainder if url else text, 4000)
        if any(marker in url for marker in ("/captcha", "/verify", "security_check")) or len(body) <= 240:
            return "security_verification"
    return ""


def _body_text(page: Any) -> str:
    try:
        return page.locator("body").inner_text(timeout=3000)
    except Exception:  # noqa: BLE001
        return ""


def _is_closed_target_error(error: BaseException) -> bool:
    text = f"{type(error).__name__}: {error}".casefold()
    return any(marker in text for marker in (
        "target page, context or browser has been closed",
        "targetclosederror",
        "browser has been closed",
        "context has been closed",
        "connection closed",
    ))


def _relay_listener_pid(relay_port: int) -> int | None:
    if os.name != "nt":
        return None
    try:
        result = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    endpoint_suffix = f":{int(relay_port)}"
    for line in result.stdout.splitlines():
        columns = line.split()
        if (
            len(columns) >= 5
            and columns[0].casefold() == "tcp"
            and columns[1].endswith(endpoint_suffix)
            and columns[3].casefold() == "listening"
            and columns[4].isdigit()
        ):
            return int(columns[4])
    return None


def _focus_windows_process_window(process_id: int | None) -> bool:
    if os.name != "nt" or not process_id:
        return False
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.WinDLL("user32", use_last_error=True)
        enum_proc_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        user32.EnumWindows.argtypes = (enum_proc_type, wintypes.LPARAM)
        user32.EnumWindows.restype = wintypes.BOOL
        user32.IsWindowVisible.argtypes = (wintypes.HWND,)
        user32.IsWindowVisible.restype = wintypes.BOOL
        user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
        user32.GetWindowThreadProcessId.restype = wintypes.DWORD
        user32.ShowWindow.argtypes = (wintypes.HWND, ctypes.c_int)
        user32.ShowWindow.restype = wintypes.BOOL
        user32.BringWindowToTop.argtypes = (wintypes.HWND,)
        user32.BringWindowToTop.restype = wintypes.BOOL
        user32.SetForegroundWindow.argtypes = (wintypes.HWND,)
        user32.SetForegroundWindow.restype = wintypes.BOOL
        user32.SetWindowPos.argtypes = (
            wintypes.HWND,
            wintypes.HWND,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.UINT,
        )
        user32.SetWindowPos.restype = wintypes.BOOL
        matches: list[Any] = []

        @enum_proc_type
        def visit(hwnd: Any, _lparam: Any) -> bool:
            if not user32.IsWindowVisible(hwnd):
                return True
            owner_pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner_pid))
            if owner_pid.value == process_id:
                matches.append(hwnd)
                return False
            return True

        user32.EnumWindows(visit, 0)
        if not matches:
            return False
        hwnd = matches[0]
        user32.ShowWindow(hwnd, 9)
        user32.SetWindowPos(hwnd, wintypes.HWND(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
        user32.SetWindowPos(hwnd, wintypes.HWND(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        return True
    except (AttributeError, OSError, TypeError, ValueError):
        return False


def _show_verification_notification() -> bool:
    if os.name != "nt":
        return False
    script = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$n=New-Object System.Windows.Forms.NotifyIcon;"
        "$n.Icon=[System.Drawing.SystemIcons]::Warning;"
        "$n.BalloonTipTitle='采集任务需要安全验证';"
        "$n.BalloonTipText='验证页已置顶。完成验证后，原任务会自动继续。';"
        "$n.Visible=$true;$n.ShowBalloonTip(12000);"
        "Start-Sleep -Seconds 13;$n.Dispose()"
    )
    try:
        subprocess.Popen(
            ["powershell.exe", "-NoProfile", "-WindowStyle", "Hidden", "-Command", script],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return True
    except OSError:
        return False


def _surface_security_verification(page: Any, relay_port: int) -> tuple[bool, bool]:
    try:
        page.bring_to_front()
    except Exception:  # noqa: BLE001
        pass
    focused = _focus_windows_process_window(_relay_listener_pid(relay_port))
    notified = _show_verification_notification()
    print(
        f"SECURITY_VERIFICATION attention page_front=true window_front={str(focused).lower()} "
        f"notification={str(notified).lower()}",
        flush=True,
    )
    return focused, notified


def _wait_for_manual_verification(
    page: Any,
    timeout_seconds: int,
    *,
    checkpoint_callback: Callable[[], Any] | None = None,
    reload_interval_seconds: float | None = None,
) -> tuple[bool, str]:
    deadline = time.monotonic() + timeout_seconds
    next_checkpoint = time.monotonic()
    reload_enabled = reload_interval_seconds is not None and reload_interval_seconds > 0
    next_reload = time.monotonic() + reload_interval_seconds if reload_enabled else float("inf")
    while time.monotonic() < deadline:
        status = _challenge_status(f"{getattr(page, 'url', '')}\n{_body_text(page)}")
        if status == "rate_limited":
            return False, status
        if not status:
            return True, ""
        if checkpoint_callback is not None and time.monotonic() >= next_checkpoint:
            checkpoint_callback()
            next_checkpoint = time.monotonic() + 15
        if reload_enabled and time.monotonic() >= next_reload:
            try:
                page.reload(wait_until="domcontentloaded", timeout=30_000)
            except Exception:  # noqa: BLE001
                pass
            next_reload = time.monotonic() + max(15.0, reload_interval_seconds or 0)
        time.sleep(min(3, max(0.1, deadline - time.monotonic())))
    return False, "security_verification_timeout"


def _comment_api_exhausted(responses: Iterable[tuple[str, Any]]) -> bool:
    """Return true when a top-level comment endpoint proves its final page."""
    for url, payload in responses:
        lowered_url = str(url or "").casefold()
        if "comment/sub" in lowered_url or not any(
            marker in lowered_url for marker in ("comment/page", "comment/list")
        ):
            continue
        data = payload.get("data") if isinstance(payload, dict) else None
        if isinstance(data, dict) and data.get("has_more") is False:
            return True
        if isinstance(data, dict) and data.get("hasMore") is False:
            return True
    return False


def _wait_for_rate_limit_recovery(
    page: Any,
    *,
    max_retries: int = 5,
    initial_delay_seconds: float = 15.0,
    max_delay_seconds: float = 120.0,
    reload_timeout_ms: int = 15000,
    checkpoint_callback: Callable[[], Any] | None = None,
    manual_recovery_path: Path | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[bool, str]:
    """Back off after a rate limit and probe the current page before resuming."""
    retries = max(0, int(max_retries))
    initial_delay = max(0.0, float(initial_delay_seconds))
    maximum_delay = max(initial_delay, float(max_delay_seconds))
    for attempt in range(1, retries + 1):
        delay = min(maximum_delay, initial_delay * (2 ** (attempt - 1)))
        if checkpoint_callback is not None:
            checkpoint_callback()
        print(
            f"AUDIENCE_RATE_LIMIT retry={attempt}/{retries} wait={delay:g}s; checkpoint preserved",
            flush=True,
        )
        remaining = delay
        while remaining > 0:
            step = min(1.0 if manual_recovery_path is not None else 5.0, remaining)
            sleep(step)
            remaining = max(0.0, remaining - step)
            if manual_recovery_path is not None and manual_recovery_path.exists():
                manual_recovery_path.unlink(missing_ok=True)
                print(
                    f"AUDIENCE_RATE_LIMIT manual_probe attempt={attempt}/{retries}; skipping remaining cooldown",
                    flush=True,
                )
                remaining = 0.0
            if remaining > 0:
                print(
                    f"AUDIENCE_RATE_LIMIT waiting attempt={attempt}/{retries} remaining={remaining:g}s",
                    flush=True,
                )
        try:
            page.reload(wait_until="domcontentloaded", timeout=reload_timeout_ms)
            page.wait_for_timeout(1200)
        except Exception as error:  # noqa: BLE001
            print(
                f"AUDIENCE_RATE_LIMIT probe_failed attempt={attempt}/{retries} error={clean_text(error, 240)}",
                flush=True,
            )
            continue
        status = _challenge_status(f"{page.url}\n{_body_text(page)}")
        if not status:
            print(
                f"AUDIENCE_RATE_LIMIT cleared retry={attempt}/{retries}; resuming",
                flush=True,
            )
            return True, ""
        if status != "rate_limited":
            return False, status
    print(
        f"AUDIENCE_RATE_LIMIT exhausted retries={retries}; checkpoint preserved",
        flush=True,
    )
    return False, "rate_limited"


def _dom_comments(page: Any, post_id: str, note_url: str) -> list[dict[str, Any]]:
    rows = page.evaluate(
        r"""() => {
          const selectors = ['.comments-container .comment-item', '.comment-list .comment-item', '[class*="comment-item"]', '[class*="commentItem"]'];
          const nodes = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
          const text = (node, selectors) => {
            for (const selector of selectors) {
              const found = node.querySelector(selector);
              if (found?.textContent?.trim()) return found.textContent.trim();
            }
            return '';
          };
          const imageUrl = (node) => {
            const value = node?.currentSrc || node?.src || node?.getAttribute?.('data-src') || '';
            return /^https?:\/\//i.test(value) ? value : '';
          };
          return nodes.map((node, index) => {
            const profile = node.querySelector('a[href*="/user/profile/"]');
            const avatar = profile?.querySelector('img')
              || node.querySelector('.avatar img, img[class*="avatar"], img.user-image');
            const href = profile?.href || '';
            const userId = (href.match(/\/user\/profile\/([^/?]+)/) || [])[1] || '';
            return {
              id: node.getAttribute('data-comment-id') || node.id || '',
              content: text(node, ['.content', '[class*="content"]', '.note-text']),
              like_count: text(node, ['.like-wrapper .count', '[class*="like"] [class*="count"]']),
              create_time: text(node, ['.date', '[class*="date"]', '[class*="time"]']),
              parent_comment_id: node.closest('[class*="reply"]') ? 'dom-parent' : '',
              user_info: {
                user_id: userId,
                nickname: text(node, ['.name', '[class*="name"]', '[class*="author"]']),
                image: imageUrl(avatar),
                profile_url: href,
              },
              dom_index: index,
            };
          }).filter((item) => item.content && (item.user_info.user_id || item.user_info.nickname));
        }"""
    )
    records = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        comment = normalize_comment(row, post_id=post_id, note_url=note_url)
        if comment["parent_comment_id"] == "dom-parent":
            comment["parent_comment_id"] = "unknown_parent"
        records.append(comment)
    return records


def _click_more_replies(
    page: Any,
    completed_comment_ids: set[str] | None = None,
) -> int:
    clicked = 0
    completed = completed_comment_ids or set()
    try:
        candidates = page.get_by_text(MORE_REPLY_PATTERN).all()
    except Exception:  # noqa: BLE001
        candidates = []
    # Bound each pass so a note with many stale "more replies" nodes cannot
    # spend minutes retrying the same controls before progress is evaluated.
    for candidate in candidates[:20]:
        try:
            if completed:
                try:
                    root_comment_id = candidate.evaluate(
                        """node => {
                          const root = node.closest('[data-comment-id], [id]');
                          return root?.getAttribute('data-comment-id') || root?.id || '';
                        }"""
                    )
                except Exception:  # noqa: BLE001
                    root_comment_id = ""
                if clean_text(root_comment_id, 200) in completed:
                    continue
            if candidate.is_visible(timeout=200) and candidate.is_enabled(timeout=200):
                candidate.click(timeout=1200)
                clicked += 1
                time.sleep(0.12)
        except Exception:  # noqa: BLE001
            continue
    return clicked


def _next_stagnant_rounds(previous_count: int, current_count: int, stagnant_rounds: int) -> int:
    return stagnant_rounds + 1 if current_count == previous_count else 0


def _scroll_comments(page: Any) -> dict[str, Any]:
    return page.evaluate(
        r"""() => {
          const candidates = [...document.querySelectorAll('.comments-container, [class*="comments-container"], [class*="comment-list"], [class*="comments"]')]
            .filter((node) => node.scrollHeight > node.clientHeight + 30);
          const target = candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || document.scrollingElement;
          if (!target) return {top: 0, height: 0, client: 0};
          target.scrollTop = target.scrollHeight;
          if (target === document.scrollingElement) window.scrollTo(0, document.body.scrollHeight);
          return {top: target.scrollTop, height: target.scrollHeight, client: target.clientHeight};
        }"""
    )


def _profile_snapshot(page: Any) -> dict[str, Any]:
    return page.evaluate(
        r"""() => {
          const allText = document.body?.innerText || '';
          const read = (selectors) => {
            for (const selector of selectors) {
              const node = document.querySelector(selector);
              if (node?.textContent?.trim()) return node.textContent.trim();
            }
            return '';
          };
          const imageUrl = (node) => {
            const value = node?.currentSrc || node?.src || node?.getAttribute?.('data-src') || '';
            return /^https?:\/\//i.test(value) ? value : '';
          };
          const profileAvatar = [
            '.avatar-wrapper > img.user-image',
            '.avatar-wrapper img.user-image',
            '.avatar-wrapper > img',
          ].map((selector) => document.querySelector(selector)).find(Boolean);
          const unwrap = (raw) => {
            let value = raw;
            for (let depth = 0; depth < 4 && value && typeof value === 'object'; depth += 1) {
              if (Object.prototype.hasOwnProperty.call(value, '_value')) value = value._value;
              else if (Object.prototype.hasOwnProperty.call(value, 'value')) value = value.value;
              else break;
            }
            return value;
          };
          const scalar = (raw) => {
            const value = unwrap(raw);
            if (typeof value === 'number' || typeof value === 'string') return String(value).trim();
            return '';
          };
          const aliases = {
            following_count: ['follows', 'followCount', 'followsCount', 'followingCount', 'following_count'],
            follower_count: ['fans', 'fanCount', 'fansCount', 'followerCount', 'follower_count'],
            liked_and_collected_count: ['interaction', 'interactionCount', 'interactionsCount', 'likedAndCollectedCount', 'liked_and_collected_count'],
          };
          const hydrationMetrics = (() => {
            const roots = [window.__INITIAL_STATE__, window.__NUXT__].filter(Boolean);
            const queue = [...roots];
            const seen = new WeakSet();
            let inspected = 0;
            while (queue.length && inspected < 10000) {
              const current = unwrap(queue.shift());
              if (!current || typeof current !== 'object' || seen.has(current)) continue;
              seen.add(current);
              inspected += 1;
              const candidate = {};
              for (const [field, names] of Object.entries(aliases)) {
                for (const name of names) {
                  if (!Object.prototype.hasOwnProperty.call(current, name)) continue;
                  const value = scalar(current[name]);
                  if (value !== '') {
                    candidate[field] = value;
                    break;
                  }
                }
              }
              if (Object.keys(candidate).length >= 2) return candidate;
              try {
                for (const value of Object.values(current)) {
                  const nested = unwrap(value);
                  if (nested && typeof nested === 'object') queue.push(nested);
                }
              } catch (_) {
                // Some framework proxies reject enumeration; the visible DOM remains available.
              }
            }
            return {};
          })();
          const metric = (field, labels) => {
            if (hydrationMetrics[field] !== undefined) return hydrationMetrics[field];
            const knownLabels = ['关注', '粉丝', '获赞与收藏', '获赞和收藏'];
            const rows = [...document.querySelectorAll([
              '.user-interactions > div',
              '[class*="user-interactions"] > div',
              '.data-info > div',
              '[class*="data-info"] > div',
              '[class*="interaction"] > div',
            ].join(','))];
            for (const row of rows) {
              const rowText = (row.textContent || '').replace(/\s+/g, '');
              const rowLabels = knownLabels.filter((label) => rowText.includes(label));
              if (rowLabels.length !== 1 || !labels.includes(rowLabels[0])) continue;
              const direct = row.querySelector('.count, [class*="count"], [class*="number"], strong')?.textContent?.trim() || '';
              if (direct && /\d/.test(direct)) return direct;
              const withoutLabel = rowText.replace(rowLabels[0], '');
              const match = withoutLabel.match(/\d+(?:\.\d+)?\s*[万千wWkK]?/);
              if (match) return match[0];
            }
            return '';
          };
          return {
            profile_loaded: location.pathname.includes('/user/profile/'),
            display_name: read(['.user-name', '[class*="user-name"]', '[class*="userName"]', 'h1']),
            avatar_url: imageUrl(profileAvatar),
            xhs_id: (allText.match(/小红书号[：:]?\s*([^\s]+)/) || [])[1] || '',
            bio: read(['.user-desc', '[class*="user-desc"]', '[class*="desc"]']),
            ip_location: (allText.match(/IP属地[：:]?\s*([^\n]+)/) || [])[1] || '',
            following_count: metric('following_count', ['关注']),
            follower_count: metric('follower_count', ['粉丝']),
            liked_and_collected_count: metric('liked_and_collected_count', ['获赞与收藏', '获赞和收藏']),
          };
        }"""
    )


def _post_source(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    posts: list[dict[str, Any]] = []
    seen: set[str] = set()
    for note in records:
        post_id = _content_post_id(note)
        note_url = _content_post_url(note)
        if not post_id:
            post_id = hashlib.sha256(note_url.encode("utf-8")).hexdigest()[:24]
        if not note_url or post_id in seen:
            continue
        seen.add(post_id)
        author_name = clean_text(first_value(note, "author", "nickname"), 200)
        author_url = clean_text(first_value(note, "author_profile", "author_url"), 2000)
        author_avatar = clean_text(
            first_value(note, "author_avatar", "author_avatar_url", "avatar_url"),
            2000,
        )
        if not author_avatar:
            for field in ("card_image_urls", "detail_image_urls", "image_urls"):
                candidates = str(note.get(field) or "").split("|")
                author_avatar = next((
                    candidate.strip()
                    for candidate in candidates
                    if "sns-avatar" in candidate.casefold() or "/avatar/" in candidate.casefold()
                ), "")
                if author_avatar:
                    break
        author_id = ""
        match = re.search(r"/user/profile/([^/?]+)", author_url)
        if match:
            author_id = match.group(1)
        author = normalize_user({
            "user_id": author_id,
            "nickname": author_name,
            "profile_url": author_url,
            "avatar_url": author_avatar,
        }, role="author")
        posts.append({
            "post_id": post_id,
            "title": clean_text(note.get("title"), 500) or "未命名内容",
            "note_url": note_url,
            "author": author,
            "expected_comment_count": compact_count(first_value(note, "comment_count", "comments")),
            "status": "pending",
        })
    return posts


def normalize_audience_post_status(post: dict[str, Any], *, comment_count: int = 0) -> str:
    """Map legacy audience checkpoints onto pending/partial/complete."""
    status = clean_text(post.get("status"), 40).casefold()
    stored_count = compact_count(post.get("collected_comment_count")) or 0
    collected_count = max(stored_count, comment_count)
    expected_count = compact_count(post.get("expected_comment_count"))
    if status == "complete":
        return "complete"
    if expected_count is not None and collected_count > 0 and collected_count >= expected_count:
        return "complete"
    if status in {"partial", "failed"}:
        return "partial"
    attempted = bool(
        post.get("last_attempt_at")
        or post.get("last_collected_at")
        or post.get("failure_reason")
    )
    return "partial" if collected_count > 0 or attempted else "pending"


def merge_audience_posts(
    source_posts: list[dict[str, Any]],
    existing_posts: list[dict[str, Any]],
    comments: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Merge prior progress onto the authoritative content-insight link set."""
    comments_by_post: dict[str, list[dict[str, Any]]] = {}
    for comment in comments:
        post_id = clean_text(comment.get("post_id"), 200)
        if post_id:
            comments_by_post.setdefault(post_id, []).append(comment)

    existing_by_id = {
        clean_text(post.get("post_id"), 200): post
        for post in existing_posts
        if clean_text(post.get("post_id"), 200)
    }
    merged_posts: list[dict[str, Any]] = []
    source_ids: set[str] = set()

    def merge_one(source: dict[str, Any] | None, current: dict[str, Any]) -> dict[str, Any]:
        merged = {**(source or {}), **current}
        post_id = clean_text(merged.get("post_id"), 200)
        merged["post_id"] = post_id

        # The content-insight checkpoint owns the navigation URL. Audience resume
        # must never rediscover or replace it through a fresh keyword search.
        if source and clean_text(source.get("note_url"), 2000):
            merged["note_url"] = clean_text(source["note_url"], 2000)
        if source and source.get("expected_comment_count") is not None:
            merged["expected_comment_count"] = source["expected_comment_count"]

        source_author = source.get("author") if source and isinstance(source.get("author"), dict) else None
        current_author = current.get("author") if isinstance(current.get("author"), dict) else None
        if source_author or current_author:
            merged["author"] = merge_user(current_author, source_author or {})
            merged["author"]["post_ids"] = list(dict.fromkeys([
                *merged["author"].get("post_ids", []),
                post_id,
            ]))

        post_comments = comments_by_post.get(post_id, [])
        stored_count = compact_count(merged.get("collected_comment_count")) or 0
        merged["collected_comment_count"] = max(stored_count, len(post_comments))
        merged["status"] = normalize_audience_post_status(
            merged,
            comment_count=len(post_comments),
        )
        return merged

    for source in source_posts:
        post_id = clean_text(source.get("post_id"), 200)
        if not post_id or post_id in source_ids:
            continue
        source_ids.add(post_id)
        merged_posts.append(merge_one(source, existing_by_id.get(post_id, {})))

    if not source_posts:
        for current in existing_posts:
            post_id = clean_text(current.get("post_id"), 200)
            if not post_id or post_id in source_ids:
                continue
            source_ids.add(post_id)
            merged_posts.append(merge_one(None, current))
    return merged_posts


def audience_posts_to_supplement(
    posts: Iterable[dict[str, Any]],
    *,
    allowed_post_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Return resumable posts, prioritizing untouched checkpoints."""
    resumable = []
    for post in posts:
        initialize_post_checkpoint(post)
        detailed_status = clean_text(post.get("comment_status"), 80).casefold()
        legacy_status = clean_text(post.get("status"), 40).casefold()
        should_resume = detailed_status != "complete_reachable"
        if detailed_status == "failed" and post.get("recoverable") is False:
            should_resume = False
        if legacy_status not in RESUMABLE_AUDIENCE_POST_STATUSES and detailed_status == "not_started":
            should_resume = False
        if allowed_post_ids is not None and clean_text(post.get("post_id"), 200) not in allowed_post_ids:
            should_resume = False
        if should_resume:
            resumable.append(post)

    def resume_priority(post: dict[str, Any]) -> int:
        status = clean_text(post.get("comment_status"), 80).casefold()
        reason = clean_text(post.get("stop_reason") or post.get("failure_reason"), 120).casefold()
        if status == "not_started":
            return 0
        if "rate_limit" in reason or "security_verification" in reason:
            return 2
        return 1

    return sorted(resumable, key=resume_priority)


def merge_comment(current: dict[str, Any] | None, incoming: dict[str, Any]) -> dict[str, Any]:
    if not current:
        return dict(incoming)
    merged = {**incoming, **current}
    current_user = current.get("user") if isinstance(current.get("user"), dict) else None
    incoming_user = incoming.get("user") if isinstance(incoming.get("user"), dict) else None
    if current_user or incoming_user:
        merged["user"] = merge_user(current_user, incoming_user or {})
    return merged


def _merge_checkpoint_user(
    current: dict[str, Any] | None,
    incoming: dict[str, Any],
) -> dict[str, Any]:
    if not current:
        return dict(incoming)
    merged = merge_user(current, incoming)
    status_rank = {"": 0, "pending": 1, "partial": 2, "complete": 3}
    current_status = clean_text(current.get("enrichment_status"), 40).casefold()
    incoming_status = clean_text(incoming.get("enrichment_status"), 40).casefold()
    if status_rank.get(incoming_status, 0) > status_rank.get(current_status, 0):
        merged["enrichment_status"] = incoming_status
    access_rank = {
        "": 0,
        "discovered": 1,
        "profile_partial": 2,
        "public_profile_ok": 3,
    }
    current_access = clean_text(current.get("access_status"), 80).casefold()
    incoming_access = clean_text(incoming.get("access_status"), 80).casefold()
    if access_rank.get(incoming_access, 0) > access_rank.get(current_access, 0):
        merged["access_status"] = incoming_access
    for field in ("last_attempt_at", "last_enriched_at"):
        latest = max(clean_text(current.get(field), 100), clean_text(incoming.get(field), 100))
        if latest:
            merged[field] = latest
    return merged


def _merge_checkpoint_post(
    current: dict[str, Any] | None,
    incoming: dict[str, Any],
) -> dict[str, Any]:
    if not current:
        merged = dict(incoming)
        merged["status"] = normalize_audience_post_status(merged)
        return merged
    merged = _enrich_current_record(current, incoming)
    current_author = current.get("author") if isinstance(current.get("author"), dict) else None
    incoming_author = incoming.get("author") if isinstance(incoming.get("author"), dict) else None
    if current_author or incoming_author:
        merged["author"] = _merge_checkpoint_user(current_author, incoming_author or {})

    count_fields = (
        "expected_comment_count",
        "collected_comment_count",
        "top_level_count",
        "unique_user_count",
    )
    for field in count_fields:
        current_count = compact_count(current.get(field))
        incoming_count = compact_count(incoming.get(field))
        if current_count is not None or incoming_count is not None:
            merged[field] = max(current_count or 0, incoming_count or 0)

    status_rank = {"pending": 0, "partial": 1, "complete": 2}
    current_status = normalize_audience_post_status(
        current,
        comment_count=compact_count(current.get("collected_comment_count")) or 0,
    )
    incoming_status = normalize_audience_post_status(
        incoming,
        comment_count=compact_count(incoming.get("collected_comment_count")) or 0,
    )
    merged["status"] = max((current_status, incoming_status), key=status_rank.get)
    for field in ("last_attempt_at", "last_collected_at"):
        latest = max(clean_text(current.get(field), 100), clean_text(incoming.get(field), 100))
        if latest:
            merged[field] = latest
    return merged


def _load_audience_readthrough(
    output_dir: Path,
    checkpoint_dirs: list[Path],
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    dict[str, dict[str, Any]],
    dict[str, dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    notes = [item for item in load_json(output_dir / "xiaohongshu_notes_latest.json", []) if isinstance(item, dict)]
    posts = [item for item in load_json(output_dir / "audience-posts.json", []) if isinstance(item, dict) and item.get("post_id")]
    comments_by_id = {
        str(item.get("comment_id")): item
        for item in load_json(output_dir / "audience-comments.json", [])
        if isinstance(item, dict) and item.get("comment_id")
    }
    users_by_id = {
        str(item.get("user_id")): item
        for item in load_json(output_dir / "audience-users.json", [])
        if isinstance(item, dict) and item.get("user_id")
    }
    failures = [item for item in load_json(output_dir / "audience-failures.json", []) if isinstance(item, dict)]

    note_positions = {
        _record_key(item, "note_id", "id", "note_url", "search_result_url", "explore_url"): index
        for index, item in enumerate(notes)
        if _record_key(item, "note_id", "id", "note_url", "search_result_url", "explore_url")
    }
    post_positions = {
        clean_text(item.get("post_id"), 200): index
        for index, item in enumerate(posts)
        if clean_text(item.get("post_id"), 200)
    }
    failure_keys = {
        json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        for item in failures
    }
    for checkpoint_dir in checkpoint_dirs:
        source_notes = [item for item in load_json(checkpoint_dir / "xiaohongshu_notes_latest.json", []) if isinstance(item, dict)]
        for incoming in source_notes:
            key = _record_key(incoming, "note_id", "id", "note_url", "search_result_url", "explore_url")
            if not key:
                continue
            if key in note_positions:
                notes[note_positions[key]] = _enrich_current_record(notes[note_positions[key]], incoming)
            else:
                note_positions[key] = len(notes)
                notes.append(dict(incoming))
        source_posts = [
            item for item in load_json(checkpoint_dir / "audience-posts.json", [])
            if isinstance(item, dict) and item.get("post_id")
        ]
        for incoming in source_posts:
            post_id = clean_text(incoming.get("post_id"), 200)
            if post_id in post_positions:
                posts[post_positions[post_id]] = _merge_checkpoint_post(posts[post_positions[post_id]], incoming)
            else:
                post_positions[post_id] = len(posts)
                posts.append(_merge_checkpoint_post(None, incoming))
        for incoming in load_json(checkpoint_dir / "audience-comments.json", []):
            if not isinstance(incoming, dict) or not incoming.get("comment_id"):
                continue
            comment_id = str(incoming["comment_id"])
            comments_by_id[comment_id] = merge_comment(comments_by_id.get(comment_id), incoming)

        for incoming in load_json(checkpoint_dir / "audience-users.json", []):
            if not isinstance(incoming, dict) or not incoming.get("user_id"):
                continue
            user_id = str(incoming["user_id"])
            users_by_id[user_id] = _merge_checkpoint_user(users_by_id.get(user_id), incoming)

        for incoming in load_json(checkpoint_dir / "audience-failures.json", []):
            if not isinstance(incoming, dict):
                continue
            key = json.dumps(incoming, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            if key not in failure_keys:
                failure_keys.add(key)
                failures.append(dict(incoming))

    content_insight_records = _load_content_insight_records(
        output_dir,
        checkpoint_dirs,
        notes,
    )
    return notes, posts, comments_by_id, users_by_id, failures, content_insight_records


def _summary(posts: list[dict[str, Any]], comments: list[dict[str, Any]], users: list[dict[str, Any]], stop_reason: str = "") -> dict[str, Any]:
    normalized_statuses = [normalize_audience_post_status(post) for post in posts]
    complete_posts = normalized_statuses.count("complete")
    complete_profiles = sum(1 for user in users if user.get("enrichment_status") == "complete")
    failed_posts = sum(1 for post in posts if clean_text(post.get("status"), 40).casefold() == "failed")
    partial_posts = normalized_statuses.count("partial")
    pending_posts = normalized_statuses.count("pending")
    attempted_posts = complete_posts + partial_posts
    posts_with_comments = sum(1 for post in posts if (compact_count(post.get("collected_comment_count")) or 0) > 0)
    status = "complete" if posts and complete_posts == len(posts) and complete_profiles == len(users) else "partial" if comments or complete_posts or partial_posts else "pending"
    return {
        "schemaVersion": 1,
        "status": status,
        "postsTotal": len(posts),
        "postsComplete": complete_posts,
        "postsPending": pending_posts,
        "postsPartial": partial_posts,
        "postsFailed": failed_posts,
        "postsAttempted": attempted_posts,
        "postsWithComments": posts_with_comments,
        "commentsCollected": len(comments),
        "topLevelComments": sum(1 for item in comments if not item.get("parent_comment_id")),
        "repliesCollected": sum(1 for item in comments if item.get("parent_comment_id")),
        "usersDiscovered": len(users),
        "profilesComplete": complete_profiles,
        "postCoveragePercent": round((complete_posts / len(posts)) * 100, 2) if posts else 0,
        "postAttemptPercent": round((attempted_posts / len(posts)) * 100, 2) if posts else 0,
        "profileCoveragePercent": round((complete_profiles / len(users)) * 100, 2) if users else 0,
        "stopReason": stop_reason,
        "generatedAt": utc_now(),
    }


def _collect_audience_impl(
    output_dir: Path,
    *,
    checkpoint_dirs: Iterable[str | Path] = (),
    attempt_id: str = "",
    relay_port: int = 18800,
    goto_timeout_ms: int = 15000,
    note_delay_seconds: float = 1.2,
    stable_rounds: int = 5,
    security_verification_timeout_seconds: int = 600,
    rate_limit_max_retries: int = 5,
    rate_limit_initial_delay_seconds: float = 15.0,
    rate_limit_max_delay_seconds: float = 120.0,
    upstream_scraper: Path = DEFAULT_UPSTREAM_SCRAPER,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    _readthrough_context: tuple[
        list[Path],
        Path | None,
        dict[str, Any] | None,
    ] | None = None,
) -> dict[str, Any]:
    output_dir = output_dir.resolve()
    manual_rate_limit_recovery_path = output_dir / ".rate-limit-recover.request"
    if _readthrough_context is None:
        readthrough_dirs = _normalized_checkpoint_dirs(output_dir, checkpoint_dirs)
        manifest_path, readthrough_manifest = _prepare_readthrough_manifest(
            output_dir,
            readthrough_dirs,
            attempt_id,
        )
    else:
        readthrough_dirs, manifest_path, readthrough_manifest = _readthrough_context
    notes_path = output_dir / "xiaohongshu_notes_latest.json"
    comments_path = output_dir / "audience-comments.json"
    users_path = output_dir / "audience-users.json"
    posts_path = output_dir / "audience-posts.json"
    failures_path = output_dir / "audience-failures.json"
    summary_path = output_dir / "audience-summary.json"
    (
        notes,
        existing_posts,
        comments_by_id,
        users_by_id,
        failures,
        content_insight_records,
    ) = _load_audience_readthrough(output_dir, readthrough_dirs)
    if not content_insight_records:
        raise ValueError("Audience collection requires content-insight post links")

    source_posts = _post_source(content_insight_records)
    posts = merge_audience_posts(source_posts, existing_posts, comments_by_id.values())
    runtime_attempt_id = attempt_id or f"audience-{os.getpid()}-{int(time.time() * 1000)}"
    for post in posts:
        initialize_post_checkpoint(post)
    invalid_legacy_avatars = legacy_duplicate_avatar_fingerprints(users_by_id.values())
    for post in posts:
        author = post.get("author") if isinstance(post.get("author"), dict) else None
        if not author or not author.get("user_id"):
            continue
        users_by_id[author["user_id"]] = merge_user(users_by_id.get(author["user_id"]), author)
    for user in users_by_id.values():
        initialize_user_checkpoint(user)

    trusted_avatar_sources = [
        ("comment_api", comment["user"])
        for comment in comments_by_id.values()
        if isinstance(comment.get("user"), dict)
    ]
    trusted_avatar_sources.extend(
        ("post_checkpoint", post["author"])
        for post in posts
        if isinstance(post.get("author"), dict)
    )
    restored_legacy_avatar_ids = restore_legacy_avatar_urls(
        users_by_id,
        trusted_avatar_sources,
        invalid_legacy_avatars,
    )
    legacy_profile_refresh_ids = [
        user_id
        for user_id, user in users_by_id.items()
        if invalidate_legacy_profile_snapshot(user, invalid_legacy_avatars)
    ]
    if restored_legacy_avatar_ids or legacy_profile_refresh_ids:
        print(
            f"AUDIENCE_AVATAR_REPAIR restored={len(restored_legacy_avatar_ids)} "
            f"scheduled={len(legacy_profile_refresh_ids)} "
            f"duplicate_avatars={len(invalid_legacy_avatars)}",
            flush=True,
        )

    stop_reason = ""
    profile_stop_reason = ""

    def absorb(comment: dict[str, Any]) -> bool:
        is_new = comment["comment_id"] not in comments_by_id
        merged_comment = merge_comment(comments_by_id.get(comment["comment_id"]), comment)
        comments_by_id[comment["comment_id"]] = merged_comment
        user = merged_comment["user"]
        user_id = user["user_id"]
        merged = merge_user(users_by_id.get(user_id), user)
        merged["post_ids"] = list(dict.fromkeys([*merged.get("post_ids", []), merged_comment["post_id"]]))
        initialize_user_checkpoint(merged)
        users_by_id[user_id] = merged
        return is_new

    def checkpoint() -> dict[str, Any]:
        comments = sorted(comments_by_id.values(), key=lambda item: (item.get("post_id", ""), item.get("collected_at", ""), item.get("comment_id", "")))
        for post in posts:
            refresh_post_counts(post, comments)
        comment_counts_by_user: dict[str, int] = {}
        for item in comments:
            user_id = clean_text(item.get("user", {}).get("user_id"), 200)
            if user_id:
                comment_counts_by_user[user_id] = comment_counts_by_user.get(user_id, 0) + 1
        for user in users_by_id.values():
            initialize_user_checkpoint(user)
            checkpoint_count = comment_counts_by_user.get(clean_text(user.get("user_id"), 200), 0)
            user["comment_count"] = max(compact_count(user.get("comment_count")) or 0, checkpoint_count)
        users = sorted(users_by_id.values(), key=lambda item: (-int(item.get("comment_count") or 0), item.get("display_name", "")))
        atomic_json(notes_path, notes)
        atomic_json(comments_path, comments)
        atomic_json(users_path, users)
        atomic_json(posts_path, posts)
        atomic_json(failures_path, failures[-1000:])
        summary = _summary(posts, comments, users, stop_reason or profile_stop_reason)
        summary.update(checkpoint_metrics(posts))
        atomic_json(summary_path, summary)
        if progress_callback is not None:
            progress_callback({
                "posts": [dict(item) for item in posts],
                "users": [dict(item) for item in users],
                "summary": dict(summary),
                "status": "running",
                "lastCheckpointAt": utc_now(),
            })
        return summary

    # Materialize the merged checkpoint before opening any page so existing
    # audience data remains available throughout a supplementation run.
    checkpoint()
    source_post_ids = {
        clean_text(post.get("post_id"), 200)
        for post in source_posts
        if clean_text(post.get("post_id"), 200)
    }
    target_posts = audience_posts_to_supplement(
        posts,
        allowed_post_ids=source_post_ids,
    )
    print(
        f"AUDIENCE_RESUME saved_posts={len(posts)} targets={len(target_posts)} "
        f"preserved_comments={len(comments_by_id)} preserved_users={len(users_by_id)}",
        flush=True,
    )

    upstream = load_upstream(upstream_scraper)
    resume_comment_cursor = getattr(upstream, "resume_comment_cursor", None)
    resume_reply_cursor = getattr(upstream, "resume_reply_cursor", None)
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = upstream.connect_browser(playwright, relay_port)
        context = upstream.get_or_create_context(browser)
        get_reusable_page = getattr(upstream, "get_reusable_page", None)
        reused_page = callable(get_reusable_page)
        page = get_reusable_page(context) if reused_page else context.new_page()
        profile_page = page
        response_payloads: list[tuple[str, Any]] = []
        response_listener_pages: set[int] = set()
        created_pages: list[Any] = [] if reused_page else [page]

        def on_response(response: Any) -> None:
            if not any(marker in response.url.casefold() for marker in COMMENT_RESPONSE_MARKERS):
                return
            try:
                response_payloads.append((response.url, response.json()))
            except Exception:  # noqa: BLE001
                return

        def attach_response_listener(candidate: Any) -> None:
            identity = id(candidate)
            if identity in response_listener_pages:
                return
            candidate.on("response", on_response)
            response_listener_pages.add(identity)

        def page_is_closed(candidate: Any) -> bool:
            try:
                return bool(candidate.is_closed())
            except (AttributeError, TypeError):
                return False

        def ensure_live_page(*, force_reconnect: bool = False) -> Any:
            nonlocal browser, context, page, profile_page
            if not force_reconnect and not page_is_closed(page):
                return page
            browser = upstream.connect_browser(playwright, relay_port)
            context = upstream.get_or_create_context(browser)
            candidate = context.new_page()
            created_pages.append(candidate)
            attach_response_listener(candidate)
            page = candidate
            profile_page = candidate
            print("AUDIENCE_RELAY_PAGE restored after target closure", flush=True)
            return candidate

        attach_response_listener(page)
        try:
            def recover_rate_limit(limited_page: Any) -> tuple[bool, str]:
                return _wait_for_rate_limit_recovery(
                    limited_page,
                    max_retries=rate_limit_max_retries,
                    initial_delay_seconds=rate_limit_initial_delay_seconds,
                    max_delay_seconds=rate_limit_max_delay_seconds,
                    reload_timeout_ms=goto_timeout_ms,
                    checkpoint_callback=checkpoint,
                    manual_recovery_path=manual_rate_limit_recovery_path,
                )

            def recover_access(limited_page: Any, challenge: str) -> tuple[bool, str]:
                if challenge == "rate_limited":
                    cleared, reason = recover_rate_limit(limited_page)
                    if cleared:
                        return True, ""
                    challenge = reason
                if challenge == "security_verification":
                    _surface_security_verification(limited_page, relay_port)
                    print(
                        f"SECURITY_VERIFICATION detected timeout={security_verification_timeout_seconds}s; "
                        "checkpoint saved and audience collection waiting",
                        flush=True,
                    )
                    cleared, reason = _wait_for_manual_verification(
                        limited_page,
                        security_verification_timeout_seconds,
                        checkpoint_callback=checkpoint,
                    )
                    if cleared:
                        print("SECURITY_VERIFICATION cleared; resuming audience collection", flush=True)
                        return True, ""
                    if reason == "rate_limited":
                        return recover_rate_limit(limited_page)
                    return False, reason
                return not challenge, challenge

            def enrich_profile(user: dict[str, Any], *, phase: str) -> bool:
                nonlocal profile_stop_reason
                if initialize_user_checkpoint(user).get("profile_status") == "complete_reachable":
                    return True
                mark_user_attempt(user, runtime_attempt_id)
                if not user.get("profile_url"):
                    user["enrichment_status"] = "partial"
                    user["access_status"] = "profile_url_missing"
                    set_user_terminal(user, "partial_limit", "profile_url_missing")
                    return False
                for attempt in range(2):
                    active_page = ensure_live_page(force_reconnect=attempt > 0)
                    try:
                        active_page.goto(user["profile_url"], wait_until="domcontentloaded", timeout=goto_timeout_ms)
                        active_page.wait_for_timeout(900)
                        challenge = _challenge_status(f"{active_page.url}\n{_body_text(active_page)}")
                        if challenge:
                            cleared, challenge = recover_access(active_page, challenge)
                            if cleared:
                                challenge = ""
                        if challenge:
                            profile_stop_reason = challenge
                            user["enrichment_status"] = "partial"
                            user["access_status"] = challenge
                            set_user_terminal(
                                user,
                                "partial_verification" if challenge == "security_verification_timeout" else "blocked",
                                challenge,
                            )
                            print(
                                f"AUDIENCE_PROFILE_LIMIT reason={challenge}; comments continue and profile checkpoint preserved",
                                flush=True,
                            )
                            return False
                        parsed = parse_profile_snapshot(_profile_snapshot(active_page), user)
                        set_user_terminal(
                            parsed,
                            "complete_reachable" if parsed.get("enrichment_status") == "complete" else "partial_limit",
                            "" if parsed.get("enrichment_status") == "complete" else str(parsed.get("access_status") or "profile_partial"),
                        )
                        users_by_id[user["user_id"]] = parsed
                        return parsed.get("enrichment_status") == "complete"
                    except Exception as error:  # noqa: BLE001
                        if attempt == 0 and _is_closed_target_error(error):
                            continue
                        user["enrichment_status"] = "partial"
                        user["access_status"] = "profile_error"
                        user["last_enriched_at"] = utc_now()
                        set_user_terminal(user, "failed", "profile_error", recoverable=True)
                        failures.append({
                            "user_id": user["user_id"],
                            "phase": phase,
                            "reason": clean_text(error, 1000),
                            "at": utc_now(),
                        })
                        return False
                return False

            def pending_profile_users() -> list[dict[str, Any]]:
                commented_post_ids = {
                    item.get("post_id") for item in comments_by_id.values() if item.get("post_id")
                }
                return sorted(
                    [
                        item for item in users_by_id.values()
                        if initialize_user_checkpoint(item).get("profile_status") != "complete_reachable"
                        and not (
                            item.get("profile_status") == "failed"
                            and item.get("recoverable") is False
                        )
                    ],
                    key=lambda item: (
                        0 if item.get("profile_url") else 1,
                        0 if "author" in item.get("roles", []) and commented_post_ids.intersection(item.get("post_ids", [])) else
                        1 if "author" in item.get("roles", []) else
                        2,
                        -int(compact_count(item.get("comment_count")) or 0),
                        item.get("display_name", ""),
                    ),
                )

            # A long comment backlog used to starve profile enrichment for hours.
            # Resume now refreshes a bounded set of the most visible saved users
            # first, then continues comments and finally drains every profile.
            catchup_users = pending_profile_users()
            if target_posts and len(catchup_users) >= PROFILE_CATCHUP_BATCH_SIZE:
                catchup_batch = catchup_users[:PROFILE_CATCHUP_BATCH_SIZE]
                print(
                    f"AUDIENCE_PROFILE_CATCHUP pending={len(catchup_users)} batch={len(catchup_batch)}",
                    flush=True,
                )
                for profile_index, user in enumerate(catchup_batch, start=1):
                    enrich_profile(user, phase="profile_catchup")
                    checkpoint()
                    profiles_complete, profiles_total = _profile_progress(users_by_id)
                    print(
                        f"AUDIENCE_PROGRESS posts={len(posts) - len(target_posts)}/{len(posts)} "
                        f"comments={len(comments_by_id)} users={len(users_by_id)} "
                        f"profiles={profiles_complete}/{profiles_total} "
                        f"processed={profile_index}/{len(catchup_batch)} phase=profile_catchup",
                        flush=True,
                    )
                    if profile_stop_reason:
                        break
                    time.sleep(max(0.0, note_delay_seconds))

            for post_index, post in enumerate(target_posts, start=1):
                exact_cursor_supported = exact_resume_supported(
                    post,
                    comment_cursor_supported=callable(resume_comment_cursor),
                    reply_cursor_supported=callable(resume_reply_cursor),
                )
                strategy, fallback_reason = choose_resume_strategy(
                    post,
                    exact_cursor_supported=exact_cursor_supported,
                )
                if not strategy:
                    continue
                saved_anchor = clean_text(post.get("last_visible_comment_id"), 200)
                set_resume_strategy(post, strategy, fallback_reason)
                mark_post_attempt(post, runtime_attempt_id)
                checkpoint()
                if not clean_text(post.get("note_url"), 2000):
                    set_post_terminal(
                        post,
                        "failed",
                        "checkpoint_note_url_missing",
                        recoverable=False,
                    )
                    failures.append({
                        "post_id": post["post_id"],
                        "phase": "comments",
                        "reason": "checkpoint_note_url_missing",
                        "at": utc_now(),
                    })
                    progress_summary = checkpoint()
                    print(
                        f"AUDIENCE_PROGRESS posts={progress_summary['postsComplete']}/{len(posts)} "
                        f"comments={len(comments_by_id)} users={len(users_by_id)} "
                        f"profiles={_profile_progress(users_by_id)[0]}/{len(users_by_id)} "
                        f"processed={post_index}/{len(target_posts)} phase=comments",
                        flush=True,
                    )
                    continue
                response_payloads.clear()
                processed_response_count = 0
                existing_comment_ids = set(comments_by_id)
                observed_comment_ids: set[str] = set()
                saved_reply_thread_ids = {
                    comment_id
                    for comment_id, thread in post.get("reply_threads", {}).items()
                    if isinstance(thread, dict)
                    and thread.get("reply_status") != "complete_reachable"
                    and clean_text(thread.get("reply_cursor"), 1000)
                }
                requested_reply_cursors: set[str] = set()
                before = len([item for item in comments_by_id.values() if item.get("post_id") == post["post_id"]])
                try:
                    page = ensure_live_page()
                    page.goto(post["note_url"], wait_until="domcontentloaded", timeout=goto_timeout_ms)
                    page.wait_for_timeout(1200)
                    challenge = _challenge_status(f"{page.url}\n{_body_text(page)}")
                    if challenge:
                        set_post_terminal(
                            post,
                            "partial_verification" if challenge == "security_verification" else "blocked",
                            challenge,
                        )
                        checkpoint()
                        cleared, reason = recover_access(page, challenge)
                        if not cleared:
                            stop_reason = reason
                            set_post_terminal(
                                post,
                                "partial_verification" if "verification" in reason else "blocked",
                                reason,
                            )
                            checkpoint()
                            break
                        mark_post_attempt(post, runtime_attempt_id)

                    if post.get("resume_strategy") == "exact_cursor":
                        try:
                            exact_resumed = bool(resume_comment_cursor(
                                page=page,
                                post_id=post["post_id"],
                                note_url=post["note_url"],
                                cursor=post.get("comment_cursor"),
                            ))
                        except Exception as error:  # noqa: BLE001
                            exact_resumed = False
                            failures.append({
                                "post_id": post["post_id"],
                                "phase": "cursor_resume",
                                "reason": clean_text(error, 1000),
                                "at": utc_now(),
                            })
                        if not exact_resumed:
                            fallback = "anchor_comment" if saved_anchor else "rescan_dedupe"
                            set_resume_strategy(
                                post,
                                fallback,
                                "exact_cursor_driver_failed",
                            )
                            checkpoint()

                    unchanged = 0
                    previous_count = -1
                    explicit_exhausted = False
                    api_exhausted = False
                    anchor_pending = post.get("resume_strategy") == "anchor_comment"
                    for _round in range(200):
                        exact_reply_threads: set[str] = set()
                        if post.get("resume_strategy") == "exact_cursor":
                            for comment_id in saved_reply_thread_ids:
                                thread = post.get("reply_threads", {}).get(comment_id, {})
                                if thread.get("reply_status") == "complete_reachable":
                                    continue
                                reply_cursor = clean_text(thread.get("reply_cursor"), 1000)
                                request_key = f"{comment_id}:{reply_cursor}"
                                if not reply_cursor or request_key in requested_reply_cursors:
                                    exact_reply_threads.add(comment_id)
                                    continue
                                try:
                                    reply_resumed = bool(resume_reply_cursor(
                                        page=page,
                                        post_id=post["post_id"],
                                        comment_id=comment_id,
                                        cursor=reply_cursor,
                                    ))
                                except Exception as error:  # noqa: BLE001
                                    reply_resumed = False
                                    failures.append({
                                        "post_id": post["post_id"],
                                        "comment_id": comment_id,
                                        "phase": "reply_cursor_resume",
                                        "reason": clean_text(error, 1000),
                                        "at": utc_now(),
                                    })
                                if reply_resumed:
                                    requested_reply_cursors.add(request_key)
                                    exact_reply_threads.add(comment_id)
                                    checkpoint()
                                else:
                                    fallback_strategy = (
                                        "anchor_comment" if saved_anchor else "rescan_dedupe"
                                    )
                                    set_resume_strategy(
                                        post,
                                        fallback_strategy,
                                        "reply_cursor_driver_failed",
                                    )
                                    anchor_pending = bool(saved_anchor)
                                    checkpoint()
                                    break
                        completed_reply_threads = {
                            comment_id
                            for comment_id, thread in post.get("reply_threads", {}).items()
                            if isinstance(thread, dict)
                            and thread.get("reply_status") == "complete_reachable"
                        }
                        completed_reply_threads.update(exact_reply_threads)
                        clicked = 0 if anchor_pending else _click_more_replies(
                            page,
                            completed_reply_threads,
                        )
                        new_responses = list(response_payloads[processed_response_count:])
                        processed_response_count += len(new_responses)
                        visible_comment_ids: list[str] = []
                        for response_url, payload in new_responses:
                            extracted = extract_comments_from_payload(
                                payload,
                                post_id=post["post_id"],
                                note_url=post["note_url"],
                            )
                            for comment in extracted:
                                absorb(comment)
                                visible_comment_ids.append(comment["comment_id"])
                            event = response_page_event(response_url, payload)
                            if event is not None:
                                apply_response_checkpoint(
                                    post,
                                    event,
                                    extracted,
                                    existing_comment_ids=existing_comment_ids,
                                    observed_comment_ids=observed_comment_ids,
                                    attempt_id=runtime_attempt_id,
                                )
                                checkpoint()
                        dom_comments = _dom_comments(page, post["post_id"], post["note_url"])
                        for comment in dom_comments:
                            absorb(comment)
                            visible_comment_ids.append(comment["comment_id"])
                        if anchor_pending and resolve_anchor_observation(
                            post,
                            visible_comment_ids,
                            anchor_id=saved_anchor,
                        ):
                            anchor_pending = False
                            checkpoint()
                        current_count = len([item for item in comments_by_id.values() if item.get("post_id") == post["post_id"]])
                        scroll = _scroll_comments(page)
                        page.wait_for_timeout(650)
                        body = _body_text(page)
                        challenge = _challenge_status(f"{page.url}\n{body}")
                        if challenge:
                            set_post_terminal(
                                post,
                                "partial_verification" if challenge == "security_verification" else "blocked",
                                challenge,
                            )
                            checkpoint()
                            cleared, reason = recover_access(page, challenge)
                            if not cleared:
                                stop_reason = reason
                                break
                            response_payloads.clear()
                            processed_response_count = 0
                            mark_post_attempt(post, runtime_attempt_id)
                            unchanged = 0
                            previous_count = -1
                            continue
                        api_exhausted = _comment_api_exhausted(response_payloads)
                        explicit_exhausted = bool(
                            COMMENT_EXHAUSTED_PATTERN.search(body)
                            or COMMENT_EMPTY_PATTERN.search(body)
                            or (api_exhausted and clicked == 0)
                        )
                        # A click is only progress when it produces a new comment.
                        # Some pages leave already-expanded controls clickable forever.
                        unchanged = _next_stagnant_rounds(previous_count, current_count, unchanged)
                        previous_count = current_count
                        if explicit_exhausted or unchanged >= stable_rounds:
                            break
                        if scroll.get("height", 0) <= scroll.get("client", 0) and clicked == 0 and unchanged >= 2:
                            break

                    if anchor_pending:
                        resolve_anchor_observation(
                            post,
                            (),
                            anchor_id=saved_anchor,
                            scan_finished=True,
                        )

                    collected = len([item for item in comments_by_id.values() if item.get("post_id") == post["post_id"]])
                    expected = post.get("expected_comment_count")
                    expected_met = expected is not None and collected >= int(expected)
                    unknown_exhausted = expected is None and explicit_exhausted
                    refresh_post_counts(post, comments_by_id.values())
                    post["unique_user_count"] = len({item.get("user", {}).get("user_id") for item in comments_by_id.values() if item.get("post_id") == post["post_id"]})
                    post["last_collected_at"] = utc_now()
                    if stop_reason:
                        terminal_status = (
                            "partial_verification" if "verification" in stop_reason
                            else "partial_timeout" if "timeout" in stop_reason
                            else "partial_cancelled" if "cancel" in stop_reason
                            else "blocked" if "rate" in stop_reason
                            else "partial_limit"
                        )
                        set_post_terminal(post, terminal_status, stop_reason)
                    elif expected_met:
                        set_post_terminal(post, "complete_reachable")
                        post["completion_basis"] = "expected_count"
                    elif unknown_exhausted:
                        set_post_terminal(post, "complete_reachable")
                        post["completion_basis"] = "api_exhausted" if api_exhausted else "ui_exhausted"
                    else:
                        post["completion_basis"] = "checkpoint"
                        set_post_terminal(
                            post,
                            "partial_limit",
                            f"expected_{expected}_collected_{collected}" if expected is not None else "comment_list_not_proven_complete",
                        )
                    if collected == before and post["status"] != "complete":
                        failures.append({"post_id": post["post_id"], "phase": "comments", "reason": post["failure_reason"], "at": utc_now()})
                    progress_summary = checkpoint()
                    print(
                        f"AUDIENCE_PROGRESS posts={progress_summary['postsComplete']}/{len(posts)} comments={len(comments_by_id)} "
                        f"users={len(users_by_id)} profiles={_profile_progress(users_by_id)[0]}/{len(users_by_id)} "
                        f"processed={post_index}/{len(target_posts)} phase=comments",
                        flush=True,
                    )
                    if stop_reason:
                        break
                    time.sleep(max(0.0, note_delay_seconds))
                except KeyboardInterrupt:
                    set_post_terminal(post, "partial_cancelled", "user_cancelled")
                    checkpoint()
                    raise
                except Exception as error:  # noqa: BLE001
                    set_post_terminal(
                        post,
                        "failed",
                        clean_text(error, 1000),
                        recoverable=True,
                    )
                    failures.append({"post_id": post["post_id"], "phase": "comments", "reason": post["failure_reason"], "at": utc_now()})
                    progress_summary = checkpoint()
                    print(
                        f"AUDIENCE_PROGRESS posts={progress_summary['postsComplete']}/{len(posts)} "
                        f"comments={len(comments_by_id)} users={len(users_by_id)} "
                        f"profiles={_profile_progress(users_by_id)[0]}/{len(users_by_id)} "
                        f"processed={post_index}/{len(target_posts)} phase=comments",
                        flush=True,
                    )

            if not stop_reason and not profile_stop_reason:
                pending_users = pending_profile_users()
                for profile_index, user in enumerate(pending_users, start=1):
                    enrich_profile(user, phase="profile")
                    checkpoint()
                    profiles_complete, profiles_total = _profile_progress(users_by_id)
                    print(
                        f"AUDIENCE_PROGRESS posts={len(posts)}/{len(posts)} comments={len(comments_by_id)} "
                        f"users={len(users_by_id)} profiles={profiles_complete}/{profiles_total} "
                        f"processed={profile_index}/{len(pending_users)} phase=profiles",
                        flush=True,
                    )
                    if profile_stop_reason:
                        break
                    time.sleep(max(0.0, note_delay_seconds))
        finally:
            for created_page in created_pages:
                try:
                    if not page_is_closed(created_page):
                        created_page.close()
                except Exception:  # noqa: BLE001
                    pass

    summary = checkpoint()
    if manifest_path is not None and readthrough_manifest is not None:
        _verify_readthrough_sources(readthrough_manifest)
        readthrough_manifest = {
            **readthrough_manifest,
            "status": "committed",
            "targetState": "committed",
            "sourceIntegrity": "verified",
            "verifiedAt": utc_now(),
        }
        atomic_json(manifest_path, readthrough_manifest)
    if progress_callback is not None:
        progress_callback({
            "posts": [dict(item) for item in posts],
            "users": [dict(item) for item in users_by_id.values()],
            "summary": dict(summary),
            "status": "completed" if summary.get("status") == "complete" else "blocked" if summary.get("stopReason") else "partial",
            "lastCheckpointAt": utc_now(),
        })
    print(
        f"AUDIENCE_COMPLETE posts={summary['postsComplete']}/{summary['postsTotal']} "
        f"comments={summary['commentsCollected']} users={summary['usersDiscovered']} "
        f"profiles={summary['profilesComplete']}/{summary['usersDiscovered']} status={summary['status']} "
        f"attempted={summary['postsAttempted']} with_comments={summary['postsWithComments']}",
        flush=True,
    )
    return summary


def collect_audience(
    output_dir: Path,
    *,
    checkpoint_dirs: Iterable[str | Path] = (),
    attempt_id: str = "",
    relay_port: int = 18800,
    goto_timeout_ms: int = 15000,
    note_delay_seconds: float = 1.2,
    stable_rounds: int = 5,
    security_verification_timeout_seconds: int = 600,
    rate_limit_max_retries: int = 5,
    rate_limit_initial_delay_seconds: float = 15.0,
    rate_limit_max_delay_seconds: float = 120.0,
    upstream_scraper: Path = DEFAULT_UPSTREAM_SCRAPER,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    resolved_output_dir = output_dir.resolve()
    readthrough_dirs = _normalized_checkpoint_dirs(resolved_output_dir, checkpoint_dirs)
    manifest_path, readthrough_manifest = _prepare_readthrough_manifest(
        resolved_output_dir,
        readthrough_dirs,
        attempt_id,
    )
    try:
        return _collect_audience_impl(
            resolved_output_dir,
            checkpoint_dirs=readthrough_dirs,
            attempt_id=attempt_id,
            relay_port=relay_port,
            goto_timeout_ms=goto_timeout_ms,
            note_delay_seconds=note_delay_seconds,
            stable_rounds=stable_rounds,
            security_verification_timeout_seconds=security_verification_timeout_seconds,
            rate_limit_max_retries=rate_limit_max_retries,
            rate_limit_initial_delay_seconds=rate_limit_initial_delay_seconds,
            rate_limit_max_delay_seconds=rate_limit_max_delay_seconds,
            upstream_scraper=upstream_scraper,
            progress_callback=progress_callback,
            _readthrough_context=(
                readthrough_dirs,
                manifest_path,
                readthrough_manifest,
            ),
        )
    except BaseException as error:
        if isinstance(error, KeyboardInterrupt):
            raise
        if manifest_path is not None and readthrough_manifest is not None:
            rollback_errors = _rollback_readthrough_target(
                resolved_output_dir,
                manifest_path,
                readthrough_manifest,
                error,
            )
            if rollback_errors:
                raise RuntimeError(
                    "Audience read-through failed and rollback was incomplete: "
                    + "; ".join(rollback_errors)
                ) from error
        raise


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Collect all visible comments and public audience profiles from note checkpoints.")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--relay-port", type=int, default=18800)
    parser.add_argument("--goto-timeout-ms", type=int, default=15000)
    parser.add_argument("--note-delay-seconds", type=float, default=1.2)
    parser.add_argument("--stable-rounds", type=int, default=5)
    parser.add_argument("--security-verification-timeout-seconds", type=int, default=600)
    parser.add_argument("--rate-limit-max-retries", type=int, default=5)
    parser.add_argument("--rate-limit-initial-delay-seconds", type=float, default=15.0)
    parser.add_argument("--rate-limit-max-delay-seconds", type=float, default=120.0)
    parser.add_argument("--upstream-scraper", default=str(DEFAULT_UPSTREAM_SCRAPER))
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--resume-scope", choices=("full", "audience"))
    parser.add_argument("--attempt-id")
    parser.add_argument("--resume-checkpoint-dir", action="append", default=[])
    parser.add_argument("--state-path")
    parser.add_argument("--expected-state-revision", type=int)
    parser.add_argument(
        "--repair-avatars-only",
        action="store_true",
        help="Repair legacy avatar pollution from saved comment/post checkpoints and exit.",
    )
    options = parser.parse_args(arguments)
    output_dir = Path(options.output_dir).resolve()
    if options.repair_avatars_only:
        result = repair_audience_avatar_checkpoints(output_dir)
        print(f"AUDIENCE_AVATAR_REPAIR_COMPLETE {json.dumps(result, ensure_ascii=False)}", flush=True)
        return 0
    state = open_workflow_state_from_args(options, output_dir)
    if state is not None:
        if not state.should_run("audience"):
            summary = load_json(output_dir / "audience-summary.json", {})
            return 0 if isinstance(summary, dict) and summary.get("status") == "complete" else 3
        state.start_stage("audience")

    def update_state(progress: dict[str, Any]) -> None:
        if state is None:
            return
        state.checkpoint_audience(
            posts=progress["posts"],
            users=progress["users"],
            summary=progress["summary"],
            status=str(progress.get("status") or "running"),
        )

    try:
        summary = collect_audience(
            output_dir,
            checkpoint_dirs=options.resume_checkpoint_dir,
            attempt_id=options.attempt_id or "",
            relay_port=options.relay_port,
            goto_timeout_ms=options.goto_timeout_ms,
            note_delay_seconds=options.note_delay_seconds,
            stable_rounds=options.stable_rounds,
            security_verification_timeout_seconds=options.security_verification_timeout_seconds,
            rate_limit_max_retries=options.rate_limit_max_retries,
            rate_limit_initial_delay_seconds=options.rate_limit_initial_delay_seconds,
            rate_limit_max_delay_seconds=options.rate_limit_max_delay_seconds,
            upstream_scraper=Path(options.upstream_scraper),
            progress_callback=update_state,
        )
    except BaseException as error:
        if state is not None:
            try:
                cancelled = isinstance(error, KeyboardInterrupt)
                state.finish_stage("audience", "cancelled" if cancelled else "failed", {
                    "failureCode": "user_cancelled" if cancelled else type(error).__name__,
                    "failureMessage": str(error)[:1000],
                    "stopReason": "user_cancelled" if cancelled else "",
                })
            except BaseException:
                pass
        raise
    if state is not None:
        status = "completed" if summary["status"] == "complete" else "blocked" if summary.get("stopReason") else "partial"
        state.finish_stage("audience", status, {"stopReason": summary.get("stopReason") or ""})
    return 0 if summary["status"] == "complete" else 3


if __name__ == "__main__":
    raise SystemExit(main())
