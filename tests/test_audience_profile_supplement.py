from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.audience_profile_supplement import (
    SupplementRequestError,
    current_post_user_ids,
    load_request,
    merge_recent_posts,
    run_supplement,
    select_target_users,
)


def user(user_id: str, *, complete: bool = False) -> dict[str, object]:
    return {
        "user_id": user_id,
        "display_name": user_id,
        "profile_url": f"https://www.xiaohongshu.com/user/profile/{user_id}",
        "enrichment_status": "complete" if complete else "pending",
    }


def comment(comment_id: str, post_id: str, user_id: str) -> dict[str, object]:
    return {
        "comment_id": comment_id,
        "post_id": post_id,
        "text": comment_id,
        "user": {"user_id": user_id},
    }


def request_payload(output_dir: Path, *, mode: str = "collect_missing_header") -> dict[str, object]:
    return {
        "jobId": "job-1",
        "postId": "post-1",
        "runId": "run-1",
        "outputDir": str(output_dir),
        "profileMode": mode,
        "profileUserLimit": 5,
        "profilePostLimitPerUser": 2 if mode == "recent_public_posts" else 0,
        "profilePostTotalLimit": 4 if mode == "recent_public_posts" else 0,
    }


def test_current_post_user_ids_excludes_other_posts_and_ranks_commenters() -> None:
    comments = [
        comment("c-1", "post-1", "u-1"),
        comment("c-2", "post-2", "u-3"),
        comment("c-3", "post-1", "u-2"),
        comment("c-4", "post-1", "u-2"),
    ]
    assert current_post_user_ids(comments, "post-1") == ["u-2", "u-1"]


def test_collect_missing_header_only_selects_incomplete_current_post_users() -> None:
    users = [user("u-1", complete=True), user("u-2"), user("u-3")]
    comments = [
        comment("c-1", "post-1", "u-1"),
        comment("c-2", "post-1", "u-2"),
        comment("c-3", "post-2", "u-3"),
    ]
    selected = select_target_users(
        users,
        comments,
        post_id="post-1",
        mode="collect_missing_header",
        user_limit=20,
    )
    assert [item["user_id"] for item in selected] == ["u-2"]


def test_recent_public_posts_respects_current_post_user_limit() -> None:
    users = [user("u-1", complete=True), user("u-2"), user("u-3")]
    comments = [
        comment("c-1", "post-1", "u-1"),
        comment("c-2", "post-1", "u-2"),
        comment("c-3", "post-2", "u-3"),
    ]
    selected = select_target_users(
        users,
        comments,
        post_id="post-1",
        mode="recent_public_posts",
        user_limit=1,
    )
    assert [item["user_id"] for item in selected] == ["u-1"]


def test_load_request_rejects_implicit_recent_post_budget(tmp_path: Path) -> None:
    payload = request_payload(tmp_path, mode="recent_public_posts")
    payload["profilePostLimitPerUser"] = 0
    path = tmp_path / "request.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(SupplementRequestError, match="explicit"):
        load_request(path)


def test_merge_recent_posts_updates_existing_identity_without_duplicates() -> None:
    merged = merge_recent_posts(
        [{"post_id": "note-1", "title": "old"}],
        [{"post_id": "note-1", "title": "new"}, {"post_id": "note-2", "title": "two"}],
    )
    assert merged == [
        {"post_id": "note-1", "title": "new"},
        {"post_id": "note-2", "title": "two"},
    ]


def test_no_missing_headers_finishes_without_opening_relay(tmp_path: Path) -> None:
    users = [user("u-1", complete=True), user("other")]
    comments = [comment("c-1", "post-1", "u-1"), comment("c-2", "post-2", "other")]
    (tmp_path / "audience-users.json").write_text(json.dumps(users), encoding="utf-8")
    (tmp_path / "audience-comments.json").write_text(json.dumps(comments), encoding="utf-8")
    checkpoint = tmp_path / "profile-supplement.json"
    loader_called = False

    def fail_loader(_path: Path) -> object:
        nonlocal loader_called
        loader_called = True
        raise AssertionError("Relay must not be opened when there is nothing to supplement")

    result = run_supplement(request_payload(tmp_path), checkpoint, upstream_loader=fail_loader)
    assert result["status"] == "completed"
    assert result["targetUserCount"] == 0
    assert loader_called is False
    assert json.loads((tmp_path / "audience-users.json").read_text(encoding="utf-8")) == users
    assert json.loads(checkpoint.read_text(encoding="utf-8"))["jobId"] == "job-1"
