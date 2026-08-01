from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from expansion_collection import _seed_posts, collect_expansion


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def write_json(path: Path, value: Any) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def refresh_artifact_manifest(output_dir: Path) -> None:
    manifest_path = output_dir / "artifact-manifest.json"
    manifest = read_json(manifest_path, {})
    artifacts = []
    for path in sorted(output_dir.rglob("*"), key=lambda item: item.as_posix().casefold()):
        if path == manifest_path or not path.is_file() or path.is_symlink() or path.stat().st_size == 0:
            continue
        artifacts.append({
            "path": path.relative_to(output_dir).as_posix(),
            "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        })
    write_json(manifest_path, {
        **(manifest if isinstance(manifest, dict) else {}),
        "schemaVersion": 1,
        "runId": output_dir.parent.name,
        "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "artifacts": artifacts,
    })


def main() -> int:
    parser = argparse.ArgumentParser(description="Run relationship expansion inside an existing task")
    parser.add_argument("--request-file", required=True)
    args = parser.parse_args()
    request_path = Path(args.request_file).resolve()
    request = read_json(request_path, {})
    output_dir = Path(request["outputDir"]).resolve()
    selected_ids = list(dict.fromkeys(str(item) for item in request.get("seedPostIds", []) if str(item)))
    selected_set = set(selected_ids)
    available = _seed_posts(output_dir, request.get("checkpointDirs", []))
    available_by_id = {str(item.get("postId", "")): item for item in available}
    missing = sorted(selected_set - set(available_by_id))
    if missing:
        print(f"EXPANSION_WORKSPACE_ERROR invalid_seed_ids={json.dumps(missing)}", flush=True)
        return 2
    cancel_path = Path(request["cancelPath"]).resolve()
    summary = collect_expansion(
        output_dir,
        config={**request.get("config", {}), "enabled": True},
        attempt_id=str(request.get("attemptId", "")),
        keyword=str(request.get("keyword", "")),
        relay_port=int(request.get("relayPort", 18800)),
        goto_timeout_ms=int(request.get("gotoTimeoutMs", 15000)),
        note_delay_seconds=float(request.get("noteDelaySeconds", 1.2)),
        stable_rounds=int(request.get("stableRounds", 5)),
        seed_posts=[available_by_id[item] for item in selected_ids],
        cancel_requested=cancel_path.exists,
        materialize_audience_compat=False,
    )
    workflow_path = output_dir / "workflow-summary.json"
    workflow = read_json(workflow_path, {})
    workflow["expansion"] = {
        **(workflow.get("expansion", {}) if isinstance(workflow.get("expansion"), dict) else {}),
        **summary,
        "attemptId": request.get("attemptId", ""),
        "seedPostIds": selected_ids,
        "config": request.get("config", {}),
    }
    write_json(workflow_path, workflow)
    refresh_artifact_manifest(output_dir)
    return 0 if summary.get("status") == "complete" else 3


if __name__ == "__main__":
    raise SystemExit(main())
