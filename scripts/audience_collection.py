from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_UPSTREAM_SCRAPER = PROJECT_ROOT / "vendor/xiaohongshu-relay-scrape/scripts/scrape_xiaohongshu_search.py"
COMMENT_RESPONSE_MARKERS = ("comment/page", "comment/sub", "comment/list", "/comment")
SECURITY_MARKERS = ("安全验证", "请完成验证", "拖动滑块", "滑块验证", "captcha")
RATE_LIMIT_MARKERS = ("访问频繁", "请稍后再试", "error_code=300013")
MORE_REPLY_PATTERN = re.compile(r"(?:展开|查看|更多|显示).{0,12}(?:回复|评论)|(?:回复|评论).{0,12}(?:更多|全部)")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def atomic_json(path: Path, payload: Any) -> None:
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


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


def normalize_user(raw: Any, *, role: str = "commenter") -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    user_id = clean_text(first_value(source, "user_id", "userid", "id", "userId"), 160)
    token = clean_text(first_value(source, "xsec_token", "xsecToken"), 800)
    name = clean_text(first_value(source, "nickname", "nick_name", "name", "display_name"), 200)
    avatar = clean_text(first_value(source, "image", "avatar", "avatar_url", "imageb"), 2000)
    url = clean_text(first_value(source, "profile_url", "user_url", "url"), 2000) or profile_url(user_id, token)
    stable = user_id or hashlib.sha256(f"{name}|{url}".encode("utf-8")).hexdigest()[:24]
    return {
        "user_id": stable,
        "display_name": name or "未命名用户",
        "profile_url": url,
        "avatar_url": avatar,
        "xhs_id": clean_text(first_value(source, "red_id", "xhs_id", "redId"), 200),
        "bio": clean_text(first_value(source, "desc", "description", "bio"), 1000),
        "location": clean_text(first_value(source, "ip_location", "location"), 200),
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
        return incoming
    merged = dict(current)
    for field in (
        "display_name", "profile_url", "avatar_url", "xhs_id", "bio", "location",
        "following_count", "follower_count", "liked_and_collected_count",
    ):
        current_missing = merged.get(field) in (None, "", [], {})
        if field == "display_name" and merged.get(field) == "未命名用户":
            current_missing = True
        if incoming.get(field) not in (None, "", [], {}) and current_missing:
            merged[field] = incoming[field]
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
    return {
        "comment_id": comment_id,
        "post_id": post_id,
        "parent_comment_id": parent,
        "level": "reply" if parent else "comment",
        "text": text,
        "likes": compact_count(first_value(raw, "like_count", "likes", "likeCount")) or 0,
        "publish_time": clean_text(create_time, 200),
        "location": clean_text(first_value(raw, "ip_location", "location"), 200),
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
    identity_fields = ("display_name", "avatar_url", "xhs_id", "bio", "location")
    profile_verified = bool(snapshot.get("profile_loaded")) and any(
        clean_text(snapshot.get(field), 2000) for field in identity_fields
    )
    if not profile_verified:
        merged["enrichment_status"] = "partial"
        merged["access_status"] = "profile_not_verified"
        merged["last_enriched_at"] = utc_now()
        return merged
    for field in identity_fields:
        value = clean_text(snapshot.get(field), 2000 if field == "avatar_url" else 1000)
        if value:
            merged[field] = value
    for field in ("following_count", "follower_count", "liked_and_collected_count"):
        value = compact_count(snapshot.get(field))
        if value is not None:
            merged[field] = value
    merged["enrichment_status"] = "complete"
    merged["access_status"] = "public_profile_ok"
    merged["last_enriched_at"] = utc_now()
    return merged


def _challenge_status(text: str) -> str:
    folded = text.casefold()
    if any(marker.casefold() in folded for marker in RATE_LIMIT_MARKERS):
        return "rate_limited"
    if any(marker.casefold() in folded for marker in SECURITY_MARKERS):
        return "security_verification"
    return ""


def _body_text(page: Any) -> str:
    try:
        return page.locator("body").inner_text(timeout=3000)
    except Exception:  # noqa: BLE001
        return ""


def _wait_for_manual_verification(page: Any, timeout_seconds: int) -> tuple[bool, str]:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        status = _challenge_status(_body_text(page))
        if status == "rate_limited":
            return False, status
        if not status:
            return True, ""
        time.sleep(min(3, max(0.1, deadline - time.monotonic())))
    return False, "security_verification_timeout"


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
          return nodes.map((node, index) => {
            const profile = node.querySelector('a[href*="/user/profile/"]');
            const avatar = node.querySelector('img');
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
                image: avatar?.src || '',
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


def _click_more_replies(page: Any) -> int:
    clicked = 0
    try:
        candidates = page.get_by_text(MORE_REPLY_PATTERN).all()
    except Exception:  # noqa: BLE001
        candidates = []
    for candidate in candidates[:100]:
        try:
            if candidate.is_visible(timeout=200) and candidate.is_enabled(timeout=200):
                candidate.click(timeout=1200)
                clicked += 1
                time.sleep(0.12)
        except Exception:  # noqa: BLE001
            continue
    return clicked


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
          const metric = (labels) => {
            const nodes = [...document.querySelectorAll('[class*="data-info"], [class*="user-interactions"], [class*="count"]')];
            for (const node of nodes) {
              const text = node.textContent?.trim() || '';
              if (labels.some((label) => text.includes(label))) return text.replace(/粉丝|关注|获赞与收藏|获赞和收藏/g, '').trim();
            }
            return '';
          };
          return {
            profile_loaded: location.pathname.includes('/user/profile/'),
            display_name: read(['.user-name', '[class*="user-name"]', '[class*="userName"]', 'h1']),
            avatar_url: document.querySelector('.avatar img, [class*="avatar"] img')?.src || '',
            xhs_id: (allText.match(/小红书号[：:]?\s*([^\s]+)/) || [])[1] || '',
            bio: read(['.user-desc', '[class*="user-desc"]', '[class*="desc"]']),
            location: (allText.match(/(?:IP属地|所在地)[：:]?\s*([^\n]+)/) || [])[1] || '',
            following_count: metric(['关注']),
            follower_count: metric(['粉丝']),
            liked_and_collected_count: metric(['获赞与收藏', '获赞和收藏']),
          };
        }"""
    )


def _post_source(notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    posts: list[dict[str, Any]] = []
    seen: set[str] = set()
    for note in notes:
        post_id = clean_text(first_value(note, "note_id", "id"), 200)
        note_url = clean_text(first_value(note, "note_url", "search_result_url", "explore_url"), 2000)
        if not post_id:
            post_id = hashlib.sha256(note_url.encode("utf-8")).hexdigest()[:24]
        if not note_url or post_id in seen:
            continue
        seen.add(post_id)
        author_name = clean_text(first_value(note, "author", "nickname"), 200)
        author_url = clean_text(first_value(note, "author_profile", "author_url"), 2000)
        author_id = ""
        match = re.search(r"/user/profile/([^/?]+)", author_url)
        if match:
            author_id = match.group(1)
        author = normalize_user({"user_id": author_id, "nickname": author_name, "profile_url": author_url}, role="author")
        posts.append({
            "post_id": post_id,
            "title": clean_text(note.get("title"), 500) or "未命名内容",
            "note_url": note_url,
            "author": author,
            "expected_comment_count": compact_count(first_value(note, "comment_count", "comments")),
        })
    return posts


def _summary(posts: list[dict[str, Any]], comments: list[dict[str, Any]], users: list[dict[str, Any]], stop_reason: str = "") -> dict[str, Any]:
    complete_posts = sum(1 for post in posts if post.get("status") == "complete")
    complete_profiles = sum(1 for user in users if user.get("enrichment_status") == "complete")
    failed_posts = sum(1 for post in posts if post.get("status") == "failed")
    partial_posts = sum(1 for post in posts if post.get("status") == "partial")
    status = "complete" if posts and complete_posts == len(posts) and complete_profiles == len(users) else "partial" if comments or complete_posts else "pending"
    if failed_posts and not comments:
        status = "failed"
    return {
        "schemaVersion": 1,
        "status": status,
        "postsTotal": len(posts),
        "postsComplete": complete_posts,
        "postsPartial": partial_posts,
        "postsFailed": failed_posts,
        "commentsCollected": len(comments),
        "topLevelComments": sum(1 for item in comments if not item.get("parent_comment_id")),
        "repliesCollected": sum(1 for item in comments if item.get("parent_comment_id")),
        "usersDiscovered": len(users),
        "profilesComplete": complete_profiles,
        "postCoveragePercent": round((complete_posts / len(posts)) * 100, 2) if posts else 0,
        "profileCoveragePercent": round((complete_profiles / len(users)) * 100, 2) if users else 0,
        "stopReason": stop_reason,
        "generatedAt": utc_now(),
    }


def collect_audience(
    output_dir: Path,
    *,
    relay_port: int = 18800,
    goto_timeout_ms: int = 15000,
    note_delay_seconds: float = 1.2,
    stable_rounds: int = 5,
    security_verification_timeout_seconds: int = 600,
    upstream_scraper: Path = DEFAULT_UPSTREAM_SCRAPER,
) -> dict[str, Any]:
    output_dir = output_dir.resolve()
    notes_path = output_dir / "xiaohongshu_notes_latest.json"
    comments_path = output_dir / "audience-comments.json"
    users_path = output_dir / "audience-users.json"
    posts_path = output_dir / "audience-posts.json"
    failures_path = output_dir / "audience-failures.json"
    summary_path = output_dir / "audience-summary.json"
    notes = load_json(notes_path, [])
    if not isinstance(notes, list) or not notes:
        raise ValueError("Audience collection requires a non-empty note checkpoint")

    source_posts = _post_source([item for item in notes if isinstance(item, dict)])
    existing_posts = {item.get("post_id"): item for item in load_json(posts_path, []) if isinstance(item, dict) and item.get("post_id")}
    comments_by_id = {item.get("comment_id"): item for item in load_json(comments_path, []) if isinstance(item, dict) and item.get("comment_id")}
    users_by_id = {item.get("user_id"): item for item in load_json(users_path, []) if isinstance(item, dict) and item.get("user_id")}
    failures = [item for item in load_json(failures_path, []) if isinstance(item, dict)]
    posts: list[dict[str, Any]] = []
    for source in source_posts:
        post = {**source, **existing_posts.get(source["post_id"], {})}
        post["author"] = merge_user(existing_posts.get(source["post_id"], {}).get("author"), source["author"])
        post["author"]["post_ids"] = list(dict.fromkeys([*post["author"].get("post_ids", []), post["post_id"]]))
        posts.append(post)
        users_by_id[post["author"]["user_id"]] = merge_user(users_by_id.get(post["author"]["user_id"]), post["author"])

    stop_reason = ""

    def absorb(comment: dict[str, Any]) -> None:
        comments_by_id[comment["comment_id"]] = comment
        user = comment["user"]
        user_id = user["user_id"]
        merged = merge_user(users_by_id.get(user_id), user)
        merged["post_ids"] = list(dict.fromkeys([*merged.get("post_ids", []), comment["post_id"]]))
        users_by_id[user_id] = merged

    def checkpoint() -> dict[str, Any]:
        comments = sorted(comments_by_id.values(), key=lambda item: (item.get("post_id", ""), item.get("collected_at", ""), item.get("comment_id", "")))
        for user in users_by_id.values():
            user["comment_count"] = sum(1 for item in comments if item.get("user", {}).get("user_id") == user.get("user_id"))
        users = sorted(users_by_id.values(), key=lambda item: (-int(item.get("comment_count") or 0), item.get("display_name", "")))
        atomic_json(comments_path, comments)
        atomic_json(users_path, users)
        atomic_json(posts_path, posts)
        atomic_json(failures_path, failures[-1000:])
        summary = _summary(posts, comments, users, stop_reason)
        atomic_json(summary_path, summary)
        return summary

    upstream = load_upstream(upstream_scraper)
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = upstream.connect_browser(playwright, relay_port)
        context = upstream.get_or_create_context(browser)
        page = context.new_page()
        response_payloads: list[Any] = []

        def on_response(response: Any) -> None:
            if not any(marker in response.url.casefold() for marker in COMMENT_RESPONSE_MARKERS):
                return
            try:
                response_payloads.append(response.json())
            except Exception:  # noqa: BLE001
                return

        page.on("response", on_response)
        try:
            for post_index, post in enumerate(posts, start=1):
                if post.get("status") == "complete":
                    continue
                response_payloads.clear()
                before = len([item for item in comments_by_id.values() if item.get("post_id") == post["post_id"]])
                try:
                    page.goto(post["note_url"], wait_until="domcontentloaded", timeout=goto_timeout_ms)
                    page.wait_for_timeout(1200)
                    challenge = _challenge_status(f"{page.url}\n{_body_text(page)}")
                    if challenge == "security_verification":
                        print(
                            f"SECURITY_VERIFICATION detected timeout={security_verification_timeout_seconds}s; audience collection paused",
                            flush=True,
                        )
                        cleared, reason = _wait_for_manual_verification(page, security_verification_timeout_seconds)
                        if not cleared:
                            stop_reason = reason
                            post["status"] = "partial"
                            post["failure_reason"] = reason
                            checkpoint()
                            break
                    elif challenge:
                        stop_reason = challenge
                        post["status"] = "partial"
                        post["failure_reason"] = challenge
                        print("AUDIENCE_RATE_LIMIT detected; checkpoint preserved", flush=True)
                        checkpoint()
                        break

                    unchanged = 0
                    previous_count = -1
                    explicit_exhausted = False
                    for _round in range(200):
                        clicked = _click_more_replies(page)
                        for payload in list(response_payloads):
                            for comment in extract_comments_from_payload(payload, post_id=post["post_id"], note_url=post["note_url"]):
                                absorb(comment)
                        for comment in _dom_comments(page, post["post_id"], post["note_url"]):
                            absorb(comment)
                        current_count = len([item for item in comments_by_id.values() if item.get("post_id") == post["post_id"]])
                        scroll = _scroll_comments(page)
                        page.wait_for_timeout(650)
                        body = _body_text(page)
                        challenge = _challenge_status(f"{page.url}\n{body}")
                        if challenge:
                            stop_reason = challenge
                            break
                        explicit_exhausted = bool(re.search(r"没有更多(?:评论|回复)|已显示全部(?:评论|回复)|到底了", body))
                        if current_count == previous_count and clicked == 0:
                            unchanged += 1
                        else:
                            unchanged = 0
                        previous_count = current_count
                        if explicit_exhausted or unchanged >= stable_rounds:
                            break
                        if scroll.get("height", 0) <= scroll.get("client", 0) and clicked == 0 and unchanged >= 2:
                            break

                    collected = len([item for item in comments_by_id.values() if item.get("post_id") == post["post_id"]])
                    expected = post.get("expected_comment_count")
                    expected_met = expected is not None and collected >= int(expected)
                    unknown_exhausted = expected is None and explicit_exhausted
                    post["collected_comment_count"] = collected
                    post["top_level_count"] = sum(1 for item in comments_by_id.values() if item.get("post_id") == post["post_id"] and not item.get("parent_comment_id"))
                    post["reply_count"] = collected - post["top_level_count"]
                    post["unique_user_count"] = len({item.get("user", {}).get("user_id") for item in comments_by_id.values() if item.get("post_id") == post["post_id"]})
                    post["last_collected_at"] = utc_now()
                    if stop_reason:
                        post["status"] = "partial"
                        post["failure_reason"] = stop_reason
                    elif expected_met:
                        post["status"] = "complete"
                        post["completion_basis"] = "expected_count"
                        post["failure_reason"] = ""
                    elif unknown_exhausted:
                        post["status"] = "complete"
                        post["completion_basis"] = "ui_exhausted"
                        post["failure_reason"] = ""
                    else:
                        post["status"] = "partial"
                        post["completion_basis"] = "checkpoint"
                        post["failure_reason"] = f"expected_{expected}_collected_{collected}" if expected is not None else "comment_list_not_proven_complete"
                    if collected == before and post["status"] != "complete":
                        failures.append({"post_id": post["post_id"], "phase": "comments", "reason": post["failure_reason"], "at": utc_now()})
                    checkpoint()
                    print(
                        f"AUDIENCE_PROGRESS posts={post_index}/{len(posts)} comments={len(comments_by_id)} "
                        f"users={len(users_by_id)} profiles={sum(1 for item in users_by_id.values() if item.get('enrichment_status') == 'complete')}/{len(users_by_id)} phase=comments",
                        flush=True,
                    )
                    if stop_reason:
                        break
                    time.sleep(max(0.0, note_delay_seconds))
                except Exception as error:  # noqa: BLE001
                    post["status"] = "failed"
                    post["failure_reason"] = clean_text(error, 1000)
                    failures.append({"post_id": post["post_id"], "phase": "comments", "reason": post["failure_reason"], "at": utc_now()})
                    checkpoint()

            if not stop_reason:
                pending_users = [item for item in users_by_id.values() if item.get("enrichment_status") != "complete"]
                for profile_index, user in enumerate(pending_users, start=1):
                    if not user.get("profile_url"):
                        user["enrichment_status"] = "partial"
                        user["access_status"] = "profile_url_missing"
                        continue
                    try:
                        page.goto(user["profile_url"], wait_until="domcontentloaded", timeout=goto_timeout_ms)
                        page.wait_for_timeout(800)
                        challenge = _challenge_status(f"{page.url}\n{_body_text(page)}")
                        if challenge:
                            stop_reason = challenge
                            user["enrichment_status"] = "partial"
                            user["access_status"] = challenge
                            print("AUDIENCE_RATE_LIMIT detected during profile enrichment; checkpoint preserved", flush=True)
                            checkpoint()
                            break
                        users_by_id[user["user_id"]] = parse_profile_snapshot(_profile_snapshot(page), user)
                    except Exception as error:  # noqa: BLE001
                        user["enrichment_status"] = "partial"
                        user["access_status"] = "profile_error"
                        user["last_enriched_at"] = utc_now()
                        failures.append({"user_id": user["user_id"], "phase": "profile", "reason": clean_text(error, 1000), "at": utc_now()})
                    checkpoint()
                    print(
                        f"AUDIENCE_PROGRESS posts={len(posts)}/{len(posts)} comments={len(comments_by_id)} "
                        f"users={len(users_by_id)} profiles={profile_index}/{len(pending_users)} phase=profiles",
                        flush=True,
                    )
                    time.sleep(max(0.0, note_delay_seconds))
        finally:
            try:
                page.close()
            except Exception:  # noqa: BLE001
                pass

    summary = checkpoint()
    print(
        f"AUDIENCE_COMPLETE posts={summary['postsComplete']}/{summary['postsTotal']} "
        f"comments={summary['commentsCollected']} users={summary['usersDiscovered']} "
        f"profiles={summary['profilesComplete']}/{summary['usersDiscovered']} status={summary['status']}",
        flush=True,
    )
    return summary


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Collect all visible comments and public audience profiles from note checkpoints.")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--relay-port", type=int, default=18800)
    parser.add_argument("--goto-timeout-ms", type=int, default=15000)
    parser.add_argument("--note-delay-seconds", type=float, default=1.2)
    parser.add_argument("--stable-rounds", type=int, default=5)
    parser.add_argument("--security-verification-timeout-seconds", type=int, default=600)
    parser.add_argument("--upstream-scraper", default=str(DEFAULT_UPSTREAM_SCRAPER))
    options = parser.parse_args(arguments)
    summary = collect_audience(
        Path(options.output_dir),
        relay_port=options.relay_port,
        goto_timeout_ms=options.goto_timeout_ms,
        note_delay_seconds=options.note_delay_seconds,
        stable_rounds=options.stable_rounds,
        security_verification_timeout_seconds=options.security_verification_timeout_seconds,
        upstream_scraper=Path(options.upstream_scraper),
    )
    return 0 if summary["status"] == "complete" else 3


if __name__ == "__main__":
    raise SystemExit(main())
