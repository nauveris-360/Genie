# Hermes integration: verification and constrained adapter

Status (15 October 2026): **Hermes has an official programmatic interface.**
A constrained Genie client for it is implemented and tested locally against a
stand-in server. It has now been reviewed against the exact Hermes commit
installed on VPS 2 (`v0.21.6+774.g835c3dd`, commit `835c3dd038d9`); see
"Compatibility review at 835c3dd" below. That review found and fixed one
adapter incompatibility, and added three new required Hermes settings. It is
**not enabled anywhere**. Turning it on requires the checks and owner approvals
listed under "Blockers" below. Codex owns the adapter contract and reviews this
before anything is enabled.

Offline audit: `infra/hermes/audit_hermes_profile.py` checks a profile against
everything below that can be checked from files. It prints only check ids,
PASS/FAIL/WARN/MANUAL and names, never a value. The private networking and
service plan is in `docs/HERMES-SERVICE-PLAN.md`.

## What was verified, and from where

Read from the official repository `NousResearch/hermes-agent` (main branch,
fetched 14 October 2026 via raw.githubusercontent.com; the GitHub web UI and the
docs site were not reachable from this environment):

* `website/docs/user-guide/features/api-server.md`: the documented API server.
* `gateway/platforms/api_server.py` and `gateway/platforms/api_server_runs.py`:
  the implementation, read to confirm the documented behaviour.

**Not verified:** the Hermes version and configuration actually installed on
VPS 2. Nothing here contacted VPS 2. The repository's `pyproject.toml` on main
says `0.0.0`. PyPI lists `hermes-agent` 0.19.0, but nothing here ties that
release to the main branch or to the VPS 2 install. Older installs may lack
parts of this API.

### The interface

`hermes gateway` with `API_SERVER_ENABLED=true` and `API_SERVER_KEY=<16+ chars>`
in the Hermes account's `~/.hermes/.env` starts an HTTP server. It listens on
`127.0.0.1:8642` by default. Every route except `/health` requires
`Authorization: Bearer <API_SERVER_KEY>`. CORS is off unless
`API_SERVER_CORS_ORIGINS` is set. Genie uses only:

| Route | Use |
| --- | --- |
| `GET /v1/capabilities` | Preflight: `auth.required` must be `true`; `features.run_submission`, `run_status`, `run_stop` must be `true` |
| `GET /v1/toolsets` | Preflight: every toolset must report `enabled: false` (tool-free) |
| `POST /v1/runs` | Start one run: `{input, model, provider}` + `Idempotency-Key` |
| `GET /v1/runs/{run_id}` | Poll: `status`, `output`, `error`, `usage`, `runtime {provider, model}` |
| `POST /v1/runs/{run_id}/stop` | Cancel |

Genie never calls the chat-completions, responses, sessions, jobs, skills,
memory, model-route, browser-control or run-approval endpoints.

### Why "constrained" needs Genie-side rules

The documentation states that the API server "gives full access to
hermes-agent's toolset, **including terminal commands**". The interface has
these properties:

1. **Tools come from Hermes configuration, not from the request.** The tools a
   run gets are Hermes' `api_server` platform toolsets. A caller cannot turn
   them off per request. `GET /v1/toolsets` reports them, but it omits default
   MCP servers.
2. **Credentials come from Hermes, not from the request.** `provider` selects a
   provider slug whose credentials Hermes resolves from its own configuration.
   There is no per-request API key, so a tenant's own OpenRouter key cannot be
   used. Per-user isolation in Hermes means **one Hermes profile per user**,
   each with its own `.env`, provider key and `API_SERVER_KEY`, served under
   `/p/<profile>/`.
3. **Hermes may serve a different model than requested.** Runs use Hermes'
   configured fallback-provider chain. The run status reports the pair that
   actually served it in `runtime`.
4. **Hermes makes its own side calls.** These include title generation,
   context compression and vision. By default (`auxiliary.*.provider: auto`)
   they use Hermes' configured main model, not the per-request model.
