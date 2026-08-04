from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (
    ROOT
    / "vendor"
    / "xiaohongshu-relay-scrape"
    / "scripts"
    / "scrape_xiaohongshu_search.py"
)
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("xhs_scraper_detail_readiness", SCRIPT)
assert SPEC and SPEC.loader
SCRAPER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SCRAPER
SPEC.loader.exec_module(SCRAPER)


def make_record(**overrides):
    values = {
        field: (0 if field == "card_rank" else "")
        for field in SCRAPER.NoteRecord.__dataclass_fields__
    }
    values.update({"access_level": "detail", "access_status": "detail_ok"})
    values.update(overrides)
    return SCRAPER.NoteRecord(**values)


class FakeBodyLocator:
    def __init__(self, page: "FakeReadinessPage") -> None:
        self.page = page

    def inner_text(self, **_kwargs) -> str:
        return self.page.current(self.page.page_texts)


class FakeReadinessPage:
    def __init__(
        self,
        *,
        body_texts: list[str],
        page_texts: list[str] | None = None,
        url: str = "https://example.test/detail",
    ) -> None:
        self.url = url
        self.body_texts = body_texts
        self.page_texts = page_texts or [""] * max(1, len(body_texts))
        self.index = 0
        self.timeouts: list[int] = []
        self.evaluate_calls = 0

    def current(self, values: list[str]) -> str:
        return values[min(self.index, len(values) - 1)]

    def locator(self, selector: str) -> FakeBodyLocator:
        assert selector == "body"
        return FakeBodyLocator(self)

    def evaluate(self, script: str) -> str:
        assert script == SCRAPER.DETAIL_BODY_TEXT_JS
        self.evaluate_calls += 1
        return self.current(self.body_texts)

    def wait_for_timeout(self, milliseconds: int) -> None:
        self.timeouts.append(milliseconds)
        self.index += 1


def test_note_readiness_waits_for_body_when_title_is_visible_first() -> None:
    page = FakeReadinessPage(
        body_texts=["短正文", "这里是延迟加载完成后的真实正文内容"],
        page_texts=["这是先出现的笔记标题", "这是先出现的笔记标题 这里是延迟加载完成后的真实正文内容"],
    )

    status = SCRAPER.wait_for_note_ready(page, timeout_ms=500, poll_interval_ms=250)

    assert status == "detail_body_ready"
    assert page.evaluate_calls == 2
    assert page.timeouts == [250]


def test_note_readiness_does_not_treat_title_or_author_as_body() -> None:
    page = FakeReadinessPage(
        body_texts=["", ""],
        page_texts=["很长的笔记标题 作者名字", "很长的笔记标题 作者名字"],
    )

    status = SCRAPER.wait_for_note_ready(page, timeout_ms=500, poll_interval_ms=250)

    assert status == "detail_wait_timeout"
    assert page.evaluate_calls == 2


@pytest.mark.parametrize(
    ("url", "page_text", "expected"),
    [
        (
            "https://example.test/website-login/error?error_code=300013",
            "访问频繁，请稍后再试",
            "detail_rate_limited",
        ),
        ("https://example.test/captcha", "安全验证", "detail_security_verification"),
        ("https://example.test/login", "手机号登录", "detail_login_required"),
        ("https://example.test/explore/n1", "当前笔记暂时无法浏览", "detail_unavailable"),
    ],
)
def test_note_readiness_stops_on_explicit_terminal_state(
    url: str,
    page_text: str,
    expected: str,
) -> None:
    page = FakeReadinessPage(body_texts=[""], page_texts=[page_text], url=url)

    assert SCRAPER.wait_for_note_ready(page) == expected
    assert page.evaluate_calls == 0
    assert page.timeouts == []


def payload(body: str) -> dict:
    return {
        "title": "",
        "body": body,
        "body_html": f"<p>{body}</p>" if body else "",
        "detail_image_urls": [],
        "detail_image_alts": [],
        "author": "",
        "publish_time": "",
        "like_count": "",
        "collect_count": "",
        "comment_count": "",
        "author_profile": "",
        "tags": [],
    }


class FakeExtractPage:
    def __init__(self) -> None:
        self.url = "https://example.test/detail"
        self.timeouts: list[int] = []

    def wait_for_timeout(self, milliseconds: int) -> None:
        self.timeouts.append(milliseconds)


def test_extract_note_does_not_return_early_for_fallback_title_and_author(monkeypatch) -> None:
    page = FakeExtractPage()
    payloads = iter([payload(""), payload("这是第二次读取才出现的正文")])
    calls = 0

    def fake_payload(_page) -> dict:
        nonlocal calls
        calls += 1
        return next(payloads)

    monkeypatch.setattr(SCRAPER, "dismiss_common_popups", lambda _page: None)
    monkeypatch.setattr(SCRAPER, "extract_note_payload", fake_payload)

    record = SCRAPER.extract_note(
        page,
        {"note_id": "n1", "title": "卡片标题", "author": "卡片作者"},
    )

    assert record.body == "这是第二次读取才出现的正文"
    assert calls == 2
    assert page.timeouts == [500]


