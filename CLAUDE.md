# Genie V3: project memory

## Ownership (do not cross without agreement)
* Claude Code: `apps/api` (backend), `packages/contracts` (OpenAPI + shared types), database migrations.
* AI Studio: the frontend (`apps/web`, not in this repo). Never edit frontend files.
* Codex: integration coordination and the Hermes adapter (`apps/api/src/adapters/HermesAdapter.ts` stays an honest "unavailable" stub until Codex verifies a programmatic interface).
* Contract changes (`packages/contracts/openapi.yaml`, `src/types.ts`) are agreed with AI Studio/Codex and recorded in `docs/FRONTEND_HANDOFF.md`.

## Standing constraints
* No deployment, DNS/infrastructure changes, provider-account changes, secret entry or paid API calls without explicit owner approval for that specific step. A public Genie test is authorized, but each deployment step still needs approval.
* Never touch VPS 1 (production websites, n8n). New Genie services go on VPS 2, managed by Coolify.
* Keep genie-hermes, genie-infra and genie-agent-factory private or behind authenticated access.
* Pushes go to the working branch only; no pull request unless asked. The repo has no `main` branch yet.

## Planned domains
See `docs/AGENT-DOMAINS.md` (planned names, not provisioned). This repo's backend is **genie-core → api.genie.readyqr.com**; the UI is **genie-command → genie.readyqr.com**. The browser-origin decision (same-origin proxy vs CORS) is still open: see that file. Never set cookie `Domain` to a parent domain.

## Working here
* `npm ci && npm run build`; tests: `npm test` (needs `apps/api/.env.test` pointing at a disposable PostgreSQL 16 DB; the suite drops and recreates its schema).
* Migrations are `apps/api/src/migrations/NNN_*.up.sql` / `.down.sql`; never edit an applied one (checksummed), add a new number.
* Approval digests are versioned (`approvals.digest_version`); changing canonicalization or bound fields needs a new version, never a silent format change.
* Runbook: `docs/RUNBOOK.md`. Frontend contract guide: `docs/FRONTEND_HANDOFF.md`.
