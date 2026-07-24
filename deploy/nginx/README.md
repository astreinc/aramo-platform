# nginx front door (Front-Door Migration PR-2, ADR-0023)

The nginx replacement for the Caddy front door — faithful to the three host
classes and their walls, plus the certbot DNS-01 sidecar that owns the wildcard
cert. **Built inert:** shippable and CI-gated, but the `nginx` + `certbot` compose
services are profile-gated (`profiles: ["frontdoor"]`) and nginx publishes **no
ports** until the PR-3 cutover flip. Zero Caddy files are touched here.

## Files

- `Dockerfile` — mirrors the Caddy image: a `web-builder` stage compiles all three
  SPAs (`ats-web → /srv/ats`, `platform-web → /srv/admin`, `portal-web → /srv/portal`,
  with the `prisma:generate` prerequisite), runtime `nginx:stable-alpine` (pinned).
- `nginx.conf` — minimal top-level config (`gzip on`, `include conf.d/*.conf`).
- `templates/aramo.conf.template` — the three 443 server blocks + the port-80
  healthz/redirect, materialized by the official image's envsubst at container
  start.

## Parameterization (env-less = local posture)

Four vars, defaults chosen so an env-less container is the LOCAL posture (mirrors
the Caddyfile's local defaults):

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
exactly as the Caddyfile hardcodes them. Every var appears in both the compose
passthrough and `.env.prod.example` (the D-AUTH-PLATFORM-HOSTS-1 defect class: an
unpassed var silently reverts to the local default on the box).

## Local posture (mkcert)

nginx has no built-in local CA (Caddy did — `tls internal`). To run the full
compose stack locally over HTTPS, mount an mkcert-generated
`fullchain.pem`/`privkey.pem` pair at `NGINX_CERT_DIR`:

```
mkcert -cert-file fullchain.pem -key-file privkey.pem localhost admin.localhost portal.localhost
# mount the directory containing them at NGINX_CERT_DIR
```

## Cert / TLS

One shared **wildcard** cert (`*.aramo.ai`, **no apex SAN** — PR-0b R4) serves all
three 443 blocks. TLS terminates at the front door; nginx→backend is plain HTTP on
the compose network (the Caddy posture). The certbot sidecar solves the ACME
DNS-01 challenge via Route53 (no HTTP-01), so there is **no
`/.well-known/acme-challenge` location** — the port-80 server only answers
`/healthz` and redirects everything else to HTTPS.

## Reload loop (Ruling 4)

The nginx service command wraps a 6h `nginx -s reload` loop around
`nginx -g 'daemon off;'` — the standard shared-volume pattern that picks up a
renewed cert without a container restart. **No docker socket is mounted anywhere**
(rejected: a root-equivalent surface for a convenience hook). The certbot service
runs a 12h `certbot renew` loop (TERM-trapped); **initial issuance is NOT run by
the service** — it is an explicit cutover-runbook step (PR-3), keeping PR-2 inert.

## Parity delta (accepted, documented)

- **gzip only** — stock nginx compresses gzip; Caddy did gzip + zstd.
- **No WebSocket provisions** — the front-door audit found zero realtime
  (websocket/SSE) usage.

## Inertness invariant

`profiles: ["frontdoor"]` on both new services + **no `ports:`** on nginx: a plain
`docker compose up -d` starts neither. The PR-3 flip removes the profiles and moves
the 80/443 publications from caddy to nginx in one reviewed diff.
`ci/scripts/verify-frontdoor-conf.ts` asserts this invariant (assertion f) and
retires it at PR-3.
