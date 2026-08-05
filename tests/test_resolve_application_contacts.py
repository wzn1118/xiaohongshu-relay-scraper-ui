from __future__ import annotations

import sys
import hashlib
import json
import urllib.error
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = PROJECT_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from resolve_application_contacts import (  # noqa: E402
    apply_ocr_result,
    available_local_base_urls,
    cache_image_url,
    image_request_fingerprint,
    latest_payload,
    local_provider,
    process_ocr_item,
    prefetch_queue_images,
    record_images,
    request_visible_text,
    routes_from_ocr,
    run_once,
    should_process_contact_ocr,
    split_image_texts,
)


def test_local_provider_uses_dedicated_ocr_model_limits(tmp_path: Path, monkeypatch) -> None:
    config_path = tmp_path / "ai-config.json"
    config_path.write_text(
        json.dumps({"providers": {"local_qwen": {"model": "qwen3.5:4b"}}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("XHS_APPLICATION_CONTACT_OCR_MODEL", "qwen2.5vl:3b")
    monkeypatch.setenv("XHS_APPLICATION_CONTACT_OCR_CONTEXT_TOKENS", "4096")
    monkeypatch.setenv("XHS_APPLICATION_CONTACT_OCR_MAX_OUTPUT_TOKENS", "512")

    provider = local_provider(config_path, 60, "http://127.0.0.1:11435")

    assert provider.model == "qwen2.5vl:3b"
    assert provider.base_url == "http://127.0.0.1:11435/v1"
    assert provider.model_context_tokens == 4096
    assert provider.max_output_tokens == 512


def test_available_local_base_urls_skips_unhealthy_shards(tmp_path: Path, monkeypatch) -> None:
    config_path = tmp_path / "ai-config.json"
    config_path.write_text(
        json.dumps(
            {
                "providers": {
                    "local_qwen": {
                        "baseUrl": "http://127.0.0.1:11434/v1",
                        "contactOcrBaseUrls": [
                            "http://127.0.0.1:11434/v1",
                            "http://127.0.0.1:11435/v1",
                        ],
                    }
                }
            }
        ),
        encoding="utf-8",
    )

    class HealthyResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def fake_urlopen(request, timeout):
        assert timeout >= 0.25
        if "11435" in request.full_url:
            raise urllib.error.URLError("offline")
        return HealthyResponse()

    monkeypatch.setattr("resolve_application_contacts.urllib.request.urlopen", fake_urlopen)

    assert available_local_base_urls(config_path) == ["http://127.0.0.1:11434/v1"]


def test_explicit_ocr_endpoint_does_not_mix_in_general_model_endpoint(tmp_path: Path) -> None:
    config_path = tmp_path / "ai-config.json"
    config_path.write_text(
        json.dumps({"providers": {"local_qwen": {"baseUrl": "http://127.0.0.1:11434/v1"}}}),
        encoding="utf-8",
    )

    assert available_local_base_urls(
        config_path,
        ["http://127.0.0.1:11435/v1"],
    ) == ["http://127.0.0.1:11435/v1"]


def test_prefetch_queue_images_downloads_unique_images_concurrently(tmp_path: Path, monkeypatch) -> None:
    active = 0
    peak = 0
    lock = __import__("threading").Lock()

    def fake_cache(_output_dir: Path, image_url: str, _timeout: int):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        __import__("time").sleep(0.03)
        with lock:
            active -= 1
        return {"ok": True, "url": image_url, "cacheHit": False, "bytes": 10}

    monkeypatch.setattr("resolve_application_contacts.cache_image_url", fake_cache)
    queue = [
        (0, {"media": {"images": [{"sourceUrl": "https://one.xhscdn.com/a.jpg"}]}}),
        (1, {"media": {"images": [{"sourceUrl": "https://two.xhscdn.com/b.jpg"}]}}),
        (2, {"media": {"images": [{"sourceUrl": "https://one.xhscdn.com/a.jpg"}]}}),
    ]

    metrics = prefetch_queue_images(tmp_path, queue, concurrency=4, timeout_seconds=10)

    assert metrics["total"] == 2
    assert metrics["downloaded"] == 2
    assert metrics["bytes"] == 20
    assert peak >= 2


def test_body_email_skips_ocr_even_when_force_is_enabled() -> None:
    body_record = {
        "note_id": "post-body-email",
        "body": "Please send your resume to Jobs@Example.com",
        "media": {"images": [{"sourceUrl": "https://img.example/poster.jpg"}]},
    }
    structured_body_record = {
        "note_id": "post-structured-body-email",
        "application_info": {
            "contacts": [{
                "type": "email",
                "value": "structured@example.com",
                "source_field": "body",
            }],
        },
        "media": {"images": [{"sourceUrl": "https://img.example/poster-2.jpg"}]},
    }
    image_only_record = {
        "note_id": "post-image-only",
        "application_info": {
            "application_routes": [{
                "type": "email",
                "value": "image@example.com",
                "source_field": "image",
            }],
        },
        "media": {"images": [{"sourceUrl": "https://img.example/poster-3.jpg"}]},
    }

    assert should_process_contact_ocr(body_record, force=True) is False
    assert should_process_contact_ocr(structured_body_record, force=True) is False
    assert should_process_contact_ocr(image_only_record, force=True) is True


def test_run_once_does_not_enqueue_body_email_for_ocr(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "application_intelligence.json").write_text(
        json.dumps({
            "records": [{
                "note_id": "post-body-email",
                "body": "Please send your resume to jobs@example.com",
                "media": {"images": [{"sourceUrl": "https://img.example/poster.jpg"}]},
            }],
        }),
        encoding="utf-8",
    )
    config_path = tmp_path / "ai-config.json"
    config_path.write_text(
        json.dumps({"providers": {"local_qwen": {"model": "qwen2.5vl:3b"}}}),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "resolve_application_contacts.available_local_base_urls",
        lambda *_args, **_kwargs: ["http://127.0.0.1:11435/v1"],
    )

    report = run_once(SimpleNamespace(
        output_dir=str(tmp_path),
        ai_config=str(config_path),
        base_url=[],
        checkpoint_every=1,
        concurrency=2,
        force=True,
        image_batch_size=4,
        job_id="body-email-short-circuit-test",
        max_attempts=2,
        max_records=0,
        note_id=[],
        prefetch_concurrency=4,
        timeout_seconds=30,
        watch=False,
    ))

    assert report["queue"]["total"] == 0
    assert report["queue"]["processed"] == 0
    assert report["queue"]["inferenceRequests"] == 0
    assert report["after"]["imageOcrSkippedBodyEmail"] == 1
    assert report["after"]["imageOcrPending"] == 0


def test_collection_snapshot_is_a_live_ocr_source_and_avatar_is_ignored(tmp_path: Path) -> None:
    source = tmp_path / "xiaohongshu_notes_latest.json"
    source.write_text(
        '[{"note_id":"post-live","card_cover_url":"https://img.example/poster.png",'
        '"card_image_urls":"https://img.example/poster.png | '
        'https://sns-avatar-qc.xhscdn.com/avatar/user.webp"}]',
        encoding="utf-8",
    )

    artifact, payload = latest_payload(tmp_path)

    assert artifact.name == "xiaohongshu_notes_latest.json"
    assert payload["source_kind"] == "collection"
    assert record_images(payload["records"][0]) == ["https://img.example/poster.png"]


def test_image_request_fingerprint_changes_when_cached_image_changes(tmp_path: Path) -> None:
    image_url = "https://img.example/poster.jpg"
    first = image_request_fingerprint(tmp_path, [image_url])
    cache_dir = tmp_path / ".media-cache"
    cache_dir.mkdir()
    key = hashlib.sha256(image_url.encode("utf-8")).hexdigest()
    (cache_dir / f"{key}.image").write_bytes(b"poster-v1")
    second = image_request_fingerprint(tmp_path, [image_url])
    (cache_dir / f"{key}.image").write_bytes(b"poster-v2-with-new-bytes")
    third = image_request_fingerprint(tmp_path, [image_url])

    assert first != second
    assert second != third


def test_process_ocr_item_reuses_only_complete_cached_text(tmp_path: Path) -> None:
    record = {
        "note_id": "post-cache",
        "media": {"images": [{"sourceUrl": "https://img.example/poster.jpg"}]},
    }
    result = process_ocr_item(
        tmp_path,
        tmp_path / "ai-config.json",
        60,
        2,
        0,
        record,
        {"visibleText": "投递 jobs@example.com", "model": "qwen3.5:4b"},
    )

    assert result["ok"] is True
    assert result["cacheHit"] is True
    assert result["attemptsUsed"] == 0
    assert result["visibleText"] == "投递 jobs@example.com"


def test_request_visible_text_retries_only_after_a_transient_failure() -> None:
    class FlakyProvider:
        last_request_used_images = False
        last_image_error = ""

        def __init__(self) -> None:
            self.calls = 0

        def generate_json(self, *_args, **_kwargs):
            self.calls += 1
            if self.calls == 1:
                raise TimeoutError("temporary local model timeout")
            self.last_request_used_images = True
            return {"visible_text": "Apply at jobs@example.com"}

    provider = FlakyProvider()
    visible_text, attempts = request_visible_text(
        provider,
        remote_image_urls=["https://img.example/poster.jpg"],
        image_files=[],
        max_attempts=2,
    )

    assert visible_text == "Apply at jobs@example.com"
    assert attempts == 2
    assert provider.calls == 2


def test_request_visible_text_uses_contact_focused_prompt() -> None:
    class CapturingProvider:
        last_request_used_images = True
        last_image_error = ""

        def __init__(self) -> None:
            self.system = ""
            self.user = ""

        def generate_json(self, system, user, _schema, **_kwargs):
            self.system = system
            self.user = user
            return {"visible_text": "[[IMAGE_1]]\n投递：name📮example.com"}

    provider = CapturingProvider()
    visible_text, attempts = request_visible_text(
        provider,
        remote_image_urls=["https://img.example/poster.jpg"],
        image_files=[],
        max_attempts=1,
    )

    assert visible_text == "[[IMAGE_1]]\n投递：name📮example.com"
    assert attempts == 1
    assert "Inspect every supplied image" in provider.system
    assert "emoji" in provider.system
    assert "Do not transcribe unrelated job-description text" in provider.user


def test_cached_image_paths_reach_the_local_provider_as_strings(tmp_path: Path) -> None:
    cached = tmp_path / "poster.image"
    cached.write_bytes(b"image-bytes")

    class CapturingProvider:
        last_request_used_images = False
        last_image_error = ""

        def generate_json(self, *_args, image_urls=None, image_files=None, **_kwargs):
            assert image_urls == []
            assert image_files == [str(cached)]
            self.last_request_used_images = True
            return {"visible_text": "Apply at jobs@example.com"}

    visible_text, attempts = request_visible_text(
        CapturingProvider(),
        remote_image_urls=[],
        image_files=[cached],
        image_sources=[("file", str(cached))],
        max_attempts=1,
    )

    assert visible_text == "Apply at jobs@example.com"
    assert attempts == 1


def test_short_or_empty_visible_text_is_a_completed_image_inspection() -> None:
    class EmptyImageProvider:
        last_request_used_images = True
        last_image_error = ""

        def generate_json(self, *_args, **_kwargs):
            return {"visible_text": ""}

    visible_text, attempts = request_visible_text(
        EmptyImageProvider(),
        remote_image_urls=["https://img.example/no-text.jpg"],
        image_files=[],
        max_attempts=2,
    )

    assert visible_text == ""
    assert attempts == 1


def test_completed_empty_ocr_cache_prevents_repeat_inference(tmp_path: Path) -> None:
    record = {
        "note_id": "post-no-text",
        "media": {"images": [{"sourceUrl": "https://img.example/no-text.jpg"}]},
    }
    result = process_ocr_item(
        tmp_path,
        tmp_path / "ai-config.json",
        60,
        2,
        0,
        record,
        {"status": "complete", "visibleText": "", "model": "qwen3.5:4b"},
    )

    assert result["ok"] is True
    assert result["cacheHit"] is True
    assert result["visibleText"] == ""


def test_request_visible_text_splits_context_overflow_into_image_micro_batches() -> None:
    class ContextLimitedProvider:
        last_request_used_images = False
        last_image_error = ""

        def __init__(self) -> None:
            self.calls = 0

        def generate_json(self, _system, _user, _schema, image_urls=None, image_files=None):
            self.calls += 1
            supplied = len(image_urls or []) + len(image_files or [])
            if supplied > 1:
                raise ValueError("request exceeds available context size")
            self.last_request_used_images = True
            return {"visible_text": "[[IMAGE_1]]\n投递邮箱 jobs@example.com"}

    provider = ContextLimitedProvider()
    visible_text, attempts = request_visible_text(
        provider,
        remote_image_urls=["https://img.example/one.jpg", "https://img.example/two.jpg"],
        image_files=[],
        max_attempts=2,
        image_batch_size=2,
        image_sources=[
            ("url", "https://img.example/one.jpg"),
            ("url", "https://img.example/two.jpg"),
        ],
        annotate_images=True,
    )

    assert provider.calls == 3
    assert attempts == 2
    assert "[[IMAGE_1]]" in visible_text
    assert "[[IMAGE_2]]" in visible_text


def test_routes_from_ocr_extracts_henkel_email_with_image_evidence() -> None:
    image_urls = ["https://img.example/henkel-1.jpg", "https://img.example/henkel-2.jpg"]
    routes = routes_from_ocr(
        [(1, "投递邮箱：oriana.li@henkel.com\n命名方式：【Intern】姓名-学校")],
        image_urls,
    )

    assert len(routes) == 1
    assert routes[0]["value"] == "oriana.li@henkel.com"
    assert routes[0]["source"] == "image"
    assert routes[0]["source_image_index"] == 1
    assert routes[0]["source_image_url"] == image_urls[0]
    assert routes[0]["evidence"] == "投递邮箱：oriana.li@henkel.com"


def test_apply_ocr_result_merges_image_route_without_losing_existing_routes() -> None:
    existing = {
        "type": "web_form",
        "channel": "web_form",
        "value": "https://careers.example/apply",
        "source_field": "body",
    }
    record = {
        "note_id": "post-1",
        "application_info": {"contacts": [], "application_routes": [deepcopy(existing)]},
        "media": {"images": [{"sourceUrl": "https://img.example/poster.jpg"}], "analysis": {}},
    }
    provider = SimpleNamespace(model="qwen3.5:4b", last_request_model="qwen3.5:4b")

    routes = apply_ocr_result(
        record,
        image_urls=["https://img.example/poster.jpg"],
        image_texts=[(1, "招聘邮箱 jobs@example.com")],
        provider=provider,
        prior_attempts=0,
    )

    assert routes[0]["value"] == "jobs@example.com"
    assert record["application_info"]["application_routes"][0] == existing
    assert record["application_info"]["application_routes"][1]["value"] == "jobs@example.com"
    contact_ocr = record["media"]["analysis"]["contact_ocr"]
    assert contact_ocr["status"] == "complete"
    assert contact_ocr["attempts"] == 1
    assert contact_ocr["imageCount"] == 1
    assert contact_ocr["emailsFound"] == 1


def test_batch_level_ocr_evidence_is_not_falsely_attributed_to_one_image() -> None:
    visible_text = "招聘信息\n投递邮箱 jobs@example.com"
    image_urls = ["https://img.example/1.jpg", "https://img.example/2.jpg"]

    image_texts = split_image_texts(visible_text, len(image_urls))
    routes = routes_from_ocr(image_texts, image_urls)

    assert image_texts == [(0, visible_text)]
    assert routes[0]["source_image_index"] == 0
    assert routes[0]["source_image_url"] == ""
    assert routes[0]["source_image_urls"] == image_urls
