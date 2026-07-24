# Aramo — public marketing site image (PUB-1 PR-1b, §3.1). Replaces the PR-1a
# placeholder with the real multi-stage build.
#
# BAKED CONFIG: the Astro dist, the holding page, and nginx.conf are baked into
# the image. A config or content change needs an image REBUILD + container
# RECREATE — not a live edit (the deploy/caddy image precedent).
#
# Build from the REPO ROOT (the Nx build graph needs the whole workspace):
#   docker build -f deploy/public/Dockerfile -t aramo/public-web:local .
#
# NO secrets baked in. The staging basic-auth htpasswd and the TLS certs arrive
# as MOUNTED volumes at runtime (see docker-compose.public.yml / README.md).

# ---------- Stage 1: build the Astro static site ----------
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# Prisma's generator + WASM query-compiler need openssl/ca-certs present.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Deterministic install first (cache layer keyed on the lockfile only).
COPY package.json package-lock.json ./
RUN npm ci

# Workspace source (.dockerignore keeps out node_modules/dist/.env/secrets).
COPY . .

# Per-module Prisma clients — REQUIRED before `nx build public-web`. public-web
# is a scope:public leaf, but its Nx project graph includes @aramo/engagement
# (scope:ats, Prisma-backed) via the COMMITTED Public⊥ATS negative-control
# fixture — a deliberate graph edge (excluded from public-web's own compile, but
# present at graph-compute time so the boundary lint can fire on it). The `build`
# target's default `^build` therefore builds engagement + its Prisma-backed deps
# first, and those need the generated clients. The generated code is NOT in the
# static dist (Astro emits only the pages); this is a build-time prerequisite.
RUN npm run prisma:generate

# Build the Astro site → apps/public-web/dist (+ the upstream build tasks).
RUN npx nx build public-web --skip-nx-cache

# CSP HASH DRIFT GATE (R-PUB5-7): assert the built inline-script hashes equal the
# nginx CSP script-src allow-list EXACTLY. dist/ and nginx.conf are both present
# here, so the image build IS the gate — an Astro upgrade that changes the inline
# hydration bootstrap fails the build until nginx.conf's hashes are updated.
RUN node deploy/public/verify-csp-hashes.mjs

# ---------- Stage 2: nginx front-door (site + holding page baked) ----------
FROM nginx:alpine AS runtime

# Self-signed FALLBACK cert at the mounted cert path, so nginx boots (and
# `nginx -t` passes) when /etc/letsencrypt is not mounted. The prod letsencrypt
# volume shadows this directory with the real certbot cert.
RUN apk add --no-cache openssl \
 && mkdir -p /etc/letsencrypt/live/aramo.ai \
 && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
      -keyout /etc/letsencrypt/live/aramo.ai/privkey.pem \
      -out /etc/letsencrypt/live/aramo.ai/fullchain.pem \
      -subj "/CN=aramo.ai" \
      -addext "subjectAltName=DNS:aramo.ai,DNS:www.aramo.ai,DNS:staging.aramo.ai" \
 && mkdir -p /var/www/certbot

# The full Astro site (staging.aramo.ai) and the apex holding page.
COPY --from=builder /app/apps/public-web/dist /usr/share/nginx/site
COPY deploy/public/holding /usr/share/nginx/holding

# The baked, hardened front-door config (replaces the stock default).
COPY deploy/public/nginx.conf /etc/nginx/nginx.conf

# Validate the baked config at build time (mirrors deploy/caddy's `caddy
# validate`) — fails the docker-build on a malformed nginx.conf at zero new CI
# cost. The self-signed fallback above lets this run without a mounted volume.
RUN nginx -t

EXPOSE 80 443

# Foreground nginx (nginx:alpine's default CMD; restated for clarity).
CMD ["nginx", "-g", "daemon off;"]
