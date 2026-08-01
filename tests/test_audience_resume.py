import json

from scripts import audience_collection
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


def comment(comment_id, *, post_id="post-1", parent_id=""):
    return {
        "comment_id": comment_id,
        "post_id": post_id,
        "parent_comment_id": parent_id,
    }


def page_event(cursor, next_cursor, has_more=True):
    return response_page_event(
        f"https://edith.example/api/sns/web/v2/comment/page?cursor={cursor}",
        {"data": {"cursor": next_cursor, "has_more": has_more}},
    )


def test_comment_page_three_interruption_persists_cursor_and_resumes_exactly():
    post = {"post_id": "post-1", "status": "partial"}
    observed = set()
    for index in range(1, 4):
        event = page_event(f"cursor-{index - 1}", f"cursor-{index}")
        apply_response_checkpoint(
            post,
            event,
            [comment(f"comment-{index}")],
            existing_comment_ids=set(),
            observed_comment_ids=observed,
            attempt_id="attempt-1",
        )

    set_post_terminal(post, "partial_timeout", "runner_timeout")
    assert post["comment_page"] == 3
    assert post["comment_cursor"] == "cursor-3"
    assert choose_resume_strategy(post, exact_cursor_supported=True) == ("exact_cursor", "")

    mark_post_attempt(post, "attempt-2")
    apply_response_checkpoint(
        post,
        page_event("cursor-3", "cursor-4"),
        [comment("comment-4")],
        existing_comment_ids={"comment-1", "comment-2", "comment-3"},
        observed_comment_ids=set(),
        attempt_id="attempt-2",
    )
    assert post["comment_page"] == 4
    assert post["last_successful_cursor"] == "cursor-3"
    assert post["comment_cursor"] == "cursor-4"
    assert post["repeated_requests"] == 0


def test_page_three_fixture_exact_resume_eliminates_replayed_pages_without_losing_coverage():
    checkpoint = {"post_id": "post-1", "status": "partial"}
    for index in range(1, 4):
        apply_response_checkpoint(
            checkpoint,
            page_event(f"cursor-{index - 1}", f"cursor-{index}"),
            [comment(f"comment-{index}")],
            existing_comment_ids=set(),
            observed_comment_ids=set(),
            attempt_id="attempt-1",
        )
    baseline = json.loads(json.dumps(checkpoint))
    exact = json.loads(json.dumps(checkpoint))
    existing = {"comment-1", "comment-2", "comment-3"}

    baseline_observed = set()
    baseline_requests = 0
    for index in range(1, 5):
        baseline_requests += 1
        apply_response_checkpoint(
            baseline,
            page_event(f"cursor-{index - 1}", f"cursor-{index}"),
            [comment(f"comment-{index}")],
            existing_comment_ids=existing,
            observed_comment_ids=baseline_observed,
            attempt_id="attempt-2",
        )

    exact_requests = 1
    apply_response_checkpoint(
        exact,
        page_event("cursor-3", "cursor-4"),
        [comment("comment-4")],
        existing_comment_ids=existing,
        observed_comment_ids=set(),
        attempt_id="attempt-2",
    )

    assert baseline_requests == 4
    assert baseline["repeated_requests"] == 3
    assert baseline["duplicate_comments_seen"] == 3
    assert exact_requests == 1
    assert exact["repeated_requests"] == 0
    assert exact["duplicate_comments_seen"] == 0
    assert baseline["comment_cursor"] == exact["comment_cursor"] == "cursor-4"


