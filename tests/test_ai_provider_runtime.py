from __future__ import annotations

import os
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.ai_provider_runtime import AIProvider, AIProviderError


class AiProviderRuntimeTests(unittest.TestCase):
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
        self.assertTrue(payload["messages"][-1]["content"].endswith("/no_think"))

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
