from __future__ import annotations

import base64
import ipaddress
import json
import os
import socket
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

try:
    from .codex_config import current_codex_runtime_args
except ImportError:
    from codex_config import current_codex_runtime_args


class AIProviderError(RuntimeError):
    pass


_LOCAL_IMAGE_MAX_BYTES = 8 * 1024 * 1024
_LOCAL_IMAGE_TOTAL_MAX_BYTES = 20 * 1024 * 1024


class AIProvider:
    def __init__(self, provider: str = "", api_key: str = "", base_url: str = "", model: str = "", wire_api: str = "", timeout: int | None = None):
        self.provider = (provider or os.environ.get("XHS_AI_PROVIDER") or "codex").strip().lower()
        self.api_key = api_key or os.environ.get("XHS_AI_API_KEY", "")
        self.base_url = (base_url or os.environ.get("XHS_AI_BASE_URL", "")).rstrip("/")
        self.model = model or os.environ.get("XHS_AI_MODEL", "")
        configured_wire_api = wire_api or os.environ.get("XHS_AI_WIRE_API", "")
        self.wire_api = (configured_wire_api or ("responses" if self.provider == "codex" else "chat_completions")).strip().lower().replace("-", "_")
        configured_timeout = timeout if timeout is not None else os.environ.get("XHS_AI_TIMEOUT_SECONDS", "600")
        try:
            self.timeout = max(30, int(configured_timeout))
        except (TypeError, ValueError):
            self.timeout = 600
        self.last_request_used_images = False

    @property
    def requires_api_key(self) -> bool:
        return self.provider != "local_qwen"

    def generate_json(
        self,
        system: str,
        user: str,
        schema: dict[str, Any],
        image_urls: list[str] | None = None,
    ) -> dict[str, Any]:
        images = [
            value.strip()
            for value in (image_urls or [])
            if isinstance(value, str) and value.strip().lower().startswith(("http://", "https://"))
        ][:4]
        self.last_request_used_images = False
        schema_instruction = (
            "\nReturn exactly one JSON object matching this JSON Schema; do not add Markdown:\n"
            + json.dumps(schema, ensure_ascii=False)
        )
        if self.provider == "local_qwen":
            local_images = self._download_local_images(images)
            if local_images:
                try:
                    result = self._local_chat(system + schema_instruction, user, schema, local_images)
                    self.last_request_used_images = True
                    return result
                except AIProviderError:
                    # Text-only local models still produce a useful result from the note and image alt text.
                    pass
            return self._local_chat(system + schema_instruction, user, schema)
        if self.provider == "codex" and not (self.api_key and self.base_url and self.model):
            return self._codex(system + schema_instruction, user, schema)
        if not images:
            return self._openai_compatible(system + schema_instruction, user, self.wire_api)
        try:
            result = self._openai_compatible(system + schema_instruction, user, self.wire_api, images)
            self.last_request_used_images = True
            return result
        except AIProviderError:
            # Some OpenAI-compatible relays expose text-only models under the same API.
            # Retry without image parts so the record still receives text/alt-text analysis.
            return self._openai_compatible(system + schema_instruction, user, self.wire_api)

    def _download_local_images(self, image_urls: list[str]) -> list[str]:
        encoded_images: list[str] = []
        total_bytes = 0
        for image_url in image_urls:
            parsed = urllib.parse.urlparse(image_url)
            hostname = (parsed.hostname or "").strip().lower()
            if parsed.scheme not in {"http", "https"} or not hostname or hostname == "localhost":
                continue
            try:
                address = ipaddress.ip_address(hostname)
            except ValueError:
                address = None
            if address and (address.is_private or address.is_loopback or address.is_link_local or address.is_reserved):
                continue

            remaining_bytes = _LOCAL_IMAGE_TOTAL_MAX_BYTES - total_bytes
            if remaining_bytes <= 0:
                break
            byte_limit = min(_LOCAL_IMAGE_MAX_BYTES, remaining_bytes)
            request = urllib.request.Request(
                image_url,
                headers={
                    "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
                    "User-Agent": "Mozilla/5.0 (compatible; XiaohongshuRelayScraper/1.0)",
                },
                method="GET",
            )
            try:
                with urllib.request.urlopen(request, timeout=min(self.timeout, 30)) as response:
                    content_type = str(getattr(response, "headers", {}).get("Content-Type", "")).lower()
                    image_bytes = response.read(byte_limit + 1)
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, socket.timeout, OSError, ValueError):
                continue
            if (content_type and not content_type.startswith("image/")) or not image_bytes or len(image_bytes) > byte_limit:
                continue
            encoded_images.append(base64.b64encode(image_bytes).decode("ascii"))
            total_bytes += len(image_bytes)
        return encoded_images

    def _local_chat(
        self,
        system: str,
        user: str,
        schema: dict[str, Any],
        images: list[str] | None = None,
    ) -> dict[str, Any]:
        if not self.base_url or not self.model:
            raise AIProviderError("Local AI provider configuration is incomplete")
        root_url = self.base_url[:-3] if self.base_url.endswith("/v1") else self.base_url
        user_message: dict[str, Any] = {"role": "user", "content": f"{user}\n/no_think"}
        if images:
            user_message["images"] = images
        payload = {
            "model": self.model,
            "stream": False,
            "think": False,
            "format": schema,
            "options": {"temperature": 0},
            "messages": [
                {"role": "system", "content": system},
                user_message,
            ],
        }
        request = urllib.request.Request(
            f"{root_url}/api/chat",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:500]
            raise AIProviderError(f"Local AI provider returned HTTP {error.code}: {detail}") from error
        except (urllib.error.URLError, TimeoutError, socket.timeout, json.JSONDecodeError) as error:
            raise AIProviderError(f"Local AI provider request failed: {error}") from error
        try:
            return _parse_json_object(str(result["message"]["content"]))
        except (KeyError, TypeError) as error:
            raise AIProviderError("Local AI provider response did not contain a message") from error

    def _openai_compatible(
        self,
        system: str,
        user: str,
        wire_api: str = "chat_completions",
        image_urls: list[str] | None = None,
    ) -> dict[str, Any]:
        if not self.base_url or not self.model or (self.requires_api_key and not self.api_key):
            raise AIProviderError("AI provider configuration is incomplete")
        if wire_api == "responses":
            return self._responses(system, user, image_urls)
        if wire_api != "chat_completions":
            raise AIProviderError("Unsupported AI wire API")
        user_content: str | list[dict[str, Any]] = user
        if image_urls:
            user_content = [
                {"type": "text", "text": user},
                *[
                    {"type": "image_url", "image_url": {"url": image_url}}
                    for image_url in image_urls
                ],
            ]
        payload = {
            "model": self.model,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user_content},
            ],
            "response_format": {"type": "json_object"},
        }
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers,
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

    def _responses(self, system: str, user: str, image_urls: list[str] | None = None) -> dict[str, Any]:
        input_value: str | list[dict[str, Any]] = user
        if image_urls:
            input_value = [{
                "role": "user",
                "content": [
                    {"type": "input_text", "text": user},
                    *[
                        {"type": "input_image", "image_url": image_url}
                        for image_url in image_urls
                    ],
                ],
            }]
        payload = {
            "model": self.model,
            "instructions": system,
            "input": input_value,
            "temperature": 0.2,
            "text": {"format": {"type": "json_object"}},
        }
        request = urllib.request.Request(
            f"{self.base_url}/responses",
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
        content = result.get("output_text") if isinstance(result, dict) else None
        if not isinstance(content, str):
            parts: list[str] = []
            for item in (result.get("output", []) if isinstance(result, dict) else []):
                for block in (item.get("content", []) if isinstance(item, dict) else []):
                    if not isinstance(block, dict):
                        continue
                    text = block.get("text") or block.get("output_text")
                    if isinstance(text, str):
                        parts.append(text)
            content = "".join(parts)
        if not content:
            raise AIProviderError("AI provider Responses API response did not contain output text")
        return _parse_json_object(content)

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
