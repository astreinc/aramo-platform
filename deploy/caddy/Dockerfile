# Aramo — Single-Box prod front-door image (Directive 1).
#
# Self-contained (matches D1's containerized philosophy): a multi-stage build
# compiles BOTH static SPAs (ats-web → /srv/ats, platform-web → /srv/admin) and
# bakes them into ONE Caddy image, so the front-door ships as a single artifact
# (no mounted static volume to manage on the box). Caddy serves the tenant SPA on
# the *.aramo.ai wildcard host and the platform SPA on admin.aramo.ai, and
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

# Deterministic install first (cache layer keyed on the lockfile only).
COPY package.json package-lock.json ./
RUN npm ci

# Workspace source (.dockerignore keeps out node_modules/dist/.env/secrets).
COPY . .

# Build BOTH SPAs + their Nx lib graph (fe-foundation) → dist/apps/{ats-web,
# platform-web}. Inc-3 PR-3.3: ONE Caddy image serves both consoles — a single
# box has one :443, so two ingress containers cannot coexist. Both are pure FE
# apps (no Prisma in their dependency graph), so — unlike the backend images —
# no `prisma:generate` step is needed.
RUN npx nx build aramo-ats-web --skip-nx-cache
RUN npx nx build aramo-platform-web --skip-nx-cache

# ---------- Stage 2: Caddy front-door (both SPAs baked in) ----------
FROM caddy:2-alpine AS runtime
# The compiled SPAs — the only application artifacts this image carries.
# ats-web serves the tenant/recruiter consoles (the *.aramo.ai wildcard host);
# platform-web serves the platform console (the admin.aramo.ai site block).
COPY --from=web-builder /app/dist/apps/ats-web /srv/ats
COPY --from=web-builder /app/dist/apps/platform-web /srv/admin
# The parameterized front-door config (copied from the build context).
COPY deploy/caddy/Caddyfile /etc/caddy/Caddyfile

# Validate the adapted config at build time (Inc-3 PR-3.3 acceptance §4.2) —
# env vars are unset here so Caddy uses the in-Caddyfile defaults (localhost /
# admin.localhost, internal TLS). Fails the docker-build if the Caddyfile is
# malformed, so the check rides existing CI at zero new job cost.
RUN caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile

EXPOSE 80 443
