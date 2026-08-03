from __future__ import annotations

import csv
import hashlib
import json
import re
import sqlite3
import time
from dataclasses import asdict, dataclass, is_dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Protocol

try:
    import audience_collection as audience
    from artifact_io import atomic_write_json
except ModuleNotFoundError:
    from scripts import audience_collection as audience
    from scripts.artifact_io import atomic_write_json


SCHEMA_VERSION = 1
STOP_REASONS = frozenset({
    "rounds_completed", "empty_frontier", "user_budget_reached",
    "post_budget_reached", "comment_budget_reached", "time_budget_reached",
    "failure_budget_reached", "verification_blocked", "user_cancelled",
    "relay_unavailable", "interrupted", "fatal_error",
})
RELATION_TYPES = frozenset({
    "USER_AUTHORED_POST", "USER_COMMENTED_ON_POST", "USER_REPLIED_TO_COMMENT",
    "USER_DISCOVERED_FROM_COMMENT", "POST_DISCOVERED_FROM_USER",
    "USER_DISCOVERED_FROM_POST",
})
COMPLETE_STOP_REASONS = frozenset({"rounds_completed", "empty_frontier"})


def utc_now() -> str:
    return audience.utc_now()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _stable_id(*parts: Any) -> str:
    return hashlib.sha256("|".join(str(part or "") for part in parts).encode("utf-8")).hexdigest()[:32]


@dataclass(frozen=True)
class ExpansionConfig:
    enabled: bool = False
    rounds: int = 0
    include_replies: bool = True
    max_reply_depth: int = 2
    max_users_per_round: int = 20
    max_posts_per_user: int = 3
    max_comments_per_post: int = 100
    max_total_users: int = 250
    max_total_posts: int = 500
    max_total_comments: int = 5000
    time_budget_minutes: int = 30
    max_failure_count: int = 10
    concurrency: int = 1
    post_selection_strategy: str = "latest"
    schema_version: int = SCHEMA_VERSION

    def __post_init__(self) -> None:
        integer_ranges = {
            "rounds": (0, 10), "max_reply_depth": (0, 10),
            "max_users_per_round": (1, 1000), "max_posts_per_user": (1, 100),
            "max_comments_per_post": (1, 5000), "max_total_users": (1, 100000),
            "max_total_posts": (1, 100000), "max_total_comments": (1, 1000000),
            "time_budget_minutes": (1, 1440), "max_failure_count": (1, 1000),
            "concurrency": (1, 1),
            "schema_version": (1, 1),
        }
        for field, (minimum, maximum) in integer_ranges.items():
            value = getattr(self, field)
            if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
                raise ValueError(f"expansion.{field} must be an integer from {minimum} to {maximum}")
        if self.post_selection_strategy not in {"latest", "top_engagement", "keyword_match", "all_reachable"}:
            raise ValueError("expansion.postSelectionStrategy is unsupported")

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ExpansionConfig":
        allowed = {
            "enabled", "rounds", "includeReplies", "maxReplyDepth", "maxUsersPerRound",
            "maxPostsPerUser", "maxCommentsPerPost", "maxTotalUsers", "maxTotalPosts",
            "maxTotalComments", "timeBudgetMinutes", "maxFailureCount", "concurrency",
            "postSelectionStrategy", "schemaVersion",
        }
        unknown = sorted(set(value) - allowed)
        if unknown:
            raise ValueError(f"Unsupported expansion parameters: {', '.join(unknown)}")
        for key in ("enabled", "includeReplies"):
            if key in value and not isinstance(value[key], bool):
                raise ValueError(f"expansion.{key} must be boolean")
        integer_keys = allowed - {"enabled", "includeReplies", "postSelectionStrategy"}
        for key in integer_keys:
            if key in value and (isinstance(value[key], bool) or not isinstance(value[key], int)):
                raise ValueError(f"expansion.{key} must be an integer")
        return cls(
            enabled=bool(value.get("enabled", False)),
            rounds=int(value.get("rounds", 0)),
            include_replies=bool(value.get("includeReplies", True)),
            max_reply_depth=int(value.get("maxReplyDepth", 2)),
            max_users_per_round=int(value.get("maxUsersPerRound", 20)),
            max_posts_per_user=int(value.get("maxPostsPerUser", 3)),
            max_comments_per_post=int(value.get("maxCommentsPerPost", 100)),
            max_total_users=int(value.get("maxTotalUsers", 250)),
            max_total_posts=int(value.get("maxTotalPosts", 500)),
            max_total_comments=int(value.get("maxTotalComments", 5000)),
            time_budget_minutes=int(value.get("timeBudgetMinutes", 30)),
            max_failure_count=int(value.get("maxFailureCount", 10)),
            concurrency=int(value.get("concurrency", 1)),
            post_selection_strategy=str(value.get("postSelectionStrategy", "latest")),
            schema_version=int(value.get("schemaVersion", SCHEMA_VERSION)),
        )

    def public(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "rounds": self.rounds,
            "includeReplies": self.include_replies,
            "maxReplyDepth": self.max_reply_depth,
            "maxUsersPerRound": self.max_users_per_round,
            "maxPostsPerUser": self.max_posts_per_user,
            "maxCommentsPerPost": self.max_comments_per_post,
            "maxTotalUsers": self.max_total_users,
            "maxTotalPosts": self.max_total_posts,
            "maxTotalComments": self.max_total_comments,
            "timeBudgetMinutes": self.time_budget_minutes,
            "maxFailureCount": self.max_failure_count,
            "concurrency": self.concurrency,
            "postSelectionStrategy": self.post_selection_strategy,
            "schemaVersion": self.schema_version,
        }


class ExpansionAdapter(Protocol):
    def open(self) -> None: ...
    def close(self) -> None: ...
    def collect_post_comments(self, post: dict[str, Any], config: ExpansionConfig) -> dict[str, Any]: ...
    def expand_user(self, user: dict[str, Any], config: ExpansionConfig, keyword: str) -> dict[str, Any]: ...


