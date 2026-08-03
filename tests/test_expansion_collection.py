import inspect
import json
import sys
import time
import tracemalloc
from pathlib import Path

import pytest

from scripts.expansion_collection import ExpansionConfig, PlaywrightExpansionAdapter, collect_expansion


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import run_project_workflow as workflow  # noqa: E402


def seed(post_id: str) -> dict:
    return {"postId": post_id, "postUrl": f"https://fixture.invalid/explore/{post_id}", "title": post_id}


def comment(comment_id: str, user_id: str, *, parent_id: str = "") -> dict:
    return {
        "comment_id": comment_id,
        "text": f"comment-{comment_id}",
        "parent_comment_id": parent_id,
        "user": {
            "user_id": user_id,
            "nickname": user_id,
            "profile_url": f"https://fixture.invalid/user/profile/{user_id}",
        },
    }


def post(post_id: str, author_id: str) -> dict:
    return {
        "postId": post_id,
        "postUrl": f"https://fixture.invalid/explore/{post_id}",
        "authorUserId": author_id,
        "title": post_id,
        "engagement": 1,
    }


class FakeExpansionAdapter:
    def __init__(
        self,
        *,
        comments_by_post=None,
        posts_by_user=None,
        blocked_posts=(),
        blocked_users=(),
        failed_users=(),
        interrupt_user="",
    ):
        self.comments_by_post = comments_by_post or {}
        self.posts_by_user = posts_by_user or {}
        self.blocked_posts = set(blocked_posts)
        self.blocked_users = set(blocked_users)
        self.failed_users = set(failed_users)
        self.interrupt_user = interrupt_user
        self.interrupted = False
        self.expand_calls = []
        self.post_calls = []
        self.opened = False
        self.closed = False

    def open(self):
        self.opened = True

    def close(self):
        self.closed = True

    def collect_post_comments(self, item, _config):
        post_id = item["postId"]
        self.post_calls.append(post_id)
        if post_id in self.blocked_posts:
            return {
                "comments": [], "commentStatus": "blocked_verification",
                "hasMore": True, "stopReason": "security_verification",
            }
        comments = list(self.comments_by_post.get(post_id, []))
        return {
            "comments": comments, "commentStatus": "complete_reachable",
            "commentsAttempted": len(comments), "commentsSucceeded": len(comments),
            "hasMore": False, "stopReason": "current_session_reachable_exhausted",
            "postPatch": {"body": f"body-{post_id}", "bodyStatus": "succeeded"},
        }

    def expand_user(self, item, _config, _keyword):
        user_id = item["userId"]
        self.expand_calls.append(user_id)
        if user_id == self.interrupt_user and not self.interrupted:
            self.interrupted = True
            raise InterruptedError("fixture interruption")
        if user_id in self.blocked_users:
            return {"status": "blocked", "profile": {}, "posts": [], "stopReason": "security_verification"}
        if user_id in self.failed_users:
            return {"status": "failed", "profile": {}, "posts": [], "stopReason": "fixture_failure"}
        return {
            "status": "completed",
            "profile": {"display_name": user_id, "enrichment_status": "complete"},
            "posts": list(self.posts_by_user.get(user_id, [])),
            "stopReason": "",
        }


def config(rounds: int, **changes) -> dict:
    value = {
        "enabled": True,
        "rounds": rounds,
        "includeReplies": True,
        "maxReplyDepth": 2,
        "maxUsersPerRound": 50,
        "maxPostsPerUser": 5,
        "maxCommentsPerPost": 200,
        "maxTotalUsers": 5000,
        "maxTotalPosts": 5000,
        "maxTotalComments": 20000,
        "timeBudgetMinutes": 60,
        "maxFailureCount": 10,
        "concurrency": 1,
        "postSelectionStrategy": "latest",
        "schemaVersion": 1,
    }
    value.update(changes)
    return value


