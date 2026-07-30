import errno
import json
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any


def atomic_write_json(path: Path, payload: Any, *, attempts: int = 8) -> None:
    """Replace a JSON artifact without exposing partial writes to UI readers."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())

        last_error: OSError | None = None
        for attempt in range(max(1, attempts)):
            try:
                os.replace(temporary, path)
                return
            except OSError as error:
                last_error = error
                retryable = error.errno in {errno.EACCES, errno.EPERM}
                if not retryable:
                    raise
                if attempt + 1 < attempts:
                    time.sleep(min(0.05 * (2**attempt), 0.8))

        # Windows can deny replacing an existing artifact while the UI is reading it.
        # A full in-place copy keeps the checkpoint moving until the reader releases it.
        if last_error is not None:
            with temporary.open("rb") as source, path.open("wb") as destination:
                shutil.copyfileobj(source, destination)
                destination.flush()
                os.fsync(destination.fileno())
    finally:
        temporary.unlink(missing_ok=True)
