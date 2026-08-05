from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
import re
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ai_application_workflow import _extract_route_emails
from ai_provider_runtime import AIProvider, AIProviderError
from artifact_io import atomic_write_json


ARTIFACT_CANDIDATES = (
    "application_intelligence.checkpoint.json",
    "application_intelligence.json",
    "xiaohongshu_notes_latest.json",
    "xiaohongshu_cards_latest.json",
)
STATE_FILE = "contact-resolution-job.json"
REPORT_FILE = "contact-resolution-report.json"
OVERLAY_FILE = "application-contact-ocr.json"
CACHE_FILE = "application-contact-ocr-cache.json"
OCR_STRATEGY_VERSION = "contact_focused_pipeline_v4"
MEDIA_CACHE_MAX_BYTES = 8 * 1024 * 1024
SIMPLE_EMAIL = re.compile(
    r"(?<![A-Z0-9._%+\-/])([A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+)(?![A-Z0-9._%+\-/])",
    re.I,
)
OCR_REQUEST_ERRORS = (AIProviderError, TimeoutError, ValueError, TypeError, OSError)
_worker_local = threading.local()
_worker_endpoint_lock = threading.Lock()
_worker_endpoint_index = 0


class OcrAttemptsExhausted(AIProviderError):
    def __init__(self, message: str, attempts: int):
        super().__init__(message)
        self.attempts = attempts


def batch_ocr_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["visible_text"],
        "properties": {
            "visible_text": {"type": "string"},
        },
    }


def request_visible_text(
    provider: AIProvider,
    *,
    remote_image_urls: list[str],
    image_files: list[Path],
    max_attempts: int,
    image_batch_size: int = 4,
    image_sources: list[tuple[str, str]] | None = None,
    annotate_images: bool = False,
) -> tuple[str, int]:
    sources = image_sources or [
        ("url", str(value)) for value in remote_image_urls if str(value).strip()
    ] + [
        ("file", str(value)) for value in image_files if str(value).strip()
    ]
    if not sources:
        raise AIProviderError("No image inputs were available for local vision OCR.")
    bounded_batch_size = max(1, min(int(image_batch_size), 4))
    sections: list[str] = []
    attempts_total = 0
    for offset in range(0, len(sources), bounded_batch_size):
        batch_text, attempts_used = request_visible_text_batch(
            provider,
            sources[offset:offset + bounded_batch_size],
            max_attempts=max_attempts,
            image_offset=offset,
            annotate_images=annotate_images,
        )
        sections.append(batch_text)
        attempts_total += attempts_used
    return "\n\n".join(section for section in sections if section).strip(), attempts_total


