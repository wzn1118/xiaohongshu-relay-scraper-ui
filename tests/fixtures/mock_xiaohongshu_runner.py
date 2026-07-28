#!/usr/bin/env python3
"""Deterministic stand-in for the local Xiaohongshu relay runner.

The fixture intentionally uses only the Python standard library so a Node
process can spawn it on Windows, macOS, or Linux without installing packages.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import signal
import sys
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote
from xml.sax.saxutils import escape


FINAL_ARTIFACTS = (
    "xiaohongshu_cards_latest.json",
    "xiaohongshu_notes_latest.json",
    "xiaohongshu_notes_latest.csv",
    "xiaohongshu_notes_latest_dedup.json",
    "xiaohongshu_notes_latest_dedup.csv",
    "xiaohongshu_notes_latest_dedup.xlsx",
    "xiaohongshu_notes_structured.xlsx",
)

cancel_requested = False


def log(message: str) -> None:
    print(message, flush=True)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def atomic_text(path: Path, content: str, encoding: str = "utf-8") -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(content, encoding=encoding)
    temporary.replace(path)


def atomic_json(path: Path, payload: Any) -> None:
    atomic_text(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    temporary.replace(path)


def cell_reference(column: int, row: int) -> str:
    letters = ""
    while column:
        column, remainder = divmod(column - 1, 26)
        letters = chr(65 + remainder) + letters
    return f"{letters}{row}"


def worksheet_xml(headers: list[str], rows: list[dict[str, Any]]) -> str:
    values = [headers] + [[row.get(header, "") for header in headers] for row in rows]
    sheet_rows: list[str] = []
    for row_number, values_in_row in enumerate(values, 1):
        cells: list[str] = []
        for column_number, value in enumerate(values_in_row, 1):
            reference = cell_reference(column_number, row_number)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                cells.append(f'<c r="{reference}"><v>{value}</v></c>')
            else:
                rendered = escape(str(value))
                cells.append(
                    f'<c r="{reference}" t="inlineStr"><is><t xml:space="preserve">'
                    f"{rendered}</t></is></c>"
                )
        sheet_rows.append(f'<row r="{row_number}">{"".join(cells)}</row>')
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="A1:{cell_reference(len(headers), len(values))}"/>'
        f'<sheetData>{"".join(sheet_rows)}</sheetData></worksheet>'
    )


def write_xlsx(path: Path, rows: list[dict[str, Any]], sheet_name: str) -> None:
    headers = list(rows[0].keys())
    created_at = utc_now()
    parts = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
            '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
            "</Types>"
        ),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
            '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
            "</Relationships>"
        ),
        "xl/workbook.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f'<sheets><sheet name="{escape(sheet_name)}" sheetId="1" r:id="rId1"/></sheets></workbook>'
        ),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            "</Relationships>"
        ),
        "xl/worksheets/sheet1.xml": worksheet_xml(headers, rows),
        "docProps/core.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            '<dc:creator>Mock Xiaohongshu Runner</dc:creator>'
            f'<dcterms:created xsi:type="dcterms:W3CDTF">{created_at}</dcterms:created></cp:coreProperties>'
        ),
        "docProps/app.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
            '<Application>Mock Xiaohongshu Runner</Application></Properties>'
        ),
    }
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as workbook:
        for member_name, content in parts.items():
            workbook.writestr(member_name, content.encode("utf-8"))
    temporary.replace(path)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact_entries(output_dir: Path, names: tuple[str, ...] | list[str]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for name in names:
        path = output_dir / name
        if path.is_file():
            entries.append({"path": name, "bytes": path.stat().st_size, "sha256": sha256(path)})
    return entries


def write_manifest(
    output_dir: Path,
    run_id: str,
    scenario: str,
    status: str,
    keyword: str,
    started_at: str,
    count: int,
    names: tuple[str, ...] | list[str],
    message: str = "",
) -> None:
    payload = {
        "schemaVersion": 1,
        "runId": run_id,
        "runner": "mock-xiaohongshu-relay",
        "scenario": scenario,
        "status": status,
        "keyword": keyword,
        "startedAt": started_at,
        "updatedAt": utc_now(),
        "recordCount": count,
        "message": message,
        "artifacts": artifact_entries(output_dir, names),
    }
    atomic_json(output_dir / "artifact-manifest.json", payload)


def make_records(keyword: str, search_url: str, count: int) -> list[dict[str, Any]]:
    timestamp = utc_now()
    records: list[dict[str, Any]] = []
    for index in range(1, count + 1):
        note_id = f"mock-note-{index:03d}"
        author = f"Mock Author {index}"
        records.append(
            {
                "note_id": note_id,
                "title": f"{keyword} sample {index}",
                "author": author,
                "author_profile": f"https://www.xiaohongshu.com/user/profile/mock-{index:03d}",
                "note_url": f"https://www.xiaohongshu.com/explore/{note_id}",
                "publish_time": "6天前",
                "like_count": str(index * 10),
                "collect_count": str(index * 3),
                "comment_count": str(index),
                "body": (
                    "岗位职责：负责消费品牌社交媒体内容策划、用户洞察、活动复盘与跨团队推进；"
                    "使用数据看板跟踪触达、互动和转化，提出迭代方案。\n"
                    "任职要求：具备内容运营或市场项目经验，能够独立完成分析、文案和项目协同；"
                    "熟悉 Excel，英文可作为工作语言，每周到岗四天，连续实习三个月以上。\n"
                    "投递方式：发送邮件至 jobs@example.com，主题为姓名-市场运营实习。"
                ),
                "body_html": (
                    "<p>岗位职责：内容策划、用户洞察、活动复盘与跨团队推进。</p>"
                    "<p>任职要求：数据分析、文案和项目协同；每周到岗四天。</p>"
                    "<p>投递方式：jobs@example.com</p>"
                ),
                "tags": keyword,
                "source_card_text": f"{keyword} card {index}",
                "scraped_at": timestamp,
                "access_level": "mock",
                "access_status": "detail_ok",
                "source_search_url": search_url,
                "card_rank": index,
                "card_title": f"{keyword} sample {index}",
                "card_author": author,
                "card_author_profile": f"https://www.xiaohongshu.com/user/profile/mock-{index:03d}",
                "card_publish_time": "6天前",
                "card_like_count": str(index * 10),
                "card_collect_count": str(index * 3),
                "card_comment_count": str(index),
                "card_cover_url": f"https://example.invalid/mock-cover-{index}.jpg",
                "card_cover_alt": f"Mock cover {index}",
                "card_tags": keyword,
                "card_badges": "fixture",
                "card_link_urls": f"https://www.xiaohongshu.com/explore/{note_id}",
                "card_image_urls": f"https://example.invalid/mock-cover-{index}.jpg",
            }
        )
    return records


def make_cards(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "note_id": row["note_id"],
            "title": row["title"],
            "author": row["author"],
            "note_url": row["note_url"],
            "rank": row["card_rank"],
        }
        for row in records
    ]


def should_cancel(cancel_file: Path | None) -> bool:
    return cancel_requested or bool(cancel_file and cancel_file.exists())


def wait_interruptibly(seconds: float, cancel_file: Path | None = None) -> bool:
    deadline = time.monotonic() + max(0.0, seconds)
    while time.monotonic() < deadline:
        if should_cancel(cancel_file):
            return False
        time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
    return not should_cancel(cancel_file)


def install_signal_handlers() -> None:
    def request_cancel(_signum: int, _frame: Any) -> None:
        global cancel_requested
        cancel_requested = True

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        candidate = getattr(signal, name, None)
        if candidate is not None:
            try:
                signal.signal(candidate, request_cancel)
            except (OSError, RuntimeError, ValueError):
                pass


def common_preamble(args: argparse.Namespace, search_url: str) -> None:
    log(f"Search URL: {search_url}")
    log(f"Output directory: {args.output_dir.resolve()}")
    log(f"Resume mode: {bool(args.resume and not args.fresh)}")
    log("Use card cache: False")
    log("Attached relay tabs: 1")
    log(f"- Xiaohongshu mock search | {search_url}")


def run_success(args: argparse.Namespace, output_dir: Path, search_url: str, run_id: str, started_at: str) -> int:
    records = make_records(args.keyword, search_url, args.mock_records)
    cards = make_cards(records)
    log("Running scraper...")
    steps = (
        "Connecting to the active Edge relay...",
        "Opening search page in the existing browser context...",
        "Collecting search result cards...",
        f"Collected {len(cards)} cards.",
        "Scraping note details...",
    )
    for message in steps:
        if not wait_interruptibly(args.mock_delay_seconds, args.mock_cancel_file):
            return finish_cancelled(args, output_dir, run_id, started_at, 0)
        log(message)
    atomic_json(output_dir / "xiaohongshu_cards_latest.json", cards)
    for index, record in enumerate(records, 1):
        if not wait_interruptibly(args.mock_delay_seconds, args.mock_cancel_file):
            return finish_cancelled(args, output_dir, run_id, started_at, index - 1)
        log(f"[{index}/{len(records)}] Saved {record['note_id']}")
    atomic_json(output_dir / "xiaohongshu_notes_latest.json", records)
    write_csv(output_dir / "xiaohongshu_notes_latest.csv", records)
    log(f"Saved JSON: {output_dir / 'xiaohongshu_notes_latest.json'}")
    log(f"Saved CSV: {output_dir / 'xiaohongshu_notes_latest.csv'}")
    log("Running post-process exports...")
    atomic_json(output_dir / "xiaohongshu_notes_latest_dedup.json", records)
    write_csv(output_dir / "xiaohongshu_notes_latest_dedup.csv", records)
    write_xlsx(output_dir / "xiaohongshu_notes_latest_dedup.xlsx", records, "Notes")
    write_xlsx(output_dir / "xiaohongshu_notes_structured.xlsx", records, "Structured Notes")
    write_manifest(
        output_dir,
        run_id,
        args.mock_scenario,
        "succeeded",
        args.keyword,
        started_at,
        len(records),
        FINAL_ARTIFACTS,
    )
    log(f"Structured workbook: {output_dir / 'xiaohongshu_notes_structured.xlsx'}")
    log("Done.")
    return 0


def run_failure(args: argparse.Namespace, output_dir: Path, run_id: str, started_at: str) -> int:
    log("Running scraper...")
    wait_interruptibly(args.mock_delay_seconds, args.mock_cancel_file)
    message = "Mock runner forced failure (scenario=failure)."
    log("Scrape run failed before normal delivery.")
    log(message)
    write_manifest(output_dir, run_id, args.mock_scenario, "failed", args.keyword, started_at, 0, [], message)
    return args.mock_failure_exit_code


def finish_cancelled(
    args: argparse.Namespace,
    output_dir: Path,
    run_id: str,
    started_at: str,
    count: int,
) -> int:
    message = "Cancellation requested; no final export was published."
    write_manifest(
        output_dir,
        run_id,
        args.mock_scenario,
        "cancelled",
        args.keyword,
        started_at,
        count,
        ["xiaohongshu_cards_latest.json"],
        message,
    )
    log("[cancelled] Cancellation requested; stopping mock runner.")
    return 130


def run_long(args: argparse.Namespace, output_dir: Path, search_url: str, run_id: str, started_at: str) -> int:
    records = make_records(args.keyword, search_url, max(1, args.mock_records))
    atomic_json(output_dir / "xiaohongshu_cards_latest.json", make_cards(records))
    write_manifest(
        output_dir,
        run_id,
        args.mock_scenario,
        "running",
        args.keyword,
        started_at,
        0,
        ["xiaohongshu_cards_latest.json"],
        "Waiting for completion or cancellation.",
    )
    log("Running scraper...")
    log("Connecting to the active Edge relay...")
    log("[long] Mock long-running scrape started.")
    deadline = time.monotonic() + args.mock_long_seconds
    heartbeat = 0
    while time.monotonic() < deadline:
        if not wait_interruptibly(args.mock_delay_seconds, args.mock_cancel_file):
            return finish_cancelled(args, output_dir, run_id, started_at, 0)
        heartbeat += 1
        log(f"[long] heartbeat {heartbeat}")
    log("[long] Duration elapsed; publishing final artifacts.")
    return run_success(args, output_dir, search_url, run_id, started_at)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Cross-platform mock for run_xiaohongshu_relay_scrape.py")
    parser.add_argument("--keyword", default="\u5b9e\u4e60\u7ee7\u4efb")
    parser.add_argument("--search-url", default="")
    parser.add_argument("--output-dir", type=Path, default=Path.cwd() / "output" / "mock-run")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--relay-port", type=int, default=18792)
    parser.add_argument("--browser-profile", default="openclaw")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--fresh", action="store_true")
    parser.add_argument(
        "--mock-scenario",
        choices=("success", "failure", "long"),
        default=os.environ.get("MOCK_RUNNER_SCENARIO", "success"),
    )
    parser.add_argument(
        "--mock-records",
        type=int,
        default=int(os.environ.get("MOCK_RUNNER_RECORDS", "3")),
    )
    parser.add_argument(
        "--mock-delay-seconds",
        type=float,
        default=float(os.environ.get("MOCK_RUNNER_DELAY_SECONDS", "0.05")),
    )
    parser.add_argument(
        "--mock-long-seconds",
        type=float,
        default=float(os.environ.get("MOCK_RUNNER_LONG_SECONDS", "300")),
    )
    parser.add_argument("--mock-cancel-file", type=Path)
    parser.add_argument("--mock-failure-exit-code", type=int, default=1)
    args, _unknown = parser.parse_known_args()
    if args.limit > 0:
        args.mock_records = min(args.mock_records, args.limit)
    if args.mock_records < 1:
        parser.error("--mock-records must be at least 1")
    if args.mock_delay_seconds < 0 or args.mock_long_seconds < 0:
        parser.error("mock timing values must not be negative")
    args.output_dir = args.output_dir.resolve()
    if args.mock_cancel_file is not None:
        args.mock_cancel_file = args.mock_cancel_file.resolve()
    return args


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
        sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
    except (AttributeError, ValueError):
        pass
    install_signal_handlers()
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    search_url = args.search_url or (
        "https://www.xiaohongshu.com/search_result/?keyword="
        f"{quote(args.keyword)}&source=web_note_detail_r10&type=51"
    )
    run_id = f"mock-{uuid.uuid4().hex[:12]}"
    started_at = utc_now()
    common_preamble(args, search_url)
    if args.mock_scenario == "failure":
        return run_failure(args, args.output_dir, run_id, started_at)
    if args.mock_scenario == "long":
        return run_long(args, args.output_dir, search_url, run_id, started_at)
    return run_success(args, args.output_dir, search_url, run_id, started_at)


if __name__ == "__main__":
    raise SystemExit(main())
