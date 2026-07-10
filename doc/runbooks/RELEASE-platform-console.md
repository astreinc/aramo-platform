# RELEASE — Platform Console (`https://admin.aramo.ai`)

**Inc-3 PR-3.3 · Track A closeout.** The self-contained checklist that turns the
Increment-3 `M` merge into a running platform console on the single box, and
proves it without improvisation. Run top-to-bottom; every step has an explicit
pass signal. This complements — does not replace — the general redeploy grammar
in [singlebox-ops.md](singlebox-ops.md) (§ "Redeploy: the ordered sequence").

The platform console adds ONE backend (`platform-admin`) and a second SPA baked
into the SAME Caddy image (`platform-web` → `/srv/admin`); it introduces no new
database and no new migration. The admin host is served by a DEDICATED Caddy
site block with ordinary ACME (never the tenant on-demand / ask path — Ruling
R14) and has NO `/v1` route.

---

## 0. Prerequisites (verify BEFORE the release window)

- [ ] **`M` merged to `main`.** The Increment-3 integration merge (`platform-console`
      → `main`) is complete; `main` carries the platform-admin app, `platform-web`,
      and this PR's deploy wiring.
- [ ] **Images published from `main`.** GHCR holds `:latest` (and the commit-SHA
      tag) for all four images built on the `main` push — confirm the new ones:
      - `ghcr.io/<owner>/aramo-platform-admin`
      - `ghcr.io/<owner>/aramo-caddy` (now fattened: contains BOTH SPAs)
      - (unchanged: `aramo-api`, `aramo-auth-service`)
      Publish is main-ref-gated in `ci.yml`; nothing publishes off a branch.
- [ ] **DNS resolves `admin.aramo.ai`.** The existing `*.aramo.ai` wildcard record
      already covers it — VERIFY, don't assume:
      ```
      dig +short admin.aramo.ai      # expect the box's public IP
      ```
      No new DNS record is needed (the wildcard subsumes the admin host).
- [ ] **PO — Cognito prod app-client additions** (the ONLY manual cloud step; the
      platform console rides the same auth-service OAuth flow, host-derived per
      PR-3.1, so the sole gap is the allowed-URL allowlist on the app client):
      - Callback URL: `https://admin.aramo.ai/auth/platform/callback`
      - Sign-out URL: `https://admin.aramo.ai/` (the admin post-logout landing)
      Leave the existing `astre.aramo.ai` (and other tenant) URLs in place.
- [ ] **Platform Cognito pool id known.** `AUTH_COGNITO_PLATFORM_USER_POOL_ID` is
      set in the box `.env` (see §1). Distinct from the tenant pool. Without it,
      platform-admin invitations throw `AUTH_COGNITO_PLATFORM_USER_POOL_ID is not
      configured` at invite time (not at boot).

## 1. Box `.env` additions

Append/set in the box's `.env` (the file `docker-compose.prod.yml` reads). See
[.env.prod.example](../../.env.prod.example) for the full annotated list; the
platform-console-specific keys:

```sh
# The platform console host (dedicated block, ordinary ACME — R14).
CADDY_ADMIN_ADDRESS=admin.aramo.ai

# The platform-admin image (defaults to the local build tag; on the box point
# it at the published GHCR tag).
ARAMO_PLATFORM_ADMIN_IMAGE=ghcr.io/<owner>/aramo-platform-admin:latest

# The PLATFORM Cognito user pool (platform-admin invitations mint here).
AUTH_COGNITO_PLATFORM_USER_POOL_ID=us-east-1_XXXXXXXXX
```

- **`AUTH_PLATFORM_HOSTS`** should already be `admin.aramo.ai` (added in PR-3.1) —
  confirm. It is what makes auth-service DERIVE the admin redirect base from the
  request host.
- **`AUTH_PUBLIC_BASE_URL` stays UNSET.** Host-derivation (PR-3.1) governs the
  redirect base for both consoles concurrently; the env is only the escape hatch
  for unvalidated hosts. Setting it would pin every consumer to one origin.
- **`CADDY_TLS`** is unchanged (`admin@aramo.ai` on the box) — the admin block
  reuses it for ordinary Let's Encrypt issuance.

## 2. Pull + bring up (on the box)

Follow the STANDARD ordered redeploy (singlebox-ops.md) — the platform console
adds no migration, but the ordered gates still run:

```sh
cd /opt/aramo
git pull --ff-only                       # or just update the image tags in .env
deploy/migrate-prod.sh                    # zero-pending expected (no new migration)
deploy/seed-prod.sh                       # regen client + seed asserts (unchanged)
# Only if BOTH gates exited 0:
sudo systemctl restart aramo-singlebox.service   # compose up -d, recreates containers
```

The restart recreates the stack from `docker-compose.prod.yml`, which now
includes the `platform-admin` service and pulls the fattened `caddy` image.

Confirm the new container is healthy and Caddy has both roots:

```sh
docker ps --format '{{.Names}}\t{{.Status}}' | grep platform-admin   # Up (healthy)
docker exec aramo-prod-caddy ls /srv                                 # ats  admin
```

## 3. Smoke (the release is DONE when all pass)

1. [ ] **Platform login.** In a clean browser, visit `https://admin.aramo.ai` →
       redirected to Cognito → log in as the platform owner → landed back on the
       platform console (no `pkce_state_missing`, valid TLS cert issued).
2. [ ] **Tenant list renders.** The platform console's tenant list loads (a real
       `GET /platform/tenants` round-trip through `platform-admin:3002`).
3. [ ] **One read exercised.** Open a tenant → its detail/audit renders (proves
       the `/platform/*` surface end-to-end, not just the list).
4. [ ] **No `/v1` leakage (R14).** `curl -sk https://admin.aramo.ai/v1/health-ish`
       returns the SPA `index.html` (200, HTML) — NOT tenant JSON and NOT a proxy
       to `api:3000`. The admin host cannot reach tenant data.
5. [ ] **Regression — tenant console still clean.** `https://astre.aramo.ai`
       recruiter login + one page render still works (the wildcard block's only
       change was the `/srv` → `/srv/ats` re-path; astre must be unaffected).

## 4. Rollback

The change is deploy-surface only. To revert: restore the prior image tags
(`ARAMO_PLATFORM_ADMIN_IMAGE` / caddy) in `.env` and
`sudo systemctl restart aramo-singlebox.service`. The `platform-admin` service
and the admin site block simply stop being served; the tenant console
(`api` + `auth-service` + the ats-web root) is untouched. No DB rollback (no
migration was introduced).

---

### Why there is no new migration or seed

`platform-admin` reuses the existing identity/entitlement schema (the same DB the
`api` writes). Its whole job is orchestration over rows the tenant schema already
defines. The platform owner is already seeded by `deploy/seed-prod.sh`
(`purush@…`, scope `platform`) from Increment-1 — no new seed step.