def test_reply_thread_interruption_and_reply_cursor_resume_are_persistent():
    post = {"post_id": "post-1", "status": "partial"}
    event = response_page_event(
        "https://edith.example/api/sns/web/v2/comment/sub/page?root_comment_id=root-1&cursor=reply-2",
        {"data": {"cursor": "reply-3", "has_more": True}},
    )
    apply_response_checkpoint(
        post,
        event,
        [comment("reply-1", parent_id="root-1")],
        existing_comment_ids=set(),
        observed_comment_ids=set(),
        attempt_id="attempt-1",
    )

    thread = post["reply_threads"]["root-1"]
    assert thread["reply_cursor"] == "reply-3"
    assert thread["reply_status"] == "running"
    assert thread["attempt_count"] == 1

    resumed = response_page_event(
        "https://edith.example/api/sns/web/v2/comment/sub/page?root_comment_id=root-1&cursor=reply-3",
        {"data": {"cursor": "reply-4", "has_more": False}},
    )
    apply_response_checkpoint(
        post,
        resumed,
        [comment("reply-2", parent_id="root-1")],
        existing_comment_ids={"reply-1"},
        observed_comment_ids=set(),
        attempt_id="attempt-2",
    )
    assert thread["reply_cursor"] == "reply-4"
    assert thread["reply_status"] == "complete_reachable"
    assert thread["has_more_replies"] is False
    assert thread["attempt_count"] == 2


def test_exact_resume_requires_reply_driver_when_a_reply_cursor_is_pending():
    post = {
        "post_id": "post-1",
        "comment_status": "partial_timeout",
        "comment_cursor": "cursor-3",
        "reply_threads": {
            "root-1": {
                "comment_id": "root-1",
                "reply_status": "partial_timeout",
                "reply_cursor": "reply-3",
            },
        },
    }

    assert exact_resume_supported(
        post,
        comment_cursor_supported=True,
        reply_cursor_supported=False,
    ) is False
    assert exact_resume_supported(
        post,
        comment_cursor_supported=True,
        reply_cursor_supported=True,
    ) is True


def test_verification_cancel_and_recoverable_failure_keep_distinct_statuses():
    post = {"post_id": "post-1", "status": "partial"}
    set_post_terminal(post, "partial_verification", "security_verification")
    assert post["recoverable"] is True
    assert post["comment_status"] == "partial_verification"
    set_post_terminal(post, "partial_cancelled", "user_cancelled")
    assert post["comment_status"] == "partial_cancelled"
    set_post_terminal(post, "failed", "bad_payload", recoverable=True)
    assert post["recoverable"] is True


def test_service_restart_normalizes_saved_post_thread_and_user_without_loss():
    post = {"post_id": "post-1", "status": "partial", "comment_cursor": "cursor-3"}
    user = {"user_id": "user-1", "enrichment_status": "partial"}
    mark_post_attempt(post, "attempt-1", now="2026-08-01T00:00:00Z")
    mark_user_attempt(user, "attempt-1", now="2026-08-01T00:00:00Z")
    restored_post = json.loads(json.dumps(post))
    restored_user = json.loads(json.dumps(user))

    initialize_post_checkpoint(restored_post)
    initialize_user_checkpoint(restored_user)
    mark_post_attempt(restored_post, "attempt-2")
    mark_user_attempt(restored_user, "attempt-2")
    assert restored_post["comment_cursor"] == "cursor-3"
    assert restored_post["attempt_count"] == 2
    assert restored_user["profile_attempt_count"] == 2


def test_comment_dedupe_and_repeated_request_metrics_are_idempotent():
    post = {"post_id": "post-1", "status": "partial"}
    event = page_event("cursor-2", "cursor-3")
    observed = set()
    first = apply_response_checkpoint(
        post,
        event,
        [comment("existing-1"), comment("new-1")],
        existing_comment_ids={"existing-1"},
        observed_comment_ids=observed,
        attempt_id="attempt-2",
    )
    second = apply_response_checkpoint(
        post,
        event,
        [comment("existing-1"), comment("new-1")],
        existing_comment_ids={"existing-1"},
        observed_comment_ids=observed,
        attempt_id="attempt-2",
    )
    assert first == {"duplicates": 1, "repeatedRequests": 0}
    assert second == {"duplicates": 0, "repeatedRequests": 1}
    assert post["comment_page"] == 1
    assert checkpoint_metrics([post])["repeatedRequests"] == 1


