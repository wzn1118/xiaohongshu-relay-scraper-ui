import json
import sys
import types

import pytest

import scripts.audience_collection as audience_collection
from scripts.audience_collection import (
    _challenge_status,
    _comment_api_exhausted,
    _post_source,
    _profile_progress,
    _summary,
    _wait_for_rate_limit_recovery,
    audience_posts_to_supplement,
    compact_count,
    extract_comments_from_payload,
    invalidate_legacy_profile_snapshot,
    merge_audience_posts,
    merge_comment,
    merge_user,
    normalize_audience_post_status,
    parse_profile_snapshot,
)


def test_profile_progress_is_cumulative_across_resume_batches():
    users = {
        "complete-1": {"enrichment_status": "complete"},
        "complete-2": {"enrichment_status": "complete"},
        "partial": {"enrichment_status": "partial"},
        "pending": {},
    }

    assert _profile_progress(users) == (2, 4)


def test_generic_security_phrase_inside_normal_post_is_not_a_challenge():
    text = "https://www.xiaohongshu.com/explore/note\n" + "普通帖子讨论页面安全验证设计。" * 60

    assert _challenge_status(text) == ""
    assert _challenge_status("https://www.xiaohongshu.com/captcha\n安全验证") == "security_verification"
    assert _challenge_status("https://www.xiaohongshu.com/explore/note\n请完成验证") == "security_verification"


def test_image_security_challenge_is_detected_inside_a_long_note_page():
    text = (
        "https://www.xiaohongshu.com/explore/note\n"
        + "正常帖子和评论内容" * 100
        + "\n安全验证\n请选择最符合描述的两张图片\n植物\n换一换\n验证"
    )

    assert _challenge_status(text) == "security_verification"


def test_security_wait_preserves_manual_challenge_and_resumes_when_cleared(monkeypatch):
    class Body:
        def __init__(self, page):
            self.page = page

        def inner_text(self, timeout=0):
            self.page.reads += 1
            return "安全验证\n请选择最符合描述的两张图片" if self.page.reads == 1 else "正常帖子页面"

    class Page:
        url = "https://www.xiaohongshu.com/explore/note"
        reads = 0
        reloads = 0

        def locator(self, _selector):
            return Body(self)

        def reload(self, **_kwargs):
            self.reloads += 1

    page = Page()
    monkeypatch.setattr(audience_collection.time, "sleep", lambda _seconds: None)

    cleared, reason = audience_collection._wait_for_manual_verification(
        page,
        1,
    )

    assert (cleared, reason) == (True, "")
    assert page.reloads == 0


def test_security_attention_fronts_page_focuses_relay_window_and_notifies(monkeypatch):
    calls = []

    class Page:
        def bring_to_front(self):
            calls.append("page")

    monkeypatch.setattr(audience_collection, "_relay_listener_pid", lambda port: calls.append(("port", port)) or 123)
    monkeypatch.setattr(audience_collection, "_focus_windows_process_window", lambda pid: calls.append(("pid", pid)) or True)
    monkeypatch.setattr(audience_collection, "_show_verification_notification", lambda: calls.append("notification") or True)

    assert audience_collection._surface_security_verification(Page(), 18800) == (True, True)
    assert calls == ["page", ("port", 18800), ("pid", 123), "notification"]


def test_comment_api_final_page_is_strict_exhaustion_evidence():
    responses = [
        ("https://edith.xiaohongshu.com/api/sns/web/v2/comment/page", {"data": {"has_more": True}}),
        ("https://edith.xiaohongshu.com/api/sns/web/v2/comment/page", {"data": {"has_more": False}}),
    ]

    assert _comment_api_exhausted(responses) is True
    assert _comment_api_exhausted([
        ("https://edith.xiaohongshu.com/api/sns/web/v2/comment/sub/page", {"data": {"has_more": False}}),
    ]) is False


def test_current_empty_comment_copy_is_strict_exhaustion_evidence():
    assert audience_collection.COMMENT_EMPTY_PATTERN.search("这是一片荒地点击评论")


def test_stagnation_uses_comment_growth_instead_of_repeated_clicks():
    stagnant = audience_collection._next_stagnant_rounds(12, 12, 3)
    assert stagnant == 4
    assert audience_collection._next_stagnant_rounds(12, 13, stagnant) == 0


class FakeRateLimitPage:
    def __init__(self, clear_after: int | None):
        self.url = "https://www.xiaohongshu.com/explore/test"
        self.clear_after = clear_after
        self.reload_count = 0

    def reload(self, **_kwargs):
        self.reload_count += 1

    def wait_for_timeout(self, _milliseconds):
        return None

    def locator(self, _selector):
        page = self

        class Body:
            def inner_text(self, **_kwargs):
                if page.clear_after is not None and page.reload_count >= page.clear_after:
                    return "页面恢复正常"
                return "访问频繁，请稍后再试"

        return Body()


