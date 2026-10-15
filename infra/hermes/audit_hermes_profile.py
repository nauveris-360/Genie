#!/usr/bin/env python3
"""Offline, secret-safe audit of the Hermes profile Genie would call.

Reads a Hermes profile directory (config.yaml, .env, auth.json, context and
plugin folders), the Hermes root auth store, an optional install directory, the
managed scope (/etc/hermes) and an optional systemd unit, and reports whether
each Genie precondition holds (docs/HERMES.md, docs/HERMES-SERVICE-PLAN.md).

Secret safety, by construction:
  * Output is check ids, PASS/FAIL/WARN/MANUAL, and fixed sentences that name
    settings, keys and files. No value read from any file is ever printed: not
    credentials, not config values, not even the model id it compares.
  * Secret values are only held in memory to compute booleans (present, long
    enough, a placeholder, equal to another key).
  * Parse errors are reported without the parser's message (YAML errors quote
    the offending line, which may contain a secret).
  * It never connects to anything, starts Hermes or calls a model.

Run it as the Hermes account with the Hermes venv's Python (it needs PyYAML or
ruamel.yaml, whichever that venv has):

  ~/.hermes/hermes-agent/venv/bin/python -I audit_hermes_profile.py \\
      --profile-dir ~/.hermes/profiles/readyqr \\
      --expect-model 'nvidia/nemotron-3-super-120b-a12b:free' \\
      --install-dir ~/.hermes/hermes-agent \\
      --stage disabled            # or: --stage enabled --unit /etc/systemd/system/hermes-readyqr.service

Exit status: 0 = every required check passed, 1 = a required check failed,
2 = usage error or the profile could not be read.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import stat
import sys
from pathlib import Path
from typing import Any, Callable, Optional

MASK = "__GENIE_NOT_AVAILABLE__"
EXPECTED_PROVIDER = "openrouter"
OPENROUTER_HOST = "openrouter.ai"
ALLOWED_ENV_CREDENTIALS = {"OPENROUTER_API_KEY", "API_SERVER_KEY"}
CREDENTIAL_NAME = re.compile(r"(_API_KEY|_TOKEN|_SECRET|_KEY|_PASSWORD|_PASS)$")
ENDPOINT_OVERRIDES = ("OPENROUTER_BASE_URL", "OPENAI_BASE_URL")
CONTEXT_FILES = ("SOUL.md", "AGENTS.md", ".hermes.md", "CLAUDE.md", ".cursorrules")
# Toolsets a future edit must not silently re-enable for API runs (defence in depth via agent.disabled_toolsets).
DANGEROUS_TOOLSETS = ("terminal", "file", "code_execution", "browser", "web", "delegation", "cronjob",
                      "memory", "skills", "session_search", "connections", "computer_use")
PLACEHOLDER = re.compile(r"change[-_ ]?me|placeholder|replace[-_ ]?me|your[-_ ]|example|xxxx|<.*>", re.I)
API_SERVER_SECTIONS = (("gateway", "api_server"), ("gateway", "platforms", "api_server"), ("platforms", "api_server"))
UNIT_FORBIDDEN_ENV = {"HERMES_KANBAN_TASK", "HERMES_MANAGED_DIR", "HERMES_HOME"}


# ---------------------------------------------------------------- reporting

class Report:
    def __init__(self) -> None:
        self.rows: list[dict[str, str]] = []

    def add(self, check_id: str, status: str, summary: str) -> None:
        assert status in ("PASS", "FAIL", "WARN", "MANUAL")
        self.rows.append({"id": check_id, "status": status, "summary": summary})

    def check(self, check_id: str, ok: bool, passed: str, failed: str, *, required: bool = True) -> None:
        self.add(check_id, "PASS" if ok else ("FAIL" if required else "WARN"), passed if ok else failed)

    @property
    def failed(self) -> bool:
        return any(r["status"] == "FAIL" for r in self.rows)


def names(items) -> str:
    """Comma-separated, sorted, length-capped list of NAMES (keys, files) — never values."""
    shown = sorted({str(i) for i in items})
    text = ", ".join(shown[:12]) + (", ..." if len(shown) > 12 else "")
    return text or "none"


# ---------------------------------------------------------------- readers

def load_yaml_loader() -> Optional[Callable[[str], Any]]:
    try:
        import yaml  # type: ignore
        return yaml.safe_load
    except Exception:
        pass
    try:
        from ruamel.yaml import YAML  # type: ignore
        parser = YAML(typ="safe", pure=True)
        return parser.load
    except Exception:
        return None


def read_yaml(path: Path, loader) -> tuple[str, Any]:
    """('missing'|'unreadable'|'invalid'|'ok', data). Never surfaces the parser's message."""
    if not path.is_file():
        return "missing", None
    try:
        text = path.read_text(encoding="utf-8-sig")
    except Exception:
        return "unreadable", None
    try:
        data = loader(text)
    except Exception:
        return "invalid", None
    return "ok", data


