import argparse
import csv
import hashlib
import hmac
import json
import os
import pathlib
import re
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any
from urllib.parse import urljoin

from playwright.sync_api import Browser, BrowserContext, Error, Page, TimeoutError, sync_playwright

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


def connect_browser(playwright, relay_port: int) -> Browser:
    endpoint = f"http://127.0.0.1:{relay_port}"
    headers = get_relay_headers(relay_port)
    if headers:
        return playwright.chromium.connect_over_cdp(endpoint, headers=headers, timeout=120000)
    return playwright.chromium.connect_over_cdp(endpoint, timeout=120000)


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


def get_reusable_page(context: BrowserContext) -> Page:
    logged_in_xiaohongshu_pages: list[tuple[int, Page]] = []
    xiaohongshu_pages: list[tuple[int, Page]] = []
    fallback_pages: list[tuple[int, Page]] = []

    for page in context.pages:
        url = page.url or ""
        priority = page_reuse_priority(url)
        if "xiaohongshu.com" in url:
            try:
                page.wait_for_load_state("domcontentloaded", timeout=1500)
            except Exception:  # noqa: BLE001
                pass
            if not has_login_wall(page):
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
    try:
        def navigate() -> None:
            page.goto(search_url, wait_until="domcontentloaded", timeout=120000)

        with_retries(navigate, attempts=3, sleep_seconds=2.0)
        wait_for_search_results(page)
        return page
    except Exception as exc:  # noqa: BLE001
        log(f"direct goto failed ({exc}); falling back to location.href navigation")

    page.evaluate("(url) => { location.href = url; }", search_url)
    deadline = time.time() + 30
    while time.time() < deadline:
        if "xiaohongshu.com/search_result" in (page.url or ""):
            wait_for_search_results(page)
            return page
        page.wait_for_timeout(1000)

    raise RuntimeError("Search page navigation did not settle in time.")


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
    selectors = [
        "#detail-title",
        "#detail-desc",
        ".note-content",
        "article",
        "h1",
    ]
    for selector in selectors:
        try:
            page.locator(selector).first.wait_for(state="visible", timeout=1800)
            page.wait_for_timeout(250)
            return
        except Exception:  # noqa: BLE001
            continue
    page.wait_for_timeout(900)


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
      publish_time: '',
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


def collect_note_links(
    page: Page,
    *,
    max_scrolls: int,
    stable_rounds: int,
    speed_mode: str,
    note_delay_seconds: float,
    random_delay_min_seconds: float,
    random_delay_max_seconds: float,
) -> list[dict[str, Any]]:
    all_cards: dict[str, dict[str, Any]] = {}
    unchanged_rounds = 0

    for scroll_index in range(max_scrolls):
        dismiss_common_popups(page)
        try:
            cards = extract_cards(page)
        except Error as exc:
            if is_navigation_context_error(exc):
                log("search page navigated during collection; waiting and retrying this scroll step")
                wait_for_search_page_to_settle(page)
                continue
            raise
        before_count = len(all_cards)
        for card in cards:
            if card["note_url"] not in all_cards:
                all_cards[card["note_url"]] = card
        after_count = len(all_cards)

        log(f"scroll {scroll_index + 1}/{max_scrolls}: collected {after_count} note links")

        if after_count == before_count:
            unchanged_rounds += 1
        else:
            unchanged_rounds = 0

        if unchanged_rounds >= stable_rounds:
            break

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

    return list(all_cards.values())


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

  return {
    title: firstText(titleSelectors) || normalizeText(metaTitle),
    body: firstText(bodySelectors),
    body_html: firstHtml(bodySelectors),
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


def scrape_note(page: Page, card: dict[str, Any], *, goto_timeout_ms: int, source_search_url: str) -> NoteRecord | None:
    started_at = time.time()
    target_url = card.get("search_result_url") or card.get("note_url", "")
    try:
        goto_started_at = time.time()
        page.goto(target_url, wait_until="domcontentloaded", timeout=goto_timeout_ms)
        goto_elapsed = time.time() - goto_started_at
        log(f"detail goto finished in {goto_elapsed:.1f}s: {target_url}")

        extract_started_at = time.time()
        record = with_retries(lambda: extract_note(page, card), attempts=2, sleep_seconds=1.5)
        extract_elapsed = time.time() - extract_started_at
        total_elapsed = time.time() - started_at
        log(f"detail extract finished in {extract_elapsed:.1f}s (total {total_elapsed:.1f}s): {target_url}")
        if is_unavailable_record(record):
            return build_card_record(card, access_status="detail_unavailable", source_search_url=source_search_url)
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


def write_json(records: list[NoteRecord], output_path: pathlib.Path) -> None:
    payload = [asdict(record) for record in records]
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def write_csv(records: list[NoteRecord], output_path: pathlib.Path) -> None:
    if not records:
        output_path.write_text("", encoding="utf-8")
        return

    with output_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(asdict(records[0]).keys()))
        writer.writeheader()
        for record in records:
            writer.writerow(asdict(record))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape Xiaohongshu search results from the active Edge session.")
    parser.add_argument("--search-url", default=SEARCH_URL)
    parser.add_argument("--relay-port", type=int, default=RELAY_PORT)
    parser.add_argument("--max-scrolls", type=int, default=40)
    parser.add_argument("--stable-rounds", type=int, default=4)
    parser.add_argument("--limit", type=int, default=0, help="Optional max note count to scrape. 0 means no cap.")
    parser.add_argument("--goto-timeout-ms", type=int, default=45000)
    parser.add_argument("--note-delay-seconds", type=float, default=DEFAULT_NOTE_DELAY_SECONDS)
    parser.add_argument("--speed-mode", choices=("steady", "random"), default=DEFAULT_SPEED_MODE)
    parser.add_argument("--random-delay-min-seconds", type=float, default=DEFAULT_RANDOM_DELAY_MIN_SECONDS)
    parser.add_argument("--random-delay-max-seconds", type=float, default=DEFAULT_RANDOM_DELAY_MAX_SECONDS)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--use-card-cache", action="store_true")
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
    return args