def test_rate_limit_recovery_backs_off_and_resumes_after_probe(capsys):
    page = FakeRateLimitPage(clear_after=2)
    sleep_calls = []
    checkpoints = []

    cleared, reason = _wait_for_rate_limit_recovery(
        page,
        max_retries=3,
        initial_delay_seconds=1,
        max_delay_seconds=4,
        checkpoint_callback=lambda: checkpoints.append("saved"),
        sleep=sleep_calls.append,
    )

    assert cleared is True
    assert reason == ""
    assert page.reload_count == 2
    assert sleep_calls == [1, 2]
    assert checkpoints == ["saved", "saved"]
    output = capsys.readouterr().out
    assert "AUDIENCE_RATE_LIMIT retry=1/3 wait=1s" in output
    assert "AUDIENCE_RATE_LIMIT cleared retry=2/3" in output


def test_rate_limit_recovery_exhaustion_preserves_resumable_state(capsys):
    page = FakeRateLimitPage(clear_after=None)
    checkpoints = []

    cleared, reason = _wait_for_rate_limit_recovery(
        page,
        max_retries=2,
        initial_delay_seconds=0,
        max_delay_seconds=0,
        checkpoint_callback=lambda: checkpoints.append("saved"),
        sleep=lambda _seconds: None,
    )

    assert cleared is False
    assert reason == "rate_limited"
    assert page.reload_count == 2
    assert checkpoints == ["saved", "saved"]
    assert "AUDIENCE_RATE_LIMIT exhausted retries=2" in capsys.readouterr().out


def test_main_records_user_cancellation_as_cancelled_stage(tmp_path, monkeypatch):
    transitions = []

    class State:
        def should_run(self, _stage):
            return True

        def start_stage(self, stage):
            transitions.append(("start", stage))

        def finish_stage(self, stage, status, patch):
            transitions.append(("finish", stage, status, patch))

    monkeypatch.setattr(
        audience_collection,
        "open_workflow_state_from_args",
        lambda _options, _output_dir: State(),
    )
    monkeypatch.setattr(
        audience_collection,
        "collect_audience",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(KeyboardInterrupt()),
    )

    with pytest.raises(KeyboardInterrupt):
        audience_collection.main(["--output-dir", str(tmp_path)])

    assert transitions == [
        ("start", "audience"),
        (
            "finish",
            "audience",
            "cancelled",
            {
                "failureCode": "user_cancelled",
                "failureMessage": "",
                "stopReason": "user_cancelled",
            },
        ),
    ]
def test_rate_limit_manual_request_skips_the_remaining_cooldown(tmp_path, capsys):
    page = FakeRateLimitPage(clear_after=1)
    request_path = tmp_path / ".rate-limit-recover.request"
    request_path.write_text("recover\n", encoding="utf-8")
    sleep_calls = []

    cleared, reason = _wait_for_rate_limit_recovery(
        page,
        max_retries=2,
        initial_delay_seconds=30,
        max_delay_seconds=60,
        manual_recovery_path=request_path,
        sleep=sleep_calls.append,
    )

    assert cleared is True
    assert reason == ""
    assert page.reload_count == 1
    assert sleep_calls == [1]
    assert request_path.exists() is False
    assert "AUDIENCE_RATE_LIMIT manual_probe attempt=1/2" in capsys.readouterr().out


def test_compact_count_supports_common_xiaohongshu_units():
    assert compact_count("1.2万") == 12000
    assert compact_count("3k") == 3000
    assert compact_count("988") == 988
    assert compact_count("") is None


def test_nested_replies_keep_their_parent_comment():
    payload = {
        "data": {
            "comments": [
                {
                    "id": "root-1",
                    "content": "顶层评论",
                    "user_info": {"user_id": "u-1", "nickname": "甲"},
                    "sub_comments": [
                        {
                            "id": "reply-1",
                            "content": "楼中楼回复",
                            "user_info": {"user_id": "u-2", "nickname": "乙"},
                        }
                    ],
                }
            ]
        }
    }

    comments = {
        item["comment_id"]: item
        for item in extract_comments_from_payload(payload, post_id="note-1", note_url="https://example.test/note-1")
    }

    assert comments["root-1"]["parent_comment_id"] == ""
    assert comments["root-1"]["level"] == "comment"
    assert comments["reply-1"]["parent_comment_id"] == "root-1"
    assert comments["reply-1"]["level"] == "reply"


def test_post_source_includes_author_and_expected_comment_count():
    posts = _post_source([
        {
            "note_id": "note-1",
            "title": "示例帖子",
            "note_url": "https://www.xiaohongshu.com/explore/note-1",
            "author": "原帖主",
            "author_profile": "https://www.xiaohongshu.com/user/profile/author-1",
            "card_image_urls": (
                "https://sns-webpic-qc.xhscdn.com/post.webp | "
                "https://sns-avatar-qc.xhscdn.com/avatar/author-1.jpg?imageView2/2/w/80/format/jpg"
            ),
            "comment_count": "1.5万",
        }
    ])

    assert len(posts) == 1
    assert posts[0]["expected_comment_count"] == 15000
    assert posts[0]["author"]["user_id"] == "author-1"
    assert posts[0]["author"]["avatar_url"].startswith("https://sns-avatar-qc.xhscdn.com/avatar/")
    assert posts[0]["author"]["roles"] == ["author"]
    assert posts[0]["status"] == "pending"


