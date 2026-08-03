#!/usr/bin/env python3
"""Isolated, bounded parsing for Data Copilot document/image attachments."""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree


MAX_DOCX_XML_BYTES = 12 * 1024 * 1024
MAX_PDF_PAGES = 500


def output(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def clipped(text: str, limit: int) -> tuple[str, bool]:
    return text[:limit], len(text) > limit


def parse_docx(path: Path, limit: int) -> dict:
    with zipfile.ZipFile(path) as archive:
        try:
            info = archive.getinfo("word/document.xml")
        except KeyError as error:
            raise ValueError("DOCX document.xml is missing") from error
        if info.file_size > MAX_DOCX_XML_BYTES:
            raise ValueError("DOCX document.xml exceeds the extraction limit")
        root = ElementTree.fromstring(archive.read(info))

    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    paragraphs: list[str] = []
    for paragraph in root.iter(f"{namespace}p"):
        parts: list[str] = []
        for element in paragraph.iter():
            if element.tag == f"{namespace}t" and element.text:
                parts.append(element.text)
            elif element.tag == f"{namespace}tab":
                parts.append("\t")
            elif element.tag in {f"{namespace}br", f"{namespace}cr"}:
                parts.append("\n")
        value = "".join(parts).strip()
        if value:
            paragraphs.append(value)
    text = "\n".join(paragraphs)
    value, truncated = clipped(text, limit)
    return {
        "parser": "python-stdlib-docx",
        "kind": "document",
        "text": value,
        "characterCount": len(text),
        "paragraphCount": len(paragraphs),
        "truncated": truncated,
    }


def parse_pdf(path: Path, limit: int) -> dict:
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        return {
            "parser": "metadata_only",
            "kind": "pdf",
            "size": path.stat().st_size,
            "pageCount": None,
            "text": "",
            "truncated": True,
            "unavailableReason": "Python pypdf is unavailable.",
        }

    reader = PdfReader(str(path), strict=False)
    page_count = len(reader.pages)
    pages: list[str] = []
    remaining = limit
    scanned = 0
    for page in reader.pages[:MAX_PDF_PAGES]:
        if remaining <= 0:
            break
        value = page.extract_text() or ""
        pages.append(value[:remaining])
        remaining -= len(value)
        scanned += 1
    text = "\n".join(pages)
    truncated = page_count > scanned or len(text) >= limit
    metadata = {str(key).lstrip("/"): str(value) for key, value in (reader.metadata or {}).items()}
    return {
        "parser": "pypdf",
        "kind": "pdf",
        "text": text[:limit],
        "characterCount": len(text),
        "pageCount": page_count,
        "pagesScanned": scanned,
        "metadata": metadata,
        "truncated": truncated,
    }


def parse_image(path: Path) -> dict:
    try:
        from PIL import Image  # type: ignore
        Image.MAX_IMAGE_PIXELS = 50_000_000
    except ImportError:
        return {
            "parser": "metadata_only",
            "kind": "image",
            "size": path.stat().st_size,
            "truncated": False,
            "unavailableReason": "Python Pillow is unavailable.",
        }

    with Image.open(path) as image:
        return {
            "parser": "pillow",
            "kind": "image",
            "format": str(image.format or ""),
            "width": int(image.width),
            "height": int(image.height),
            "mode": str(image.mode),
            "frameCount": int(getattr(image, "n_frames", 1)),
            "animated": bool(getattr(image, "is_animated", False)),
            "size": path.stat().st_size,
            "truncated": False,
        }


def main() -> int:
    if len(sys.argv) != 5 or sys.argv[1] != "parse":
        print("usage: parse PATH FORMAT MAX_CHARACTERS", file=sys.stderr)
        return 2
    path = Path(sys.argv[2]).resolve(strict=True)
    format_name = sys.argv[3]
    limit = max(1_000, min(int(sys.argv[4]), 2_000_000))
    if format_name == "docx":
        value = parse_docx(path, limit)
    elif format_name == "pdf":
        value = parse_pdf(path, limit)
    elif format_name == "image":
        value = parse_image(path)
    else:
        raise ValueError(f"unsupported attachment format: {format_name}")
    output(value)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # Keep stdout JSON-only for the Node caller.
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
