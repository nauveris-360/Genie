# Genie V3

Configuration-driven SaaS control plane for organisations, websites, AI agents
and approved automation. Hermes supplies reasoning; Genie supplies
authentication, tenant isolation, policy enforcement, task persistence, audit
history and the UI. This repository currently contains the **backend and the
shared API contract** for the first vertical-slice milestone.

> Not production-ready. Nothing in this repo is deployed. The Hermes adapter is
> an honest "unavailable" stub pending Codex's verification of a supported
> programmatic interface. See `docs/RUNBOOK.md` → "What is deliberately NOT integrated".

## Layout and ownership

| Path | Owner | Contents |
| --- | --- | --- |
| `packages/contracts/` | Claude Code | `openapi.yaml` (source of truth), `@genie/contracts` TypeScript types + permission matrix, safe fixtures |
| `apps/api/` | Claude Code | Fastify + TypeScript + PostgreSQL backend, SQL migrations, integration tests |
| `apps/web/` | AI Studio | React/TypeScript/Vite frontend (not in this repo yet; integrate via `docs/FRONTEND_HANDOFF.md`) |
| Hermes adapter | Codex | `apps/api/src/adapters/HermesAdapter.ts` is a placeholder for Codex's reviewed implementation |
| `infra/` | review only | Container definitions; deployment needs owner approval |
| `docs/` | — | Runbook, frontend handoff |

Contract changes are agreed between owners before either side changes code.

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
31 integration tests run serially against a real PostgreSQL 16 database using a
mock agent adapter; details and coverage list in `docs/RUNBOOK.md`.

## Guarantees implemented and tested
* Opaque server-side sessions in HttpOnly/SameSite cookies; argon2id passwords;
  CSRF double-submit bound to the session; strict `Origin`/`Referer` allowlist
  on every write including login (login-CSRF).
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
  fallback off by default, never auto-enabled; unknown/stale pricing never
  treated as free; no invented quota balances.