def test_summary_only_reports_complete_when_posts_and_profiles_are_complete():
    posts = [{"status": "complete"}]
    comments = [{"parent_comment_id": ""}, {"parent_comment_id": "root-1"}]
    users = [{"enrichment_status": "complete"}]

    completed = _summary(posts, comments, users)
    assert completed["status"] == "complete"
    assert completed["topLevelComments"] == 1
    assert completed["repliesCollected"] == 1

    partial = _summary(posts, comments, [{"enrichment_status": "partial"}])
    assert partial["status"] == "partial"


def test_real_name_replaces_placeholder_during_user_merge():
    merged = merge_user(
        {"user_id": "u-1", "display_name": "未命名用户", "roles": ["commenter"], "post_ids": [], "comment_count": 0},
        {"user_id": "u-1", "display_name": "真实昵称", "roles": ["author"], "post_ids": ["note-1"], "comment_count": 0},
    )

    assert merged["display_name"] == "真实昵称"
    assert merged["roles"] == ["author", "commenter"]


def test_legacy_shell_avatar_is_rejected_during_user_merge():
    bad_avatar = "https://sns-avatar-qc.xhscdn.com/avatar/645b7e371fc3de4c930eff9d.jpg?width=360"
    valid_avatar = "https://sns-avatar-qc.xhscdn.com/avatar/profile-u1.jpg?width=120"

    assert audience_collection.clean_avatar_url(bad_avatar) == ""
    merged = merge_user(
        {"user_id": "u-1", "avatar_url": bad_avatar, "roles": [], "post_ids": []},
        {"user_id": "u-1", "avatar_url": valid_avatar, "roles": [], "post_ids": []},
    )

    assert merged["avatar_url"] == valid_avatar


def test_profile_requires_verified_public_page_before_completion():
    existing = {"user_id": "u-1", "display_name": "评论者", "enrichment_status": "pending"}

    unverified = parse_profile_snapshot({"profile_loaded": False, "display_name": "异常页面"}, existing)
    assert unverified["enrichment_status"] == "partial"
    assert unverified["access_status"] == "profile_not_verified"

    identity_only = parse_profile_snapshot({"profile_loaded": True, "display_name": "公开昵称"}, existing)
    assert identity_only["enrichment_status"] == "partial"
    assert identity_only["access_status"] == "profile_metrics_missing"
    assert identity_only["missing_profile_fields"] == [
        "following_count",
        "follower_count",
        "liked_and_collected_count",
        "ip_location",
        "avatar_url",
    ]


def test_profile_snapshot_keeps_metrics_separate_and_records_ip_location():
    parsed = parse_profile_snapshot({
        "profile_loaded": True,
        "display_name": "Star11",
        "avatar_url": "https://sns-avatar-qc.xhscdn.com/avatar/star11.jpg",
        "ip_location": "上海",
        "following_count": "5",
        "follower_count": "44",
        "liked_and_collected_count": "178",
    }, {"user_id": "u-1", "enrichment_status": "pending"})

    assert parsed["following_count"] == 5
    assert parsed["follower_count"] == 44
    assert parsed["liked_and_collected_count"] == 178
    assert parsed["ip_location"] == "上海"
    assert parsed["location"] == "上海"
    assert parsed["profile_avatar_source"] == "profile_header"
    assert parsed["enrichment_status"] == "complete"
    assert parsed["access_status"] == "public_profile_ok"


def test_profile_with_one_missing_metric_remains_resumable_and_preserves_values():
    parsed = parse_profile_snapshot({
        "profile_loaded": True,
        "display_name": "Star11",
        "avatar_url": "https://sns-avatar-qc.xhscdn.com/avatar/star11.jpg",
        "ip_location": "上海",
        "following_count": "5",
        "follower_count": "44",
    }, {
        "user_id": "u-1",
        "enrichment_status": "pending",
        "liked_and_collected_count": None,
    })

    assert parsed["following_count"] == 5
    assert parsed["follower_count"] == 44
    assert parsed["enrichment_status"] == "partial"
    assert parsed["access_status"] == "profile_metrics_missing"
    assert parsed["missing_profile_fields"] == ["liked_and_collected_count"]


def test_legacy_duplicate_metrics_are_cleared_and_scheduled_for_refresh():
    user = {
        "enrichment_status": "complete",
        "following_count": 544175,
        "follower_count": 544175,
        "liked_and_collected_count": 544175,
        "avatar_url": "https://sns-avatar-qc.xhscdn.com/avatar/u1.jpg",
        "ip_location": "上海",
        "location": "上海",
    }

    assert invalidate_legacy_profile_snapshot(user) is True
    assert user["following_count"] is None
    assert user["follower_count"] is None
    assert user["liked_and_collected_count"] is None
    assert user["enrichment_status"] == "pending"
    assert user["access_status"] == "profile_refresh_required"


