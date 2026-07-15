# Aramo — Single-Box prod front-door image (Directive 1).
#
# Self-contained (matches D1's containerized philosophy): a multi-stage build
# compiles ALL THREE static SPAs (ats-web → /srv/ats, platform-web → /srv/admin,
# portal-web → /srv/portal) and bakes them into ONE Caddy image, so the
# front-door ships as a single artifact (no mounted static volume to manage on
# the box). Caddy serves the tenant SPA on the *.aramo.ai wildcard host, the
# platform SPA on admin.aramo.ai, and the portal SPA on candidate.aramo.ai, and
# path-routes /v1→api, /auth→auth-service, /platform→platform-admin;
# TLS + domain are RUNTIME-parameterized via the Caddyfile env vars (see
# docker-compose.prod.yml / .env.prod.example).
#
# Build from the REPO ROOT (the Nx build graph needs the whole workspace):
#   docker build -f deploy/caddy/Dockerfile -t aramo/caddy:local .
#
# NO secrets baked in: the FE calls same-origin RELATIVE paths, so there is no
# API URL — or anything else — to embed at build time.

# ---------- Stage 1: build BOTH static SPAs ----------
FROM node:24-bookworm-slim AS web-builder
WORKDIR /app

# Prisma's generator needs openssl/ca-certs present (see below — platform-web's
# nx build graph pulls a Prisma-backed lib, so this image runs prisma:generate).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Deterministic install first (cache layer keyed on the lockfile only).
COPY package.json package-lock.json ./
RUN npm ci

# Workspace source (.dockerignore keeps out node_modules/dist/.env/secrets).
COPY . .

# Per-module Prisma clients — REQUIRED before the platform-web build. Unlike
# ats-web (whose graph is fe-foundation only), aramo-platform-web's nx project
# graph includes @aramo/engagement (scope:ats, Prisma-backed) via its COMMITTED
# Platform⊥ATS negative-control fixture — a deliberate graph edge (excluded from
# platform-web's own compile, but present at graph-compute time so the boundary
# lint can fire on it). nx therefore builds engagement + its Prisma-backed deps
# as a prerequisite of the platform-web build, and those deps need the generated
# clients. The generated code is NOT bundled into either SPA (Vite tree-shakes
# from each app's entry); this is a build-time prerequisite only — the runtime
# stage below still copies pure static dist.
RUN npm run prisma:generate

# Build ALL THREE SPAs → dist/apps/{ats-web,platform-web,portal-web}. Inc-3
# PR-3.3 + Portal P1 PR-3: ONE Caddy image serves every console — a single box
# has one :443, so multiple ingress containers cannot coexist.
RUN npx nx build aramo-ats-web --skip-nx-cache
RUN npx nx build aramo-platform-web --skip-nx-cache
RUN npx nx build aramo-portal-web --skip-nx-cache

# ---------- Stage 2: Caddy front-door (all SPAs baked in) ----------
FROM caddy:2-alpine AS runtime
# The compiled SPAs — the only application artifacts this image carries.
# ats-web serves the tenant/recruiter consoles (the *.aramo.ai wildcard host);
# platform-web serves the platform console (the admin.aramo.ai site block);
# portal-web serves the talent-facing portal (the candidate.aramo.ai block).
COPY --from=web-builder /app/dist/apps/ats-web /srv/ats
COPY --from=web-builder /app/dist/apps/platform-web /srv/admin
COPY --from=web-builder /app/dist/apps/portal-web /srv/portal
# The parameterized front-door config (copied from the build context).
COPY deploy/caddy/Caddyfile /etc/caddy/Caddyfile

# Validate the adapted config at build time (Inc-3 PR-3.3 acceptance §4.2) —
# env vars are unset here so Caddy uses the in-Caddyfile defaults (localhost /
# admin.localhost, internal TLS). Fails the docker-build if the Caddyfile is
# malformed, so the check rides existing CI at zero new job cost.
RUN caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile

EXPOSE 80 443
