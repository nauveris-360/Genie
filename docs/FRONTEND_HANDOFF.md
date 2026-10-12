# Genie V3 API v1 — frontend integration handoff

For AI Studio (apps/web) and Codex reconciliation. Source of truth is
`packages/contracts/openapi.yaml`; the TypeScript mirror is
`packages/contracts/src/{types,permissions}.ts` (`@genie/contracts`), and safe
example payloads for every endpoint are in `packages/contracts/fixtures/*.json`.
If this page and the YAML ever disagree, the YAML wins — tell us.

Status: backend implemented and integration-tested (89 tests) against
PostgreSQL 16 with a **mock** agent adapter. Hermes is **not** integrated
(readiness reports it `unavailable`). There is **no pricing-verification job
yet, so in a real deployment every model is refused** (`409
model_not_allowed`) — that is intended fail-closed behaviour, not a bug. n8n
execution, provider usage/quota figures, email, voice, SEO, publishing and
billing are not implemented. Nothing is deployed.

## Changes since the first handoff
* `POST /auth/login` is rate limited → `429 rate_limited` with `Retry-After`
  header and `error.retryAfterSeconds`.
* `ErrorEnvelope.error.retryAfterSeconds?: number` (only on 429).
* `Model.verificationSource: 'seed' | 'trusted'` (new, required).
  `Model.pricingStatus` is now the *effective* status: `seed` rows report
  `unknown`; trusted rows older than 72 h report `stale`. Prices and
  `lastVerifiedAt` are `null` unless `trusted`. `usage` is always present and `null`.
* Approve no longer guarantees execution: the model policy, agent and provider
  are re-checked immediately before dispatch, and a task can end `failed` with
  `error` starting `Blocked before dispatch:` (see semantics §5).
* `payloadDigest` canonicalization now keeps JSON `"__proto__"` keys (they were
  silently dropped); the format is otherwise unchanged (§ "Approval digest").
* Every authenticated state-changing operation in `openapi.yaml` now declares
  `security: [{ cookieAuth, csrfHeader }]` (behaviour unchanged).
* JSON bodies containing a `"__proto__"` key or a `"constructor": {"prototype": …}`
  member anywhere are rejected with `400 validation_error`, never stripped.

### New in this round (screens to build)
* **Members and invitations** (§ "Members and invitations"): six endpoints,
  `Member` / `Invitation` entities, permissions `member:read` / `member:manage`,
  helper `canManageRole(actorRole, targetRole)` in `@genie/contracts`, error codes
  `already_member`, `last_owner`, `invitation_invalid`, and a public
  accept-invitation page.
* **`Approval.digestVersion: 1 | 2`** (new, required). New approvals are v2 and
  also bind the agent's model, provider connection and config: editing those
  after a task was submitted makes the approval fail with `409
  approval_payload_mismatch`. Name and description edits do not.
* **Models become usable** once an owner approves a model in
  `apps/api/config/approved-models.json` and the server-side pricing sync runs.
  Until then every model still shows `allowed: false`.

## Transport conventions

| Thing | Value |
| --- | --- |
| Base path | `/api/v1` (same origin as the API; no public host published) |
| IDs | UUID v4 strings |
| Timestamps | UTC ISO-8601 with `Z` (`2026-10-12T03:00:00.000Z`) |
| Single resource | `{ "data": <resource> }` |
| List | `{ "data": [...], "page": { "nextCursor": string \| null } }` |
| Error | `{ "error": { "code", "message", "requestId", "retryAfterSeconds"? } }` — never a stack trace |
| Task submit success | `202` with the **full persisted Task** in `data` |
| Create success | `201`; other writes `200` |

### Pagination
Query `?limit=1..100` (default 20) and `?cursor=<opaque>` taken verbatim from
the previous `page.nextCursor`. Lists are newest-first and stable under inserts.
An invalid `cursor`/`limit` → `400 validation_error`. Tasks and approvals also
accept `?status=<enum>`. `GET …/models` and `GET …/providers` return the full
set (`providers` includes `page.nextCursor: null`; `models` has no `page`).

