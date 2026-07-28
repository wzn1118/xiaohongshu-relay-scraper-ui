from __future__ import annotations

import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.ai_provider_runtime import AIProvider, AIProviderError


class AiProviderRuntimeTests(unittest.TestCase):
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
            self.assertEqual(command[command.index("--model") + 1], "portable-model")
            return subprocess.CompletedProcess(command, 0, "", "")

        with patch("scripts.ai_provider_runtime.shutil.which", return_value="codex"), patch(
            "scripts.ai_provider_runtime.subprocess.run", side_effect=complete
        ):
            self.assertEqual(provider.generate_json("system", "user", {"type": "object"}), {})


if __name__ == "__main__":
    unittest.main()
