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
Everyone else joins through an invitation (see "Members and invitations").

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
  (policy hardening), `005_rate_limit_and_verification` (login buckets, pricing
  provenance), `006_approval_digest_v2` (versioned approval digests),
  `007_invitations` (one-time invitations).

### Rollback
```bash
npm run migrate:rollback   # rolls back exactly ONE migration (the latest)
npm run migrate            # re-applies
```
Rollback drops tables and their data for that step — take a database-aware
backup first in any shared environment. Rolling back `007` drops all
invitations (outstanding links stop working; memberships are unaffected).
Rolling back `006` drops `approvals.digest_version`, after which pending v2
approvals no longer match and fail closed (409) rather than being accepted
without their agent binding. Rolling back `005` drops the
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
event and no adapter call. For a task with an approval, the gate also
re-verifies that the approval is `approved` and that its digest still matches
exactly what is about to be dispatched, closing the gap between decision and
run.

## Approval digests (versioned)
`approvals.digest_version` records the format each approval was bound with.
**v2** (all new approvals) binds the task payload plus the agent's `modelId`,
`providerConnectionId` and `config` at request time, so any material agent edit
after the request invalidates the approval (409 at decision, or blocked at
dispatch). Name and description are cosmetic and not bound. **v1** (approvals
created before migration 006) binds the task payload only and keeps validating
exactly as before; for those, the dispatch gate's live policy/provider checks
remain the protection against agent edits. Unknown versions never match. Both
versions use the same canonical JSON; the recipe is in docs/FRONTEND_HANDOFF.md.

## Model pricing provenance (fail closed)
Every row in `models` has `verification_source`: `seed` (placeholder, from
migrations) or `trusted` (written only by `recordTrustedVerification`; no HTTP
route can set it). The policy treats `seed` rows as `unknown` and never allows
them, not even with paid fallback. A `trusted` row older than
`MODEL_PRICING_MAX_AGE_HOURS` (72) is `stale` and refused until re-verified.
Until the pricing sync below has run with at least one approved model, no model
is usable and every task fails `409 model_not_allowed`. That is intended; do
not work around it by editing rows.

## Pricing sync (OpenRouter)
`npm run models:sync` reads OpenRouter's free, public, unauthenticated model
list (`GET https://openrouter.ai/api/v1/models`). It sends no API key and calls
no model, so it costs nothing. It verifies **only** the models listed in
`apps/api/config/approved-models.json`, the reviewed allowlist (shipped
empty: approving a model is an owner decision, made by editing this file in a
reviewed change):
```json
{ "openrouter": [ { "openRouterId": "<vendor>/<model>:free", "displayName": "Optional label" } ] }
```
Use OpenRouter's own id without a prefix; the registry stores it as
`openrouter/<id>`, which is the `modelId` agents use. When a real Hermes
adapter exists it must strip the `openrouter/` prefix before calling the
provider. Classification fails closed:
* `verified_free` only if `prompt` and `completion` are present and **every**
  pricing dimension (request, image, web search, reasoning, cache, and any
  dimension OpenRouter adds later) is exactly zero;
* any non-zero dimension → `paid` (a `:free` suffix does not override it);
* missing, malformed or negative values (OpenRouter uses `-1` for variable
  pricing) → `unknown`;
* an approved model missing from the feed → `unknown`;
* a previously trusted model removed from the allowlist → `unknown`.
Feed models that are not approved are never added. All writes happen in one
transaction; a transport or format error writes nothing. Always run
`npm run models:sync -- --dry-run` first and read the output.

Schedule it every 6 hours (well inside the 72-hour freshness window), e.g. a
cron job or a Coolify scheduled task running `node apps/api/dist/policy/pricingSyncCli.js`
in the API image. If it stops running, verified models go `stale` after 72 hours
and are refused: safe, but tasks stop working.

**Not verified against the live feed yet.** This build environment's network
policy blocks `openrouter.ai`, so the sync is tested only with fixtures modelled
on OpenRouter's documented format. Do the first `--dry-run` on VPS 2 and check
that the approved model shows `verified_free` with sensible reasons before
relying on it. Gemini has no public machine-readable pricing, so Gemini models
stay unverified (refused) until a separate verification source is chosen.

## Members and invitations
Any member can list members. Owners can change or remove anyone and invite to
any role. Admins can only invite, change or remove operators and viewers, and
only assign those roles. A tenant can never lose its last owner; every member
change locks the tenant's owner rows first and re-reads the actor's role under
that lock, so concurrent changes serialize. Removal takes effect on the
removed user's next request.