5. **Memory and skills are per Hermes profile.** They are shared by every run
   on that profile unless disabled.

## Compatibility review at 835c3dd (installed on VPS 2)

The source was read at commit `835c3dd038d9` through raw.githubusercontent.com,
file by file; the full tarball was not reachable from here. `api_server.py` and
`api_server_runs.py` at that commit are byte-identical to the main-branch
copies reviewed on 14 October. Nothing was executed and nothing contacted
VPS 2.

| Area | Finding at 835c3dd (source) | Consequence for Genie |
| --- | --- | --- |
| `GET /v1/toolsets` shape | Returns `{object: "list", platform: "api_server", data: [...]}`, **not** the bare array the docs show (`api_server.py` `_handle_toolsets`) | **Adapter bug, fixed.** The old preflight required an array, so it would always have reported Hermes unavailable (fail-closed but unusable). It now accepts this wrapper (requiring `platform: api_server`) or a bare array, and refuses an empty inventory |
| Run idempotency | `features.runs_idempotency = {supported, durable, retention_seconds: 86400}`; keys are durable in SQLite, scoped to the API key, and a same-body replay returns the original `run_id` (`api_server_run_idempotency.py`, `api_server_runs.py`) | The adapter now **requires** `supported` and `durable` to be `true`, because its one-retry rule depends on them |
| Served model | `runtime` on `GET /v1/runs/{id}` is the agent's `provider`/`model` after the turn, which a `fallback_providers` switch would change (`_served_runtime`). OpenRouter is an aggregator provider, so model ids are **not** normalized (`model_normalize._AGGREGATOR_PROVIDERS`) | `runtime.model` should equal the id Genie sends (`nvidia/nemotron-3-super-120b-a12b:free`). The adapter's exact comparison is compatible; still to be observed in the authorized smoke test |
| Tool resolution | An explicit empty `platform_toolsets.api_server: []` resolves to no toolsets. The agent treats `enabled_toolsets=[]` as "none", not "all" (`model_tools._select_tool_names`). No platform-native toolset is recovered for `api_server`. Context-engine and memory-provider tools are gated on the same list. **Plugin toolsets default ON** unless listed in `known_plugin_toolsets` | Empty list = zero tools, confirmed in source. Plugin toolsets appear in `/v1/toolsets`, so Genie's preflight refuses them. MCP servers do not appear there (item 2 below) |
| Profile `.env` isolation | Single-profile gateway (`hermes -p readyqr gateway`): loads only `<profile>/.env` (override=True), then the **install directory's `.env`** as a gap-filler, then **`/etc/hermes/.env`** (managed scope, override=True, beats the profile). The root `~/.hermes/.env` is not loaded. Shell or systemd environment credentials survive when the profile `.env` does not define them | New items 11, 12 and 13 below |
| **Credential pool fallback** | In profile mode `read_credential_pool("openrouter")` returns the profile's own `auth.json` entries, or, **if it has none, the root `~/.hermes/auth.json` entries**. `load_pool` adds an entry seeded from `OPENROUTER_API_KEY`, and the pool rung is resolved **before** the plain `.env` key (`auth.py`, `credential_pool.py`, `runtime_provider._ladder_rungs`) | **New blocker-level item 14.** If the administrator's root store has an OpenRouter pool entry, `readyqr` runs could be served, and billed, with that key instead of the $0-capped one |
| Background review | `auxiliary.background_review.enabled` defaults to **true** (fail-open). After a turn it may fork a review agent on the same runtime (provider, model, credentials). The API server does not pass `skip_background_review` | **New item 15:** must be explicitly `false`. With memory off and no skills tool it is unlikely to trigger for single-turn tool-free runs, but that is not proven |
| Auxiliary upgrades | `prefer_fast_model` applies only to `title_generation`; `model_upgrade_enabled` belongs to title generation. With `auxiliary.*` on `auto`, side tasks use the **configured main model** (`model.default`), not the per-request model | Owner's settings (title off, both upgrades false, all `auto`, no `fallback_chain`) are correct; `model.default` must be the free model (item 4) |
| Startup guard | The API server refuses to start without an `API_SERVER_KEY` of 16+ characters that is not a placeholder | Matches Genie's own 16-character minimum; the service plan uses 64 hex characters |

