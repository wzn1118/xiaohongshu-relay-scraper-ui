from __future__ import annotations

import base64
import io
import ipaddress
import json
import math
import os
import socket
import shutil
import subprocess
import tempfile
import time
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


class AIProviderTimeoutError(AIProviderError):
    pass


_LOCAL_IMAGE_MAX_BYTES = 8 * 1024 * 1024
_LOCAL_IMAGE_TOTAL_MAX_BYTES = 20 * 1024 * 1024


def _terminate_process_tree(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        except (OSError, subprocess.SubprocessError):
            pass
    if process.poll() is None:
        try:
            process.kill()
        except OSError:
            pass


def run_with_tree_timeout(
    command: list[str],
    *,
    input_text: str,
    timeout: int,
    encoding: str = "utf-8",
    errors: str = "replace",
) -> subprocess.CompletedProcess[str]:
    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding=encoding,
        errors=errors,
        creationflags=creationflags,
    )
    try:
        stdout, stderr = process.communicate(input=input_text, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        _terminate_process_tree(process)
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired as drain_error:
            _terminate_process_tree(process)
            stdout = drain_error.output or error.output or ""
            stderr = drain_error.stderr or error.stderr or ""
        raise subprocess.TimeoutExpired(
            command,
            timeout,
            output=stdout,
            stderr=stderr,
        ) from error
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


class AIProvider:
    def __init__(
        self,
        provider: str = "",
        api_key: str = "",
        base_url: str = "",
        model: str = "",
        wire_api: str = "",
        timeout: int | None = None,
        total_timeout: int | None = None,
        model_context_tokens: int | None = None,
        max_output_tokens: int | None = None,
    ):
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
        try:
            self.total_timeout = max(30, int(total_timeout)) if total_timeout is not None else 0
        except (TypeError, ValueError):
            self.total_timeout = 0
        configured_context = (
            model_context_tokens
            if model_context_tokens is not None
            else os.environ.get("XHS_AI_MODEL_CONTEXT_TOKENS", "")
        )
        try:
            self.model_context_tokens = max(4_096, min(int(configured_context), 131_072))
        except (TypeError, ValueError):
            self.model_context_tokens = 0
        configured_output_tokens = (
            max_output_tokens
            if max_output_tokens is not None
            else os.environ.get("XHS_AI_MAX_OUTPUT_TOKENS", "4096")
        )
        try:
            self.max_output_tokens = max(256, min(int(configured_output_tokens), 16_384))
        except (TypeError, ValueError):
            self.max_output_tokens = 4_096
        self.last_request_used_images = False
        self.last_request_model = ""
        self._vision_model_cache: str | None = None
        self._terminal_error = ""
        self._budget_deadline = 0.0

    @property
    def requires_api_key(self) -> bool:
        return self.provider != "local_qwen"

    def _remaining_timeout(self) -> int:
        if not self.total_timeout:
            return self.timeout
        now = time.monotonic()
        if not self._budget_deadline:
            self._budget_deadline = now + self.total_timeout
        remaining = math.ceil(self._budget_deadline - now)
        if remaining <= 0:
            self._terminal_error = (
                f"AI runtime budget exhausted after {self.total_timeout} seconds; "
                "remaining records were preserved for a later resume"
            )
            raise AIProviderTimeoutError(self._terminal_error)
        return min(self.timeout, remaining)

    def generate_json(
        self,
        system: str,
        user: str,
        schema: dict[str, Any],
        image_urls: list[str] | None = None,
    ) -> dict[str, Any]:
        if self._terminal_error:
            raise AIProviderTimeoutError(self._terminal_error)
        self._remaining_timeout()
        images = [
            value.strip()
            for value in (image_urls or [])
            if isinstance(value, str) and value.strip().lower().startswith(("http://", "https://"))
        ][:4]
        self.last_request_used_images = False
        self.last_request_model = ""
        schema_instruction = (
            "\nReturn exactly one JSON object matching this JSON Schema; do not add Markdown:\n"
            + json.dumps(schema, ensure_ascii=False)
        )
        if self.provider == "local_qwen":
            local_images = self._download_local_images(images)
            vision_model = self._select_local_vision_model() if local_images else ""
            if local_images and vision_model:
                try:
                    result = self._local_chat(
                        system + schema_instruction,
                        user,
                        schema,
                        local_images,
                        model=vision_model,
                    )
                    self.last_request_used_images = True
                    return result
                except AIProviderError:
                    # Text-only local models still produce a useful result from the note and image alt text.
                    pass
            return self._local_chat(system + schema_instruction, user, schema, model=self.model)
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
            prepared = self._prepare_local_image(image_bytes, content_type)
            if not prepared or len(prepared) > byte_limit:
                continue
            encoded_images.append(base64.b64encode(prepared).decode("ascii"))
            total_bytes += len(prepared)
        return encoded_images

    @staticmethod
    def _prepare_local_image(image_bytes: bytes, content_type: str) -> bytes:
        if "webp" not in content_type and "avif" not in content_type:
            return image_bytes
        try:
            from PIL import Image

            with Image.open(io.BytesIO(image_bytes)) as image:
                converted = image.convert("RGB")
                output = io.BytesIO()
                converted.save(output, format="PNG", optimize=True)
                return output.getvalue()
        except (ImportError, OSError, ValueError):
            return b""

    @staticmethod
    def _is_vision_model(model: str) -> bool:
        lowered = str(model or "").casefold()
        return any(marker in lowered for marker in ("qwen2.5vl", "qwen3-vl", "qwen-vl", "vision", "llava", "minicpm-v"))

    def _ollama_model_capabilities(self, model: str) -> set[str]:
        if not self.base_url or not model:
            return set()
        root_url = self.base_url[:-3] if self.base_url.endswith("/v1") else self.base_url
        request = urllib.request.Request(
            f"{root_url}/api/show",
            data=json.dumps({"model": model}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=min(self.timeout, 10)) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, socket.timeout, json.JSONDecodeError, OSError, ValueError):
            return set()
        return {
            str(capability).strip().casefold()
            for capability in payload.get("capabilities", [])
            if str(capability).strip()
        }

    def _select_local_vision_model(self) -> str:
        configured = os.environ.get("XHS_AI_VISION_MODEL", "").strip()
        if configured:
            return configured
        if self._is_vision_model(self.model):
            return self.model
        if self._vision_model_cache is not None:
            return self._vision_model_cache
        if not self.base_url:
            return ""
        if "vision" in self._ollama_model_capabilities(self.model):
            self._vision_model_cache = self.model
            return self._vision_model_cache
        root_url = self.base_url[:-3] if self.base_url.endswith("/v1") else self.base_url
        try:
            with urllib.request.urlopen(f"{root_url}/api/tags", timeout=min(self.timeout, 10)) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, socket.timeout, json.JSONDecodeError, OSError, ValueError):
            self._vision_model_cache = ""
            return ""
        names = [
            str(item.get("name") or item.get("model") or "").strip()
            for item in payload.get("models", [])
            if isinstance(item, dict)
        ]
        vision_models = [name for name in names if self._is_vision_model(name)]
        preferences = ("qwen2.5vl", "qwen3-vl", "qwen-vl", "minicpm-v", "llava", "vision")
        vision_models.sort(key=lambda name: next(
            (index for index, marker in enumerate(preferences) if marker in name.casefold()),
            len(preferences),
        ))
        self._vision_model_cache = vision_models[0] if vision_models else ""
        return self._vision_model_cache

    def _local_chat(
        self,
        system: str,
        user: str,
        schema: dict[str, Any],
        images: list[str] | None = None,
        model: str = "",
    ) -> dict[str, Any]:
        selected_model = model or self.model
        if not self.base_url or not selected_model:
            raise AIProviderError("Local AI provider configuration is incomplete")
        root_url = self.base_url[:-3] if self.base_url.endswith("/v1") else self.base_url
        user_message: dict[str, Any] = {"role": "user", "content": f"{user}\n/no_think"}
        if images:
            user_message["images"] = images
        parse_error: Exception | None = None
        for attempt in range(1, 4):
            attempt_message = dict(user_message)
            if attempt > 1:
                attempt_message["content"] += (
                    "\nThe previous response was invalid or incomplete JSON. "
                    "Regenerate the complete object from the original input and schema."
                )
            options = {"temperature": 0, "num_predict": self.max_output_tokens}
            if self.model_context_tokens:
                options["num_ctx"] = self.model_context_tokens
            payload = {
                "model": selected_model,
                "stream": False,
                "think": False,
                "format": schema,
                "options": options,
                "messages": [
                    {"role": "system", "content": system},
                    attempt_message,
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
                self.last_request_model = selected_model
            except urllib.error.HTTPError as error:
                detail = error.read().decode("utf-8", errors="replace")[:500]
                raise AIProviderError(f"Local AI provider returned HTTP {error.code}: {detail}") from error
            except (urllib.error.URLError, TimeoutError, socket.timeout, json.JSONDecodeError) as error:
                raise AIProviderError(f"Local AI provider request failed: {error}") from error
            try:
                return _parse_json_object(str(result["message"]["content"]))
            except (KeyError, TypeError) as error:
                raise AIProviderError("Local AI provider response did not contain a message") from error
            except (json.JSONDecodeError, AIProviderError) as error:
                parse_error = error

        raise AIProviderError(
            f"Local AI provider returned invalid structured JSON after 3 attempts: {parse_error}"
        ) from parse_error

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
            request_timeout = self._remaining_timeout()
            try:
                completed = run_with_tree_timeout(
                    command,
                    input_text=prompt,
                    timeout=request_timeout,
                    encoding="utf-8",
                    errors="replace",
                )
            except subprocess.TimeoutExpired as error:
                self._terminal_error = (
                    f"Codex CLI timed out after {request_timeout} seconds; "
                    "the current AI run was stopped and remaining records were preserved"
                )
                raise AIProviderTimeoutError(self._terminal_error) from error
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
