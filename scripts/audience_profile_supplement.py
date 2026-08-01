from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any, Callable

try:
    from artifact_io import atomic_write_json
    from audience_collection import (
        DEFAULT_UPSTREAM_SCRAPER,
        _body_text,
        _challenge_status,
        _profile_snapshot,
        _show_verification_notification,
        _surface_security_verification,
        _wait_for_manual_verification,
        _wait_for_rate_limit_recovery,
        clean_text,
        load_json,
        load_upstream,
        parse_profile_snapshot,
        utc_now,
    )
except ModuleNotFoundError:
    from scripts.artifact_io import atomic_write_json
    from scripts.audience_collection import (
        DEFAULT_UPSTREAM_SCRAPER,
        _body_text,
        _challenge_status,
        _profile_snapshot,
        _show_verification_notification,
        _surface_security_verification,
        _wait_for_manual_verification,
        _wait_for_rate_limit_recovery,
        clean_text,
        load_json,
        load_upstream,
        parse_profile_snapshot,
        utc_now,
    )


EVENT_PREFIX = "AUDIENCE_PROFILE_EVENT "
SUPPORTED_MODES = {"collect_missing_header", "recent_public_posts"}


class SupplementRequestError(ValueError):
    pass


def emit(event: dict[str, Any]) -> None:
    print(f"{EVENT_PREFIX}{json.dumps(event, ensure_ascii=False, separators=(',', ':'))}", flush=True)


def load_request(path: Path) -> dict[str, Any]:
    payload = load_json(path, None)
    if not isinstance(payload, dict):
        raise SupplementRequestError("Supplement request must be a JSON object")
    required = ("jobId", "postId", "runId", "outputDir", "profileMode")
    missing = [field for field in required if not clean_text(payload.get(field), 4000)]
    if missing:
        raise SupplementRequestError(f"Missing supplement request fields: {', '.join(missing)}")
    if payload["profileMode"] not in SUPPORTED_MODES:
        raise SupplementRequestError("Unsupported supplement profileMode")
    output_dir = Path(str(payload["outputDir"])).resolve()
    if not output_dir.is_dir():
        raise SupplementRequestError(f"Audience output directory was not found: {output_dir}")
    payload["outputDir"] = str(output_dir)
    payload["profileUserLimit"] = bounded_integer(payload.get("profileUserLimit"), 1, 2000, 100)
    payload["profilePostLimitPerUser"] = bounded_integer(payload.get("profilePostLimitPerUser"), 0, 20, 0)
    payload["profilePostTotalLimit"] = bounded_integer(payload.get("profilePostTotalLimit"), 0, 2000, 0)
    if payload["profileMode"] == "recent_public_posts":
        if payload["profilePostLimitPerUser"] < 1 or payload["profilePostTotalLimit"] < 1:
            raise SupplementRequestError("Recent public posts require explicit per-user and total post budgets")
        maximum = payload["profileUserLimit"] * payload["profilePostLimitPerUser"]
        if payload["profilePostTotalLimit"] > maximum:
            raise SupplementRequestError("Total post budget exceeds the configured user budget")
    return payload


def current_post_user_ids(comments: list[dict[str, Any]], post_id: str) -> list[str]:
    counts: dict[str, int] = {}
    first_seen: dict[str, int] = {}
    for index, comment in enumerate(comments):
        if not isinstance(comment, dict) or str(comment.get("post_id") or "") != post_id:
            continue
        user = comment.get("user") if isinstance(comment.get("user"), dict) else {}
        user_id = clean_text(user.get("user_id"), 200)
        if not user_id:
            continue
        counts[user_id] = counts.get(user_id, 0) + 1
        first_seen.setdefault(user_id, index)
    return sorted(counts, key=lambda user_id: (-counts[user_id], first_seen[user_id], user_id))