def run_fixture(tmp_path: Path, name: str, adapter: FakeExpansionAdapter, seeds, rounds=0, **changes):
    output = tmp_path / name / "artifacts"
    summary = collect_expansion(
        output,
        config=config(rounds, **changes),
        adapter=adapter,
        seed_posts=seeds,
        keyword="fixture",
        attempt_id=name,
    )
    return output, summary


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_zero_round_collects_seed_comments_without_opening_profiles(tmp_path):
    adapter = FakeExpansionAdapter(comments_by_post={
        "seed": [comment("c1", "A"), comment("c2", "B"), comment("c3", "C")],
    })
    output, summary = run_fixture(tmp_path, "round-0", adapter, [seed("seed")])

    assert adapter.expand_calls == []
    assert adapter.post_calls == ["seed"]
    assert summary["completedRounds"] == 0
    assert summary["counters"]["users"] == 3
    assert summary["stopReason"] == "rounds_completed"
    assert read_json(output / "graph.json")["maxRounds"] == 0


def test_one_round_expands_only_seed_commenters(tmp_path):
    adapter = FakeExpansionAdapter(
        comments_by_post={
            "seed": [comment("seed-a", "A"), comment("seed-b", "B")],
            "a1": [comment("a1-c", "C")], "a2": [comment("a2-d", "D")],
            "b1": [comment("b1-c", "C")],
        },
        posts_by_user={"A": [post("a1", "A"), post("a2", "A")], "B": [post("b1", "B")]},
    )
    output, summary = run_fixture(tmp_path, "round-1", adapter, [seed("seed")], rounds=1)

    assert adapter.expand_calls == ["A", "B"]
    assert set(adapter.post_calls) == {"seed", "a1", "a2", "b1"}
    assert summary["counters"]["users"] == 4
    assert summary["counters"]["expandedUsers"] == 2
    assert summary["stopReason"] == "rounds_completed"
    discovered_edges = [
        item for item in read_json(output / "graph.json")["edges"]
        if item["type"] == "POST_DISCOVERED_FROM_USER"
    ]
    assert {(item["fromId"], item["toId"]) for item in discovered_edges} == {
        ("A", "a1"), ("A", "a2"), ("B", "b1"),
    }


def test_preloaded_seed_comments_fill_frontier_before_live_refresh(tmp_path):
    adapter = FakeExpansionAdapter(comments_by_post={"seed": []}, posts_by_user={"A": [], "B": []})
    output = tmp_path / "preloaded" / "artifacts"
    summary = collect_expansion(
        output,
        config=config(1),
        adapter=adapter,
        seed_posts=[seed("seed")],
        seed_comments_by_post={"seed": [comment("stored-a", "A"), comment("stored-b", "B")]},
    )

    assert adapter.post_calls == ["seed"]
    assert adapter.expand_calls == ["A", "B"]
    assert summary["counters"]["users"] == 2
    assert summary["counters"]["comments"] == 2
    seed_node = next(
        item for item in read_json(output / "graph.json")["nodes"]
        if item["type"] == "Post" and item["postId"] == "seed"
    )
    assert seed_node["commentsSucceeded"] == 2


def test_two_rounds_expand_the_next_unique_frontier(tmp_path):
    adapter = FakeExpansionAdapter(
        comments_by_post={
            "seed": [comment("s-a", "A"), comment("s-b", "B")],
            "pa": [comment("pa-c", "C")], "pb": [comment("pb-d", "D")],
            "pc": [comment("pc-e", "E")], "pd": [comment("pd-f", "F")],
        },
        posts_by_user={
            "A": [post("pa", "A")], "B": [post("pb", "B")],
            "C": [post("pc", "C")], "D": [post("pd", "D")],
        },
    )
    output, summary = run_fixture(tmp_path, "round-2", adapter, [seed("seed")], rounds=2)

    assert adapter.expand_calls == ["A", "B", "C", "D"]
    assert summary["counters"]["expandedUsers"] == 4
    assert summary["completedRounds"] == 2
    assert [item["roundIndex"] for item in read_json(output / "expansion_rounds.json")] == [0, 1, 2]


