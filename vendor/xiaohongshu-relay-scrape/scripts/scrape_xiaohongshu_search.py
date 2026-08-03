import argparse
import csv
import hashlib
import hmac
import io
import json
import os
import pathlib
import re
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from typing import Any, Callable
from urllib.parse import parse_qsl, unquote, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from playwright.sync_api import Browser, BrowserContext, Error, Page, TimeoutError, sync_playwright
from websockets.sync.client import connect as websocket_connect

from collection_pacing import (
    DEFAULT_NOTE_DELAY_SECONDS,
    DEFAULT_RANDOM_DELAY_MAX_SECONDS,
    DEFAULT_RANDOM_DELAY_MIN_SECONDS,
    DEFAULT_SPEED_MODE,
    next_collection_delay,
    validate_collection_pacing,
)


SEARCH_URL = (
    "https://www.xiaohongshu.com/search_result/"
    "?keyword=%25E8%25BF%2590%25E8%2590%25A5%2520%25E5%25AE%259E%25E4%25B9%25A0%2520%25E7%25BB%25A7%25E4%25BB%25BB"
    "&source=web_note_detail_r10&type=51"
)
RELAY_PORT = 18800
CHECKPOINT_EVERY = 5

RATE_LIMIT_MARKERS = (
    "error_code=300013",
    "访问频繁",
    "请求频繁",
    "操作频繁",
    "请稍后再试",
    "too many requests",
)
SECURITY_VERIFICATION_MARKERS = (
    "/captcha",
    "安全验证",
    "请完成验证",
    "验证后继续",
    "拖动滑块",
    "滑块验证",
    "异常访问",
    "网络环境存在风险",
)
LOGIN_REQUIRED_MARKERS = (
    "/website-login",
    "/login",
    "登录后查看",
    "手机号登录",
    "请先登录",
)

LATEST_SORT_SELECTED_JS = r"""
() => Array.from(document.querySelectorAll('.filter-panel .tags')).some((element) => {
  const text = (element.innerText || element.textContent || '').trim();
  const opacity = Number.parseFloat(getComputedStyle(element).opacity || '1');
  return text === '最新'
    && element.classList.contains('active')
    && element.getAttribute('aria-hidden') !== 'true'
    && opacity > 0.1;
})
"""

OPEN_FILTER_PANEL_JS = r"""
() => {
  if (document.querySelector('.filter-panel')) return true;
  const trigger = Array.from(document.querySelectorAll('.filter')).find((element) => {
    const text = (element.innerText || element.textContent || '').trim();
    return text.includes('筛选') || text.includes('已筛选');
  });
  if (!trigger) return false;
  trigger.click();
  return true;
}
"""

CLICK_LATEST_SORT_JS = r"""
() => {
  const option = Array.from(document.querySelectorAll('.filter-panel .tags')).find((element) => {
    const text = (element.innerText || element.textContent || '').trim();
    const opacity = Number.parseFloat(getComputedStyle(element).opacity || '1');
    return text === '最新'
      && element.getAttribute('aria-hidden') !== 'true'
      && opacity > 0.1;
  });
  if (!option) return false;
  option.click();
  return true;
}
"""

VISIBLE_CARD_IDS_JS = r"""
() => Array.from(document.querySelectorAll('section.note-item[data-note-id]'))
  .slice(0, 12)
  .map((element) => element.getAttribute('data-note-id'))
  .filter(Boolean)
"""

CLOSE_FILTER_PANEL_JS = r"""
() => {
  if (!document.querySelector('.filter-panel')) return true;
  const trigger = document.querySelector('.filter');
  if (!trigger) return false;
  trigger.click();
  return true;
}
"""


@dataclass
class NoteRecord:
    note_id: str
    title: str
    author: str
    author_profile: str
    note_url: str
    publish_time: str
    like_count: str
    collect_count: str
    comment_count: str
    body: str
    body_html: str
    detail_image_urls: str
    detail_image_alts: str
    tags: str
    source_card_text: str
    scraped_at: str
    access_level: str
    access_status: str
    source_search_url: str
    card_rank: int
    card_title: str
    card_author: str
    card_author_profile: str
    card_publish_time: str
    card_like_count: str
    card_collect_count: str
    card_comment_count: str
    card_cover_url: str
    card_cover_alt: str
    card_tags: str
    card_badges: str
    card_link_urls: str
    card_image_urls: str
    card_text_segments: str
    card_search_result_url: str
    card_explore_url: str


def log(message: str) -> None:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now}] {message}")


def get_gateway_token() -> str:
    token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "").strip()
    if token:
        return token

    configured_path = os.environ.get("OPENCLAW_CONFIG_PATH", "").strip()
    openclaw_json = pathlib.Path(configured_path) if configured_path else pathlib.Path.home() / ".openclaw" / "openclaw.json"
    if openclaw_json.exists():
        try:
            payload = json.loads(openclaw_json.read_text(encoding="utf-8"))
            config_token = payload.get("gateway", {}).get("auth", {}).get("token", "").strip()
            if config_token:
                return config_token
        except Exception:  # noqa: BLE001
            pass
    if configured_path:
        return ""

    gateway_cmd = pathlib.Path.home() / ".openclaw" / "gateway.cmd"
    if not gateway_cmd.exists():
        return ""

    text = gateway_cmd.read_text(encoding="utf-8", errors="ignore")
    match = re.search(r'OPENCLAW_GATEWAY_TOKEN=([^"\r\n]+)', text)
    return match.group(1).strip() if match else ""


