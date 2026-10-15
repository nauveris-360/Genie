"""Tests for audit_hermes_profile.py: verdicts per misconfiguration, and that no secret ever reaches output.

Run:  python3 -I -m unittest discover -s infra/hermes/tests -v
Each case runs the script as a subprocess (python -I), exactly as an operator would.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "audit_hermes_profile.py"
MODEL = "nvidia/nemotron-3-super-120b-a12b:free"
# Canary secrets: none of these may ever appear in stdout or stderr.
OR_KEY = "sk-or-v1-CANARYOPENROUTER0123456789abcdef0123456789abcdef"
ADMIN_KEY = "sk-or-v1-CANARYADMINROOTKEY0123456789abcdef0123456789"
API_KEY = "CANARYAPISERVERKEY0123456789abcdef0123456789abcdef"
OTHER_KEY = "sk-ant-CANARYOTHERPROVIDER0123456789"
CANARIES = (OR_KEY, ADMIN_KEY, API_KEY, OTHER_KEY, "CANARYCONFIGSECRET", "CANARYUNITSECRET", "CANARYYAMLLINE")

GOLDEN_CONFIG = f"""
model:
  provider: openrouter
  default: {MODEL}
platform_toolsets:
  api_server: []
  cli: []
agent:
  disabled_toolsets: [terminal, file, code_execution, browser, web, delegation, cronjob, memory, skills, session_search, connections, computer_use]
auxiliary:
  title_generation:
    enabled: false
    model_upgrade_enabled: false
    prefer_fast_model: false
  compression:
    provider: auto
  background_review:
    enabled: false
memory:
  memory_enabled: false
  user_profile_enabled: false