def test_complete_profile_with_missing_metric_is_scheduled_without_clearing_good_values():
    user = {
        "enrichment_status": "complete",
        "following_count": 10,
        "follower_count": 20,
        "liked_and_collected_count": None,
        "avatar_url": "https://sns-avatar-qc.xhscdn.com/avatar/u1.jpg",
        "ip_location": "上海",
    }

    assert invalidate_legacy_profile_snapshot(user) is True
    assert user["following_count"] == 10
    assert user["follower_count"] == 20
    assert user["liked_and_collected_count"] is None
    assert user["missing_profile_fields"] == ["liked_and_collected_count"]
    assert user["enrichment_status"] == "pending"


def test_duplicate_legacy_avatar_is_cleared_and_scheduled_for_refresh():
    shared = "https://sns-avatar-qc.xhscdn.com/avatar/sidebar-account.jpg?width=360"
    users = [
        {"user_id": f"u-{index}", "avatar_url": shared, "enrichment_status": "complete"}
        for index in range(8)
    ]
    invalid = audience_collection.legacy_duplicate_avatar_fingerprints(users)
    target = {
        "user_id": "u-1",
        "avatar_url": shared,
        "enrichment_status": "complete",
        "following_count": 1,
        "follower_count": 2,
        "liked_and_collected_count": 3,
        "ip_location": "上海",
    }

    assert audience_collection.invalidate_legacy_profile_snapshot(target, invalid) is True
    assert target["avatar_url"] == ""
    assert target["profile_status"] == "not_started"
    assert target["missing_profile_fields"] == ["avatar_url"]


def test_legitimate_shared_default_avatar_does_not_trigger_profile_refresh():
    shared = "https://sns-avatar-qc.xhscdn.com/avatar/platform-default-user.jpg?width=360"
    users = [
        {"user_id": f"u-{index}", "avatar_url": shared, "enrichment_status": "complete"}
        for index in range(12)
    ]
    invalid = audience_collection.legacy_duplicate_avatar_fingerprints(users)
    target = {
        "user_id": "u-1",
        "avatar_url": shared,
        "enrichment_status": "complete",
        "profile_status": "complete_reachable",
        "following_count": 1,
        "follower_count": 2,
        "liked_and_collected_count": 3,
        "ip_location": "上海",
    }

    assert invalid == set()
    assert audience_collection.invalidate_legacy_profile_snapshot(target, invalid) is False
    assert target["avatar_url"] == shared
    assert target["profile_status"] == "complete_reachable"


def test_duplicate_legacy_avatar_is_restored_from_trusted_checkpoint():
    shared = "https://sns-avatar-qc.xhscdn.com/avatar/sidebar-account.jpg?width=360"
    users = {
        f"u-{index}": {
            "user_id": f"u-{index}",
            "avatar_url": shared,
            "enrichment_status": "complete",
        }
        for index in range(8)
    }
    invalid = audience_collection.legacy_duplicate_avatar_fingerprints(users.values())
    restored = audience_collection.restore_legacy_avatar_urls(
        users,
        [("post_checkpoint", {
            "user_id": "u-1",
            "avatar_url": "https://sns-avatar-qc.xhscdn.com/avatar/real-u-1.jpg",
        })],
        invalid,
    )

    assert restored == ["u-1"]
    assert users["u-1"]["avatar_url"].endswith("real-u-1.jpg")
    assert users["u-1"]["profile_avatar_source"] == "post_checkpoint"


def test_avatar_repair_migrates_saved_users_without_recollecting(tmp_path):
    shared = "https://sns-avatar-qc.xhscdn.com/avatar/sidebar-account.jpg?width=360"
    users = [
        {
            "user_id": f"u-{index}",
            "display_name": f"User {index}",
            "avatar_url": shared,
            "comment_count": index,
            "enrichment_status": "complete",
        }
        for index in range(8)
    ]
    posts = [
        {
            "post_id": f"p-{index}",
            "author": {
                "user_id": f"u-{index}",
                "avatar_url": f"https://sns-avatar-qc.xhscdn.com/avatar/real-u-{index}.jpg",
            },
        }
        for index in range(8)
    ]
    (tmp_path / "audience-users.json").write_text(json.dumps(users), encoding="utf-8")
    (tmp_path / "audience-posts.json").write_text(json.dumps(posts), encoding="utf-8")
    (tmp_path / "audience-comments.json").write_text("[]", encoding="utf-8")
    (tmp_path / "audience-summary.json").write_text(json.dumps({"profilesComplete": 8}), encoding="utf-8")

    result = audience_collection.repair_audience_avatar_checkpoints(tmp_path)
    repaired = json.loads((tmp_path / "audience-users.json").read_text(encoding="utf-8"))

    assert result["affected"] == 8
    assert result["restored"] == 8
    assert result["scheduledForRelayRefresh"] == 0
    assert all("sidebar-account" not in user["avatar_url"] for user in repaired)
    assert (tmp_path / ".avatar-repair-backup" / "audience-users.json").is_file()


def test_profile_snapshot_uses_profile_header_avatar_not_generic_avatar():
    class Page:
        def evaluate(self, script):
            assert ".avatar-wrapper > img.user-image" in script
            assert "document.querySelector('.avatar img" not in script
            return {"profile_loaded": True}

    assert audience_collection._profile_snapshot(Page()) == {"profile_loaded": True}


