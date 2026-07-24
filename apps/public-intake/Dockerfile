# Aramo — apps/public-intake (PUB-5 intake handler) production image.
#
# A standalone NestJS service with ZERO @aramo/* dependencies (its nx build
# pulls no workspace libs, so there is no Prisma generate step and no @aramo
# symlink wiring — unlike the api/platform-admin images). node:24-bookworm-slim,
# non-root, prod-deps-only, healthcheck on /intake/healthz.
#
# Build from the REPO ROOT (the workspace lockfile lives there):
#   docker build -f apps/public-intake/Dockerfile -t aramo/public-intake:local .
#
# NO secrets baked in — AWS credentials arrive at runtime via the SDK default
# chain (host .env → container env), region + addresses via env.

# ---------- Stage 1: builder ----------
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# Deterministic install first (cache layer keyed on the lockfile only). The
# public-intake workspace member is absent at this point; npm ci tolerates that
# and installs the root dependency set the build needs.
COPY package.json package-lock.json ./
RUN npm ci || npm ci || npm ci # retry: free-email-domains postinstall fetches 3 third-party hosts and hard-exits on a transient ETIMEDOUT

# Workspace source (.dockerignore keeps out node_modules/dist/.env/secrets).
COPY . .

# tsc-compile public-intake only (dependsOn: [] — no lib graph, no Prisma).
RUN npx nx build public-intake --skip-nx-cache

# Drop dev dependencies — prod node_modules only.
RUN npm prune --omit=dev

# ---------- Stage 2: runtime (slim, non-root) ----------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

USER node
EXPOSE 3000

# Liveness via the app's own healthz route (compose reuses this endpoint).
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/intake/healthz',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/apps/public-intake/src/main.js"]
