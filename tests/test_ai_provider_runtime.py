from __future__ import annotations

import base64
import io
import os
import json
import subprocess
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from scripts.ai_provider_runtime import AIProvider, AIProviderError


class AiProviderRuntimeTests(unittest.TestCase):
    def test_openai_compatible_chat_request_includes_image_parts(self) -> None:
        provider = AIProvider(
            provider="openai",
            api_key="test-key",
            base_url="https://api.example/v1",
            model="vision-model",
            wire_api="chat_completions",
            timeout=30,
        )

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return b'{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}'

        with patch("scripts.ai_provider_runtime.urllib.request.urlopen", return_value=Response()) as open_url:
            result = provider.generate_json(
                "system",
                "user",
                {"type": "object"},
                image_urls=["https://img.example/job.jpg"],
            )

        self.assertEqual(result, {"ok": True})
        self.assertTrue(provider.last_request_used_images)
        payload = json.loads(open_url.call_args.args[0].data)
        self.assertEqual(payload["messages"][-1]["content"][0]["type"], "text")
        self.assertEqual(payload["messages"][-1]["content"][1]["image_url"]["url"], "https://img.example/job.jpg")

    def test_local_model_uses_native_structured_api_without_key(self) -> None:
        provider = AIProvider(
            provider="local_qwen",
            api_key="",
            base_url="http://127.0.0.1:11434/v1",
            model="qwen3:4b",
            wire_api="chat_completions",
            timeout=30,
        )

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return b'{"message":{"content":"{\\"summary\\":\\"ready\\"}"}}'

        with patch("scripts.ai_provider_runtime.urllib.request.urlopen", return_value=Response()) as open_url:
            result = provider.generate_json("system", "user", {"type": "object"})

        self.assertEqual(result, {"summary": "ready"})
        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:11434/api/chat")
        self.assertNotIn("Authorization", request.headers)
        payload = json.loads(request.data)
        self.assertEqual(payload["format"], {"type": "object"})
        self.assertEqual(payload["think"], False)
        self.assertEqual(payload["options"]["temperature"], 0)
        self.assertEqual(payload["options"]["num_predict"], 4096)
        self.assertTrue(payload["messages"][-1]["content"].endswith("/no_think"))

    def test_local_model_retries_incomplete_structured_json(self) -> None:
        provider = AIProvider(
            provider="local_qwen",
            base_url="http://127.0.0.1:11434/v1",
            model="qwen3.5:4b",
            timeout=30,
        )

        class Response:
            def __init__(self, body: bytes) -> None:
                self.body = body

            def __enter__(self):
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return self.body

        responses = [
            Response(b'{"message":{"content":"{\\"summary\\":\\"truncated"}}'),
            Response(b'{"message":{"content":"{\\"summary\\":\\"ready\\"}"}}'),
        ]
        with patch("scripts.ai_provider_runtime.urllib.request.urlopen", side_effect=responses) as open_url:
            result = provider.generate_json(
                "system",
                "user",
                {"type": "object", "required": ["summary"]},
            )

        self.assertEqual(result, {"summary": "ready"})
        self.assertEqual(open_url.call_count, 2)
        retry_payload = json.loads(open_url.call_args.args[0].data)
        self.assertIn("previous response was invalid", retry_payload["messages"][-1]["content"])

    def test_local_model_downloads_and_sends_image_bytes(self) -> None:
        provider = AIProvider(
            provider="local_qwen",
            base_url="http://127.0.0.1:11434/v1",
            model="qwen3-vl:4b",
            timeout=30,
        )
        image_bytes = b"fake-image-bytes"
        requests: list[object] = []

        class Response:
            def __init__(self, body: bytes, content_type: str = "application/json") -> None:
                self.body = body
                self.headers = {"Content-Type": content_type}

            def __enter__(self):
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self, *_args: object) -> bytes:
                return self.body

        def open_url(request: object, **_kwargs: object) -> Response:
            requests.append(request)
            if getattr(request, "method", "") == "GET":
                return Response(image_bytes, "image/jpeg")
            return Response(b'{"message":{"content":"{\\"summary\\":\\"vision-ready\\"}"}}')

        with patch("scripts.ai_provider_runtime.urllib.request.urlopen", side_effect=open_url):
            result = provider.generate_json(
                "system",
                "user",
                {"type": "object"},
                image_urls=["https://img.example/job.jpg"],
            )

        self.assertEqual(result, {"summary": "vision-ready"})
        self.assertTrue(provider.last_request_used_images)
        self.assertEqual(len(requests), 2)
        payload = json.loads(getattr(requests[-1], "data"))
        self.assertEqual(payload["messages"][-1]["images"], [base64.b64encode(image_bytes).decode("ascii")])

    def test_local_model_retries_without_images_when_model_is_text_only(self) -> None:
        provider = AIProvider(
            provider="local_qwen",
            base_url="http://127.0.0.1:11434/v1",
            model="qwen3:4b",
            timeout=30,
        )
        chat_payloads: list[dict[str, object]] = []

        class Response:
            def __init__(self, body: bytes, content_type: str = "application/json") -> None:
                self.body = body
                self.headers = {"Content-Type": content_type}

            def __enter__(self):
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self, *_args: object) -> bytes:
                return self.body

        def open_url(request: object, **_kwargs: object) -> Response:
            url = getattr(request, "full_url", str(request))
            if str(url).endswith("/api/show"):
                return Response(b'{"capabilities":["completion"]}')
            if str(url).endswith("/api/tags"):
                return Response(b'{"models":[{"name":"qwen2.5vl:3b"}]}')
            if getattr(request, "method", "") == "GET":
                return Response(b"fake-image-bytes", "image/jpeg")
            payload = json.loads(getattr(request, "data"))
            chat_payloads.append(payload)
            if "images" in payload["messages"][-1]:
                raise urllib.error.URLError("model does not support images")
            return Response(b'{"message":{"content":"{\\"summary\\":\\"text-ready\\"}"}}')

        with patch("scripts.ai_provider_runtime.urllib.request.urlopen", side_effect=open_url):
            result = provider.generate_json(
                "system",
                "user",
                {"type": "object"},
                image_urls=["https://img.example/job.webp"],
            )

        self.assertEqual(result, {"summary": "text-ready"})
        self.assertFalse(provider.last_request_used_images)
        self.assertEqual(len(chat_payloads), 2)
        self.assertEqual(chat_payloads[0]["model"], "qwen2.5vl:3b")
        self.assertEqual(chat_payloads[1]["model"], "qwen3:4b")
        self.assertIn("images", chat_payloads[0]["messages"][-1])
        self.assertNotIn("images", chat_payloads[1]["messages"][-1])

    def test_local_model_uses_declared_vision_capability_without_name_marker(self) -> None:
        provider = AIProvider(
            provider="local_qwen",
            base_url="http://127.0.0.1:11434/v1",
            model="qwen3.5:4b",
            timeout=30,
        )
        chat_payloads: list[dict[str, object]] = []

        class Response:
            def __init__(self, body: bytes, content_type: str = "application/json") -> None:
                self.body = body
                self.headers = {"Content-Type": content_type}

            def __enter__(self):
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self, *_args: object) -> bytes:
                return self.body

        def open_url(request: object, **_kwargs: object) -> Response:
            url = getattr(request, "full_url", str(request))
            if str(url).endswith("/api/show"):
                return Response(b'{"capabilities":["completion","vision"]}')
            if getattr(request, "method", "") == "GET":
                return Response(b"fake-image-bytes", "image/jpeg")
            payload = json.loads(getattr(request, "data"))
            chat_payloads.append(payload)
            return Response(b'{"message":{"content":"{\\"summary\\":\\"vision-ready\\"}"}}')

        with patch("scripts.ai_provider_runtime.urllib.request.urlopen", side_effect=open_url):
            result = provider.generate_json(
                "system",
                "user",
                {"type": "object"},
                image_urls=["https://img.example/job.jpg"],
            )

        self.assertEqual(result, {"summary": "vision-ready"})
        self.assertTrue(provider.last_request_used_images)
        self.assertEqual(provider.last_request_model, "qwen3.5:4b")
        self.assertEqual(chat_payloads[0]["model"], "qwen3.5:4b")
        self.assertIn("images", chat_payloads[0]["messages"][-1])

    def test_local_webp_is_normalized_to_png_for_vision_models(self) -> None:
        from PIL import Image

        source = io.BytesIO()
        Image.new("RGB", (4, 4), color=(20, 100, 200)).save(source, format="WEBP")

        prepared = AIProvider._prepare_local_image(source.getvalue(), "image/webp")

        self.assertTrue(prepared.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_codex_uses_bundled_responses_runtime_when_relay_is_configured(self) -> None:
        provider = AIProvider(
            provider="codex",
            api_key="test-key",
            base_url="https://relay.example/v1",
            model="gpt-5.5",
            wire_api="responses",
            timeout=30,
        )

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return b'{"output_text":"{\\"items\\": []}"}'

        with patch("scripts.ai_provider_runtime.urllib.request.urlopen", return_value=Response()) as open_url, patch(
            "scripts.ai_provider_runtime.shutil.which", side_effect=AssertionError("CLI should not be used")
        ):
            self.assertEqual(provider.generate_json("system", "user", {"type": "object"}), {"items": []})

        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, "https://relay.example/v1/responses")
        self.assertEqual(json.loads(request.data)["model"], "gpt-5.5")
        self.assertEqual(json.loads(request.data)["text"]["format"]["type"], "json_object")

    def test_native_codex_binary_is_preferred_on_windows(self) -> None:
        provider = AIProvider(provider="codex", timeout=30)
        lookups: list[str] = []

        def locate(name: str) -> str | None:
            lookups.append(name)
            return "C:/portable/codex.exe" if name == "codex.exe" else None

        def complete(command: list[str], **_: object) -> subprocess.CompletedProcess[str]:
            output = Path(command[command.index("--output-last-message") + 1])
            output.write_text("{}", encoding="utf-8")
            self.assertEqual(command[0], "C:/portable/codex.exe")
            return subprocess.CompletedProcess(command, 0, "", "")

        with patch("scripts.ai_provider_runtime.shutil.which", side_effect=locate), patch(
            "scripts.ai_provider_runtime.subprocess.run", side_effect=complete
        ):
            self.assertEqual(provider.generate_json("system", "user", {"type": "object"}), {})

        self.assertEqual(lookups, ["codex.exe"])

    def test_codex_timeout_becomes_actionable_provider_error(self) -> None:
        provider = AIProvider(provider="codex", timeout=30)
        with patch("scripts.ai_provider_runtime.shutil.which", return_value="codex"), patch(
            "scripts.ai_provider_runtime.subprocess.run",
            side_effect=subprocess.TimeoutExpired(["codex", "exec"], 30),
        ):
            with self.assertRaisesRegex(AIProviderError, "timed out after 30 seconds"):
                provider.generate_json("system", "user", {"type": "object"})

    def test_codex_model_override_is_forwarded(self) -> None:
        provider = AIProvider(provider="codex", model="portable-model", timeout=30)

        def complete(command: list[str], **_: object) -> subprocess.CompletedProcess[str]:
            output = Path(command[command.index("--output-last-message") + 1])
            output.write_text("{}", encoding="utf-8")
            model_indexes = [index for index, value in enumerate(command) if value == "--model"]
            self.assertEqual(command[model_indexes[-1] + 1], "portable-model")
            return subprocess.CompletedProcess(command, 0, "", "")

        with patch("scripts.ai_provider_runtime.shutil.which", return_value="codex"), patch(
            "scripts.ai_provider_runtime.subprocess.run", side_effect=complete
        ):
            self.assertEqual(provider.generate_json("system", "user", {"type": "object"}), {})

    def test_codex_does_not_override_user_reasoning_effort(self) -> None:
        provider = AIProvider(provider="codex", timeout=30)

        def complete(command: list[str], **_: object) -> subprocess.CompletedProcess[str]:
            output = Path(command[command.index("--output-last-message") + 1])
            output.write_text("{}", encoding="utf-8")
            self.assertNotIn('model_reasoning_effort="low"', command)
            self.assertIn("disable_response_storage=true", command)
            return subprocess.CompletedProcess(command, 0, "", "")

        with patch("scripts.ai_provider_runtime.shutil.which", return_value="codex"), patch(
            "scripts.ai_provider_runtime.subprocess.run", side_effect=complete
        ):
            self.assertEqual(provider.generate_json("system", "user", {"type": "object"}), {})

    def test_codex_forwards_the_configured_relay_profile(self) -> None:
        provider = AIProvider(provider="codex", timeout=30)
        with tempfile.TemporaryDirectory() as temporary:
            Path(temporary, "config.toml").write_text(
                """
model_provider = "OpenAI"
model = "gpt-5.5"
review_model = "gpt-5.5"
model_reasoning_effort = "xhigh"
disable_response_storage = true
network_access = "enabled"
windows_wsl_setup_acknowledged = true

[model_providers.OpenAI]
name = "OpenAI"
base_url = "https://relay.example.invalid"
wire_api = "responses"
requires_openai_auth = true

[features]
goals = true
""".strip(),
                encoding="utf-8",
            )

            def complete(command: list[str], **_: object) -> subprocess.CompletedProcess[str]:
                output = Path(command[command.index("--output-last-message") + 1])
                output.write_text("{}", encoding="utf-8")
                self.assertIn("model_provider=\"OpenAI\"", command)
                self.assertIn("model_providers.OpenAI.base_url=\"https://relay.example.invalid\"", command)
                self.assertIn("model_providers.OpenAI.wire_api=\"responses\"", command)
                self.assertIn("review_model=\"gpt-5.5\"", command)
                self.assertIn("model_reasoning_effort=\"xhigh\"", command)
                self.assertIn("network_access=\"enabled\"", command)
                self.assertIn("features.goals=true", command)
                self.assertIn("--model", command)
                self.assertIn("gpt-5.5", command)
                return subprocess.CompletedProcess(command, 0, "", "")

            with patch.dict(os.environ, {"CODEX_HOME": temporary}, clear=False), patch(
                "scripts.ai_provider_runtime.shutil.which", return_value="codex"
            ), patch("scripts.ai_provider_runtime.subprocess.run", side_effect=complete):
                self.assertEqual(provider.generate_json("system", "user", {"type": "object"}), {})


if __name__ == "__main__":
    unittest.main()
