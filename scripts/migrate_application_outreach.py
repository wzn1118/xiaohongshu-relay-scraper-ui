"""Stage historical application copy through the current generation pipeline.

The source artifacts are read-only. A migration output directory receives a
deduplicated card/note input, regenerated application_intelligence artifacts,
and an audit that makes every copy change reviewable before writeback.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from application_intelligence_agents import PROMPT_VERSION, run_pipeline


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _read_json(path: Path) -> Any:
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-16", "utf-16-le", "utf-16-be"):
        try:
            return json.loads(raw.decode(encoding))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
    raise ValueError(f"Invalid JSON artifact: {path}")


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _record_key(record: dict[str, Any], fallback: str) -> str:
    return _text(record.get("note_id") or record.get("noteId") or record.get("id")) or fallback


def _has_body(record: dict[str, Any]) -> bool:
    return bool(_text(record.get("body") or record.get("content") or record.get("text")))


def _copy_hash(record: dict[str, Any]) -> str:
    outreach = record.get("outreach") if isinstance(record.get("outreach"), dict) else {}
    fields = {
        "greeting": _text(outreach.get("greeting")),
        "email_subject": _text(outreach.get("email_subject")),
        "email_body": _text(outreach.get("email_body")),
        "cover_letter": _text(outreach.get("cover_letter")),
    }
    return hashlib.sha256(json.dumps(fields, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def collect_records(input_root: Path, output_root: Path) -> tuple[list[dict[str, Any]], list[str], int]:
    """Collect first-seen records, preferring a later copy that has a body."""

    records_by_key: dict[str, dict[str, Any]] = {}
    source_files: list[str] = []
    raw_count = 0
    output_resolved = output_root.resolve()
    for path in sorted(input_root.rglob("application_intelligence.json")):
        try:
            if output_resolved == path.resolve() or output_resolved in path.resolve().parents:
                continue
            payload = _read_json(path)
        except (OSError, ValueError):
            continue
        records = payload.get("records") if isinstance(payload, dict) else None
        if not isinstance(records, list):
            continue
        source_files.append(str(path))
        raw_count += len(records)
        for index, value in enumerate(records):
            if not isinstance(value, dict):
                continue
            key = _record_key(value, f"{path}#{index}")
            existing = records_by_key.get(key)
            if existing is None or (not _has_body(existing) and _has_body(value)):
                records_by_key[key] = value
    return list(records_by_key.values()), source_files, raw_count


def _staging_record(record: dict[str, Any]) -> dict[str, Any]:
    """Strip generated fields while retaining the source note and job card."""

    result = dict(record)
    for field in ("outreach", "cover_letter_evaluation", "draftVersion", "delivery", "generation"):
        result.pop(field, None)
    if not _text(result.get("body")):
        result["body"] = _text(result.get("content") or result.get("text"))
    return result


def build_audit(old_records: list[dict[str, Any]], new_records: list[dict[str, Any]]) -> dict[str, Any]:
    old_by_key = {_record_key(item, f"old-{index}"): item for index, item in enumerate(old_records)}
    new_by_key = {_record_key(item, f"new-{index}"): item for index, item in enumerate(new_records)}
    changes: list[dict[str, Any]] = []
    for key in sorted(set(old_by_key) | set(new_by_key)):
        old = old_by_key.get(key, {})
        new = new_by_key.get(key, {})
        old_outreach = old.get("outreach") if isinstance(old.get("outreach"), dict) else {}
        new_outreach = new.get("outreach") if isinstance(new.get("outreach"), dict) else {}
        old_hash = _copy_hash(old)
        new_hash = _copy_hash(new)
        changes.append({
            "note_id": key,
            "title": _text(new.get("title") or old.get("title")),
            "change_type": "added" if key not in old_by_key else "removed" if key not in new_by_key else "updated" if old_hash != new_hash else "unchanged",
            "old_copy_hash": old_hash if key in old_by_key else "",
            "new_copy_hash": new_hash if key in new_by_key else "",
            "old_subject": _text(old_outreach.get("email_subject")),
            "new_subject": _text(new_outreach.get("email_subject")),
            "old_cover_letter_chars": len(_text(old_outreach.get("cover_letter"))),
            "new_cover_letter_chars": len(_text(new_outreach.get("cover_letter"))),
            "content_quality": new_outreach.get("content_quality") if isinstance(new_outreach.get("content_quality"), dict) else {},
            "requirement_matches": new_outreach.get("requirement_matches") if isinstance(new_outreach.get("requirement_matches"), list) else [],
            "used_evidence_ids": new_outreach.get("used_evidence_ids") if isinstance(new_outreach.get("used_evidence_ids"), list) else [],
        })
    updated = [item for item in changes if item["change_type"] == "updated"]
    ready = [item for item in changes if item.get("content_quality", {}).get("batch_ready") is True]
    return {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "promptVersion": PROMPT_VERSION,
        "counts": {
            "old": len(old_records),
            "new": len(new_records),
            "updated": len(updated),
            "ready": len(ready),
            "blocked": len(changes) - len(ready),
        },
        "changes": changes,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stage historical application copy through the current prompt and quality gates.")
    parser.add_argument("--input-root", default=str(PROJECT_ROOT / "data"))
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--candidate-profile", default=str(PROJECT_ROOT / "profiles/candidate_profile.json"))
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--no-codex-runtime", action="store_true")
    parser.add_argument("--allow-incomplete", action="store_true", help="Keep a staging audit when some historical rows fail the quality gate.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    input_root = Path(args.input_root).resolve()
    output_dir = Path(args.output_dir).resolve()
    profile_path = Path(args.candidate_profile).resolve()
    records, source_files, raw_count = collect_records(input_root, output_dir)
    selected = records[args.offset:]
    if args.limit > 0:
        selected = selected[:args.limit]
    if not selected:
        raise SystemExit("No historical application records selected")
    cards = [_staging_record(item) for item in selected]
    notes = [_staging_record(item) for item in selected]
    output_dir.mkdir(parents=True, exist_ok=True)
    _write_json(output_dir / "xiaohongshu_cards_latest.json", cards)
    _write_json(output_dir / "xiaohongshu_notes_latest.json", notes)
    _write_json(output_dir / "migration_manifest.json", {
        "schemaVersion": 1,
        "sourceRoot": str(input_root),
        "sourceFiles": source_files,
        "rawRecords": raw_count,
        "deduplicatedRecords": len(records),
        "selectedRecords": len(selected),
        "offset": args.offset,
        "limit": args.limit,
        "sourceIsReadOnly": True,
    })
    result = run_pipeline(
        output_dir,
        profile_path,
        use_codex_runtime=not args.no_codex_runtime,
        persist=True,
    )
    generated = result.payload.get("records") if isinstance(result.payload, dict) else []
    audit = build_audit(selected, generated if isinstance(generated, list) else [])
    _write_json(output_dir / "application_outreach_migration_audit.json", audit)
    gate = result.payload.get("quality_gate", {}) if isinstance(result.payload, dict) else {}
    print(
        "[application-migration] "
        f"selected={len(selected)} generated={len(generated) if isinstance(generated, list) else 0} "
        f"ready={audit['counts']['ready']} blocked={audit['counts']['blocked']} "
        f"gate={'PASS' if result.passed else 'FAIL'} output={output_dir}",
        flush=True,
    )
    for issue in gate.get("issues", []):
        print(f"[quality-gate] {issue.get('message', issue)}", flush=True)
    return 0 if result.passed or args.allow_incomplete else 3


if __name__ == "__main__":
    raise SystemExit(main())