def read_json(path: Path) -> tuple[str, Any]:
    if not path.is_file():
        return "missing", None
    try:
        return "ok", json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return "invalid", None


def read_dotenv(path: Path) -> tuple[str, dict[str, str]]:
    """Minimal dotenv reader (KEY=VALUE, optional `export`, quotes, comments). Values stay in memory."""
    if not path.is_file():
        return "missing", {}
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except Exception:
        return "unreadable", {}
    out: dict[str, str] = {}
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        out[key] = value
    return "ok", out


def dig(data: Any, *keys: str) -> Any:
    for key in keys:
        if not isinstance(data, dict):
            return None
        data = data.get(key)
    return data


def truthy(value: Any) -> bool:
    return value is True or (isinstance(value, str) and value.strip().lower() in ("1", "true", "yes", "on"))


def explicitly_false(value: Any) -> bool:
    return value is False or (isinstance(value, str) and value.strip().lower() in ("0", "false", "no", "off"))


def usable_secret(value: Optional[str], min_length: int) -> bool:
    return bool(value) and MASK not in value and not PLACEHOLDER.search(value) and len(value) >= min_length


def host_of(url: Any) -> str:
    if not isinstance(url, str):
        return ""
    m = re.match(r"^[a-z]+://([^/:?#]+)", url.strip(), re.I)
    return (m.group(1) if m else "").lower()


