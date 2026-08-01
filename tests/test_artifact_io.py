import errno
import json
import sys
import tempfile
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from artifact_io import atomic_write_json  # noqa: E402


def test_atomic_write_json_retries_windows_access_conflict() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        target = Path(temporary) / "result.json"
        target.write_text('{"old": true}', encoding="utf-8")
        real_replace = __import__("os").replace
        calls = 0

        def flaky_replace(source, destination):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise PermissionError(errno.EACCES, "locked", destination)
            return real_replace(source, destination)

        with mock.patch("artifact_io.os.replace", side_effect=flaky_replace), mock.patch("artifact_io.time.sleep"):
            written = atomic_write_json(target, {"new": True})

        assert written is True
        assert calls == 2
        assert json.loads(target.read_text(encoding="utf-8")) == {"new": True}
        assert not list(target.parent.glob("*.tmp"))


def test_atomic_write_json_preserves_complete_checkpoint_when_target_stays_locked() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        target = Path(temporary) / "result.json"
        target.write_text('{"old": true}', encoding="utf-8")

        locked = PermissionError(errno.EACCES, "locked", str(target))
        with mock.patch("artifact_io.os.replace", side_effect=locked), mock.patch("artifact_io.time.sleep"):
            written = atomic_write_json(target, {"new": True}, attempts=2)

        assert written is False
        assert json.loads(target.read_text(encoding="utf-8")) == {"old": True}
        assert not list(target.parent.glob("*.tmp"))
