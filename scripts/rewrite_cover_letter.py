from __future__ import annotations

import json
import sys
from typing import Any

from ai_provider_runtime import AIProvider
from cover_letter_rewriter import rewrite_cover_letter


def _object(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("Request body must be a JSON object")
        provider = AIProvider()
        result = rewrite_cover_letter(
            provider,
            _object(payload.get("record")),
            _object(payload.get("outreach") or payload.get("current_draft")),
            str(payload.get("instructions") or "").strip(),
            _object(payload.get("candidateProfile") or payload.get("candidate_profile")),
            _object(payload.get("applicationContext") or payload.get("application_context")),
            max_attempts=payload.get("maxAttempts", 2),
        )
        json.dump(
            {
                "result": result,
                "runtime": {
                    "provider": provider.provider,
                    "model": provider.last_request_model or provider.model,
                    "wireApi": provider.wire_api,
                },
            },
            sys.stdout,
            ensure_ascii=False,
        )
        sys.stdout.write("\n")
        return 0
    except Exception as error:  # The Node caller turns this into a typed 502 without replacing the saved draft.
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