### Auth: cookies, CSRF, Origin
* Session cookie `genie_sid` — HttpOnly, SameSite=Lax, Secure in production,
  Path=/. Opaque; the server stores only a hash. **Never read or store it in JS.**
* CSRF cookie `genie_csrf` — same attributes but **not** HttpOnly so the SPA can
  read it. Send its value as header `X-CSRF-Token` on every `POST/PUT/PATCH/DELETE`
  except `POST /auth/login`. Missing/mismatched → `403 csrf_mismatch`.
* **Origin**: every state-changing request, *including login*, must carry an
  `Origin` (browsers do this automatically for `fetch`) in the server's
  `ALLOWED_ORIGINS` allowlist; otherwise `403 forbidden` ("Request origin is not
  trusted"). `Referer` is accepted as a fallback. This is the login-CSRF defense.
  Use `fetch(..., { credentials: 'include' })`.
* Logout clears both cookies and deletes the server session. Sessions survive
  API restarts (they are DB rows). `401 unauthorized` means "sign in"; after a
  `401` on `/auth/me` treat the user as signed out.
* No tokens in `localStorage`/`sessionStorage`, ever.

### Login rate limiting (what the sign-in screen must handle)
* Only **failed** attempts count, per 15-minute window: 5 per (client address,
  account) and 20 per client address. A successful sign-in costs nothing.
* On `429 rate_limited`: show the generic message, disable submit, and count
  down from `Retry-After` (header) / `error.retryAfterSeconds` (same value,
  seconds). Do not retry automatically.
* The 429 is identical for wrong/unknown accounts and for per-address vs
  per-account limits, and a **correct** password is also refused while
  limited. Do not tell users "your account is locked": it isn't. There is no
  account-wide lockout; signing in from another network works normally.
* `401 invalid_credentials` message is the same for unknown email and bad
  password; keep it that way in the UI.

## Permission matrix (server-enforced; UI gating is cosmetic)

The role comes from the caller's **membership row for the `tenantId` in the URL**.
No membership → `404 not_found` (indistinguishable from a missing tenant). Wrong
role → `403 forbidden`. Any signed-in user may `POST /tenants` and becomes its owner.

| Permission | owner | admin | operator | viewer | Endpoints |
| --- | :-: | :-: | :-: | :-: | --- |
| tenant:read | ✓ | ✓ | ✓ | ✓ | `GET /tenants`, `GET /auth/me` |
| website:read | ✓ | ✓ | ✓ | ✓ | `GET …/websites` |
| website:write | ✓ | ✓ | ✓ | – | `POST …/websites`, `PATCH …/websites/{id}` |
| agent:read | ✓ | ✓ | ✓ | ✓ | `GET …/agents` |
| agent:write | ✓ | ✓ | ✓ | – | `POST …/agents`, `PATCH …/agents/{id}` |
| provider:read | ✓ | ✓ | ✓ | ✓ | `GET …/providers` (metadata only) |
| provider:write | ✓ | ✓ | – | – | `POST …/providers` |
| modelPolicy:read | ✓ | ✓ | ✓ | ✓ | `GET …/model-policy`, `GET …/models` |
| modelPolicy:write | ✓ | ✓ | – | – | `PUT …/model-policy` |
| task:read | ✓ | ✓ | ✓ | ✓ | `GET …/tasks`, `GET …/tasks/{id}` |
| task:submit | ✓ | ✓ | ✓ | – | `POST …/tasks` |
| task:cancel | ✓ | ✓ | ✓ | – | `POST …/tasks/{id}/cancel` |
| approval:read | ✓ | ✓ | ✓ | ✓ | `GET …/approvals` |
| approval:decide | ✓ | ✓ | – | – | `POST …/approvals/{id}/decision` |
| auditEvent:read | ✓ | ✓ | ✓ | ✓ | `GET …/audit-events` |
| member:read | ✓ | ✓ | ✓ | ✓ | `GET …/members` |
| member:manage | ✓ | ✓\* | – | – | `PATCH`/`DELETE …/members/{membershipId}`, `GET`/`POST …/invitations`, `POST …/invitations/{id}/revoke` |

\* Admins may only invite, change or remove **operators and viewers**, and only
assign those two roles (`MANAGEABLE_ROLES` / `canManageRole`). Owners may do
anything, except that no change may leave the tenant without an owner.
`POST /invitations/accept` is public (see below).

`…` = `/tenants/{tenantId}`. Import `PERMISSION_ROLES` / `roleHasPermission`
from `@genie/contracts` to drive UI affordances; the backend re-checks regardless.
The very first owner is still created by the private bootstrap CLI. Everyone
else joins through invitations.

## Entities (exact response fields)

```ts
User        { id, email, displayName, createdAt }
Membership  { id, tenantId, tenantName, role, createdAt }
AuthMe      { user: User, memberships: Membership[] }
Tenant      { id, name, slug, role, createdAt, updatedAt }            // role = caller's role
Website     { id, tenantId, label, url, status: 'active'|'archived', createdAt, updatedAt }
Agent       { id, tenantId, name, description: string|null, status: 'active'|'disabled',
              providerConnectionId, modelId, requiresApproval: boolean, config: object,
              createdAt, updatedAt }
ProviderConnection { id, tenantId, provider: 'openrouter'|'gemini', label,
              credentialStatus: 'present'|'missing', createdAt, updatedAt }   // never the credential
Model       { modelId, provider, displayName,
              pricingStatus: 'verified_free'|'paid'|'unknown'|'stale',   // effective status
              verificationSource: 'seed'|'trusted',
              allowed: boolean,
              inputPricePerMillionTokensUsd: number|null,    // null unless trusted
              outputPricePerMillionTokensUsd: number|null,   // null unless trusted
              lastVerifiedAt: string|null,                   // null unless trusted
              usage: null }                                  // no usage integration yet
ModelPolicy { tenantId, allowPaidFallback: boolean, updatedAt, updatedBy: uuid|null }
Task        { id, tenantId, websiteId: uuid|null, agentId,
              type: 'chat'|'summarize'|'embed'|'title_generate',
              status: 'queued'|'running'|'awaiting_approval'|'succeeded'|'failed'|'cancelled',
              input: object, result: object|null, error: string|null, idempotencyKey,
              approvalId: uuid|null, createdBy, createdAt, updatedAt }
Approval    { id, tenantId, taskId, action: 'task.execute', payloadDigest: sha256hex,
              digestVersion: 1|2,
              status: 'pending'|'approved'|'rejected'|'expired', decidedBy: uuid|null,
              decidedAt: string|null, reason: string|null, expiresAt, createdAt }
Member      { id /* membershipId */, tenantId, userId, email, displayName, role, createdAt }
Invitation  { id, tenantId, email, role, status: 'pending'|'accepted'|'revoked'|'expired',
              invitedBy: uuid, expiresAt, acceptedAt: string|null, createdAt }   // never the token
CreateInvitationResponse { invitation: Invitation, inviteToken: string }      // token shown ONCE
AuditEvent  { id, tenantId, actorUserId: uuid|null, action, targetType, targetId, metadata: object, createdAt }
Readiness   { data: { status:'ok'|'degraded', checks: { database: {status, detail?}, agentAdapter: {status, detail?} } } }
```

Render `usage: null` as "not reported". Never show a remaining balance.
Render `verificationSource: 'seed'` as "pricing not verified" and never show
its prices (they are `null`).

## Request payloads

| Call | Body / headers |
| --- | --- |
| `POST /auth/login` | `{ email, password }` → 200 `AuthMe` + both cookies. 401 `invalid_credentials`. 429 `rate_limited` + `Retry-After`. |
| `POST /auth/logout` | none |
| `POST /tenants` | `{ name }` (1–200) |
| `POST …/websites` | `{ label, url }` (url must be absolute) |
| `PATCH …/websites/{id}` | any of `{ label, url, status }`, ≥1 field |
| `POST …/agents` | `{ name, providerConnectionId, modelId, description?, requiresApproval? = true, config? }` |
| `PATCH …/agents/{id}` | any of `{ name, description, status, providerConnectionId, modelId, requiresApproval, config }` |
| `POST …/providers` | `{ provider, label, credential }` — `credential` is write-only; 201 returns metadata only. Only on an explicit user action; never prefilled; never in demo mode. |
| `PUT …/model-policy` | `{ allowPaidFallback }` — enabling is an explicit, audited owner/admin act. |
| `POST …/tasks` | header **`Idempotency-Key`** (required, 1–200 chars; generate a UUID per user intent and reuse it on retry) + `{ agentId, type, input: object, websiteId? }` |
| `POST …/tasks/{id}/cancel` | none |
| `POST …/approvals/{id}/decision` | `{ decision: 'approve'\|'reject', reason? }` |
| `PATCH …/members/{membershipId}` | `{ role }` |
| `DELETE …/members/{membershipId}` | none → `{ data: { success: true } }` |
| `POST …/invitations` | `{ email, role }` → 201 `{ invitation, inviteToken }` |
| `POST …/invitations/{id}/revoke` | none → the `Invitation` (idempotent) |
| `POST /invitations/accept` | `{ token, password?, displayName? }` → 200 `AuthMe` (see flows below) |

## Error codes to handle

`validation_error`(400) · `unauthorized`(401) · `invalid_credentials`(401) ·
`forbidden`(403, also untrusted Origin) · `csrf_mismatch`(403) · `not_found`(404) ·
`idempotency_key_conflict`(409) · `model_not_allowed`(409) · `approval_expired`(409) ·
`approval_payload_mismatch`(409) · `approval_already_decided`(409) ·
`task_not_cancellable`(409) · `already_member`(409) · `last_owner`(409) ·
`invitation_invalid`(400) · `rate_limited`(429, with `retryAfterSeconds`) ·
`internal_error`(500). Always surface `requestId` in error UI.

## Members and invitations

**Members page** (`GET …/members`, any role): list `email`, `displayName`,
`role`. Show role controls only where `canManageRole(myRole, member.role)` is
true, and in the role picker offer only roles where `canManageRole(myRole, r)`
is true. Handle `409 last_owner` with "A workspace must keep at least one
owner". Removing a member takes effect on their next request.

**Invite** (`POST …/invitations`, owners and admins): the response's
`inviteToken` appears **only once**. Build the link immediately, for example
`https://<app-origin>/accept-invite#token=<inviteToken>`. A URL fragment keeps
the token out of server logs and `Referer` headers. Show it with a copy button
and a clear warning: "Anyone with this link can join as <role>. It expires on
<expiresAt>. Send it directly to the person." **No email is sent.** The
invitation list (`GET …/invitations`) never includes tokens. A lost link
cannot be shown again: revoke it and invite again (a new invite for the same
email automatically revokes the previous one).

**Accept-invite page** (public route): read the token from the fragment, then:
1. If the user is **signed in**, call `POST /invitations/accept { token }`
   with the usual `X-CSRF-Token` header.
   * 200 → show the new workspace (the body is the updated `AuthMe`).
   * 403 `forbidden` → "This invitation is for a different account. Sign out
     and open the link again."
2. If the user is **not signed in**, show a form (display name and password, 12+
   characters) and call `POST /invitations/accept { token, password, displayName }`.
   * 200 → the account was created, cookies are set, and the user is signed in.
   * 401 `unauthorized` → the email already has an account: "Sign in to accept",
     then retry step 1 after login with the same token.
3. 400 `invitation_invalid` → "This invitation link is invalid or has expired.
   Ask for a new one." The same message covers unknown, used, revoked and
   expired links, so don't try to tell them apart.
4. 409 `already_member` → open the workspace. 429 → countdown from `Retry-After`.

The accept call is Origin-checked like login and rate limited per address.

## Task & approval semantics

1. `POST …/tasks` validates agent ∈ tenant, website ∈ tenant, and the agent's
   `modelId` against the tenant's **free-first policy at submit time** (every
   `type`, including `embed`/`title_generate`/`summarize`). Disallowed → `409
   model_not_allowed`, no task row is created. A model that was allowed when
   the agent was created can become disallowed later (policy tightened or
   pricing went stale); surface the message, don't hide the agent.