def test_extract_note_retries_all_reads_when_body_stays_empty(monkeypatch) -> None:
    page = FakeExtractPage()
    calls = 0

    def fake_payload(_page) -> dict:
        nonlocal calls
        calls += 1
        return payload("")

    monkeypatch.setattr(SCRAPER, "dismiss_common_popups", lambda _page: None)
    monkeypatch.setattr(SCRAPER, "extract_note_payload", fake_payload)

    record = SCRAPER.extract_note(
        page,
        {"note_id": "n1", "title": "卡片标题", "author": "卡片作者"},
    )

    assert record.body == ""
    assert calls == 6
    assert page.timeouts == [500] * 5


class FakeNavigationPage(FakeReadinessPage):
    def __init__(self) -> None:
        super().__init__(
            body_texts=["这是错误笔记页面中的正文内容"],
            page_texts=["这是错误笔记页面中的正文内容"],
            url="about:blank",
        )
        self.goto_calls: list[str] = []

    def goto(self, url: str, **_kwargs) -> None:
        self.goto_calls.append(url)
        self.url = "https://example.test/explore/wrong-note"


class FakeFallbackNavigationPage(FakeReadinessPage):
    def __init__(self) -> None:
        super().__init__(
            body_texts=["这是目标笔记页面中的真实正文内容"],
            page_texts=["这是目标笔记页面中的真实正文内容"],
            url="about:blank",
        )
        self.goto_calls: list[str] = []

    def goto(self, url: str, **_kwargs) -> None:
        self.goto_calls.append(url)
        self.url = (
            "https://example.test/explore/wrong-note"
            if len(self.goto_calls) == 1
            else "https://example.test/explore/expected-note"
        )


def test_scrape_note_returns_structured_status_for_wrong_note_id(monkeypatch) -> None:
    page = FakeNavigationPage()
    monkeypatch.setattr(
        SCRAPER,
        "wait_for_note_ready",
        lambda _page: pytest.fail("note-id mismatch must stop before readiness wait"),
    )
    monkeypatch.setattr(
        SCRAPER,
        "extract_note",
        lambda *_args: pytest.fail("note-id mismatch must stop before extraction"),
    )
    card = {
        "note_id": "expected-note",
        "search_result_url": "https://example.test/explore/expected-note",
    }

    record = SCRAPER.scrape_note(
        page,
        card,
        goto_timeout_ms=10000,
        source_search_url="https://example.test/search_result?keyword=test",
    )

    assert record is not None
    assert record.access_status == "detail_note_mismatch"
    assert page.goto_calls == [card["search_result_url"]]


def test_scrape_note_uses_one_fallback_after_wrong_note_id(monkeypatch) -> None:
    page = FakeFallbackNavigationPage()
    monkeypatch.setattr(SCRAPER, "wait_for_note_ready", lambda _page: "detail_body_ready")
    monkeypatch.setattr(
        SCRAPER,
        "extract_note",
        lambda *_args: make_record(body="这是目标笔记页面中的真实正文内容"),
    )
    card = {
        "note_id": "expected-note",
        "search_result_url": "https://example.test/search_result/expected-note?token=expired",
        "explore_url": "https://example.test/explore/expected-note",
    }

    record = SCRAPER.scrape_note(
        page,
        card,
        goto_timeout_ms=10000,
        source_search_url="https://example.test/search_result?keyword=test",
    )

    assert record is not None
    assert record.access_status == "detail_ok"
    assert page.goto_calls == [card["search_result_url"], card["explore_url"]]


def test_note_id_validation_keeps_pages_without_an_id_compatible() -> None:
    record = make_record(body="这是页面中已经提取完成的真实正文")

    assert SCRAPER.detail_note_id_mismatch("https://example.test/detail", "expected-note") is False
    assert (
        SCRAPER.classify_detail_access(
            "https://example.test/detail",
            record,
            expected_note_id="expected-note",
        )
        == "detail_ok"
    )


def test_detail_access_classifies_an_exact_note_id_mismatch() -> None:
    record = make_record(body="这是另一个笔记页面中提取出的正文")

    assert (
        SCRAPER.classify_detail_access(
            "https://example.test/explore/other-note",
            record,
            expected_note_id="expected-note",
        )
        == "detail_note_mismatch"
    )


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://example.test/explore/note-1", "note-1"),
        ("https://example.test/search_result/note-2?token=volatile", "note-2"),
        ("https://example.test/discovery/item/note-3", "note-3"),
    ],
)
def test_detail_note_id_parses_supported_detail_routes(url: str, expected: str) -> None:
    assert SCRAPER.detail_note_id_from_url(url) == expected


def test_detail_access_rejects_short_placeholder_text_as_an_empty_body() -> None:
    record = make_record(body="...")

    assert SCRAPER.classify_detail_access(
        "https://example.test/explore/note-1",
        record,
        expected_note_id="note-1",
    ) == "detail_empty"