def test_user_attempt_is_idempotent_and_completed_profile_is_stable():
    user = {"user_id": "user-1", "enrichment_status": "pending"}
    mark_user_attempt(user, "attempt-1")
    mark_user_attempt(user, "attempt-1")
    set_user_terminal(user, "complete_reachable")
    initialize_user_checkpoint(user)
    assert user["profile_attempt_count"] == 1
    assert user["profile_status"] == "complete_reachable"


def test_invalidated_legacy_profile_is_not_skipped_as_complete():
    user = {
        "user_id": "user-legacy",
        "enrichment_status": "complete",
        "profile_status": "complete_reachable",
        "following_count": 88,
        "follower_count": 88,
        "liked_and_collected_count": 88,
        "ip_location": "",
    }

    assert audience_collection.invalidate_legacy_profile_snapshot(user) is True
    initialize_user_checkpoint(user)
    assert user["profile_status"] == "not_started"
    assert user["failure_code"] == "profile_refresh_required"
    assert user["recoverable"] is True


def test_three_level_resume_strategy_and_fallback_metrics_are_explicit():
    exact = {"post_id": "exact", "status": "partial", "comment_cursor": "cursor-3"}
    anchor = {
        "post_id": "anchor", "status": "partial", "comment_cursor": "cursor-3",
        "last_visible_comment_id": "comment-30",
    }
    rescan = {"post_id": "rescan", "status": "partial"}
    assert choose_resume_strategy(exact, exact_cursor_supported=True) == ("exact_cursor", "")
    assert choose_resume_strategy(anchor, exact_cursor_supported=False) == (
        "anchor_comment", "relay_cursor_resume_unavailable",
    )
    assert choose_resume_strategy(rescan, exact_cursor_supported=False) == (
        "rescan_dedupe", "anchor_unavailable",
    )

    set_resume_strategy(anchor, "anchor_comment", "relay_cursor_resume_unavailable")
    assert resolve_anchor_observation(anchor, ["comment-29", "comment-30"]) is True
    assert anchor["resumed_from_anchor"] == "comment-30"
    set_resume_strategy(anchor, "anchor_comment", "relay_cursor_resume_unavailable")
    assert resolve_anchor_observation(anchor, [], scan_finished=True) is False
    assert anchor["resume_strategy"] == "rescan_dedupe"
    assert anchor["fallback_reason"] == "saved_anchor_not_observed"


def test_complete_reachable_is_terminal_and_counts_refresh_without_duplicates():
    post = {"post_id": "post-1", "status": "complete"}
    initialize_post_checkpoint(post)
    assert choose_resume_strategy(post, exact_cursor_supported=True) == ("", "already_complete")
    refresh_post_counts(post, [comment("root"), comment("reply", parent_id="root")])
    assert post["comments_collected"] == 2
    assert post["replies_collected"] == 1


def test_completed_reply_threads_are_skipped_without_suppressing_unknown_controls(monkeypatch):
    class Candidate:
        def __init__(self, comment_id=None, *, evaluate_error=False):
            self.comment_id = comment_id
            self.evaluate_error = evaluate_error
            self.clicked = False

        def evaluate(self, _script):
            if self.evaluate_error:
                raise RuntimeError("detached node")
            return self.comment_id

        def is_visible(self, **_kwargs):
            return True

        def is_enabled(self, **_kwargs):
            return True

        def click(self, **_kwargs):
            self.clicked = True

    completed = Candidate("root-complete")
    pending = Candidate("root-pending")
    unknown = Candidate(evaluate_error=True)
    page = type("Page", (), {
        "get_by_text": lambda self, _pattern: type("Matches", (), {
            "all": lambda self: [completed, pending, unknown],
        })(),
    })()
    monkeypatch.setattr(audience_collection.time, "sleep", lambda _seconds: None)

    clicked = audience_collection._click_more_replies(page, {"root-complete"})

    assert clicked == 2
    assert completed.clicked is False
    assert pending.clicked is True
    assert unknown.clicked is True