## What the Genie adapter enforces (`apps/api/src/adapters/HermesApiAdapter.ts`)

This sits on top of everything Genie already checks before any dispatch:
authentication, tenant membership, RLS, approvals bound by digest v2, a
disabled-agent check and the free-first policy re-run at dispatch time.

* **Selection.** The adapter is used only with `HERMES_ENABLED=true` and a valid
  `HERMES_BASE_URL`, `HERMES_API_KEY` and `HERMES_TENANT_ID`. Any other
  combination selects the honest "unavailable" stub, and readiness names the
  missing setting (never its value). A masked value (`__GENIE_NOT_AVAILABLE__`)
  counts as unset.
* **One tenant only.** Only the tenant in `HERMES_TENANT_ID` can dispatch to
  Hermes. All other tenants get "Hermes is not enabled for this tenant." and
  cause no Hermes request at all. The platform's Hermes credentials therefore
  never become available to other tenants. The bound tenant's own stored
  credential is **not** forwarded; Hermes uses its own configured key.
* **Tool-free.** Every dispatch re-runs the preflight. This is not the cached
  readiness answer, so a toolset enabled since the last check still blocks the
  dispatch. A run that parks in `waiting_for_approval` (it asked for a tool) is
  stopped and the task fails.
* **Chat only, OpenRouter only, exact model.** Only `chat` tasks with input
  exactly `{ "prompt": "<text>" }` (up to 32,000 characters) are sent. They go
  out as `{input, model: <the policy-checked OpenRouter id>, provider: "openrouter"}`.
  `summarize`, `embed` and `title_generate` are never sent to Hermes.
* **Served model must match.** A completed run must report
  `runtime.provider = openrouter` and `runtime.model` equal to the requested
  model. Otherwise the output is discarded and the task fails visibly.
  **This check does not prevent spending.** It runs only after Hermes has
  finished the run. By then any fallback or auxiliary model Hermes used has
  already been called and, if it was paid, already billed to the account Hermes
  holds. Genie can neither stop nor refund that. It also sees only the model
  that produced the final answer, not Hermes' side calls (titles, compression,
  vision). Prevention is Hermes' own configuration plus a provider-side
  spending limit; see "Preventive Hermes configuration" below.
* **Stateless.** No session id, history, previous response,
  `X-Hermes-Session-Id` or `X-Hermes-Session-Key` is sent, so each run starts a
  fresh Hermes session.
* **Idempotent.** The `Idempotency-Key` is `genie-task-<taskId>`. If the
  response to `POST /v1/runs` is lost (connection cut, timeout) or is a 5xx,
  Genie retries **once** with the same key. Hermes then replays the original
  `run_id` if the first request created a run, so there is still at most one run
  per task. If the retry also fails, the task fails with "Hermes did not confirm
  the run (…). It may still have started on Hermes under idempotency key
  genie-task-<id>". Genie cannot see or stop such a run. Genie's conditional
  claim already prevents a duplicate dispatch.
* **Bounded responses.** Hermes responses over 2,000,000 characters are refused,
  whether the size is declared up front or only seen while streaming.
* **No leaks.** Redirects are refused, so the key is never replayed to another
  host. Errors and readiness details never contain the key or URL. Hermes error
  text is cut to 200 single-line characters. Result: `{text, servedBy, usage}`,
  where usage is labelled `reportedBy: hermes`.
* **Asynchronous runs.** A submitted task stays `running`. `GET
  /tenants/{tenantId}/tasks/{taskId}` asks Hermes once for that task's run and
  settles it. A cancellation recorded first always wins; a cancel that arrives
  while the run is being submitted stops it once Hermes accepts it. If Hermes
  is unreachable, the task stays `running` rather than failing.

