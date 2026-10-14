# genie-core deployment guide: option A (auth-gated public test)

Status: **guidance only, nothing deployed.** This document does not authorize
any deployment, DNS, TLS, Coolify, VPS or database-provisioning step. Each one
needs the owner's explicit approval. VPS 1 (production websites, n8n) is out of
bounds. Hostnames are the planned names from `docs/AGENT-DOMAINS.md`.

## 1. Topology (option A)

```
browser ──HTTPS──▶ genie.readyqr.com  (edge TLS: Coolify/Traefik on VPS 2)
                      │
                      ├─ /            → genie-command static web app (AI Studio / Codex)
                      └─ /api/*       → private reverse proxy → genie-core :4000  (same path)
genie-core ──private network──▶ PostgreSQL 16 (no published port)
```

* The browser only ever talks to `https://genie.readyqr.com` and calls the
  **relative** base `/api/v1`. There is no CORS, and the API sends no CORS
  headers.
* `api.genie.readyqr.com` remains genie-core's assigned hostname, but it is
  **not used by the browser**. For the public test, leave it unrouted (or
  internal/authenticated only). If it is ever routed publicly it must point at
  the same container and changes nothing below: login and writes from any
  origin other than `https://genie.readyqr.com` are refused.
* genie-hermes, genie-infra and genie-agent-factory stay private or behind
  authenticated access.

### Requirements for the private reverse proxy (`/api/*` → genie-core)

| Requirement | Why |
| --- | --- |
| Forward the path unchanged (`/api/v1/...` → `/api/v1/...`); do not strip `/api` | Routes are registered under `/api/v1` |
| Pass `Origin`, `Referer`, `Cookie`, `X-CSRF-Token`, `Idempotency-Key` unchanged | Login-CSRF/CSRF checks and idempotency depend on them |
| Pass `Set-Cookie` unchanged: **no** cookie domain or path rewriting | Cookies stay host-only on `genie.readyqr.com` (`HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`) |
| Append `X-Forwarded-For`; set `X-Forwarded-Proto: https` | Client IP for login rate limiting (with `TRUSTED_PROXIES`) |
| Add **no** `Access-Control-*` headers | No cross-origin access is intended |
| HTTPS only at the edge (redirect HTTP, HSTS) | Cookies are `Secure` in production |
| Request body limit ≥ 1 MB, upstream timeout ≥ 30 s | API body limit is 1 MB; task submission may run synchronously |
| Optional: block `/api/v1/health/ready` from the public | It reveals dependency status (no secrets) |

## 2. Configuration

### Secrets (names only; values live in the Coolify/secret store, never in Git)

| Name | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | genie-core runtime | `postgres://genie_app:<GENIE_APP_PASSWORD>@<db-host>:5432/genie` |
| `MIGRATION_DATABASE_URL` | migration job only | `postgres://genie_owner:<GENIE_OWNER_PASSWORD>@<db-host>:5432/genie` |
| `CREDENTIAL_ENCRYPTION_KEY` | genie-core runtime | `openssl rand -base64 32`. Back it up separately from the database: without it, stored provider credentials cannot be decrypted |
| `SESSION_COOKIE_SECRET` | genie-core runtime | Required by config validation but **currently unused** (sessions are opaque DB tokens). Set any `openssl rand -hex 32` value |
| `GENIE_DB_SUPERUSER_PASSWORD` | DB provisioning only | The Postgres superuser. Never given to the app or the migration job |
| `GENIE_OWNER_PASSWORD`, `GENIE_APP_PASSWORD`, `GENIE_BACKUP_PASSWORD` | DB provisioning, and the job or app that uses each role | `openssl rand -hex 32` (hex needs no URL escaping) |
| `PGPASSWORD` (= backup role password) | backup job only | With `PGUSER=genie_backup` |
| `BOOTSTRAP_OWNER_EMAIL`, `BOOTSTRAP_OWNER_PASSWORD` | one-time bootstrap | Typed interactively for one command, **never stored** |

### Non-secret runtime settings for the public test

