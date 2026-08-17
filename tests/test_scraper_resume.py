from __future__ import annotations

import importlib.util
import sys
from datetime import datetime
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SCRIPT = ROOT / "vendor" / "xiaohongshu-relay-scrape" / "scripts" / "scrape_xiaohongshu_search.py"
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("xhs_scraper", SCRIPT)
assert SPEC and SPEC.loader
SCRAPER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SCRAPER
SPEC.loader.exec_module(SCRAPER)

import run_project_workflow as WORKFLOW  # noqa: E402


def make_record(status: str, **overrides):
    values = {
        field: (0 if field == "card_rank" else "")
        for field in SCRAPER.NoteRecord.__dataclass_fields__
    }
    values["access_status"] = status
    values.update(overrides)
    return SCRAPER.NoteRecord(**values)


def test_wrapper_accepts_repeatable_resume_checkpoint_directories() -> None:
    options, remaining = WORKFLOW.parse_wrapper_args([
        "--resume-scope", "audience",
        "--resume-checkpoint-dir", "C:/jobs/legacy-1",
        "--resume-checkpoint-dir=C:/jobs/legacy-2",
    ])

    assert options.resume_checkpoint_dir == ["C:/jobs/legacy-1", "C:/jobs/legacy-2"]
    assert remaining == []


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


def test_discovery_identity_deduplicates_query_variants_and_keeps_richer_url() -> None:
    first = {
        "note_id": "n1",
        "note_url": "https://www.xiaohongshu.com/search_result/n1?xsec_source=",
        "card_rank": 8,
        "title": "同一篇内容",
    }
    second = {
        "note_id": "n1",
        "note_url": "https://www.xiaohongshu.com/search_result/n1?xsec_source=pc_search",
        "card_rank": 12,
        "card_cover_url": "https://img.example/n1.webp",
    }

    assert SCRAPER.card_identity(first) == SCRAPER.card_identity(second) == "note:n1"
    merged = SCRAPER.merge_discovered_cards(first, second)
    assert merged["note_url"].endswith("xsec_source=pc_search")
    assert merged["card_rank"] == 8
    assert merged["card_cover_url"] == "https://img.example/n1.webp"


def test_search_request_match_requires_the_requested_keyword() -> None:
    expected = "https://www.xiaohongshu.com/search_result/?keyword=%E9%95%BF%E5%8F%91%E7%94%B7&type=51"
    assert SCRAPER.search_request_matches(
        "https://www.xiaohongshu.com/search_result?keyword=%E9%95%BF%E5%8F%91%E7%94%B7&source=web_note_detail_r10",
        expected,
    )
    assert not SCRAPER.search_request_matches(
        "https://www.xiaohongshu.com/search_result/?keyword=%E7%9F%AD%E5%8F%91%E5%A5%B3",
        expected,
    )


def test_failed_discovery_retries_body_checkpoint_when_cards_are_available(tmp_path, monkeypatch) -> None:
    calls = {}

    def fake_complete_bodies(output_dir, **kwargs):
        calls["output_dir"] = output_dir
        calls["kwargs"] = kwargs
        return {"collectionStatus": "partial", "missingBodies": 1}

    monkeypatch.setattr(WORKFLOW, "complete_bodies", fake_complete_bodies)

    summary = WORKFLOW.collect_body_checkpoint(
        tmp_path,
        scrape_failed=True,
        checkpoint_fallback=True,
        relay_port=18800,
        goto_timeout_ms=15000,
        security_verification_timeout_seconds=600,
        speed_mode="random",
        note_delay_seconds=1.2,
        random_delay_min_seconds=0.8,
        random_delay_max_seconds=2.4,
        upstream_scraper=SCRIPT,
    )

    assert summary["collectionStatus"] == "partial"
    assert calls["output_dir"] == tmp_path
    assert calls["kwargs"]["workers"] == 1
    assert calls["kwargs"]["attempts"] == 3
    assert calls["kwargs"]["speed_mode"] == "random"


def test_security_restriction_target_detection() -> None:
    assert SCRAPER.is_security_restriction_target({"url": "https://example.test/website-login/error?error_code=300013"})
    assert not SCRAPER.is_security_restriction_target({"url": "https://example.test/search_result/?keyword=test"})