## Blockers before `HERMES_ENABLED=true` (each needs owner approval)

1. **Codex verifies the VPS 2 install:** its version, and that
   `GET /v1/capabilities` reports `run_submission`, `run_status` and `run_stop`
   with `auth.required: true`.
2. **Codex verifies the Hermes configuration on VPS 2** against every item in
   "Preventive Hermes configuration" below, by running
   `infra/hermes/audit_hermes_profile.py` as the `hermes` account. The owner's
   15 October settings cover items 1–7 except two items the owner list does
   not mention: **item 14** (root credential pool) and **item 15**
   (`auxiliary.background_review.enabled: false`). Items 11–13 and 16 are also
   not yet confirmed. Genie can check only the toolset item over the API.
3. **Owner decision on credentials:** Hermes will run on the platform's own
   OpenRouter key, for the one bound tenant only. Multi-tenant Hermes means one
   Hermes profile per tenant; that is not designed or implemented.
4. **A non-empty model allowlist** (`apps/api/config/approved-models.json`),
   with the pricing sync having verified it. The Hermes model must be on it.
5. **Networking:** genie-core can reach Hermes on a private address. Hermes is
   never exposed publicly (hermes.genie.readyqr.com stays private or behind
   authenticated access). The proposed plan, not applied, is in
   `docs/HERMES-SERVICE-PLAN.md`.
6. **A real tool-free smoke test**, which BUILD-SPEC requires explicit
   authorization for. It must also confirm that a completed run reports
   `runtime.provider` and `runtime.model` in exactly the form Genie sends: the
   OpenRouter id without the `openrouter/` prefix, e.g. `vendor/model:free`.
   The Hermes source suggests it does, but this has not been observed on a real
   run. If the form differs, every run is discarded (safe, but unusable) and
   the comparison needs a reviewed change.

Until then, production keeps `HERMES_ENABLED=false`. Readiness then reports
`agentAdapter: unavailable`, and every task fails visibly.

## Preventive Hermes configuration (required before enabling)

This is what actually stops Hermes from spending money, using tools or
carrying data between runs. Genie's checks only detect some violations after
the fact. Every item applies to the Hermes profile whose API server Genie
calls, and Codex verifies each one on VPS 2. Key names are from Hermes'
documentation (main branch, October 2026); confirm them against the installed
version.

