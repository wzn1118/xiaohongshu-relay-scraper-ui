from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable
from urllib.parse import parse_qs, urlparse


AUDIENCE_CHECKPOINT_SCHEMA_VERSION = 1
AUDIENCE_PROGRESS_STATUSES = frozenset((
    "not_started",
    "running",
    "complete_reachable",
    "partial_limit",
    "partial_timeout",
    "partial_verification",
    "partial_cancelled",
    "blocked",
    "failed",
))
RESUME_STRATEGIES = frozenset(("exact_cursor", "anchor_comment", "rescan_dedupe"))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def clean(value: Any, limit: int = 1000) -> str:
    return str(value or "").strip()[:limit]


def non_negative_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def legacy_post_status(post: dict[str, Any]) -> str:
    status = clean(post.get("comment_status") or post.get("commentStatus"), 80).casefold()
    if status in AUDIENCE_PROGRESS_STATUSES:
        return status
    legacy = clean(post.get("status"), 80).casefold()
    if legacy in {"complete", "completed", "succeeded"}:
        return "complete_reachable"
    reason = clean(post.get("failure_reason") or post.get("stop_reason"), 200).casefold()
    if "verif" in reason or "captcha" in reason:
        return "partial_verification"
    if "cancel" in reason:
        return "partial_cancelled"
    if "timeout" in reason:
        return "partial_timeout"
    if legacy == "failed":
        return "failed"
    if legacy == "blocked":
        return "blocked"
    if legacy == "partial" or non_negative_int(post.get("collected_comment_count")) > 0:
        return "partial_limit"
    return "not_started"


def legacy_user_status(user: dict[str, Any]) -> str:
    status = clean(user.get("profile_status") or user.get("profileStatus"), 80).casefold()
    if status in AUDIENCE_PROGRESS_STATUSES:
        return status
    enrichment = clean(user.get("enrichment_status") or user.get("enrichmentStatus"), 80).casefold()
    if enrichment in {"complete", "completed", "succeeded"}:
        return "complete_reachable"
    reason = clean(user.get("failure_code") or user.get("access_status"), 200).casefold()
    if "verif" in reason or "captcha" in reason:
        return "partial_verification"
    if "cancel" in reason:
        return "partial_cancelled"
    if "timeout" in reason:
        return "partial_timeout"
    if enrichment == "failed":
        return "failed"
    if enrichment == "blocked":
        return "blocked"
    if enrichment in {"partial", "pending"} and user.get("last_attempt_at"):
        return "partial_limit"
    return "not_started"


def initialize_post_checkpoint(post: dict[str, Any], *, now: str | None = None) -> dict[str, Any]:
    timestamp = now or utc_now()
    post.setdefault("checkpoint_schema_version", AUDIENCE_CHECKPOINT_SCHEMA_VERSION)
    post["comment_status"] = legacy_post_status(post)
    post.setdefault("comment_cursor", "")
    post["comment_page"] = non_negative_int(post.get("comment_page"))
    post.setdefault("reply_cursor", "")
    post["has_more_comments"] = bool(
        post.get("has_more_comments", post["comment_status"] != "complete_reachable")
    )
    post["comments_collected"] = max(
        non_negative_int(post.get("comments_collected")),
        non_negative_int(post.get("collected_comment_count")),
    )
    post["replies_collected"] = max(
        non_negative_int(post.get("replies_collected")),
        non_negative_int(post.get("reply_count")),
    )
    post.setdefault("last_visible_comment_id", "")
    post.setdefault("last_successful_cursor", "")
    post["attempt_count"] = non_negative_int(post.get("attempt_count"))
    post.setdefault("stop_reason", clean(post.get("failure_reason"), 1000))
    post.setdefault("recoverable", post["comment_status"] != "complete_reachable")
    post.setdefault("resume_strategy", "")
    post.setdefault("fallback_reason", "")
    post["repeated_requests"] = non_negative_int(post.get("repeated_requests"))
    post["duplicate_comments_seen"] = non_negative_int(post.get("duplicate_comments_seen"))
    post.setdefault("resumed_from_anchor", "")
    post["performance_penalty"] = _penalty(post)
    post["completed_request_keys"] = _unique_strings(post.get("completed_request_keys"), 512)
    threads = post.get("reply_threads")
    post["reply_threads"] = threads if isinstance(threads, dict) else {}
    post.setdefault("updated_at", timestamp)
    return post


