from __future__ import annotations

import base64
import io
import os
import json
import signal
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from scripts.ai_provider_runtime import AIProvider, AIProviderError, run_with_tree_timeout


class AiProviderRuntimeTests(unittest.TestCase):
    def test_openai_compatible_plain_text_omits_json_controls(self) -> None:
        provider = AIProvider(
            provider="relay",
            api_key="test-key",
            base_url="https://api.example/v1",
            model="gpt-5.6-sol",
            wire_api="chat_completions",
            timeout=30,
        )

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps({
                    "model": "gpt-5.6-sol",
                    "choices": [{"message": {"content": "尊敬的招聘负责人：正文"}}],
                }, ensure_ascii=False).encode("utf-8")

        with patch("scripts.ai_provider_runtime.urllib.request.urlopen", return_value=Response()) as open_url:
            result = provider.generate_text("system", "user")

        self.assertEqual(result, "尊敬的招聘负责人：正文")
        payload = json.loads(open_url.call_args.args[0].data)
        self.assertNotIn("response_format", payload)
        self.assertNotIn("text", payload)
        self.assertEqual(payload["messages"][0]["content"], "system")
        self.assertEqual(provider.last_request_model, "gpt-5.6-sol")
        request = open_url.call_args.args[0]
        self.assertEqual(request.get_header("Accept"), "application/json")
        self.assertEqual(request.get_header("Connection"), "close")
        self.assertNotIn("Python-urllib", request.get_header("User-agent"))

    def test_openai_compatible_text_json_omits_structured_output_controls(self) -> None:
        provider = AIProvider(
            provider="relay",
            api_key="test-key",
            base_url="https://api.example/v1",
            model="gpt-5.6-sol",
            wire_api="chat_completions",
            timeout=30,
        )

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return b'{"choices":[{"message":{"content":"```json\\n{\\"ok\\":true}\\n```"}}]}'

        with patch("scripts.ai_provider_runtime.urllib.request.urlopen", return_value=Response()) as open_url:
            result = provider.generate_json_from_text("system", "user")

        self.assertEqual(result, {"ok": True})
        payload = json.loads(open_url.call_args.args[0].data)
        self.assertNotIn("response_format", payload)
        self.assertEqual(payload["messages"][0]["content"], "system")
        self.assertEqual(payload["model"], "gpt-5.6-sol")

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
        self.assertEqual(payload["max_tokens"], 4_096)
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
            model_context_tokens=16_384,
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
        self.assertEqual(payload["options"]["num_ctx"], 16_384)
        self.assertTrue(payload["messages"][-1]["content"].endswith("/no_think"))

    def test_local_model_plain_text_omits_json_format(self) -> None:
        provider = AIProvider(
            provider="local_qwen",
            base_url="http://127.0.0.1:11434/v1",
            model="qwen3.5:4b",
            timeout=30,
            model_context_tokens=16_384,
        )

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps({
                    "message": {"content": "第一段个人经历。\n\n第二段岗位匹配。"},
                }, ensure_ascii=False).encode("utf-8")

        with patch("scripts.ai_provider_runtime.urllib.request.urlopen", return_value=Response()) as open_url:
            result = provider.generate_text("system", "user")

        self.assertEqual(result, "第一段个人经历。\n\n第二段岗位匹配。")
        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:11434/api/chat")
        self.assertNotIn("Authorization", request.headers)
        payload = json.loads(request.data)
        self.assertNotIn("format", payload)
        self.assertEqual(payload["think"], False)
        self.assertEqual(payload["options"]["num_predict"], 4096)
        self.assertEqual(payload["options"]["num_ctx"], 16_384)
        self.assertEqual(payload["keep_alive"], "15m")

    def test_local_model_honors_bounded_output_token_override(self) -> None:
        provider = AIProvider(
            provider="local_qwen",
            base_url="http://127.0.0.1:11434/v1",
            model="qwen3:4b",
            timeout=30,
            max_output_tokens=1_536,
        )

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return b'{"message":{"content":"{\\"summary\\":\\"ready\\"}"}}'

        with patch("scripts.ai_provider_runtime.urllib.request.urlopen", return_value=Response()) as open_url:
            provider.generate_json("system", "user", {"type": "object"})

        payload = json.loads(open_url.call_args.args[0].data)
        self.assertEqual(payload["options"]["num_predict"], 1_536)
        self.assertEqual(AIProvider(max_output_tokens=1).max_output_tokens, 256)
        self.assertEqual(AIProvider(max_output_tokens=99_999).max_output_tokens, 99_999)
        self.assertEqual(AIProvider(max_output_tokens=999_999).max_output_tokens, 262_144)

    def test_invalid_output_token_override_falls_back_to_default(self) -> None:
        with patch.dict(os.environ, {"XHS_AI_MAX_OUTPUT_TOKENS": "invalid"}):
            provider = AIProvider()

        self.assertEqual(provider.max_output_tokens, 4_096)

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

    def test_local_model_repairs_literal_newlines_inside_json_strings(self) -> None:
        provider = AIProvider(
            provider="local_qwen",
            base_url="http://127.0.0.1:11434/v1",
            model="qwen3.5:4b",
            timeout=30,
        )

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps({
                    "message": {
                        "content": '{"cover_letter":"第一行\n第二行\t正文"}',
                    },
                }, ensure_ascii=False).encode("utf-8")

        with patch("scripts.ai_provider_runtime.urllib.request.urlopen", return_value=Response()):
            result = provider.generate_json(
                "system",
                "user",
                {"type": "object", "required": ["cover_letter"]},
            )

        self.assertEqual(result["cover_letter"], "第一行\n第二行\t正文")

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

    def test_local_model_reads_cached_image_file_without_network_download(self) -> None:
        provider = AIProvider(
            provider="local_qwen",
            base_url="http://127.0.0.1:11434/v1",
            model="qwen3-vl:4b",
            timeout=30,
        )
        requests: list[object] = []

        class Response:
            def __init__(self, body: bytes) -> None:
                self.body = body
                self.headers = {"Content-Type": "application/json"}

            def __enter__(self):
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self, *_args: object) -> bytes:
                return self.body

        with tempfile.TemporaryDirectory() as directory:
            cached = Path(directory) / "cached.image"
            cached.write_bytes(b"cached-image-bytes")

            def open_url(request: object, **_kwargs: object) -> Response:
                requests.append(request)
                return Response(b'{"message":{"content":"{\\"summary\\":\\"cached-ready\\"}"}}')

            with patch("scripts.ai_provider_runtime.urllib.request.urlopen", side_effect=open_url):
                result = provider.generate_json(
                    "system",
                    "user",
                    {"type": "object"},
                    image_files=[str(cached)],
                )

        self.assertEqual(result, {"summary": "cached-ready"})
        self.assertTrue(provider.last_request_used_images)
        self.assertEqual(len(requests), 1)
        payload = json.loads(getattr(requests[0], "data"))
        self.assertEqual(payload["messages"][-1]["images"], [base64.b64encode(b"cached-image-bytes").decode("ascii")])

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

    def test_responses_retries_transient_502_then_succeeds(self) -> None:
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
                return b'{"output_text":"{\\"ok\\":true}"}'

        responses = [
            urllib.error.HTTPError("https://relay.example/v1/responses", 502, "Bad Gateway", {}, io.BytesIO(b"upstream")),
            Response(),
        ]
        with patch("scripts.ai_provider_runtime.urllib.request.urlopen", side_effect=responses) as open_url, patch(
            "scripts.ai_provider_runtime.time.sleep"
        ) as sleep:
            result = provider.generate_json("system", "user", {"type": "object"})

        self.assertEqual(result, {"ok": True})
        self.assertEqual(open_url.call_count, 2)
        sleep.assert_called_once_with(1)

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
            "scripts.ai_provider_runtime.run_with_tree_timeout", side_effect=complete
        ):
            self.assertEqual(provider.generate_json("system", "user", {"type": "object"}), {})

        self.assertEqual(lookups, ["codex.exe"])

    def test_codex_timeout_becomes_actionable_provider_error(self) -> None:
        provider = AIProvider(provider="codex", timeout=30)
        with patch("scripts.ai_provider_runtime.shutil.which", return_value="codex"), patch(
            "scripts.ai_provider_runtime.run_with_tree_timeout",
            side_effect=subprocess.TimeoutExpired(["codex", "exec"], 30),
        ) as runtime:
            with self.assertRaisesRegex(AIProviderError, "timed out after 30 seconds"):
                provider.generate_json("system", "user", {"type": "object"})
            with self.assertRaisesRegex(AIProviderError, "timed out after 30 seconds"):
                provider.generate_json("system", "user", {"type": "object"})

        self.assertEqual(runtime.call_count, 1)

    def test_total_runtime_budget_is_shared_across_requests(self) -> None:
        provider = AIProvider(provider="codex", timeout=300, total_timeout=300)

        with patch("scripts.ai_provider_runtime.time.monotonic", side_effect=[100.0, 385.0, 401.0]):
            self.assertEqual(provider._remaining_timeout(), 300)
            self.assertEqual(provider._remaining_timeout(), 15)
            with self.assertRaisesRegex(AIProviderError, "runtime budget exhausted"):
                provider._remaining_timeout()

        self.assertIn("remaining records were preserved", provider._terminal_error)

    def test_http_retries_use_the_remaining_total_runtime_budget(self) -> None:
        provider = AIProvider(
            provider="openai",
            api_key="test-key",
            base_url="https://api.example/v1",
            model="vision-model",
            timeout=300,
            total_timeout=300,
        )

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return b'{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}'

        def open_url(_request: object, *, timeout: int) -> Response:
            request_timeouts.append(timeout)
            if len(request_timeouts) == 1:
                raise urllib.error.URLError("vision request failed")
            return Response()

        request_timeouts: list[int] = []
        with patch("scripts.ai_provider_runtime.time.monotonic", side_effect=[100.0, 385.0, 395.0]), patch(
            "scripts.ai_provider_runtime.urllib.request.urlopen", side_effect=open_url
        ):
            result = provider.generate_json(
                "system",
                "user",
                {"type": "object"},
                image_urls=["https://img.example/job.jpg"],
            )

        self.assertEqual(result, {"ok": True})
        self.assertEqual(request_timeouts, [15, 5])

    def test_http_retry_stops_when_total_runtime_budget_is_exhausted(self) -> None:
        provider = AIProvider(
            provider="openai",
            api_key="test-key",
            base_url="https://api.example/v1",
            model="vision-model",
            timeout=300,
            total_timeout=300,
        )

        with patch("scripts.ai_provider_runtime.time.monotonic", side_effect=[100.0, 385.0, 401.0]), patch(
            "scripts.ai_provider_runtime.urllib.request.urlopen",
            side_effect=urllib.error.URLError("vision request failed"),
        ) as open_url:
            with self.assertRaisesRegex(AIProviderError, "runtime budget exhausted"):
                provider.generate_json(
                    "system",
                    "user",
                    {"type": "object"},
                    image_urls=["https://img.example/job.jpg"],
                )

        self.assertEqual(open_url.call_count, 1)
        self.assertEqual(open_url.call_args.kwargs["timeout"], 15)

    def test_codex_model_override_is_forwarded(self) -> None:
        provider = AIProvider(provider="codex", model="portable-model", timeout=30)

        def complete(command: list[str], **_: object) -> subprocess.CompletedProcess[str]:
            output = Path(command[command.index("--output-last-message") + 1])
            output.write_text("{}", encoding="utf-8")
            model_indexes = [index for index, value in enumerate(command) if value == "--model"]
            self.assertEqual(command[model_indexes[-1] + 1], "portable-model")
            return subprocess.CompletedProcess(command, 0, "", "")

        with patch("scripts.ai_provider_runtime.shutil.which", return_value="codex"), patch(
            "scripts.ai_provider_runtime.run_with_tree_timeout", side_effect=complete
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
            "scripts.ai_provider_runtime.run_with_tree_timeout", side_effect=complete
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
            ), patch("scripts.ai_provider_runtime.run_with_tree_timeout", side_effect=complete):
                self.assertEqual(provider.generate_json("system", "user", {"type": "object"}), {})

    @unittest.skipUnless(os.name == "nt", "requires Windows taskkill")
    def test_tree_timeout_terminates_the_windows_process_group(self) -> None:
        class TimedProcess:
            pid = 43210
            returncode = 1

            def __init__(self) -> None:
                self.communicate_calls = 0
                self.killed = False

            def communicate(self, **_kwargs: object) -> tuple[str, str]:
                self.communicate_calls += 1
                if self.communicate_calls == 1:
                    raise subprocess.TimeoutExpired(["codex", "exec"], 1)
                return "", ""

            def poll(self) -> int | None:
                return 1 if self.killed else None

            def kill(self) -> None:
                self.killed = True

        process = TimedProcess()
        with patch("scripts.ai_provider_runtime.subprocess.Popen", return_value=process), patch(
            "scripts.ai_provider_runtime.subprocess.run",
            return_value=subprocess.CompletedProcess(["taskkill.exe"], 0),
        ) as taskkill:
            with self.assertRaises(subprocess.TimeoutExpired):
                run_with_tree_timeout(["codex", "exec"], input_text="prompt", timeout=1)

        self.assertTrue(process.killed)
        self.assertEqual(process.communicate_calls, 2)
        self.assertEqual(taskkill.call_args.args[0][:4], ["taskkill.exe", "/PID", "43210", "/T"])

    @unittest.skipIf(os.name == "nt", "POSIX process groups are unavailable on Windows")
    def test_tree_timeout_escalates_the_posix_process_group(self) -> None:
        class TimedProcess:
            pid = 43210
            returncode = 1

            def communicate(self, **_kwargs: object) -> tuple[str, str]:
                raise subprocess.TimeoutExpired(["codex", "exec"], 1)

            def poll(self) -> None:
                return None

            def terminate(self) -> None:
                raise AssertionError("process-group signaling should be used")

            def kill(self) -> None:
                raise AssertionError("process-group signaling should be used")

        process = TimedProcess()
        with patch("scripts.ai_provider_runtime.subprocess.Popen", return_value=process) as popen, patch(
            "scripts.ai_provider_runtime.os.killpg"
        ) as kill_group:
            with self.assertRaises(subprocess.TimeoutExpired):
                run_with_tree_timeout(["codex", "exec"], input_text="prompt", timeout=1)

        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        self.assertEqual(
            kill_group.call_args_list,
            [
                unittest.mock.call(43210, signal.SIGTERM),
                unittest.mock.call(43210, signal.SIGKILL),
                unittest.mock.call(43210, signal.SIGKILL),
            ],
        )

    @unittest.skipIf(os.name == "nt", "POSIX process groups are unavailable on Windows")
    def test_tree_timeout_terminates_a_real_posix_descendant(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            child_script = root / "child.py"
            parent_script = root / "parent.py"
            child_ready = root / "child-ready"
            child_stopped = root / "child-stopped"
            child_pid_path = root / "child-pid"
            parent_stopped = root / "parent-stopped"
            child_script.write_text(
                """
import signal
import sys
import time
from pathlib import Path

ready = Path(sys.argv[1])
stopped = Path(sys.argv[2])

def stop(_signum, _frame):
    stopped.write_text("stopped", encoding="utf-8")
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
ready.write_text("ready", encoding="utf-8")
while True:
    time.sleep(0.05)
""".strip(),
                encoding="utf-8",
            )
            parent_script.write_text(
                """
import signal
import subprocess
import sys
import time
from pathlib import Path

child_script, ready_path, stopped_path, pid_path, parent_stopped_path = sys.argv[1:]
stop_requested = False

def stop(_signum, _frame):
    global stop_requested
    stop_requested = True

signal.signal(signal.SIGTERM, stop)
child = subprocess.Popen([sys.executable, child_script, ready_path, stopped_path])
Path(pid_path).write_text(str(child.pid), encoding="utf-8")
deadline = time.monotonic() + 5
while not Path(ready_path).exists() and time.monotonic() < deadline:
    time.sleep(0.01)
while not stop_requested:
    time.sleep(0.05)
child.wait(timeout=3)
Path(parent_stopped_path).write_text("stopped", encoding="utf-8")
""".strip(),
                encoding="utf-8",
            )

            child_pid = 0
            try:
                with self.assertRaises(subprocess.TimeoutExpired):
                    run_with_tree_timeout(
                        [
                            sys.executable,
                            str(parent_script),
                            str(child_script),
                            str(child_ready),
                            str(child_stopped),
                            str(child_pid_path),
                            str(parent_stopped),
                        ],
                        input_text="",
                        timeout=2,
                    )
                child_pid = int(child_pid_path.read_text(encoding="utf-8"))
                self.assertTrue(child_stopped.is_file())
                self.assertTrue(parent_stopped.is_file())
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
            finally:
                if not child_pid and child_pid_path.is_file():
                    try:
                        child_pid = int(child_pid_path.read_text(encoding="utf-8"))
                    except ValueError:
                        pass
                if child_pid:
                    try:
                        os.kill(child_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass


if __name__ == "__main__":
    unittest.main()
