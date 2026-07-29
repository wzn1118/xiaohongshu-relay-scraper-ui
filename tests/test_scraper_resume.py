from __future__ import annotations

import importlib.util
import sys
from datetime import datetime
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "vendor" / "xiaohongshu-relay-scrape" / "scripts" / "scrape_xiaohongshu_search.py"
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("xhs_scraper", SCRIPT)
assert SPEC and SPEC.loader
SCRAPER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SCRAPER
SPEC.loader.exec_module(SCRAPER)


def make_record(status: str, **overrides):
    values = {
        field: (0 if field == "card_rank" else "")
        for field in SCRAPER.NoteRecord.__dataclass_fields__
    }
    values["access_status"] = status
    values.update(overrides)
    return SCRAPER.NoteRecord(**values)


def test_resume_retries_failed_detail_records() -> None:
    assert SCRAPER.is_complete_resume_record(make_record("detail_ok", body="完整正文"))
    assert not SCRAPER.is_complete_resume_record(
        make_record("detail_ok", body="访问频繁，请稍后再试")
    )
    assert not SCRAPER.is_complete_resume_record(make_record("detail_ok", body=""))
    assert not SCRAPER.is_complete_resume_record(make_record("detail_timeout"))
    assert not SCRAPER.is_complete_resume_record(make_record("detail_playwright_error"))
    assert not SCRAPER.is_complete_resume_record(make_record("detail_rate_limited"))
    assert not SCRAPER.is_complete_resume_record(make_record("detail_security_verification"))


class FakeSortPage:
    def __init__(self, *, has_filter: bool = True) -> None:
        self.has_filter = has_filter
        self.panel_open = False
        self.latest_selected = False
        self.timeouts: list[int] = []

    def evaluate(self, script: str):
        if script == SCRAPER.VISIBLE_CARD_IDS_JS:
            return ["before-note"]
        if script == SCRAPER.OPEN_FILTER_PANEL_JS:
            self.panel_open = self.has_filter
            return self.has_filter
        if script == SCRAPER.LATEST_SORT_SELECTED_JS:
            return self.latest_selected
        if script == SCRAPER.CLICK_LATEST_SORT_JS:
            if not self.panel_open:
                return False
            self.latest_selected = True
            return True
        if script == SCRAPER.CLOSE_FILTER_PANEL_JS:
            self.panel_open = False
            return True
        raise AssertionError(f"Unexpected script: {script[:80]}")

    def wait_for_function(self, script: str, **_kwargs) -> None:
        if script == SCRAPER.LATEST_SORT_SELECTED_JS:
            assert self.latest_selected
        elif "Boolean(document.querySelector('.filter-panel'))" in script:
            assert self.panel_open
        elif "!document.querySelector('.filter-panel')" in script:
            assert not self.panel_open

    def wait_for_timeout(self, milliseconds: int) -> None:
        self.timeouts.append(milliseconds)


def test_latest_sort_is_selected_and_verified(monkeypatch) -> None:
    page = FakeSortPage()
    monkeypatch.setattr(SCRAPER, "wait_for_search_results", lambda _page: None)

    SCRAPER.select_latest_sort(page)

    assert page.latest_selected
    assert not page.panel_open


def test_latest_sort_stops_before_scraping_when_filter_is_missing(monkeypatch) -> None:
    page = FakeSortPage(has_filter=False)
    monkeypatch.setattr(SCRAPER, "wait_for_search_results", lambda _page: None)

    try:
        SCRAPER.select_latest_sort(page)
    except RuntimeError as error:
        assert "latest-first sorting was not applied" in str(error)
    else:
        raise AssertionError("Missing latest-sort control must stop collection")


def test_recency_filter_removes_old_cards_and_keeps_unknown_dates() -> None:
    now = datetime(2026, 7, 29, 12, 0)
    cards = [
        {"note_id": "recent", "source_card_text": "招聘实习生 昨天 10:20"},
        {"note_id": "old", "source_card_text": "招聘实习生 05-18 上海"},
        {"note_id": "unknown", "source_card_text": "招聘实习生 发布时间待确认"},
    ]

    kept, removed, unknown = SCRAPER.filter_cards_by_recency(cards, 30, now)

    assert [card["note_id"] for card in kept] == ["recent", "unknown"]
    assert removed == 1
    assert unknown == 1


def test_latest_resume_only_reuses_records_still_present_in_live_cards() -> None:
    cards = [{"note_id": "current", "note_url": "https://example.test/current"}]

    assert SCRAPER.resume_record_matches_cards(make_record("detail_ok", note_id="current", body="正文"), cards)
    assert not SCRAPER.resume_record_matches_cards(make_record("detail_ok", note_id="old", body="正文"), cards)


@pytest.mark.parametrize(
    ("url", "title", "body", "expected"),
    [
        (
            "https://example.test/website-login/error?error_code=300013&error_msg=%E8%AE%BF%E9%97%AE%E9%A2%91%E7%B9%81",
            "",
            "访问频繁，请稍后再试",
            "detail_rate_limited",
        ),
        ("https://example.test/captcha", "安全验证", "请完成验证后继续", "detail_security_verification"),
        ("https://example.test/login", "手机号登录", "", "detail_login_required"),
        ("https://example.test/explore/abc", "岗位招聘", "", "detail_empty"),
        ("https://example.test/explore/abc", "岗位招聘", "完整岗位正文", "detail_ok"),
    ],
)
def test_detail_access_classification(url: str, title: str, body: str, expected: str) -> None:
    record = make_record("detail_ok", title=title, body=body)

    assert SCRAPER.classify_detail_access(url, record) == expected