def test_closed_relay_target_errors_are_retryable():
    assert audience_collection._is_closed_target_error(
        RuntimeError("Page.goto: Target page, context or browser has been closed")
    ) is True
    assert audience_collection._is_closed_target_error(RuntimeError("navigation timeout")) is False


def test_resume_targets_pending_partial_and_legacy_failed_but_never_complete():
    posts = [
        {"post_id": "pending", "status": "pending"},
        {"post_id": "partial", "status": "partial"},
        {"post_id": "failed", "status": "failed"},
        {"post_id": "complete-zero-comments", "status": "complete", "collected_comment_count": 0},
    ]

    targets = audience_posts_to_supplement(posts)

    assert [post["post_id"] for post in targets] == ["pending", "partial", "failed"]


def test_resume_target_allowlist_keeps_historical_posts_visible_without_reopening_them():
    posts = [
        {"post_id": "content-insight-post", "status": "partial"},
        {"post_id": "historical-orphan", "status": "partial"},
    ]

    targets = audience_posts_to_supplement(
        posts,
        allowed_post_ids={"content-insight-post"},
    )

    assert [post["post_id"] for post in targets] == ["content-insight-post"]


def test_resume_prioritizes_unchecked_posts_and_defers_rate_limited_posts():
    posts = [
        {"post_id": "rate-limited", "status": "partial", "failure_reason": "rate_limited"},
        {"post_id": "partial", "status": "partial", "failure_reason": "comment_list_not_proven_complete"},
        {"post_id": "pending", "status": "pending"},
        {"post_id": "security", "status": "partial", "failure_reason": "security_verification"},
    ]

    targets = audience_posts_to_supplement(posts)

    assert [post["post_id"] for post in targets] == ["pending", "partial", "rate-limited", "security"]


def test_summary_separates_attempted_complete_and_posts_with_comments():
    posts = [
        {"post_id": "pending", "status": "pending", "collected_comment_count": 0},
        {"post_id": "partial", "status": "partial", "collected_comment_count": 2},
        {"post_id": "complete", "status": "complete", "collected_comment_count": 0},
    ]

    summary = _summary(posts, [{"comment_id": "comment-1"}], [])

    assert summary["postsTotal"] == 3
    assert summary["postsAttempted"] == 2
    assert summary["postsComplete"] == 1
    assert summary["postsWithComments"] == 1
    assert summary["postAttemptPercent"] == 66.67


def test_checkpoint_merge_uses_content_insight_as_authoritative_post_set():
    source_posts = _post_source([{
        "note_id": "note-1",
        "title": "Content insight",
        "note_url": "https://www.xiaohongshu.com/explore/note-1?from=content-insight",
        "author": "Author",
        "author_profile": "https://www.xiaohongshu.com/user/profile/author-1",
        "comment_count": 3,
    }])
    existing_posts = [
        {
            "post_id": "note-1",
            "note_url": "https://www.xiaohongshu.com/search_result?keyword=new-search",
            "status": "partial",
            "collected_comment_count": 1,
            "old_ui_field": "keep-visible",
        },
        {
            "post_id": "note-old",
            "note_url": "https://www.xiaohongshu.com/explore/note-old",
            "status": "complete",
            "collected_comment_count": 0,
            "old_ui_field": "also-keep-visible",
        },
    ]
    comments = [{"comment_id": "comment-1", "post_id": "note-1"}]

    merged = merge_audience_posts(source_posts, existing_posts, comments)

    assert [post["post_id"] for post in merged] == ["note-1"]
    assert merged[0]["note_url"].endswith("?from=content-insight")
    assert merged[0]["old_ui_field"] == "keep-visible"
    assert merged[0]["collected_comment_count"] == 1
    assert merged[0]["status"] == "partial"


def test_legacy_failed_checkpoint_normalizes_to_partial_and_is_resumable():
    merged = merge_audience_posts([], [{
        "post_id": "note-1",
        "note_url": "https://www.xiaohongshu.com/explore/note-1",
        "status": "failed",
    }], [])

    assert merged[0]["status"] == "partial"
    assert normalize_audience_post_status(merged[0]) == "partial"
    assert audience_posts_to_supplement(merged) == merged


def test_started_audience_attempt_normalizes_to_partial():
    post = {
        "post_id": "note-1",
        "status": "pending",
        "last_attempt_at": "2026-07-31T10:00:00.000Z",
    }

    assert normalize_audience_post_status(post) == "partial"


def test_collected_expected_comment_count_normalizes_to_complete():
    post = {
        "post_id": "note-1",
        "status": "partial",
        "expected_comment_count": 2,
        "collected_comment_count": 1,
    }

    assert normalize_audience_post_status(post, comment_count=2) == "complete"


