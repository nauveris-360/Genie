# Hermes integration: verification and constrained adapter

Status (14 October 2026): **Hermes has an official programmatic interface.** A
constrained Genie client for it is implemented and tested locally against a
stand-in server. It is **not enabled anywhere**. Turning it on requires the
checks and owner approvals listed under "Blockers" below. Codex owns the
adapter contract and reviews this before anything is enabled.

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
  model. Otherwise the output is discarded and the task fails visibly. This
  catches a fallback switch after the fact; it cannot undo spending. That is
  why Hermes-side precondition 2 below is required.
* **Stateless.** No session id, history, previous response,
  `X-Hermes-Session-Id` or `X-Hermes-Session-Key` is sent, so each run starts a
  fresh Hermes session.
* **Idempotent.** The `Idempotency-Key` is `genie-task-<taskId>`, so a retried
  dispatch cannot start a second run. Genie's conditional claim already
  prevents a duplicate dispatch.
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
2. **Codex verifies the Hermes configuration on VPS 2.** Genie cannot check
   these over the API:
   * no toolsets enabled for the `api_server` platform, and **no MCP servers**
     configured;
   * **no fallback providers** (no `fallback_model` chain);
   * auxiliary tasks: `auxiliary.title_generation.enabled: false`, and
     compression, vision and any other auxiliary task either disabled or pinned
     to a model on Genie's verified-free allowlist;
   * memory off: `memory.memory_enabled: false`, `user_profile_enabled: false`,
     no Honcho provider;
   * `API_SERVER_HOST` bound to loopback or the private Docker network only,
     `API_SERVER_CORS_ORIGINS` unset, and a dedicated `API_SERVER_KEY`
     (16+ random characters) that is used nowhere else.
3. **Owner decision on credentials:** Hermes will run on the platform's own
   OpenRouter key, for the one bound tenant only. Multi-tenant Hermes means one
   Hermes profile per tenant; that is not designed or implemented.
4. **A non-empty model allowlist** (`apps/api/config/approved-models.json`),
   with the pricing sync having verified it. The Hermes model must be on it.
5. **Networking:** genie-core can reach Hermes on a private address. Hermes is
   never exposed publicly (hermes.genie.readyqr.com stays private or behind
   authenticated access).
6. **A real tool-free smoke test**, which BUILD-SPEC requires explicit
   authorization for.

Until then, production keeps `HERMES_ENABLED=false`. Readiness then reports
`agentAdapter: unavailable`, and every task fails visibly.

## Tests run (local, stand-in Hermes server, no model calls)

`apps/api/test/integration/hermesAdapter.test.ts`, 12 tests:

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
* **Races:**
  * a cancellation recorded during a status check wins;
  * a cancellation recorded while a submission is in flight also stops the
    run Hermes accepted.

Thirteen of these guarantees were confirmed by mutation: disabling each one in the code
made the matching test fail.
