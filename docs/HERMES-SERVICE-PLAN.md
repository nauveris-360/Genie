# Hermes on VPS 2: private networking and service plan (proposal)

Status: **proposal only. Nothing here has been applied.** Every step below is
an infrastructure change on VPS 2 and needs the owner's approval for that
specific step. Hermes stays disabled in Genie (`HERMES_ENABLED=false`) until
the blockers in `docs/HERMES.md` are cleared.

Known state on 15 October 2026 (reported by Codex and the owner; not
independently checked from here):
* Hermes `v0.21.6+774.g835c3dd` is installed for the `hermes` account. The
  `readyqr` profile was created clean (`--no-alias --no-skills`).
* The profile's API server is disabled. There is no API key, no service and no
  listener.
* The owner saved a dedicated OpenRouter key with a $0 cap. The cap was not
  verified against the account.

## Goal

genie-core (a Coolify container on VPS 2) calls the Hermes API server of the
`readyqr` profile over a private path that nothing else can use:

* no public listener, no Traefik or Coolify route, no DNS name;
* no other container on the host can connect;
* the Hermes API key is known only to genie-core and the profile `.env`.

## Recommended design: host service plus a dedicated bridge network

```
genie-core container ──(genie-hermes bridge, 10.88.88.0/29)──▶ 10.88.88.1:8642  Hermes gateway (host, user hermes)
   10.88.88.2 (fixed)                                           bound to the bridge address only
other containers ──✗ (host firewall: 8642 only from 10.88.88.2)
internet ──✗ (no public bind, no route, provider firewall closed)
```

1. **Dedicated Docker network.** Pick a subnet that does not overlap anything
   on the host (Codex: check `docker network ls` / `ip route`). For example:
   ```bash
   docker network create --driver bridge --subnet 10.88.88.0/29 --gateway 10.88.88.1 \
     -o com.docker.network.bridge.name=br-genie-hermes genie-hermes
   ```
   The host owns `10.88.88.1` on `br-genie-hermes`. Attach **only** genie-core
   to it, with the fixed address `10.88.88.2`, as an extra network next to its
   Coolify network. Use Coolify's custom-network or compose `networks:`
   (`external: true`, `ipv4_address: 10.88.88.2`) mechanism; Codex to confirm
   the Coolify 4.4.6 way to attach an external network to the app.
2. **Hermes binds the bridge address only.** In the profile's 0600 `.env`:
   * `API_SERVER_ENABLED=true`
   * `API_SERVER_HOST=10.88.88.1`
   * `API_SERVER_PORT=8642`
   * `API_SERVER_KEY=<openssl rand -hex 32>`

   Never `0.0.0.0`, and never `API_SERVER_CORS_ORIGINS`. Hermes refuses to
   start without a strong key.
3. **Host firewall.** Containers reach a host address through the INPUT chain,
   so binding alone is not enough. Allow `tcp/8642` only from `10.88.88.2` on
   `br-genie-hermes`, and drop every other source. For example, with
   iptables-persistent or the equivalent nftables or ufw rules:
   ```bash
   iptables -A INPUT -i br-genie-hermes -s 10.88.88.2 -d 10.88.88.1 -p tcp --dport 8642 -j ACCEPT
   iptables -A INPUT -p tcp --dport 8642 -j DROP
   ```
   Keep the cloud-provider firewall closed for 8642.
4. **systemd service.** `infra/hermes/hermes-readyqr.service.example` is the
   reviewed template:
   * `User=hermes`, `ExecStart=<hermes> -p readyqr gateway`;
   * an **empty** `WorkingDirectory`, because Hermes injects context files from
     it into every system prompt;
   * no credential environment and no `EnvironmentFile`;
   * baseline hardening;
   * a bounded wait until `10.88.88.1` exists, since Docker creates the bridge.