`POST /tenants/{id}/invitations` returns a one-time token **once** (only its
SHA-256 is stored). The link is valid for 7 days, and a new invitation for the
same email revokes the previous one. **No email is sent**: give the link to the
person over a channel you trust; whoever holds it can claim the seat. If the
email has no account, accepting creates one (password of 12+ characters) and
signs it in. If it has an account, the person must sign in as exactly that
account first; there is no second password-checking path. Acceptance is
single-use under concurrency and rate limited per client address (20 failures
per 15 minutes, same settings as login).

## Backups and restore rehearsal
Tenant tables use `FORCE ROW LEVEL SECURITY`, so **the application role cannot
take a backup**: `pg_dump` as `genie` fails with "query would be affected by
row-level security policy". This is the safe failure. Never use
`--enable-row-security`, which silently dumps zero tenant rows. Create a
dedicated read-only backup role once (run as a superuser; BYPASSRLS requires one):
```sql
CREATE ROLE genie_backup LOGIN BYPASSRLS PASSWORD '<from your secret store>';
GRANT CONNECT ON DATABASE genie TO genie_backup;
GRANT USAGE ON SCHEMA public TO genie_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO genie_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE genie IN SCHEMA public GRANT SELECT ON TABLES TO genie_backup;
```
Then:
```bash
# Backup: custom-format dump + .sha256. Connection via libpq env vars, so no password on the command line.
PGHOST=... PGUSER=genie_backup PGDATABASE=genie BACKUP_DIR=/var/backups/genie infra/scripts/backup-db.sh
# Copy BOTH files off-server (e.g. restic or rclone to object storage). The script uploads nothing.

# Rehearsal: verify checksum, restore into a NEW scratch DB, check migrations,
# RLS 7/7, row counts (optionally vs the live DB), then drop the scratch DB.
PGHOST=... PGUSER=<admin> COMPARE_DATABASE=genie infra/scripts/restore-rehearsal.sh /var/backups/genie/genie-<stamp>.dump
```
The admin role needs CREATEDB and must bypass RLS (a superuser is simplest),
and the application roles must exist on the target server. Rehearse before any
live customer data, and after every schema change. `CREDENTIAL_ENCRYPTION_KEY`
is **not** in the database backup: keep it in the secret store, backed up
separately. Without it, restored provider credentials cannot be decrypted (users
re-enter them).

Verified locally: backup through a least-privilege `genie_backup` role, then
restore rehearsal with all checks passing and row counts equal to the source; a
corrupted dump is rejected at the checksum step; no scratch database is left
behind.

## Restart / persistence
All state (sessions, tasks, approvals, audit history) is in PostgreSQL; the API
process is stateless apart from the in-memory mock adapter used in tests. The
`restart preserves task history` integration test closes the app and pool and
rebuilds them against the same database.

## Tests
```bash
npm test     # 89 integration tests, serial, against DATABASE_URL in apps/api/.env.test
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
disabled, provider mismatch, wrong-tenant run — each with zero adapter calls),
approval digest v2 (documented recipe, material vs cosmetic agent edits, legacy
v1 compatibility, unknown versions, decision-to-run window), the OpenRouter
pricing sync (classification incl. every malformed case, no credentials sent,
allowlist only, demotion, dry run, all-or-nothing, end to end), and members and
invitations (role rules, last owner under concurrency, immediate revocation,
one-time hashed tokens, new and existing account flows, single use under
concurrency, generic errors, rate limiting). Test model rows are written through
`recordTrustedVerification`, standing in for the future verification job.

## Planned hostnames (not provisioned)
`docs/AGENT-DOMAINS.md` holds the owner-confirmed plan: genie-core (this API)
at `api.genie.readyqr.com`, genie-command (UI) at `genie.readyqr.com`, plus the
other agents, each in its own private repo and Coolify service. When deployment
is approved, the expected settings for option A (same-origin proxy) are:
* `ALLOWED_ORIGINS=https://genie.readyqr.com`
* `TRUSTED_PROXIES=<the reverse proxy's address or CIDR on VPS 2>`
* `NODE_ENV=production`, so cookies are `Secure`; cookies stay host-only (never
  set a parent `Domain`).

Nothing here authorizes DNS, TLS, Coolify or VPS changes. VPS 1 is out of
bounds, and genie-hermes, genie-infra and genie-agent-factory stay private or
behind authentication.

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
* **Live pricing feed**: the OpenRouter sync is built and tested with fixtures
  but has not been run against the real feed (network blocked here). The
  allowlist ships empty. Gemini pricing has no verification source.
* **Email**: invitations are not emailed; links are delivered out-of-band.
* **MFA, breached-password screening, password reset**: not implemented.
* **Rate limiting** covers `/auth/login` only. Other endpoints require a
  session and are not throttled yet.