| Name | Value | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | Enables `Secure` cookies and the fail-closed startup gate |
| `PORT` / `HOST` | `4000` / `0.0.0.0` | |
| `MIGRATE_ON_BOOT` | `false` | The image default. Migrations run as the separate job |
| `ALLOWED_ORIGINS` | `https://genie.readyqr.com` | Exactly this; no trailing slash, no wildcard |
| `TRUSTED_PROXIES` | IPs/CIDRs of **every** proxy hop in front of genie-core (edge Traefik **and** the private proxy) on the Docker network | Wrong or empty ⇒ all users share one login rate-limit bucket (see §5) |
| `DATABASE_SSL` | `false` on the private Docker network; `true` if the DB is reached over TLS | |
| `DATABASE_POOL_MAX` | `10` | |
| `SESSION_TTL_MINUTES` | `720` | |
| `LOGIN_RATE_LIMIT_WINDOW_SECONDS` / `LOGIN_MAX_FAILURES_PER_IP` / `LOGIN_MAX_FAILURES_PER_IP_ACCOUNT` | `900` / `20` / `5` | Defaults |
| `MODEL_PRICING_MAX_AGE_HOURS` | `72` | |
| `HERMES_ENABLED` | `false` | Keep `false` until every blocker in `docs/HERMES.md` is cleared and the owner approves. `HERMES_BASE_URL`, `HERMES_API_KEY` and `HERMES_TENANT_ID` are then required; with `false` they are ignored (mask them) |
| `DEFAULT_ALLOW_PAID_FALLBACK` | unset | Currently unused: every tenant's policy defaults to OFF in the database |

### Masked values (Coolify 4.4.6)

Coolify injects the whole stack `.env` into every container. A `null` entry
inherits a value, and an empty string is overwritten from saved values, so
blanking a key does not remove it. Keys a container must not receive are set
to `__GENIE_NOT_AVAILABLE__` instead. Genie (the API, the migration CLI and
owner bootstrap) treats that exact value as **unset**:

* a masked required setting fails at startup as "missing";
* a masked optional setting takes its default (a masked `TRUSTED_PROXIES`
  means "trust no proxy");
* the masked value is never used as a key, password, URL or address.

`infra/scripts/backup-db.sh` and `restore-rehearsal.sh` refuse to run if any
of their `PG*` settings is masked.

## 3. Database roles

| Role | Purpose | Attributes | Grants |
| --- | --- | --- | --- |
| provisioning (`postgres`) | Create database and roles, once | superuser | — |
| `genie_owner` | Migration job; owns the database and every table | LOGIN, **no** superuser, **no** BYPASSRLS | Owner (DDL). Still subject to the tenant policies via FORCE RLS |
| `genie_app` | genie-core runtime | LOGIN, **no** superuser, **no** BYPASSRLS | SELECT/INSERT/UPDATE/DELETE via default privileges; no DDL; not an owner |
| `genie_backup` | Backups only | LOGIN, **BYPASSRLS** (read-only) | SELECT via default privileges. **Never** the app's role |

Provision once, as the superuser, before the first migration:
```bash
psql -v db=genie -v owner_pw="$GENIE_OWNER_PASSWORD" -v app_pw="$GENIE_APP_PASSWORD" \
     -v backup_pw="$GENIE_BACKUP_PASSWORD" -f infra/db/provision-roles.sql
```
With the official postgres image, `infra/db-init/01-genie-roles.sh` does this
automatically on the first initialization of an empty volume (see
`infra/docker-compose.yml`). Verify:
```sql
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'genie\_%';
-- expect: genie_app f f | genie_backup f t | genie_owner f f
```

**Enforced in code:** in production, genie-core **refuses to start** (exit 1)
if any of these holds:
* its role is a superuser or has BYPASSRLS;
* any of the 7 tenant tables lacks enabled+forced RLS with the
  `tenant_isolation` policy;
* (with `MIGRATE_ON_BOOT=false`) any migration is pending, modified, or
  unknown to this build.

The migration CLI likewise refuses a superuser or BYPASSRLS role in
production. Migrations hold a PostgreSQL advisory lock on one dedicated
connection, so concurrent runs serialize.

## 4. Steps

