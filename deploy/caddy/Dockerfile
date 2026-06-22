# Aramo — Single-Box prod front-door image (Directive 1).
#
# Self-contained (matches D1's containerized philosophy): a multi-stage build
# compiles the ats-web static SPA and bakes it into a Caddy image at /srv, so
# the front-door ships as ONE artifact (no mounted static volume to manage on
# the box). Caddy serves the SPA and path-routes /v1→api, /auth→auth-service;
# TLS + domain are RUNTIME-parameterized via the Caddyfile env vars (see
# docker-compose.prod.yml / .env.prod.example).
#
# Build from the REPO ROOT (the Nx build graph needs the whole workspace):
#   docker build -f deploy/caddy/Dockerfile -t aramo/caddy:local .
#
# NO secrets baked in: the FE calls same-origin RELATIVE paths, so there is no
# API URL — or anything else — to embed at build time.

# ---------- Stage 1: build the ats-web static SPA ----------
FROM node:24-bookworm-slim AS web-builder
WORKDIR /app

# Deterministic install first (cache layer keyed on the lockfile only).
COPY package.json package-lock.json ./
RUN npm ci

# Workspace source (.dockerignore keeps out node_modules/dist/.env/secrets).
COPY . .

# Build ats-web + its Nx lib graph (fe-foundation) → dist/apps/ats-web.
# ats-web is a pure FE app (no Prisma in its dependency graph), so — unlike the
# D1 backend images — no `prisma:generate` step is needed.
RUN npx nx build aramo-ats-web --skip-nx-cache

# ---------- Stage 2: Caddy front-door (static baked in) ----------
FROM caddy:2-alpine AS runtime
# The compiled SPA — the only application artifact this image carries.
COPY --from=web-builder /app/dist/apps/ats-web /srv
# The parameterized front-door config (copied from the build context).
COPY deploy/caddy/Caddyfile /etc/caddy/Caddyfile

EXPOSE 80 443