5. **genie-core settings** (Coolify secrets; only once the owner approves
   enabling):

   | Setting | Value |
   | --- | --- |
   | `HERMES_ENABLED` | `true` |
   | `HERMES_BASE_URL` | `http://10.88.88.1:8642` |
   | `HERMES_API_KEY` | the same 64-hex `API_SERVER_KEY` |
   | `HERMES_TENANT_ID` | the owner's tenant UUID |

   Coolify injects the stack `.env` into every container, so the web
   container must receive `HERMES_API_KEY=__GENIE_NOT_AVAILABLE__`. Genie
   treats that value as unset.
6. **Hermes profile settings beyond the owner's list.** These come from the
   835c3dd review in `docs/HERMES.md`:
   * `auxiliary.background_review.enabled: false`. It defaults to on.
   * **No OpenRouter entry in the root `~/.hermes/auth.json` credential
     pool.** The alternative is to give the profile its own pool holding only
     the dedicated key. Otherwise runs can fall back to the root pool, and so
     to another key.
   * Nothing in the Hermes checkout's `.env` or in `/etc/hermes`.
   * Recommended, as defence in depth: `agent.disabled_toolsets` listing the
     high-risk toolsets, and `kanban.dispatch_in_gateway: false`. Also check
     that the profile has no cron jobs or kanban tasks; the gateway runs both
     dispatchers.

## Order of operations (each step separately approved)

1. Run the offline audit at the current stage. It should pass except
   `SPEND-CAP` (MANUAL), and it shows which of the new items still need
   changes:
   ```bash
   <hermes venv python> -I infra/hermes/audit_hermes_profile.py \
     --profile-dir ~/.hermes/profiles/readyqr --expect-model 'nvidia/nemotron-3-super-120b-a12b:free' \
     --install-dir <hermes checkout> --stage disabled
   ```
2. Fix the profile items above, and re-run the audit.
3. Create the `genie-hermes` network and attach genie-core with `10.88.88.2`.
   genie-core still has `HERMES_ENABLED=false`.
4. Add the firewall rules. Then confirm from **another** container and from
   outside that `10.88.88.1:8642` is unreachable. Nothing listens yet, so the
   expected result is a timeout or refusal.
5. Write the API settings into the profile `.env` and install the unit, but do
   not start it. Run the audit with `--stage enabled --unit …`; it must report
   no FAIL.
6. Start the service. Confirm that `ss -ltnp` shows only `10.88.88.1:8642`.
   Confirm that `GET /health` (unauthenticated, returns `{"status":"ok"}`)
   answers from genie-core and **times out** from any other container and
   from outside.
7. Owner approves enabling: set the genie-core settings from step 5 above and
   redeploy. `GET /api/v1/health/ready` → `agentAdapter` must report `ok`,
   meaning Genie's own preflight passed (auth required, no toolsets, durable
   idempotency).
8. Owner authorizes the single tool-free smoke test. Confirm the task result's
   `servedBy.model` is exactly the requested id, and that OpenRouter's
   activity page shows the free model and $0.

## Rollback

* Set `HERMES_ENABLED=false` in genie-core and redeploy. Readiness returns to
  `unavailable` and tasks fail visibly.
* `systemctl disable --now hermes-readyqr`.
* Optionally detach genie-core from `genie-hermes`. The firewall rules can stay.

## Alternative (more isolation, more work)

Run Hermes in its own container on the `genie-hermes` network: the profile as
a volume, no published ports, a non-root user, and a read-only root
filesystem. That removes the host listener and the firewall dependency, and
keeps Hermes off the host filesystem. It means containerising the existing
install, so it is a separate, later project.

## Adapter changes required

None beyond those already made in this round:
* the wrapped `/v1/toolsets` shape;
* the durable-idempotency requirement.

The adapter needs no changes for the bridge address: `HERMES_BASE_URL` takes
any private `http://` URL. Per-tenant Hermes profiles (`/p/<profile>/`) are
out of scope; Genie binds Hermes to one tenant.