def load_existing_records(path: pathlib.Path) -> list[NoteRecord]:
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    records: list[NoteRecord] = []
    for item in payload:
        normalized = dict(item)
        for field_name in NoteRecord.__dataclass_fields__:
            normalized.setdefault(field_name, "" if field_name != "card_rank" else 0)
        records.append(NoteRecord(**normalized))
    return records


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    args = parse_args()
    output_dir = pathlib.Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    latest_json = output_dir / "xiaohongshu_notes_latest.json"
    latest_csv = output_dir / "xiaohongshu_notes_latest.csv"
    latest_cards_json = output_dir / "xiaohongshu_cards_latest.json"

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

        if args.use_card_cache and latest_cards_json.exists():
            cards = json.loads(latest_cards_json.read_text(encoding="utf-8"))
            log(f"Loaded {len(cards)} cached note links.")
        else:
            log("Collecting note links from the search results...")
            cards = collect_note_links(
                search_page,
                max_scrolls=args.max_scrolls,
                stable_rounds=args.stable_rounds,
                speed_mode=args.speed_mode,
                note_delay_seconds=args.note_delay_seconds,
                random_delay_min_seconds=args.random_delay_min_seconds,
                random_delay_max_seconds=args.random_delay_max_seconds,
            )
            latest_cards_json.write_text(
                json.dumps(cards, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        if not cards:
            if has_login_wall(search_page):
                log("No note links were found because Xiaohongshu is asking for login.")
                return 2
            log("No note links were found.")
            return 1

        records: list[NoteRecord] = []
        seen_ids: set[str] = set()
        if args.resume and latest_json.exists():
            records = load_existing_records(latest_json)
            seen_ids = {record.note_id for record in records if record.note_id}
            log(f"Loaded {len(records)} existing records for resume.")

        target_total_records = args.limit if args.limit > 0 else None
        if target_total_records is not None and len(records) >= target_total_records:
            log(f"Already have {len(records)} records, meeting the requested limit {target_total_records}.")
            return 0

        log(f"Collected {len(cards)} note links. Starting note extraction...")
        detail_page = search_page
        source_search_url = search_page.url
        for index, card in enumerate(cards, start=1):
            if card["note_id"] and card["note_id"] in seen_ids:
                log(f"Skipping existing note {index}/{len(cards)}: {card['note_url']}")
                continue
            log(f"Scraping note {index}/{len(cards)}: {card['note_url']}")
            record = scrape_note(
                detail_page,
                card,
                goto_timeout_ms=args.goto_timeout_ms,
                source_search_url=source_search_url,
            )
            if record is None:
                continue
            if not (record.title or record.source_card_text or record.card_text_segments):
                log(f"Skipping empty record {index}/{len(cards)}: {card['note_url']}")
                continue
            records.append(record)
            if record.note_id:
                seen_ids.add(record.note_id)
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

        log(f"Saved {len(records)} notes to {json_path}")
        log(f"Saved {len(records)} notes to {csv_path}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
