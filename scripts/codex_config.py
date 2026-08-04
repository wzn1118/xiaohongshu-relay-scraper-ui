from __future__ import annotations

import json
import os
import tomllib
from pathlib import Path
from typing import Any


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _toml_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return json.dumps(str(value), ensure_ascii=False)


def current_codex_provider_settings() -> dict[str, Any]:
    """Load the active relay and login used by isolated Codex runs."""
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    try:
        config = tomllib.loads((codex_home / "config.toml").read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, tomllib.TOMLDecodeError):
        return {}

    provider_name = _text(config.get("model_provider"))
    provider = (config.get("model_providers") or {}).get(provider_name, {})
    if not provider_name or not isinstance(provider, dict):
        return {}
    try:
        auth = json.loads((codex_home / "auth.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        auth = {}

    return {
        "provider": "codex",
        "provider_name": provider_name,
        "api_key": _text(auth.get("OPENAI_API_KEY")) if isinstance(auth, dict) else "",
        "base_url": _text(provider.get("base_url")),
        "model": _text(config.get("model")),
        "wire_api": _text(provider.get("wire_api")) or "responses",
    }


def current_codex_runtime_args() -> list[str]:
    """Forward the supported local config.toml settings to an isolated CLI call."""
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    try:
        config = tomllib.loads((codex_home / "config.toml").read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, tomllib.TOMLDecodeError):
        return []

    arguments: list[str] = []
    model = _text(config.get("model"))
    if model:
        arguments.extend(["--model", model])

    review_model = _text(config.get("review_model"))
    if review_model:
        arguments.extend(["--config", f"review_model={_toml_value(review_model)}"])

    provider_name = _text(config.get("model_provider"))
    provider = (config.get("model_providers") or {}).get(provider_name, {})
    if provider_name and isinstance(provider, dict):
        arguments.extend(["--config", f"model_provider={_toml_value(provider_name)}"])
        for key in ("name", "base_url", "wire_api", "requires_openai_auth"):
            if key in provider and isinstance(provider[key], (str, bool)):
                arguments.extend(
                    ["--config", f"model_providers.{provider_name}.{key}={_toml_value(provider[key])}"]
                )

    for key in ("service_tier", "network_access"):
        value = _text(config.get(key))
        if value:
            arguments.extend(["--config", f"{key}={_toml_value(value)}"])
    if isinstance(config.get("windows_wsl_setup_acknowledged"), bool):
        arguments.extend(
            [
                "--config",
                f"windows_wsl_setup_acknowledged={_toml_value(config['windows_wsl_setup_acknowledged'])}",
            ]
        )

    reasoning_effort = _text(config.get("model_reasoning_effort")) or "low"
    disable_response_storage = config.get("disable_response_storage")
    if not isinstance(disable_response_storage, bool):
        disable_response_storage = True
    arguments.extend(
        [
            "--config",
            f"model_reasoning_effort={_toml_value(reasoning_effort)}",
            "--config",
            f"disable_response_storage={_toml_value(disable_response_storage)}",
        ]
    )

    features = config.get("features")
    if isinstance(features, dict) and isinstance(features.get("goals"), bool):
        arguments.extend(["--config", f"features.goals={_toml_value(features['goals'])}"])
    return arguments
