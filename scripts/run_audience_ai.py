from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from ai_provider_runtime import AIProvider
from audience_ai_pipeline import (
    EVENT_PREFIX,
    PROMPT_VERSION,
    AudienceAiCancelled,
    AudienceAiPipeline,
    DeterministicAudienceAiProvider,
    PipelineConfig,
    atomic_write_json,
    redact_secrets,
    utc_now,
)
from audience_ai_schemas import SCHEMA_VERSION


EXIT_COMPLETE = 0
EXIT_CANCELLED = 2
EXIT_INCOMPLETE = 3


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run grounded per-post audience AI analysis.")
    parser.add_argument("--input", required=True, type=Path, help="Immutable audience snapshot JSON.")
    parser.add_argument("--output-dir", required=True, type=Path, help="Directory for one analysis run.")
    parser.add_argument("--run-id", required=True, help="Run identifier; must match input.runId when present.")
    parser.add_argument("--resume", action="store_true", help="Reuse validated chunk checkpoints.")
    parser.add_argument("--cancel-file", type=Path, default=None, help="Cancellation sentinel path.")
    parser.add_argument("--checkpoint-dir", type=Path, default=None, help="Checkpoint directory override.")
    parser.add_argument("--model-context-tokens", type=int, default=16_384)
    parser.add_argument("--input-ratio", type=float, default=0.55)
    parser.add_argument("--max-users-per-batch", type=int, default=25)
    parser.add_argument(
        "--test-provider",
        choices=("none", "deterministic"),
        default="none",
        help="Explicit test-only provider; production defaults to AIProvider.",
    )
    return parser.parse_args(argv)


def emit(event: dict[str, Any]) -> None:
    print(EVENT_PREFIX + json.dumps(redact_secrets(event), ensure_ascii=False, separators=(",", ":")), flush=True)


def load_snapshot(path: Path, run_id: str) -> dict[str, Any]:
    payload = json.loads(path.resolve().read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("input snapshot must be a JSON object")
    input_run_id = str(payload.get("runId") or "").strip()
    if input_run_id and input_run_id != run_id:
        raise ValueError("--run-id does not match input.runId")
    payload["runId"] = run_id
    return payload


def identity(snapshot: dict[str, Any] | None, run_id: str) -> dict[str, str]:
    source = snapshot or {}
    return {
        "jobId": str(source.get("jobId") or ""),
        "postId": str(source.get("postId") or ""),
        "runId": run_id,
        "inputRevision": str(source.get("inputRevision") or ""),
    }


def write_terminal_metadata(
    output_dir: Path,
    snapshot: dict[str, Any] | None,
    run_id: str,
    *,
    status: str,
    error_code: str,
    message: str,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    metadata = {
        "schemaVersion": SCHEMA_VERSION,
        "promptVersion": PROMPT_VERSION,
        **identity(snapshot, run_id),
        "status": status,
        "provider": "",
        "model": "",
        "profileMode": str((snapshot or {}).get("scope", {}).get("profileMode") or "none"),
        "modules": list((snapshot or {}).get("scope", {}).get("modules") or []),
        "completedAt": utc_now(),
        "resumable": True,
        "errorCode": error_code,
        "message": str(redact_secrets(message))[:1_000],
    }
    atomic_write_json(output_dir / "run-metadata.json", metadata)
    return metadata


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    snapshot: dict[str, Any] | None = None
    output_dir = args.output_dir.resolve()
    try:
        snapshot = load_snapshot(args.input, args.run_id)
        config = PipelineConfig(
            model_context_tokens=max(4_096, args.model_context_tokens),
            input_ratio=max(0.25, min(args.input_ratio, 0.70)),
            max_users_per_batch=max(1, min(args.max_users_per_batch, 100)),
        )
        provider = (
            DeterministicAudienceAiProvider()
            if args.test_provider == "deterministic"
            else AIProvider(model_context_tokens=config.model_context_tokens)
        )
        pipeline = AudienceAiPipeline(provider, config=config, event_callback=emit)
        result = pipeline.run(
            snapshot,
            output_dir,
            resume=args.resume,
            cancel_file=args.cancel_file,
            checkpoint_dir=args.checkpoint_dir,
        )
        return EXIT_COMPLETE if result.status == "complete" else EXIT_INCOMPLETE
    except AudienceAiCancelled as error:
        metadata = write_terminal_metadata(
            output_dir,
            snapshot,
            args.run_id,
            status="cancelled",
            error_code="AUDIENCE_AI_CANCELLED",
            message=str(error),
        )
        emit({"type": "audience_ai_cancelled", **identity(snapshot, args.run_id), "status": "cancelled", "metadata": metadata})
        return EXIT_CANCELLED
    except Exception as error:  # CLI boundary: always leave machine-readable failure state.
        metadata = write_terminal_metadata(
            output_dir,
            snapshot,
            args.run_id,
            status="failed",
            error_code="AUDIENCE_AI_FAILED",
            message=f"{type(error).__name__}: {error}",
        )
        emit({"type": "audience_ai_failed", **identity(snapshot, args.run_id), "status": "failed", "metadata": metadata})
        return EXIT_INCOMPLETE


if __name__ == "__main__":
    sys.exit(main())
