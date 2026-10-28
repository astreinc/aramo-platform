# nginx front door (Front-Door Migration, ADR-0023)

The nginx front door (ADR-0023) — faithful to the three host classes and their
walls, plus the certbot DNS-01 sidecar that owns the wildcard cert. It is the
single ingress on 80/443, having replaced the retired front door at the cutover
(the compose flip removed the retired service and published nginx on 80/443).

## Files

- `Dockerfile` — mirrors the retired front-door image: a `web-builder` stage compiles all five
  SPAs (`home-web → /srv/home` — the tenant-host App Home + `/org/*` (D-ORG-2, topology T1),
  `ats-web → /srv/ats` — served under `/ats/`, `platform-web → /srv/admin`,
  `portal-web → /srv/portal`, `sign-web → /srv/sign`, with the `prisma:generate` prerequisite),
  runtime `nginx:stable-alpine` (pinned).
- `nginx.conf` — minimal top-level config (`gzip on`, `include conf.d/*.conf`).
- `templates/aramo.conf.template` — the three 443 server blocks + the port-80
  healthz/redirect, materialized by the official image's envsubst at container
  start.

## Parameterization (env-less = local posture)

Four vars, defaults chosen so an env-less container is the LOCAL posture (mirrors
the retired front door's local defaults):

| Var | Local default | Box |
|---|---|---|
| `NGINX_TENANT_SERVER_NAME` | `localhost` | `*.aramo.ai` |
| `NGINX_ADMIN_SERVER_NAME` | `admin.localhost` | `admin.aramo.ai` |
| `NGINX_PORTAL_SERVER_NAME` | `portal.localhost` | `candidate.aramo.ai` |
| `NGINX_CERT_DIR` | `/etc/letsencrypt/live/aramo.ai` | (same — the certbot volume) |

Only these four are substituted (`NGINX_ENVSUBST_FILTER=^NGINX_` at runtime;
explicit var-list `envsubst` at build time), so every nginx runtime variable
(`$host`, `$uri`, `$scheme`, `$proxy_add_x_forwarded_for`, …) is left literal.
Upstreams (`api:3000`, `auth-service:3001`, `platform-admin:3002`) are hardcoded,
exactly as the retired front door hardcoded them. Every var appears in both the compose
passthrough and `.env.prod.example` (the D-AUTH-PLATFORM-HOSTS-1 defect class: an
unpassed var silently reverts to the local default on the box).

## Local posture (mkcert)

nginx has no built-in local CA (the retired front door had one). To run the full
compose stack locally over HTTPS, mount an mkcert-generated
`fullchain.pem`/`privkey.pem` pair at `NGINX_CERT_DIR`:

```
mkcert -cert-file fullchain.pem -key-file privkey.pem localhost admin.localhost portal.localhost
# mount the directory containing them at NGINX_CERT_DIR
```

## Cert / TLS

One shared **wildcard** cert (`*.aramo.ai`, **no apex SAN** — PR-0b R4) serves all
three 443 blocks. TLS terminates at the front door; nginx→backend is plain HTTP on
the compose network (the retired front door's posture). The certbot sidecar solves the ACME
DNS-01 challenge via Route53 (no HTTP-01), so there is **no
`/.well-known/acme-challenge` location** — the port-80 server only answers
`/healthz` and redirects everything else to HTTPS.

## Reload loop (Ruling 4)

The nginx service command wraps a 6h `nginx -s reload` loop around
`nginx -g 'daemon off;'` — the standard shared-volume pattern that picks up a
renewed cert without a container restart. **No docker socket is mounted anywhere**
(rejected: a root-equivalent surface for a convenience hook). The certbot service
runs a 12h `certbot renew` loop (TERM-trapped); **initial issuance is NOT run by
the service** — it is an explicit cutover-runbook step, run once at the window.

## Parity delta (accepted, documented)

- **gzip only** — stock nginx compresses gzip; the retired front door did gzip + zstd.
- **No WebSocket provisions** — the front-door audit found zero realtime
  (websocket/SSE) usage.

## Front-door invariant

nginx publishes 80/443 and is the sole public ingress; the backends are never
published to the host. `ci/scripts/verify-frontdoor-conf.ts` asserts the post-flip
invariant (assertion f′): nginx has 80/443, no `profiles:` remain in compose, and
exactly one service publishes each ingress port.

## Sign host: rate limits

Every Sign-host location used by the web app or the mobile app has a `limit_req`.
This is required by the Aramo Sign Mobile directive (§4 B-13, §9, §12.12). The
budgets are per client address, and a refusal returns `429`. The rates are sized
so that several phones behind one carrier-NAT address are not starved.

| Zone | Rate | Locations (burst) |
|---|---|---|
| `sign_guest` | 10 r/s | `/v1/sign/signing/` (60) |
| `sign_report` | 10 r/m | `/v1/sign/report` (5) |
| `sign_signup` | 10 r/m | `/v1/signup/sign/` (10) |
| `domain_delegate` | 30 r/m | `/v1/domain-verification/delegate` (10) |
| `sign_workspace` | 20 r/s | `/v1/sign/sender/` (100), `/v1/sign/inbox` (40), `/v1/sign/me/` (40), `/v1/sign/legal/` (20), `/v1/sign/account/` (20), `/v1/sign/billing/` (20) |
| `sign_auth` | 10 r/s | `/auth/` (40) |
| `sign_native_auth` | 30 r/m | `/auth/native/` (20) |

`sign_workspace` is one shared zone, so each client address has one budget across
all of the authenticated Sign surfaces. The sender editor writes once per field,
which is why `/v1/sign/sender/` has the largest burst. On the native app, a device
refreshes its token once per 900 s access-token lifetime, so 30 requests a minute
is generous for real use and still tight against code or token guessing.

`/v1/tenant/domain-verification` is the one proxied location without an edge
limit. It is an authenticated settings page served by apps/api, which applies its
own budgets.

## Sign host: app-association files (Aramo Sign Mobile)

The Sign host serves two exact locations, as `application/json`:

- `/.well-known/apple-app-site-association` (iOS Universal Links)
- `/.well-known/assetlinks.json` (Android App Links)

Both follow M-A2 §3.2: no redirect, never the SPA fallback (a missing file is a
`404`), and `Cache-Control: public, max-age=3600`.

The files are rendered at every container start by
`app-links/render-app-links.sh`, which the image installs as
`/docker-entrypoint.d/40-aramo-app-links.sh`. It writes into
`/etc/nginx/aramo-app-links/`, using:

| Var | Example | Source |
|---|---|---|
| `SIGN_IOS_APP_ID` | `ABCDE12345.ai.aramo.sign` | Apple Team ID + bundle id (P-1) |
| `SIGN_ANDROID_PACKAGE` | `ai.aramo.sign` | Play package (P-3) |
| `SIGN_ANDROID_CERT_SHA256S` | `AA:BB:…,11:22:…` | Play app-signing and upload key SHA-256 (P-3) |

This is a separate step from the template envsubst, which stays filtered to
`^NGINX_`. The conf template never references these variables.

An unset or malformed value renders valid JSON that associates nothing:
`{"applinks":{"details":[]}}` and `[]`. A warning is logged, and nginx still
starts. The iOS file claims exactly `/s/*`, `/d/*` and `/auth/native/callback`.

After changing a value, restart nginx (a reload does not re-run the step).

`verify-frontdoor-conf.ts` checks this wiring, rules (n) to (s). It also runs the
render step under `sh`, and its built-in negative tests prove that each rule can
fail. The boot smoke checks that both files are served with no `SIGN_*` env.
Activation steps are in `doc/runbooks/RELEASE-sign-mobile.md`.

## Logging: credentials are redacted (M-A7 §1, R-16)

Guest signing and download links carry a bearer token in the path (`/s/<token>`,
`/d/<token>`), and the magic-link and OAuth callbacks carry one in the query
(`?token=`, `?code=`). The template's `aramo_redacted` access-log format (used by
every server block) writes `/s/[redacted]`, `/d/[redacted]`, `?[redacted]` for any
query string, and only the origin of the Referer. The request reaching the
upstream is unchanged. The credential-bearing locations (`/auth/`, `/auth/native/`,
`/s/`, `/d/`, the Microsoft callback) log errors at `crit` only, because nginx
error lines embed the request line. Container logs rotate at 10 MB × 5 files
(`x-aramo-logging` in `docker-compose.prod.yml`).
