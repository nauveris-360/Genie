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
backup first in any shared environment. Rolling back `005` drops the
rate-limit buckets and the `verification_source` column (so trusted/seed
provenance is lost; re-run verification after re-applying). Rolling back `003`
removes the seeded registry rows (agents referencing them keep their
`model_id` text but become `model_not_allowed`); rolling back `002` drops all
tenant operational data.

## Login rate limiting
Failures only, fixed window (`LOGIN_RATE_LIMIT_WINDOW_SECONDS`, default 900):
at most `LOGIN_MAX_FAILURES_PER_IP_ACCOUNT` (5) per client address + account
and `LOGIN_MAX_FAILURES_PER_IP` (20) per client address. Counters live in
PostgreSQL (`rate_limit_buckets`, account part stored only as a SHA-256 of the
normalised email), so limits survive restarts and multiple instances; expired
rows are swept hourly. Reservation is a single atomic UPSERT taken *before*
password verification, so concurrency cannot overshoot and limited requests
cost no argon2 work. 429 responses carry `Retry-After` and
`error.retryAfterSeconds` with one generic message.

There is deliberately **no account-wide lockout**: it would let anyone lock a
user out. The trade-off is that a distributed attacker gets
5 guesses per account per window *per address they control* (IPv6 grouped by
/64). Mitigations beyond this milestone: MFA, breached-password screening,
alerting on per-account failure spikes from many addresses.

**Client IP.** With `TRUSTED_PROXIES` empty (default) the client is the TCP
peer and `X-Forwarded-For` is ignored. Behind a reverse proxy, set
`TRUSTED_PROXIES` to exactly the proxy's address/CIDR; the client is then the
right-most `X-Forwarded-For` hop that is not a trusted proxy. Getting this
wrong in either direction is a security issue: too broad lets clients spoof
their bucket; empty behind a proxy puts every user in the proxy's single
bucket (shared 20-failure budget). Invalid values abort startup.

## Pre-dispatch gate
`TaskService.run` is the only place the adapter is called. In the same
transaction that claims a task it reloads the current agent and provider
connection (tenant-scoped), refuses a disabled agent, re-runs the free-first
policy for the agent's current model and the task's call kind, and requires the
model's provider to match the connection. A failed check marks the task
`failed` (`Blocked before dispatch: …`) with a `task.dispatch_blocked` audit
event and no adapter call. Known limit: the approval digest binds the task
payload, not the agent's configuration, so an agent edit that still passes
policy (e.g. a different allowed free model or changed `config`) does not
invalidate a pending approval. Binding agent configuration would be a new,
versioned digest format.

## Model pricing provenance (fail closed)
Every row in `models` has `verification_source`: `seed` (placeholder, from
migrations) or `trusted` (written only by `recordTrustedVerification`, the
entry point for a future server-side pricing-verification job; no HTTP route
can set it). The policy treats `seed` rows as `unknown` and never allows
them, not even with paid fallback. A `trusted` row older than
`MODEL_PRICING_MAX_AGE_HOURS` (72) is `stale` and refused until re-verified.
**Consequence today: with no verification job, no model is usable in a real
deployment** — every task fails `409 model_not_allowed`. That is intended
until a trusted verification exists; do not work around it by editing rows.

## Restart / persistence
All state (sessions, tasks, approvals, audit history) is in PostgreSQL; the API
process is stateless apart from the in-memory mock adapter used in tests. The
`restart preserves task history` integration test closes the app and pool and
rebuilds them against the same database.

## Tests
```bash
npm test     # 67 integration tests, serial, against DATABASE_URL in apps/api/.env.test
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
seeded/stale/unknown/paid registry rows failing closed (and stale → re-verified),
login rate limiting (per-pair and per-address bounds, Retry-After, no
password or account-existence oracle, no lockout of the user at another
address, concurrent-race bound, success refunds, window expiry,
X-Forwarded-For spoofing with and without a trusted proxy, IPv6 /64 grouping,
invalid proxy config), migrations up/idempotent/down/re-up/checksum tamper,
restart persistence, digest canonicalization (own `__proto__`/`constructor`/
integer-like keys bound into approval and idempotency digests, byte-identical to
the v1 format otherwise, pinned legacy hashes), and the pre-dispatch gate
(model switched, fallback turned off, pricing stale/repriced/revoked, agent
disabled, provider mismatch, wrong-tenant run — each with zero adapter calls).
Test model rows are written through
`recordTrustedVerification`, standing in for the future verification job.

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
* **Model pricing verification job**: not built. Seeded rows are placeholders
  and fail closed, so no model is usable outside tests until a trusted job
  calls `recordTrustedVerification` (needs owner decision on the pricing source;
  it must not use paid API calls).
* **Rate limiting** covers `/auth/login` only. Other endpoints require a
  session and are not throttled yet.