def test_comment_merge_keeps_existing_fields_while_adding_new_checkpoint_data():
    existing = {
        "comment_id": "comment-1",
        "post_id": "note-1",
        "text": "existing text",
        "visible_marker": "keep-visible",
        "user": {"user_id": "user-1", "display_name": "Existing", "roles": ["commenter"], "post_ids": [], "comment_count": 1},
    }
    incoming = {
        "comment_id": "comment-1",
        "post_id": "note-1",
        "text": "replacement text",
        "new_checkpoint_field": "added",
        "user": {"user_id": "user-1", "display_name": "", "roles": ["commenter"], "post_ids": ["note-1"], "comment_count": 1},
    }

    merged = merge_comment(existing, incoming)

    assert merged["text"] == "existing text"
    assert merged["visible_marker"] == "keep-visible"
    assert merged["new_checkpoint_field"] == "added"
    assert merged["user"]["display_name"] == "Existing"
    assert merged["user"]["post_ids"] == ["note-1"]


def test_collect_audience_opens_only_saved_incomplete_note_urls(monkeypatch, tmp_path):
    saved_complete_url = "https://www.xiaohongshu.com/explore/complete?from=content-insight"
    saved_pending_url = "https://www.xiaohongshu.com/explore/pending?from=content-insight"
    notes = [
        {
            "note_id": "complete",
            "title": "Complete",
            "note_url": saved_complete_url,
            "author": "Author",
            "author_profile": "https://www.xiaohongshu.com/user/profile/author-1",
            "comment_count": 0,
        },
    ]
    application_records = {
        "records": [
            {"note_id": "complete", "title": "Complete", "note_url": saved_complete_url},
            {"note_id": "pending", "title": "Pending", "note_url": saved_pending_url},
        ]
    }
    cards = [
        {
            "note_id": "complete", "title": "Complete", "note_url": saved_complete_url,
            "author": "Author", "author_profile": "https://www.xiaohongshu.com/user/profile/author-1",
            "comment_count": 0,
        },
        {
            "note_id": "pending", "title": "Pending", "note_url": saved_pending_url,
            "author": "Author", "author_profile": "https://www.xiaohongshu.com/user/profile/author-1",
            "comment_count": 0,
        },
    ]
    author = {
        "user_id": "author-1",
        "display_name": "Author",
        "profile_url": "https://www.xiaohongshu.com/user/profile/author-1",
        "roles": ["author"],
        "post_ids": ["complete", "pending"],
        "comment_count": 7,
        "enrichment_status": "complete",
        "access_status": "public_profile_ok",
    }
    posts = [
        {"post_id": "complete", "note_url": "https://stale.test/complete", "status": "complete", "author": author},
        {"post_id": "pending", "note_url": "https://stale.test/pending", "status": "pending", "author": author},
    ]
    preserved_comment = {
        "comment_id": "old-comment",
        "post_id": "complete",
        "parent_comment_id": "",
        "collected_at": "2026-01-01T00:00:00Z",
        "user": author,
    }
    (tmp_path / "xiaohongshu_notes_latest.json").write_text(json.dumps(notes), encoding="utf-8")
    (tmp_path / "application_intelligence.json").write_text(json.dumps(application_records), encoding="utf-8")
    (tmp_path / "xiaohongshu_cards_latest.json").write_text(json.dumps(cards), encoding="utf-8")
    (tmp_path / "audience-posts.json").write_text(json.dumps(posts), encoding="utf-8")
    (tmp_path / "audience-comments.json").write_text(json.dumps([preserved_comment]), encoding="utf-8")
    (tmp_path / "audience-users.json").write_text(json.dumps([author]), encoding="utf-8")

    navigations = []

    class FakeLocator:
        def inner_text(self, timeout=0):
            return "没有更多评论"

    class FakeTextMatches:
        def all(self):
            return []

    class FakePage:
        url = "about:blank"

        def on(self, _event, _callback):
            return None

        def goto(self, url, **_kwargs):
            self.url = url
            navigations.append(url)

        def wait_for_timeout(self, _timeout):
            return None

        def locator(self, _selector):
            return FakeLocator()

        def get_by_text(self, _pattern):
            return FakeTextMatches()

        def evaluate(self, script):
            if "return nodes.map" in script:
                return []
            return {"top": 0, "height": 0, "client": 0}

        def close(self):
            return None

    class FakeContext:
        def new_page(self):
            return FakePage()

    fake_context = FakeContext()
    fake_upstream = types.SimpleNamespace(
        connect_browser=lambda _playwright, _port: object(),
        get_or_create_context=lambda _browser: fake_context,
    )

    class FakePlaywright:
        def __enter__(self):
            return object()

        def __exit__(self, *_args):
            return None

    fake_sync_api = types.ModuleType("playwright.sync_api")
    fake_sync_api.sync_playwright = FakePlaywright
    monkeypatch.setitem(sys.modules, "playwright.sync_api", fake_sync_api)
    monkeypatch.setattr(audience_collection, "load_upstream", lambda _path: fake_upstream)

    audience_collection.collect_audience(
        tmp_path,
        note_delay_seconds=0,
        stable_rounds=1,
    )

    post_navigations = [url for url in navigations if "/explore/" in url or "/search_result" in url]
    assert post_navigations == [saved_pending_url]
    assert not any("search_result" in url for url in navigations)
    persisted_posts = json.loads((tmp_path / "audience-posts.json").read_text(encoding="utf-8"))
    assert [post["post_id"] for post in persisted_posts] == ["complete", "pending"]
    persisted_comments = json.loads((tmp_path / "audience-comments.json").read_text(encoding="utf-8"))
    assert persisted_comments == [preserved_comment]
    persisted_users = json.loads((tmp_path / "audience-users.json").read_text(encoding="utf-8"))
    assert persisted_users[0]["comment_count"] == 7


