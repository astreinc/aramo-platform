# Step-4 — Single-Box Directive 1: the runnable prod stack

**Status:** built + proven locally · branch `feat/step4-singlebox-d1-runnable-prod-stack` off `21e7905`
**Scope:** additive only — no app-code, no scope, no migration. The D1 images, D2 Terraform, and D5 dev compose are untouched.

The first of the deployment artifacts: a **runnable prod stack** — the D1 containers + persisted Postgres + Redis behind a **Caddy** front-door (TLS + static host + path routing) — composed so it comes up with one command and is **provable locally before the Lightsail box exists**. It is the D5 stack plus a production front-door.

---

## What shipped

| File | Role |
|------|------|
| `docker-compose.prod.yml` | The prod stack: `caddy` (only published service) + `api` + `auth-service` (D1 images, referenced not rebuilt) + `postgres` (persisted volume) + `redis`. `restart: unless-stopped` on all. |
| `deploy/caddy/Caddyfile` | Front-door config: serves the ats-web SPA at `/`, path-routes `/v1`→api, `/auth`→auth-service, `/.well-known/jwks.json`→auth-service. TLS + domain parameterized by env. |
| `deploy/caddy/Dockerfile` | Self-contained multi-stage image: builds the ats-web SPA → bakes it into `caddy:2-alpine` at `/srv`. No secrets baked. |
| `.env.prod.example` | The full prod env surface (per-service), documented. Real `.env` is never committed. |
| `.gitignore` | One line: `!.env.prod.example` so the example is tracked (the real `.env` stays ignored). |

## §C — ats-web same-origin relative paths (no FE change needed)

Recon of the FE API-base config: `ApiClient` defaults to `baseUrl: ''` ([libs/fe-foundation/src/api/client.ts:71](../libs/fe-foundation/src/api/client.ts#L71)) and every call site uses relative paths (`/v1/...`, `/auth/...`). The FE is **already same-origin / relative-capable** — no absolute URL is baked, nothing reads a `VITE_API_URL`. Because Caddy puts everything on one origin by path, the FE needs **no CORS, no per-env rebuild, and no code change**. The directive's `HALT-if-significant-app-change` did not trigger; the minimal-config branch was a no-op.

## TLS parameterization (one Caddyfile, both environments)

Two env vars (Caddyfile defaults in parentheses):

- `CADDY_SITE_ADDRESS` (`localhost`) — the address Caddy answers on. Box: `astre.aramo.ai`.
- `CADDY_TLS` (`internal`) — the `tls` directive argument. `internal` = Caddy's local CA (laptop). Box: an ACME email (e.g. `admin@aramo.ai`) → real Let's Encrypt auto-provision + auto-renew.

Unset → local defaults, so the stack runs and is testable on a laptop with **no public domain**.

## How to run it

```bash
# 0) Build the D1 backend images + this front-door image (first time / on change):
docker build -f apps/api/Dockerfile          -t aramo/api:local          .
docker build -f apps/auth-service/Dockerfile -t aramo/auth-service:local .
docker build -f deploy/caddy/Dockerfile      -t aramo/caddy:local        .

# 1) Load the env contract into the shell, then bring the stack up:
set -a && source .env && set +a
docker compose --env-file /dev/null -f docker-compose.prod.yml up -d

docker compose --env-file /dev/null -f docker-compose.prod.yml down      # stop (data persists)
docker compose --env-file /dev/null -f docker-compose.prod.yml down -v   # stop + WIPE the volume
```

`--env-file /dev/null` + `set -a && source .env` is the proven D1 pattern: it stops compose parsing the multi-line PEM `.env`, and bare-name `environment:` entries pass through from the sourced shell verbatim (multi-line-safe). `DATABASE_URL`/`REDIS_URL` are pinned to the compose service names; DB credentials are interpolated from the same `POSTGRES_*` vars that configure the postgres service, so they cannot drift.

## Local provability — verified (through Caddy, over local TLS)

All proven against `https://localhost` (Caddy local CA, `curl -k`):

| Check | Result |
|-------|--------|
| Stack up | caddy + api + auth + postgres + redis all boot; **only caddy publishes ports** (80/443). Postgres/Redis/api/auth are container-internal (no host mapping). |
| `GET /.well-known/jwks.json` through Caddy | **200** — `{"keys":[{"kty":"RSA",...}]}` (proxied to auth-service) |
| `GET /v1/tenant/settings` (unauth) through Caddy | **401 `AUTH_REQUIRED`** (proxied to api) |
| `GET /` through Caddy | **200** `text/html` — ats-web SPA loads (`<title>Aramo Recruiter Console</title>`) |
| `GET /admin/settings` (deep link) | **200** index.html — SPA fallback (`try_files`) works for client-side routes |
| Postgres persistence | Marker row written, stack `down` (no `-v`) + `up`, marker **survived** (named volume persists) |
| No baked secrets | Caddy image has no `.env`; `/srv` is `assets/` + `index.html` only; no `AKIA…`/`BEGIN PRIVATE KEY`/`sk-ant-…` in the baked SPA or Caddyfile |

## ★ Honest boundary — box-only (not faked locally)

Per §D and the §5 local-Cognito limitation, two things are verified **on the box**, not locally:

- **Real Let's Encrypt TLS** — needs the public domain `astre.aramo.ai` + the ACME challenge. Local proves the stack composition + routing + serving + persistence over the Caddy local CA; the box proves real cert issuance.
- **Real Cognito login** — no real pool is reachable locally (the §5 limitation). The box proves the full login flow (the §5 checklist).

## Notes / flags

- **Anthropic key is NOT an env var.** The codebase fetches it at runtime from AWS Secrets Manager at `aramo/${ARAMO_ENV}/anthropic-api-key` ([libs/ai-draft SecretCacheService](../libs/ai-draft/src/lib/secrets/secret-cache.service.ts)), authorized by the `AWS_*` creds. So the "Anthropic key" enters via Secrets Manager + `ARAMO_ENV`, not the env surface — documented as such in `.env.prod.example`. (The D1 backend env list, which this mirrors, likewise carries no `ANTHROPIC_API_KEY`.)
- **`/.well-known/jwks.json` is routed by exact path**, not `/.well-known/*`, so `/.well-known/acme-challenge/*` stays free for Caddy's own Let's Encrypt HTTP-01 challenge on the box.
- Caddy cert/ACME state persists in the `aramo-prod-caddy-data` volume (avoids re-requesting Let's Encrypt certs — and its rate limits — on every box reboot).