2. Same `Idempotency-Key` + identical body → `202` with the **original** task
   (same `id`); same key + different body → `409 idempotency_key_conflict`.
3. If `agent.requiresApproval` is `true` (default), the task is persisted as
   `awaiting_approval` with `approvalId` set and a `pending` Approval bound to a
   SHA-256 digest (v2: the task payload plus the agent's model, provider
   connection and config; see below) and a 60-minute `expiresAt`. Nothing
   reaches the model before approval. If someone edits the agent's model,
   connection or config before the decision, approving returns `409
   approval_payload_mismatch`: show "The agent changed after this request;
   submit the task again".
4. If `requiresApproval` is `false`, the task runs synchronously through the
   adapter inside the same request; the 202 body already shows the final status
   (`succeeded`/`failed`). With Hermes not integrated, a production-configured
   API returns `failed` with a visible error, never a fake result. **Poll
   `GET …/tasks/{id}` anyway** — the contract allows `queued`/`running`.
5. Approve → decision recorded (immutable, `decidedBy/At` set) → task runs →
   `succeeded`/`failed`. Reject → task `cancelled`, `error = "rejected: <reason>"`.
   Immediately before any adapter call the server re-checks, against current
   state: the agent and its provider connection still exist in this tenant, the
   agent is `active`, the agent's **current** model passes the tenant's
   **current** free-first policy (with current verified pricing, for this task's
   `type`), and the model's provider matches the connection. If any check fails
   the decision stays `approved` (`200`), but the task becomes `failed` with
   `error` beginning `Blocked before dispatch:` and a `task.dispatch_blocked`
   audit event; no model call is made and the task never runs later. Show the
   approval as approved **and** the task error; to proceed, fix the cause and
   submit a new task.