def test_cycle_terminates_and_each_user_expands_once(tmp_path):
    adapter = FakeExpansionAdapter(
        comments_by_post={
            "seed": [comment("s-a", "A")], "pa": [comment("a-b", "B")],
            "pb": [comment("b-c", "C")], "pc": [comment("c-a", "A")],
        },
        posts_by_user={
            "A": [post("pa", "A")], "B": [post("pb", "B")], "C": [post("pc", "C")],
        },
    )
    _, summary = run_fixture(tmp_path, "cycle", adapter, [seed("seed")], rounds=3)

    assert adapter.expand_calls == ["A", "B", "C"]
    assert summary["counters"]["expandedUsers"] == 3
    assert summary["stopReason"] == "rounds_completed"


def test_multi_seed_duplicate_user_keeps_multiple_source_relations(tmp_path):
    adapter = FakeExpansionAdapter(comments_by_post={
        "s1": [comment("s1-a", "A")], "s2": [comment("s2-a", "A")],
    })
    output, summary = run_fixture(tmp_path, "multi-source", adapter, [seed("s1"), seed("s2")])
    graph = read_json(output / "graph.json")
    sources = {
        edge["sourceSeedPostId"]
        for edge in graph["edges"]
        if edge["type"] == "USER_DISCOVERED_FROM_POST" and edge["fromId"] == "A"
    }

    assert summary["counters"]["users"] == 1
    assert sources == {"s1", "s2"}


def test_per_round_and_per_item_budgets_apply_before_scheduling(tmp_path):
    adapter = FakeExpansionAdapter(
        comments_by_post={
            "seed": [comment("a", "A"), comment("b", "B"), comment("c", "C")],
            "pa": [comment("pa1", "X"), comment("pa2", "Y"), comment("pa3", "Z")],
        },
        posts_by_user={"A": [post("pa", "A"), post("pa2", "A")], "B": [], "C": []},
    )
    output, _ = run_fixture(
        tmp_path, "per-item-budgets", adapter, [seed("seed")], rounds=1,
        maxUsersPerRound=2, maxPostsPerUser=1,
    )

    assert adapter.expand_calls == ["A", "B"]
    assert adapter.post_calls == ["seed", "pa"]
    frontier = read_json(output / "expansion_frontier.json")
    assert next(item for item in frontier["currentFrontier"] if item["userId"] == "C")["state"] == "skipped_budget"

    comment_adapter = FakeExpansionAdapter(comments_by_post={
        "seed": [comment("a", "A"), comment("b", "B"), comment("c", "C")],
    })
    output, _ = run_fixture(
        tmp_path, "per-post-comment-budget", comment_adapter, [seed("seed")],
        maxCommentsPerPost=1,
    )
    posts = {
        item["postId"]: item
        for item in read_json(output / "graph.json")["nodes"]
        if item["type"] == "Post"
    }
    assert posts["seed"]["commentStatus"] == "partial_limit"
    assert posts["seed"]["commentsSucceeded"] == 1


@pytest.mark.parametrize(
    ("name", "limits", "expected_reason", "expected_count"),
    [
        ("users", {"maxTotalUsers": 1}, "user_budget_reached", ("users", 1)),
        ("posts", {"maxTotalPosts": 2}, "post_budget_reached", ("posts", 2)),
        ("comments", {"maxTotalComments": 2}, "comment_budget_reached", ("comments", 2)),
    ],
)
def test_total_entity_budgets_stop_at_the_cap(tmp_path, name, limits, expected_reason, expected_count):
    adapter = FakeExpansionAdapter(
        comments_by_post={
            "seed": [comment("a", "A"), comment("b", "B"), comment("c", "C")],
            "pa": [], "pb": [],
        },
        posts_by_user={"A": [post("pa", "A"), post("pb", "A")]},
    )
    rounds = 1 if name == "posts" else 0
    output, summary = run_fixture(tmp_path, f"total-{name}", adapter, [seed("seed")], rounds=rounds, **limits)

    assert summary["stopReason"] == expected_reason
    assert summary["counters"][expected_count[0]] == expected_count[1]
    assert summary["status"] == "partial"
    if name == "comments":
        post_node = next(
            item for item in read_json(output / "graph.json")["nodes"]
            if item["type"] == "Post" and item["postId"] == "seed"
        )
        assert post_node["commentStatus"] == "partial_limit"
        assert post_node["stopReason"] == "max_total_comments"
        assert post_node["hasMore"] is True


