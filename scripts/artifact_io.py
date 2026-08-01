import errno
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any


def atomic_write_json(path: Path, payload: Any, *, attempts: int = 8) -> bool:
    """Replace a JSON artifact without exposing partial writes to UI readers."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())

        total_attempts = max(1, attempts)
        for attempt in range(total_attempts):
            try:
                os.replace(temporary, path)
                return True
            except OSError as error:
                retryable = error.errno in {errno.EACCES, errno.EPERM}
                if not retryable:
                    raise
                if attempt + 1 < total_attempts:
                    time.sleep(min(0.05 * (2**attempt), 0.8))

        # Keep the last complete checkpoint visible. A later collection cycle will
        # retry with a newer snapshot after the Windows reader releases the file.
        return False
    finally:
        temporary.unlink(missing_ok=True)