def initialize_user_checkpoint(user: dict[str, Any], *, now: str | None = None) -> dict[str, Any]:
    timestamp = now or utc_now()
    user.setdefault("checkpoint_schema_version", AUDIENCE_CHECKPOINT_SCHEMA_VERSION)
    user["profile_status"] = legacy_user_status(user)
    user["profile_attempt_count"] = non_negative_int(
        user.get("profile_attempt_count", user.get("attempt_count"))
    )
    user.setdefault("user_post_cursor", "")
    user.setdefault("last_attempt_at", "")
    user["failure_code"] = clean(user.get("failure_code") or user.get("access_status"), 200)
    user.setdefault("recoverable", user["profile_status"] != "complete_reachable")
    user.setdefault("updated_at", timestamp)
    return user


def mark_post_attempt(post: dict[str, Any], attempt_id: str, *, now: str | None = None) -> None:
    initialize_post_checkpoint(post, now=now)
    if clean(post.get("last_attempt_id"), 200) != attempt_id:
        post["attempt_count"] += 1
        post["last_attempt_id"] = attempt_id
    post["comment_status"] = "running"
    post["last_attempt_at"] = now or utc_now()
    post["updated_at"] = post["last_attempt_at"]


def mark_user_attempt(user: dict[str, Any], attempt_id: str, *, now: str | None = None) -> None:
    initialize_user_checkpoint(user, now=now)
    if clean(user.get("last_profile_attempt_id"), 200) != attempt_id:
        user["profile_attempt_count"] += 1
        user["last_profile_attempt_id"] = attempt_id
    user["profile_status"] = "running"
    user["last_attempt_at"] = now or utc_now()
    user["updated_at"] = user["last_attempt_at"]


def choose_resume_strategy(
    post: dict[str, Any],
    *,
    exact_cursor_supported: bool,
) -> tuple[str, str]:
    initialize_post_checkpoint(post)
    if post["comment_status"] == "complete_reachable":
        return "", "already_complete"
    if clean(post.get("comment_cursor")) and exact_cursor_supported:
        return "exact_cursor", ""
    if clean(post.get("last_visible_comment_id")):
        reason = "relay_cursor_resume_unavailable" if post.get("comment_cursor") else "cursor_unavailable"
        return "anchor_comment", reason
    reason = "anchor_unavailable"
    if post.get("comment_cursor"):
        reason = "relay_cursor_resume_unavailable_and_anchor_unavailable"
    return "rescan_dedupe", reason


def exact_resume_supported(
    post: dict[str, Any],
    *,
    comment_cursor_supported: bool,
    reply_cursor_supported: bool,
) -> bool:
    initialize_post_checkpoint(post)
    pending_reply_cursor = any(
        isinstance(thread, dict)
        and clean(thread.get("reply_cursor"), 1000)
        and clean(thread.get("reply_status"), 80) != "complete_reachable"
        for thread in post["reply_threads"].values()
    )
    return bool(
        comment_cursor_supported
        and (not pending_reply_cursor or reply_cursor_supported)
    )


def set_resume_strategy(
    post: dict[str, Any],
    strategy: str,
    fallback_reason: str = "",
    *,
    resumed_from_anchor: str = "",
    now: str | None = None,
) -> None:
    if strategy not in RESUME_STRATEGIES:
        raise ValueError(f"Invalid audience resume strategy: {strategy}")
    initialize_post_checkpoint(post, now=now)
    post["resume_strategy"] = strategy
    post["fallback_reason"] = clean(fallback_reason, 1000)
    post["resumed_from_anchor"] = clean(resumed_from_anchor, 200)
    post["updated_at"] = now or utc_now()


def resolve_anchor_observation(
    post: dict[str, Any],
    visible_comment_ids: Iterable[str],
    *,
    anchor_id: str = "",
    scan_finished: bool = False,
    now: str | None = None,
) -> bool:
    initialize_post_checkpoint(post, now=now)
    anchor = clean(anchor_id or post.get("last_visible_comment_id"), 200)
    visible = {clean(item, 200) for item in visible_comment_ids if clean(item, 200)}
    if anchor and anchor in visible:
        set_resume_strategy(
            post,
            "anchor_comment",
            clean(post.get("fallback_reason"), 1000),
            resumed_from_anchor=anchor,
            now=now,
        )
        return True
    if scan_finished and post.get("resume_strategy") == "anchor_comment":
        set_resume_strategy(
            post,
            "rescan_dedupe",
            "saved_anchor_not_observed",
            now=now,
        )
    return False


