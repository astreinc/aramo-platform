# Aramo — nginx front-door image (Front-Door Migration PR-2, ADR-0023). Built
# INERT: CI-gated + cutover-ready, but profile-gated in compose with no published
# ports until the PR-3 flip. Mirrors deploy/caddy/Dockerfile's shape — identical
# web-builder stage (3 SPAs + the prisma:generate prerequisite), SPAs baked to
# /srv/{ats,admin,portal}, front-door config + template copied in.
#
# Build from the REPO ROOT (the Nx build graph needs the whole workspace):
#   docker build -f deploy/nginx/Dockerfile -t aramo/nginx:local .
#
# NO secrets baked in: the FE calls same-origin RELATIVE paths.

# ---------- Stage 1: build ALL THREE static SPAs (mirrors the Caddy image) ------
FROM node:24-bookworm-slim AS web-builder
WORKDIR /app

# Prisma's generator needs openssl/ca-certs (platform-web's nx graph pulls a
# Prisma-backed lib via the committed Platform⊥ATS negative-control fixture).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Per-module Prisma clients — REQUIRED before the platform-web build (same graph
# prerequisite as the Caddy image; generated code is NOT bundled into any SPA).
RUN npm run prisma:generate

# Build ALL THREE SPAs → dist/apps/{ats-web,platform-web,portal-web}.
RUN npx nx build aramo-ats-web --skip-nx-cache
RUN npx nx build aramo-platform-web --skip-nx-cache
RUN npx nx build aramo-portal-web --skip-nx-cache

# ---------- Stage 2: config validation gate (§2.7 — mirrors `caddy validate`) ---
# Materialize the template with DEFAULT env against an EPHEMERAL self-signed cert
# and run `nginx -t`. A malformed template fails the docker build, so the check
# rides the new CI matrix entry at zero extra jobs. Everything here is discarded —
# the runtime stage below carries nothing from this stage except the validated
# nginx.conf (the COPY that also forces this gate to run).
FROM nginx:stable-alpine AS conf-validate
RUN apk add --no-cache openssl
COPY deploy/nginx/nginx.conf /etc/nginx/nginx.conf
COPY deploy/nginx/templates/aramo.conf.template /tmp/aramo.conf.template
RUN set -eux; \
    rm -f /etc/nginx/conf.d/default.conf; \
    export NGINX_TENANT_SERVER_NAME=localhost \
           NGINX_ADMIN_SERVER_NAME=admin.localhost \
           NGINX_PORTAL_SERVER_NAME=portal.localhost \
           NGINX_CERT_DIR=/tmp/aramo-ephemeral-certs; \
    mkdir -p "$NGINX_CERT_DIR"; \
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' \
      -keyout "$NGINX_CERT_DIR/privkey.pem" -out "$NGINX_CERT_DIR/fullchain.pem"; \
    envsubst '${NGINX_TENANT_SERVER_NAME} ${NGINX_ADMIN_SERVER_NAME} ${NGINX_PORTAL_SERVER_NAME} ${NGINX_CERT_DIR}' \
      < /tmp/aramo.conf.template > /tmp/aramo.materialized.conf; \
    # nginx (unlike Caddy) resolves literal-hostname upstreams at config-test time;
    # this build stage has no compose DNS and BuildKit mounts /etc/hosts read-only.
    # Validate a COPY with the known upstream service names rewritten to loopback:
    # the full config SYNTAX/structure (server_names, locations, headers, ssl,
    # client_max_body_size) is checked, and the upstreams become resolvable. The
    # SHIPPED template + runtime keep the literal `proxy_pass http://<svc>:<port>`
    # VERBATIM (§2.2) — this rewrite touches only the build-time syntax test. A
    # typo'd/unknown upstream name is NOT rewritten and still fails to resolve, so
    # name errors are still caught.
    sed -E 's#(proxy_pass http://)(api|auth-service|platform-admin)(:)#\1127.0.0.1\3#g' \
      /tmp/aramo.materialized.conf > /etc/nginx/conf.d/aramo.conf; \
    nginx -t

# ---------- Stage 3: runtime nginx (SPAs + config baked in) ----------------------
FROM nginx:stable-alpine AS runtime
# The compiled SPAs — the only application artifacts this image carries.
COPY --from=web-builder /app/dist/apps/ats-web /srv/ats
COPY --from=web-builder /app/dist/apps/platform-web /srv/admin
COPY --from=web-builder /app/dist/apps/portal-web /srv/portal
# The validated nginx.conf (COPY --from=conf-validate forces the §2.7 gate to run,
# and carries the byte-identical validated config forward — nothing else from the
# validation stage reaches runtime: no ephemeral cert, no materialized conf).
COPY --from=conf-validate /etc/nginx/nginx.conf /etc/nginx/nginx.conf
# The template stays a TEMPLATE at runtime — the official image's entrypoint runs
# envsubst over /etc/nginx/templates/*.template → /etc/nginx/conf.d/ at start.
COPY deploy/nginx/templates/aramo.conf.template /etc/nginx/templates/aramo.conf.template
# Only the four ${NGINX_*} vars are substituted; every nginx runtime var ($host,
# $uri, $scheme, …) is left literal.
ENV NGINX_ENVSUBST_FILTER=^NGINX_
# Drop the base image's default server so only our block is included.
RUN rm -f /etc/nginx/conf.d/default.conf

EXPOSE 80 443
