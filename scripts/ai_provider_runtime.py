from __future__ import annotations

import json
import os
import socket
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

try:
    from .codex_config import current_codex_runtime_args
except ImportError:
    from codex_config import current_codex_runtime_args


class AIProviderError(RuntimeError):
    pass


class AIProvider:
    def __init__(self, provider: str = "", api_key: str = "", base_url: str = "", model: str = "", timeout: int | None = None):
        self.provider = (provider or os.environ.get("XHS_AI_PROVIDER") or "codex").strip().lower()
        self.api_key = api_key or os.environ.get("XHS_AI_API_KEY", "")
        self.base_url = (base_url or os.environ.get("XHS_AI_BASE_URL", "")).rstrip("/")
        self.model = model or os.environ.get("XHS_AI_MODEL", "")
        configured_timeout = timeout if timeout is not None else os.environ.get("XHS_AI_TIMEOUT_SECONDS", "600")
        try:
            self.timeout = max(30, int(configured_timeout))
        except (TypeError, ValueError):
            self.timeout = 600

    def generate_json(self, system: str, user: str, schema: dict[str, Any]) -> dict[str, Any]:
        schema_instruction = (
            "\nReturn exactly one JSON object matching this JSON Schema; do not add Markdown:\n"
            + json.dumps(schema, ensure_ascii=False)
        )
        if self.provider == "codex":
            return self._codex(system + schema_instruction, user, schema)
        return self._openai_compatible(system + schema_instruction, user)

    def _openai_compatible(self, system: str, user: str) -> dict[str, Any]:
        if not self.api_key or not self.base_url or not self.model:
            raise AIProviderError("AI provider configuration is incomplete")
        payload = {
            "model": self.model,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {"type": "json_object"},
        }
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:500]
            raise AIProviderError(f"AI provider returned HTTP {error.code}: {detail}") from error
        except (urllib.error.URLError, TimeoutError, socket.timeout, json.JSONDecodeError) as error:
            raise AIProviderError(f"AI provider request failed: {error}") from error
        try:
            content = result["choices"][0]["message"]["content"]
            if isinstance(content, list):
                content = "".join(str(item.get("text", "")) for item in content if isinstance(item, dict))
            return _parse_json_object(str(content))
        except (KeyError, IndexError, TypeError) as error:
            raise AIProviderError("AI provider response did not contain a message") from error

    def _codex(self, system: str, user: str, schema: dict[str, Any]) -> dict[str, Any]:
        executable = (
            os.environ.get("CODEX_CLI_BIN")
            or shutil.which("codex.exe")
            or shutil.which("codex")
            or shutil.which("codex.cmd")
        )
        if not executable:
            raise AIProviderError("Codex CLI was not found")
        with tempfile.TemporaryDirectory(prefix="xhs-ai-") as temporary:
            root = Path(temporary)
            schema_path = root / "schema.json"
            output_path = root / "response.json"
            schema_path.write_text(json.dumps(schema, ensure_ascii=False), encoding="utf-8")
            command = [
                executable,
                "exec",
                "--ephemeral",
                "--ignore-user-config",
                "--ignore-rules",
                "--sandbox",
                "read-only",
                "--output-schema",
                str(schema_path),
                "--output-last-message",
                str(output_path),
                *current_codex_runtime_args(),
                "--config",
                "disable_response_storage=true",
            ]
            if self.model:
                command.extend(["--model", self.model])
            command.append("-")
            prompt = f"SYSTEM\n{system}\n\nUSER\n{user}"
            try:
                completed = subprocess.run(
                    command,
                    input=prompt,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=self.timeout,
                    check=False,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                )
            except subprocess.TimeoutExpired as error:
                raise AIProviderError(
                    f"Codex CLI timed out after {self.timeout} seconds; "
                    "increase XHS_AI_TIMEOUT_SECONDS or select a faster model"
                ) from error
            if completed.returncode != 0:
                detail = (completed.stderr or completed.stdout or "Codex CLI failed")[-800:]
                raise AIProviderError(detail)
            if not output_path.is_file():
                raise AIProviderError("Codex CLI did not return structured output")
            return _parse_json_object(output_path.read_text(encoding="utf-8"))


def _parse_json_object(value: str) -> dict[str, Any]:
    text = value.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise AIProviderError("AI response must be a JSON object")
    return parsed