6. Replay of a decided approval → `409 approval_already_decided`. Any change to
   the task payload after creation → `409 approval_payload_mismatch` (approval
   stays `pending`, task stays `awaiting_approval`). Past `expiresAt` → `409
   approval_expired` and the row flips to `expired`.
7. Cancel is allowed from `queued`/`running`/`awaiting_approval` (expires any
   pending approval) and is idempotent on `cancelled`; on `succeeded`/`failed` → `409`.
8. Every action above writes an AuditEvent (`task.submitted`, `approval.requested`,
   `approval.decided`, `approval.expired`, `task.dispatch_blocked`,
   `task.succeeded|failed|cancelled`, `provider.credential_saved`,
   `model_policy.updated`, `website.*`, `agent.*`, `tenant.created`,
   `member.role_changed`, `member.removed`, `member.joined`, `invitation.created`,
   `invitation.revoked`, `invitation.accepted`). Metadata is redacted server-side.

### Approval digest (`payloadDigest`) — versions 1 and 2
You should not need to compute it (the server binds and checks it). If you do,
pick the object by `approval.digestVersion`:

1. Object:
   * **v1** (approvals created before this release):
     `{ tenantId, agentId, type, input, websiteId }` from the stored task.
   * **v2** (all new approvals): the v1 fields plus `v: 2` and
     `agent: { modelId, providerConnectionId, config }`, with the agent's values
     **at the time the task was submitted**.

   `websiteId` is `null` when absent, never omitted. Use `input` as returned by
   `GET …/tasks/{id}`.
