import json

from scripts.workflow_state import WorkflowStateSession


def test_audience_cursor_checkpoint_is_atomic_revisioned_and_restartable(tmp_path):
    job_dir = tmp_path / "logical-job"
    output_dir = job_dir / "artifacts"
    output_dir.mkdir(parents=True)
    state_path = job_dir / "workflow-state.json"
    state_path.write_text(json.dumps({
        "schemaVersion": 2,
        "jobId": "logical-job",
        "revision": 1,
        "status": "running",
        "activeAttemptId": "attempt-2",
        "resumeCount": 1,
        "attempts": [{"attemptId": "attempt-2", "status": "running"}],
        "stages": {
            "discovery": {"status": "completed", "discoveredIds": []},
            "bodyCompletion": {"status": "not_started", "records": {}},
            "analysis": {"status": "not_started", "records": {}},
            "audience": {"status": "running", "posts": {}, "users": {}},
            "artifacts": {"status": "not_started", "generatedFiles": []},
        },
    }), encoding="utf-8")
    session = WorkflowStateSession.open(
        output_dir=output_dir,
        state_path=state_path,
        attempt_id="attempt-2",
        resume_scope="audience",
        expected_revision=1,
    )
    assert session.output_dir == output_dir.resolve()
    post = {
        "post_id": "post-1",
        "comment_status": "partial_timeout",
        "comment_cursor": "cursor-3",
        "comment_page": 3,
        "reply_cursor": "reply-3",
        "has_more_comments": True,
        "comments_collected": 5,
        "replies_collected": 2,
        "last_visible_comment_id": "comment-5",
        "last_successful_cursor": "cursor-2",
        "attempt_count": 2,
        "stop_reason": "runner_timeout",
        "recoverable": True,
        "resume_strategy": "anchor_comment",
        "fallback_reason": "relay_cursor_resume_unavailable",
        "repeated_requests": 2,
        "duplicate_comments_seen": 5,
        "resumed_from_anchor": "comment-2",
        "performance_penalty": 25.0,
        "reply_threads": {
            "comment-1": {
                "comment_id": "comment-1",
                "reply_status": "running",
                "reply_cursor": "reply-3",
                "has_more_replies": True,
                "replies_collected": 2,
                "attempt_count": 2,
            },
        },
    }
    user = {
        "user_id": "user-1",
        "profile_status": "partial_verification",
        "profile_attempt_count": 2,
        "user_post_cursor": "user-post-4",
        "last_attempt_at": "2026-08-01T00:00:00Z",
        "failure_code": "security_verification",
        "recoverable": True,
    }
    session.checkpoint_audience(
        posts=[post],
        users=[user],
        summary={
            "checkpointSchemaVersion": 1,
            "resumeStrategyCounts": {"anchor_comment": 1},
            "repeatedRequests": 2,
            "duplicateCommentsSeen": 5,
            "performancePenalty": 25.0,
        },
    )

    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    assert persisted["jobId"] == "logical-job"
    assert persisted["revision"] == 2
    stage = persisted["stages"]["audience"]
    assert stage["posts"]["post-1"]["commentCursor"] == "cursor-3"
    assert stage["posts"]["post-1"]["resumeStrategy"] == "anchor_comment"
    assert stage["replyThreads"]["post-1:comment-1"]["replyCursor"] == "reply-3"
    assert stage["users"]["user-1"]["userPostCursor"] == "user-post-4"

    reopened = WorkflowStateSession.open(
        output_dir=output_dir,
        state_path=state_path,
        attempt_id="attempt-2",
        resume_scope="audience",
        expected_revision=2,
    )
    assert reopened.output_dir == output_dir.resolve()
    assert reopened.state["jobId"] == "logical-job"
    assert reopened.state["stages"]["audience"]["posts"]["post-1"]["commentPage"] == 3