| # | Requirement | Hermes setting | Why | Genie can verify? |
| --- | --- | --- | --- | --- |
| 1 | No tools for API runs | `hermes tools`: nothing enabled for the `api_server` platform (`platform_toolsets`) | API runs otherwise get terminal, file, web and other tools | **Yes**, preflight on every dispatch via `GET /v1/toolsets` |
| 2 | No MCP servers | no `mcp_servers` entries | `/v1/toolsets` does not list default MCP servers | No |
| 3 | No main-model fallback | no top-level `fallback_providers` list, and no legacy `fallback_model` | Hermes otherwise switches provider or model on errors **before** Genie sees anything | Only after the run, and only for the final answer |
| 4 | Main model is the free model | `model.provider: openrouter`, `model.default` = the verified-free OpenRouter id Genie dispatches | Auxiliary tasks on `auto` use the main model, and the auxiliary capacity-error "safety net" falls back to it even when a task is pinned elsewhere | No |
| 5 | No paid auxiliary calls | `auxiliary.title_generation.enabled: false`; every other `auxiliary.<task>` (`compression`, `vision`, `skills_hub`, `mcp`, `approval`, `review`, `triage_specifier`, `curator`, …) left on `auto` (= item 4) or pinned to a verified-free model; **no** `auxiliary.<task>.fallback_chain` entries | Side calls are billed like chat and are invisible to Genie | No |
| 6 | No model routes | no `gateway.api_server.model_routes` (or `platforms.api_server.model_routes`) | A route alias matching the requested model could pin other credentials or a base URL | No |
| 7 | No memory | `memory.memory_enabled: false`, `memory.user_profile_enabled: false`, no `memory.provider` (e.g. Honcho) | Memory is per profile and would carry content between runs | No |
| 8 | No private context files | no `SOUL.md`, `AGENTS.md`, `.hermes.md`, `CLAUDE.md` or `.cursorrules` with private content in the Hermes account's home or the gateway's working directory | They are injected into the system prompt and can surface in answers | No |
| 9 | Private, authenticated API | `API_SERVER_ENABLED=true`; `API_SERVER_HOST` loopback or the private Docker network only; dedicated random `API_SERVER_KEY` (16+ chars, used nowhere else); `API_SERVER_CORS_ORIGINS` unset | The API server can run whatever the profile allows | Partly: auth required (preflight), no redirects |
| 10 | Provider-side spending cap | a dedicated OpenRouter key for this Hermes profile; if the account offers a per-key credit or spend limit, set it to zero | The only control that still stops spending if items 3–6 or 14–15 are ever wrong | No. Owner action; a provider-account change needs owner approval |
| 11 | No install-directory credentials | the Hermes checkout's `.env` defines no credentials or base URLs | Hermes loads it after the profile `.env` to fill gaps | No; audit `INSTALL-ENV` |
| 12 | No managed scope | `/etc/hermes/config.yaml` and `/etc/hermes/.env` absent (or reviewed) | The managed scope overrides every profile's config and `.env` | No; audit `MANAGED-SCOPE` |
| 13 | Clean service environment | the systemd unit sets no credential, base-URL, `HERMES_KANBAN_TASK`, `HERMES_MANAGED_DIR` or `HERMES_HOME` variables and loads no `EnvironmentFile` | Process-environment credentials survive when the profile `.env` does not define them | No; audit `UNIT-*` |
| 14 | **No root credential-pool fallback** | the root `~/.hermes/auth.json` has **no** `credential_pool.openrouter` entries; or the profile's own `auth.json` pool holds exactly the dedicated key (a non-empty profile pool shadows the root one) | Otherwise runs can use the administrator's OpenRouter key, which the $0 cap does not cover | No; audit `POOL-ROOT-FALLBACK`, `POOL-PROFILE` |
| 15 | No background review | `auxiliary.background_review.enabled: false` | Defaults on; a post-turn fork on the same key and model | No; audit `AUX-BACKGROUND-REVIEW` |
| 16 | No external secret sources | no `secrets:` block and no `.op.env` in the profile | Bitwarden or 1Password sources can inject other credentials | No; audit `SECRET-SOURCES` |

With items 1–9 and 11–16 in place, the remaining Genie-side check (served model equals
requested model) is a tripwire. It is not a spending control.

## Offline profile audit (`infra/hermes/audit_hermes_profile.py`)

* Python standard library plus PyYAML or ruamel.yaml, whichever the Hermes
  venv has.
* It reads the profile's `config.yaml`, `.env` and `auth.json`, the root
  `auth.json`, the install directory's `.env`, `/etc/hermes` and, optionally,
  the systemd unit.
* It reports PASS, FAIL, WARN or MANUAL per check, by id. Exit 0 means no
  required check failed.
* It never prints a value: not even the model id it compares, and not parser
  messages, which can quote secret-bearing lines.
* `--stage disabled` is for today: the API server must be off. `--stage
  enabled` adds the key, bind-address, port, CORS and unit checks.

Tests: 28 unittest cases in `infra/hermes/tests/`. Each runs the script as a
subprocess (`python -I`), as an operator would:
* a golden profile passes;
* each misconfiguration fails its own check;
* in every case, canary secrets placed in `.env`, `config.yaml`, `auth.json`,
  malformed YAML and the unit file never appear in text or JSON output;
* the shipped unit template passes every unit check.

They run under PyYAML and under ruamel.yaml 0.18.16 (no PyYAML), and five
mutations were confirmed:
* ignoring the root pool;
* ignoring background review;
* leaking the model id;
* printing the YAML parser's traceback;
* printing the API key.

## Edge cases and known limits