1. **Build** (repository root, uses `.dockerignore`):
   `docker build -f infra/Dockerfile.api -t genie-core:<git-sha> .`
   In Codex's combined workspace, add `COPY apps/web/package.json apps/web/`
   next to the other manifest copies. Install and prune are already scoped to
   `@genie/api` + `@genie/contracts`, so web dependencies never enter the image.
2. **Provision roles** (once, §3).
3. **Migrate** (one-off job, same image, before every rollout):
   `node apps/api/dist/db/cli.js up` with `NODE_ENV=production`,
   `MIGRATION_DATABASE_URL`. Then `node apps/api/dist/db/cli.js status` must
   print `"pending":[],"modified":[],"unknown":[]` and exit 0 (it exits 2
   otherwise).
4. **Run genie-core** with the §2 settings (default CMD
   `node apps/api/dist/index.js`). If the startup gate fails, the log's last
   line starts with `Refusing to start:`.
5. **Health check** in Coolify: `GET /api/v1/health/live` (200). **Do not use
   `/health/ready`**: it returns **503** with
   `agentAdapter: unavailable` for as long as Hermes is not integrated, which
   would mark the container unhealthy.
6. **Bootstrap the first owner** (once), inside the genie-core container (its
   runtime env provides the DB connection):
   ```bash
   docker exec -it <genie-core-container> bash
   read -r  BOOTSTRAP_OWNER_EMAIL; read -rs BOOTSTRAP_OWNER_PASSWORD   # 12+ chars
   export BOOTSTRAP_OWNER_EMAIL BOOTSTRAP_OWNER_PASSWORD BOOTSTRAP_TENANT_NAME='ReadyQR'
   node apps/api/dist/auth/bootstrapCli.js
   unset BOOTSTRAP_OWNER_PASSWORD; exit
   ```
   It refuses if any user exists, and writes a `tenant.bootstrapped` audit
   event with paid fallback OFF. Everyone else joins by invitation.
7. **Pricing sync dry run**, inside the genie-core container (needs egress to
   `openrouter.ai`):
   `node apps/api/dist/policy/pricingSyncCli.js --dry-run`.
   * With the shipped empty allowlist it prints "No approved OpenRouter
     models", then fetches.
   * To approve a model, add its OpenRouter id to
     `apps/api/config/approved-models.json` in a reviewed change and rebuild
     (the allowlist is baked into the image).
   * Check that the dry run shows `verified_free` with a sensible reason, then
     run without `--dry-run`, and schedule it every 6 hours.
8. **Smoke test through `https://genie.readyqr.com`:**
   * `/api/v1/health/live` returns 200.
   * Login returns 200 with `genie_sid` (`HttpOnly; Secure; SameSite=Lax`, no
     `Domain`) and `genie_csrf` (`Secure`, readable).
   * Login with any other `Origin` returns 403.
   * A write without `X-CSRF-Token` returns 403.
   * No `Access-Control-*` headers appear.
   * The 6th failed login for one account from one client returns 429, while
     a different client still gets 401. If **everyone** gets 429 together,
     `TRUSTED_PROXIES` is wrong.
9. **Backups** before any real customer data (`infra/scripts/backup-db.sh` as
   `genie_backup`, plus `infra/scripts/restore-rehearsal.sh`; see
   `docs/RUNBOOK.md`).

Rollback: redeploy the previous image tag. Never roll the schema back with
live data without a fresh backup. `cli.js down` reverts exactly one migration
under the same lock, and genie-core refuses to start if the database has
migrations its build does not know.

## 5. Public-test readiness (auth-gated, Hermes unavailable)

**Fixed in this change (local, not yet pushed):**
* the app refuses to run as a superuser or BYPASSRLS role;
* migrations are serialized by an advisory lock;
* Compose no longer connects the app as the Postgres superuser;
* a `.dockerignore` keeps secrets and data out of the build context.

**Blockers to resolve at deploy time:**
1. `TRUSTED_PROXIES` must list every proxy hop. If it is wrong, all users share
   one login bucket, and 20 failed logins from anyone lock **everyone** out for
   15 minutes.