def test_user_budget_keeps_already_queued_users_running(tmp_path):
    adapter = FakeExpansionAdapter(
        comments_by_post={"seed": [comment("a", "A"), comment("b", "B")]},
        posts_by_user={"A": []},
    )
    _, summary = run_fixture(
        tmp_path, "soft-user-budget", adapter, [seed("seed")],
        rounds=1, maxTotalUsers=1,
    )

    assert adapter.expand_calls == ["A"]
    assert summary["counters"]["expandedUsers"] == 1
    assert summary["stopReason"] == "user_budget_reached"


def test_time_budget_stops_before_the_next_scheduled_operation(tmp_path):
    class Clock:
        def __init__(self):
            self.calls = 0

        def __call__(self):
            self.calls += 1
            return 0.0 if self.calls < 3 else 61.0

    adapter = FakeExpansionAdapter(comments_by_post={"seed": [comment("a", "A")]})
    output = tmp_path / "time" / "artifacts"
    summary = collect_expansion(
        output, config=config(0, timeBudgetMinutes=1), adapter=adapter,
        seed_posts=[seed("seed")], monotonic=Clock(),
    )

    assert summary["stopReason"] == "time_budget_reached"
    assert adapter.post_calls == []


def test_interrupted_round_resumes_without_reexpanding_completed_users(tmp_path):
    comments = {
        "seed": [comment("s-a", "A"), comment("s-b", "B")],
        "pa": [comment("pa-c", "C")], "pb": [comment("pb-d", "D")],
    }
    posts = {"A": [post("pa", "A")], "B": [post("pb", "B")]}
    first = FakeExpansionAdapter(comments_by_post=comments, posts_by_user=posts, interrupt_user="B")
    output, interrupted = run_fixture(tmp_path, "resume", first, [seed("seed")], rounds=1)
    before = read_json(output / "graph.json")["counters"]

    second = FakeExpansionAdapter(comments_by_post=comments, posts_by_user=posts)
    _, resumed = run_fixture(tmp_path, "resume", second, [seed("seed")], rounds=1)

    assert interrupted["stopReason"] == "interrupted"
    assert first.expand_calls == ["A", "B"]
    assert second.expand_calls == ["B"]
    assert resumed["stopReason"] == "rounds_completed"
    assert resumed["counters"]["users"] >= before["users"]
    assert resumed["counters"] == {"users": 4, "posts": 3, "comments": 4, "expandedUsers": 2, "crawledPosts": 3}


def test_new_attempt_recollects_selected_posts_and_keeps_accumulated_graph(tmp_path):
    first = FakeExpansionAdapter(comments_by_post={
        "seed-1": [comment("first-comment", "first-user")],
    })
    output, initial = run_fixture(tmp_path, "new-attempt", first, [seed("seed-1")])
    assert first.post_calls == ["seed-1"]
    assert initial["attemptId"] == "new-attempt"

    second = FakeExpansionAdapter(comments_by_post={
        "seed-1": [comment("refreshed-comment", "refreshed-user")],
        "seed-2": [comment("second-comment", "second-user")],
    })
    refreshed = collect_expansion(
        output,
        config=config(0),
        adapter=second,
        seed_posts=[seed("seed-1"), seed("seed-2")],
        keyword="fixture",
        attempt_id="attempt-2",
        new_attempt=True,
    )

    graph = read_json(output / "graph.json")
    assert second.post_calls == ["seed-1", "seed-2"]
    assert refreshed["attemptId"] == "attempt-2"
    assert refreshed["seedPostIds"] == ["seed-1", "seed-2"]
    assert refreshed["failureCount"] == 0
    assert {item["postId"] for item in graph["nodes"] if item["type"] == "Post"} == {"seed-1", "seed-2"}
    assert {item["commentId"] for item in graph["nodes"] if item["type"] == "Comment"} == {
        "first-comment", "refreshed-comment", "second-comment",
    }


