from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from application_intelligence_agents import run_pipeline, write_pipeline_artifacts
from ai_application_workflow import enrich_payload
from parallel_body_completion import complete_bodies


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CANDIDATE_PROFILE = PROJECT_ROOT / "profiles/candidate_profile.json"


def resolve_upstream_runner(explicit: str = "") -> Path:
    candidates = [
        Path(explicit) if explicit else None,
        Path(os.environ["XHS_UPSTREAM_RUNNER"]) if os.environ.get("XHS_UPSTREAM_RUNNER") else None,
        PROJECT_ROOT / "vendor/xiaohongshu-relay-scrape/scripts/run_xiaohongshu_relay_scrape.py",
        Path(os.environ["CODEX_HOME"]) / "skills/xiaohongshu-relay-scrape/scripts/run_xiaohongshu_relay_scrape.py"
        if os.environ.get("CODEX_HOME")
        else None,
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError(
        "Could not locate the upstream Xiaohongshu relay runner. Set XHS_UPSTREAM_RUNNER "
        "or install the xiaohongshu-relay-scrape skill under CODEX_HOME."
    )


def resolve_upstream_scraper(upstream_runner: Path) -> Path:
    candidates = [
        Path(os.environ["XHS_UPSTREAM_SCRAPER"]) if os.environ.get("XHS_UPSTREAM_SCRAPER") else None,
        upstream_runner.parent / "scrape_xiaohongshu_search.py",
        PROJECT_ROOT / "vendor/xiaohongshu-relay-scrape/scripts/scrape_xiaohongshu_search.py",
        Path(os.environ["CODEX_HOME"]) / "skills/xiaohongshu-relay-scrape/scripts/scrape_xiaohongshu_search.py"
        if os.environ.get("CODEX_HOME")
        else None,
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return candidate.resolve()
    return upstream_runner.parent / "scrape_xiaohongshu_search.py"


def rewrite_unlimited_args(arguments: list[str]) -> list[str]:
    rewritten: list[str] = []
    skip_next = False
    for argument in arguments:
        if skip_next:
            skip_next = False
            continue
        if argument == "--limit":
            skip_next = True
            continue
        if argument.startswith("--limit="):
            continue
        rewritten.append(argument)
    return rewritten + ["--limit", "0"]


def rewrite_limit(arguments: list[str], limit: int) -> list[str]:
    """Keep the historical argument helper available to integrations and tests."""
    rewritten = rewrite_unlimited_args(arguments)
    return rewritten[:-2] + ["--limit", str(limit)]


def option_value(arguments: list[str], name: str) -> str:
    for index, argument in enumerate(arguments):
        if argument == name and index + 1 < len(arguments):
            return arguments[index + 1]
        if argument.startswith(f"{name}="):
            return argument.split("=", 1)[1]
    return ""


def parse_wrapper_args(arguments: list[str]) -> tuple[argparse.Namespace, list[str]]:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--candidate-profile", default=str(DEFAULT_CANDIDATE_PROFILE))
    parser.add_argument("--analyze-checkpoint", action="store_true")
    parser.add_argument("--upstream-runner", default="")
    parser.add_argument("--security-verification-timeout-seconds", type=int, default=600)
    parser.add_argument("--codex-runtime", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--codex-cli-bin", default="")
    parser.add_argument("--codex-batch-size", type=int, default=8)
    parser.add_argument("--codex-timeout-seconds", type=int, default=300)
    parser.add_argument("--cover-letter-threshold", type=int, default=90)
    parser.add_argument("--cover-letter-max-attempts", type=int, default=4)
    return parser.parse_known_args(arguments)


def add_flag_once(arguments: list[str], flag: str) -> list[str]:
    return list(arguments) if flag in arguments else [*arguments, flag]


def add_option_once(arguments: list[str], name: str, value: str) -> list[str]:
    if option_value(arguments, name):
        return list(arguments)
    return [*arguments, name, value]


def resolve_project_path(value: str) -> Path:
    candidate = Path(value)
    return (candidate if candidate.is_absolute() else PROJECT_ROOT / candidate).resolve()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def atomic_json(path: Path, payload: Any) -> None:
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def build_workflow_summary(payload: dict[str, Any], body_summary: dict[str, Any] | None = None) -> dict[str, Any]:
    gate = payload["quality_gate"]
    records = payload["records"]
    body_summary = body_summary or {}
    time_normalized = sum(1 for record in records if record["publish_time"]["value"])
    exact_time = sum(
        1
        for record in records
        if record["publish_time"]["value"]
        and not record["publish_time"]["is_estimated"]
        and record["publish_time"]["precision"] in {"day", "minute"}
    )
    estimated_time = sum(1 for record in records if record["publish_time"]["is_estimated"])
    contacts = sum(len(record["application_info"]["contacts"]) for record in records)
    routes = sum(len(record["application_info"]["application_routes"]) for record in records)
    responsibilities = sum(len(record["application_info"]["responsibilities"]) for record in records)
    requirements = sum(len(record["application_info"]["requirements"]) for record in records)
    greetings = sum(1 for record in records if record["outreach"]["greeting"])
    emails = sum(1 for record in records if record["outreach"]["email_body"])
    cover_letters = sum(1 for record in records if record["outreach"].get("cover_letter"))
    job_cards = sum(1 for record in records if isinstance(record.get("job_card"), dict))
    application_copy = sum(
        1
        for record in records
        if all(
            str(record.get("outreach", {}).get(field) or "").strip()
            for field in ("greeting", "email_subject", "email_body", "cover_letter")
        )
    )
    runtime = payload.get("codex_runtime", {})
    partial_analysis = bool(
        body_summary.get("transitionedToAnalysis")
        or int(body_summary.get("missingBodies") or 0) > 0
    )
    collection_stop_reason = str(body_summary.get("stopReason") or "")
    security_verification = body_summary.get("securityVerification")
    if not isinstance(security_verification, dict):
        security_verification = {}
    security_timeout = (
        collection_stop_reason == "security_verification_timeout"
        or security_verification.get("status") == "timed_out"
    )
    analysis_mode = (
        "security_timeout_partial"
        if security_timeout
        else "partial_collection"
        if partial_analysis
        else "full_collection"
    )
    agent_stages = [
        {"index": 1, "total": 8, "id": "coverage-agent", "label": "full-body-coverage", "status": "partial" if partial_analysis else "completed"},
        {"index": 2, "total": 8, "id": "time-agent", "label": "time-normalization", "status": "completed"},
        {"index": 3, "total": 8, "id": "profile-memory-agent", "label": "background-memory", "status": "completed"},
        {"index": 4, "total": 8, "id": "application-info-agent", "label": "responsibilities-requirements-and-routes", "status": "completed"},
        {"index": 5, "total": 8, "id": "capability-agent", "label": "job-capabilities", "status": "completed"},
        {"index": 6, "total": 8, "id": "ai-writer-agent", "label": "per-link-outreach", "status": runtime.get("status", "disabled")},
        {"index": 7, "total": 8, "id": "employer-review-agent", "label": "score-and-rewrite", "status": runtime.get("status", "disabled")},
        {
            "index": 8,
            "total": 8,
            "id": "quality-gate-agent",
            "label": "quality-gate-and-artifacts",
            "status": "passed" if gate["passed"] else "failed",
        },
    ]
    return {
        "schemaVersion": 1,
        "runner": "xiaohongshu-project-workflow",
        "status": "completed_partial" if partial_analysis else "succeeded" if gate["passed"] else "failed",
        "analysisMode": analysis_mode,
        "collectionStopReason": collection_stop_reason,
        "securityVerification": security_verification,
        "generatedAt": utc_now(),
        "cardsDiscovered": gate["discovered_count"],
        "notesCollected": gate["record_count"],
        "bodiesCaptured": gate["body_count"],
        "bodyCoveragePercent": round(gate["body_coverage_rate"] * 100, 2),
        "timeNormalizedCount": time_normalized,
        "exactTimeCount": exact_time,
        "estimatedTimeCount": estimated_time,
        "contactsFound": contacts,
        "applicationRoutesFound": routes,
        "responsibilitiesExtracted": responsibilities,
        "requirementsExtracted": requirements,
        "greetingsGenerated": greetings,
        "emailsGenerated": emails,
        "coverLettersGenerated": cover_letters,
        "jobCardsGenerated": job_cards,
        "applicationCopyGenerated": application_copy,
        "generationCoveragePercent": round((application_copy / len(records)) * 100, 2) if records else 100.0,
        "applicationDetailsExtracted": contacts + routes + responsibilities + requirements,
        "codexRuntime": runtime,
        "checks": gate["checks"],
        "issues": gate["issues"],
        "agentStages": agent_stages,
        "discovered": gate["discovered_count"],
        "bodyAttempted": gate["discovered_count"],
        "bodySucceeded": gate["body_count"],
        "timesNormalized": time_normalized,
        "applicationInfo": job_cards,
        "draftsGenerated": application_copy,
        "qualityPassed": 1 if gate["passed"] else 0,
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_project_manifest(output_dir: Path, summary: dict[str, Any]) -> Path:
    manifest_path = output_dir / "artifact-manifest.json"
    artifacts: list[dict[str, Any]] = []
    for path in sorted(output_dir.rglob("*"), key=lambda item: item.as_posix().casefold()):
        if path == manifest_path or not path.is_file():
            continue
        if path.is_symlink():
            raise RuntimeError(f"Refusing to publish symlink artifact: {path}")
        if path.stat().st_size == 0:
            continue
        relative = path.relative_to(output_dir).as_posix()
        artifacts.append({"path": relative, "bytes": path.stat().st_size, "sha256": sha256(path)})
    manifest = {
        "schemaVersion": 1,
        "runId": output_dir.parent.name,
        "runner": "xiaohongshu-project-workflow",
        "status": summary.get("status") or ("succeeded" if summary["checks"] and all(summary["checks"].values()) else "failed"),
        "startedAt": "",
        "updatedAt": utc_now(),
        "recordCount": summary["notesCollected"],
        "bodyCount": summary["bodiesCaptured"],
        "message": "" if not summary["issues"] else "; ".join(item["message"] for item in summary["issues"]),
        "artifacts": artifacts,
    }
    atomic_json(manifest_path, manifest)
    return manifest_path


def emit_stage(index: int, label: str, status: str = "completed") -> None:
    print(f"AGENT_STAGE {index}/8 {label} {status}", flush=True)


def materialize_checkpoint(
    output_dir: Path,
    candidate_profile: Path,
    *,
    stop_reason: str,
    body_summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    print("[checkpoint-analysis] parsing every discovered job card", flush=True)
    notes_checkpoint = output_dir / "xiaohongshu_notes_latest.json"
    if not notes_checkpoint.exists():
        atomic_json(notes_checkpoint, [])
    result = run_pipeline(output_dir, candidate_profile, use_codex_runtime=False)
    summary = build_workflow_summary(
        result.payload,
        body_summary or {
            "transitionedToAnalysis": True,
            "stopReason": stop_reason,
        },
    )
    atomic_json(output_dir / "workflow-summary.json", summary)
    write_project_manifest(output_dir, summary)
    print(
        "CHECKPOINT_ANALYSIS "
        f"records={len(result.payload['records'])} "
        f"job_cards={summary['jobCardsGenerated']} "
        f"application_copy={summary['applicationCopyGenerated']}",
        flush=True,
    )
    return summary


def main(arguments: list[str] | None = None) -> int:
    raw_arguments = list(sys.argv[1:] if arguments is None else arguments)
    wrapper, upstream_arguments = parse_wrapper_args(raw_arguments)
    unlimited_arguments = rewrite_unlimited_args(upstream_arguments)
    output_dir_value = option_value(unlimited_arguments, "--output-dir")
    candidate_profile = Path(os.environ.get("XHS_PROFILE_PATH") or resolve_project_path(wrapper.candidate_profile)).resolve()
    if wrapper.analyze_checkpoint:
        if not output_dir_value:
            raise ValueError("--output-dir is required for checkpoint analysis")
        output_dir = Path(output_dir_value).resolve()
        materialize_checkpoint(output_dir, candidate_profile, stop_reason="terminal_checkpoint")
        return 0

    upstream = resolve_upstream_runner(wrapper.upstream_runner)
    print("[coverage-agent] discovering all job cards before guarded body collection", flush=True)
    scrape_arguments = add_flag_once(unlimited_arguments, "--skip-postprocess")
    scrape_arguments = add_flag_once(scrape_arguments, "--cards-only")
    scrape_arguments = add_option_once(
        scrape_arguments,
        "--security-verification-timeout-seconds",
        str(wrapper.security_verification_timeout_seconds),
    )
    completed = subprocess.run([sys.executable, str(upstream), *scrape_arguments], check=False)
    if completed.returncode != 0:
        if output_dir_value and "--check-only" not in unlimited_arguments:
            output_dir = Path(output_dir_value).resolve()
            if (output_dir / "xiaohongshu_cards_latest.json").is_file():
                try:
                    restriction_path = output_dir / "security-restriction.json"
                    restriction = (
                        json.loads(restriction_path.read_text(encoding="utf-8"))
                        if restriction_path.is_file()
                        else {}
                    )
                    security_timeout = restriction.get("status") == "timed_out"
                    stop_reason = "security_verification_timeout" if security_timeout else "scrape_runner_failed"
                    materialize_checkpoint(
                        output_dir,
                        candidate_profile,
                        stop_reason=stop_reason,
                        body_summary={
                            "transitionedToAnalysis": True,
                            "stopReason": stop_reason,
                            "newAccessStopped": security_timeout,
                            "securityVerification": restriction,
                        },
                    )
                except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
                    print(f"[checkpoint-analysis] failed: {error}", file=sys.stderr, flush=True)
        return completed.returncode
    if "--check-only" in unlimited_arguments or "--help" in unlimited_arguments or "-h" in unlimited_arguments:
        return 0

    if not output_dir_value:
        raise ValueError("--output-dir is required for project workflow enrichment")
    output_dir = Path(output_dir_value).resolve()
    body_summary = complete_bodies(
        output_dir,
        relay_port=int(option_value(unlimited_arguments, "--relay-port") or 18800),
        workers=1,
        attempts=3,
        goto_timeout_ms=int(option_value(unlimited_arguments, "--goto-timeout-ms") or 15000),
        security_verification_timeout_seconds=wrapper.security_verification_timeout_seconds,
        upstream_scraper=resolve_upstream_scraper(upstream),
    )
    if "--skip-postprocess" not in unlimited_arguments:
        postprocess = upstream.parent / "build_structured_excel.py"
        completed = subprocess.run(
            [
                sys.executable,
                str(postprocess),
                "--input-json",
                str(output_dir / "xiaohongshu_notes_latest.json"),
                "--output-dir",
                str(output_dir),
            ],
            check=False,
        )
        if completed.returncode != 0:
            return completed.returncode
    emit_stage(1, "full-body-coverage")
    result = run_pipeline(
        output_dir,
        candidate_profile,
        use_codex_runtime=False,
        codex_cli_bin=wrapper.codex_cli_bin,
        codex_batch_size=wrapper.codex_batch_size,
        codex_timeout_seconds=wrapper.codex_timeout_seconds,
    )
    emit_stage(2, "time-normalization")
    emit_stage(3, "background-memory")
    if wrapper.codex_runtime:
        profile = json.loads(candidate_profile.read_text(encoding="utf-8"))

        def checkpoint_ai_progress(completed: int, total: int, status: str, _record: dict[str, Any]) -> None:
            if completed % 10 == 0 or completed == total or status != "skipped":
                print(f"AI_RECORD {completed}/{total} {status}", flush=True)
            if completed % 10 == 0 or completed == total:
                atomic_json(output_dir / "application_intelligence.checkpoint.json", result.payload)

        report = enrich_payload(
            result.payload,
            profile,
            threshold=wrapper.cover_letter_threshold,
            max_attempts=wrapper.cover_letter_max_attempts,
            progress_callback=checkpoint_ai_progress,
        )
        write_pipeline_artifacts(output_dir, result.payload)
        print(
            f"[employer-review-agent] processed={report.processed} skipped={report.skipped} "
            f"passed={report.passed} failed={report.failed} attempts={report.attempts}",
            flush=True,
        )
    emit_stage(4, "application-info")
    emit_stage(5, "job-capabilities")
    emit_stage(6, "ai-outreach", result.payload["codex_runtime"]["status"])
    emit_stage(7, "employer-score-and-rewrite", "passed" if result.payload["quality_gate"].get("cover_letter_quality_passed") else "failed")
    gate = result.payload["quality_gate"]
    print(
        "[quality-gate] "
        f"discovered={gate['discovered_count']} records={gate['record_count']} "
        f"full_bodies={gate['body_count']} status={'PASS' if gate['passed'] else 'FAIL'}",
        flush=True,
    )
    for issue in gate["issues"]:
        print(f"[quality-gate] {issue['message']}", flush=True)
    summary = build_workflow_summary(result.payload, body_summary)
    atomic_json(output_dir / "workflow-summary.json", summary)
    result.passed = bool(gate["passed"])
    emit_stage(8, "quality-gate-and-artifacts", "passed" if result.passed else "failed")
    write_project_manifest(output_dir, summary)
    return 0 if result.passed else 3


if __name__ == "__main__":
    raise SystemExit(main())