PRIVATE_NETS = tuple(ipaddress.ip_network(n) for n in (
    "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "::1/128", "fc00::/7"))


def private_bind(host: str) -> bool:
    """Loopback or RFC 1918 / ULA address only; never a wildcard, a public address or a name.
    (ipaddress' is_private also covers documentation and other reserved ranges, so it is not used.)"""
    if host == "localhost":
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(ip in net for net in PRIVATE_NETS if net.version == ip.version)


def pool_entries(store: Any, provider: str) -> list:
    entries = dig(store, "credential_pool", provider)
    return [e for e in entries if isinstance(e, dict)] if isinstance(entries, list) else []


def entry_secret(entry: dict) -> Optional[str]:
    for field in ("access_token", "api_key", "runtime_api_key"):
        value = entry.get(field)
        if isinstance(value, str) and value:
            return value
    return None


# ---------------------------------------------------------------- checks

def audit(args, loader) -> Report:
    r = Report()
    profile = Path(args.profile_dir).expanduser()
    root = Path(args.hermes_root).expanduser() if args.hermes_root else (
        profile.parent.parent if profile.parent.name == "profiles" else Path("~/.hermes").expanduser())
    expected_model = args.expect_model

    # --- config.yaml
    state, cfg = read_yaml(profile / "config.yaml", loader)
    r.check("CFG-PARSE", state == "ok" and isinstance(cfg, dict),
            "config.yaml present and parsed",
            {"missing": "config.yaml is missing", "unreadable": "config.yaml is not readable",
             "invalid": "config.yaml could not be parsed (parser message withheld)"}.get(state, "config.yaml is not a mapping"))
    cfg = cfg if isinstance(cfg, dict) else {}

    api_tools = dig(cfg, "platform_toolsets", "api_server")
    r.check("TOOLS-API", isinstance(api_tools, list) and len(api_tools) == 0,
            "platform_toolsets.api_server is an explicit empty list (API runs get no tools)",
            "platform_toolsets.api_server is missing, not a YAML list, or not empty (missing = Hermes' full default toolset)")
    cli_tools = dig(cfg, "platform_toolsets", "cli")
    r.check("TOOLS-CLI", isinstance(cli_tools, list) and len(cli_tools) == 0,
            "platform_toolsets.cli is an explicit empty list",
            "platform_toolsets.cli is not an explicit empty list (not used by API runs)", required=False)
    disabled = dig(cfg, "agent", "disabled_toolsets")
    disabled_set = {str(x) for x in disabled} if isinstance(disabled, list) else set()
    missing_disabled = [t for t in DANGEROUS_TOOLSETS if t not in disabled_set]
    r.check("TOOLS-DENYLIST", not missing_disabled,
            "agent.disabled_toolsets also strips every high-risk toolset (defence in depth)",
            f"agent.disabled_toolsets does not list: {names(missing_disabled)} (defence in depth only)", required=False)

    mcp = cfg.get("mcp_servers")
    mcp_names = list(mcp.keys()) if isinstance(mcp, dict) else []
    r.check("MCP", not mcp_names, "no mcp_servers configured",
            f"mcp_servers configured: {names(mcp_names)} (MCP tools are not listed by /v1/toolsets)")
    engine = dig(cfg, "context", "engine")
    r.check("CONTEXT-ENGINE", engine in (None, "", "compressor"), "context.engine is the default compressor",
            "context.engine is a non-default engine (its tools are gated by the empty api_server list)", required=False)

    fb = cfg.get("fallback_providers")
    fb_legacy = cfg.get("fallback_model")
    r.check("FALLBACK", not fb and not fb_legacy, "no fallback_providers and no legacy fallback_model",
            "fallback_providers or fallback_model is set (Hermes would switch provider/model before Genie sees anything)")

    model = cfg.get("model")
    provider = dig(model, "provider") if isinstance(model, dict) else None
    default_model = dig(model, "default") if isinstance(model, dict) else None
    r.check("MODEL-PROVIDER", provider == EXPECTED_PROVIDER, "model.provider is openrouter",
            "model.provider is not openrouter (or model is not a mapping)")
    r.check("MODEL-DEFAULT", isinstance(default_model, str) and default_model == expected_model,
            "model.default equals the expected verified-free model (auxiliary 'auto' tasks use it)",
            "model.default does not equal the expected model")
    base_url = dig(model, "base_url") if isinstance(model, dict) else None
    r.check("MODEL-ENDPOINT", base_url in (None, "") or host_of(base_url) == OPENROUTER_HOST,
            "model.base_url is unset or the canonical OpenRouter host",
            "model.base_url points somewhere other than openrouter.ai")
    r.check("MODEL-KEY-IN-CONFIG", not (isinstance(model, dict) and model.get("api_key")),
            "no API key in config.yaml model section",
            "model.api_key is set in config.yaml (keep the key only in the 0600 profile .env)", required=False)
    custom_providers = cfg.get("providers")
    r.check("CUSTOM-PROVIDERS", not custom_providers, "no custom providers section",
            f"providers section defines: {names(custom_providers.keys() if isinstance(custom_providers, dict) else ['(non-mapping)'])}",
            required=False)

    aux = cfg.get("auxiliary") if isinstance(cfg.get("auxiliary"), dict) else {}
    bad_aux: list[str] = []
    for task, block in aux.items():
        if not isinstance(block, dict):
            continue
        prov = block.get("provider")
        pinned_ok = prov in (None, "", "auto", "main") or (prov == EXPECTED_PROVIDER and block.get("model") in (None, "", expected_model))
        if not pinned_ok:
            bad_aux.append(f"{task}.provider/model")
        if block.get("base_url"):
            bad_aux.append(f"{task}.base_url")
        if block.get("api_key"):
            bad_aux.append(f"{task}.api_key")
        if block.get("fallback_chain"):
            bad_aux.append(f"{task}.fallback_chain")
        if truthy(block.get("prefer_fast_model")):
            bad_aux.append(f"{task}.prefer_fast_model")
    r.check("AUX-ROUTING", not bad_aux,
            "every auxiliary task is on auto/main or pinned to the expected model, with no fallback_chain, base_url, api_key or prefer_fast_model",
            f"auxiliary settings that can reach another model or key: {names(bad_aux)}")
    title = aux.get("title_generation") if isinstance(aux.get("title_generation"), dict) else {}
    r.check("AUX-TITLE", explicitly_false(title.get("enabled")) and not truthy(title.get("model_upgrade_enabled")),
            "auxiliary.title_generation.enabled is false and model_upgrade_enabled is not true",
            "auxiliary.title_generation.enabled is not explicitly false, or model_upgrade_enabled is true")
    review = aux.get("background_review") if isinstance(aux.get("background_review"), dict) else {}
    r.check("AUX-BACKGROUND-REVIEW", explicitly_false(review.get("enabled")),
            "auxiliary.background_review.enabled is false",
            "auxiliary.background_review.enabled is not explicitly false (Hermes defaults it ON: a post-turn review fork on the same key)")
    comp = cfg.get("compression") if isinstance(cfg.get("compression"), dict) else {}
    legacy_comp = [k for k in ("summary_model", "summary_provider", "summary_base_url") if comp.get(k)]
    r.check("COMPRESSION-LEGACY", not legacy_comp, "no legacy compression summary_* routing",
            f"legacy compression routing set: {names(legacy_comp)}")
    deleg = cfg.get("delegation") if isinstance(cfg.get("delegation"), dict) else {}
    r.check("DELEGATION", deleg.get("provider") in (None, "", "auto") and not deleg.get("model") and not deleg.get("fallback_providers"),
            "delegation inherits the main model (and delegation has no tool to run anyway)",
            "delegation pins its own provider, model or fallback_providers", required=False)

    route_sections = [".".join(path) for path in API_SERVER_SECTIONS if dig(cfg, *path, "model_routes")]
    r.check("MODEL-ROUTES", not route_sections, "no api_server model_routes",
            f"model_routes defined under: {names(route_sections)}")
    cfg_api_key = [".".join(path) for path in API_SERVER_SECTIONS if dig(cfg, *path, "key")]
    r.check("API-KEY-IN-CONFIG", not cfg_api_key, "API server key is not stored in config.yaml",
            f"an API server key is set in config.yaml under: {names(cfg_api_key)} (keep it only in the 0600 .env)")
    cfg_cors = [".".join(path) for path in API_SERVER_SECTIONS if dig(cfg, *path, "cors_origins")]
    r.check("API-CORS-CONFIG", not cfg_cors, "no browser CORS origins in config.yaml",
            f"cors_origins set under: {names(cfg_cors)}")

    mem = cfg.get("memory") if isinstance(cfg.get("memory"), dict) else {}
    r.check("MEMORY", explicitly_false(mem.get("memory_enabled")) and explicitly_false(mem.get("user_profile_enabled")) and not mem.get("provider"),
            "memory.memory_enabled and memory.user_profile_enabled are false; no external memory provider",
            "memory is not fully off (memory_enabled / user_profile_enabled not explicitly false, or memory.provider set)")
    secrets_block = cfg.get("secrets")
    r.check("SECRET-SOURCES", not secrets_block and not (profile / ".op.env").exists(),
            "no external secret sources (secrets: block, .op.env)",
            "external secret sources configured (secrets: block or .op.env) can inject other credentials")
    r.check("POOL-STRATEGY", not cfg.get("credential_pool_strategies"), "no credential_pool_strategies overrides",
            "credential_pool_strategies is set", required=False)

    # --- profile .env
    env_path = profile / ".env"
    env_state, env = read_dotenv(env_path)
    mode_ok = False
    if env_state == "ok":
        try:
            mode_ok = stat.S_IMODE(env_path.stat().st_mode) & 0o077 == 0
        except Exception:
            mode_ok = False
    r.check("ENV-FILE", env_state == "ok" and mode_ok, "profile .env present and not readable by group/others",
            "profile .env missing, unreadable, or readable by group/others (chmod 600)")
    or_key = env.get("OPENROUTER_API_KEY")
    r.check("ENV-OPENROUTER-KEY", usable_secret(or_key, 20), "OPENROUTER_API_KEY present in the profile .env",
            "OPENROUTER_API_KEY missing, too short, masked or a placeholder in the profile .env")
    other_creds = [k for k in env if CREDENTIAL_NAME.search(k) and k not in ALLOWED_ENV_CREDENTIALS and env[k]]
    r.check("ENV-OTHER-CREDENTIALS", not other_creds, "no other credentials in the profile .env",
            f"other credential names in the profile .env: {names(other_creds)}")
    endpoint_env = [k for k in ENDPOINT_OVERRIDES if env.get(k)]
    r.check("ENV-ENDPOINT-OVERRIDE", not endpoint_env, "no provider base-URL override in the profile .env",
            f"base-URL overrides set: {names(endpoint_env)}")

    api_enabled = truthy(env.get("API_SERVER_ENABLED")) or any(truthy(dig(cfg, *p, "enabled")) for p in API_SERVER_SECTIONS)
    if args.stage == "disabled":
        r.check("STAGE-DISABLED", not api_enabled, "API server is disabled (stage: disabled)",
                "API server is enabled but the audit stage is 'disabled'")
    else:
        api_key = env.get("API_SERVER_KEY")
        r.check("API-ENABLED", api_enabled, "API server enabled", "API server is not enabled")
        r.check("API-KEY", usable_secret(api_key, 32), "API_SERVER_KEY present, 32+ characters, not a placeholder",
                "API_SERVER_KEY missing, shorter than 32 characters, masked or a placeholder")
        reused = bool(api_key) and any(v == api_key for k, v in env.items() if k != "API_SERVER_KEY")
        r.check("API-KEY-UNIQUE", bool(api_key) and not reused, "API_SERVER_KEY is not reused by any other .env entry",
                "API_SERVER_KEY is missing or equals another .env value")
        host = (env.get("API_SERVER_HOST") or str(dig(cfg, "gateway", "api_server", "host") or "127.0.0.1")).strip()
        r.check("API-HOST", private_bind(host), "API server binds a loopback or private address",
                "API server bind address is a wildcard, public or non-IP name")
        port = env.get("API_SERVER_PORT") or str(dig(cfg, "gateway", "api_server", "port") or "8642")
        r.check("API-PORT", port.isdigit() and 1024 <= int(port) <= 65535, "API server port is an unprivileged number",
                "API server port is not a number in 1024-65535")
        r.check("API-CORS", not env.get("API_SERVER_CORS_ORIGINS"), "API_SERVER_CORS_ORIGINS unset",
                "API_SERVER_CORS_ORIGINS is set (Genie calls server-to-server; no browser should reach Hermes)")

    # --- credential pools: profile first, root auth.json is the per-provider fallback
    p_state, p_auth = read_json(profile / "auth.json")
    g_state, g_auth = read_json(root / "auth.json")
    r.check("AUTH-PARSE", p_state != "invalid" and g_state != "invalid", "auth stores readable (or absent)",
            "a Hermes auth.json could not be parsed (contents withheld)")
    p_or = pool_entries(p_auth, EXPECTED_PROVIDER)
    g_or = pool_entries(g_auth, EXPECTED_PROVIDER) if root.resolve() != profile.resolve() else []
    p_match = bool(p_or) and bool(or_key) and all(entry_secret(e) == or_key for e in p_or)
    r.check("POOL-PROFILE", not p_or or p_match,
            "profile OpenRouter pool is empty or holds only the dedicated key",
            "the profile auth.json OpenRouter pool holds a key other than the profile .env key")
    r.check("POOL-ROOT-FALLBACK", not g_or or p_match,
            "no root OpenRouter pool can stand in for the profile key",
            f"root auth.json holds {len(g_or)} OpenRouter pool entr{'y' if len(g_or) == 1 else 'ies'} and the profile has no "
            "pool of its own: Hermes uses the root pool as a fallback and resolves the pool before .env, so runs could "
            "bill that key instead of the capped one")
    other_pool = sorted(k for k in (dig(p_auth, "credential_pool") or {}) if k != EXPECTED_PROVIDER and pool_entries(p_auth, k))
    r.check("POOL-OTHER-PROVIDERS", not other_pool, "profile pool holds no other providers",
            f"profile pool also holds: {names(other_pool)}", required=False)

    # --- other env sources Hermes reads in profile mode
    if args.install_dir:
        i_state, i_env = read_dotenv(Path(args.install_dir).expanduser() / ".env")
        i_creds = [k for k in i_env if (CREDENTIAL_NAME.search(k) or k in ENDPOINT_OVERRIDES) and i_env[k]]
        r.check("INSTALL-ENV", not i_creds, "install-directory .env adds no credentials or endpoints",
                f"install-directory .env defines {names(i_creds)} (it fills gaps the profile .env leaves)")
    else:
        r.add("INSTALL-ENV", "MANUAL", "pass --install-dir to check the Hermes checkout's .env (it fills gaps the profile .env leaves)")
    managed = Path(args.managed_dir)
    managed_files = [n for n in ("config.yaml", ".env") if (managed / n).exists()] if managed.is_dir() else []
    r.check("MANAGED-SCOPE", not managed_files, "no managed scope overlay (config.yaml/.env) at the managed directory",
            f"managed scope present ({names(managed_files)}): it overrides the profile for every Hermes process; inspect it")

    present_context = [n for n in CONTEXT_FILES if (profile / n).is_file() and (profile / n).stat().st_size > 0]
    r.check("CONTEXT-FILES", not present_context, "no context files in the profile",
            f"context files injected into every system prompt: {names(present_context)} (must hold nothing private)",
            required=False)
    mem_dir = profile / "memories"
    mem_files = [p.name for p in mem_dir.glob("*.md") if p.is_file() and p.stat().st_size > 0] if mem_dir.is_dir() else []
    r.check("MEMORY-FILES", not mem_files, "no stored memory files", f"non-empty memory files: {names(mem_files)}", required=False)
    plugins_dir = profile / "plugins"
    plugins = [p.name for p in plugins_dir.iterdir() if not p.name.startswith(".")] if plugins_dir.is_dir() else []
    r.check("PLUGINS", not plugins, "no profile plugins",
            f"profile plugins: {names(plugins)} (plugin toolsets default ON; Genie's preflight refuses them)", required=False)
    skills_dir = profile / "skills"
    skills = [p.name for p in skills_dir.iterdir() if not p.name.startswith(".")] if skills_dir.is_dir() else []
    r.check("SKILLS", not skills, "no installed skills", f"installed skills: {names(skills)}", required=False)

    # --- service unit
    if args.unit:
        audit_unit(r, Path(args.unit).expanduser(), profile.name)
    elif args.stage == "enabled":
        r.add("UNIT", "FAIL", "stage 'enabled' requires --unit (the service definition must be audited too)")

    r.add("SPEND-CAP", "MANUAL", "the provider-side $0 cap on the dedicated OpenRouter key cannot be verified offline")
    return r


def audit_unit(r: Report, path: Path, profile_name: str) -> None:
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        r.add("UNIT-READ", "FAIL", "systemd unit could not be read")
        return
    directives: list[tuple[str, str]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", ";", "[")) or "=" not in line:
            continue
        key, _, value = line.partition("=")
        directives.append((key.strip(), value.strip()))
    get = lambda k: [v for kk, v in directives if kk == k]
    users = get("User")
    r.check("UNIT-USER", bool(users) and users[-1] not in ("root", "0"), "service runs as a non-root User",
            "service has no User= or runs as root")
    execs = " ".join(get("ExecStart"))
    profile_flag = re.search(rf"(?:^|\s)(?:-p|--profile)(?:=|\s+){re.escape(profile_name)}(?:\s|$)", execs) is not None
    r.check("UNIT-EXEC", profile_flag and re.search(r"(?:^|\s)gateway(?:\s|$)", execs) is not None,
            "ExecStart runs `hermes -p <profile> gateway`", "ExecStart does not run the gateway for this profile")
    env_names: list[str] = []
    for value in get("Environment"):
        for token in re.findall(r'"[^"]*"|\S+', value):
            name = token.strip('"').split("=", 1)[0]
            if name:
                env_names.append(name)
    risky = [n for n in env_names if CREDENTIAL_NAME.search(n) or n in ENDPOINT_OVERRIDES or n in UNIT_FORBIDDEN_ENV]
    r.check("UNIT-ENV", not risky, "unit Environment= sets no credentials, endpoints or Hermes routing variables",
            f"unit Environment= sets: {names(risky)}")
    env_files = get("EnvironmentFile")
    r.check("UNIT-ENVFILE", not env_files, "unit loads no EnvironmentFile",
            f"unit loads {len(env_files)} EnvironmentFile entr{'y' if len(env_files) == 1 else 'ies'} (they can inject credentials)")
    workdirs = get("WorkingDirectory")
    workdir = Path(workdirs[-1]).expanduser() if workdirs else None
    stray = [n for n in CONTEXT_FILES if workdir and (workdir / n).is_file()] if workdir and workdir.is_dir() else []
    r.check("UNIT-WORKDIR", bool(workdir) and workdir.is_dir() and not stray,
            "WorkingDirectory is set to an existing directory with no context files",
            "WorkingDirectory is unset or missing, or holds context files"
            + (f": {names(stray)}" if stray else "") + " (Hermes injects them into every system prompt)")
    hardening = {"NoNewPrivileges": "yes", "PrivateTmp": "yes", "ProtectSystem": "strict|full", "RestrictSUIDSGID": "yes"}
    missing = [k for k, v in hardening.items() if not any(re.fullmatch(v, x, re.I) for x in get(k))]
    r.check("UNIT-HARDENING", not missing, "unit sets the baseline hardening directives",
            f"unit lacks: {names(missing)}", required=False)


# ---------------------------------------------------------------- main

def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Offline, secret-safe audit of a Hermes profile for Genie.")
    ap.add_argument("--profile-dir", required=True)
    ap.add_argument("--expect-model", required=True, help="the verified-free OpenRouter model id Genie will request")
    ap.add_argument("--hermes-root", help="Hermes root (default: <profile>/../.. for profiles/<name>, else ~/.hermes)")
    ap.add_argument("--install-dir", help="Hermes checkout whose .env Hermes loads as a gap-filler")
    ap.add_argument("--managed-dir", default=os.environ.get("HERMES_MANAGED_DIR") or "/etc/hermes")
    ap.add_argument("--unit", help="systemd unit file of the Hermes service")
    ap.add_argument("--stage", choices=("disabled", "enabled"), default="disabled")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if not Path(args.profile_dir).expanduser().is_dir():
        print("profile directory not found", file=sys.stderr)
        return 2
    loader = load_yaml_loader()
    if loader is None:
        print("no YAML parser available; run with the Hermes venv's Python (PyYAML or ruamel.yaml)", file=sys.stderr)
        return 2
    try:
        report = audit(args, loader)
    except Exception as exc:  # never let a traceback or exception message echo file contents
        print(f"audit failed ({type(exc).__name__}); no details are printed to avoid echoing file contents", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps({"ok": not report.failed, "stage": args.stage, "checks": report.rows}, indent=2))
    else:
        for row in report.rows:
            print(f"{row['status']:<6} {row['id']:<24} {row['summary']}")
        counts = {s: sum(1 for x in report.rows if x["status"] == s) for s in ("PASS", "FAIL", "WARN", "MANUAL")}
        print(f"\n{counts['PASS']} pass, {counts['FAIL']} fail, {counts['WARN']} warn, {counts['MANUAL']} manual "
              f"(stage: {args.stage}) -> {'OK' if not report.failed else 'NOT READY'}")
    return 1 if report.failed else 0


if __name__ == "__main__":
    sys.exit(main())