def test_atomic_write_preserves_existing_checkpoint_when_replace_fails(tmp_path, monkeypatch) -> None:
    checkpoint = tmp_path / "checkpoint.json"
    checkpoint.write_text("old", encoding="utf-8")

    def fail_replace(_source, _destination) -> None:
        raise OSError("simulated replace failure")

    monkeypatch.setattr(SCRAPER.os, "replace", fail_replace)

    with pytest.raises(OSError, match="simulated replace failure"):
        SCRAPER.write_text_atomically(checkpoint, "new", encoding="utf-8")

    assert checkpoint.read_text(encoding="utf-8") == "old"
    assert list(tmp_path.glob("*.tmp")) == []


def test_unreadable_resume_checkpoint_is_recollected(tmp_path) -> None:
    checkpoint = tmp_path / "checkpoint.json"
    checkpoint.write_text("[truncated", encoding="utf-8")

    assert SCRAPER.load_existing_records(checkpoint) == []


class FakeNavigationPage:
    def __init__(self, *, closed: bool = False) -> None:
        self.closed = closed
        self.url = "https://www.xiaohongshu.com/search_result"
        self.goto_calls = 0

    def is_closed(self) -> bool:
        return self.closed

    def goto(self, url: str, **_kwargs) -> None:
        self.goto_calls += 1
        if self.closed:
            raise RuntimeError("Target page has been closed")
        self.url = url


class FakeNavigationContext:
    def __init__(self, replacement: FakeNavigationPage) -> None:
        self.replacement = replacement
        self.new_page_calls = 0

    def new_page(self) -> FakeNavigationPage:
        self.new_page_calls += 1
        return self.replacement


def test_search_navigation_replaces_a_stale_reusable_page(monkeypatch) -> None:
    stale = FakeNavigationPage(closed=True)
    replacement = FakeNavigationPage()
    context = FakeNavigationContext(replacement)
    monkeypatch.setattr(SCRAPER, "get_reusable_page", lambda _context: stale)
    monkeypatch.setattr(SCRAPER, "wait_for_search_results", lambda _page: None)

    selected = SCRAPER.open_search_page(context, "https://www.xiaohongshu.com/search_result?keyword=test")

    assert selected is replacement
    assert context.new_page_calls == 1
    assert replacement.goto_calls == 1


class FakeRestrictionBody:
    def __init__(self, page) -> None:
        self.page = page

    def inner_text(self, **_kwargs) -> str:
        return self.page.body_text


class FakeRestrictionPage:
    def __init__(self, body_text: str) -> None:
        self.url = "https://www.xiaohongshu.com/search_result"
        self.body_text = body_text
        self.waits = 0

    def locator(self, selector: str):
        assert selector == "body"
        return FakeRestrictionBody(self)

    def wait_for_timeout(self, _milliseconds: int) -> None:
        self.waits += 1
        self.body_text = "岗位搜索结果"


def test_search_security_restriction_is_detected_without_new_navigation() -> None:
    page = FakeRestrictionPage("请完成安全验证后继续")

    assert SCRAPER.search_security_restriction(page) == "security_verification"


def test_search_security_clearance_resumes_after_manual_completion(monkeypatch) -> None:
    page = FakeRestrictionPage("请完成安全验证后继续")
    monotonic_values = iter((0.0, 0.0, 1.0))
    monkeypatch.setattr(SCRAPER.time, "monotonic", lambda: next(monotonic_values))
    monkeypatch.setattr(SCRAPER, "wait_for_search_results", lambda _page: None)

    assert SCRAPER.wait_for_search_security_clearance(page, 60)
    assert page.waits == 1


def test_search_security_timeout_returns_discovered_cards_and_checkpoint(monkeypatch) -> None:
    page = FakeRestrictionPage("")
    clearance = iter((True, False))
    checkpoints: list[list[dict]] = []
    monkeypatch.setattr(SCRAPER, "wait_for_search_security_clearance", lambda *_args: next(clearance))
    monkeypatch.setattr(SCRAPER, "dismiss_common_popups", lambda _page: None)
    monkeypatch.setattr(
        SCRAPER,
        "extract_cards",
        lambda _page: [{"note_id": "n1", "note_url": "https://example.test/n1"}],
    )
    monkeypatch.setattr(SCRAPER, "scroll_search_results", lambda *_args: True)
    monkeypatch.setattr(SCRAPER, "next_collection_delay", lambda *_args: 0)

    cards, timed_out = SCRAPER.collect_note_links(
        page,
        max_scrolls=2,
        stable_rounds=2,
        speed_mode="steady",
        note_delay_seconds=1,
        random_delay_min_seconds=1,
        random_delay_max_seconds=2,
        security_verification_timeout_seconds=60,
        checkpoint=lambda items: checkpoints.append(items),
    )

    assert timed_out
    assert cards == [{"note_id": "n1", "note_url": "https://example.test/n1"}]
    assert checkpoints == [cards]