def response_page_event(url: str, payload: Any) -> dict[str, Any] | None:
    lowered = clean(url, 4000).casefold()
    is_reply = "comment/sub" in lowered
    is_comment = is_reply or "comment/page" in lowered or "comment/list" in lowered
    if not is_comment or not isinstance(payload, dict):
        return None
    data = payload.get("data")
    if not isinstance(data, dict):
        data = payload
    query = parse_qs(urlparse(url).query)

    def query_value(*names: str) -> str:
        for name in names:
            values = query.get(name)
            if values:
                return clean(values[0], 1000)
        return ""

    request_cursor = query_value("cursor", "page_cursor", "next_cursor")
    next_cursor = clean(
        data.get("cursor")
        or data.get("next_cursor")
        or data.get("nextCursor"),
        1000,
    )
    has_more_value = data.get("has_more", data.get("hasMore"))
    has_more = None if has_more_value is None else bool(has_more_value)
    parent_id = query_value(
        "root_comment_id",
        "rootCommentId",
        "comment_id",
        "commentId",
        "target_comment_id",
    )
    kind = "reply" if is_reply else "comment"
    return {
        "kind": kind,
        "requestCursor": request_cursor,
        "nextCursor": next_cursor,
        "hasMore": has_more,
        "commentId": parent_id,
        "requestKey": f"{kind}:{parent_id}:{request_cursor or '<initial>'}",
    }


def apply_response_checkpoint(
    post: dict[str, Any],
    event: dict[str, Any],
    comments: Iterable[dict[str, Any]],
    *,
    existing_comment_ids: set[str],
    observed_comment_ids: set[str],
    attempt_id: str,
    now: str | None = None,
) -> dict[str, int]:
    timestamp = now or utc_now()
    initialize_post_checkpoint(post, now=timestamp)
    incoming = [item for item in comments if isinstance(item, dict)]
    incoming_ids = [clean(item.get("comment_id") or item.get("commentId"), 200) for item in incoming]
    incoming_ids = [item for item in incoming_ids if item]
    duplicates = sum(
        identifier in existing_comment_ids and identifier not in observed_comment_ids
        for identifier in incoming_ids
    )
    observed_comment_ids.update(incoming_ids)
    post["duplicate_comments_seen"] += duplicates

    key = clean(event.get("requestKey"), 1200)
    completed_keys = post["completed_request_keys"]
    repeated = int(bool(key and key in completed_keys))
    if repeated:
        post["repeated_requests"] += 1
    elif key:
        completed_keys.append(key)
        del completed_keys[:-512]

    kind = clean(event.get("kind"), 20)
    request_cursor = clean(event.get("requestCursor"), 1000)
    next_cursor = clean(event.get("nextCursor"), 1000)
    has_more = event.get("hasMore")
    if kind == "reply":
        parent_id = clean(event.get("commentId"), 200)
        if not parent_id:
            parent_id = next((
                clean(item.get("parent_comment_id") or item.get("parentCommentId"), 200)
                for item in incoming
                if item.get("parent_comment_id") or item.get("parentCommentId")
            ), "")
        if parent_id:
            thread = post["reply_threads"].setdefault(parent_id, {})
            thread.setdefault("comment_id", parent_id)
            thread.setdefault("reply_status", "not_started")
            thread.setdefault("reply_cursor", "")
            thread.setdefault("has_more_replies", True)
            thread.setdefault("replies_collected", 0)
            thread.setdefault("attempt_count", 0)
            if clean(thread.get("last_attempt_id"), 200) != attempt_id:
                thread["attempt_count"] = non_negative_int(thread.get("attempt_count")) + 1
                thread["last_attempt_id"] = attempt_id
            thread["reply_cursor"] = next_cursor
            if has_more is not None:
                thread["has_more_replies"] = bool(has_more)
            thread["reply_status"] = (
                "complete_reachable" if has_more is False else "running"
            )
            thread["replies_collected"] = max(
                non_negative_int(thread.get("replies_collected")),
                sum(
                    clean(item.get("parent_comment_id") or item.get("parentCommentId"), 200) == parent_id
                    for item in incoming
                ),
            )
            thread["updated_at"] = timestamp
            post["reply_cursor"] = next_cursor
    else:
        if not repeated:
            post["comment_page"] += 1
        post["last_successful_cursor"] = request_cursor
        post["comment_cursor"] = next_cursor
        if has_more is not None:
            post["has_more_comments"] = bool(has_more)
        top_level_ids = [
            clean(item.get("comment_id") or item.get("commentId"), 200)
            for item in incoming
            if not clean(item.get("parent_comment_id") or item.get("parentCommentId"), 200)
        ]
        if top_level_ids:
            post["last_visible_comment_id"] = top_level_ids[-1]

    post["performance_penalty"] = _penalty(post)
    post["updated_at"] = timestamp
    return {"duplicates": duplicates, "repeatedRequests": repeated}


