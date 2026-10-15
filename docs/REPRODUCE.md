# Reproducing the backend checks from a source archive

Self-contained steps to verify a sanitized archive and run every check the
backend handoff reports. Nothing here deploys, contacts Hermes or a model
provider, or needs a real secret: the test values below are generated locally
and thrown away.

## Requirements
* Node.js `>=22.12 <23` (the repo's `engines`; verified with 22.22.0, npm 10.9.4).
* PostgreSQL 16 server you can administer, used **only** for a disposable test
  database. The suite truncates every table between files.
* `openssl`, `sha256sum`, `tar`.
* Python 3.11+ with PyYAML or ruamel.yaml, for the offline Hermes audit tests.
* Network access to the npm registry, for `npm ci`.

## 1. Verify and unpack the archive
```bash
sha256sum -c <<'EOF'
<sha256 from the handoff>  genie-<commit>-source.tar.gz
EOF
tar -xzf genie-<commit>-source.tar.gz
cd genie-<commit>
```
The archive is `git archive` of the commit: tracked files only. It has no
`.env`, `node_modules`, `dist`, dumps or keys.

## 2. Create a disposable test database and role
The test role must **not** be a superuser or BYPASSRLS; a test asserts this.
```bash
TEST_DB_PW="$(openssl rand -hex 16)"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE genie LOGIN PASSWORD '$TEST_DB_PW' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE"
sudo -u postgres createdb -O genie genie_test
```
If a `genie` role already exists for something else, pick another role and
database name and adjust `DATABASE_URL` below.

## 3. Test environment (`apps/api/.env.test`, gitignored)
```bash
sed -e "s#postgres://genie:CHANGE_ME@localhost:5432/genie_test#postgres://genie:${TEST_DB_PW}@localhost:5432/genie_test#" \
    -e "s#^SESSION_COOKIE_SECRET=.*#SESSION_COOKIE_SECRET=$(openssl rand -hex 32)#" \
    -e "s#^CREDENTIAL_ENCRYPTION_KEY=.*#CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)#" \
    apps/api/.env.test.example > apps/api/.env.test
grep -c CHANGE_ME apps/api/.env.test   # expect 0
```

## 4. Install, build and check
```bash
npm ci
npm run build                     # contracts + api (tsc)
npm run lint                      # tsc --noEmit
npm test                          # integration suite, serial
npx --yes @redocly/cli@2.62.1 lint packages/contracts/openapi.yaml
npm audit                         # expect: found 0 vulnerabilities
bash -n infra/scripts/*.sh infra/db-init/*.sh
npm run test:hermes-audit         # offline Hermes profile audit, python3 + PyYAML or ruamel.yaml
npx --yes @redocly/cli@2.62.1 lint --config packages/contracts/redocly.yaml docs/proposals/agent-factory.openapi.yaml
```
Expected at the handoff commit:
* integration suite: `# tests 116`, `# pass 116`, `# fail 0`;
* audit tests: `Ran 28 tests … OK`.

Run one file:
```bash
cd apps/api
node --env-file=.env.test --import tsx --test --test-concurrency=1 test/integration/hermesAdapter.test.ts
```

## 5. Optional: backup and restore rehearsal on throwaway servers
This needs two **separate** PostgreSQL servers you can delete afterwards: a
source, and a disposable target. `docs/RUNBOOK.md` → "Backups and restore
rehearsal" has the commands. `restore-rehearsal.sh` refuses any target server
that holds other databases.

## 6. Clean up
```bash
sudo -u postgres dropdb genie_test
sudo -u postgres psql -c "DROP ROLE genie"
rm apps/api/.env.test
```

## What these checks do not cover
* No container build: there was no Docker daemon in the authoring environment.
* No real Hermes, VPS 2, reverse proxy or Coolify.
* No live OpenRouter pricing feed (blocked by the authoring environment's
  network policy).

See `docs/HERMES.md` and `docs/DEPLOYMENT.md` for the blockers.