def test_relay_cleanup_closes_restricted_target_when_search_target_remains(monkeypatch) -> None:
    responses = {
        "/json/list": [
            {"id": "blocked", "type": "page", "url": "https://example.test/website-login/error?error_code=300013"},
            {"id": "search", "type": "page", "url": "https://example.test/search_result/?keyword=test"},
        ],
        "/json/version": {"webSocketDebuggerUrl": "ws://127.0.0.1:18800/devtools/browser/test"},
    }
    sent: list[dict] = []

    class FakeSocket:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def send(self, payload: str) -> None:
            sent.append(__import__("json").loads(payload))

        def recv(self, **_kwargs) -> str:
            return '{"id": 1, "result": {"success": true}}'

    monkeypatch.setattr(SCRAPER, "get_relay_headers", lambda _port: {"x-openclaw-relay-token": "token"})
    monkeypatch.setattr(SCRAPER, "fetch_relay_json", lambda _port, path, _headers, _timeout: responses[path])
    monkeypatch.setattr(SCRAPER, "websocket_connect", lambda *_args, **_kwargs: FakeSocket())

    assert SCRAPER.cleanup_security_restriction_targets(18800) == 1
    assert sent == [{"id": 1, "method": "Target.closeTarget", "params": {"targetId": "blocked"}}]


def test_relay_cleanup_fails_fast_when_only_restricted_target_remains(monkeypatch) -> None:
    monkeypatch.setattr(SCRAPER, "get_relay_headers", lambda _port: {})
    monkeypatch.setattr(
        SCRAPER,
        "fetch_relay_json",
        lambda *_args: [{"id": "blocked", "type": "page", "url": "https://example.test/website-login/error"}],
    )

    with pytest.raises(SCRAPER.RelaySecurityRestrictionError, match="only has a security-restriction page"):
        SCRAPER.cleanup_security_restriction_targets(18800)


def test_relay_target_pressure_detects_overloaded_browser_context() -> None:
    targets = [
        {"id": "search", "type": "page", "url": "https://www.xiaohongshu.com/search_result?keyword=test"},
        {"id": "detail", "type": "page", "url": "https://www.xiaohongshu.com/explore/note"},
        {"id": "other", "type": "page", "url": "https://www.douyin.com/search/test"},
        *({"id": f"worker-{index}", "type": "worker", "url": "https://example.test/worker.js"} for index in range(6)),
    ]

    pressured, reasons = SCRAPER.relay_target_pressure(targets)

    assert pressured is True
    assert "target_count" in reasons
    assert "page_count" in reasons


def test_relay_overload_reset_creates_clean_target_before_closing_old_pages(monkeypatch) -> None:
    responses = {
        "/json/list": [
            {"id": "search", "type": "page", "url": "https://www.xiaohongshu.com/search_result?keyword=test"},
            {"id": "detail", "type": "page", "url": "https://www.xiaohongshu.com/explore/note"},
            {"id": "other", "type": "page", "url": "https://www.douyin.com/search/test"},
        ],
        "/json/version": {"webSocketDebuggerUrl": "ws://127.0.0.1:18800/devtools/browser/test"},
    }
    sent: list[dict] = []

    class FakeSocket:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def send(self, payload: str) -> None:
            sent.append(__import__("json").loads(payload))

        def recv(self, **_kwargs) -> str:
            command = sent[-1]
            result = {"targetId": "clean"} if command["method"] == "Target.createTarget" else {"success": True}
            return __import__("json").dumps({"id": command["id"], "result": result})

    monkeypatch.setattr(SCRAPER, "get_relay_headers", lambda _port: {})
    monkeypatch.setattr(SCRAPER, "fetch_relay_json", lambda _port, path, _headers, _timeout: responses[path])
    monkeypatch.setattr(SCRAPER, "websocket_connect", lambda *_args, **_kwargs: FakeSocket())

    assert SCRAPER.reset_overloaded_relay_targets(18800) == 3
    assert sent[0] == {
        "id": 1,
        "method": "Target.createTarget",
        "params": {"url": "https://www.xiaohongshu.com/explore"},
    }
    assert [command["params"]["targetId"] for command in sent[1:]] == ["search", "detail", "other"]


class FakeSortPage:
    def __init__(self, *, has_filter: bool = True, panel_renders: bool = True) -> None:
        self.has_filter = has_filter
        self.panel_renders = panel_renders
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
            assert self.panel_open and self.panel_renders
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


def test_latest_sort_falls_back_when_legacy_panel_does_not_render(monkeypatch) -> None:
    page = FakeSortPage(panel_renders=False)
    settled: list[bool] = []
    monkeypatch.setattr(SCRAPER, "wait_for_search_results", lambda _page: settled.append(True))

    SCRAPER.select_latest_sort(page)

    assert not page.panel_open
    assert settled == [True]


