from __future__ import annotations

from typing import Any, Mapping
from urllib.parse import parse_qs, urlsplit, urlunsplit


NOTE_ID_QUERY_FIELDS = ("note_id", "noteId", "source_note_id", "sourceNoteId")
NOTE_ID_PATH_PREFIXES = {"explore", "search_result"}
NOTE_ID_FIELDS = ("note_id", "noteId", "source_note_id", "sourceNoteId", "canonical_id", "id")
NOTE_URL_FIELDS = ("note_url", "search_result_url", "explore_url", "card_search_result_url")


def note_id_from_value(value: Any) -> str:
    """Extract a stable note id from an id value or supported detail URL."""

    text = str(value or "").strip()
    if not text:
        return ""
    if "://" not in text and "/" not in text and "?" not in text and "#" not in text:
        return text
    try:
        parsed = urlsplit(text)
    except ValueError:
        return ""
    query = parse_qs(parsed.query)
    for field in NOTE_ID_QUERY_FIELDS:
        candidate = str((query.get(field) or [""])[0]).strip()
        if candidate:
            return candidate
    segments = [segment for segment in parsed.path.split("/") if segment]
    lowered_segments = [segment.casefold() for segment in segments]
    for index, segment in enumerate(lowered_segments[:-1]):
        if segment in NOTE_ID_PATH_PREFIXES:
            return segments[index + 1]
        if (
            segment == "discovery"
            and lowered_segments[index + 1] == "item"
            and index + 2 < len(segments)
        ):
            return segments[index + 2]
    return ""


def canonical_note_url(value: Any) -> str:
    """Drop volatile signed-query data when a URL has no extractable note id."""

    text = str(value or "").strip()
    if not text:
        return ""
    try:
        parsed = urlsplit(text)
    except ValueError:
        return text
    if not parsed.scheme or not parsed.netloc:
        return text
    return urlunsplit(
        (parsed.scheme.casefold(), parsed.netloc.casefold(), parsed.path.rstrip("/"), "", "")
    )


def record_note_id(record: Mapping[str, Any]) -> str:
    for field in NOTE_ID_FIELDS:
        note_id = note_id_from_value(record.get(field))
        if note_id:
            return note_id
    for field in NOTE_URL_FIELDS:
        note_id = note_id_from_value(record.get(field))
        if note_id:
            return note_id
    return ""


def record_key(record: Mapping[str, Any]) -> str:
    note_id = record_note_id(record)
    if note_id:
        return note_id
    for field in NOTE_URL_FIELDS:
        normalized_url = canonical_note_url(record.get(field))
        if normalized_url:
            return normalized_url
    return ""


def record_identity_keys(record: Mapping[str, Any]) -> list[str]:
    note_id = record_note_id(record)
    if note_id:
        return [f"id:{note_id}"]
    key = record_key(record)
    return [f"url:{key}"] if key else []
