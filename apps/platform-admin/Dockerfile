# Aramo — apps/platform-admin (NestJS platform-console backend) production image.
# Inc-3 PR-3.3: containerize platform-admin as a real production service.
# Mirrors apps/api/Dockerfile's shape 1:1 (multi-stage Nx build → minimal prod
# image; built dist + production node_modules only; no dev deps, no source).
# Config is RUNTIME env-driven — NO secrets are baked in.
#
# Build from the REPO ROOT (the Nx build graph needs the whole workspace):
#   docker build -f apps/platform-admin/Dockerfile -t aramo/platform-admin:local .
#
# Boot mirrors `PORT=3002 node dist/apps/platform-admin/src/main.js`.

# ---------- Stage 1: builder (full toolchain) ----------
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

# Per-module Prisma clients (WASM engine, platform-independent) — must exist
# before the tsc build because the libs (identity/entitlement/common) import
# the generated client types.
RUN npm run prisma:generate

# Build platform-admin + its Nx lib dependency graph → dist/apps/platform-admin
# + dist/libs/*.
RUN npx nx build platform-admin --skip-nx-cache

# Drop dev dependencies (nx, prisma CLI, test tooling) — prod node_modules only.
RUN npm prune --omit=dev

# Reproduce the runtime wiring the compiled output expects (same mechanism as
# apps/api/Dockerfile — materialized into dist so the runtime stage needs
# neither the lib source tree nor symlinks into it):
#   - node_modules/@aramo/<lib>  -> /app/dist/libs/<lib>  (TS path-alias runtime)
#   - dist/libs/<lib>/prisma/generated  (the generated Prisma client)
RUN set -eux; \
    mkdir -p node_modules/@aramo; \
    for d in dist/libs/*/; do n="$(basename "$d")"; ln -sfn "/app/dist/libs/$n" "node_modules/@aramo/$n"; done; \
    for p in libs/*/prisma; do \
      lib="$(basename "$(dirname "$p")")"; \
      if [ -d "dist/libs/$lib" ] && [ -d "$p/generated" ]; then \
        mkdir -p "dist/libs/$lib/prisma"; \
        cp -R "$p/generated" "dist/libs/$lib/prisma/generated"; \
      fi; \
    done; \
    for nm in libs/*/node_modules; do \
      lib="$(basename "$(dirname "$nm")")"; \
      if [ -d "dist/libs/$lib" ] && [ -d "$nm/.prisma" ]; then \
        mkdir -p "dist/libs/$lib/node_modules"; \
        cp -R "$nm/.prisma" "dist/libs/$lib/node_modules/.prisma"; \
      fi; \
    done

# ---------- Stage 2: runtime (slim, non-root) ----------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3002
WORKDIR /app

# Only the resolved prod node_modules (incl. @aramo symlinks) + built dist.
# No source, no dev deps, no .env — config arrives as runtime env.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

USER node
EXPOSE 3002

# Liveness via a TCP connect to the service port — zero app-code change
# (the codebase ships no /health route; see doc/runbooks/run-layer.md).
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "const s=require('net').connect(Number(process.env.PORT)||3002,'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"

CMD ["node", "dist/apps/platform-admin/src/main.js"]
