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


def test_resume_reuses_checkpoint_cards_even_when_source_sort_is_latest(tmp_path: Path) -> None:
    (tmp_path / "xiaohongshu_cards_latest.json").write_text("[]", encoding="utf-8")

    assert RUNNER.should_use_card_cache(True, tmp_path, "latest")
    assert not RUNNER.should_use_card_cache(False, tmp_path, "latest")


def test_runner_cli_rejects_non_latest_search_sort(monkeypatch) -> None:
    monkeypatch.setattr(sys, "argv", ["runner", "--search-sort", "comprehensive"])
    with pytest.raises(SystemExit):
        RUNNER.parse_args()


def test_runner_accepts_search_security_wait_configuration(monkeypatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        ["runner", "--security-verification-timeout-seconds", "900"],
    )

    assert RUNNER.parse_args().security_verification_timeout_seconds == 900