def test_new_attempt_resets_failure_budget_before_opening_relay(tmp_path):
    failed = FakeExpansionAdapter(
        comments_by_post={"seed-1": [comment("failed-comment", "failed-user")]},
        failed_users={"failed-user"},
    )
    output, first = run_fixture(
        tmp_path, "new-attempt-failure-reset", failed, [seed("seed-1")],
        rounds=1, maxFailureCount=1,
    )
    assert first["failureCount"] == 1

    class OpenFailureAdapter(FakeExpansionAdapter):
        def open(self):
            raise RuntimeError("relay fixture unavailable")

    unavailable = collect_expansion(
        output,
        config=config(0, maxFailureCount=1),
        adapter=OpenFailureAdapter(),
        seed_posts=[seed("seed-2")],
        attempt_id="attempt-open-failure",
        new_attempt=True,
    )
    frontier = read_json(output / "expansion_frontier.json")
    assert unavailable["attemptId"] == "attempt-open-failure"
    assert unavailable["failureCount"] == 0
    assert frontier["currentFrontier"] == []

    retry = FakeExpansionAdapter(comments_by_post={
        "seed-2": [comment("retry-comment", "retry-user")],
    })
    recovered = collect_expansion(
        output,
        config=config(0, maxFailureCount=1),
        adapter=retry,
        seed_posts=[seed("seed-2")],
        attempt_id="attempt-open-failure",
    )
    assert retry.post_calls == ["seed-2"]
    assert recovered["failureCount"] == 0
    assert recovered["seedPostIds"] == ["seed-2"]


def test_security_block_is_checkpointed_without_retry_or_complete_status(tmp_path):
    adapter = FakeExpansionAdapter(blocked_posts={"seed"})
    output, summary = run_fixture(tmp_path, "blocked", adapter, [seed("seed")])
    frontier = read_json(output / "expansion_frontier.json")
    graph = read_json(output / "graph.json")
    seed_node = next(item for item in graph["nodes"] if item["type"] == "Post")

    assert adapter.post_calls == ["seed"]
    assert summary["stopReason"] == "verification_blocked"
    assert summary["status"] == "partial"
    assert frontier["stopReason"] == "verification_blocked"
    assert seed_node["commentStatus"] == "blocked_verification"
    assert seed_node["commentExecutionStatus"] == "blocked"


def test_user_cancellation_keeps_frontier_resumable(tmp_path):
    adapter = FakeExpansionAdapter(comments_by_post={"seed": [comment("a", "A")]})
    output = tmp_path / "cancelled" / "artifacts"
    summary = collect_expansion(
        output, config=config(1), adapter=adapter, seed_posts=[seed("seed")],
        cancel_requested=lambda: True,
    )

    assert summary["stopReason"] == "user_cancelled"
    assert summary["status"] == "partial"
    assert adapter.post_calls == []
    assert read_json(output / "expansion_frontier.json")["stopReason"] == "user_cancelled"