def request_visible_text_batch(
    provider: AIProvider,
    sources: list[tuple[str, str]],
    *,
    max_attempts: int,
    image_offset: int,
    annotate_images: bool,
) -> tuple[str, int]:
    """Request one small image group and split again only on context overflow."""
    bounded_attempts = max(1, min(int(max_attempts), 3))
    remote_image_urls = [value for kind, value in sources if kind == "url"]
    # AIProvider accepts string paths and intentionally ignores other input
    # types, so preserve this boundary when cached files replace remote URLs.
    image_files = [str(value) for kind, value in sources if kind == "file"]
    last_error: BaseException | None = None
    for attempt in range(1, bounded_attempts + 1):
        try:
            result = provider.generate_json(
                "You are a recruitment contact OCR engine. Inspect every supplied image, but return only lines "
                "that contain an email address, delivery instruction, phone number, social account, QR-code "
                "instruction, or other application contact route. Include one adjacent context line only when "
                "needed to interpret the route. Preserve punctuation, digits, spaces, emoji, symbol substitutions, "
                "and line breaks exactly; never invent or silently normalize an address.",
                "Scan every supplied image in reading order. Put the contact-bearing text into visible_text and "
                "prefix each image section with [[IMAGE_1]], [[IMAGE_2]], and so on. Use an empty section when an "
                "image has no contact route. Do not transcribe unrelated job-description text.",
                batch_ocr_schema(),
                image_urls=remote_image_urls,
                image_files=image_files,
            )
            visible_text = str(result.get("visible_text") or "").strip()
            if not getattr(provider, "last_request_used_images", False):
                detail = str(getattr(provider, "last_image_error", "") or "").strip()
                raise AIProviderError(
                    "Local vision request returned no verifiable image text."
                    + (f" Vision error: {detail}" if detail else "")
                )
            return (
                relabel_image_sections(visible_text, image_offset, len(sources)) if annotate_images else visible_text,
                attempt,
            )
        except OCR_REQUEST_ERRORS as error:
            if is_context_limit_error(error) and len(sources) > 1:
                midpoint = max(1, len(sources) // 2)
                left_text, left_attempts = request_visible_text_batch(
                    provider,
                    sources[:midpoint],
                    max_attempts=max_attempts,
                    image_offset=image_offset,
                    annotate_images=annotate_images,
                )
                right_text, right_attempts = request_visible_text_batch(
                    provider,
                    sources[midpoint:],
                    max_attempts=max_attempts,
                    image_offset=image_offset + midpoint,
                    annotate_images=annotate_images,
                )
                return "\n\n".join(part for part in (left_text, right_text) if part), left_attempts + right_attempts
            last_error = error
    message = str(last_error) if last_error else "Local vision request failed."
    raise OcrAttemptsExhausted(message, bounded_attempts) from last_error


def is_context_limit_error(error: BaseException) -> bool:
    message = str(error).casefold()
    return any(marker in message for marker in (
        "context size",
        "context length",
        "n_prompt_tokens",
        "exceed_context_size",
        "maximum context",
    ))


def relabel_image_sections(visible_text: str, image_offset: int, image_count: int) -> str:
    """Keep image evidence mapped to original URLs after micro-batching."""
    matches = list(IMAGE_SECTION.finditer(visible_text))
    if not matches:
        return f"[[IMAGE_{image_offset + 1}]]\n{visible_text.strip()}"
    sections: list[str] = []
    for position, match in enumerate(matches):
        index = int(match.group(1))
        end = matches[position + 1].start() if position + 1 < len(matches) else len(visible_text)
        body = visible_text[match.end():end].strip()
        if not body:
            continue
        bounded_index = max(1, min(index, max(1, image_count)))
        sections.append(f"[[IMAGE_{image_offset + bounded_index}]]\n{body}")
    return "\n\n".join(sections) or f"[[IMAGE_{image_offset + 1}]]\n{visible_text.strip()}"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_json(path: Path, default: Any) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def latest_payload(output_dir: Path) -> tuple[Path, dict[str, Any]]:
    candidates = [
        path
        for name in ARTIFACT_CANDIDATES
        if (path := output_dir / name).is_file()
    ]
    candidates.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    for path in candidates:
        payload = load_json(path, {})
        if isinstance(payload, list):
            return path, {"records": [item for item in payload if isinstance(item, dict)], "source_kind": "collection"}
        if isinstance(payload, dict) and isinstance(payload.get("records"), list):
            return path, payload
    raise FileNotFoundError("Application or collection artifact is not available.")


def normalized_local_base_url(value: Any) -> str:
    text = str(value or "").strip().rstrip("/")
    if not text:
        return ""
    return text if text.endswith("/v1") else f"{text}/v1"


def available_local_base_urls(
    config_path: Path,
    overrides: list[str] | None = None,
    timeout_seconds: float = 2.0,
) -> list[str]:
    raw = load_json(config_path, {})
    providers = raw.get("providers") if isinstance(raw, dict) else {}
    configured = providers.get("local_qwen") if isinstance(providers, dict) else {}
    if not isinstance(configured, dict):
        configured = {}
    configured_pool = configured.get("contactOcrBaseUrls")
    candidates = list(overrides or [])
    if not candidates:
        if isinstance(configured_pool, list):
            candidates.extend(str(value) for value in configured_pool)
        if not candidates:
            candidates.append(str(configured.get("baseUrl") or "http://127.0.0.1:11434/v1"))
    unique = list(dict.fromkeys(filter(None, (normalized_local_base_url(value) for value in candidates))))
    if len(unique) <= 1:
        return unique
    available: list[str] = []
    for base_url in unique:
        try:
            request = urllib.request.Request(
                f"{base_url}/models",
                headers={"Accept": "application/json", "User-Agent": "xhs-contact-ocr/1.0"},
            )
            with urllib.request.urlopen(request, timeout=max(0.25, timeout_seconds)) as response:
                if 200 <= int(getattr(response, "status", 200)) < 300:
                    available.append(base_url)
        except (OSError, TimeoutError, urllib.error.URLError, ValueError):
            continue
    return available or unique[:1]


def local_provider(config_path: Path, timeout: int, base_url: str = "") -> AIProvider:
    raw = load_json(config_path, {})
    providers = raw.get("providers") if isinstance(raw, dict) else {}
    configured = providers.get("local_qwen") if isinstance(providers, dict) else {}
    if not isinstance(configured, dict):
        configured = {}
    ocr_model = os.environ.get("XHS_APPLICATION_CONTACT_OCR_MODEL", "").strip()
    context_tokens = bounded_environment_integer(
        "XHS_APPLICATION_CONTACT_OCR_CONTEXT_TOKENS",
        int(configured.get("contactOcrContextTokens") or 4096),
        2048,
        8192,
    )
    max_output_tokens = bounded_environment_integer(
        "XHS_APPLICATION_CONTACT_OCR_MAX_OUTPUT_TOKENS",
        int(configured.get("contactOcrMaxOutputTokens") or 256),
        128,
        2048,
    )
    return AIProvider(
        provider="local_qwen",
        api_key="",
        base_url=normalized_local_base_url(base_url or configured.get("baseUrl") or "http://127.0.0.1:11434/v1"),
        model=ocr_model or str(configured.get("contactOcrModel") or configured.get("model") or "qwen3.5:4b"),
        wire_api=str(configured.get("wireApi") or "chat_completions"),
        timeout=timeout,
        model_context_tokens=context_tokens,
        max_output_tokens=max_output_tokens,
    )


def bounded_environment_integer(name: str, fallback: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, "") or fallback)
    except (TypeError, ValueError):
        value = fallback
    return max(minimum, min(value, maximum))


def worker_provider(config_path: Path, timeout: int, base_urls: list[str] | None = None) -> AIProvider:
    """Keep mutable provider request metadata isolated per OCR worker."""
    global _worker_endpoint_index
    endpoint_pool = base_urls or available_local_base_urls(config_path)
    provider_key = (str(config_path), timeout, tuple(endpoint_pool))
    provider = getattr(_worker_local, "provider", None)
    if provider is None or getattr(_worker_local, "provider_key", None) != provider_key:
        with _worker_endpoint_lock:
            base_url = endpoint_pool[_worker_endpoint_index % len(endpoint_pool)]
            _worker_endpoint_index += 1
        provider = local_provider(config_path, timeout, base_url)
        _worker_local.provider = provider
        _worker_local.provider_key = provider_key
    return provider


def record_id(record: dict[str, Any], index: int) -> str:
    return str(
        record.get("note_id")
        or record.get("post_id")
        or record.get("id")
        or f"record-{index + 1}"
    ).strip()


