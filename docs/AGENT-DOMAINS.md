# ReadyQR / Genie: agent domain and repository map

Status: **planned names only.** Recovered from the "Set Agent Memory" chat of
11 October 2026 and confirmed by the owner on 13 October 2026. Nothing here
says that DNS records, TLS certificates, repositories or Coolify services
exist. Codex keeps the same map as `docs/AGENT-DOMAINS.md` in the local
integration project; if the two copies ever differ, ask the owner which is
current rather than guessing.

This document does **not** authorize publishing, deploying, changing DNS or
infrastructure, or using paid APIs. A public test of Genie is authorized by the
owner, but each deployment step still needs its own explicit approval.

## Map

Root domain: `readyqr.com`

| Agent / repository | Planned public hostname |
| --- | --- |
| genie-command | genie.readyqr.com |
| genie-core | api.genie.readyqr.com |
| genie-developer | developer.genie.readyqr.com |
| genie-webmaster | webmaster.genie.readyqr.com |
| genie-seo | seo.genie.readyqr.com |
| genie-marketing | marketing.genie.readyqr.com |
| genie-commerce | commerce.genie.readyqr.com |
| genie-support | support.genie.readyqr.com |
| genie-analyst | analyst.genie.readyqr.com |
| genie-infra | infra.genie.readyqr.com |
| genie-voice | voice.genie.readyqr.com |
| genie-hermes | hermes.genie.readyqr.com |
| genie-agent-factory | factory.genie.readyqr.com |
| genie-agent-template | *(no public URL)* |
| Architect | *(no hostname confirmed yet)* |
| Security | *(no hostname confirmed yet)* |
| Verifier | *(no hostname confirmed yet)* |

Each independently deployable agent is intended to have its own **private**
Git repository and its own Coolify service.

## Standing constraints

* **VPS 1** production websites and n8n must keep running and must not be moved
  or reconfigured.
* **genie-hermes, genie-infra and genie-agent-factory** are management surfaces.
  Keep them private, or reachable only behind authenticated access, even though
  they have hostnames in the map. The Hermes adapter in particular must not be
  exposed publicly (see BUILD-SPEC.md).
* Hostnames, TLS and routing are chosen with the owner before deployment.

## How this repository relates to the map

This repository (`nauveris-360/Genie`) currently holds the backend
(`apps/api`) and the shared contract (`packages/contracts`). In the map, the
backend is **genie-core → api.genie.readyqr.com**, and the web UI that AI
Studio builds is presumably **genie-command → genie.readyqr.com**. Whether
this repository is later split or renamed to match the one-repository-per-agent
plan is an owner decision; nothing has been moved.

### Open decision: browser origin for genie-command → genie-core

The API as built assumes the browser app and the API are served from the
**same origin** (FRONTEND_HANDOFF.md: base path `/api/v1` on the app's origin).
Session and CSRF cookies are host-only, and the API sends no CORS headers. With
the app on `genie.readyqr.com` and the API on `api.genie.readyqr.com`, a
browser calling the API host directly would fail in two ways:

1. Cross-origin requests are blocked, because there is no CORS allowlist.
2. The app cannot read the CSRF cookie: it is host-only on
   `api.genie.readyqr.com`, so JavaScript on `genie.readyqr.com` never sees it,
   and every write would fail `403 csrf_mismatch`.

Options (owner and Codex to choose; not implemented):

* **A. Same-origin proxy (recommended, no API change).** `genie.readyqr.com`
  serves the app and reverse-proxies `/api/*` to genie-core.
  `api.genie.readyqr.com` remains genie-core's own hostname (for direct or
  service access), but the browser only ever talks to `genie.readyqr.com`.
  Then `ALLOWED_ORIGINS=https://genie.readyqr.com`, and `TRUSTED_PROXIES` is
  set to the proxy's address.
* **B. Direct cross-origin calls.** The API gains a strict CORS allowlist
  (`https://genie.readyqr.com` only, with credentials), returns the CSRF token
  in the login/me response so the app keeps it in memory, and keeps cookies
  host-only. This is a contract change and needs tests.

Whichever is chosen: **never** widen cookies to `Domain=.genie.readyqr.com` or
`Domain=.readyqr.com`. That would send Genie session cookies to every agent
subdomain in the map, including seo, marketing and the others.
