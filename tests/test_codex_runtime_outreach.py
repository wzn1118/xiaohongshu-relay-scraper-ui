from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.codex_runtime_outreach import current_codex_runtime_args


class CodexRuntimeOutreachTests(unittest.TestCase):
    def test_forwards_provider_and_runtime_settings_from_codex_config(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config_path = Path(temporary) / "config.toml"
            config_path.write_text(
                """
model_provider = "OpenAI"
model = "gpt-5.5"
review_model = "gpt-5.5"
model_reasoning_effort = "xhigh"
disable_response_storage = true
network_access = "enabled"
windows_wsl_setup_acknowledged = true

[features]
goals = true

[model_providers.OpenAI]
name = "OpenAI"
base_url = "https://relay.example.invalid"
wire_api = "responses"
requires_openai_auth = true
""".strip(),
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"CODEX_HOME": temporary}, clear=False):
                arguments = current_codex_runtime_args()

        config_arguments = {
            arguments[index + 1]
            for index, value in enumerate(arguments[:-1])
            if value == "--config"
        }
        self.assertIn("model_provider=\"OpenAI\"", config_arguments)
        self.assertIn("model_providers.OpenAI.base_url=\"https://relay.example.invalid\"", config_arguments)
        self.assertIn("model_providers.OpenAI.wire_api=\"responses\"", config_arguments)
        self.assertIn("model_providers.OpenAI.requires_openai_auth=true", config_arguments)
        self.assertIn("review_model=\"gpt-5.5\"", config_arguments)
        self.assertIn("model_reasoning_effort=\"xhigh\"", config_arguments)
        self.assertIn("disable_response_storage=true", config_arguments)
        self.assertIn("network_access=\"enabled\"", config_arguments)
        self.assertIn("windows_wsl_setup_acknowledged=true", config_arguments)
        self.assertIn("features.goals=true", config_arguments)
        self.assertIn("gpt-5.5", arguments)
        self.assertNotIn('model_reasoning_effort="low"', config_arguments)


if __name__ == "__main__":
    unittest.main()