def test_user_cancellation_marks_active_frontier_and_resumes_it(tmp_path):
    adapter = FakeExpansionAdapter(
        comments_by_post={"seed": [comment("a", "A")], "a-post": []},
        posts_by_user={"A": [post("a-post", "A")]},
    )
    output = tmp_path / "cancel-active" / "artifacts"
    checks = 0

    def cancel_during_user_posts():
        nonlocal checks
        checks += 1
        return checks >= 3

    cancelled = collect_expansion(
        output, config=config(1), adapter=adapter, seed_posts=[seed("seed")],
        cancel_requested=cancel_during_user_posts,
    )
    cancelled_frontier = read_json(output / "expansion_frontier.json")

    assert cancelled["stopReason"] == "user_cancelled"
    assert len(cancelled_frontier["currentFrontier"]) == 1
    assert cancelled_frontier["currentFrontier"][0] | {"sequence": 0} == {
        "roundIndex": 1, "userId": "A", "state": "cancelled", "sequence": 0,
    }

    resumed_adapter = FakeExpansionAdapter(
        comments_by_post={"seed": [comment("a", "A")], "a-post": []},
        posts_by_user={"A": [post("a-post", "A")]},
    )
    resumed = collect_expansion(
        output, config=config(1), adapter=resumed_adapter, seed_posts=[seed("seed")],
    )

    assert resumed_adapter.expand_calls == ["A"]
    assert resumed["stopReason"] == "rounds_completed"
    resumed_frontier = read_json(output / "expansion_frontier.json")["currentFrontier"]
    assert len(resumed_frontier) == 1
    assert resumed_frontier[0] | {"sequence": 0} == {
        "roundIndex": 1, "userId": "A", "state": "completed", "sequence": 0,
    }


def test_failure_budget_stops_before_later_users(tmp_path):
    adapter = FakeExpansionAdapter(
        comments_by_post={"seed": [comment("a", "A"), comment("b", "B")]},
        failed_users={"A", "B"},
    )
    _, summary = run_fixture(
        tmp_path, "failure-budget", adapter, [seed("seed")], rounds=1, maxFailureCount=1,
    )

    assert summary["stopReason"] == "failure_budget_reached"
    assert adapter.expand_calls == ["A"]
    assert summary["failureCount"] == 1


@pytest.mark.parametrize(
    ("message", "expected_reason"),
    [("Relay unavailable", "relay_unavailable"), ("unexpected fixture", "fatal_error")],
)
def test_open_failures_are_classified_and_exported(tmp_path, message, expected_reason):
    class OpenFailureAdapter(FakeExpansionAdapter):
        def open(self):
            raise RuntimeError(message)

    output, summary = run_fixture(tmp_path, expected_reason, OpenFailureAdapter(), [seed("seed")])

    assert summary["stopReason"] == expected_reason
    assert summary["status"] == "partial"
    assert (output / "expansion_summary.json").is_file()


def test_entity_adapter_exceptions_consume_failure_budget_without_becoming_fatal(tmp_path):
    class EntityFailureAdapter(FakeExpansionAdapter):
        def collect_post_comments(self, post_item, expansion_config):
            if post_item["postId"] == "broken-post":
                raise TimeoutError("fixture post timeout")
            return super().collect_post_comments(post_item, expansion_config)

        def expand_user(self, user_item, expansion_config, keyword):
            if user_item["userId"] == "broken-user":
                raise TimeoutError("fixture profile timeout")
            return super().expand_user(user_item, expansion_config, keyword)

    output, post_summary = run_fixture(
        tmp_path, "post-adapter-error", EntityFailureAdapter(), [seed("broken-post")],
    )
    failed_post = next(
        item for item in read_json(output / "graph.json")["nodes"] if item["type"] == "Post"
    )
    assert post_summary["stopReason"] == "rounds_completed"
    assert post_summary["status"] == "partial"
    assert post_summary["failureCount"] == 1
    assert failed_post["commentExecutionStatus"] == "failed"

    adapter = EntityFailureAdapter(
        comments_by_post={"seed": [comment("broken", "broken-user")]},
    )
    output, user_summary = run_fixture(
        tmp_path, "user-adapter-error", adapter, [seed("seed")], rounds=1,
    )
    frontier = read_json(output / "expansion_frontier.json")
    assert user_summary["stopReason"] == "rounds_completed"
    assert user_summary["status"] == "partial"
    assert user_summary["profilesFailed"] == 1
    assert frontier["currentOperation"] == {}


