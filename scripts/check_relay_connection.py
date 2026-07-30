from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify that Playwright can initialize a Relay CDP session.")
    parser.add_argument("--relay-port", type=int, required=True)
    parser.add_argument("--timeout-ms", type=int, default=60000)
    return parser.parse_args()


def relay_headers(port: int) -> dict[str, str]:
    gateway_token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "").strip()
    config_path = Path(os.environ.get("OPENCLAW_CONFIG_PATH", "").strip() or Path.home() / ".openclaw" / "openclaw.json")
    if not gateway_token and config_path.exists():
        try:
            gateway_token = str(json.loads(config_path.read_text(encoding="utf-8")).get("gateway", {}).get("auth", {}).get("token", "")).strip()
        except (OSError, ValueError, TypeError):
            gateway_token = ""
    if not gateway_token:
        return {}
    token = hmac.new(
        gateway_token.encode("utf-8"),
        f"openclaw-extension-relay-v1:{port}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {"x-openclaw-relay-token": token}


def main() -> int:
    args = parse_args()
    endpoint = f"http://127.0.0.1:{args.relay_port}"
    headers = relay_headers(args.relay_port)
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(
                endpoint,
                headers=headers or None,
                timeout=max(1000, args.timeout_ms),
            )
            contexts = len(browser.contexts)
            pages = sum(len(context.pages) for context in browser.contexts)
            payload: dict[str, Any] = {
                "ok": browser.is_connected(),
                "contexts": contexts,
                "pages": pages,
                "message": f"Playwright connected with {contexts} context(s) and {pages} page(s).",
            }
            print(json.dumps(payload, ensure_ascii=False))
            return 0 if payload["ok"] else 1
    except Exception as error:  # noqa: BLE001
        print(json.dumps({
            "ok": False,
            "type": type(error).__name__,
            "message": str(error),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