2. Recursively rebuild every object with its own keys inserted in
   `Object.keys(o).sort()` order (arrays keep their order), creating keys with
   `Object.fromEntries` (or a null-prototype accumulator) so a `"__proto__"` key
   is kept as data. Do **not** use `out[key] = …` on a `{}` accumulator.
3. `JSON.stringify` the result (no whitespace) and SHA-256 it (lowercase hex).

Because JS objects enumerate array-index keys (`"0"` … `"4294967294"`) first in
ascending numeric order, the emitted key order is: array-index keys
numerically, then every other key (including `"-1"`, `"01"`, `"1.5"`,
`"4294967295"`, `"__proto__"`) in UTF-16 code-unit order. Reference vectors:

```
{"agentId":"77777777-7777-4777-8777-777777777771","input":{"options":{"a":1,"b":2},"prompt":"Post this reply to the live ticket."},"tenantId":"44444444-4444-4444-8444-444444444444","type":"chat","websiteId":null}
→ 13a3614698b7a3f721234f372b8ee6a0d59afb6b5a7d59053b7fa4e6151dfffd

{"agentId":"77777777-7777-4777-8777-777777777771","input":{"9":"nine","10":"ten","a":1,"b":[{"1":"y","2":"x"}],"prompt":"p"},"tenantId":"44444444-4444-4444-8444-444444444444","type":"chat","websiteId":null}
→ fc6a6b8127eff2f4542fd0ecf38298b170b28aef81fa5e95d031c714a31065e3

v2:
{"agent":{"config":{"tone":"formal"},"modelId":"openrouter/example-model:free","providerConnectionId":"66666666-6666-4666-8666-666666666661"},"agentId":"77777777-7777-4777-8777-777777777771","input":{"options":{"a":1,"b":2},"prompt":"Post this reply to the live ticket."},"tenantId":"44444444-4444-4444-8444-444444444444","type":"chat","v":2,"websiteId":null}
→ 11fc72f9537a257e3ab4477ecf289e62b6bc4c561e3c2fc39db3d72d3096e25f
```