def refresh_post_counts(
    post: dict[str, Any],
    comments: Iterable[dict[str, Any]],
    *,
    now: str | None = None,
) -> None:
    initialize_post_checkpoint(post, now=now)
    post_id = clean(post.get("post_id") or post.get("postId"), 200)
    matching = [
        item for item in comments
        if isinstance(item, dict)
        and clean(item.get("post_id") or item.get("postId"), 200) == post_id
    ]
    replies = [
        item for item in matching
        if clean(item.get("parent_comment_id") or item.get("parentCommentId"), 200)
    ]
    post["comments_collected"] = len(matching)
    post["replies_collected"] = len(replies)
    post["collected_comment_count"] = len(matching)
    post["top_level_count"] = len(matching) - len(replies)
    post["reply_count"] = len(replies)
    reply_counts: dict[str, int] = {}
    for item in replies:
        parent_id = clean(item.get("parent_comment_id") or item.get("parentCommentId"), 200)
        if parent_id:
            reply_counts[parent_id] = reply_counts.get(parent_id, 0) + 1
    for parent_id, thread in post["reply_threads"].items():
        if isinstance(thread, dict):
            thread["replies_collected"] = reply_counts.get(parent_id, 0)
    post["updated_at"] = now or utc_now()


def set_post_terminal(
    post: dict[str, Any],
    status: str,
    stop_reason: str = "",
    *,
    recoverable: bool | None = None,
    now: str | None = None,
) -> None:
    if status not in AUDIENCE_PROGRESS_STATUSES:
        raise ValueError(f"Invalid audience post status: {status}")
    initialize_post_checkpoint(post, now=now)
    post["comment_status"] = status
    post["stop_reason"] = clean(stop_reason, 1000)
    post["has_more_comments"] = status != "complete_reachable"
    post["recoverable"] = (
        status not in {"complete_reachable", "failed"}
        if recoverable is None else bool(recoverable)
    )
    post["updated_at"] = now or utc_now()
    post["status"] = (
        "complete" if status == "complete_reachable"
        else "pending" if status == "not_started"
        else "failed" if status == "failed"
        else "partial"
    )
    post["failure_reason"] = "" if status == "complete_reachable" else post["stop_reason"]


def set_user_terminal(
    user: dict[str, Any],
    status: str,
    failure_code: str = "",
    *,
    recoverable: bool | None = None,
    now: str | None = None,
) -> None:
    if status not in AUDIENCE_PROGRESS_STATUSES:
        raise ValueError(f"Invalid audience user status: {status}")
    initialize_user_checkpoint(user, now=now)
    user["profile_status"] = status
    user["failure_code"] = clean(failure_code, 200)
    user["recoverable"] = (
        status not in {"complete_reachable", "failed"}
        if recoverable is None else bool(recoverable)
    )
    user["updated_at"] = now or utc_now()


def checkpoint_metrics(posts: Iterable[dict[str, Any]]) -> dict[str, Any]:
    items = [initialize_post_checkpoint(item) for item in posts if isinstance(item, dict)]
    strategy_counts = {name: 0 for name in sorted(RESUME_STRATEGIES)}
    for item in items:
        strategy = clean(item.get("resume_strategy"), 40)
        if strategy in strategy_counts:
            strategy_counts[strategy] += 1
    repeated = sum(non_negative_int(item.get("repeated_requests")) for item in items)
    duplicates = sum(non_negative_int(item.get("duplicate_comments_seen")) for item in items)
    completed_requests = sum(len(item.get("completed_request_keys") or []) for item in items)
    denominator = completed_requests + repeated
    return {
        "checkpointSchemaVersion": AUDIENCE_CHECKPOINT_SCHEMA_VERSION,
        "resumeStrategyCounts": strategy_counts,
        "repeatedRequests": repeated,
        "duplicateCommentsSeen": duplicates,
        "performancePenalty": round((repeated / denominator) * 100, 2) if denominator else 0.0,
    }


def _penalty(post: dict[str, Any]) -> float:
    repeated = non_negative_int(post.get("repeated_requests"))
    completed = len(post.get("completed_request_keys") or [])
    denominator = completed + repeated
    return round((repeated / denominator) * 100, 2) if denominator else 0.0


def _unique_strings(value: Any, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(clean(item, 1200) for item in value if clean(item, 1200)))[-limit:]