def test_expansion_config_is_strict_and_production_default_is_real_adapter():
    assert ExpansionConfig.from_dict({"enabled": True, "rounds": 0}).rounds == 0
    with pytest.raises(ValueError, match="Unsupported expansion parameters"):
        ExpansionConfig.from_dict({"enabled": True, "unknown": 1})
    with pytest.raises(ValueError, match="must be boolean"):
        ExpansionConfig.from_dict({"enabled": "true"})
    with pytest.raises(ValueError, match="must be an integer"):
        ExpansionConfig.from_dict({"rounds": 1.5})
    with pytest.raises(ValueError, match="1 to 1"):
        ExpansionConfig.from_dict({"concurrency": 2})
    assert inspect.signature(collect_expansion).parameters["adapter"].default is None
    assert PlaywrightExpansionAdapter.__doc__.startswith("Production adapter")


def test_production_adapter_closes_the_started_playwright_runtime():
    adapter = PlaywrightExpansionAdapter(
        relay_port=18800,
        goto_timeout_ms=1000,
        note_delay_seconds=0,
        stable_rounds=1,
        upstream_scraper=Path("fixture.py"),
    )

    class FakePage:
        closed = False

        def is_closed(self):
            return self.closed

        def close(self):
            self.closed = True

    class FakePlaywright:
        stopped = False

        def stop(self):
            self.stopped = True

    adapter.page = FakePage()
    runtime = FakePlaywright()
    adapter.playwright = runtime
    adapter.playwright_manager = object()

    adapter.close()

    assert adapter.page.closed is True
    assert runtime.stopped is True
    assert adapter.playwright is None


@pytest.mark.parametrize("seed_count,user_count", [(1, 100), (10, 1000)])
def test_persistent_frontier_scales_to_synthetic_graphs(tmp_path, seed_count, user_count):
    seeds = [seed(f"s{index}") for index in range(seed_count)]
    comments_by_post = {item["postId"]: [] for item in seeds}
    for index in range(user_count):
        target = seeds[index % seed_count]["postId"]
        comments_by_post[target].append(comment(f"c{index}", f"U{index}"))
    adapter = FakeExpansionAdapter(comments_by_post=comments_by_post)

    tracemalloc.start()
    wall_started = time.perf_counter()
    cpu_started = time.process_time()
    output, summary = run_fixture(
        tmp_path, f"scale-{seed_count}-{user_count}", adapter, seeds,
        maxTotalUsers=user_count + 1, maxTotalComments=user_count + 1,
        maxCommentsPerPost=max(200, user_count),
    )
    elapsed = time.perf_counter() - wall_started
    cpu = time.process_time() - cpu_started
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    checkpoint_bytes = (output / "expansion_frontier.json").stat().st_size
    artifact_bytes = sum(item.stat().st_size for item in output.iterdir() if item.is_file())

    assert summary["counters"]["users"] == user_count
    assert summary["counters"]["comments"] == user_count
    assert peak < 128 * 1024 * 1024
    print(json.dumps({
        "seeds": seed_count, "users": user_count, "wallSeconds": round(elapsed, 3),
        "cpuSeconds": round(cpu, 3), "peakBytes": peak,
        "checkpointBytes": checkpoint_bytes, "artifactBytes": artifact_bytes,
        "queueLength": summary["frontierCount"],
    }, sort_keys=True))


def test_high_duplicate_wide_and_deep_shapes_remain_bounded(tmp_path):
    duplicate_seeds = [seed(f"dup{index}") for index in range(10)]
    duplicate_comments = {
        item["postId"]: [comment(f"{item['postId']}-{user}", user) for user in ("A", "B", "C")]
        for item in duplicate_seeds
    }
    _, duplicate_summary = run_fixture(
        tmp_path, "high-duplicate", FakeExpansionAdapter(comments_by_post=duplicate_comments), duplicate_seeds,
    )
    assert duplicate_summary["counters"]["users"] == 3

    comments_by_post = {"seed": [comment("chain-0", "U0")]}
    posts_by_user = {}
    for index in range(5):
        posts_by_user[f"U{index}"] = [post(f"p{index}", f"U{index}")]
        comments_by_post[f"p{index}"] = [comment(f"chain-{index + 1}", f"U{index + 1}")]
    adapter = FakeExpansionAdapter(comments_by_post=comments_by_post, posts_by_user=posts_by_user)
    _, deep_summary = run_fixture(tmp_path, "deep", adapter, [seed("seed")], rounds=5)
    assert adapter.expand_calls == ["U0", "U1", "U2", "U3", "U4"]
    assert deep_summary["completedRounds"] == 5


