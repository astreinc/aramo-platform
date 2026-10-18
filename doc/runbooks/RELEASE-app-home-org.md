# RELEASE — App Home + Organization Administration on the tenant host (D-ORG)

**Status:** PREPARED, NOT EXECUTED. Nothing in this runbook has been performed. It documents the external
activation steps the D-ORG branch (`feat/d-org-multiproduct-app-home`) requires, per the D-ORG authorization §6.
**Scope:** the tenant host class (`<slug>.aramo.ai`, prod today `astre.aramo.ai`). The ATS moves from `/` to
`/ats/`; the App Home takes `/`; Organization Administration is `/org/*`. Cognito app-client URLs are managed OUTSIDE
Terraform (the Cognito pool is not in IaC — see `doc/runbooks/RELEASE-platform-console.md` §0 for the precedent).

## 0. Prerequisites (before the release window)

- [ ] **PO — Cognito tenant-pool app-client additions** (the ONLY manual cloud step; auth-service derives both URLs
      per host, so the sole gap is the allowed-URL allowlist). For EVERY tenant host that will use the App Home:
      - Callback URL: `https://<slug>.aramo.ai/auth/org/callback`
      - Sign-out URL: `https://<slug>.aramo.ai/signed-out` (prod logout currently never cleared Cognito SSO because
        this URL was never registered — a standing follow-up; the same URL now serves both SPAs' signed-out landings)
      Leave the existing `…/auth/recruiter/callback` and every other registered URL in place. `/auth/esign/callback`
      on the tenant host is NOT part of this release (Sign stays dark, §3.H).
- [ ] **Post-login landing (Gate-6 V4 ruling).** The code defaults are `recruiter → /ats/`, `org → /` and the legacy
      global `AUTH_POST_LOGIN_PATH` no longer overrides a consumer with a built-in landing (it was also never passed to
      the auth-service container by compose). Delete the stale `AUTH_POST_LOGIN_PATH=/` line from the box `.env` for
      hygiene; to override ONE consumer explicitly use `AUTH_POST_LOGIN_PATH_<CONSUMER>` (now passed through by
      compose for recruiter / org / esign). `AUTH_SIGNOUT_PATH` stays as today.
- [ ] **Sign entry stays dark.** Do NOT set `ARAMO_SIGN_ENTRY_ENABLED`. `/v1/me/products` reports Sign as
      `not_activated` until a separate ruling activates the Sign entry (which also needs the Cognito callback above
      for `esign` and the nginx `/sign/` location — neither exists in this branch).
- [ ] **No DNS change.** The wildcard subsumes every tenant host; `/ats/` and `/org/` are paths, not hosts.

## 1. Images

The nginx image bakes FIVE SPAs (`deploy/nginx/Dockerfile`: `home-web` → `/srv/home`, `ats-web` → `/srv/ats`,
`platform-web` → `/srv/admin`, `portal-web` → `/srv/portal`, `sign-web` → `/srv/sign`). `deploy/build-images.sh`
builds it as before; nothing new to list. Backend images (api, auth-service, platform-admin) carry the `org`
consumer, the cookie contract and `/v1/me/products` — ALL of api, auth-service, platform-admin and nginx must be
rebuilt and recreated together (a new nginx with an old auth-service would route `/auth/org/*` to a service that
rejects the consumer; an old nginx with a new ats-web bundle would serve asset URLs under `/ats/` that the old
template cannot resolve).

## 2. Bring-up order (on the box, per `RELEASE-box.md`)

1. Build all images from the authorized SHA (`deploy/build-images.sh`).
2. Recreate api, auth-service, platform-admin, esign-service, nginx (esign-service must be running BEFORE nginx —
   the standing hard-coupling in `RELEASE-box.md` v2.4).
3. No migration ships with D-ORG (no schema change).

## 3. Smoke (the release is DONE when all pass)

1. `https://astre.aramo.ai/` → 302 to Cognito via `/auth/org/login`; after sign-in → `/` renders the App Home tiles.
2. ATS tile → `/auth/recruiter/login?return_to=%2Fats%2F` → silent SSO → lands on `/ats/` (the recruiter session
   cookie is `aramo_access_token_recruiter`; the org cookie `aramo_access_token_org` is still present — both
   `/auth/recruiter/session` and `/auth/org/session` answer 200 for their own cookie).
3. A pre-release bookmark `https://astre.aramo.ai/talent/<id>` → forwarded to `/ats/talent/<id>`.
4. Refresh on `/ats/requisitions/<id>` and on `/org/users` → both render (no 404).
5. `/org/users` as a tenant owner → the roster; as a recruiter without `tenant:admin:*` → the in-app forbidden state
   (and the API 403s).
6. Sign-out from either app → Cognito sign-out → `/signed-out`; afterwards `/auth/recruiter/session` AND
   `/auth/org/session` both 401 (global sign-out).
7. `GET /v1/me/products` → `ats.available=true`, `org.available=true`, `esign.available=false`
   (`reason=not_activated` or `not_subscribed`).

## 4. Rollback

Recreate the previous image set (the previous nginx template roots `/srv/ats` at `/`). Sessions minted with the
suffixed cookie names are simply ignored by the previous auth-service (it reads the unsuffixed names), so users
re-authenticate once. Remove the two Cognito URLs only if the rollback is permanent.

## 5. Local browser check (what Gate-6 V3 ran; repeatable before any release)

The integrated front-door bundle in a real browser, with the two backends stubbed at the browser network layer
(`apps/home-web/e2e/topology.spec.ts`; config `apps/home-web/playwright.topology.config.ts`):

```sh
docker build -f deploy/nginx/Dockerfile -t aramo/nginx:local .
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=localhost' -keyout /tmp/certs/privkey.pem -out /tmp/certs/fullchain.pem
docker run -d --name dorg-nginx -p 8443:443 --add-host api:127.0.0.1 --add-host auth-service:127.0.0.1 \
  --add-host platform-admin:127.0.0.1 --add-host esign-service:127.0.0.1 \
  -e NGINX_TENANT_SERVER_NAME=localhost -e NGINX_CERT_DIR=/certs -v /tmp/certs:/certs:ro aramo/nginx:local
DORG_E2E_BASE_URL=https://localhost:8443 npx playwright test --config apps/home-web/playwright.topology.config.ts
```

Covers: tenant `/` → org login → App Home; the ATS tile → recruiter login with `return_to=/ats/`; ATS deep link +
refresh through nginx; the ATS rail link out to `/org/`; the relocated Organization views and dialogs; legacy
bookmark forwarding; an org-only session never opening the ATS; login-error and signed-out landings in both apps;
global sign-out. Screenshots land in `apps/home-web/e2e/.evidence/` (gitignored). Backend contracts are proven by
the auth-service and identity integration suites, not here.
