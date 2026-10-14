# Genie V3

Configuration-driven SaaS control plane for organisations, websites, AI agents
and approved automation. Hermes supplies reasoning; Genie supplies
authentication, tenant isolation, policy enforcement, task persistence, audit
history and the UI. This repository currently contains the **backend and the
shared API contract** for the first vertical-slice milestone.

> Not production-ready. An auth-only public test runs on VPS 2 with Hermes
> disabled. The Hermes API server has been verified as the supported interface,
> and a constrained, tool-free, single-tenant client is implemented and tested
> locally. It stays disabled until the blockers in `docs/HERMES.md` are cleared
> and the owner approves.

## Layout and ownership

| Path | Owner | Contents |
| --- | --- | --- |
| `packages/contracts/` | Claude Code | `openapi.yaml` (source of truth), `@genie/contracts` TypeScript types + permission matrix, safe fixtures |
| `apps/api/` | Claude Code | Fastify + TypeScript + PostgreSQL backend, SQL migrations, integration tests |
| `apps/web/` | AI Studio | React/TypeScript/Vite frontend (not in this repo yet; integrate via `docs/FRONTEND_HANDOFF.md`) |
| Hermes adapter | Codex (review) | `HermesApiAdapter.ts` (constrained client, disabled by default) and `HermesAdapter.ts` (unavailable stub); see `docs/HERMES.md` |
| `infra/` | review only | Container definitions; deployment needs owner approval |
| `docs/` | — | Runbook, deployment, Hermes verification (`HERMES.md`), reproduction steps (`REPRODUCE.md`), frontend handoff, planned agent domains (`AGENT-DOMAINS.md`) |

Contract changes are agreed between owners before either side changes code.

Planned hostnames for every Genie agent (not provisioned) are in
`docs/AGENT-DOMAINS.md`: this backend is genie-core → `api.genie.readyqr.com`.

## Quick start (local)
```bash
npm install
cp .env.example apps/api/.env             # fill in; see docs/RUNBOOK.md
npm run build --workspace=@genie/contracts
npm run migrate
BOOTSTRAP_OWNER_EMAIL=... BOOTSTRAP_OWNER_PASSWORD=... npm run bootstrap:owner
npm run dev                                # http://localhost:4000/api/v1/health/ready
```

## Tests
```bash
cp apps/api/.env.test.example apps/api/.env.test   # point at a disposable DB
npm test
```
115 integration tests run serially against a real PostgreSQL 16 database using a
mock agent adapter; details and coverage list in `docs/RUNBOOK.md`.

## Guarantees implemented and tested
* Opaque server-side sessions in HttpOnly/SameSite cookies; argon2id passwords;
  CSRF double-submit bound to the session; strict `Origin`/`Referer` allowlist
  on every write including login (login-CSRF).
* Login rate limiting (per address+account and per address, failures only,
  `429` + `Retry-After`), proxy-safe client IP (`TRUSTED_PROXIES`, default none),
  no account-wide lockout.
* Server-enforced owner/admin/operator/viewer matrix (`@genie/contracts`
  `PERMISSION_ROLES`), membership resolved from the DB for the `tenantId` in
  every URL; cross-tenant access by ID tampering returns 404.
* PostgreSQL row-level security (`FORCE`) on every tenant-scoped table as a
  second isolation layer; default-deny when no tenant context is set.
* Provider credentials AES-256-GCM encrypted with an external key; API returns
  presence metadata only; logs and audit metadata are redacted.
* Tasks with required `Idempotency-Key`, explicit lifecycle states, 202 returns
  the persisted record; approvals immutable and bound to tenant + action +
  payload digest + expiry; full audit trail; state survives restart.
* Free-first model policy enforced server-side for every call kind; paid
  fallback off by default, never auto-enabled; seeded, unknown and stale
  pricing never treated as free (fail closed until a trusted verification);
  no invented quota balances. Pricing is verified from OpenRouter's free public
  model list for an owner-reviewed allowlist (`apps/api/config/approved-models.json`)
  and re-checked immediately before every model call.
* Approvals bind the task payload and (digest v2) the agent's model, connection
  and config; legacy v1 approvals stay valid.
* Members and one-time invitations with an owner/admin role hierarchy and a
  guaranteed last owner.
* Backup and restore-rehearsal scripts (`infra/scripts/`), rehearsed locally.
* Fail-closed production startup gate (no superuser/BYPASSRLS role, schema at
  the build's version, RLS intact) and advisory-lock-serialized migrations;
  separate provisioning, migration, runtime and backup roles
  (`docs/DEPLOYMENT.md`).
