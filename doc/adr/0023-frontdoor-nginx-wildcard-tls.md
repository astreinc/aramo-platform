# ADR-0023 — Front door: nginx + wildcard TLS (certbot DNS-01), Caddy retired

**Status:** Accepted (2026-07-24)
**Supersedes:** Subdomain-Identity Directive A's on-demand-TLS posture (the
tenant-validated per-host cert mint). **Related:** ADR-0016 (identity), the
PublicSite track (apex ownership).

## Context

The single-box front door was Caddy, serving three host classes over TLS:

- the tenant wildcard host (`*.aramo.ai`) with **on-demand TLS** — Caddy minted a
  per-host Let's Encrypt cert JIT on first request, gated by an ask-endpoint
  (`GET /v1/tenants/cert-eligible`) that validated the host's slug against the
  tenant table;
- the platform console host (`admin.aramo.ai`) and the portal host
  (`candidate.aramo.ai`) as dedicated blocks with ordinary HTTP-01 certs.

This coupled cert issuance to a public app endpoint and to the tenant table, kept
per-host issuance on the request path, and (with `trust proxy` unset) collapsed
the app's per-IP budgets to a single global bucket behind the proxy.

## Decision

Replace Caddy with **nginx** as the front door, and replace on-demand per-host
issuance with a single **`*.aramo.ai` wildcard certificate** obtained by a
**certbot DNS-01 sidecar** via Route53. Specifically:

1. **nginx** terminates TLS on 80/443 and reverse-proxies the same three host
   classes with the walls translated verbatim from the retired Caddy config —
   tenant (`/v1/`, `/auth/`, exact `jwks`, the Indeed webhook), admin
   (`/auth/`, `/platform/`, `jwks`, **no `/v1`** — R14), portal (`/v1/portal/`
   only). Upstreams are the compose service names; TLS terminates at the front
   door, backend hops are plain HTTP on the compose network.
2. **Wildcard cert via certbot DNS-01/Route53** supersedes Subdomain-Identity A's
   on-demand mint. One cert covers every `<slug>.aramo.ai`; onboarding stays a
   Tenant-row data op, but no per-host issuance and no request-path cert gate
   exist. The certbot principal is a **least-privilege IAM user** scoped to the
   `_acme-challenge.aramo.ai` TXT record only (PR-0 `iam-certbot-dns`).
3. **The ask-endpoint is retired** — `PublicTenantCertController`
   (`/v1/tenants/cert-eligible`) and its spec/wiring are removed. On-demand TLS no
   longer exists, so nothing consumes it. `TenantService.findActiveBySlug`
   survives for its other callers (the Indeed webhook and the auth host-context
   adapter).
4. **Explicit proxy-header contract** on every proxied location: `Host`,
   `X-Forwarded-For` (via `$proxy_add_x_forwarded_for`), `X-Forwarded-Host`,
   `X-Forwarded-Proto`. Paired with **`trust proxy = 1`** in each deployable
   (D-PROXY-IP-1 fix), so `req.ip` is the proxy-observed client and the per-IP
   budgets key per-client again.
5. **Local posture:** nginx has no built-in local CA (Caddy had `tls internal`);
   local HTTPS uses an **mkcert** pair mounted at `NGINX_CERT_DIR`.

The nginx + certbot services ship inert (profile-gated, no ports) and are flipped
live at a scheduled cutover window (`doc/runbooks/frontdoor-cutover.md`): Caddy is
removed, nginx publishes 80/443, the wildcard cert is issued once before the flip.

## Scope carve-out (from Front-Door PR-0b §0 — verbatim in substance)

- The certificate scope is **`*.aramo.ai` ONLY — no apex SAN.**
- The **`aramo.ai` apex is out of this ADR's scope and is owned by the PublicSite
  track, permanently.** This migration track writes **no DNS**.
- The **manual `*.aramo.ai` wildcard `A` record** (pre-IaC, what tenant routing
  rides on) is touched by **neither track's Terraform** and remains manual.

## Consequences

- Cert issuance is decoupled from any app endpoint and from the tenant table; no
  per-host mint on the request path. One wildcard cert, renewed on a certbot loop.
- Per-IP budgets are honest again (D-PROXY-IP-1 closed at the cutover deploy).
- Parity delta (accepted, documented): nginx compresses gzip only (Caddy did
  gzip+zstd); no WebSocket provisions (the audit found zero realtime usage).
- Caddy is removed from the repo entirely; a sealed forbidden-term lane in
  `scripts/verify-vocabulary.sh` keeps it zero outside this ADR + the filed
  history/architecture records.