def test_collect_audience_reads_legacy_checkpoint_without_mutating_it(monkeypatch, tmp_path):
    target_dir = tmp_path / "original-job" / "artifacts"
    checkpoint_dir = tmp_path / "legacy-audience-child"
    target_dir.mkdir(parents=True)
    checkpoint_dir.mkdir()
    complete_url = "https://www.xiaohongshu.com/explore/complete?from=original-insight"
    partial_url = "https://www.xiaohongshu.com/explore/partial?from=original-insight"
    target_notes = [
        {
            "note_id": "complete",
            "title": "Complete target",
            "note_url": complete_url,
            "author": "Author",
            "author_profile": "https://www.xiaohongshu.com/user/profile/author-1",
            "comment_count": 0,
        },
        {
            "note_id": "partial",
            "title": "Partial target",
            "note_url": partial_url,
            "author": "Author",
            "author_profile": "https://www.xiaohongshu.com/user/profile/author-1",
            "comment_count": 0,
        },
    ]
    target_user = {
        "user_id": "author-1",
        "display_name": "Author",
        "profile_url": "https://www.xiaohongshu.com/user/profile/author-1",
        "roles": ["author"],
        "post_ids": ["complete", "partial"],
        "comment_count": 1,
        "enrichment_status": "pending",
        "access_status": "discovered",
    }
    target_posts = [
        {"post_id": "complete", "note_url": complete_url, "status": "pending", "author": target_user},
        {"post_id": "partial", "note_url": partial_url, "status": "pending", "author": target_user},
    ]
    target_comment = {
        "comment_id": "preserved-comment",
        "post_id": "complete",
        "text": "target wins",
        "parent_comment_id": "",
        "collected_at": "2026-01-01T00:00:00Z",
        "user": target_user,
    }
    (target_dir / "xiaohongshu_notes_latest.json").write_text(json.dumps(target_notes), encoding="utf-8")
    (target_dir / "audience-posts.json").write_text(json.dumps(target_posts), encoding="utf-8")
    (target_dir / "audience-comments.json").write_text(json.dumps([target_comment]), encoding="utf-8")
    (target_dir / "audience-users.json").write_text(json.dumps([target_user]), encoding="utf-8")

    complete_user = {
        **target_user,
        "bio": "filled from legacy checkpoint",
        "avatar_url": "https://sns-avatar-qc.xhscdn.com/avatar/author-1.jpg",
        "ip_location": "Shanghai",
        "following_count": 1,
        "follower_count": 2,
        "liked_and_collected_count": 3,
        "comment_count": 9,
        "enrichment_status": "complete",
        "access_status": "public_profile_ok",
        "last_enriched_at": "2026-07-30T00:00:00Z",
    }
    checkpoint_posts = [
        {
            "post_id": "complete",
            "note_url": "https://legacy.invalid/complete",
            "status": "complete",
            "collected_comment_count": 1,
            "author": complete_user,
            "legacy_marker": "keep-visible",
        },
        {
            "post_id": "partial",
            "note_url": "https://legacy.invalid/partial",
            "status": "partial",
            "last_attempt_at": "2026-07-30T00:00:00Z",
            "author": complete_user,
        },
    ]
    checkpoint_comment = {
        **target_comment,
        "text": "legacy must not replace target",
        "legacy_comment_field": "source enrichment",
        "user": complete_user,
    }
    (checkpoint_dir / "audience-posts.json").write_text(json.dumps(checkpoint_posts), encoding="utf-8")
    (checkpoint_dir / "audience-comments.json").write_text(json.dumps([checkpoint_comment]), encoding="utf-8")
    (checkpoint_dir / "audience-users.json").write_text(json.dumps([complete_user]), encoding="utf-8")
    source_bytes = {
        path.name: path.read_bytes()
        for path in checkpoint_dir.iterdir()
        if path.is_file()
    }

    navigations = []

    class FakeLocator:
        def inner_text(self, timeout=0):
            return "normal page"

    class FakeTextMatches:
        def all(self):
            return []

    class FakePage:
        url = "about:blank"

        def on(self, _event, _callback):
            return None

        def goto(self, url, **_kwargs):
            self.url = url
            navigations.append(url)

        def wait_for_timeout(self, _timeout):
            return None

        def locator(self, _selector):
            return FakeLocator()

        def get_by_text(self, _pattern):
            return FakeTextMatches()

        def evaluate(self, script):
            if "return nodes.map" in script:
                return []
            return {"top": 0, "height": 0, "client": 0}

        def close(self):
            return None

    class FakeContext:
        def new_page(self):
            return FakePage()

    fake_upstream = types.SimpleNamespace(
        connect_browser=lambda _playwright, _port: object(),
        get_or_create_context=lambda _browser: FakeContext(),
    )

    class FakePlaywright:
        def __enter__(self):
            return object()

        def __exit__(self, *_args):
            return None

    fake_sync_api = types.ModuleType("playwright.sync_api")
    fake_sync_api.sync_playwright = FakePlaywright
    monkeypatch.setitem(sys.modules, "playwright.sync_api", fake_sync_api)
    monkeypatch.setattr(audience_collection, "load_upstream", lambda _path: fake_upstream)

    audience_collection.collect_audience(
        target_dir,
        checkpoint_dirs=[checkpoint_dir],
        attempt_id="attempt-legacy-readthrough",
        note_delay_seconds=0,
        stable_rounds=1,
    )

    post_navigations = [url for url in navigations if "/explore/" in url]
    assert post_navigations == [partial_url]
    persisted_posts = json.loads((target_dir / "audience-posts.json").read_text(encoding="utf-8"))
    assert persisted_posts[0]["status"] == "complete"
    assert persisted_posts[0]["legacy_marker"] == "keep-visible"
    persisted_comments = json.loads((target_dir / "audience-comments.json").read_text(encoding="utf-8"))
    assert persisted_comments[0]["text"] == "target wins"
    assert persisted_comments[0]["legacy_comment_field"] == "source enrichment"
    persisted_users = json.loads((target_dir / "audience-users.json").read_text(encoding="utf-8"))
    assert persisted_users[0]["enrichment_status"] == "complete"
    assert persisted_users[0]["comment_count"] == 9
    assert {path.name: path.read_bytes() for path in checkpoint_dir.iterdir()} == source_bytes

    backup_root = (
        target_dir.parent
        / "attempts"
        / "attempt-legacy-readthrough"
        / "readthrough-backup"
    )
    manifest_path = backup_root / "readthrough-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["mode"] == "read_through"
    assert manifest["sourceIntegrity"] == "verified"
    assert manifest["targetBackups"]
    assert all(entry["sha256"] for entry in manifest["sourceFiles"])
    for backup in manifest["targetBackups"]:
        assert (backup_root / "target-before-readthrough" / backup["filename"]).is_file()


