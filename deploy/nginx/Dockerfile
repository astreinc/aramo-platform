# Aramo — nginx front-door image (Front-Door Migration PR-2, ADR-0023). Built
# INERT: CI-gated + cutover-ready, but profile-gated in compose with no published
# ports until the PR-3 flip. Mirrors the retired front-door image's shape — identical
# web-builder stage (5 SPAs + the prisma:generate prerequisite), SPAs baked to
# /srv/{home,ats,admin,portal,sign}, front-door config + template copied in.
#
# Build from the REPO ROOT (the Nx build graph needs the whole workspace):
#   docker build -f deploy/nginx/Dockerfile -t aramo/nginx:local .
#
# NO secrets baked in: the FE calls same-origin RELATIVE paths.

# ---------- Stage 1: build ALL FIVE static SPAs (mirrors the retired front-door image) ------
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
# prerequisite as the retired front-door image; generated code is NOT bundled into any SPA).
RUN npm run prisma:generate

# Build ALL FIVE SPAs → dist/apps/{home-web,ats-web,platform-web,portal-web,sign-web}.
# D-ORG-2: home-web is the tenant host's App Home (served at `/`); ats-web is
# built with Vite base `/ats/` and served under `/ats/`.
RUN npx nx build aramo-home-web --skip-nx-cache
RUN npx nx build aramo-ats-web --skip-nx-cache
RUN npx nx build aramo-platform-web --skip-nx-cache
RUN npx nx build aramo-portal-web --skip-nx-cache
# Sign Unified Product S-2 — the ONE Aramo Sign application (workspace + guest
# signing) served by the sign host; the retired esign host only redirects.
# Personal (Free) — the public Turnstile site key is baked into the Sign bundle at
# build time (compose build arg from SIGN_TURNSTILE_SITE_KEY). Unset ⇒ no widget,
# and the backend refuses Personal signups (fail closed).
ARG VITE_SIGN_TURNSTILE_SITE_KEY=
ENV VITE_SIGN_TURNSTILE_SITE_KEY=${VITE_SIGN_TURNSTILE_SITE_KEY}
RUN npx nx build aramo-sign-web --skip-nx-cache

# ---------- Stage 2: config validation gate (§2.7 — mirrors the retired front door's config validate) ---
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
           NGINX_SIGN_SERVER_NAME=sign.localhost \
           NGINX_CERT_DIR=/tmp/aramo-ephemeral-certs; \
    mkdir -p "$NGINX_CERT_DIR"; \
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' \
      -keyout "$NGINX_CERT_DIR/privkey.pem" -out "$NGINX_CERT_DIR/fullchain.pem"; \
    envsubst '${NGINX_TENANT_SERVER_NAME} ${NGINX_ADMIN_SERVER_NAME} ${NGINX_PORTAL_SERVER_NAME} ${NGINX_SIGN_SERVER_NAME} ${NGINX_CERT_DIR}' \
      < /tmp/aramo.conf.template > /tmp/aramo.materialized.conf; \
    # nginx (unlike the retired front door) resolves literal-hostname upstreams at config-test time;
    # this build stage has no compose DNS and BuildKit mounts /etc/hosts read-only.
    # Validate a COPY with the known upstream service names rewritten to loopback:
    # the full config SYNTAX/structure (server_names, locations, headers, ssl,
    # client_max_body_size) is checked, and the upstreams become resolvable. The
    # SHIPPED template + runtime keep the literal `proxy_pass http://<svc>:<port>`
    # VERBATIM (§2.2) — this rewrite touches only the build-time syntax test. A
    # typo'd/unknown upstream name is NOT rewritten and still fails to resolve, so
    # name errors are still caught.
    sed -E 's#(proxy_pass http://)(api|auth-service|platform-admin|sign-service)(:)#\1127.0.0.1\3#g' \
      /tmp/aramo.materialized.conf > /etc/nginx/conf.d/aramo.conf; \
    nginx -t

# ---------- Stage 3: runtime nginx (SPAs + config baked in) ----------------------
FROM nginx:stable-alpine AS runtime
# GLH-2-A (GLH-2 Release Integrity, R3) — stamp the exact source revision into the
# artifact (OCI revision label). nginx runs no Node service, so there is no runtime
# ARAMO_RELEASE_REVISION / /version surface here — the label is the provenance.
ARG GIT_REVISION=unknown
LABEL org.opencontainers.image.revision=$GIT_REVISION
# The compiled SPAs — the only application artifacts this image carries.
COPY --from=web-builder /app/dist/apps/home-web /srv/home
COPY --from=web-builder /app/dist/apps/ats-web /srv/ats
COPY --from=web-builder /app/dist/apps/platform-web /srv/admin
COPY --from=web-builder /app/dist/apps/portal-web /srv/portal
COPY --from=web-builder /app/dist/apps/sign-web /srv/sign
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
# E19 defense-in-depth: image-level defaults make an unset var structurally
# impossible on EVERY run path (compose, bare `docker run`, the boot smoke).
# The official entrypoint's envsubst substitutes only DEFINED vars — an unset
# NGINX_* would otherwise be left as a literal `${NGINX_*}` and crash nginx
# ([emerg] unknown "nginx_cert_dir" variable — the 2026-07-26 window, E19). The
# image is now AUTHORITATIVE for the defaults; compose `${VAR:-default}` remains
# the operator-facing belt (D-FRONTDOOR-CUTOVER-1 Ruling A).
ENV NGINX_TENANT_SERVER_NAME=localhost \
    NGINX_ADMIN_SERVER_NAME=admin.localhost \
    NGINX_PORTAL_SERVER_NAME=portal.localhost \
    NGINX_SIGN_SERVER_NAME=sign.localhost \
    NGINX_CERT_DIR=/etc/letsencrypt/live/aramo.ai
# Drop the base image's default server so only our block is included.
RUN rm -f /etc/nginx/conf.d/default.conf
# Aramo Sign Mobile (directive §4 B-13, M-A2 §3.2) — the app-association files
# (/.well-known/apple-app-site-association, /.well-known/assetlinks.json) are
# rendered from SIGN_IOS_APP_ID / SIGN_ANDROID_PACKAGE / SIGN_ANDROID_CERT_SHA256S
# at EVERY container start by a dedicated entrypoint step (runs after
# 20-envsubst-on-templates.sh). It is separate from the template envsubst, so the
# ^NGINX_ filter above is untouched. Rendered once here with no env as well, so
# the image always carries valid associate-nothing JSON even on a run path that
# bypasses the entrypoint.
COPY deploy/nginx/app-links/render-app-links.sh /docker-entrypoint.d/40-aramo-app-links.sh
RUN chmod 0755 /docker-entrypoint.d/40-aramo-app-links.sh \
 && /docker-entrypoint.d/40-aramo-app-links.sh

EXPOSE 80 443