* **Check, then run.** Toolsets are checked just before each run starts. A
  Hermes configuration change between that check and the run, or during the
  run, is not detected.
* **Unconfirmed submission.** After a failed retry (see "Idempotent"), the run
  may exist on Hermes without Genie knowing its id.
* **Hermes restarts.** Hermes marks an active run `interrupted`; Genie fails
  the task.
* **Status retention.** Runs are polled by id. Hermes keeps idempotent run
  status for about 24 hours; after that a still-unsettled task fails with
  "Hermes no longer has a record of this run."
* **Read amplification.** Each `GET …/tasks/{id}` of a running task makes one
  Hermes status request, so the frontend should poll no faster than every 2
  seconds. The task list does not settle tasks.
* **Usage.** Usage is whatever Hermes reports for the run, labelled as such.
  It excludes Hermes' auxiliary calls and is not a cost figure.

## Tests run (local, stand-in Hermes server, no model calls)

`apps/api/test/integration/hermesAdapter.test.ts`, 17 tests:

* **Preflight:** readiness is unavailable for any enabled or unlabelled toolset,
  for auth not required, a missing run feature, a redirect (not followed, key
  not replayed), a wrong key or an unreachable host. Details never contain the
  key or URL.
* **Dispatch:** exactly one run, with the exact body and idempotency key and no
  session headers. The tenant credential does not appear in any Hermes request.
  The task settles on read, reported usage survives redaction, the audit event
  is recorded, and the same idempotency key starts no second run.
* **Tenant isolation:** an unbound tenant causes zero Hermes requests. Another
  tenant cannot read, settle or cancel the bound tenant's task, by its own URL
  or by tampering IDs.
* **Primary free-only:**
  * a paid model with fallback off, or stale pricing, makes zero runs;
  * a fallback-served run is discarded;
  * a run with a missing `runtime` is discarded.
* **Auxiliary free-only:**
  * `summarize`, `embed` and `title_generate` are never sent to Hermes, even
    with a free model;
  * with a paid model they are refused by policy;
  * smuggled extra input fields are refused.
* **Approval binding:** no run while awaiting approval or after a rejection; one
  run per approval; a replayed decision returns 409; an agent change after the
  request makes the approval mismatch and nothing runs.
* **Dispatch checks:** a disabled agent, or stale pricing at dispatch, gives
  zero Hermes requests. Another tenant's context cannot claim a task. A tool
  approval request stops the run. Gemini models are refused.
* **Cancel:** stops the Hermes run and wins over a later completion. A
  transient Hermes error leaves the task running.
* **Settings:** masked or missing settings select the stub and name the setting,
  never the value. A masked required secret fails like a missing one.
* **Fresh preflight per dispatch:** this holds even while readiness serves a
  cached "ok".
* **Unconfirmed submission:** a lost response is retried once with the same
  key and adopts the single run Hermes created. Two 5xx responses fail visibly
  and say the run may exist. One 5xx is absorbed.
* **Oversized responses** are refused, both declared and streamed.
* **Sentinel inside a value:** a connection string or URL containing
  `__GENIE_NOT_AVAILABLE__` counts as masked, and a required setting then fails
  as "missing (… masked …)".
* **835c3dd compatibility:**
  * the wrapped `{object, platform: api_server, data}` inventory and the
    documented bare array are accepted;
  * another platform's inventory, or an empty inventory, is refused;
  * an enabled plugin toolset is refused;
  * missing or non-durable `runs_idempotency` is refused.
* **Races:**
  * a cancellation recorded during a status check wins;
  * a cancellation recorded while a submission is in flight also stops the
    run Hermes accepted.

Twenty of these guarantees were confirmed by mutation: disabling each one in
the code made the matching test fail. Restoring the old array-only toolset
parsing fails 13 of the 17 tests, because every dispatch path then reports
Hermes unavailable against the real response shape. The early refusal of a body declared as
too large is not separately detected, because the streaming cap still refuses
it; it is defence in depth.