def test_missing_or_disabled_expansion_uses_the_unchanged_standard_collector(monkeypatch, tmp_path):
    wrapper, _ = workflow.parse_wrapper_args([])
    standard_calls = []
    expansion_calls = []

    def fake_standard(output_dir, **kwargs):
        standard_calls.append((output_dir, kwargs))
        return {"status": "complete"}

    def fake_expansion(output_dir, **kwargs):
        expansion_calls.append((output_dir, kwargs))
        return {"status": "complete"}

    monkeypatch.setattr(workflow, "collect_audience", fake_standard)
    monkeypatch.setattr(workflow, "collect_expansion", fake_expansion)
    arguments = ["--relay-port", "18800", "--keyword", "fixture"]
    upstream = tmp_path / "upstream.py"

    workflow.collect_configured_audience(wrapper, tmp_path, arguments, upstream)
    wrapper.expansion_config_json = json.dumps({"enabled": False, "rounds": 2})
    workflow.collect_configured_audience(wrapper, tmp_path, arguments, upstream)

    assert len(standard_calls) == 2
    assert expansion_calls == []
    assert standard_calls[0][1]["relay_port"] == 18800
    assert standard_calls[0][1]["upstream_scraper"] == upstream

    wrapper.expansion_config_json = json.dumps({"enabled": True, "rounds": 0})
    workflow.collect_configured_audience(wrapper, tmp_path, arguments, upstream)
    assert len(standard_calls) == 2
    assert expansion_calls[0][1]["config"]["rounds"] == 0
    assert expansion_calls[0][1]["keyword"] == "fixture"


def test_expansion_artifacts_are_hashed_in_the_existing_manifest(tmp_path):
    output, _ = run_fixture(
        tmp_path,
        "manifest",
        FakeExpansionAdapter(comments_by_post={"seed": [comment("a", "A")]}),
        [seed("seed")],
    )
    manifest_path = workflow.write_project_manifest(output, {
        "status": "completed_partial",
        "checks": {"fixture": True},
        "notesCollected": 1,
        "bodiesCaptured": 1,
        "issues": [],
    })
    manifest = read_json(manifest_path)
    entries = {item["path"]: item for item in manifest["artifacts"]}
    required = {
        "expansion_summary.json",
        "expansion_rounds.json",
        "expansion_frontier.json",
        "users.csv",
        "posts.csv",
        "comments.csv",
        "relations.csv",
        "graph.json",
    }

    assert required <= entries.keys()
    for relative in required:
        assert entries[relative]["sha256"] == workflow.sha256(output / relative)
        assert len(entries[relative]["sha256"]) == 64


def test_independent_workspace_does_not_materialize_audience_compatibility_files(tmp_path):
    output = tmp_path / "independent" / "artifacts"
    summary = collect_expansion(
        output,
        config=config(1),
        adapter=FakeExpansionAdapter(comments_by_post={"seed": [comment("c1", "A")]}, posts_by_user={"A": []}),
        seed_posts=[seed("seed")],
        keyword="fixture",
        attempt_id="independent",
        materialize_audience_compat=False,
    )

    assert summary["status"] == "complete"
    assert (output / "graph.json").exists()
    assert not (output / "audience-summary.json").exists()
    assert not (output / "audience-posts.json").exists()
    assert not (output / "audience-comments.json").exists()
    assert not (output / "audience-users.json").exists()