class ExpansionStore:
    """SQLite-backed entity store and paged BFS queue."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.connection = sqlite3.connect(path)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.executescript("""
            CREATE TABLE IF NOT EXISTS entities (
              kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
              PRIMARY KEY (kind, id)
            );
            CREATE TABLE IF NOT EXISTS relations (
              relation_key TEXT PRIMARY KEY, relation_type TEXT NOT NULL,
              from_id TEXT NOT NULL, to_id TEXT NOT NULL, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS frontier (
              round_index INTEGER NOT NULL, user_id TEXT NOT NULL,
              state TEXT NOT NULL, sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              UNIQUE (round_index, user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_frontier_round_state
              ON frontier(round_index, state, sequence);
            CREATE TABLE IF NOT EXISTS rounds (
              round_index INTEGER PRIMARY KEY, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS meta (
              key TEXT PRIMARY KEY, value TEXT NOT NULL
            );
        """)
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()

    def get_meta(self, key: str, default: Any = None) -> Any:
        row = self.connection.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def set_meta(self, key: str, value: Any) -> None:
        self.connection.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, _json(value)),
        )
        self.connection.commit()

    def begin_new_attempt(self) -> None:
        """Reset attempt-local execution state while retaining accumulated entities and relations."""
        meta = {
            "seedPostIds": [],
            "seedInitialized": False,
            "seedRoundCompleted": False,
            "currentRoundIndex": 0,
            "currentOperation": {},
            "lastSuccessfulAtomicOperation": {},
            "failureCount": 0,
            "duplicateUserCount": 0,
            "fatalError": "",
        }
        try:
            self.connection.execute("BEGIN IMMEDIATE")
            self.connection.execute("DELETE FROM frontier")
            self.connection.execute("DELETE FROM rounds")
            self.connection.executemany(
                "INSERT INTO meta(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                ((key, _json(value)) for key, value in meta.items()),
            )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

    def entity(self, kind: str, entity_id: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT payload FROM entities WHERE kind = ? AND id = ?", (kind, entity_id)
        ).fetchone()
        return json.loads(row["payload"]) if row else None

    def upsert_entity(self, kind: str, entity_id: str, payload: dict[str, Any]) -> bool:
        previous = self.entity(kind, entity_id)
        created = previous is None
        merged = {**(previous or {}), **payload, "updatedAt": utc_now()}
        if created:
            merged.setdefault("createdAt", merged["updatedAt"])
        self.connection.execute(
            "INSERT INTO entities(kind, id, payload) VALUES(?, ?, ?) "
            "ON CONFLICT(kind, id) DO UPDATE SET payload=excluded.payload",
            (kind, entity_id, _json(merged)),
        )
        self.connection.commit()
        return created

    def update_entity(self, kind: str, entity_id: str, **changes: Any) -> None:
        current = self.entity(kind, entity_id)
        if current is not None:
            self.upsert_entity(kind, entity_id, {**current, **changes})

    def count(self, kind: str) -> int:
        return int(self.connection.execute(
            "SELECT COUNT(*) AS count FROM entities WHERE kind = ?", (kind,)
        ).fetchone()["count"])

    def ids(self, kind: str, predicate: Callable[[dict[str, Any]], bool] | None = None) -> list[str]:
        rows = self.connection.execute(
            "SELECT id, payload FROM entities WHERE kind = ? ORDER BY id", (kind,)
        )
        if predicate is None:
            return [str(row["id"]) for row in rows]
        return [str(row["id"]) for row in rows if predicate(json.loads(row["payload"]))]

    def entities(self, kind: str, batch_size: int = 250) -> Iterable[dict[str, Any]]:
        cursor = self.connection.execute(
            "SELECT payload FROM entities WHERE kind = ? ORDER BY id", (kind,)
        )
        while rows := cursor.fetchmany(batch_size):
            for row in rows:
                yield json.loads(row["payload"])

    def add_relation(self, relation_type: str, from_id: str, to_id: str, provenance: dict[str, Any]) -> bool:
        if relation_type not in RELATION_TYPES:
            raise ValueError(f"Unsupported expansion relation: {relation_type}")
        relation_key = _stable_id(relation_type, from_id, to_id, _json(provenance))
        payload = {
            "relationId": relation_key,
            "type": relation_type,
            "fromId": from_id,
            "toId": to_id,
            **provenance,
            "createdAt": utc_now(),
        }
        before = self.connection.total_changes
        self.connection.execute(
            "INSERT OR IGNORE INTO relations(relation_key, relation_type, from_id, to_id, payload) VALUES(?, ?, ?, ?, ?)",
            (relation_key, relation_type, from_id, to_id, _json(payload)),
        )
        self.connection.commit()
        return self.connection.total_changes > before

    def relations(self, batch_size: int = 250) -> Iterable[dict[str, Any]]:
        cursor = self.connection.execute("SELECT payload FROM relations ORDER BY relation_key")
        while rows := cursor.fetchmany(batch_size):
            for row in rows:
                yield json.loads(row["payload"])

    def enqueue(self, round_index: int, user_id: str) -> bool:
        before = self.connection.total_changes
        self.connection.execute(
            "INSERT OR IGNORE INTO frontier(round_index, user_id, state) VALUES(?, ?, 'queued')",
            (round_index, user_id),
        )
        self.connection.commit()
        return self.connection.total_changes > before

    def frontier(self, round_index: int, states: tuple[str, ...] = ("queued",), limit: int = 250) -> list[str]:
        placeholders = ",".join("?" for _ in states)
        rows = self.connection.execute(
            f"SELECT user_id FROM frontier WHERE round_index = ? AND state IN ({placeholders}) ORDER BY sequence LIMIT ?",
            (round_index, *states, limit),
        )
        return [str(row["user_id"]) for row in rows]

    def frontier_count(self, round_index: int, states: tuple[str, ...]) -> int:
        placeholders = ",".join("?" for _ in states)
        return int(self.connection.execute(
            f"SELECT COUNT(*) AS count FROM frontier WHERE round_index = ? AND state IN ({placeholders})",
            (round_index, *states),
        ).fetchone()["count"])

    def skip_frontier_overflow(self, round_index: int, states: tuple[str, ...], keep_count: int) -> int:
        placeholders = ",".join("?" for _ in states)
        boundary = self.connection.execute(
            f"SELECT sequence FROM frontier WHERE round_index = ? AND state IN ({placeholders}) "
            "ORDER BY sequence LIMIT 1 OFFSET ?",
            (round_index, *states, keep_count),
        ).fetchone()
        if boundary is None:
            return 0
        skipped = 0
        while True:
            rows = list(self.connection.execute(
                f"SELECT user_id FROM frontier WHERE round_index = ? AND state IN ({placeholders}) "
                "AND sequence >= ? ORDER BY sequence LIMIT 250",
                (round_index, *states, int(boundary["sequence"])),
            ))
            if not rows:
                break
            for row in rows:
                user_id = str(row["user_id"])
                self.update_frontier(round_index, user_id, "skipped_budget")
                self.update_entity("User", user_id, profileStatus="skipped_budget")
                skipped += 1
        return skipped

    def update_frontier(self, round_index: int, user_id: str, state: str) -> None:
        self.connection.execute(
            "UPDATE frontier SET state = ? WHERE round_index = ? AND user_id = ?",
            (state, round_index, user_id),
        )
        self.connection.commit()

    def frontier_rows(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self.connection.execute(
            "SELECT round_index AS roundIndex, user_id AS userId, state, sequence FROM frontier ORDER BY sequence"
        )]

    def frontier_state(self, round_index: int, user_id: str) -> str:
        row = self.connection.execute(
            "SELECT state FROM frontier WHERE round_index = ? AND user_id = ?",
            (round_index, user_id),
        ).fetchone()
        return str(row["state"]) if row else ""

    def save_round(self, round_index: int, summary: dict[str, Any]) -> None:
        self.connection.execute(
            "INSERT INTO rounds(round_index, payload) VALUES(?, ?) "
            "ON CONFLICT(round_index) DO UPDATE SET payload=excluded.payload",
            (round_index, _json(summary)),
        )
        self.connection.commit()

    def round_summaries(self) -> list[dict[str, Any]]:
        return [json.loads(row["payload"]) for row in self.connection.execute(
            "SELECT payload FROM rounds ORDER BY round_index"
        )]


class PlaywrightExpansionAdapter:
    """Production adapter over the existing Relay and audience parser primitives."""

    def __init__(
        self,
        *,
        relay_port: int,
        goto_timeout_ms: int,
        note_delay_seconds: float,
        stable_rounds: int,
        upstream_scraper: Path,
    ):
        self.relay_port = relay_port
        self.goto_timeout_ms = goto_timeout_ms
        self.note_delay_seconds = note_delay_seconds
        self.stable_rounds = stable_rounds
        self.upstream_scraper = upstream_scraper
        self.playwright_manager: Any = None
        self.playwright: Any = None
        self.browser: Any = None
        self.context: Any = None
        self.page: Any = None
        self.upstream: Any = None
        self.response_payloads: list[tuple[str, Any]] = []
        self.deadline_monotonic: float | None = None

    def configure_deadline(self, deadline_monotonic: float) -> None:
        self.deadline_monotonic = deadline_monotonic

    def open(self) -> None:
        from playwright.sync_api import sync_playwright

        try:
            upstream = audience.load_upstream(self.upstream_scraper)
            self.upstream = upstream
            self.playwright_manager = sync_playwright()
            self.playwright = self.playwright_manager.start()
            self.browser = upstream.connect_browser(self.playwright, self.relay_port)
            self.context = upstream.get_or_create_context(self.browser)
            self.page = self.context.new_page()
        except Exception as error:
            raise RuntimeError("Relay unavailable") from error

        def on_response(response: Any) -> None:
            if not any(marker in response.url.casefold() for marker in audience.COMMENT_RESPONSE_MARKERS):
                return
            try:
                self.response_payloads.append((response.url, response.json()))
            except Exception:  # noqa: BLE001
                return

        self.page.on("response", on_response)

    def close(self) -> None:
        try:
            if self.page is not None and not self.page.is_closed():
                self.page.close()
        except Exception:  # noqa: BLE001
            pass
        if self.playwright is not None:
            self.playwright.stop()
            self.playwright = None

    def _open(self, url: str) -> str:
        if self.page is None:
            raise RuntimeError("Relay adapter was not opened")
        self.page.goto(url, wait_until="domcontentloaded", timeout=self.goto_timeout_ms)
        self.page.wait_for_timeout(900)
        challenge = audience._challenge_status(f"{self.page.url}\n{audience._body_text(self.page)}")
        if challenge:
            audience._surface_security_verification(self.page, self.relay_port)
        return challenge

    def collect_post_comments(self, post: dict[str, Any], config: ExpansionConfig) -> dict[str, Any]:
        url = str(post.get("postUrl") or post.get("note_url") or "")
        if not url:
            return self._post_result([], "failed", "post_url_missing", False)
        self.response_payloads.clear()
        challenge = self._open(url)
        if challenge:
            return self._post_result([], "blocked_verification", challenge, True)
        post_patch: dict[str, Any] = {}
        try:
            extracted = self.upstream.extract_note(self.page, {
                "note_id": post["postId"], "title": post.get("title", ""),
                "author": "", "author_profile": "",
            })
            detail = asdict(extracted) if is_dataclass(extracted) else vars(extracted)
            post_patch = {
                "title": str(detail.get("title") or post.get("title") or ""),
                "body": str(detail.get("body") or ""),
                "publishedAt": str(detail.get("publish_time") or ""),
                "engagement": {
                    "likes": audience.compact_count(detail.get("like_count")),
                    "collects": audience.compact_count(detail.get("collect_count")),
                    "comments": audience.compact_count(detail.get("comment_count")),
                },
                "bodyStatus": "succeeded" if detail.get("body") else "partial",
            }
        except Exception:  # noqa: BLE001
            post_patch = {"bodyStatus": "partial"}
        records: dict[str, dict[str, Any]] = {}
        unchanged = 0
        previous_count = -1
        exhausted = False
        for _ in range(200):
            if self.deadline_monotonic is not None and time.monotonic() >= self.deadline_monotonic:
                return self._post_result(list(records.values()), "partial_timeout", "time_budget_reached", True, post_patch)
            clicked = audience._click_more_replies(self.page) if config.include_replies else 0
            for _response_url, payload in list(self.response_payloads):
                for comment in audience.extract_comments_from_payload(payload, post_id=post["postId"], note_url=url):
                    if self._include_comment(comment, config):
                        records[comment["comment_id"]] = comment
            for comment in audience._dom_comments(self.page, post["postId"], url):
                if self._include_comment(comment, config):
                    records[comment["comment_id"]] = comment
            if len(records) >= config.max_comments_per_post:
                ordered = list(records.values())[:config.max_comments_per_post]
                return self._post_result(ordered, "partial_limit", "max_comments_per_post", True, post_patch)
            scroll = audience._scroll_comments(self.page)
            self.page.wait_for_timeout(650)
            challenge = audience._challenge_status(f"{self.page.url}\n{audience._body_text(self.page)}")
            if challenge:
                audience._surface_security_verification(self.page, self.relay_port)
                return self._post_result(list(records.values()), "blocked_verification", challenge, True, post_patch)
            exhausted = audience._comment_api_exhausted(self.response_payloads)
            unchanged = audience._next_stagnant_rounds(previous_count, len(records), unchanged)
            previous_count = len(records)
            if exhausted or unchanged >= self.stable_rounds:
                break
            if scroll.get("height", 0) <= scroll.get("client", 0) and clicked == 0 and unchanged >= 2:
                break
        status = "complete_reachable" if exhausted else "partial_timeout"
        reason = "current_session_reachable_exhausted" if exhausted else "comment_list_not_proven_complete"
        return self._post_result(list(records.values()), status, reason, not exhausted, post_patch)

    @staticmethod
    def _include_comment(comment: dict[str, Any], config: ExpansionConfig) -> bool:
        if not comment.get("parent_comment_id"):
            return True
        if not config.include_replies or config.max_reply_depth == 0:
            return False
        depth = int(comment.get("reply_depth") or comment.get("replyDepth") or 1)
        return depth <= config.max_reply_depth

    @staticmethod
    def _post_result(
        comments: list[dict[str, Any]], status: str, reason: str, has_more: bool,
        post_patch: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "comments": comments,
            "commentStatus": status,
            "commentsAttempted": len(comments),
            "commentsSucceeded": len(comments),
            "repliesAttempted": sum(bool(item.get("parent_comment_id")) for item in comments),
            "repliesSucceeded": sum(bool(item.get("parent_comment_id")) for item in comments),
            "paginationCursor": "",
            "hasMore": has_more,
            "stopReason": reason,
            "postPatch": post_patch or {},
        }

    def expand_user(self, user: dict[str, Any], config: ExpansionConfig, keyword: str) -> dict[str, Any]:
        profile_url = str(user.get("profileUrl") or "")
        if not profile_url:
            return {"status": "failed", "stopReason": "profile_url_missing", "profile": user, "posts": []}
        challenge = self._open(profile_url)
        if challenge:
            return {"status": "blocked", "stopReason": challenge, "profile": user, "posts": []}
        legacy = {
            "user_id": user["userId"], "display_name": user.get("displayName", ""),
            "profile_url": profile_url, "avatar_url": user.get("avatarUrl", ""),
        }
        profile = audience.parse_profile_snapshot(audience._profile_snapshot(self.page), legacy)
        visible_by_url: dict[str, dict[str, Any]] = {}
        unchanged = 0
        for _ in range(30):
            visible = self.page.evaluate(r"""() => [...new Map(
              [...document.querySelectorAll('a[href*="/explore/"],a[href*="/discovery/item/"]')]
                .map((a) => [a.href, {
                  href: a.href,
                  title: (a.querySelector('[class*="title"]')?.textContent || a.getAttribute('title') || a.textContent || '').trim(),
                  engagement: (a.querySelector('[class*="like"], [class*="count"]')?.textContent || '').trim(),
                }])
            ).values()]""")
            before = len(visible_by_url)
            for item in visible if isinstance(visible, list) else []:
                visible_by_url[str(item.get("href") or "")] = item
            unchanged = unchanged + 1 if len(visible_by_url) == before else 0
            if unchanged >= self.stable_rounds or len(visible_by_url) >= config.max_posts_per_user:
                break
            if self.deadline_monotonic is not None and time.monotonic() >= self.deadline_monotonic:
                break
            self.page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            self.page.wait_for_timeout(max(400, round(self.note_delay_seconds * 1000)))
        posts = []
        for raw in visible_by_url.values():
            url = str(raw.get("href") or "")
            match = re.search(r"/(?:explore|discovery/item)/([^/?]+)", url)
            if not match:
                continue
            posts.append({
                "postId": match.group(1),
                "authorUserId": user["userId"],
                "postUrl": url,
                "title": audience.clean_text(raw.get("title"), 500),
                "body": "",
                "publishedAt": "",
                "engagement": audience.compact_count(raw.get("engagement")) or 0,
            })
        if config.post_selection_strategy == "keyword_match" and keyword:
            posts.sort(key=lambda item: keyword.casefold() not in item["title"].casefold())
        elif config.post_selection_strategy == "top_engagement":
            posts.sort(key=lambda item: int(item.get("engagement") or 0), reverse=True)
        selected = posts if config.post_selection_strategy == "all_reachable" else posts[:config.max_posts_per_user]
        return {"status": "completed", "stopReason": "", "profile": profile, "posts": selected[:config.max_posts_per_user]}


class ExpansionOrchestrator:
    def __init__(
        self,
        *,
        output_dir: Path,
        config: ExpansionConfig,
        adapter: ExpansionAdapter,
        seed_posts: list[dict[str, Any]],
        seed_comments_by_post: dict[str, list[dict[str, Any]]] | None = None,
        keyword: str = "",
        attempt_id: str = "",
        progress_callback: Callable[[dict[str, Any]], None] | None = None,
        cancel_requested: Callable[[], bool] | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        materialize_audience_compat: bool = True,
        new_attempt: bool = False,
    ):
        self.output_dir = output_dir
        self.config = config
        self.adapter = adapter
        self.seed_posts = seed_posts
        self.seed_comments_by_post = seed_comments_by_post or {}
        self.keyword = keyword
        self.attempt_id = attempt_id
        self.progress_callback = progress_callback
        self.cancel_requested = cancel_requested or (lambda: False)
        self.monotonic = monotonic
        self.materialize_audience_compat = materialize_audience_compat
        self.new_attempt = new_attempt
        self.started = monotonic()
        self.store = ExpansionStore(output_dir.parent / "expansion-state.sqlite3")
        self.stop_reason = ""
        self.soft_budget_reason = ""
        self.comment_budget_post_ids: set[str] = set()
        self.per_post_budget_post_ids: set[str] = set()
        self.post_comment_counts: dict[str, int] = {}
        self.failures = int(self.store.get_meta("failureCount", 0))
        self.duplicate_users = int(self.store.get_meta("duplicateUserCount", 0))

    def run(self) -> dict[str, Any]:
        try:
            if self.new_attempt:
                self.store.begin_new_attempt()
                self.failures = 0
                self.duplicate_users = 0
            configure_deadline = getattr(self.adapter, "configure_deadline", None)
            if callable(configure_deadline):
                configure_deadline(self.started + self.config.time_budget_minutes * 60)
            self.adapter.open()
            self._initialize_seeds()
            self.store.set_meta("currentRoundIndex", 0)
            self._emit("expansion_round_started", {"roundIndex": 0})
            self._run_seed_round()
            for round_index in range(1, self.config.rounds + 1):
                if self.stop_reason:
                    break
                self.store.set_meta("currentRoundIndex", round_index)
                self._emit("expansion_round_started", {"roundIndex": round_index})
                self._run_user_round(round_index)
            if not self.stop_reason:
                self.stop_reason = self.soft_budget_reason or "rounds_completed"
        except (KeyboardInterrupt, InterruptedError):
            self.stop_reason = "interrupted"
        except Exception as error:  # noqa: BLE001
            self.stop_reason = "relay_unavailable" if "relay" in str(error).casefold() else "fatal_error"
            self.store.set_meta("fatalError", f"{type(error).__name__}: {error}")
        finally:
            try:
                self.adapter.close()
            finally:
                self._checkpoint(self.stop_reason)
                summary = self._export_artifacts()
                self.store.close()
        return summary

    def _initialize_seeds(self) -> None:
        if self.store.get_meta("seedInitialized", False):
            return
        seed_ids: list[str] = []
        for raw in self.seed_posts:
            post = self._normalize_post(raw, round_index=0, seed_post_id=str(raw.get("postId") or raw.get("post_id") or ""))
            if not post["postId"] or not post["postUrl"]:
                continue
            existing_post = self.store.entity("Post", post["postId"])
            if existing_post is None and self.store.count("Post") >= self.config.max_total_posts:
                self.stop_reason = "post_budget_reached"
                break
            if existing_post is None:
                post_patch = post
            else:
                post_patch = {
                    "title": post.get("title") or existing_post.get("title", ""),
                    "postUrl": post.get("postUrl") or existing_post.get("postUrl", ""),
                }
                if self.new_attempt:
                    post_patch.update({
                        "roundIndex": 0,
                        "sourceSeedPostId": post["postId"],
                        "commentStatus": "uncollected",
                        "commentExecutionStatus": "queued",
                        "commentsAttempted": 0,
                        "commentsSucceeded": 0,
                        "repliesAttempted": 0,
                        "repliesSucceeded": 0,
                        "hasMore": False,
                        "stopReason": "",
                        "paginationCursor": "",
                    })
            self.store.upsert_entity("Post", post["postId"], post_patch)
            seed_ids.append(post["postId"])
            author = raw.get("author") if isinstance(raw.get("author"), dict) else {}
            author_id = str(post.get("authorUserId") or "")
            if author_id:
                user = self._normalize_user(
                    {**author, "user_id": author_id}, 0, post["postId"], "", post["postId"]
                )
                if self.store.entity("User", author_id) is None and self.store.count("User") >= self.config.max_total_users:
                    self.stop_reason = "user_budget_reached"
                    break
                self.store.upsert_entity("User", author_id, user)
                self._relation("USER_AUTHORED_POST", author_id, post["postId"], post["postId"], 0, post["postId"], "")
        self.store.set_meta("seedPostIds", seed_ids)
        self.store.set_meta("seedInitialized", True)
        self._checkpoint("")

    def _run_seed_round(self) -> None:
        if self.store.get_meta("seedRoundCompleted", False) or self.stop_reason:
            return
        started = self.monotonic()
        counters_before = self._counts()
        attempted = 0
        crawled = 0
        for post_id in self.store.get_meta("seedPostIds", []):
            if self._must_stop():
                break
            post = self.store.entity("Post", post_id)
            if not post or post.get("commentExecutionStatus") == "succeeded":
                continue
            self._preload_seed_comments(post_id, round_index=0, seed_post_id=post_id)
            attempted += 1
            if self._collect_post(post, round_index=0, seed_post_id=post_id):
                crawled += 1
        round_stop = self.stop_reason or "round_completed"
        self._save_round(0, 0, attempted, crawled, counters_before, started, round_stop)
        if not self.stop_reason:
            self.store.set_meta("seedRoundCompleted", True)
            if self.config.rounds > 0 and not self.store.frontier(1, limit=1):
                self.stop_reason = self.soft_budget_reason or "empty_frontier"
        self._checkpoint(self.stop_reason)

    def _run_user_round(self, round_index: int) -> None:
        recoverable = (
            "queued", "profile_loading", "posts_loading", "comments_loading",
            "partial", "blocked", "cancelled",
        )
        frontier_count = self.store.frontier_count(round_index, recoverable)
        queued = self.store.frontier(
            round_index, states=recoverable, limit=self.config.max_users_per_round
        )
        if not queued:
            self.stop_reason = self.soft_budget_reason or "empty_frontier"
            return
        started = self.monotonic()
        counters_before = self._counts()
        duplicate_before = self.duplicate_users
        selected = queued
        skipped_count = self.store.skip_frontier_overflow(
            round_index, recoverable, self.config.max_users_per_round
        )
        expanded_count = 0
        attempted_posts = 0
        crawled_posts = 0
        blocked_count = 0
        failed_count = 0
        for user_id in selected:
            if self._must_stop():
                break
            user = self.store.entity("User", user_id)
            if not user:
                self.store.update_frontier(round_index, user_id, "failed")
                continue
            frontier_state = self.store.frontier_state(round_index, user_id)
            if user.get("expanded") and frontier_state == "queued":
                self.store.update_frontier(round_index, user_id, "skipped_duplicate")
                self.duplicate_users += 1
                continue
            self.store.update_frontier(round_index, user_id, "profile_loading")
            self.store.update_entity("User", user_id, profileStatus="profile_loading")
            self.store.set_meta("currentOperation", {"roundIndex": round_index, "userId": user_id, "postId": ""})
            self._checkpoint("")
            self._emit("expansion_user_started", {"userId": user_id, "roundIndex": round_index})
            try:
                result = self.adapter.expand_user(user, self.config, self.keyword)
            except (KeyboardInterrupt, InterruptedError):
                raise
            except Exception as error:  # noqa: BLE001
                if self._is_relay_error(error):
                    self.stop_reason = "relay_unavailable"
                    self.store.update_frontier(round_index, user_id, "partial")
                    self.store.update_entity("User", user_id, profileStatus="partial")
                    break
                result = {
                    "status": "failed", "profile": {}, "posts": [],
                    "stopReason": f"adapter_{type(error).__name__}",
                }
            status = str(result.get("status") or "failed")
            if status == "blocked":
                blocked_count += 1
                self.store.update_frontier(round_index, user_id, "blocked")
                self.store.update_entity("User", user_id, profileStatus="blocked")
                self.stop_reason = "verification_blocked"
                self._emit("expansion_blocked", {"userId": user_id, "roundIndex": round_index})
                break
            if status != "completed":
                failed_count += 1
                self._failure()
                self.store.update_frontier(round_index, user_id, "failed")
                self.store.update_entity("User", user_id, profileStatus="failed", expanded=True, expandedRound=round_index)
                self.store.set_meta("lastSuccessfulAtomicOperation", {
                    "kind": "user", "id": user_id, "roundIndex": round_index,
                    "status": "failed",
                })
                self.store.set_meta("currentOperation", {})
                self._checkpoint(self.stop_reason)
                self._emit("expansion_user_completed", {
                    "userId": user_id, "roundIndex": round_index, "state": "failed",
                })
                continue
            profile = result.get("profile") if isinstance(result.get("profile"), dict) else {}
            self.store.update_entity(
                "User", user_id,
                displayName=profile.get("display_name") or user.get("displayName", ""),
                avatarUrl=profile.get("avatar_url") or user.get("avatarUrl", ""),
                profileStatus=profile.get("enrichment_status") or "completed",
                expanded=True, expandedRound=round_index,
            )
            expanded_count += 1
            self.store.update_frontier(round_index, user_id, "posts_loading")
            posts = result.get("posts") if isinstance(result.get("posts"), list) else []
            for raw_post in posts[:self.config.max_posts_per_user]:
                if self._must_stop():
                    break
                post = self._normalize_post(raw_post, round_index=round_index, seed_post_id=user.get("sourceSeedPostId", ""), source_user_id=user_id)
                if not post["postId"]:
                    continue
                existing_post = self.store.entity("Post", post["postId"])
                if existing_post is None and self.store.count("Post") >= self.config.max_total_posts:
                    self._set_soft_budget("post_budget_reached")
                    continue
                self.store.upsert_entity("Post", post["postId"], post if existing_post is None else {
                    "title": post.get("title") or existing_post.get("title", ""),
                    "postUrl": post.get("postUrl") or existing_post.get("postUrl", ""),
                    "engagement": post.get("engagement") or existing_post.get("engagement", {}),
                })
                self._relation("POST_DISCOVERED_FROM_USER", user_id, post["postId"], user.get("sourceSeedPostId", ""), round_index, post["postId"], "")
                self._relation("USER_AUTHORED_POST", user_id, post["postId"], user.get("sourceSeedPostId", ""), round_index, post["postId"], "")
                attempted_posts += 1
                self.store.update_frontier(round_index, user_id, "comments_loading")
                if self._collect_post(post, round_index=round_index, seed_post_id=user.get("sourceSeedPostId", "")):
                    crawled_posts += 1
            final_state = (
                "completed" if not self.stop_reason
                else "cancelled" if self.stop_reason == "user_cancelled"
                else "partial"
            )
            self.store.update_frontier(round_index, user_id, final_state)
            self.store.update_entity("User", user_id, profileStatus=final_state)
            self.store.set_meta("lastSuccessfulAtomicOperation", {"kind": "user", "id": user_id, "roundIndex": round_index})
            self.store.set_meta("currentOperation", {})
            self._checkpoint(self.stop_reason)
            self._emit("expansion_user_completed", {"userId": user_id, "roundIndex": round_index, "state": final_state})
        round_stop = self.stop_reason or self.soft_budget_reason or ("round_user_budget_reached" if skipped_count else "round_completed")
        self._save_round(
            round_index, frontier_count, attempted_posts, crawled_posts, counters_before,
            started, round_stop, expanded_count, blocked_count, failed_count, duplicate_before,
        )
        self._checkpoint(self.stop_reason)

    def _collect_post(self, post: dict[str, Any], *, round_index: int, seed_post_id: str) -> bool:
        post_id = post["postId"]
        existing = self.store.entity("Post", post_id) or post
        if existing.get("commentExecutionStatus") == "succeeded":
            return True
        self.store.update_entity("Post", post_id, commentExecutionStatus="attempted", commentStatus="not_attempted")
        self.store.set_meta("currentOperation", {"roundIndex": round_index, "userId": "", "postId": post_id})
        self._checkpoint("")
        try:
            result = self.adapter.collect_post_comments(existing, self.config)
        except (KeyboardInterrupt, InterruptedError):
            raise
        except Exception as error:  # noqa: BLE001
            if self._is_relay_error(error):
                self.stop_reason = "relay_unavailable"
            result = {
                "comments": [], "commentStatus": "failed", "hasMore": True,
                "stopReason": self.stop_reason or f"adapter_{type(error).__name__}",
            }
        comments = result.get("comments") if isinstance(result.get("comments"), list) else []
        status = str(result.get("commentStatus") or "failed")
        if len(comments) > self.config.max_comments_per_post:
            comments = comments[:self.config.max_comments_per_post]
            status = "partial_limit"
            result = {**result, "stopReason": "max_comments_per_post", "hasMore": True}
        post_patch = result.get("postPatch") if isinstance(result.get("postPatch"), dict) else {}
        if post_patch:
            self.store.update_entity("Post", post_id, **post_patch)
        absorbed = 0
        for raw in comments:
            if self._absorb_comment(raw, post_id, round_index, seed_post_id):
                absorbed += 1
            if self.stop_reason:
                break
        if post_id in self.comment_budget_post_ids:
            status = "partial_limit"
            result = {**result, "stopReason": "max_total_comments", "hasMore": True}
        elif post_id in self.per_post_budget_post_ids:
            status = "partial_limit"
            result = {**result, "stopReason": "max_comments_per_post", "hasMore": True}
        execution = (
            "succeeded" if status == "complete_reachable"
            else "blocked" if status == "blocked_verification"
            else "failed" if status == "failed"
            else "cancelled" if status == "partial_cancelled"
            else "partial"
        )
        self.store.update_entity(
            "Post", post_id,
            commentStatus=status,
            commentExecutionStatus=execution,
            commentsAttempted=max(
                int(existing.get("commentsAttempted") or 0),
                int(result.get("commentsAttempted") or len(comments)),
            ),
            commentsSucceeded=self._comment_count_for_post(post_id),
            repliesAttempted=int(result.get("repliesAttempted") or 0),
            repliesSucceeded=int(result.get("repliesSucceeded") or 0),
            paginationCursor=str(result.get("paginationCursor") or ""),
            hasMore=bool(result.get("hasMore", False)),
            stopReason=str(result.get("stopReason") or ""),
        )
        if status == "blocked_verification":
            self.stop_reason = "verification_blocked"
        elif str(result.get("stopReason") or "") == "time_budget_reached":
            self.stop_reason = "time_budget_reached"
        elif status == "failed":
            self._failure()
        self.store.set_meta("lastSuccessfulAtomicOperation", {"kind": "post", "id": post_id, "roundIndex": round_index})
        self.store.set_meta("currentOperation", {})
        self._checkpoint(self.stop_reason)
        self._emit("expansion_post_completed", {"postId": post_id, "roundIndex": round_index, "status": status})
        return execution == "succeeded"

    def _absorb_comment(self, raw: dict[str, Any], post_id: str, round_index: int, seed_post_id: str) -> bool:
        user_raw = raw.get("user") if isinstance(raw.get("user"), dict) else {}
        user_id = str(user_raw.get("user_id") or user_raw.get("userId") or "")
        comment_id = str(raw.get("comment_id") or raw.get("commentId") or "") or _stable_id(post_id, user_id, raw.get("text"))
        parent_id = str(raw.get("parent_comment_id") or raw.get("parentCommentId") or "")
        comment = {
            "commentId": comment_id, "postId": post_id, "userId": user_id,
            "parentCommentId": parent_id, "content": str(raw.get("text") or raw.get("content") or ""),
            "publishedAt": str(raw.get("publish_time") or raw.get("publishedAt") or ""),
            "round": round_index, "sourceSeedPostId": seed_post_id,
        }
        existing_comment = self.store.entity("Comment", comment_id)
        if existing_comment is None and self._comment_count_for_post(post_id) >= self.config.max_comments_per_post:
            self.per_post_budget_post_ids.add(post_id)
            return False
        if existing_comment is None and self.store.count("Comment") >= self.config.max_total_comments:
            self.comment_budget_post_ids.add(post_id)
            self._set_soft_budget("comment_budget_reached")
            return False
        self.store.upsert_entity("Comment", comment_id, comment if existing_comment is None else {
            "content": comment.get("content") or existing_comment.get("content", ""),
            "publishedAt": comment.get("publishedAt") or existing_comment.get("publishedAt", ""),
        })
        if existing_comment is None:
            self.post_comment_counts[post_id] = self._comment_count_for_post(post_id) + 1
        if not user_id:
            return True
        existing = self.store.entity("User", user_id)
        user = self._normalize_user(user_raw, round_index, post_id, comment_id, seed_post_id)
        if existing is None and self.store.count("User") >= self.config.max_total_users:
            self._set_soft_budget("user_budget_reached")
            return True
        if existing is None:
            created = self.store.upsert_entity("User", user_id, user)
        else:
            created = False
            self.store.update_entity(
                "User", user_id,
                displayName=user.get("displayName") or existing.get("displayName", ""),
                profileUrl=user.get("profileUrl") or existing.get("profileUrl", ""),
                avatarUrl=user.get("avatarUrl") or existing.get("avatarUrl", ""),
            )
        if not created:
            self.duplicate_users += 1
        provenance = (seed_post_id, round_index, post_id, comment_id)
        self._relation("USER_COMMENTED_ON_POST", user_id, post_id, *provenance)
        self._relation("USER_DISCOVERED_FROM_COMMENT", user_id, comment_id, *provenance)
        self._relation("USER_DISCOVERED_FROM_POST", user_id, post_id, *provenance)
        if parent_id:
            self._relation("USER_REPLIED_TO_COMMENT", user_id, parent_id, *provenance)
        current = existing or user
        if (
            round_index < self.config.rounds
            and not current.get("expanded")
            and user.get("profileUrl")
        ):
            self.store.enqueue(round_index + 1, user_id)
        return True

    def _preload_seed_comments(self, post_id: str, *, round_index: int, seed_post_id: str) -> None:
        comments = self.seed_comments_by_post.get(post_id, [])
        if not comments:
            return
        for raw in comments:
            self._absorb_comment(raw, post_id, round_index, seed_post_id)
            if self.stop_reason:
                break
        current = self.store.entity("Post", post_id) or {}
        self.store.update_entity(
            "Post", post_id,
            commentsAttempted=max(int(current.get("commentsAttempted") or 0), len(comments)),
            commentsSucceeded=self._comment_count_for_post(post_id),
        )
        self._emit("expansion_seed_comments_preloaded", {
            "postId": post_id,
            "available": len(comments),
            "imported": self._comment_count_for_post(post_id),
        })

    def _comment_count_for_post(self, post_id: str) -> int:
        cached = self.post_comment_counts.get(post_id)
        if cached is not None:
            return cached
        count = len(self.store.ids("Comment", lambda item: str(item.get("postId") or "") == post_id))
        self.post_comment_counts[post_id] = count
        return count

    def _set_soft_budget(self, reason: str) -> None:
        if not self.soft_budget_reason:
            self.soft_budget_reason = reason

    def _normalize_user(self, raw: dict[str, Any], round_index: int, post_id: str, comment_id: str, seed_post_id: str) -> dict[str, Any]:
        normalized = audience.normalize_user(raw)
        return {
            "userId": normalized["user_id"], "displayName": normalized.get("display_name", ""),
            "profileUrl": normalized.get("profile_url", ""), "avatarUrl": normalized.get("avatar_url", ""),
            "firstDiscoveredRound": round_index, "discoveredFromPostId": post_id,
            "discoveredFromCommentId": comment_id, "sourceSeedPostId": seed_post_id,
            "profileStatus": "queued", "profileCursor": "", "postCursor": "",
            "expanded": False, "expandedRound": None,
        }

    def _normalize_post(self, raw: dict[str, Any], *, round_index: int, seed_post_id: str, source_user_id: str = "") -> dict[str, Any]:
        post_id = str(raw.get("postId") or raw.get("post_id") or "")
        url = str(raw.get("postUrl") or raw.get("note_url") or "")
        author = raw.get("author") if isinstance(raw.get("author"), dict) else {}
        author_id = str(raw.get("authorUserId") or author.get("user_id") or "")
        return {
            "postId": post_id, "authorUserId": author_id, "postUrl": url,
            "title": str(raw.get("title") or ""), "body": str(raw.get("body") or ""),
            "publishedAt": str(raw.get("publishedAt") or raw.get("publish_time") or ""),
            "engagement": raw.get("engagement") or {}, "firstDiscoveredRound": round_index,
            "discoveredFromUserId": source_user_id, "sourceSeedPostId": seed_post_id,
            "bodyStatus": "succeeded" if raw.get("body") else "not_attempted",
            "commentStatus": "not_attempted", "commentExecutionStatus": "queued",
            "commentsAttempted": 0, "commentsSucceeded": 0, "repliesAttempted": 0,
            "repliesSucceeded": 0, "paginationCursor": "", "hasMore": True, "stopReason": "",
        }

    def _relation(self, relation_type: str, from_id: str, to_id: str, seed_post_id: str, round_index: int, source_post_id: str, source_comment_id: str) -> None:
        self.store.add_relation(relation_type, from_id, to_id, {
            "sourceSeedPostId": seed_post_id, "round": round_index,
            "sourcePostId": source_post_id, "sourceCommentId": source_comment_id,
        })

    def _failure(self) -> None:
        self.failures += 1
        self.store.set_meta("failureCount", self.failures)
        if self.failures >= self.config.max_failure_count:
            self.stop_reason = "failure_budget_reached"

    @staticmethod
    def _is_relay_error(error: Exception) -> bool:
        message = str(error).casefold()
        return any(marker in message for marker in (
            "relay", "econnrefused", "connection refused", "target page, context or browser has been closed",
        ))

    def _must_stop(self) -> bool:
        if self.stop_reason:
            return True
        if self.cancel_requested():
            self.stop_reason = "user_cancelled"
            self._mark_current_cancelled()
        elif self.monotonic() - self.started >= self.config.time_budget_minutes * 60:
            self.stop_reason = "time_budget_reached"
        elif self.failures >= self.config.max_failure_count:
            self.stop_reason = "failure_budget_reached"
        return bool(self.stop_reason)

    def _mark_current_cancelled(self) -> None:
        operation = self.store.get_meta("currentOperation", {})
        round_index = int(operation.get("roundIndex") or 0)
        post_id = str(operation.get("postId") or "")
        user_id = str(operation.get("userId") or "")
        if post_id and self.store.entity("Post", post_id):
            self.store.update_entity(
                "Post", post_id,
                commentStatus="partial_cancelled",
                commentExecutionStatus="cancelled",
                hasMore=True,
                stopReason="user_cancelled",
            )
        if user_id and self.store.entity("User", user_id):
            self.store.update_frontier(round_index, user_id, "cancelled")
            self.store.update_entity("User", user_id, profileStatus="cancelled")

    def _counts(self) -> dict[str, int]:
        return {
            "users": self.store.count("User"), "posts": self.store.count("Post"),
            "comments": self.store.count("Comment"),
            "expandedUsers": len(self.store.ids("User", lambda item: bool(item.get("expanded")))),
            "crawledPosts": len(self.store.ids("Post", lambda item: item.get("commentExecutionStatus") == "succeeded")),
        }

    def _save_round(
        self,
        round_index: int,
        frontier_count: int,
        attempted_posts: int,
        crawled_posts: int,
        before: dict[str, int],
        started: float,
        stop_reason: str,
        expanded_count: int = 0,
        blocked_count: int = 0,
        failed_count: int = 0,
        duplicate_before: int = 0,
    ) -> None:
        after = self._counts()
        summary = {
            "roundIndex": round_index, "frontierUserCount": frontier_count,
            "expandedUserCount": expanded_count, "discoveredPostCount": after["posts"] - before["posts"],
            "attemptedPostCount": attempted_posts, "crawledPostCount": crawled_posts,
            "discoveredCommentCount": after["comments"] - before["comments"],
            "discoveredNewUserCount": after["users"] - before["users"],
            "duplicateUserCount": self.duplicate_users - duplicate_before,
            "blockedUserCount": blocked_count,
            "failedUserCount": failed_count, "durationMs": round((self.monotonic() - started) * 1000, 2),
            "stopReason": stop_reason,
        }
        self.store.save_round(round_index, summary)
        self._emit("expansion_round_completed", summary)

    def _checkpoint(self, stop_reason: str) -> None:
        self.store.set_meta("failureCount", self.failures)
        self.store.set_meta("duplicateUserCount", self.duplicate_users)
        frontier_rows = self.store.frontier_rows()
        operation = self.store.get_meta("currentOperation", {})
        current_round = int(operation.get("roundIndex") or self.store.get_meta("currentRoundIndex", 0))
        users = list(self.store.entities("User"))
        checkpoint = {
            "schemaVersion": SCHEMA_VERSION,
            "roundIndex": current_round,
            "currentFrontier": [item for item in frontier_rows if item["roundIndex"] == current_round],
            "nextFrontier": [
                item for item in frontier_rows
                if item["roundIndex"] == current_round + 1 and item["state"] == "queued"
            ],
            "discoveredUserIds": self.store.ids("User"),
            "expandedUserIds": self.store.ids("User", lambda item: bool(item.get("expanded"))),
            "discoveredPostIds": self.store.ids("Post"),
            "crawledPostIds": self.store.ids("Post", lambda item: item.get("commentExecutionStatus") == "succeeded"),
            "discoveredCommentIds": self.store.ids("Comment"),
            "budgetCounters": self._counts(),
            "userProfileCursors": {
                item["userId"]: item.get("profileCursor", "") for item in users
            },
            "userPostCursors": {
                item["userId"]: item.get("postCursor", "") for item in users
            },
            "commentPaginationCursors": {
                item["postId"]: item.get("paginationCursor", "") for item in self.store.entities("Post")
            },
            "currentOperation": operation,
            "lastSuccessfulAtomicOperation": self.store.get_meta("lastSuccessfulAtomicOperation", {}),
            "stopReason": stop_reason, "attemptId": self.attempt_id, "updatedAt": utc_now(),
        }
        atomic_write_json(self.output_dir / "expansion_frontier.json", checkpoint)
        progress = self._summary(stop_reason)
        self._emit("expansion_frontier_updated", {
            "roundIndex": current_round,
            "completedRounds": progress["completedRounds"],
            "frontierCount": progress["frontierCount"],
            "stopReason": stop_reason,
            "status": progress["status"],
            "counters": progress["counters"],
        })
        if self.progress_callback:
            self.progress_callback({
                "posts": self._audience_posts(), "users": self._audience_users(),
                "summary": progress,
                "status": "completed" if stop_reason in COMPLETE_STOP_REASONS else "running",
                "lastCheckpointAt": checkpoint["updatedAt"],
            })

    def _summary(self, stop_reason: str) -> dict[str, Any]:
        counts = self._counts()
        partial_posts = sum(
            item.get("commentExecutionStatus") in {"partial", "blocked"}
            for item in self.store.entities("Post")
        )
        pending_posts = sum(item.get("commentExecutionStatus") == "queued" for item in self.store.entities("Post"))
        failed_posts = sum(item.get("commentExecutionStatus") == "failed" for item in self.store.entities("Post"))
        attempted_posts = sum(item.get("commentExecutionStatus") != "queued" for item in self.store.entities("Post"))
        posts_with_comments = sum(int(item.get("commentsSucceeded") or 0) > 0 for item in self.store.entities("Post"))
        comments = list(self.store.entities("Comment"))
        status = "complete" if (
            stop_reason in COMPLETE_STOP_REASONS
            and partial_posts == 0
            and pending_posts == 0
            and failed_posts == 0
            and self.failures == 0
        ) else "partial"
        frontier_rows = self.store.frontier_rows()
        active_frontier = sum(item["state"] not in {"completed", "skipped_duplicate", "skipped_budget", "failed"} for item in frontier_rows)
        complete_profiles = len(self.store.ids(
            "User", lambda item: item.get("profileStatus") == "completed"
        ))
        generated_at = utc_now()
        return {
            "schemaVersion": SCHEMA_VERSION, "status": status, "enabled": True,
            "attemptId": self.attempt_id,
            "seedPostIds": self.store.get_meta("seedPostIds", []),
            "config": self.config.public(),
            "maxRounds": self.config.rounds, "completedRounds": max(0, len(self.store.round_summaries()) - 1),
            "stopReason": stop_reason, "budgets": self.config.public(), "counters": counts,
            "postsTotal": counts["posts"], "postsComplete": counts["crawledPosts"],
            "postsPending": pending_posts, "postsPartial": partial_posts, "postsFailed": failed_posts,
            "postsAttempted": attempted_posts, "postsWithComments": posts_with_comments,
            "commentsCollected": counts["comments"], "usersDiscovered": counts["users"],
            "profilesComplete": complete_profiles,
            "profilesFailed": len(self.store.ids(
                "User", lambda item: item.get("profileStatus") == "failed"
            )),
            "frontierCount": active_frontier,
            "failureCount": self.failures, "duplicateUserCount": self.duplicate_users,
            "topLevelComments": sum(not item.get("parentCommentId") for item in comments),
            "repliesCollected": sum(bool(item.get("parentCommentId")) for item in comments),
            "postCoveragePercent": round((counts["crawledPosts"] / counts["posts"]) * 100, 2) if counts["posts"] else 0,
            "postAttemptPercent": round((attempted_posts / counts["posts"]) * 100, 2) if counts["posts"] else 0,
            "profileCoveragePercent": round((complete_profiles / counts["users"]) * 100, 2) if counts["users"] else 0,
            "effectiveConcurrency": 1, "updatedAt": generated_at, "generatedAt": generated_at,
        }

    def _export_artifacts(self) -> dict[str, Any]:
        summary = self._summary(self.stop_reason)
        users = list(self.store.entities("User"))
        posts = list(self.store.entities("Post"))
        comments = list(self.store.entities("Comment"))
        relations = list(self.store.relations())
        rounds = self.store.round_summaries()
        atomic_write_json(self.output_dir / "expansion_summary.json", summary)
        atomic_write_json(self.output_dir / "expansion_rounds.json", rounds)
        atomic_write_json(self.output_dir / "graph.json", {
            "nodes": [*[{"type": "User", **item} for item in users], *[{"type": "Post", **item} for item in posts], *[{"type": "Comment", **item} for item in comments]],
            "edges": relations, "seedPostIds": self.store.get_meta("seedPostIds", []),
            "maxRounds": self.config.rounds, "completedRounds": max(0, len(rounds) - 1),
            "stopReason": self.stop_reason, "budgets": self.config.public(),
            "counters": self._counts(), "schemaVersion": SCHEMA_VERSION,
        })
        self._write_csv(self.output_dir / "users.csv", users)
        self._write_csv(self.output_dir / "posts.csv", posts)
        self._write_csv(self.output_dir / "comments.csv", comments)
        self._write_csv(self.output_dir / "relations.csv", relations)
        if self.materialize_audience_compat:
            atomic_write_json(self.output_dir / "audience-users.json", self._audience_users())
            atomic_write_json(self.output_dir / "audience-posts.json", self._audience_posts())
            atomic_write_json(self.output_dir / "audience-comments.json", [self._audience_comment(item) for item in comments])
            atomic_write_json(self.output_dir / "audience-failures.json", [])
            atomic_write_json(self.output_dir / "audience-summary.json", summary)
        return summary

    @staticmethod
    def _write_csv(path: Path, records: list[dict[str, Any]]) -> None:
        fields = sorted({key for record in records for key in record}) or ["id"]
        temporary = path.with_name(f".{path.name}.tmp")
        with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            for record in records:
                writer.writerow({key: _json(value) if isinstance(value, (dict, list)) else value for key, value in record.items()})
        temporary.replace(path)

    def _audience_users(self) -> list[dict[str, Any]]:
        return [{
            "user_id": item["userId"], "display_name": item.get("displayName", ""),
            "profile_url": item.get("profileUrl", ""), "avatar_url": item.get("avatarUrl", ""),
            "roles": ["commenter"], "comment_count": 0, "post_ids": [],
            "enrichment_status": "complete" if item.get("expanded") else "pending",
            "access_status": item.get("profileStatus", ""), "last_enriched_at": item.get("updatedAt", ""),
        } for item in self.store.entities("User")]

    def _audience_posts(self) -> list[dict[str, Any]]:
        return [{
            "post_id": item["postId"], "title": item.get("title", ""), "note_url": item.get("postUrl", ""),
            "status": "complete" if item.get("commentStatus") == "complete_reachable" else "partial",
            "collected_comment_count": item.get("commentsSucceeded", 0),
            "reply_count": item.get("repliesSucceeded", 0), "failure_reason": item.get("stopReason", ""),
            "last_collected_at": item.get("updatedAt", ""),
        } for item in self.store.entities("Post")]

    @staticmethod
    def _audience_comment(item: dict[str, Any]) -> dict[str, Any]:
        return {
            "comment_id": item["commentId"], "post_id": item["postId"],
            "parent_comment_id": item.get("parentCommentId", ""), "text": item.get("content", ""),
            "publish_time": item.get("publishedAt", ""),
            "user": {"user_id": item.get("userId", "")}, "collected_at": item.get("updatedAt", ""),
        }

    @staticmethod
    def _emit(event: str, payload: dict[str, Any]) -> None:
        print(f"EXPANSION_EVENT {event} {_json(payload)}", flush=True)


def _seed_posts(output_dir: Path, checkpoint_dirs: Iterable[str | Path]) -> list[dict[str, Any]]:
    resolved = [Path(item).resolve() for item in checkpoint_dirs]
    notes = [item for item in audience.load_json(output_dir / "xiaohongshu_notes_latest.json", []) if isinstance(item, dict)]
    records = audience._load_content_insight_records(output_dir, resolved, notes)
    return [
        {
            "postId": item.get("post_id", ""), "postUrl": item.get("note_url", ""),
            "title": item.get("title", ""), "author": item.get("author", {}),
        }
        for item in audience._post_source(records)
    ]


def collect_expansion(
    output_dir: Path,
    *,
    config: dict[str, Any],
    checkpoint_dirs: Iterable[str | Path] = (),
    attempt_id: str = "",
    keyword: str = "",
    relay_port: int = 18800,
    goto_timeout_ms: int = 15000,
    note_delay_seconds: float = 1.2,
    stable_rounds: int = 5,
    upstream_scraper: Path = audience.DEFAULT_UPSTREAM_SCRAPER,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    cancel_requested: Callable[[], bool] | None = None,
    adapter: ExpansionAdapter | None = None,
    seed_posts: list[dict[str, Any]] | None = None,
    seed_comments_by_post: dict[str, list[dict[str, Any]]] | None = None,
    monotonic: Callable[[], float] = time.monotonic,
    materialize_audience_compat: bool = True,
    new_attempt: bool = False,
) -> dict[str, Any]:
    expansion = ExpansionConfig.from_dict(config)
    if not expansion.enabled:
        raise ValueError("Expansion collection requires enabled=true")
    output_dir.mkdir(parents=True, exist_ok=True)
    production_adapter = adapter or PlaywrightExpansionAdapter(
        relay_port=relay_port, goto_timeout_ms=goto_timeout_ms,
        note_delay_seconds=note_delay_seconds, stable_rounds=stable_rounds,
        upstream_scraper=upstream_scraper,
    )
    orchestrator = ExpansionOrchestrator(
        output_dir=output_dir, config=expansion, adapter=production_adapter,
        seed_posts=seed_posts if seed_posts is not None else _seed_posts(output_dir, checkpoint_dirs),
        seed_comments_by_post=seed_comments_by_post,
        keyword=keyword, attempt_id=attempt_id, progress_callback=progress_callback,
        cancel_requested=cancel_requested, monotonic=monotonic,
        materialize_audience_compat=materialize_audience_compat,
        new_attempt=new_attempt,
    )
    return orchestrator.run()
