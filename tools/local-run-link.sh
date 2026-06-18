#!/usr/bin/env bash
# RUN/SERVE ENABLEMENT ONLY — links the built backends' runtime dependencies
# so the compiled apps (dist/apps/*) can run via plain `node`. No app logic is
# touched; everything created here lives under dist/ or node_modules/ (both
# gitignored). Idempotent — safe to re-run after `nx build`.
#
# Why each link is needed (the gaps that block `node dist/apps/<app>/src/main.js`):
#   1. @aramo/* — TS path aliases with no runtime resolution. The compiled
#      apps `require("@aramo/<lib>")`; we point node_modules/@aramo/<lib> at the
#      built dist/libs/<lib>.
#   2. Prisma clients are generated to SOURCE-relative locations the compiled
#      output can't reach at its dist depth:
#        - 25 libs:  libs/<lib>/prisma/generated  → link dist/libs/<lib>/prisma
#        - ai-draft: libs/ai-draft/node_modules/.prisma → link the node_modules
#
# Usage:
#   nx run-many -t build -p api auth-service     # produce dist/
#   bash tools/local-run-link.sh                 # create the runtime links
#   npm run db:sync:local                        # apply any NEW migrations to the dev DB
#   set -a && source .env && set +a
#   PORT=3001 node dist/apps/auth-service/src/main.js
#   PORT=3000 node dist/apps/api/src/main.js
#
# After ANY schema change (a new prisma migration), run `npm run db:sync:local`
# to apply it to the local dev DB — see doc/runbooks/local-db-sync.md. That is
# the durable replacement for hand-applying migration SQL.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 1. @aramo/* → dist/libs/*
mkdir -p node_modules/@aramo
for d in dist/libs/*/; do
  name="$(basename "$d")"
  ln -sfn "$ROOT/dist/libs/$name" "node_modules/@aramo/$name"
done

# 2a. prisma/generated clients (25 libs) → dist/libs/<lib>/prisma
for p in libs/*/prisma; do
  lib="$(basename "$(dirname "$p")")"
  if [ -d "dist/libs/$lib" ] && [ -d "$p/generated" ]; then
    ln -sfn "$ROOT/$p" "dist/libs/$lib/prisma"
  fi
done

# 2b. nested node_modules/.prisma clients (ai-draft pattern) → dist/libs/<lib>/node_modules
for nm in libs/*/node_modules; do
  lib="$(basename "$(dirname "$nm")")"
  if [ -d "dist/libs/$lib" ] && [ -d "$nm/.prisma" ]; then
    ln -sfn "$ROOT/$nm" "dist/libs/$lib/node_modules"
  fi
done

echo "local-run links ready (@aramo + prisma clients) under dist/ + node_modules/"
