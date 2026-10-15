# Agent Factory: draft, template and owner-approval contract (proposal)

Status: **proposal for review.** Nothing is implemented, agreed or deployed.
It is backend-only, for a **separate private repository and service**
(`genie-agent-factory`, planned host `factory.genie.readyqr.com` behind
authenticated access; see `docs/AGENT-DOMAINS.md`). It defines no live
activation, provisioning, deployment, DNS or credential handling.

Machine-readable draft: `docs/proposals/agent-factory.openapi.yaml`
(OpenAPI 3.1; lints clean with the same Redocly rules as the Genie contract).

## Where it fits

* **Genie is the central assistant** ("Jarvis"). genie-core (this repository)
  stays the system of record for tenants, members, roles, provider connections,
  approvals and audit history.
* **Build order** (owner): Voice (`genie-voice`), then Agent Factory, then
  Marketing (`genie-marketing`). The factory comes before Marketing so that
  Marketing becomes the factory's first real template, rather than a one-off
  that the factory later has to absorb.
* **The Agent Factory turns a reviewed template into a tenant-specific agent
  specification that the tenant owner approves.** In this phase it stops
  there. An approved draft is an approved *specification*. It is not a
  running agent, a Genie `Agent` record, a container, a hostname or a key.

## Non-goals in this phase

* No activation, provisioning, deployment, Coolify, DNS, TLS or repository
  creation. There is no endpoint for any of them, on purpose.
* No credentials: drafts may reference a Genie provider connection id, never a
  key.
* No tools: the only capability in v0.1 is text `chat`. Web, files, terminal,
  email, publishing and payments are later extensions, each separately
  approved.
* No paid models: templates are free-only (`modelPolicy.freeOnly: true`), with
  verified-free OpenRouter ids that Genie's free-first policy re-checks at run
  time.
* No frontend: the approval screen belongs to AI Studio once the contract is
  agreed.

## Objects

**AgentTemplate** (published, immutable, versioned with semver)
* `slug`: `genie-<name>`, from the domain map, e.g. `genie-marketing`.
* `purpose`.
* `capabilities`: an allowlisted enum; v0.1 is `[chat]`.
* `modelPolicy`: `freeOnly: true` and 1–5 `allowedModelIds`.
* `dataScopes`: an allowlisted enum of tenant-scoped reads: `tenant_profile`,
  `websites`, `own_tasks`.
* Typed `parameters`, with no free-form code or prompts that execute anything.
* `plannedHostname`: a planned name only.
* `requiresOwnerApproval: true` (constant).
* `templateDigest`: the SHA-256 of the canonical template.

A changed template is a new version. Drafts pin `templateId`, `templateVersion`
and `templateDigest`.

**AgentDraft** (tenant-scoped)
* Created from one template version, with parameter values, a `modelId` from
  the template's allowlist, and an optional `providerConnectionId` reference.
* Carries `digest`, the current approval digest, recomputed on every edit.

## Lifecycle

```
draft ──submit──▶ awaiting_owner_approval ──approve──▶ approved   (terminal in this phase)
  ▲  (edit only here)        │ ──reject──▶ rejected   (terminal; edit = new draft)
  │                          └ ──7 days──▶ expired    (terminal; resubmit = new approval)
```

* `PATCH` is allowed only in `draft` status; otherwise it returns `409
  draft_not_editable`.
* `submit` freezes the draft and creates one pending approval, which expires
  after 7 days.
* An `approved` draft can never be edited. Changing anything means a new draft
  and a new approval.

## Owner-approval contract

This mirrors Genie's task approvals (`docs/FRONTEND_HANDOFF.md`, "Approval
digest"), including their versioning rule: changing the bound fields or the
canonicalization needs a new `digestVersion`, never a silent change.

1. **Who.** Only a tenant **owner** may decide. Admins may create, edit and
   submit drafts. Operators and viewers may read. Membership and role are
   re-checked on every request, for the `tenantId` in the URL.
2. **What is bound** (`digestVersion: 1`). The SHA-256 of Genie canonical JSON
   format v1 (keys sorted recursively, `__proto__` kept, `JSON.stringify` of
   the result) over:
   ```json
   { "v": 1, "kind": "agent-draft",
     "tenantId": "…", "draftId": "…",
     "templateId": "…", "templateVersion": "0.1.0", "templateDigest": "…",
     "name": "…", "parameters": { … }, "modelId": "openrouter/…:free",
     "providerConnectionId": "… or null",
     "capabilities": ["chat"], "dataScopes": ["…"], "plannedHostname": "… or null" }
   ```
   The capabilities, scopes and hostname are copied from the pinned template
   version into the digest, so the owner approves them explicitly.
3. **Echo.** The decision request must include the `digest` the owner was
   shown. If it no longer matches the stored draft, the server returns `409
   approval_payload_mismatch`.
4. **Immutable.** One decision per approval. A second decision returns `409
   approval_already_decided`; an expired approval returns `409
   approval_expired`.
5. **Server-side re-check at decision time.** The template version is still
   published with the same `templateDigest`. The `modelId` is in the template's
   allowlist and, through Genie, currently passes the free-first policy. The
   `providerConnectionId`, if any, belongs to this tenant and is active.
6. **Effect.** The status becomes `approved` and an audit event is written.
   Nothing else happens. A later activation contract must re-verify the
   digest, exactly as Genie's dispatch gate re-verifies task approvals, before
   it acts on an approved draft.

## Audit events (in the factory's own append-only log)

`template.published`, `draft.created`, `draft.updated`, `draft.submitted`,
`draft.approved`, `draft.rejected` and `draft.expired`. Each carries the actor,
the tenant, the draft and template ids, and the digest. None carries a
parameter value that a template marks sensitive, and none carries a credential.

## Security invariants for the future implementation

* **Tenant isolation as in genie-core.** Every row carries `tenant_id`; RLS
  with FORCE; the runtime role is not a superuser and not BYPASSRLS;
  cross-tenant ID tampering returns 404. Templates are global and read-only to
  tenants.
* **Only enums are executable.** No template field is interpreted as code,
  shell, URL to fetch or prompt to run during drafting or approval.
* **No secrets.** No secrets in templates, drafts, fixtures, logs or audit
  metadata. Credentials stay in genie-core, encrypted, and are referenced by
  id.
* **Same web defences.** Session cookie host-only, CSRF header on writes, a
  strict `Origin` allowlist, rate limits on auth.
* **Free-first.** `modelPolicy.freeOnly` is constant `true` in v0.1. A paid
  model requires a new template schema version and a separate owner decision.

## Open decisions (owner, Codex, AI Studio)

1. **Auth and origin.** Option A puts the factory behind the same-origin
   proxy on `genie.readyqr.com`, for example `/factory-api/*`, reusing Genie
   sessions through a server-to-server check. Option B gives it its own login.
   This mirrors the open browser-origin decision in `docs/AGENT-DOMAINS.md`.
2. **Membership source.** Either the factory asks genie-core (a new,
   agreed, read-only endpoint), or it keeps its own copy. The proposal assumes
   genie-core stays the source of truth.
3. **Template authorship.** Who may publish templates: platform administrators
   only (proposed), never tenants in v0.1.
4. **First templates.** Proposed: `genie-voice` support templates (once Voice
   exists) and `genie-marketing` 0.1.0 (text-only copy drafting, as in the
   OpenAPI example).
5. **Activation, later and separately.** Mapping an approved draft to a Genie
   `Agent` record and, much later, to a service on VPS 2. Each step is its own
   contract and its own owner approval.