2. The Coolify health check must target `/health/live`, not `/health/ready`.
3. Use dedicated `genie_owner` / `genie_app` roles, never the database
   superuser. The startup gate enforces this, so a misconfigured deploy fails
   to start rather than running unsafely.

**Expected limitations during the test (not blockers for an auth-gated test, but visible):**
* **No agent execution.**
  * With the empty allowlist, creating an agent or submitting a task returns
    `409 model_not_allowed`.
  * Once a model is approved and synced, approved tasks end `failed` with
    `Blocked before dispatch`, or with "Hermes programmatic interface not
    configured". No fake results.
* **The pricing sync has never seen real OpenRouter data** (fixtures only);
  the first real run is the step-7 dry run.
* **No self-signup, no password reset, no MFA, no email.** The test is
  invite-only: invitation links are delivered out-of-band.
* **Rate limiting covers login and invitation-accept only.** Other endpoints
  require a session.
* **Test users should not enter real provider API keys** during the public
  test (keys are encrypted at rest, but there is no need for them while
  Hermes is unavailable).
* **`SESSION_COOKIE_SECRET` is required but unused.**
* **No backups are scheduled yet.** Use test data only until backups and a
  restore rehearsal exist on VPS 2. Rehearse restores on a **disposable**
  PostgreSQL server (`restore-rehearsal.sh` refuses any server that hosts
  other databases, including production); see `docs/RUNBOOK.md`.

## 6. What was actually verified (locally, PostgreSQL 16, no Docker daemon)

* **Integration suite:** all 111 tests pass (99 at a290196, plus 12 for the
  constrained Hermes adapter; see `docs/HERMES.md`). This includes:
  * the startup gate (unsafe roles refused before any migration, RLS
    tampering detected, pending/modified/unknown migrations refused);
  * advisory-lock serialization (4 concurrent runners, lock waiting,
    release on failure).
  * Mutation checks: removing the lock, the role check or the RLS check makes
    those tests fail.
* **Role rehearsal on a fresh database:**
  * `provision-roles.sql` via the init script.
  * Two concurrent `cli.js up` processes: one applied the migrations, the
    other waited and found nothing to do. Tables are owned by `genie_owner`.
  * genie-core started as `genie_app` (`MIGRATE_ON_BOOT=false`). Production
    boots were **refused** for a superuser, for `genie_backup` (BYPASSRLS), for
    an unmigrated database, and for `genie_app` with migrate-on-boot on (the
    error explains how to fix it).
  * `genie_app` cannot create, alter or drop tables, and RLS denies its writes
    without tenant context.
  * The audited bootstrap works as `genie_app`.
  * `genie_backup` dumped data from all 15 tables.
* **Option A rehearsal:** a stand-in Node proxy (nginx/Traefik not available
  here) forwarding `/api/*` unchanged.
  * Live 200; ready 503 (Hermes unavailable).
  * Login cookies: host-only, `Secure`, `HttpOnly`.
  * Exact-origin allowlist: `https://api.genie.readyqr.com`, `http://…`, a
    sibling subdomain and a suffix look-alike are all refused.
  * No CORS headers, including on preflight.
  * CSRF enforced through the proxy.
  * Rate-limit buckets keyed on the real client through the `X-Forwarded-For`
    chain.
  * Bootstrap refuses a second run.
  * Pricing dry run fails safely ("nothing written") without network.
* **Dockerfile:** `.dockerignore` checked with Docker's matching rules against
  the real tree (planted `.env`, `.env.test`, `dist`, uploads, backup dump and
  `node_modules` all excluded; all 113 needed files kept).
  * The Dockerfile's exact install, build and prune steps replayed on that
    filtered context. The combined-workspace variant was replayed with a
    stand-in `apps/web`: scoped install and prune keep web and dev
    dependencies out.
  * The resulting runtime layout booted in production mode.
* **Compose:** `docker compose config` validates and resolves the API to
  `genie_app`, migrations to `genie_owner`, with migrate-then-start ordering.
* **Not verified:** a real `docker build`/`docker run` (no Docker daemon
  here), real nginx/Traefik, Coolify itself, TLS, the real OpenRouter feed,
  and anything on VPS 2.