def test_latest_sort_is_only_applied_during_live_card_discovery() -> None:
    assert SCRAPER.should_apply_live_search_sort(False)
    assert not SCRAPER.should_apply_live_search_sort(True)


def test_scraper_cli_rejects_non_latest_search_sort(monkeypatch) -> None:
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "--search-sort", "comprehensive"])
    with pytest.raises(SystemExit):
        SCRAPER.parse_args()


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


def test_full_collection_applies_recency_before_body_collection() -> None:
    assert SCRAPER.collection_max_age_days(0, 30) == 30
    assert SCRAPER.collection_max_age_days(100, 30) == 30
    assert SCRAPER.collection_max_age_days(0, 0) == 0


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


def test_navigation_stall_on_rate_limit_does_not_open_fallback(monkeypatch) -> None:
    class FakeBody:
        def inner_text(self, **_kwargs) -> str:
            return "访问频繁，请稍后再试"

    class FakePage:
        def __init__(self) -> None:
            self.url = "https://example.test/website-login/error?error_code=300013"
            self.goto_calls: list[str] = []

        def goto(self, url: str, **_kwargs) -> None:
            self.goto_calls.append(url)
            raise SCRAPER.TimeoutError("navigation stalled")

        def wait_for_timeout(self, _milliseconds: int) -> None:
            return None

        def locator(self, selector: str) -> FakeBody:
            assert selector == "body"
            return FakeBody()

    page = FakePage()
    monkeypatch.setattr(
        SCRAPER,
        "wait_for_note_ready",
        lambda _page: pytest.fail("restriction must stop before note readiness wait"),
    )
    monkeypatch.setattr(
        SCRAPER,
        "extract_note",
        lambda *_args: pytest.fail("restriction must stop before extraction"),
    )
    card = {
        "note_id": "n1",
        "search_result_url": "https://example.test/search_result/n1",
        "explore_url": "https://example.test/explore/n1",
    }

    record = SCRAPER.scrape_note(
        page,
        card,
        goto_timeout_ms=10000,
        source_search_url="https://example.test/search_result?keyword=test",
    )

    assert record is not None
    assert record.access_status == "detail_rate_limited"
    assert page.goto_calls == [card["search_result_url"]]


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


def test_atomic_write_retries_transient_windows_access_conflict(tmp_path, monkeypatch) -> None:
    checkpoint = tmp_path / "checkpoint.json"
    checkpoint.write_text("old", encoding="utf-8")
    real_replace = SCRAPER.os.replace
    calls = 0

    def flaky_replace(source, destination) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise PermissionError(SCRAPER.errno.EACCES, "locked", destination)
        real_replace(source, destination)

    monkeypatch.setattr(SCRAPER.os, "replace", flaky_replace)
    monkeypatch.setattr(SCRAPER.time, "sleep", lambda _seconds: None)

    SCRAPER.write_text_atomically(checkpoint, "new", encoding="utf-8")

    assert calls == 2
    assert checkpoint.read_text(encoding="utf-8") == "new"
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


def test_full_discovery_does_not_stop_on_stable_rounds(monkeypatch) -> None:
    page = FakeRestrictionPage("")
    extract_calls = 0
    scrolls: list[int] = []

    def extract_cards(_page):
        nonlocal extract_calls
        extract_calls += 1
        return [{"note_id": "n1", "note_url": "https://example.test/n1"}]

    monkeypatch.setattr(SCRAPER, "wait_for_search_security_clearance", lambda *_args: True)
    monkeypatch.setattr(SCRAPER, "dismiss_common_popups", lambda _page: None)
    monkeypatch.setattr(SCRAPER, "extract_cards", extract_cards)
    monkeypatch.setattr(SCRAPER, "search_security_restriction", lambda _page: "")
    monkeypatch.setattr(SCRAPER, "scroll_search_results", lambda _page, delta: scrolls.append(delta) or True)
    monkeypatch.setattr(SCRAPER, "next_collection_delay", lambda *_args: 0)

    cards, timed_out = SCRAPER.collect_note_links(
        page,
        max_scrolls=5,
        stable_rounds=2,
        speed_mode="steady",
        note_delay_seconds=0,
        random_delay_min_seconds=0,
        random_delay_max_seconds=0,
        security_verification_timeout_seconds=60,
        full_discovery=True,
    )

    assert not timed_out
    assert extract_calls == 5
    assert cards == [{"note_id": "n1", "note_url": "https://example.test/n1"}]
    assert -900 in scrolls
