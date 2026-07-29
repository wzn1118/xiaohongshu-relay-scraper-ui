from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from unittest import mock

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "vendor" / "xiaohongshu-relay-scrape" / "scripts"
sys.path.insert(0, str(SCRIPTS))

SPEC = importlib.util.spec_from_file_location("relay_runner", SCRIPTS / "run_xiaohongshu_relay_scrape.py")
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def test_streaming_command_inherits_parent_output() -> None:
    with mock.patch.object(
        RUNNER.subprocess,
        "run",
        return_value=subprocess.CompletedProcess(["sample"], 0),
    ) as run:
        assert RUNNER.run_streaming_command(["sample"]) == 0

    run.assert_called_once_with(["sample"], check=False)


def test_streaming_command_raises_for_nonzero_exit() -> None:
    with mock.patch.object(
        RUNNER.subprocess,
        "run",
        return_value=subprocess.CompletedProcess(["sample"], 7),
    ):
        with pytest.raises(RuntimeError, match="exit code 7"):
            RUNNER.run_streaming_command(["sample"])


def test_latest_resume_refreshes_live_search_cards(tmp_path: Path) -> None:
    (tmp_path / "xiaohongshu_cards_latest.json").write_text("[]", encoding="utf-8")

    assert not RUNNER.should_use_card_cache(True, tmp_path, "latest")
    assert RUNNER.should_use_card_cache(True, tmp_path, "comprehensive")


def test_runner_accepts_search_security_wait_configuration(monkeypatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        ["runner", "--security-verification-timeout-seconds", "900"],
    )

    assert RUNNER.parse_args().security_verification_timeout_seconds == 900
