# Aramo — apps/talent-intelligence-service (ATI-SEP-1 T0, ADR-0036) production image.
# Mirrors apps/sign-service/Dockerfile: multi-stage Nx build → minimal prod image
# (built dist + production node_modules only; no dev deps, no source). Config is
# RUNTIME env-driven (INTELLIGENCE_DATABASE_URL) — NO secrets are baked in.
#
# Build from the REPO ROOT (the Nx build graph needs the whole workspace):
#   docker build -f apps/talent-intelligence-service/Dockerfile -t aramo/talent-intelligence-service:local .
#
# Boot mirrors `PORT=3004 node dist/apps/talent-intelligence-service/src/main.js`.

# ---------- Stage 1: builder (full toolchain) ----------
FROM node:24-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Per-module Prisma clients (incl. libs/intelligence-core) before the tsc build.
RUN npm run prisma:generate

RUN npx nx build talent-intelligence-service --skip-nx-cache

RUN npm prune --omit=dev

# Same runtime wiring as apps/sign-service/Dockerfile (materialized into dist):
#   - node_modules/@aramo/<lib>  -> /app/dist/libs/<lib>
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
    done

# ---------- Stage 2: runtime (slim, non-root) ----------
FROM node:24-bookworm-slim AS runtime
ARG GIT_REVISION=unknown
LABEL org.opencontainers.image.revision=$GIT_REVISION
ENV NODE_ENV=production \
    PORT=3004 \
    ARAMO_RELEASE_REVISION=$GIT_REVISION
WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

USER node
EXPOSE 3004

# Real readiness: GET /health answers 200 only when the TI database responds.
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:Number(process.env.PORT)||3004,path:'/health',timeout:2500},(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/apps/talent-intelligence-service/src/main.js"]