def record_images(record: dict[str, Any]) -> list[str]:
    media = record.get("media") if isinstance(record.get("media"), dict) else {}
    images = media.get("images") if isinstance(media.get("images"), list) else []
    candidates: list[Any] = list(images)
    for field in ("detail_image_urls", "card_image_urls", "image_urls"):
        value = record.get(field)
        if isinstance(value, str):
            candidates.extend(re.findall(r"https?://[^|\s]+", value))
        elif isinstance(value, list):
            candidates.extend(value)
    candidates.append(record.get("card_cover_url"))
    if isinstance(record.get("images"), list):
        candidates.extend(record["images"])
    urls: list[str] = []
    for item in candidates:
        if isinstance(item, dict):
            value = (
                item.get("sourceUrl")
                or item.get("source_url")
                or item.get("original_url")
                or item.get("origin_url")
                or item.get("image_url")
                or item.get("url")
            )
        else:
            value = item
        url = str(value or "").strip()
        # Card records also contain the author's avatar. It is not a job poster
        # and wastes a vision request, so keep only content images here.
        lowered = url.casefold()
        if (
            url.startswith(("http://", "https://"))
            and url not in urls
            and "/avatar/" not in lowered
            and "avatar" not in lowered
            and "profile" not in lowered
        ):
            urls.append(url)
    return urls[:4]


def image_inputs(output_dir: Path, image_urls: list[str]) -> tuple[list[str], list[str]]:
    sources = image_input_sources(output_dir, image_urls)
    return (
        [value for kind, value in sources if kind == "file"],
        [value for kind, value in sources if kind == "url"],
    )


def image_input_sources(output_dir: Path, image_urls: list[str]) -> list[tuple[str, str]]:
    cache_dir = output_dir / ".media-cache"
    sources: list[tuple[str, str]] = []
    for image_url in image_urls:
        key = hashlib.sha256(image_url.encode("utf-8")).hexdigest()
        cached = cache_dir / f"{key}.image"
        if cached.is_file():
            sources.append(("file", str(cached)))
        else:
            sources.append(("url", image_url))
    return sources


