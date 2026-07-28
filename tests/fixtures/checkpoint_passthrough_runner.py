#!/usr/bin/env python3
"""Validate a captured checkpoint and let the production workflow resume it."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def load_rows(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, list) or not payload:
        raise ValueError(f"checkpoint must contain at least one row: {path}")
    return [row for row in payload if isinstance(row, dict)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--keyword")
    parser.add_argument("--search-url")
    parser.add_argument("--relay-host")
    parser.add_argument("--relay-port")
    parser.add_argument("--browser")
    parser.add_argument("--profile-directory")
    parser.add_argument("--limit")
    parser.add_argument("--scrolls")
    parser.add_argument("--scroll-delay")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--fresh", action="store_true")
    args, _ = parser.parse_known_args()

    output_dir = Path(args.output_dir).expanduser().resolve()
    cards_path = output_dir / "xiaohongshu_cards_latest.json"
    notes_path = output_dir / "xiaohongshu_notes_latest.json"
    cards = load_rows(cards_path)
    notes = load_rows(notes_path)
    complete = [row for row in notes if str(row.get("body") or "").strip()]
    if not complete:
        raise ValueError("checkpoint contains no complete note bodies")
    print(
        json.dumps(
            {
                "status": "checkpoint_ready",
                "cards": len(cards),
                "notes": len(notes),
                "completeBodies": len(complete),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
