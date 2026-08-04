from __future__ import annotations

import argparse
import sys
from pathlib import Path

from application_intelligence_agents import run_pipeline


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Enrich Xiaohongshu notes with time, application, fit, and outreach agents.")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--candidate-profile", default=str(PROJECT_ROOT / "profiles/candidate_profile.json"))
    parser.add_argument("--allow-incomplete", action="store_true", help="Write artifacts but do not fail on quality-gate issues.")
    parser.add_argument("--codex-runtime", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--codex-cli-bin", default="")
    parser.add_argument("--codex-batch-size", type=int, default=8)
    parser.add_argument("--codex-timeout-seconds", type=int, default=300)
    parser.add_argument("--writeback-url", default="", help="Relay API base URL or full application-generation/writeback endpoint.")
    parser.add_argument("--writeback-job-id", default="", help="Job id used when --writeback-url is an API base URL.")
    parser.add_argument("--writeback-timeout-seconds", type=int, default=30)
    parser.add_argument("--generation-run-id", default="")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    candidate_profile = Path(args.candidate_profile)
    if not candidate_profile.is_absolute():
        candidate_profile = PROJECT_ROOT / candidate_profile
    result = run_pipeline(
        Path(args.output_dir).resolve(),
        candidate_profile.resolve(),
        use_codex_runtime=args.codex_runtime,
        codex_cli_bin=args.codex_cli_bin,
        codex_batch_size=args.codex_batch_size,
        codex_timeout_seconds=args.codex_timeout_seconds,
        writeback_url=args.writeback_url,
        writeback_job_id=args.writeback_job_id,
        writeback_timeout_seconds=args.writeback_timeout_seconds,
        generation_run_id=args.generation_run_id,
    )
    gate = result.payload["quality_gate"]
    print(
        "[application-agents] "
        f"discovered={gate['discovered_count']} records={gate['record_count']} "
        f"bodies={gate['body_count']} gate={'PASS' if result.passed else 'FAIL'}",
        flush=True,
    )
    for issue in gate["issues"]:
        print(f"[quality-gate] {issue['message']}", flush=True)
    return 0 if result.passed or args.allow_incomplete else 3


if __name__ == "__main__":
    raise SystemExit(main())