## Free-first policy (what the UI should expect)

`allowPaidFallback` defaults to **false** per tenant and is never flipped by
the backend. `GET …/models` returns every registry row with `allowed` computed
for the tenant:

| verificationSource | effective pricingStatus | allowed (fallback off) | allowed (fallback on) |
| --- | --- | :-: | :-: |
| `seed` | `unknown` (always) | ✗ | ✗ |
| `trusted` | `verified_free` (zero input **and** output price, ≤72 h old) | ✓ | ✓ |
| `trusted` | `paid` (≤72 h old) | ✗ | ✓ |
| `trusted` | `unknown` | ✗ | ✗ |
| `trusted` | `stale` (explicitly, or older than 72 h) | ✗ | ✗ |

The `:free` suffix in a model id carries no weight. Only a server-side
verification job can mark a row `trusted`; no API call can. None exists yet,
so today every real model shows `allowed: false`. The agent model picker
should list all rows, disable the not-allowed ones, and explain why using
`pricingStatus`/`verificationSource`.

## Health
`GET /health/live` → `200 {data:{status:'ok'}}`. `GET /health/ready` → `200` or
`503 degraded` with per-dependency `checks`; today `agentAdapter` is
`unavailable` until Codex verifies a Hermes programmatic interface. Show that
state honestly in Integrations/Overview; do not label execution as available.

## Demo mode
Keep demo fixtures isolated and labelled; never accept a credential in demo
mode. In real mode call these endpoints only; where a capability is not
implemented (usage, Hermes execution, n8n, pricing verification), show it as
unavailable.