def cacheable_media_url(value: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(str(value or "").strip())
    except ValueError:
        return False
    hostname = str(parsed.hostname or "").casefold()
    return parsed.scheme == "https" and (
        hostname == "xhscdn.com"
        or hostname.endswith(".xhscdn.com")
        or hostname == "picasso-static.xiaohongshu.com"
    )


def cache_image_url(output_dir: Path, image_url: str, timeout_seconds: int = 30) -> dict[str, Any]:
    """Persist one fresh CDN image using the same cache contract as the Node media route."""
    if not cacheable_media_url(image_url):
        return {"ok": False, "url": image_url, "reason": "unsupported_media_host"}
    cache_dir = output_dir / ".media-cache"
    key = hashlib.sha256(image_url.encode("utf-8")).hexdigest()
    data_path = cache_dir / f"{key}.image"
    metadata_path = cache_dir / f"{key}.json"
    if data_path.is_file():
        try:
            size = data_path.stat().st_size
        except OSError:
            size = 0
        if 0 < size <= MEDIA_CACHE_MAX_BYTES:
            return {"ok": True, "url": image_url, "cacheHit": True, "bytes": size}

    request = urllib.request.Request(
        image_url,
        headers={
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Referer": "https://www.xiaohongshu.com/",
            "User-Agent": "Mozilla/5.0 (compatible; XiaohongshuRelayScraper/1.0)",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=max(5, min(int(timeout_seconds), 60))) as response:
            final_url = str(response.geturl() or image_url)
            content_type = str(getattr(response, "headers", {}).get("Content-Type", "")).split(";", 1)[0].strip().lower()
            image_bytes = response.read(MEDIA_CACHE_MAX_BYTES + 1)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        return {"ok": False, "url": image_url, "reason": str(error)[:300]}
    if not cacheable_media_url(final_url):
        return {"ok": False, "url": image_url, "reason": "unsupported_redirect_host"}
    if not content_type.startswith("image/") or not image_bytes or len(image_bytes) > MEDIA_CACHE_MAX_BYTES:
        return {"ok": False, "url": image_url, "reason": "invalid_or_oversized_image"}

    cache_dir.mkdir(parents=True, exist_ok=True)
    temp_path = cache_dir / f"{key}.{uuid.uuid4().hex}.tmp"
    try:
        temp_path.write_bytes(image_bytes)
        temp_path.replace(data_path)
        if not atomic_write_json(metadata_path, {"sourceUrl": image_url, "contentType": content_type}):
            raise OSError("Could not persist media cache metadata.")
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
    return {"ok": True, "url": image_url, "cacheHit": False, "bytes": len(image_bytes)}


def prefetch_queue_images(
    output_dir: Path,
    queue: list[tuple[int, dict[str, Any]]],
    *,
    concurrency: int,
    timeout_seconds: int,
) -> dict[str, Any]:
    urls = list(dict.fromkeys(
        image_url
        for _, record in queue
        for image_url in record_images(record)
    ))
    bounded_concurrency = max(1, min(int(concurrency), 32))
    metrics: dict[str, Any] = {
        "total": len(urls),
        "downloaded": 0,
        "cacheHits": 0,
        "failed": 0,
        "bytes": 0,
        "concurrency": bounded_concurrency,
        "failures": [],
    }
    if not urls:
        return metrics
    with ThreadPoolExecutor(max_workers=bounded_concurrency, thread_name_prefix="contact-media") as executor:
        futures = {
            executor.submit(cache_image_url, output_dir, image_url, timeout_seconds): image_url
            for image_url in urls
        }
        for future in as_completed(futures):
            result = future.result()
            if result.get("ok"):
                metrics["cacheHits" if result.get("cacheHit") else "downloaded"] += 1
                metrics["bytes"] += int(result.get("bytes") or 0)
            else:
                metrics["failed"] += 1
                if len(metrics["failures"]) < 20:
                    metrics["failures"].append({
                        "url": str(result.get("url") or futures[future]),
                        "reason": str(result.get("reason") or "download_failed")[:300],
                    })
    return metrics


def image_request_fingerprint(output_dir: Path, image_urls: list[str]) -> str:
    """Fingerprint ordered image inputs while invalidating changed local cache files."""
    descriptors: list[dict[str, Any]] = []
    cache_dir = output_dir / ".media-cache"
    for image_url in image_urls:
        key = hashlib.sha256(image_url.encode("utf-8")).hexdigest()
        cached = cache_dir / f"{key}.image"
        descriptor: dict[str, Any] = {"url": image_url}
        try:
            metadata = cached.stat()
            descriptor["size"] = metadata.st_size
            descriptor["mtime_ns"] = metadata.st_mtime_ns
        except OSError:
            descriptor["cached"] = False
        descriptors.append(descriptor)
    encoded = json.dumps(descriptors, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def existing_email_addresses(record: dict[str, Any]) -> set[str]:
    application = record.get("application_info") if isinstance(record.get("application_info"), dict) else {}
    routes = [
        *[item for item in application.get("contacts", []) if isinstance(item, dict)],
        *[item for item in application.get("application_routes", []) if isinstance(item, dict)],
    ]
    addresses: set[str] = set()
    for route in routes:
        for value in (route.get("value"), route.get("evidence")):
            addresses.update(address for address, _ in _extract_route_emails(value))
    return addresses


def body_has_email(record: dict[str, Any]) -> bool:
    for field in ("body", "full_body", "source_card_text", "card_text_segments"):
        if _extract_route_emails(record.get(field)):
            return True
    application = record.get("application_info") if isinstance(record.get("application_info"), dict) else {}
    routes = [
        *[item for item in application.get("contacts", []) if isinstance(item, dict)],
        *[item for item in application.get("application_routes", []) if isinstance(item, dict)],
    ]
    for route in routes:
        source_fields = route.get("source_fields") if isinstance(route.get("source_fields"), list) else []
        sources = {
            str(route.get("source") or "").strip().lower(),
            str(route.get("source_field") or "").strip().lower(),
            *(str(value or "").strip().lower() for value in source_fields),
        }
        if "body" not in sources:
            continue
        if any(_extract_route_emails(route.get(field)) for field in ("value", "evidence")):
            return True
    return False


def ocr_complete(record: dict[str, Any]) -> bool:
    media = record.get("media") if isinstance(record.get("media"), dict) else {}
    analysis = media.get("analysis") if isinstance(media.get("analysis"), dict) else {}
    contact_ocr = analysis.get("contact_ocr") if isinstance(analysis.get("contact_ocr"), dict) else {}
    return contact_ocr.get("status") == "complete"


def should_process_contact_ocr(
    record: dict[str, Any],
    *,
    force: bool = False,
    watch: bool = False,
    max_attempts: int = 2,
) -> bool:
    if not record_images(record) or body_has_email(record):
        return False
    if not force and ocr_complete(record):
        return False
    media = record.get("media") if isinstance(record.get("media"), dict) else {}
    analysis = media.get("analysis") if isinstance(media.get("analysis"), dict) else {}
    contact_ocr = analysis.get("contact_ocr") if isinstance(analysis.get("contact_ocr"), dict) else {}
    return not (
        watch
        and contact_ocr.get("status") == "failed"
        and contact_ocr.get("strategy") == OCR_STRATEGY_VERSION
        and int(contact_ocr.get("attempts") or 0) >= max_attempts
    )


def line_for_email(text: str, address: str) -> str:
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if address in {email for email, _ in _extract_route_emails(line)}:
            return line
    return address


IMAGE_SECTION = re.compile(r"\[\[IMAGE[_ ]?(\d+)\]\]", re.I)


def split_image_texts(visible_text: str, image_count: int) -> list[tuple[int, str]]:
    matches = list(IMAGE_SECTION.finditer(visible_text))
    sections: list[tuple[int, str]] = []
    for position, match in enumerate(matches):
        image_index = int(match.group(1))
        end = matches[position + 1].start() if position + 1 < len(matches) else len(visible_text)
        text = visible_text[match.end():end].strip()
        if 1 <= image_index <= image_count and text:
            sections.append((image_index, text))
    # Index 0 explicitly means that the local model returned batch-level text,
    # so evidence is not falsely attributed to one image.
    return sections or [(0, visible_text)]


def routes_from_ocr(image_texts: list[tuple[int, str]], image_urls: list[str]) -> list[dict[str, Any]]:
    routes: list[dict[str, Any]] = []
    seen: set[str] = set()
    for image_index, visible_text in image_texts:
        matches = list(_extract_route_emails(visible_text))
        matched_addresses = {address for address, _ in matches}
        for match in SIMPLE_EMAIL.finditer(visible_text):
            address = match.group(1).casefold()
            if address not in matched_addresses:
                matches.append((address, False))
                matched_addresses.add(address)
        for address, normalization_applied in matches:
            if address in seen:
                continue
            seen.add(address)
            source_url = image_urls[image_index - 1] if 0 < image_index <= len(image_urls) else ""
            evidence = line_for_email(visible_text, address)
            routes.append({
                "type": "email",
                "value": address,
                "channel": "email",
                "confidence": 90 if normalization_applied else 100,
                "evidence": evidence,
                "normalization_applied": normalization_applied,
                "source": "image",
                "source_field": "image",
                "source_fields": ["image"],
                "source_image_index": image_index,
                "source_image_url": source_url,
                "source_image_urls": image_urls if image_index == 0 else [source_url],
                "offset_start": -1,
                "offset_end": -1,
                "verification_status": "image_format_normalized" if normalization_applied else "image_format_verified",
                "actionable": True,
            })
    return routes


def merge_routes(record: dict[str, Any], image_routes: list[dict[str, Any]]) -> None:
    application = record.get("application_info") if isinstance(record.get("application_info"), dict) else {}
    existing = [item for item in application.get("application_routes", []) if isinstance(item, dict)]
    merged: list[dict[str, Any]] = []
    positions: dict[tuple[str, str], int] = {}
    for route in [*existing, *image_routes]:
        key = (
            str(route.get("channel") or route.get("type") or "other").casefold(),
            str(route.get("value") or "").strip().casefold(),
        )
        if not key[1]:
            continue
        if key in positions:
            current = merged[positions[key]]
            current_sources = current.get("source_fields") if isinstance(current.get("source_fields"), list) else []
            incoming_sources = route.get("source_fields") if isinstance(route.get("source_fields"), list) else []
            merged[positions[key]] = {
                **current,
                **route,
                "source_fields": list(dict.fromkeys([*current_sources, *incoming_sources])),
                "confidence": max(int(current.get("confidence") or 0), int(route.get("confidence") or 0)),
            }
            continue
        positions[key] = len(merged)
        merged.append(dict(route))
    record["application_info"] = {**application, "application_routes": merged}


def image_routes(record: dict[str, Any]) -> list[dict[str, Any]]:
    application = record.get("application_info") if isinstance(record.get("application_info"), dict) else {}
    routes = application.get("application_routes") if isinstance(application.get("application_routes"), list) else []
    return [
        dict(route)
        for route in routes
        if isinstance(route, dict) and str(route.get("source") or route.get("source_field") or "") == "image"
    ]


def overlay_entry(record: dict[str, Any], routes: list[dict[str, Any]]) -> dict[str, Any]:
    media = record.get("media") if isinstance(record.get("media"), dict) else {}
    analysis = media.get("analysis") if isinstance(media.get("analysis"), dict) else {}
    contact_ocr = analysis.get("contact_ocr") if isinstance(analysis.get("contact_ocr"), dict) else {}
    return {
        "updatedAt": str(contact_ocr.get("processedAt") or utc_now()),
        "status": str(contact_ocr.get("status") or "pending"),
        "visibleText": str(analysis.get("visible_text") or analysis.get("ocr_text") or ""),
        "routes": routes,
        "contactOcr": contact_ocr,
    }


def apply_overlay_entry(record: dict[str, Any], entry: dict[str, Any]) -> None:
    media = record.get("media") if isinstance(record.get("media"), dict) else {}
    analysis = media.get("analysis") if isinstance(media.get("analysis"), dict) else {}
    contact_ocr = entry.get("contactOcr") if isinstance(entry.get("contactOcr"), dict) else {}
    complete = contact_ocr.get("status") == "complete"
    media["analysis"] = {
        **analysis,
        **({
            "status": "analyzed",
            "source": "image_ocr_model",
            "visible_text": str(entry.get("visibleText") or ""),
            "ocr_text": str(entry.get("visibleText") or ""),
            "application_routes": entry.get("routes") if isinstance(entry.get("routes"), list) else [],
            "application_route_count": len(entry.get("routes") or []),
        } if complete else {}),
        "contact_ocr": contact_ocr,
    }
    record["media"] = media
    if complete:
        merge_routes(record, [route for route in entry.get("routes", []) if isinstance(route, dict)])


def apply_ocr_result(
    record: dict[str, Any],
    *,
    image_urls: list[str],
    image_texts: list[tuple[int, str]],
    provider: AIProvider,
    prior_attempts: int,
    model_name: str = "",
) -> list[dict[str, Any]]:
    routes = routes_from_ocr(image_texts, image_urls)
    combined = "\n\n".join(text for _, text in image_texts)
    media = record.get("media") if isinstance(record.get("media"), dict) else {}
    analysis = media.get("analysis") if isinstance(media.get("analysis"), dict) else {}
    processed_at = utc_now()
    media["analysis"] = {
        **analysis,
        "status": "analyzed",
        "source": "image_ocr_model",
        "visible_text": combined,
        "ocr_text": combined,
        "application_routes": routes,
        "application_route_count": len(routes),
        "contact_ocr": {
            "status": "complete",
            "strategy": OCR_STRATEGY_VERSION,
            "processedAt": processed_at,
            "model": str(model_name or getattr(provider, "last_request_model", "") or provider.model),
            "attempts": prior_attempts + 1,
            "imageCount": len(image_urls),
            "emailsFound": len(routes),
            "images": [
                {
                    "imageIndex": image_index or None,
                    "url": image_urls[image_index - 1] if 0 < image_index <= len(image_urls) else "",
                    "urls": image_urls if image_index == 0 else [image_urls[image_index - 1]],
                    "visibleText": text,
                }
                for image_index, text in image_texts
            ],
        },
    }
    record["media"] = media
    merge_routes(record, routes)
    return routes


def apply_ocr_failure(record: dict[str, Any], message: str, prior_attempts: int) -> None:
    media = record.get("media") if isinstance(record.get("media"), dict) else {}
    analysis = media.get("analysis") if isinstance(media.get("analysis"), dict) else {}
    media["analysis"] = {
        **analysis,
        "status": analysis.get("status") if analysis.get("status") not in {"pending", "pending_ai"} else "unavailable",
        "source": analysis.get("source") if analysis.get("source") not in {"", "image_urls"} else "model_error",
        "contact_ocr": {
            "status": "failed",
            "strategy": OCR_STRATEGY_VERSION,
            "processedAt": utc_now(),
            "attempts": prior_attempts + 1,
            "reason": message[:500],
        },
    }
    record["media"] = media


def baseline_counts(records: list[dict[str, Any]]) -> dict[str, int]:
    with_images = [record for record in records if record_images(record)]
    skipped_body_email = [
        record for record in with_images
        if body_has_email(record) and not ocr_complete(record)
    ]
    return {
        "totalRecords": len(records),
        "withImages": len(with_images),
        "imageOcrComplete": sum(ocr_complete(record) for record in with_images),
        "imageOcrPending": sum(
            not ocr_complete(record) and not body_has_email(record)
            for record in with_images
        ),
        "imageOcrSkippedBodyEmail": len(skipped_body_email),
        "bodyEmailPresent": sum(body_has_email(record) for record in records),
        "noKnownEmailWithImages": sum(
            not existing_email_addresses(record) and not body_has_email(record)
            for record in with_images
        ),
    }


def write_state(path: Path, state: dict[str, Any], **changes: Any) -> dict[str, Any]:
    state = {**state, **changes, "updatedAt": utc_now()}
    atomic_write_json(path, state)
    return state


def process_ocr_item(
    output_dir: Path,
    config_path: Path,
    timeout_seconds: int,
    max_attempts: int,
    record_index: int,
    record: dict[str, Any],
    cache_entry: dict[str, Any] | None = None,
    image_batch_size: int = 4,
    base_urls: list[str] | None = None,
) -> dict[str, Any]:
    """Run one independent vision request; each worker owns its provider instance."""
    note_id = record_id(record, record_index)
    image_urls = record_images(record)
    image_files, remote_image_urls = image_inputs(output_dir, image_urls)
    image_sources = image_input_sources(output_dir, image_urls)
    media = record.get("media") if isinstance(record.get("media"), dict) else {}
    analysis = media.get("analysis") if isinstance(media.get("analysis"), dict) else {}
    contact_ocr = analysis.get("contact_ocr") if isinstance(analysis.get("contact_ocr"), dict) else {}
    prior_attempts = int(contact_ocr.get("attempts") or 0)
    cache_key = image_request_fingerprint(output_dir, image_urls)
    cached_text = str(cache_entry.get("visibleText") or "").strip() if isinstance(cache_entry, dict) else ""
    cache_complete = isinstance(cache_entry, dict) and (
        cache_entry.get("status") == "complete" or bool(cached_text)
    )
    if cache_complete:
        return {
            "ok": True,
            "cacheHit": True,
            "recordIndex": record_index,
            "noteId": note_id,
            "imageUrls": image_urls,
            "visibleText": cached_text,
            "attemptsUsed": 0,
            "priorAttempts": prior_attempts,
            "model": str(cache_entry.get("model") or "qwen3.5:4b"),
            "cacheKey": cache_key,
        }
    provider = worker_provider(config_path, timeout_seconds, base_urls)
    try:
        visible_text, attempts_used = request_visible_text(
            provider,
            remote_image_urls=remote_image_urls,
            image_files=image_files,
            max_attempts=max_attempts,
            image_batch_size=image_batch_size,
            image_sources=image_sources,
            annotate_images=True,
        )
        return {
            "ok": True,
            "recordIndex": record_index,
            "noteId": note_id,
            "imageUrls": image_urls,
            "visibleText": visible_text,
            "attemptsUsed": attempts_used,
            "priorAttempts": prior_attempts,
            "model": str(getattr(provider, "last_request_model", "") or provider.model),
            "cacheKey": cache_key,
        }
    except OCR_REQUEST_ERRORS as error:
        return {
            "ok": False,
            "recordIndex": record_index,
            "noteId": note_id,
            "imageUrls": image_urls,
            "attemptsUsed": int(getattr(error, "attempts", 1) or 1),
            "priorAttempts": prior_attempts,
            "reason": str(error) or error.__class__.__name__,
            "cacheKey": cache_key,
        }


def source_signature(output_dir: Path) -> tuple[tuple[str, int, int], ...]:
    values: list[tuple[str, int, int]] = []
    for name in ARTIFACT_CANDIDATES:
        path = output_dir / name
        try:
            metadata = path.stat()
        except OSError:
            continue
        values.append((name, int(metadata.st_mtime_ns), int(metadata.st_size)))
    return tuple(values)


def run_once(options: argparse.Namespace) -> dict[str, Any]:
    output_dir = Path(options.output_dir).resolve()
    artifact_path, payload = latest_payload(output_dir)
    records = [record for record in payload.get("records", []) if isinstance(record, dict)]
    state_path = output_dir / STATE_FILE
    report_path = output_dir / REPORT_FILE
    overlay_path = output_dir / OVERLAY_FILE
    cache_path = output_dir / CACHE_FILE
    overlay = load_json(overlay_path, {})
    if not isinstance(overlay, dict):
        overlay = {}
    stored_entries = overlay.get("records") if isinstance(overlay.get("records"), dict) else {}
    overlay = {
        "schemaVersion": 1,
        "updatedAt": str(overlay.get("updatedAt") or utc_now()),
        "records": stored_entries,
    }
    cache = load_json(cache_path, {})
    if not isinstance(cache, dict):
        cache = {}
    cache_records = cache.get("records") if isinstance(cache.get("records"), dict) else {}
    cache = {"schemaVersion": 1, "updatedAt": str(cache.get("updatedAt") or utc_now()), "records": cache_records}
    for record_index, record in enumerate(records):
        note_id = record_id(record, record_index)
        if note_id not in stored_entries and ocr_complete(record):
            stored_entries[note_id] = overlay_entry(record, image_routes(record))
        entry = stored_entries.get(note_id)
        if isinstance(entry, dict):
            apply_overlay_entry(record, entry)
    overlay["updatedAt"] = utc_now()
    if not atomic_write_json(overlay_path, overlay):
        raise OSError(f"Could not initialize {OVERLAY_FILE} after Windows file-lock retries.")
    config_path = Path(options.ai_config).resolve()
    base_urls = available_local_base_urls(
        config_path,
        list(getattr(options, "base_url", []) or []),
        timeout_seconds=min(float(options.timeout_seconds), 2.0),
    )
    provider = local_provider(config_path, options.timeout_seconds, base_urls[0])
    concurrency = max(1, min(int(options.concurrency), 8))
    prefetch_concurrency = max(1, min(int(options.prefetch_concurrency), 32))
    image_batch_size = max(1, min(int(options.image_batch_size), 4))
    started_at = utc_now()
    before = baseline_counts(records)
    requested_note_ids = {str(value).strip() for value in options.note_id if str(value).strip()}
    queue = [
        (index, record)
        for index, record in enumerate(records)
        if should_process_contact_ocr(
            record,
            force=options.force,
            watch=getattr(options, "watch", False),
            max_attempts=options.max_attempts,
        )
        and (not requested_note_ids or record_id(record, index) in requested_note_ids)
    ]
    if options.max_records > 0:
        queue = queue[: options.max_records]

    state = write_state(state_path, {
        "schemaVersion": 1,
        "jobId": options.job_id or f"contact-ocr-{uuid.uuid4().hex[:12]}",
        "status": "running",
        "pid": os.getpid(),
        "startedAt": started_at,
        "artifact": artifact_path.name,
        "overlay": OVERLAY_FILE,
        "provider": "local_qwen",
        "model": provider.model,
        "maxAttemptsPerRecord": options.max_attempts,
        "concurrency": concurrency,
        "prefetchConcurrency": prefetch_concurrency,
        "imageBatchSize": image_batch_size,
        "inferenceShards": len(base_urls),
        "totalQueued": len(queue),
        "processed": 0,
        "succeeded": 0,
        "failed": 0,
        "emailsFound": 0,
        "cacheHits": 0,
        "inferenceRequests": 0,
        "baseline": before,
    })
    processed = succeeded = failed = emails_found = cache_hits = inference_requests = 0
    failures: list[dict[str, str]] = []
    started_monotonic = time.monotonic()

    try:
        state = write_state(state_path, state, phase="prefetching")
        prefetch_started = time.monotonic()
        prefetch = prefetch_queue_images(
            output_dir,
            queue,
            concurrency=prefetch_concurrency,
            timeout_seconds=min(options.timeout_seconds, 30),
        )
        prefetch["elapsedSeconds"] = round(time.monotonic() - prefetch_started, 3)
        state = write_state(state_path, state, phase="inference", prefetch=prefetch)
        futures = {}
        with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="contact-ocr") as executor:
            for queue_index, (record_index, record) in enumerate(queue, start=1):
                image_urls = record_images(record)
                cache_key = image_request_fingerprint(output_dir, image_urls)
                futures[executor.submit(
                    process_ocr_item,
                    output_dir,
                    config_path,
                    options.timeout_seconds,
                    options.max_attempts,
                    record_index,
                    record,
                    (
                        cache_records.get(cache_key)
                        if not options.force and isinstance(cache_records.get(cache_key), dict)
                        else None
                    ),
                    options.image_batch_size,
                    base_urls,
                )] = queue_index
            for completed_index, future in enumerate(as_completed(futures), start=1):
                queue_index = futures[future]
                result = future.result()
                record_index = int(result["recordIndex"])
                record = records[record_index]
                note_id = str(result["noteId"])
                state = write_state(state_path, state, currentNoteId=note_id, currentIndex=completed_index)
                image_urls = [str(value) for value in result.get("imageUrls", [])]
                prior_attempts = int(result.get("priorAttempts") or 0)
                attempts_used = int(result["attemptsUsed"]) if "attemptsUsed" in result else 1
                if not result.get("cacheHit"):
                    inference_requests += max(1, attempts_used)
                if result.get("ok"):
                    if result.get("cacheHit"):
                        cache_hits += 1
                    image_texts = split_image_texts(str(result.get("visibleText") or ""), len(image_urls))
                    routes = apply_ocr_result(
                        record,
                        image_urls=image_urls,
                        image_texts=image_texts,
                        provider=provider,
                        prior_attempts=max(0, prior_attempts + attempts_used - 1),
                        model_name=str(result.get("model") or provider.model),
                    )
                    stored_entries[note_id] = overlay_entry(record, routes)
                    cache_records[str(result.get("cacheKey") or image_request_fingerprint(output_dir, image_urls))] = {
                        "status": "complete",
                        "visibleText": str(result.get("visibleText") or ""),
                        "model": str(result.get("model") or provider.model),
                        "imageCount": len(image_urls),
                        "updatedAt": utc_now(),
                    }
                    succeeded += 1
                    emails_found += len(routes)
                    print(
                        f"CONTACT_OCR item={queue_index}/{len(queue)} note_id={note_id} emails={len(routes)} status=complete",
                        flush=True,
                    )
                else:
                    failed += 1
                    message = str(result.get("reason") or "Local vision request failed.")
                    failures.append({"noteId": note_id, "reason": message[:500]})
                    apply_ocr_failure(record, message, prior_attempts + attempts_used - 1)
                    stored_entries[note_id] = overlay_entry(record, [])
                    print(
                        f"CONTACT_OCR item={queue_index}/{len(queue)} note_id={note_id} status=failed reason={message[:160]}",
                        flush=True,
                    )
                processed += 1
                if processed % options.checkpoint_every == 0 or processed == len(queue):
                    overlay["updatedAt"] = utc_now()
                    if not atomic_write_json(overlay_path, overlay):
                        raise OSError(f"Could not replace {OVERLAY_FILE} after Windows file-lock retries.")
                    cache["updatedAt"] = utc_now()
                    if not atomic_write_json(cache_path, cache):
                        raise OSError(f"Could not replace {CACHE_FILE} after Windows file-lock retries.")
                    state = write_state(
                        state_path,
                        state,
                        processed=processed,
                        succeeded=succeeded,
                        failed=failed,
                        emailsFound=emails_found,
                        cacheHits=cache_hits,
                        inferenceRequests=inference_requests,
                    )

        after = baseline_counts(records)
        elapsed_seconds = max(0.001, time.monotonic() - started_monotonic)
        report = {
            "schemaVersion": 1,
            "jobId": state["jobId"],
            "status": "completed" if failed == 0 else "partial",
            "startedAt": started_at,
            "finishedAt": utc_now(),
            "artifact": artifact_path.name,
            "overlay": OVERLAY_FILE,
            "provider": "local_qwen",
            "model": provider.model,
            "before": before,
            "after": after,
            "queue": {
                "total": len(queue),
                "processed": processed,
                "succeeded": succeeded,
                "failed": failed,
                "emailsFound": emails_found,
                "cacheHits": cache_hits,
                "inferenceRequests": inference_requests,
                "concurrency": concurrency,
                "prefetchConcurrency": prefetch_concurrency,
                "imageBatchSize": image_batch_size,
                "inferenceShards": len(base_urls),
                "elapsedSeconds": round(elapsed_seconds, 3),
                "recordsPerMinute": round(processed * 60 / elapsed_seconds, 2),
            },
            "prefetch": prefetch,
            "failures": failures,
        }
        atomic_write_json(report_path, report)
        state = write_state(
            state_path,
            state,
            status="completed" if failed == 0 else "partial",
            pid=None,
            currentNoteId=None,
            finishedAt=report["finishedAt"],
            processed=processed,
            succeeded=succeeded,
            failed=failed,
            emailsFound=emails_found,
            cacheHits=cache_hits,
            inferenceRequests=inference_requests,
            phase="finished",
            prefetch=prefetch,
            elapsedSeconds=round(elapsed_seconds, 3),
            recordsPerMinute=round(processed * 60 / elapsed_seconds, 2),
            report=REPORT_FILE,
        )
        return report
    except BaseException as error:
        write_state(
            state_path,
            state,
            status="failed",
            pid=None,
            finishedAt=utc_now(),
            error=str(error)[:1000],
            processed=processed,
            succeeded=succeeded,
            failed=failed,
            emailsFound=emails_found,
        )
        raise


def run_watch(options: argparse.Namespace) -> dict[str, Any]:
    """Consume collection and analysis artifacts as they are materialized.

    The collector may rewrite its JSON atomically several times. A signature
    based loop avoids holding a large file open and only starts OCR work when a
    new snapshot arrives. The Node supervisor owns process lifetime.
    """
    output_dir = Path(options.output_dir).resolve()
    last_signature: tuple[tuple[str, int, int], ...] | None = None
    last_report: dict[str, Any] = {
        "schemaVersion": 1,
        "status": "watching",
        "queue": {"total": 0, "processed": 0, "succeeded": 0, "failed": 0, "emailsFound": 0},
    }
    idle_seconds = 0.0
    poll_seconds = max(0.5, min(float(options.poll_seconds), 15.0))
    idle_exit_seconds = max(0.0, min(float(options.watch_idle_exit_seconds), 3600.0))
    while True:
        current_signature = source_signature(output_dir)
        if current_signature and current_signature != last_signature:
            try:
                last_report = run_once(options)
                last_signature = current_signature
                idle_seconds = 0.0
                state_path = output_dir / STATE_FILE
                state = load_json(state_path, {})
                if isinstance(state, dict):
                    write_state(
                        state_path,
                        state,
                        status="watching",
                        pid=os.getpid(),
                        watching=True,
                        lastSourceSignature=[list(item) for item in current_signature],
                    )
                print(
                    f"CONTACT_OCR_WATCH source={last_report.get('artifact', '')} "
                    f"processed={last_report.get('queue', {}).get('processed', 0)}",
                    flush=True,
                )
            except FileNotFoundError:
                pass
        else:
            idle_seconds += poll_seconds
            if idle_exit_seconds and idle_seconds >= idle_exit_seconds:
                break
        time.sleep(poll_seconds)
    return last_report


def main(arguments: list[str] | None = None) -> int:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Resolve image-based application contacts with the local vision model.")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--ai-config", default=str(project_root / "data" / "ai-config.json"))
    parser.add_argument("--job-id", default="")
    parser.add_argument("--timeout-seconds", type=int, default=180)
    parser.add_argument("--checkpoint-every", type=int, default=5)
    parser.add_argument("--max-attempts", type=int, default=2)
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--prefetch-concurrency", type=int, default=12)
    parser.add_argument("--image-batch-size", type=int, default=4)
    parser.add_argument("--base-url", action="append", default=[])
    parser.add_argument("--max-records", type=int, default=0)
    parser.add_argument("--note-id", action="append", default=[])
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--watch", action="store_true", help="Keep consuming new collection snapshots.")
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    parser.add_argument("--watch-idle-exit-seconds", type=float, default=0.0)
    options = parser.parse_args(arguments)
    options.timeout_seconds = max(30, min(options.timeout_seconds, 600))
    options.checkpoint_every = max(1, min(options.checkpoint_every, 50))
    options.max_attempts = max(1, min(options.max_attempts, 3))
    options.concurrency = max(1, min(options.concurrency, 8))
    options.prefetch_concurrency = max(1, min(options.prefetch_concurrency, 32))
    options.image_batch_size = max(1, min(options.image_batch_size, 4))
    options.max_records = max(0, options.max_records)
    options.poll_seconds = max(0.5, min(options.poll_seconds, 15.0))
    options.watch_idle_exit_seconds = max(0.0, min(options.watch_idle_exit_seconds, 3600.0))
    try:
        report = run_watch(options) if options.watch else run_once(options)
        print(f"CONTACT_OCR_COMPLETE {json.dumps(report['queue'], ensure_ascii=False)}", flush=True)
        return 0 if report["status"] == "completed" else 2
    except BaseException as error:
        print(f"CONTACT_OCR_FAILED {error}", file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