def get_relay_headers(port: int) -> dict[str, str]:
    gateway_token = get_gateway_token()
    if not gateway_token:
        return {}
    relay_token = hmac.new(
        gateway_token.encode("utf-8"),
        f"openclaw-extension-relay-v1:{port}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {"x-openclaw-relay-token": relay_token}


class RelaySecurityRestrictionError(RuntimeError):
    pass


def is_security_restriction_target(target: dict[str, Any]) -> bool:
    text = f"{target.get('title', '')} {target.get('url', '')}".casefold()
    return (
        "/website-login/error" in text
        or "error_code=300013" in text
        or "access_denied" in text
    )


def is_xiaohongshu_target(target: dict[str, Any]) -> bool:
    try:
        hostname = (urlsplit(str(target.get("url") or "")).hostname or "").casefold()
    except ValueError:
        return False
    return hostname == "xiaohongshu.com" or hostname.endswith(".xiaohongshu.com")


def relay_target_pressure(targets: Any) -> tuple[bool, list[str]]:
    if not isinstance(targets, list):
        raise RuntimeError("Relay returned an invalid target list.")
    pages = [target for target in targets if target.get("type", "page") == "page"]
    xiaohongshu_pages = [target for target in pages if is_xiaohongshu_target(target)]
    reasons: list[str] = []
    if len(targets) >= 9:
        reasons.append("target_count")
    if len(pages) >= 3:
        reasons.append("page_count")
    if len(xiaohongshu_pages) >= 3:
        reasons.append("duplicate_target_pages")
    if any(is_security_restriction_target(target) for target in pages):
        reasons.append("security_restriction")
    return bool(reasons), reasons


def fetch_relay_json(port: int, path: str, headers: dict[str, str], timeout_seconds: float) -> Any:
    request = Request(f"http://127.0.0.1:{port}{path}", headers=headers)
    with urlopen(request, timeout=timeout_seconds) as response:
        return json.load(response)


def relay_websocket_url(raw_url: str, relay_token: str) -> str:
    if not relay_token:
        return raw_url
    parts = urlsplit(raw_url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query["token"] = relay_token
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def send_relay_cdp_command(socket, command_id: int, method: str, params: dict[str, Any], timeout_seconds: float) -> dict[str, Any]:
    socket.send(json.dumps({"id": command_id, "method": method, "params": params}))
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        response = json.loads(socket.recv(timeout=max(0.1, deadline - time.monotonic())))
        if response.get("id") != command_id:
            continue
        if response.get("error"):
            raise RuntimeError(response["error"].get("message") or f"Relay CDP command {method} failed.")
        return response.get("result", {})
    raise TimeoutError(f"Relay CDP command {method} timed out.")


def reset_overloaded_relay_targets(relay_port: int, timeout_seconds: float = 5.0, *, force: bool = False) -> int:
    headers = get_relay_headers(relay_port)
    targets = fetch_relay_json(relay_port, "/json/list", headers, timeout_seconds)
    pressured, _reasons = relay_target_pressure(targets)
    if not pressured and not force:
        return 0

    page_targets = [target for target in targets if target.get("type", "page") == "page"]
    version = fetch_relay_json(relay_port, "/json/version", headers, timeout_seconds)
    websocket_url = str(version.get("webSocketDebuggerUrl") or "").strip()
    if not websocket_url:
        raise RuntimeError("Relay version response has no WebSocket endpoint.")

    relay_token = headers.get("x-openclaw-relay-token", "")
    closed = 0
    with websocket_connect(
        relay_websocket_url(websocket_url, relay_token),
        open_timeout=timeout_seconds,
        close_timeout=1,
    ) as socket:
        created = send_relay_cdp_command(
            socket,
            1,
            "Target.createTarget",
            {"url": "https://www.xiaohongshu.com/explore"},
            timeout_seconds,
        )
        if not str(created.get("targetId") or "").strip():
            raise RuntimeError("Relay did not create a clean replacement target.")
        for command_id, target in enumerate(page_targets, start=2):
            target_id = str(target.get("id") or "").strip()
            if not target_id:
                continue
            result = send_relay_cdp_command(
                socket,
                command_id,
                "Target.closeTarget",
                {"targetId": target_id},
                timeout_seconds,
            )
            if result.get("success") is not False:
                closed += 1
    return closed


def cleanup_security_restriction_targets(relay_port: int, timeout_seconds: float = 5.0) -> int:
    headers = get_relay_headers(relay_port)
    targets = fetch_relay_json(relay_port, "/json/list", headers, timeout_seconds)
    if not isinstance(targets, list):
        raise RuntimeError("Relay returned an invalid target list.")
    page_targets = [target for target in targets if target.get("type", "page") == "page"]
    restricted = [target for target in page_targets if is_security_restriction_target(target)]
    if not restricted:
        return 0
    usable = [target for target in page_targets if not is_security_restriction_target(target)]
    if not usable:
        raise RelaySecurityRestrictionError(
            "Relay only has a security-restriction page. Refresh the search page, reconnect Relay, then retry."
        )

    version = fetch_relay_json(relay_port, "/json/version", headers, timeout_seconds)
    websocket_url = str(version.get("webSocketDebuggerUrl") or "").strip()
    if not websocket_url:
        raise RuntimeError("Relay version response has no WebSocket endpoint.")
    relay_token = headers.get("x-openclaw-relay-token", "")
    closed = 0
    with websocket_connect(
        relay_websocket_url(websocket_url, relay_token),
        open_timeout=timeout_seconds,
        close_timeout=1,
    ) as socket:
        for command_id, target in enumerate(restricted, start=1):
            target_id = str(target.get("id") or "").strip()
            if not target_id:
                continue
            socket.send(json.dumps({
                "id": command_id,
                "method": "Target.closeTarget",
                "params": {"targetId": target_id},
            }))
            deadline = time.monotonic() + timeout_seconds
            while time.monotonic() < deadline:
                response = json.loads(socket.recv(timeout=max(0.1, deadline - time.monotonic())))
                if response.get("id") != command_id:
                    continue
                if response.get("error"):
                    raise RuntimeError(response["error"].get("message") or "Relay could not close the restricted page.")
                if response.get("result", {}).get("success"):
                    closed += 1
                break
    return closed


def connect_browser(playwright, relay_port: int) -> Browser:
    endpoint = f"http://127.0.0.1:{relay_port}"
    headers = get_relay_headers(relay_port)
    timeout = int(os.environ.get("XHS_RELAY_CONNECT_TIMEOUT_MS") or 60000)
    recovery_timeout = max(1.0, min(timeout / 1000, 8.0))
    try:
        reset_targets = reset_overloaded_relay_targets(relay_port, timeout_seconds=recovery_timeout)
        if reset_targets:
            log(f"Relay auto-recovery replaced an overloaded target set and closed {reset_targets} stale page(s).")
    except Exception as error:  # noqa: BLE001
        log(f"Relay preflight recovery warning: {error}")
    closed_targets = cleanup_security_restriction_targets(
        relay_port,
        timeout_seconds=recovery_timeout,
    )
    if closed_targets:
        log(f"Relay recovery closed {closed_targets} stale security-restriction tab(s).")

    def connect() -> Browser:
        if headers:
            return playwright.chromium.connect_over_cdp(endpoint, headers=headers, timeout=timeout)
        return playwright.chromium.connect_over_cdp(endpoint, timeout=timeout)

    try:
        return connect()
    except TimeoutError:
        log("Relay Playwright initialization timed out; applying a forced target reset and retrying once.")
        reset_targets = reset_overloaded_relay_targets(
            relay_port,
            timeout_seconds=recovery_timeout,
            force=True,
        )
        log(f"Relay forced recovery closed {reset_targets} stale page(s); retrying with a {timeout} ms connection window.")
        return connect()


def get_or_create_context(browser: Browser) -> BrowserContext:
    if browser.contexts:
        return browser.contexts[0]
    return browser.new_context()


def page_reuse_priority(url: str) -> int:
    if "xiaohongshu.com/search_result" in url:
        return 0
    if "xiaohongshu.com/explore" in url:
        return 1
    if "xiaohongshu.com/user/profile" in url:
        return 2
    if "xiaohongshu.com/notification" in url:
        return 3
    if "xiaohongshu.com" in url:
        return 4
    return 10


def is_blocked_page(url: str) -> bool:
    lowered = (url or "").casefold()
    return any(marker in lowered for marker in ("/login", "/captcha", "/website-login", "/404"))


def page_is_usable(page: Page) -> bool:
    try:
        return not page.is_closed()
    except Exception:  # noqa: BLE001
        return False


def get_reusable_page(context: BrowserContext) -> Page:
    logged_in_xiaohongshu_pages: list[tuple[int, Page]] = []
    xiaohongshu_pages: list[tuple[int, Page]] = []
    fallback_pages: list[tuple[int, Page]] = []

    for page in context.pages:
        if not page_is_usable(page):
            continue
        url = page.url or ""
        priority = page_reuse_priority(url)
        if "xiaohongshu.com" in url:
            try:
                page.wait_for_load_state("domcontentloaded", timeout=1500)
            except Exception:  # noqa: BLE001
                pass
            if not is_blocked_page(url) and not has_login_wall(page):
                logged_in_xiaohongshu_pages.append((priority, page))
            xiaohongshu_pages.append((priority, page))
        else:
            fallback_pages.append((priority, page))

    if logged_in_xiaohongshu_pages:
        _, selected_page = sorted(logged_in_xiaohongshu_pages, key=lambda item: item[0])[0]
        log(f"Reusing logged-in Xiaohongshu tab: {selected_page.url}")
        return selected_page

    if xiaohongshu_pages:
        _, selected_page = sorted(xiaohongshu_pages, key=lambda item: item[0])[0]
        log(f"Reusing Xiaohongshu tab (login state unknown): {selected_page.url}")
        return selected_page

    if fallback_pages:
        _, selected_page = sorted(fallback_pages, key=lambda item: item[0])[0]
        log(f"Falling back to non-Xiaohongshu tab: {selected_page.url}")
        return selected_page
    raise RuntimeError("No attached page is available in the current Edge session.")


def with_retries(action, *, attempts: int = 3, sleep_seconds: float = 2.0):
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            return action()
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt == attempts:
                break
            time.sleep(sleep_seconds)
    raise last_error  # type: ignore[misc]


def open_search_page(context: BrowserContext, search_url: str) -> Page:
    page = get_reusable_page(context)
    last_error: Exception | None = None
    for attempt in range(1, 3):
        try:
            page.goto(search_url, wait_until="domcontentloaded", timeout=120000)
            wait_for_search_results(page)
            if not search_request_matches(page.url, search_url):
                raise RuntimeError(f"search page did not reach the requested keyword: {page.url}")
            log(f"Search page ready for requested keyword: {page.url}")
            return page
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if page_is_usable(page):
                try:
                    log(f"direct goto failed ({exc}); falling back to location.href navigation")
                    page.evaluate("(url) => { location.href = url; }", search_url)
                    deadline = time.time() + 30
                    while time.time() < deadline:
                        if search_request_matches(page.url, search_url):
                            wait_for_search_results(page)
                            log(f"Search page ready for requested keyword: {page.url}")
                            return page
                        page.wait_for_timeout(1000)
                except Exception as fallback_exc:  # noqa: BLE001
                    last_error = fallback_exc
            if attempt == 1:
                log("Reusable search tab became unavailable; retrying in a fresh tab.")
                page = context.new_page()

    raise RuntimeError(f"Search page navigation failed after replacing the tab: {last_error}")


def search_request_matches(actual_url: str, expected_url: str) -> bool:
    try:
        actual = urlsplit(actual_url)
        expected = urlsplit(expected_url)
        if (
            actual.netloc.casefold() != expected.netloc.casefold()
            or actual.path.rstrip("/") != expected.path.rstrip("/")
        ):
            return False
        actual_query = dict(parse_qsl(actual.query, keep_blank_values=True))
        expected_query = dict(parse_qsl(expected.query, keep_blank_values=True))
        return bool(expected_query.get("keyword")) and actual_query.get("keyword") == expected_query.get("keyword")
    except ValueError:
        return False


def dismiss_common_popups(page: Page) -> None:
    candidates = [
        "text=知道了",
        "text=我知道了",
        "text=取消",
        "text=稍后再说",
        "text=同意",
        "text=允许",
    ]
    for selector in candidates:
        try:
            locator = page.locator(selector).first
            if locator.is_visible(timeout=500):
                locator.click(timeout=1000)
                page.wait_for_timeout(500)
        except Exception:  # noqa: BLE001
            continue


def has_login_wall(page: Page) -> bool:
    selectors = [
        "text=登录后查看搜索结果",
        "text=手机号登录",
        "text=输入手机号",
    ]
    for selector in selectors:
        try:
            if page.locator(selector).first.is_visible(timeout=500):
                return True
        except Exception:  # noqa: BLE001
            continue
    return False


def search_security_restriction(page: Page) -> str:
    """Return a restriction kind without issuing any additional page requests."""
    page_text = unquote(str(getattr(page, "url", "") or ""))
    try:
        page_text = f"{page_text} {page.locator('body').inner_text(timeout=1000)}"
    except Exception:  # noqa: BLE001
        pass
    normalized = page_text.casefold()
    if any(marker.casefold() in normalized for marker in RATE_LIMIT_MARKERS):
        return "rate_limited"
    if any(marker.casefold() in normalized for marker in SECURITY_VERIFICATION_MARKERS):
        return "security_verification"
    return ""


def wait_for_search_security_clearance(page: Page, timeout_seconds: int) -> bool:
    restriction = search_security_restriction(page)
    if not restriction:
        return True

    log(
        "SECURITY_VERIFICATION "
        f"detected timeout={timeout_seconds}s; search collection paused while waiting for manual completion"
    )
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        page.wait_for_timeout(1000)
        if not search_security_restriction(page):
            log("SECURITY_VERIFICATION cleared; resuming collection")
            wait_for_search_results(page)
            return True

    log("SECURITY_VERIFICATION timed_out; stopping new collection and preserving checkpoint")
    return False


def wait_for_search_results(page: Page) -> None:
    if has_login_wall(page):
        return
    selectors = [
        "section.note-item",
        "[class*=note-item]",
        "[class*=search-result]",
    ]
    for selector in selectors:
        try:
            page.locator(selector).first.wait_for(state="visible", timeout=2500)
            page.wait_for_timeout(400)
            return
        except Exception:  # noqa: BLE001
            continue
    page.wait_for_timeout(1500)


def should_apply_live_search_sort(use_card_cache: bool) -> bool:
    return not use_card_cache


def select_latest_sort(page: Page) -> None:
    """Select Xiaohongshu's visible latest-first filter and verify its active state."""
    before_ids = page.evaluate(VISIBLE_CARD_IDS_JS)
    if not page.evaluate(OPEN_FILTER_PANEL_JS):
        raise RuntimeError("Xiaohongshu filter control was not found; latest-first sorting was not applied.")

    try:
        page.wait_for_function("() => Boolean(document.querySelector('.filter-panel'))", timeout=5000)
    except Exception:  # noqa: BLE001
        # Some current search-page variants toggle the filter affordance without
        # rendering the legacy panel. Keep bounded runs usable; max-age filtering
        # still enforces the requested result window after card discovery.
        page.evaluate(CLOSE_FILTER_PANEL_JS)
        log("Latest-sort panel unavailable; continuing with result-level recency filtering.")
        wait_for_search_results(page)
        return

    already_selected = bool(page.evaluate(LATEST_SORT_SELECTED_JS))
    if not already_selected:
        if not page.evaluate(CLICK_LATEST_SORT_JS):
            raise RuntimeError("Xiaohongshu latest sort option was not found; collection was stopped before scraping.")
        try:
            page.wait_for_function(LATEST_SORT_SELECTED_JS, timeout=5000)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError("Xiaohongshu did not confirm the latest-first sort selection.") from exc

        if before_ids:
            try:
                page.wait_for_function(
                    """
                    (before) => {
                      const current = Array.from(document.querySelectorAll('section.note-item[data-note-id]'))
                        .slice(0, 12)
                        .map((element) => element.getAttribute('data-note-id'))
                        .filter(Boolean);
                      return current.length > 0 && JSON.stringify(current) !== JSON.stringify(before);
                    }
                    """,
                    arg=before_ids,
                    timeout=12000,
                )
            except Exception:  # noqa: BLE001
                # An already fresh result set can keep the same leading cards. The active
                # filter state above remains the authoritative verification.
                pass

    page.wait_for_timeout(800)
    if not page.evaluate(LATEST_SORT_SELECTED_JS):
        raise RuntimeError("Xiaohongshu latest-first sort verification was lost before collection.")
    log("Search sort verified: 最新 (latest first).")

    page.evaluate(CLOSE_FILTER_PANEL_JS)
    try:
        page.wait_for_function("() => !document.querySelector('.filter-panel')", timeout=3000)
    except Exception:  # noqa: BLE001
        pass
    wait_for_search_results(page)


def infer_card_publish_datetime(card: dict[str, Any], now: datetime | None = None) -> datetime | None:
    reference = now or datetime.now()
    text = " ".join(
        str(card.get(field, "") or "")
        for field in ("publish_time", "card_text_segments", "source_card_text")
    )

    full_date = re.search(r"(?<!\d)(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?", text)
    if full_date:
        try:
            return reference.replace(
                year=int(full_date.group(1)),
                month=int(full_date.group(2)),
                day=int(full_date.group(3)),
                hour=0,
                minute=0,
                second=0,
                microsecond=0,
            )
        except ValueError:
            return None

    if "刚刚" in text:
        return reference
    relative_patterns = (
        (r"(\d+)\s*分钟前", "minutes"),
        (r"(\d+)\s*小时前", "hours"),
        (r"(\d+)\s*天前", "days"),
    )
    for pattern, unit in relative_patterns:
        match = re.search(pattern, text)
        if match:
            return reference - timedelta(**{unit: int(match.group(1))})

    day_offset = 1 if "昨天" in text else 2 if "前天" in text else None
    if day_offset is not None:
        candidate = reference - timedelta(days=day_offset)
        time_match = re.search(r"(?:昨天|前天)\s*(\d{1,2}):(\d{2})", text)
        if time_match:
            candidate = candidate.replace(hour=int(time_match.group(1)), minute=int(time_match.group(2)))
        return candidate.replace(second=0, microsecond=0)

    month_day = re.search(r"(?<!\d)(\d{1,2})[-/.月](\d{1,2})(?:日)?", text)
    if month_day:
        try:
            candidate = reference.replace(
                month=int(month_day.group(1)),
                day=int(month_day.group(2)),
                hour=0,
                minute=0,
                second=0,
                microsecond=0,
            )
            if candidate > reference + timedelta(days=1):
                candidate = candidate.replace(year=candidate.year - 1)
            return candidate
        except ValueError:
            return None
    return None


def filter_cards_by_recency(
    cards: list[dict[str, Any]],
    max_age_days: int,
    now: datetime | None = None,
) -> tuple[list[dict[str, Any]], int, int]:
    if max_age_days <= 0:
        return list(cards), 0, 0
    reference = now or datetime.now()
    cutoff = reference - timedelta(days=max_age_days)
    kept: list[dict[str, Any]] = []
    removed = 0
    unknown = 0
    for card in cards:
        published_at = infer_card_publish_datetime(card, reference)
        if published_at is None:
            unknown += 1
            kept.append(card)
        elif published_at >= cutoff:
            kept.append(card)
        else:
            removed += 1
    return kept, removed, unknown


def collection_max_age_days(limit: int, max_age_days: int) -> int:
    """Apply the requested recency scope before opening detail pages."""
    return max(0, max_age_days)


def resume_record_matches_cards(record: NoteRecord, cards: list[dict[str, Any]]) -> bool:
    card_ids = {str(card.get("note_id", "") or "") for card in cards}
    card_urls = {
        str(card.get(field, "") or "")
        for card in cards
        for field in ("note_url", "search_result_url", "explore_url")
    }
    return bool(
        (record.note_id and record.note_id in card_ids)
        or (record.note_url and record.note_url in card_urls)
        or (record.card_search_result_url and record.card_search_result_url in card_urls)
        or (record.card_explore_url and record.card_explore_url in card_urls)
    )


def is_navigation_context_error(exc: Exception) -> bool:
    message = str(exc)
    markers = (
        "Execution context was destroyed",
        "Cannot find context with specified id",
        "most likely because of a navigation",
    )
    return any(marker in message for marker in markers)


def wait_for_search_page_to_settle(page: Page) -> None:
    try:
        page.wait_for_load_state("domcontentloaded", timeout=10000)
    except Exception:  # noqa: BLE001
        pass
    page.wait_for_timeout(1200)
    wait_for_search_results(page)


def wait_for_note_ready(page: Page) -> None:
    selector = ":is(#detail-title, #detail-desc, .note-content, article, h1):visible"
    try:
        page.locator(selector).first.wait_for(state="visible", timeout=3000)
        page.wait_for_timeout(250)
    except Exception:  # noqa: BLE001
        page.wait_for_timeout(500)


def extract_cards(page: Page) -> list[dict[str, Any]]:
    js = r"""
() => {
  const seen = new Set();
  function normalizeUrl(href) {
    if (!href) return '';
    try {
      return new URL(href, location.origin).toString();
    } catch {
      return '';
    }
  }

  function findText(el, selectors) {
    for (const selector of selectors) {
      const node = el.querySelector(selector);
      if (node && (node.innerText || node.textContent)) {
        const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
    }
    return '';
  }

  function collectTexts(el, selectors, { max = 20, maxLength = 80 } = {}) {
    const values = [];
    for (const selector of selectors) {
      const nodes = Array.from(el.querySelectorAll(selector));
      for (const node of nodes) {
        const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (text.length > maxLength) continue;
        if (values.includes(text)) continue;
        values.push(text);
        if (values.length >= max) return values;
      }
    }
    return values;
  }

  function collectUrls(el, selector, attr, max = 20) {
    const values = [];
    const nodes = Array.from(el.querySelectorAll(selector));
    for (const node of nodes) {
      const raw = node.getAttribute(attr) || '';
      const normalized = normalizeUrl(raw);
      if (!normalized) continue;
      if (values.includes(normalized)) continue;
      values.push(normalized);
      if (values.length >= max) return values;
    }
    return values;
  }

  function collectImageSources(el) {
    const values = [];
    const nodes = Array.from(el.querySelectorAll('img'));
    for (const node of nodes) {
      const candidates = [
        node.getAttribute('src'),
        node.getAttribute('data-src'),
        node.getAttribute('data-lazy-src'),
        node.currentSrc,
      ].filter(Boolean);
      for (const candidate of candidates) {
        const normalized = normalizeUrl(candidate);
        if (!normalized) continue;
        if (values.includes(normalized)) continue;
        values.push(normalized);
        if (values.length >= 10) return values;
      }
    }
    return values;
  }

  const items = Array.from(document.querySelectorAll('section.note-item'));
  const cards = [];
  for (const [index, item] of items.entries()) {
    const coverLink = item.querySelector('a.cover[href*="/search_result/"]');
    if (!coverLink) {
      continue;
    }

    const searchResultUrl = normalizeUrl(coverLink.getAttribute('href') || '');
    if (!searchResultUrl || seen.has(searchResultUrl)) {
      continue;
    }

    const hiddenExploreLink = item.querySelector('a[href*="/explore/"], a[href*="/discovery/item/"]');
    const exploreUrl = normalizeUrl(hiddenExploreLink?.getAttribute('href') || '');
    const preferredUrl = searchResultUrl || exploreUrl;
    if (seen.has(preferredUrl)) {
      continue;
    }
    seen.add(preferredUrl);
    const title =
      findText(item, [
        '[class*=title]',
        '[class*=Title]',
        '[class*=line-clamp]',
        'h1',
        'h2',
        'h3',
        'span'
      ]) ||
      (item.innerText || '').replace(/\s+/g, ' ').trim();
    const author = findText(item, [
      '[class*=author]',
      '[class*=user]',
      '[class*=name]',
      '.name'
    ]);
    const authorLink = item.querySelector('a[href*="/user/profile/"]');
    const authorProfile = normalizeUrl(authorLink?.getAttribute('href') || '');
    const counts = collectTexts(item, ['[class*=count]', '.count', '[class*=interact]'], { max: 6, maxLength: 20 });
    const imageNodes = Array.from(item.querySelectorAll('img'));
    const firstImage = imageNodes[0];
    const coverAlt = (firstImage?.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
    const badges = collectTexts(
      item,
      ['[class*=badge]', '[class*=label]', '[class*=tag]', '[class*=meta]', '[class*=info]'],
      { max: 12, maxLength: 40 }
    );
    const textSegments = collectTexts(
      item,
      ['a', 'span', 'div', 'p'],
      { max: 30, maxLength: 120 }
    );
    const cardText = (item.innerText || '').replace(/\s+/g, ' ').trim();
    const noteIdSource = hiddenExploreLink?.getAttribute('href') || searchResultUrl || preferredUrl;
    const noteIdMatch = noteIdSource.match(/(?:explore|item|search_result)\/([a-zA-Z0-9]+)/);
    cards.push({
      note_id: noteIdMatch ? noteIdMatch[1] : '',
      note_url: preferredUrl,
      search_result_url: searchResultUrl,
      explore_url: exploreUrl,
      card_rank: index + 1,
      title,
      author,
      author_profile: authorProfile,
      publish_time: textSegments.find(text => /^(?:刚刚|\d+\s*分钟前|\d+\s*小时前|昨天(?:\s+\d{1,2}:\d{2})?|前天(?:\s+\d{1,2}:\d{2})?|\d+\s*天前|\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2})?|20\d{2}[-/.]\d{1,2}[-/.]\d{1,2})/.test(text)) || '',
      like_count: counts[0] || '',
      collect_count: counts[1] || '',
      comment_count: counts[2] || '',
      card_cover_url: collectImageSources(item)[0] || '',
      card_cover_alt: coverAlt,
      card_tags: badges.filter(text => text.startsWith('#')).join(' | '),
      card_badges: badges.join(' | '),
      card_link_urls: collectUrls(item, 'a[href]', 'href').join(' | '),
      card_image_urls: collectImageSources(item).join(' | '),
      card_text_segments: textSegments.join(' | '),
      source_card_text: cardText.slice(0, 1000)
    });
  }
  return cards;
}
"""
    return page.evaluate(js)


def card_identity(card: dict[str, Any]) -> str:
    note_id = str(card.get("note_id") or "").strip()
    if note_id:
        return f"note:{note_id}"
    raw_url = str(card.get("note_url") or card.get("search_result_url") or card.get("explore_url") or "").strip()
    if not raw_url:
        return ""
    try:
        parsed = urlsplit(raw_url)
        return f"url:{urlunsplit((parsed.scheme.casefold(), parsed.netloc.casefold(), parsed.path, '', ''))}"
    except ValueError:
        return f"url:{raw_url}"


def merge_discovered_cards(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(existing)
    for key, value in incoming.items():
        if value not in (None, "", [], {}) and merged.get(key) in (None, "", [], {}):
            merged[key] = value
    ranks = [
        int(value)
        for value in (existing.get("card_rank"), incoming.get("card_rank"))
        if str(value or "").isdigit() and int(value) > 0
    ]
    if ranks:
        merged["card_rank"] = min(ranks)
    for key in ("note_url", "search_result_url"):
        current = str(merged.get(key) or "")
        candidate = str(incoming.get(key) or "")
        if candidate and "xsec_source=pc_search" in candidate and "xsec_source=pc_search" not in current:
            merged[key] = candidate
    return merged


def collect_note_links(
    page: Page,
    *,
    max_scrolls: int,
    stable_rounds: int,
    speed_mode: str,
    note_delay_seconds: float,
    random_delay_min_seconds: float,
    random_delay_max_seconds: float,
    security_verification_timeout_seconds: int,
    full_discovery: bool = False,
    checkpoint: Callable[[list[dict[str, Any]]], None] | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    all_cards: dict[str, dict[str, Any]] = {}
    unchanged_rounds = 0

    for scroll_index in range(max_scrolls):
        if not wait_for_search_security_clearance(page, security_verification_timeout_seconds):
            return list(all_cards.values()), True
        dismiss_common_popups(page)
        try:
            cards = extract_cards(page)
        except Error as exc:
            if is_navigation_context_error(exc):
                log("search page navigated during collection; waiting and retrying this scroll step")
                wait_for_search_page_to_settle(page)
                continue
            raise
        if search_security_restriction(page):
            if not wait_for_search_security_clearance(page, security_verification_timeout_seconds):
                return list(all_cards.values()), True
            continue
        before_count = len(all_cards)
        for card in cards:
            identity = card_identity(card)
            if not identity:
                continue
            if identity in all_cards:
                all_cards[identity] = merge_discovered_cards(all_cards[identity], card)
            else:
                all_cards[identity] = card
        after_count = len(all_cards)

        if checkpoint is not None:
            checkpoint(list(all_cards.values()))

        log(f"scroll {scroll_index + 1}/{max_scrolls}: collected {after_count} note links")

        if after_count == before_count:
            unchanged_rounds += 1
        else:
            unchanged_rounds = 0

        if unchanged_rounds >= stable_rounds:
            if not full_discovery:
                break
            log(
                "discovery plateau reached; full-discovery mode keeps scrolling "
                f"through {max_scrolls} rounds"
            )
            unchanged_rounds = 0
            # A short upward probe helps wake virtualized result feeds before
            # returning to the downward full-discovery pass.
            scroll_search_results(page, -900)
            try:
                page.wait_for_timeout(700)
            except Error as exc:
                if is_navigation_context_error(exc):
                    wait_for_search_page_to_settle(page)
                    continue
                raise

        scrolled = scroll_search_results(page, 2600)
        if not scrolled:
            continue
        try:
            page.wait_for_timeout(round(1000 * next_collection_delay(
                speed_mode,
                note_delay_seconds,
                random_delay_min_seconds,
                random_delay_max_seconds,
            )))
        except Error as exc:
            if is_navigation_context_error(exc):
                log("search page navigated after scroll; waiting and retrying this scroll step")
                wait_for_search_page_to_settle(page)
                continue
            raise

    return list(all_cards.values()), False


def scroll_search_results(page: Page, delta_y: int) -> bool:
    try:
        page.mouse.wheel(0, delta_y)
        return True
    except Error as exc:
        if is_navigation_context_error(exc):
            log("search page navigated during mouse wheel; waiting before retrying scroll")
            wait_for_search_page_to_settle(page)
            return False
        if "Input.dispatchMouseEvent" not in str(exc):
            raise
        log("mouse wheel timed out; falling back to DOM scroll")

    try:
        page.evaluate(
            """(distance) => {
                const target =
                  document.scrollingElement ||
                  document.querySelector('[class*=scroll]') ||
                  document.body;
                if (target && typeof target.scrollBy === 'function') {
                  target.scrollBy(0, distance);
                } else {
                  window.scrollBy(0, distance);
                }
            }""",
            delta_y,
        )
        return True
    except Error as exc:
        if is_navigation_context_error(exc):
            log("search page navigated during DOM scroll; waiting before retrying scroll")
            wait_for_search_page_to_settle(page)
            return False
        raise


def extract_note_payload(page: Page) -> dict[str, Any]:
    return page.evaluate(
        r"""
() => {
  function normalizeText(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  function firstText(selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (!node) continue;
      const text = normalizeText(node.innerText || node.textContent || '');
      if (text) return text;
    }
    return '';
  }

  function firstHtml(selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (!node) continue;
      const html = (node.innerHTML || '').trim();
      if (html) return html;
    }
    return '';
  }

  function collectCounts() {
    const values = [];
    for (const node of document.querySelectorAll('.interact-container .count')) {
      const text = normalizeText(node.innerText || node.textContent || '');
      if (text) values.push(text);
    }
    return values;
  }

  function collectTags() {
    const tags = [];
    for (const node of document.querySelectorAll('a, span, div')) {
      const text = normalizeText(node.innerText || node.textContent || '');
      if (!text.startsWith('#')) continue;
      if (text.length < 2 || text.length > 50) continue;
      tags.push(text);
      if (tags.length >= 50) break;
    }
    return [...new Set(tags)];
  }

  function collectDetailImages() {
    const images = [];
    const selectors = [
      '.note-content img',
      '.note-slider img',
      '.swiper img',
      '#noteContainer img',
      '[class*=note-content] img',
      'article img',
    ];
    for (const node of document.querySelectorAll(selectors.join(','))) {
      const source = node.currentSrc || node.getAttribute('src') || node.getAttribute('data-src') || '';
      if (!source || source.startsWith('data:') || source.startsWith('blob:')) continue;
      const width = Number(node.naturalWidth || node.width || 0);
      const height = Number(node.naturalHeight || node.height || 0);
      if (width && height && (width < 180 || height < 180)) continue;
      let url = source;
      try {
        url = new URL(source, location.href).toString();
      } catch {
        // Keep the original URL when the browser cannot normalize it.
      }
      images.push({ url, alt: normalizeText(node.getAttribute('alt') || '') });
      if (images.length >= 20) break;
    }
    return [...new Map(images.map((item) => [item.url, item])).values()];
  }

  function authorProfile() {
    const node = document.querySelector('.author-container a, .author a');
    if (!node) return '';
    const href = node.getAttribute('href') || '';
    if (!href) return '';
    try {
      return new URL(href, location.href).toString();
    } catch {
      return href;
    }
  }

  const titleSelectors = [
    '#detail-title',
    'h1',
    '[class*=title]',
    '[class*=Title]',
  ];
  const bodySelectors = [
    '#detail-desc',
    '.note-content',
    '.note-scroller',
    '#noteContainer',
    '[class*=note-content]',
    '[class*=desc]',
    'article',
  ];
  const authorSelectors = [
    '.author-container .name',
    '.author-wrapper .name',
    '[class*=author] .name',
    '[class*=author]',
    '[class*=user]',
  ];
  const publishSelectors = [
    '.date',
    '[class*=date]',
    '[class*=publish]',
    'time',
  ];

  const metaTitle = document.querySelector("meta[property='og:title']")?.getAttribute('content') || '';
  const counts = collectCounts();
  const detailImages = collectDetailImages();

  return {
    title: firstText(titleSelectors) || normalizeText(metaTitle),
    body: firstText(bodySelectors),
    body_html: firstHtml(bodySelectors),
    detail_image_urls: detailImages.map((item) => item.url),
    detail_image_alts: detailImages.map((item) => item.alt),
    author: firstText(authorSelectors),
    publish_time: firstText(publishSelectors),
    like_count: counts[0] || '',
    collect_count: counts[1] || '',
    comment_count: counts[2] || '',
    author_profile: authorProfile(),
    tags: collectTags(),
  };
}
"""
    )


def extract_note_from_dom(page: Page, fallback_card: dict[str, Any]) -> NoteRecord:
    payload = extract_note_payload(page)
    title = payload.get("title", "") or fallback_card.get("title", "")
    body = payload.get("body", "")
    body_html = payload.get("body_html", "")
    author = payload.get("author", "") or fallback_card.get("author", "")
    publish_time = payload.get("publish_time", "")
    like_count = payload.get("like_count", "")
    collect_count = payload.get("collect_count", "")
    comment_count = payload.get("comment_count", "")
    author_profile = payload.get("author_profile", "")
    if author_profile:
        author_profile = urljoin(page.url, author_profile)

    note_id = fallback_card.get("note_id", "")
    if not note_id:
        match = re.search(r"(?:explore|item)/([a-zA-Z0-9]+)", page.url)
        note_id = match.group(1) if match else ""

    return NoteRecord(
        note_id=note_id,
        title=title,
        author=author,
        author_profile=author_profile,
        note_url=page.url,
        publish_time=publish_time,
        like_count=like_count,
        collect_count=collect_count,
        comment_count=comment_count,
        body=body,
        body_html=body_html,
        detail_image_urls=" | ".join(payload.get("detail_image_urls", [])),
        detail_image_alts=" | ".join(payload.get("detail_image_alts", [])),
        tags=" | ".join(payload.get("tags", [])),
        source_card_text=fallback_card.get("source_card_text", ""),
        scraped_at=datetime.now().isoformat(timespec="seconds"),
        access_level="detail",
        access_status="detail_ok",
        source_search_url="",
        card_rank=int(fallback_card.get("card_rank", 0) or 0),
        card_title=fallback_card.get("title", ""),
        card_author=fallback_card.get("author", ""),
        card_author_profile=fallback_card.get("author_profile", ""),
        card_publish_time=fallback_card.get("publish_time", ""),
        card_like_count=fallback_card.get("like_count", ""),
        card_collect_count=fallback_card.get("collect_count", ""),
        card_comment_count=fallback_card.get("comment_count", ""),
        card_cover_url=fallback_card.get("card_cover_url", ""),
        card_cover_alt=fallback_card.get("card_cover_alt", ""),
        card_tags=fallback_card.get("card_tags", ""),
        card_badges=fallback_card.get("card_badges", ""),
        card_link_urls=fallback_card.get("card_link_urls", ""),
        card_image_urls=fallback_card.get("card_image_urls", ""),
        card_text_segments=fallback_card.get("card_text_segments", ""),
        card_search_result_url=fallback_card.get("search_result_url", ""),
        card_explore_url=fallback_card.get("explore_url", ""),
    )


def build_card_record(card: dict[str, Any], *, access_status: str, source_search_url: str) -> NoteRecord:
    return NoteRecord(
        note_id=card.get("note_id", ""),
        title=card.get("title", ""),
        author=card.get("author", ""),
        author_profile=card.get("author_profile", ""),
        note_url=card.get("search_result_url", "") or card.get("note_url", ""),
        publish_time=card.get("publish_time", ""),
        like_count=card.get("like_count", ""),
        collect_count=card.get("collect_count", ""),
        comment_count=card.get("comment_count", ""),
        body="",
        body_html="",
        detail_image_urls="",
        detail_image_alts="",
        tags=card.get("card_tags", ""),
        source_card_text=card.get("source_card_text", ""),
        scraped_at=datetime.now().isoformat(timespec="seconds"),
        access_level="card",
        access_status=access_status,
        source_search_url=source_search_url,
        card_rank=int(card.get("card_rank", 0) or 0),
        card_title=card.get("title", ""),
        card_author=card.get("author", ""),
        card_author_profile=card.get("author_profile", ""),
        card_publish_time=card.get("publish_time", ""),
        card_like_count=card.get("like_count", ""),
        card_collect_count=card.get("collect_count", ""),
        card_comment_count=card.get("comment_count", ""),
        card_cover_url=card.get("card_cover_url", ""),
        card_cover_alt=card.get("card_cover_alt", ""),
        card_tags=card.get("card_tags", ""),
        card_badges=card.get("card_badges", ""),
        card_link_urls=card.get("card_link_urls", ""),
        card_image_urls=card.get("card_image_urls", ""),
        card_text_segments=card.get("card_text_segments", ""),
        card_search_result_url=card.get("search_result_url", ""),
        card_explore_url=card.get("explore_url", ""),
    )


def extract_note(page: Page, fallback_card: dict[str, Any]) -> NoteRecord:
    dismiss_common_popups(page)
    for _ in range(5):
        record = extract_note_from_dom(page, fallback_card)
        if record.title or record.body or record.author:
            return record
        page.wait_for_timeout(500)
        dismiss_common_popups(page)
    return extract_note_from_dom(page, fallback_card)


def is_unavailable_record(record: NoteRecord) -> bool:
    markers = {
        "当前笔记暂时无法浏览",
        "当前内容暂时无法展示",
        "内容暂时无法展示",
    }
    haystack = " ".join(
        part for part in [record.title, record.body, record.source_card_text] if part
    )
    return any(marker in haystack for marker in markers)


def classify_detail_access(page_url: str, record: NoteRecord) -> str:
    """Classify pages that rendered HTML but did not expose a usable note body."""
    combined = unquote(
        " ".join(
            part
            for part in [page_url, record.title, record.body, record.source_card_text]
            if part
        )
    ).casefold()
    if any(marker.casefold() in combined for marker in RATE_LIMIT_MARKERS):
        return "detail_rate_limited"
    if any(marker.casefold() in combined for marker in SECURITY_VERIFICATION_MARKERS):
        return "detail_security_verification"
    if any(marker.casefold() in combined for marker in LOGIN_REQUIRED_MARKERS):
        return "detail_login_required"
    if is_unavailable_record(record) or "/404" in combined:
        return "detail_unavailable"
    if not record.body.strip():
        return "detail_empty"
    return "detail_ok"


def classify_visible_detail_restriction(page: Page, *, timeout_ms: int = 400) -> str:
    """Detect a rendered restriction before waiting for or extracting note content."""
    page_text = unquote(str(getattr(page, "url", "") or ""))
    try:
        page_text = f"{page_text} {page.locator('body').inner_text(timeout=timeout_ms)}"
    except Exception:  # noqa: BLE001
        pass
    normalized = page_text.casefold()
    if any(marker.casefold() in normalized for marker in RATE_LIMIT_MARKERS):
        return "detail_rate_limited"
    if any(marker.casefold() in normalized for marker in SECURITY_VERIFICATION_MARKERS):
        return "detail_security_verification"
    if any(marker.casefold() in normalized for marker in LOGIN_REQUIRED_MARKERS):
        return "detail_login_required"
    return ""


def scrape_note(page: Page, card: dict[str, Any], *, goto_timeout_ms: int, source_search_url: str) -> NoteRecord | None:
    started_at = time.time()
    target_url = card.get("search_result_url") or card.get("note_url", "")
    try:
        goto_started_at = time.time()
        navigation_candidates = list(dict.fromkeys(filter(None, [target_url, card.get("explore_url", "")])))
        navigation_error: Exception | None = None
        for candidate_url in navigation_candidates:
            try:
                page.goto(candidate_url, wait_until="commit", timeout=goto_timeout_ms)
                navigation_error = None
                restriction = classify_visible_detail_restriction(page)
                if restriction:
                    log(f"detail restriction detected early as {restriction}: {candidate_url}")
                    return build_card_record(
                        card,
                        access_status=restriction,
                        source_search_url=source_search_url,
                    )
                break
            except (TimeoutError, Error) as exc:
                navigation_error = exc
                try:
                    page.wait_for_timeout(250)
                except Error:
                    pass
                restriction = classify_visible_detail_restriction(page)
                if restriction:
                    log(f"detail restriction detected after navigation stall as {restriction}: {candidate_url}")
                    return build_card_record(
                        card,
                        access_status=restriction,
                        source_search_url=source_search_url,
                    )
                if card.get("note_id") and card["note_id"] in page.url:
                    navigation_error = None
                    break
                log(f"detail navigation failed, trying fallback: {candidate_url}: {exc}")
        if navigation_error is not None:
            raise navigation_error
        wait_for_note_ready(page)
        restriction = classify_visible_detail_restriction(page)
        if restriction:
            log(f"detail restriction detected before extraction as {restriction}: {target_url}")
            return build_card_record(
                card,
                access_status=restriction,
                source_search_url=source_search_url,
            )
        goto_elapsed = time.time() - goto_started_at
        log(f"detail goto finished in {goto_elapsed:.1f}s: {target_url}")

        extract_started_at = time.time()
        record = with_retries(lambda: extract_note(page, card), attempts=2, sleep_seconds=1.5)
        extract_elapsed = time.time() - extract_started_at
        total_elapsed = time.time() - started_at
        log(f"detail extract finished in {extract_elapsed:.1f}s (total {total_elapsed:.1f}s): {target_url}")
        access_status = classify_detail_access(page.url, record)
        if access_status != "detail_ok":
            log(f"detail access classified as {access_status}: {target_url}")
            return build_card_record(card, access_status=access_status, source_search_url=source_search_url)
        record.source_search_url = source_search_url
        return record
    except TimeoutError:
        log(f"timeout while opening note: {target_url}")
        return build_card_record(card, access_status="detail_timeout", source_search_url=source_search_url)
    except Error as exc:
        log(f"playwright error for {target_url}: {exc}")
        return build_card_record(card, access_status="detail_playwright_error", source_search_url=source_search_url)
    except Exception as exc:  # noqa: BLE001
        log(f"unexpected error for {target_url}: {exc}")
        return build_card_record(card, access_status="detail_unexpected_error", source_search_url=source_search_url)


def write_text_atomically(output_path: pathlib.Path, text: str, *, encoding: str) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(
        f".{output_path.name}.{os.getpid()}.{time.time_ns()}.tmp"
    )
    try:
        with temporary.open("w", encoding=encoding, newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, output_path)
    finally:
        temporary.unlink(missing_ok=True)


def write_json_payload(payload: Any, output_path: pathlib.Path) -> None:
    write_text_atomically(
        output_path,
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def write_json(records: list[NoteRecord], output_path: pathlib.Path) -> None:
    write_json_payload([asdict(record) for record in records], output_path)


def write_csv(records: list[NoteRecord], output_path: pathlib.Path) -> None:
    if not records:
        write_text_atomically(output_path, "", encoding="utf-8")
        return

    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=list(asdict(records[0]).keys()))
    writer.writeheader()
    for record in records:
        writer.writerow(asdict(record))
    write_text_atomically(output_path, buffer.getvalue(), encoding="utf-8-sig")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape Xiaohongshu search results from the active Edge session.")
    parser.add_argument("--search-url", default=SEARCH_URL)
    parser.add_argument("--relay-port", type=int, default=RELAY_PORT)
    parser.add_argument("--max-scrolls", type=int, default=40)
    parser.add_argument("--stable-rounds", type=int, default=4)
    parser.add_argument("--limit", type=int, default=0, help="Optional max note count to scrape. 0 means no cap.")
    parser.add_argument("--search-sort", choices=("latest",), default="latest")
    parser.add_argument("--max-age-days", type=int, default=14, help="Keep cards within this many days before body collection; 0 keeps all dates.")
    parser.add_argument("--goto-timeout-ms", type=int, default=45000)
    parser.add_argument("--note-delay-seconds", type=float, default=DEFAULT_NOTE_DELAY_SECONDS)
    parser.add_argument("--speed-mode", choices=("steady", "random"), default=DEFAULT_SPEED_MODE)
    parser.add_argument("--random-delay-min-seconds", type=float, default=DEFAULT_RANDOM_DELAY_MIN_SECONDS)
    parser.add_argument("--random-delay-max-seconds", type=float, default=DEFAULT_RANDOM_DELAY_MAX_SECONDS)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--use-card-cache", action="store_true")
    parser.add_argument("--cards-only", action="store_true", help="Only discover and checkpoint search-result cards.")
    parser.add_argument("--security-verification-timeout-seconds", type=int, default=600)
    parser.add_argument(
        "--output-dir",
        default=str(pathlib.Path.cwd() / "output" / "xiaohongshu-relay-scrape"),
    )
    args = parser.parse_args()
    try:
        validate_collection_pacing(
            args.speed_mode,
            args.note_delay_seconds,
            args.random_delay_min_seconds,
            args.random_delay_max_seconds,
        )
    except ValueError as exc:
        parser.error(str(exc))
    if not 0 <= args.max_age_days <= 365:
        parser.error("--max-age-days must be between 0 and 365")
    if not 60 <= args.security_verification_timeout_seconds <= 3600:
        parser.error("--security-verification-timeout-seconds must be between 60 and 3600")
    return args


def load_existing_records(path: pathlib.Path) -> list[NoteRecord]:
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log(f"Ignoring unreadable resume checkpoint {path}: {exc}")
        return []
    if not isinstance(payload, list):
        log(f"Ignoring invalid resume checkpoint {path}: expected a JSON array.")
        return []
    records: list[NoteRecord] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        normalized = dict(item)
        for field_name in NoteRecord.__dataclass_fields__:
            normalized.setdefault(field_name, "" if field_name != "card_rank" else 0)
        records.append(NoteRecord(**normalized))
    return records


def is_complete_resume_record(record: NoteRecord) -> bool:
    return (
        record.access_status == "detail_ok"
        and classify_detail_access(record.note_url, record) == "detail_ok"
    )


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    args = parse_args()
    output_dir = pathlib.Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    latest_json = output_dir / "xiaohongshu_notes_latest.json"
    latest_csv = output_dir / "xiaohongshu_notes_latest.csv"
    latest_cards_json = output_dir / "xiaohongshu_cards_latest.json"
    discovered_cards_json = output_dir / "xiaohongshu_cards_discovered.json"
    security_restriction_json = output_dir / "security-restriction.json"
    security_restriction_json.unlink(missing_ok=True)

    log("Connecting to the active Edge relay...")
    with sync_playwright() as playwright:
        browser = connect_browser(playwright, args.relay_port)
        context = get_or_create_context(browser)

        log("Opening search page in the existing browser context...")
        search_page = open_search_page(context, args.search_url)
        dismiss_common_popups(search_page)
        if has_login_wall(search_page):
            log("Detected Xiaohongshu login wall in the current browser profile.")
            log("Please log into Xiaohongshu in the Edge browser profile first, then rerun the scraper.")
            return 2

        if not wait_for_search_security_clearance(search_page, args.security_verification_timeout_seconds):
            if not latest_cards_json.exists():
                write_json_payload([], latest_cards_json)
            write_json_payload(
                {
                    "schemaVersion": 1,
                    "status": "timed_out",
                    "phase": "search_discovery",
                    "timeoutSeconds": args.security_verification_timeout_seconds,
                    "recoveryAction": "manual_verification_then_resume",
                },
                security_restriction_json,
            )
            return 3

        if should_apply_live_search_sort(args.use_card_cache):
            log("Selecting latest-first search order before collection...")
            select_latest_sort(search_page)
        else:
            log("Resume checkpoint keeps its verified latest-first source card order.")

        security_timed_out = False
        card_cache_json = discovered_cards_json if discovered_cards_json.exists() else latest_cards_json
        if args.use_card_cache and card_cache_json.exists():
            cards = json.loads(card_cache_json.read_text(encoding="utf-8"))
            log(f"Loaded {len(cards)} cached note links.")
        else:
            log("Collecting note links from the search results...")
            cards, security_timed_out = collect_note_links(
                search_page,
                max_scrolls=args.max_scrolls,
                stable_rounds=args.stable_rounds,
                speed_mode=args.speed_mode,
                note_delay_seconds=args.note_delay_seconds,
                random_delay_min_seconds=args.random_delay_min_seconds,
                random_delay_max_seconds=args.random_delay_max_seconds,
                security_verification_timeout_seconds=args.security_verification_timeout_seconds,
                full_discovery=args.limit <= 0 and args.max_age_days <= 0,
                checkpoint=lambda discovered: (
                    write_json_payload(discovered, discovered_cards_json),
                    write_json_payload(discovered, latest_cards_json),
                ),
            )
            if security_timed_out:
                write_json_payload(
                    {
                        "schemaVersion": 1,
                        "status": "timed_out",
                        "phase": "search_discovery",
                        "timeoutSeconds": args.security_verification_timeout_seconds,
                        "recoveryAction": "manual_verification_then_resume",
                    },
                    security_restriction_json,
                )
        write_json_payload(cards, discovered_cards_json)
        effective_max_age_days = collection_max_age_days(args.limit, args.max_age_days)
        cards, removed_count, unknown_count = filter_cards_by_recency(cards, effective_max_age_days)
        if effective_max_age_days > 0:
            log(
                f"Recency filter kept {len(cards)} cards within {effective_max_age_days} days; "
                f"removed {removed_count} older cards; kept {unknown_count} cards with unknown dates."
            )
        else:
            log(f"Full collection kept all {len(cards)} discovered cards for body collection.")
        write_json_payload(cards, latest_cards_json)
        if security_timed_out:
            return 3
        if not cards:
            if has_login_wall(search_page):
                log("No note links were found because Xiaohongshu is asking for login.")
                return 2
            log("No note links were found.")
            return 1

        if args.cards_only:
            log(f"CARD_DISCOVERY complete={len(cards)}; detail access delegated to guarded body completion")
            return 0

        records: list[NoteRecord] = []
        seen_ids: set[str] = set()
        if args.resume and latest_json.exists():
            loaded_records = load_existing_records(latest_json)
            records = [record for record in loaded_records if is_complete_resume_record(record)]
            if args.search_sort == "latest" or args.max_age_days > 0:
                records = [record for record in records if resume_record_matches_cards(record, cards)]
            retry_count = len(loaded_records) - len(records)
            seen_ids = {record.note_id for record in records if record.note_id}
            log(f"Loaded {len(records)} complete existing records for resume; retrying {retry_count} failed records.")

        target_total_records = args.limit if args.limit > 0 else None
        if target_total_records is not None and len(records) >= target_total_records:
            log(f"Already have {len(records)} records, meeting the requested limit {target_total_records}.")
            return 0

        log(f"Collected {len(cards)} note links. Starting note extraction...")
        detail_page = context.new_page()
        source_search_url = search_page.url
        for index, card in enumerate(cards, start=1):
            if card["note_id"] and card["note_id"] in seen_ids:
                log(f"Skipping existing note {index}/{len(cards)}: {card['note_url']}")
                log(f"NOTE_PROGRESS processed={index} total={len(cards)} saved={len(records)} status=cached")
                continue
            log(f"Scraping note {index}/{len(cards)}: {card['note_url']}")
            record = scrape_note(
                detail_page,
                card,
                goto_timeout_ms=args.goto_timeout_ms,
                source_search_url=source_search_url,
            )
            if record is None:
                log(f"NOTE_PROGRESS processed={index} total={len(cards)} saved={len(records)} status=failed")
                continue
            if not (record.title or record.source_card_text or record.card_text_segments):
                log(f"Skipping empty record {index}/{len(cards)}: {card['note_url']}")
                log(f"NOTE_PROGRESS processed={index} total={len(cards)} saved={len(records)} status=empty")
                continue
            records.append(record)
            if record.note_id:
                seen_ids.add(record.note_id)
            progress_status = "saved" if is_complete_resume_record(record) else record.access_status
            log(
                f"NOTE_PROGRESS processed={index} total={len(cards)} "
                f"saved={len(records)} status={progress_status}"
            )
            if len(records) % CHECKPOINT_EVERY == 0:
                write_json(records, latest_json)
                write_csv(records, latest_csv)
            if target_total_records is not None and len(records) >= target_total_records:
                break
            time.sleep(next_collection_delay(
                args.speed_mode,
                args.note_delay_seconds,
                args.random_delay_min_seconds,
                args.random_delay_max_seconds,
            ))

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        json_path = output_dir / f"xiaohongshu_notes_{timestamp}.json"
        csv_path = output_dir / f"xiaohongshu_notes_{timestamp}.csv"

        write_json(records, json_path)
        write_csv(records, csv_path)
        write_json(records, latest_json)
        write_csv(records, latest_csv)
        detail_page.close()

        complete_count = sum(is_complete_resume_record(record) for record in records)
        retryable_count = len(records) - complete_count
        log(
            f"DETAIL_SUMMARY complete={complete_count} retryable={retryable_count} "
            f"total={len(records)}"
        )
        log(f"Saved {len(records)} notes to {json_path}")
        log(f"Saved {len(records)} notes to {csv_path}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
