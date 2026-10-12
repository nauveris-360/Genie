# Genie V3 API — local setup, bootstrap, migrations and rollback

Scope: build-and-review runbook for `apps/api`. Nothing here deploys anything.
Deployment to VPS 2 via Coolify, hostname/TLS selection, backups and restore
rehearsal are separate, owner-approved steps (see BUILD-SPEC.md). VPS 1 (n8n,
production websites) is never touched by this repository.

## Prerequisites
* Node.js 22.x, npm 10.x (lockfile is `package-lock.json`, dependencies pinned).
* PostgreSQL 16 reachable locally. Create a dedicated role and two databases:
  ```sql
  CREATE ROLE genie LOGIN PASSWORD '<local-only-password>';
  CREATE DATABASE genie_dev  OWNER genie;
  CREATE DATABASE genie_test OWNER genie;
  ```
  The application role must **not** be a superuser and must **not** have
  `BYPASSRLS`; the row-level-security policies are part of tenant isolation.

## Configure
```bash
cp .env.example apps/api/.env          # fill in real local values
cp apps/api/.env.test.example apps/api/.env.test
openssl rand -hex 32                   # -> SESSION_COOKIE_SECRET
openssl rand -base64 32                # -> CREDENTIAL_ENCRYPTION_KEY (32 bytes)
```
`CREDENTIAL_ENCRYPTION_KEY` is the external deployment secret that protects
provider credentials at rest (AES-256-GCM). Losing it makes stored credentials
unrecoverable (users re-enter them); leaking it together with a DB dump exposes
them. Keep it in the deployment's secret store only — never in Git, fixtures,
logs or the database. `ALLOWED_ORIGINS` must be the exact origin(s) of the web
app; login and every write are rejected from any other Origin.

## Install, migrate, run
```bash
npm install
npm run build --workspace=@genie/contracts
npm run migrate            # applies apps/api/src/migrations/*.up.sql in order
npm run dev                # http://localhost:4000/api/v1/health/live
```
`npm start` (and `npm run dev`) also run pending migrations on boot.

## One-time owner bootstrap (private)
There is no default account or password anywhere in the codebase. Create the
first owner once, on the server, with the values supplied **inline** for that
single command so they never land in `.env`, shell profiles or Git:
```bash
BOOTSTRAP_OWNER_EMAIL='owner@example.com' \
BOOTSTRAP_OWNER_PASSWORD='<at least 12 chars, from a password manager>' \
BOOTSTRAP_TENANT_NAME='Primary' \
npm run bootstrap:owner
history -d $(history 1 | awk '{print $1}')   # or clear the shell history line
```
The script refuses to run if any user already exists. It creates the user
(argon2id hash), the tenant, an `owner` membership, a model policy with paid
fallback **off**, and a `tenant.bootstrapped` audit event, all in one transaction.
Further members are added by owners through the application once a membership
endpoint exists (not part of v1).

## Migrations
* Files live in `apps/api/src/migrations/` as `NNN_name.up.sql` / `NNN_name.down.sql`
  pairs; a migration without a down file is rejected.
* `schema_migrations` records id + SHA-256 checksum. **Never edit an applied
  migration** — the runner refuses to continue if a checksum changes; add a new
  numbered migration instead (see `004_rls_nullif` for the pattern).
* Each migration runs in its own transaction and is rolled back atomically on error.
* Current set: `001_core` (users, tenants, memberships, sessions),
  `002_tenant_scoped` (RLS-protected tenant tables, model registry, same-tenant
  trigger), `003_seed_models` (placeholder registry rows), `004_rls_nullif`
  (policy hardening).

### Rollback
```bash
npm run migrate:rollback   # rolls back exactly ONE migration (the latest)
npm run migrate            # re-applies
```
Rollback drops tables and their data for that step — take a database-aware
backup first in any shared environment. Rolling back `003` removes the seeded
registry rows (agents referencing them keep their `model_id` text but become
`model_not_allowed`); rolling back `002` drops all tenant operational data.

## Restart / persistence
All state (sessions, tasks, approvals, audit history) is in PostgreSQL; the API
process is stateless apart from the in-memory mock adapter used in tests. The
`restart preserves task history` integration test closes the app and pool and
rebuilds them against the same database.

## Tests
```bash
npm test     # 31 integration tests, serial, against DATABASE_URL in apps/api/.env.test
```
The suite migrates the test database from whatever state it is in, truncates
data between files, and in `migrations.test.ts` drops and recreates the schema.
Point `.env.test` only at a disposable database. Covered: login/logout/me,
cookie flags, CSRF, login-CSRF (Origin/Referer), expired/tampered sessions,
full role matrix, cross-tenant ID tampering across every endpoint, RLS
default-deny, same-tenant trigger, credential never leaking + encryption at
rest + wrong-key/tamper failure, idempotency (including concurrent duplicates),
202-is-persisted-record, cancel semantics, pagination, adapter failure and
Hermes-unavailable visibility, approval approve/reject/replay/payload-change/
expiry, free-first blocking for every task type and paid-fallback semantics,
migrations up/idempotent/down/re-up/checksum tamper, restart persistence.

## Containers (review only — not deployed)
`infra/Dockerfile.api` builds the API as a non-root image with no secrets baked
in; `infra/docker-compose.yml` wires it to a PostgreSQL 16 service for local
review using environment placeholders. Resource limits, health checks and
persistent volumes are declared there for review. Running them against real
infrastructure requires owner approval and the deployment steps in BUILD-SPEC.md.

## What is deliberately NOT integrated
* **Hermes**: the adapter is an honest stub (`availability: unavailable`); every
  submission through it fails visibly. Codex owns verifying a programmatic
  interface before `HermesAdapter` gets a real implementation.
* **n8n execution, provider usage/quota, email, voice, SEO, publishing, billing**:
  not implemented; `Model.usage` is always `null`.
* **Model registry pricing**: seeded placeholders. A verification job that
  refreshes `pricing_status` / prices / `last_verified_at` from live provider
  data is still to be built; until then only the seeded `verified_free` row passes.
* **Rate limiting** on login: the contract reserves `429 rate_limited`, but no
  limiter is wired yet (pending choice of store).