def select_target_users(
    users: list[dict[str, Any]],
    comments: list[dict[str, Any]],
    *,
    post_id: str,
    mode: str,
    user_limit: int,
) -> list[dict[str, Any]]:
    by_id = {
        clean_text(user.get("user_id"), 200): user
        for user in users
        if isinstance(user, dict) and clean_text(user.get("user_id"), 200)
    }
    selected: list[dict[str, Any]] = []
    for user_id in current_post_user_ids(comments, post_id):
        user = by_id.get(user_id)
        if not user or not clean_text(user.get("profile_url"), 3000):
            continue
        if mode == "collect_missing_header" and profile_header_complete(user):
            continue
        selected.append(user)
        if len(selected) >= user_limit:
            break
    return selected


def profile_header_complete(user: dict[str, Any]) -> bool:
    return str(user.get("enrichment_status") or "").casefold() == "complete"


def extract_profile_cards(page: Any) -> list[dict[str, Any]]:
    raw = page.evaluate(
        r"""() => {
          const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
          const absolute = (value) => {
            try { return new URL(value, location.href).toString(); } catch (_) { return value || ''; }
          };
          const roots = [...document.querySelectorAll('section.note-item, [class*="note-item"], [class*="noteItem"]')];
          const results = [];
          const seen = new Set();
          for (const root of roots) {
            const links = [...root.querySelectorAll('a[href]')];
            const link = links.find((node) => /\/(?:explore|discovery\/item|search_result)\//.test(node.getAttribute('href') || ''));
            if (!link) continue;
            const url = absolute(link.getAttribute('href') || '');
            const match = url.match(/\/(?:explore|discovery\/item|search_result)\/([A-Za-z0-9]+)/);
            const noteId = match?.[1] || '';
            const identity = noteId || url.split('?')[0];
            if (!identity || seen.has(identity)) continue;
            seen.add(identity);
            const image = root.querySelector('img');
            const texts = [...root.querySelectorAll('h1,h2,h3,p,[class*="title"],span')]
              .map((node) => normalize(node.textContent))
              .filter((value) => value && value.length <= 180);
            results.push({
              note_id: noteId,
              note_url: url,
              explore_url: url,
              title: texts[0] || normalize(image?.getAttribute('alt')),
              source_card_text: normalize(root.innerText),
              card_cover_url: image?.currentSrc || image?.src || '',
              card_cover_alt: normalize(image?.getAttribute('alt')),
              card_rank: results.length + 1,
            });
          }
          return results;
        }"""
    )
    return [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []


def normalize_recent_post(record: Any, fallback: dict[str, Any]) -> dict[str, Any]:
    source = asdict(record) if is_dataclass(record) else record if isinstance(record, dict) else {}
    return {
        "post_id": clean_text(source.get("note_id") or fallback.get("note_id"), 200),
        "title": clean_text(source.get("title") or fallback.get("title"), 1000),
        "body": clean_text(source.get("body"), 12000),
        "note_url": clean_text(source.get("note_url") or fallback.get("note_url"), 3000),
        "publish_time": clean_text(source.get("publish_time"), 300),
        "access_status": clean_text(source.get("access_status"), 200) or "detail_unknown",
        "collected_at": utc_now(),
    }


def merge_recent_posts(existing: Any, incoming: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for item in [*(existing if isinstance(existing, list) else []), *incoming]:
        if not isinstance(item, dict):
            continue
        identity = clean_text(item.get("post_id"), 200) or clean_text(item.get("note_url"), 3000).split("?", 1)[0]
        if identity:
            merged[identity] = {**merged.get(identity, {}), **item}
    return list(merged.values())


def run_supplement(
    request: dict[str, Any],
    checkpoint_path: Path,
    *,
    upstream_loader: Callable[[Path], Any] = load_upstream,
) -> dict[str, Any]:
    output_dir = Path(request["outputDir"])
    users_path = output_dir / "audience-users.json"
    comments_path = output_dir / "audience-comments.json"
    users = load_json(users_path, [])
    comments = load_json(comments_path, [])
    if not isinstance(users, list) or not isinstance(comments, list):
        raise SupplementRequestError("Audience users/comments checkpoints are not valid arrays")

    targets = select_target_users(
        users,
        comments,
        post_id=request["postId"],
        mode=request["profileMode"],
        user_limit=request["profileUserLimit"],
    )
    state = load_json(checkpoint_path, {})
    if not isinstance(state, dict) or state.get("jobId") != request["jobId"] or state.get("postId") != request["postId"]:
        state = {}
    completed_user_ids = set(str(value) for value in state.get("completedUserIds", []) if value)
    failed: list[dict[str, Any]] = list(state.get("failures", [])) if isinstance(state.get("failures"), list) else []
    posts_collected = sum(
        len(user.get("recent_public_posts", []))
        for user in targets
        if isinstance(user.get("recent_public_posts"), list)
    )
    summary = {
        "schemaVersion": 1,
        "jobId": request["jobId"],
        "postId": request["postId"],
        "runId": request["runId"],
        "profileMode": request["profileMode"],
        "status": "running",
        "targetUserCount": len(targets),
        "completedUserCount": len(completed_user_ids.intersection({str(item.get('user_id') or '') for item in targets})),
        "failedUserCount": len(failed),
        "recentPostsCollected": posts_collected,
        "profileHeaderCoverage": 0,
        "recentPostCoverage": 0,
        "startedAt": state.get("startedAt") or utc_now(),
        "updatedAt": utc_now(),
    }

    def save(status: str | None = None) -> None:
        if status:
            summary["status"] = status
        summary["completedUserCount"] = len(completed_user_ids.intersection({str(item.get('user_id') or '') for item in targets}))
        summary["failedUserCount"] = len(failed)
        summary["recentPostsCollected"] = sum(
            len(user.get("recent_public_posts", []))
            for user in targets
            if isinstance(user.get("recent_public_posts"), list)
        )
        summary["profileHeaderCoverage"] = sum(1 for user in targets if profile_header_complete(user))
        summary["recentPostCoverage"] = sum(1 for user in targets if user.get("recent_public_posts"))
        summary["updatedAt"] = utc_now()
        atomic_write_json(users_path, users)
        atomic_write_json(checkpoint_path, {
            **summary,
            "completedUserIds": sorted(completed_user_ids),
            "failures": failed[-1000:],
            "budgets": {
                "profileUserLimit": request["profileUserLimit"],
                "profilePostLimitPerUser": request["profilePostLimitPerUser"],
                "profilePostTotalLimit": request["profilePostTotalLimit"],
            },
        })

    save()
    emit({**summary, "type": "supplement_started"})
    if not targets:
        save("completed")
        emit({**summary, "type": "supplement_completed"})
        return summary

    upstream = upstream_loader(Path(str(request.get("upstreamScraper") or DEFAULT_UPSTREAM_SCRAPER)))
    from playwright.sync_api import sync_playwright

    remaining_posts = max(0, request["profilePostTotalLimit"] - posts_collected)
    stop_reason = ""
    with sync_playwright() as playwright:
        browser = upstream.connect_browser(playwright, int(request.get("relayPort") or 18800))
        context = upstream.get_or_create_context(browser)
        reusable = getattr(upstream, "get_reusable_page", None)
        page = reusable(context) if callable(reusable) else context.new_page()
        created_page = not callable(reusable)

        def recover(challenge: str) -> bool:
            nonlocal stop_reason
            if challenge == "security_verification":
                save("waiting_security_verification")
                emit({**summary, "type": "supplement_status", "status": "waiting_security_verification"})
                _surface_security_verification(page, int(request.get("relayPort") or 18800))
                cleared, reason = _wait_for_manual_verification(
                    page,
                    int(request.get("securityVerificationTimeoutSeconds") or 600),
                    checkpoint_callback=save,
                )
            else:
                save("waiting_rate_limit")
                emit({**summary, "type": "supplement_status", "status": "waiting_rate_limit"})
                cleared, reason = _wait_for_rate_limit_recovery(
                    page,
                    max_retries=int(request.get("rateLimitMaxRetries") or 5),
                    initial_delay_seconds=float(request.get("rateLimitInitialDelaySeconds") or 15),
                    max_delay_seconds=float(request.get("rateLimitMaxDelaySeconds") or 120),
                    reload_timeout_ms=int(request.get("gotoTimeoutMs") or 15000),
                    checkpoint_callback=save,
                )
            if not cleared:
                stop_reason = reason or challenge
            return cleared

        try:
            for index, user in enumerate(targets, start=1):
                user_id = str(user.get("user_id") or "")
                if user_id in completed_user_ids:
                    continue
                try:
                    save("collecting_profile_headers")
                    emit({
                        **summary,
                        "type": "supplement_progress",
                        "status": "collecting_profile_headers",
                        "currentUserId": user_id,
                        "processedUsers": index - 1,
                    })
                    page.goto(
                        str(user["profile_url"]),
                        wait_until="domcontentloaded",
                        timeout=int(request.get("gotoTimeoutMs") or 15000),
                    )
                    page.wait_for_timeout(900)
                    challenge = _challenge_status(f"{page.url}\n{_body_text(page)}")
                    if challenge and not recover(challenge):
                        break
                    updated = parse_profile_snapshot(_profile_snapshot(page), user)
                    user.clear()
                    user.update(updated)

                    if request["profileMode"] == "recent_public_posts" and remaining_posts > 0:
                        save("collecting_profile_posts")
                        emit({**summary, "type": "supplement_status", "status": "collecting_profile_posts", "currentUserId": user_id})
                        cards = extract_profile_cards(page)
                        per_user_limit = min(request["profilePostLimitPerUser"], remaining_posts)
                        collected: list[dict[str, Any]] = []
                        existing_ids = {
                            clean_text(item.get("post_id"), 200) or clean_text(item.get("note_url"), 3000).split("?", 1)[0]
                            for item in user.get("recent_public_posts", [])
                            if isinstance(item, dict)
                        }
                        for card in cards:
                            identity = clean_text(card.get("note_id"), 200) or clean_text(card.get("note_url"), 3000).split("?", 1)[0]
                            if not identity or identity in existing_ids:
                                continue
                            record = upstream.scrape_note(
                                page,
                                card,
                                goto_timeout_ms=int(request.get("gotoTimeoutMs") or 15000),
                                source_search_url=str(user.get("profile_url") or ""),
                            )
                            if record is not None:
                                collected.append(normalize_recent_post(record, card))
                                existing_ids.add(identity)
                            if len(collected) >= per_user_limit:
                                break
                            time.sleep(max(0.0, float(request.get("noteDelaySeconds") or 1.2)))
                        user["recent_public_posts"] = merge_recent_posts(user.get("recent_public_posts"), collected)
                        user["recent_public_posts_status"] = "complete" if len(collected) >= per_user_limit or len(cards) <= len(collected) else "partial"
                        user["recent_public_posts_collected_at"] = utc_now()
                        remaining_posts = max(0, remaining_posts - len(collected))

                    completed_user_ids.add(user_id)
                    save("running")
                except Exception as error:  # noqa: BLE001
                    user["profile_supplement_status"] = "partial"
                    user["profile_supplement_error"] = clean_text(error, 1000)
                    failed.append({"userId": user_id, "reason": clean_text(error, 1000), "at": utc_now()})
                    save("running")
                if stop_reason:
                    break
                time.sleep(max(0.0, float(request.get("noteDelaySeconds") or 1.2)))
        finally:
            if created_page:
                try:
                    page.close()
                except Exception:  # noqa: BLE001
                    pass

    if stop_reason:
        summary["stopReason"] = stop_reason
        save("partial")
    elif failed:
        save("partial")
    else:
        save("completed")
    emit({**summary, "type": "supplement_completed"})
    return summary


def bounded_integer(value: Any, minimum: int, maximum: int, fallback: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = fallback
    if parsed < minimum or parsed > maximum:
        raise SupplementRequestError(f"Integer must be between {minimum} and {maximum}")
    return parsed


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Supplement only current-post audience profiles inside an existing job")
    parser.add_argument("--request", required=True)
    parser.add_argument("--checkpoint", required=True)
    options = parser.parse_args(arguments)
    request_path = Path(options.request).resolve()
    checkpoint_path = Path(options.checkpoint).resolve()
    try:
        request = load_request(request_path)
        result = run_supplement(request, checkpoint_path)
        return 0 if result.get("status") in {"completed", "partial"} else 1
    except BaseException as error:  # noqa: BLE001
        emit({
            "type": "supplement_failed",
            "status": "failed",
            "message": clean_text(error, 1000),
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