def test_readthrough_failure_restores_target_bytes_and_removes_new_artifacts(monkeypatch, tmp_path):
    target_dir = tmp_path / "original-job"
    checkpoint_dir = tmp_path / "legacy-audience-child"
    target_dir.mkdir()
    checkpoint_dir.mkdir()
    notes = [{
        "note_id": "note-1",
        "title": "Original title",
        "note_url": "https://www.xiaohongshu.com/explore/note-1?from=original",
        "author": "Author",
        "comment_count": 0,
    }]
    target_posts = [{
        "post_id": "note-1",
        "note_url": notes[0]["note_url"],
        "status": "pending",
        "target_marker": "restore-exactly",
    }]
    checkpoint_posts = [{
        "post_id": "note-1",
        "note_url": "https://legacy.invalid/note-1",
        "status": "complete",
        "collected_comment_count": 4,
        "legacy_marker": "must-be-rolled-back",
    }]
    (target_dir / "xiaohongshu_notes_latest.json").write_text(
        json.dumps(notes, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    (target_dir / "audience-posts.json").write_text(
        json.dumps(target_posts, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    (checkpoint_dir / "audience-posts.json").write_text(
        json.dumps(checkpoint_posts, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    target_bytes = {
        path.name: path.read_bytes()
        for path in target_dir.iterdir()
        if path.is_file()
    }
    source_bytes = {
        path.name: path.read_bytes()
        for path in checkpoint_dir.iterdir()
        if path.is_file()
    }
    monkeypatch.setattr(
        audience_collection,
        "load_upstream",
        lambda _path: (_ for _ in ()).throw(RuntimeError("injected merge failure")),
    )

    with pytest.raises(RuntimeError, match="injected merge failure"):
        audience_collection.collect_audience(
            target_dir,
            checkpoint_dirs=[checkpoint_dir],
            attempt_id="attempt-rollback",
        )

    assert {
        filename: (target_dir / filename).read_bytes()
        for filename in target_bytes
    } == target_bytes
    originally_missing = set(audience_collection.AUDIENCE_CHECKPOINT_FILENAMES) - set(target_bytes)
    assert all(not (target_dir / filename).exists() for filename in originally_missing)
    assert {
        path.name: path.read_bytes()
        for path in checkpoint_dir.iterdir()
        if path.is_file()
    } == source_bytes

    backup_root = target_dir.parent / "attempts" / "attempt-rollback" / "readthrough-backup"
    manifest = json.loads((backup_root / "readthrough-manifest.json").read_text(encoding="utf-8"))
    assert manifest["status"] == "rolled_back"
    assert manifest["targetState"] == "rolled_back"
    assert manifest["sourceIntegrity"] == "verified"
    assert "injected merge failure" in manifest["rollbackReason"]
    assert manifest["rolledBackAt"]
    assert set(manifest["restoredFiles"]) == set(target_bytes)
    assert set(manifest["deletedFiles"]) == originally_missing
    assert manifest["rollbackErrors"] == []