"""

GOLDEN_UNIT = """
[Unit]
Description=Hermes gateway (readyqr profile, API server for genie-core)
[Service]
User=hermes
ExecStart=/home/hermes/.hermes/hermes-agent/venv/bin/hermes -p readyqr gateway
WorkingDirectory=@WORKDIR@
Environment=HOME=/home/hermes PATH=/usr/bin:/bin
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
RestrictSUIDSGID=yes
"""


class AuditCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="hermes-audit-"))
        self.root = self.tmp / ".hermes"
        self.profile = self.root / "profiles" / "readyqr"
        self.profile.mkdir(parents=True)
        self.install = self.root / "hermes-agent"
        self.install.mkdir()
        self.managed = self.tmp / "etc-hermes"  # absent unless a test creates it
        self.write_config(GOLDEN_CONFIG)
        self.write_env({"OPENROUTER_API_KEY": OR_KEY})
        self.workdir = self.tmp / "hermes-cwd"
        self.workdir.mkdir()
        self.unit = self.tmp / "hermes-readyqr.service"
        self.write_unit(GOLDEN_UNIT)

    def write_unit(self, text: str) -> None:
        self.unit.write_text(text.replace("@WORKDIR@", str(self.workdir)))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- fixture helpers
    def write_config(self, text: str) -> None:
        (self.profile / "config.yaml").write_text(textwrap.dedent(text))

    def write_env(self, values: dict, mode: int = 0o600) -> None:
        path = self.profile / ".env"
        path.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
        os.chmod(path, mode)

    def run_audit(self, *extra: str, stage: str = "disabled", unit: bool = False) -> tuple[int, dict, str]:
        args = [sys.executable, "-I", str(SCRIPT), "--profile-dir", str(self.profile), "--expect-model", MODEL,
                "--install-dir", str(self.install), "--managed-dir", str(self.managed), "--stage", stage, *extra]
        if unit:
            args += ["--unit", str(self.unit)]
        text = subprocess.run(args, capture_output=True, text=True, timeout=60)
        js = subprocess.run(args + ["--json"], capture_output=True, text=True, timeout=60)
        combined = text.stdout + text.stderr + js.stdout + js.stderr
        for canary in CANARIES:
            self.assertNotIn(canary, combined, "a secret value reached the audit output")
        self.assertNotIn(MODEL, combined, "config values (even the model id) are never echoed")
        self.assertEqual(text.returncode, js.returncode)
        data = json.loads(js.stdout) if js.stdout.strip() else {}
        return js.returncode, data, text.stdout

    def status(self, data: dict, check_id: str) -> str:
        rows = [r for r in data["checks"] if r["id"] == check_id]
        self.assertEqual(len(rows), 1, check_id)
        return rows[0]["status"]

    def assert_fails(self, check_id: str, **kw) -> dict:
        code, data, _ = self.run_audit(**kw)
        self.assertEqual(code, 1)
        self.assertEqual(self.status(data, check_id), "FAIL")
        return data


class GoldenProfile(AuditCase):
    def test_golden_disabled_stage_passes_with_only_manual_spend_cap(self):
        code, data, text = self.run_audit()
        self.assertEqual(code, 0, text)
        self.assertTrue(data["ok"])
        self.assertEqual(self.status(data, "SPEND-CAP"), "MANUAL")
        self.assertFalse([r for r in data["checks"] if r["status"] in ("FAIL", "WARN")], text)

    def test_golden_enabled_stage_with_private_bind_and_unit_passes(self):
        self.write_env({"OPENROUTER_API_KEY": OR_KEY, "API_SERVER_ENABLED": "true", "API_SERVER_KEY": API_KEY,
                        "API_SERVER_HOST": "172.17.0.1", "API_SERVER_PORT": "8642"})
        code, data, text = self.run_audit(stage="enabled", unit=True)
        self.assertEqual(code, 0, text)


class ToolsAndRouting(AuditCase):
    def test_missing_api_server_toolsets_means_default_tools(self):
        self.write_config(GOLDEN_CONFIG.replace("  api_server: []\n", ""))
        self.assert_fails("TOOLS-API")

    def test_non_empty_or_string_toolsets_fail(self):
        for value in ("[terminal]", "'[]'"):
            self.write_config(GOLDEN_CONFIG.replace("api_server: []", f"api_server: {value}"))
            self.assert_fails("TOOLS-API")

    def test_mcp_servers_fail(self):
        self.write_config(GOLDEN_CONFIG + "mcp_servers:\n  files:\n    command: npx\n")
        self.assert_fails("MCP")

    def test_fallback_providers_and_legacy_fallback_fail(self):
        for extra in ("fallback_providers:\n  - provider: anthropic\n    model: x\n", "fallback_model:\n  provider: openai\n"):
            self.write_config(GOLDEN_CONFIG + extra)
            self.assert_fails("FALLBACK")

    def test_wrong_main_model_or_provider_or_endpoint_fail(self):
        self.write_config(GOLDEN_CONFIG.replace(f"default: {MODEL}", "default: some/paid-model"))
        self.assert_fails("MODEL-DEFAULT")
        self.write_config(GOLDEN_CONFIG.replace("provider: openrouter", "provider: auto", 1))
        self.assert_fails("MODEL-PROVIDER")
        self.write_config(GOLDEN_CONFIG.replace("  provider: openrouter\n", "  provider: openrouter\n  base_url: https://proxy.example.net/v1\n", 1))
        self.assert_fails("MODEL-ENDPOINT")

    def test_auxiliary_escape_routes_fail(self):
        cases = [
            ("  compression:\n    provider: auto\n", "  compression:\n    provider: anthropic\n    model: claude\n"),
            ("  compression:\n    provider: auto\n", "  compression:\n    provider: auto\n    fallback_chain:\n      - provider: openai\n"),
            ("  compression:\n    provider: auto\n", "  compression:\n    provider: auto\n    api_key: CANARYCONFIGSECRET\n"),
            ("    prefer_fast_model: false\n", "    prefer_fast_model: true\n"),
        ]
        for old, new in cases:
            self.write_config(GOLDEN_CONFIG.replace(old, new))
            self.assert_fails("AUX-ROUTING")

    def test_title_generation_must_be_explicitly_off(self):
        self.write_config(GOLDEN_CONFIG.replace("    enabled: false\n    model_upgrade_enabled", "    model_upgrade_enabled", 1))
        self.assert_fails("AUX-TITLE")

    def test_background_review_defaults_on_and_must_be_off(self):
        self.write_config(GOLDEN_CONFIG.replace("  background_review:\n    enabled: false\n", ""))
        self.assert_fails("AUX-BACKGROUND-REVIEW")

    def test_model_routes_and_config_side_api_settings_fail(self):
        self.write_config(GOLDEN_CONFIG + "gateway:\n  api_server:\n    model_routes:\n      fast: {model: x, provider: openai}\n")
        self.assert_fails("MODEL-ROUTES")
        self.write_config(GOLDEN_CONFIG + "gateway:\n  api_server:\n    key: CANARYCONFIGSECRET\n    cors_origins: https://x\n")
        data = self.assert_fails("API-KEY-IN-CONFIG")
        self.assertEqual(self.status(data, "API-CORS-CONFIG"), "FAIL")

    def test_memory_must_be_explicitly_off(self):
        self.write_config(GOLDEN_CONFIG.replace("  memory_enabled: false\n", ""))
        self.assert_fails("MEMORY")
        self.write_config(GOLDEN_CONFIG.replace("  user_profile_enabled: false\n", "  user_profile_enabled: false\n  provider: honcho\n"))
        self.assert_fails("MEMORY")

    def test_external_secret_sources_fail(self):
        self.write_config(GOLDEN_CONFIG + "secrets:\n  bitwarden: {enabled: true}\n")
        self.assert_fails("SECRET-SOURCES")

    def test_malformed_yaml_withholds_the_parser_message(self):
        self.write_config("model:\n  provider: openrouter\n  api_key: CANARYYAMLLINE: [unclosed\n")
        code, data, text = self.run_audit()
        self.assertEqual(code, 1)
        self.assertEqual(self.status(data, "CFG-PARSE"), "FAIL")
        self.assertIn("parser message withheld", text)


class Credentials(AuditCase):
    def test_env_file_permissions(self):
        self.write_env({"OPENROUTER_API_KEY": OR_KEY}, mode=0o644)
        self.assert_fails("ENV-FILE")

    def test_missing_masked_or_placeholder_key(self):
        for value in ("", "__GENIE_NOT_AVAILABLE__", "CHANGE_ME_OPENROUTER_KEY_VALUE", "short"):
            self.write_env({"OPENROUTER_API_KEY": value})
            self.assert_fails("ENV-OPENROUTER-KEY")

    def test_other_credentials_and_endpoint_overrides_in_profile_env(self):
        self.write_env({"OPENROUTER_API_KEY": OR_KEY, "ANTHROPIC_API_KEY": OTHER_KEY})
        self.assert_fails("ENV-OTHER-CREDENTIALS")
        self.write_env({"OPENROUTER_API_KEY": OR_KEY, "OPENROUTER_BASE_URL": "https://proxy.example.net"})
        self.assert_fails("ENV-ENDPOINT-OVERRIDE")

    def test_root_pool_fallback_is_caught(self):
        (self.root / "auth.json").write_text(json.dumps({"credential_pool": {"openrouter": [{"access_token": ADMIN_KEY}]}}))
        self.assert_fails("POOL-ROOT-FALLBACK")

    def test_profile_pool_with_the_dedicated_key_shadows_the_root_pool(self):
        (self.root / "auth.json").write_text(json.dumps({"credential_pool": {"openrouter": [{"access_token": ADMIN_KEY}]}}))
        (self.profile / "auth.json").write_text(json.dumps({"credential_pool": {"openrouter": [{"access_token": OR_KEY}]}}))
        code, data, text = self.run_audit()
        self.assertEqual(code, 0, text)
        self.assertEqual(self.status(data, "POOL-ROOT-FALLBACK"), "PASS")

    def test_profile_pool_with_another_key_fails(self):
        (self.profile / "auth.json").write_text(json.dumps({"credential_pool": {"openrouter": [
            {"access_token": OR_KEY}, {"access_token": ADMIN_KEY}]}}))
        self.assert_fails("POOL-PROFILE")

    def test_install_env_and_managed_scope(self):
        (self.install / ".env").write_text(f"OPENAI_API_KEY={OTHER_KEY}\n")
        self.assert_fails("INSTALL-ENV")
        (self.install / ".env").unlink()
        self.managed.mkdir()
        (self.managed / "config.yaml").write_text("fallback_providers: []\n")
        self.assert_fails("MANAGED-SCOPE")


class EnabledStage(AuditCase):
    def base_env(self, **over):
        env = {"OPENROUTER_API_KEY": OR_KEY, "API_SERVER_ENABLED": "true", "API_SERVER_KEY": API_KEY,
               "API_SERVER_HOST": "127.0.0.1"}
        env.update(over)
        self.write_env({k: v for k, v in env.items() if v is not None})

    def test_disabled_stage_refuses_an_enabled_server(self):
        self.base_env()
        self.assert_fails("STAGE-DISABLED")

    def test_enabled_stage_checks(self):
        cases = [
            ({"API_SERVER_KEY": "short-key-0123456789"}, "API-KEY"),
            ({"API_SERVER_KEY": OR_KEY}, "API-KEY-UNIQUE"),
            ({"API_SERVER_HOST": "0.0.0.0"}, "API-HOST"),
            ({"API_SERVER_HOST": "203.0.113.10"}, "API-HOST"),
            ({"API_SERVER_HOST": "hermes.genie.readyqr.com"}, "API-HOST"),
            ({"API_SERVER_PORT": "80"}, "API-PORT"),
            ({"API_SERVER_CORS_ORIGINS": "https://genie.readyqr.com"}, "API-CORS"),
        ]
        for over, check_id in cases:
            with self.subTest(check=check_id, setting=sorted(over)):
                self.base_env(**over)
                self.assert_fails(check_id, stage="enabled", unit=True)

    def test_enabled_stage_requires_a_unit(self):
        self.base_env()
        self.assert_fails("UNIT", stage="enabled")

    def test_unit_checks(self):
        self.base_env()
        cases = [
            (GOLDEN_UNIT.replace("User=hermes", "User=root"), "UNIT-USER"),
            (GOLDEN_UNIT.replace("-p readyqr gateway", "-p default gateway"), "UNIT-EXEC"),
            (GOLDEN_UNIT.replace("PATH=/usr/bin:/bin", "PATH=/usr/bin:/bin OPENAI_API_KEY=CANARYUNITSECRET"), "UNIT-ENV"),
            (GOLDEN_UNIT.replace("PATH=/usr/bin:/bin", "PATH=/usr/bin:/bin HERMES_KANBAN_TASK=1"), "UNIT-ENV"),
            (GOLDEN_UNIT + "EnvironmentFile=/home/hermes/.hermes/.env\n", "UNIT-ENVFILE"),
        ]
        for unit_text, check_id in cases:
            with self.subTest(check=check_id):
                self.write_unit(unit_text)
                self.assert_fails(check_id, stage="enabled", unit=True)
        self.write_unit(GOLDEN_UNIT)
        (self.workdir / "AGENTS.md").write_text("private notes")
        self.assert_fails("UNIT-WORKDIR", stage="enabled", unit=True)


class Robustness(AuditCase):
    def test_missing_profile_is_a_usage_error(self):
        proc = subprocess.run([sys.executable, "-I", str(SCRIPT), "--profile-dir", str(self.tmp / "nope"),
                               "--expect-model", MODEL], capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 2)

    def test_unparseable_auth_store_withholds_contents(self):
        (self.root / "auth.json").write_text('{"credential_pool": {"openrouter": [' + json.dumps(ADMIN_KEY))
        self.assert_fails("AUTH-PARSE")


if __name__ == "__main__":
    unittest.main()


class ShippedUnitTemplate(AuditCase):
    def test_example_unit_passes_every_unit_check_except_the_server_only_workdir(self):
        example = (SCRIPT.parent / "hermes-readyqr.service.example").read_text()
        self.unit.write_text(example)
        self.write_env({"OPENROUTER_API_KEY": OR_KEY, "API_SERVER_ENABLED": "true", "API_SERVER_KEY": API_KEY,
                        "API_SERVER_HOST": "10.88.88.1", "API_SERVER_PORT": "8642"})
        _, data, text = self.run_audit(stage="enabled", unit=True)
        unit_rows = {r["id"]: r["status"] for r in data["checks"] if r["id"].startswith("UNIT")}
        self.assertEqual(unit_rows.pop("UNIT-WORKDIR"), "FAIL", "the empty working directory exists only on the server")
        self.assertEqual(set(unit_rows.values()), {"PASS"}, text)
        self.assertEqual(self.status(data, "API-HOST"), "PASS")
