from __future__ import annotations

import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import parallel_body_completion as body_completion  # noqa: E402


SCHEMA_DIR = ROOT / "schemas"
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "workflow" / "body-events.json"


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def workflow_event_validator() -> Draft202012Validator:
    problem_schema = load_json(SCHEMA_DIR / "user-problem-v1.schema.json")
    event_schema = load_json(SCHEMA_DIR / "workflow-event-v1.schema.json")
    registry = Registry().with_resource(
        problem_schema["$id"],
        Resource.from_contents(problem_schema),
    )
    return Draft202012Validator(event_schema, registry=registry)


def test_shared_body_event_fixture_matches_workflow_event_v1() -> None:
    fixture = load_json(FIXTURE_PATH)
    validator = workflow_event_validator()

    for event in fixture["events"]:
        validator.validate(event)

    sequences = [event["sequence"] for event in fixture["events"]]
    assert sequences == sorted(set(sequences))
    assert fixture["expected"]["throughSequence"] == sequences[-1]


def test_python_emitter_outputs_schema_valid_single_line_event(capsys) -> None:
    emitter = body_completion.WorkflowEventEmitter(
        job_id="job-test",
        attempt_id="attempt-test",
    )
    problem = body_completion.body_user_problem(
        "detail_rate_limited",
        saved=9,
        total=20,
    )

    emitted = emitter.emit(
        event_type="warning",
        state="waiting_system",
        message_code="body.rate_limited",
        progress={
            "unit": "body",
            "done": 2,
            "total": 12,
            "succeeded": 1,
            "reused": 8,
            "retryable": 11,
            "failed": 0,
            "blocked": 1,
        },
        performance={
            "activePerMinute": 9.5,
            "wallPerMinute": 7.2,
            "etaMinSeconds": 59.1,
            "etaMaxSeconds": 86.8,
            "confidence": "low",
        },
        problem=problem,
    )

    output = capsys.readouterr().out.strip()
    assert output.startswith("WORKFLOW_EVENT ")
    assert json.loads(output.removeprefix("WORKFLOW_EVENT ")) == emitted
    assert emitted["problem"]["technicalRef"] == emitted["eventId"]
    assert emitted["problem"]["action"]["id"] == "check_recovery"
    assert emitted["performance"]["activePerMinute"] == 9.5
    workflow_event_validator().validate(emitted)


def test_unknown_body_failure_does_not_create_misleading_user_problem() -> None:
    assert body_completion.body_user_problem(
        "detail_unexpected_error",
        saved=3,
        total=10,
    ) is None
