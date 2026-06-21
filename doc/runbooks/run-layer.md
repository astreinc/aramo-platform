# Aramo — Run Layer (containerized runtime)

**Step-4 Directive 1 deliverable.** Baseline: `de512f8`. Account-independent —
builds and runs **locally** today; it gets *deployed* once the AWS account
exists (the compute-IaC directive). No app-code change, no new scope, no
migration.

This is the foundation everything deploys through: before compute IaC (Fargate
runs **images**), the services must be **containers**. The recon
(`doc/step4-deploy-substrate-recon.md`) confirmed the starting point — no
Dockerfiles, no registry, no deploy mechanism; the apps ran as plain
`node dist/...` processes orchestrated by the D5 harness.

---

## What ships

| Artifact | What it is |
|---|---|
| `apps/api/Dockerfile` | Production image for the `api` NestJS backend |
| `apps/auth-service/Dockerfile` | Production image for the `auth-service` NestJS backend |
| `.dockerignore` | Lean, secret-free build context for the Nx monorepo |
| `docker-compose.images.yml` | Overlay that runs the two backend **containers** on the D5 stack |
| `ats-web` static build | `dist/apps/ats-web/` — confirmed static SPA → **S3 + CloudFront**, not a container |

The two backend images plus the static `ats-web` build are the entire runtime.
`platform-admin` is out of scope for this directive (the directive names only
`api` + `auth-service`); its image follows the identical pattern when needed.

---

## A. The two backend images

Both Dockerfiles are **multi-stage** and produce a minimal production image:

- **Builder stage** (`node:24-bookworm-slim`): `npm ci` → `npm run prisma:generate`
  (all per-module clients) → `npx nx build <app>` (the app + its Nx lib graph) →
  `npm prune --omit=dev` → materialize the runtime wiring.
- **Runtime stage** (`node:24-bookworm-slim`, **non-root** `node` user): copies
  only the pruned production `node_modules` and the built `dist` — **no source,
  no dev deps, no `.env`.** `WORKDIR /app`, deterministic
  `CMD ["node", "dist/apps/<app>/src/main.js"]` — exactly today's boot.

### Why the "materialize" step exists (the Nx + Prisma wiring)

The `@nx/js:tsc` build only transpiles TS→JS. Two things the compiled output
needs at runtime are *not* in `dist` by default — the same gaps
`tools/local-run-link.sh` fills for host runs:

1. **`@aramo/*` path aliases** have no runtime resolution. The compiled apps
   `require("@aramo/<lib>")`; we point `node_modules/@aramo/<lib>` at the built
   `dist/libs/<lib>` (which carries its own `package.json` `main`).
2. **Per-module Prisma clients** generate to source-relative
   `libs/<lib>/prisma/generated/` — a path the compiled output at its `dist`
   depth can't reach. We copy each generated client into
   `dist/libs/<lib>/prisma/generated/`.

The Dockerfile **materializes** (real `cp`, not symlinks into the source tree)
so the runtime stage needs neither the lib source nor links into it. The
mechanism is identical to `local-run-link.sh`; it is reproduced inline so the
host D5 story is untouched.

> **Prisma engine note:** the schemas use the Prisma 7 client whose query
> compiler is **WASM** (`query_compiler_fast_bg.wasm`) — platform-independent,
> no native binary. Generation still runs *inside* the Linux builder for
> determinism.

### Base image / Node version

`node:24-bookworm-slim` resolves to the current Node 24 LTS-line patch (e.g.
24.17). `package.json` pins `engines.node` to `~24.4`; npm emits a non-fatal
`EBADENGINE` **warning** but the build proceeds (no `engine-strict`). Slim
Debian + `openssl`/`ca-certificates` is the "slim, current base" the directive
asked for. Pin a specific patch tag if exact-version parity is later required.

### Config is runtime env — NO secrets baked in

Config is read from `process.env` at runtime (the established pattern; the recon
confirmed it is already env-driven with no hardcoded localhost in shipped code).
**Nothing is baked into the image:** `.env`, keys, and `AKIA…` material are
excluded by `.dockerignore` and asserted absent in every layer (see §D).

### Healthcheck — zero app-code

The codebase ships **no `/health` route**, and this directive forbids app-code
change. Adding a route is unnecessary for liveness, so each image uses a
**TCP-connect** `HEALTHCHECK` against its own service port:

```
HEALTHCHECK CMD node -e "const s=require('net').connect(Number(process.env.PORT),'127.0.0.1');
  s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"
```

This proves the server is accepting connections with **no app code added**. A
real readiness endpoint (DB/Redis reachability) can be added later as a
deliberate app change if deployment wants deeper probing — flagged as a future
enhancement, intentionally **not** done here.

---

## B. ats-web serving model — CONFIRMED static SPA → S3 + CloudFront

`ats-web` is a **Vite/React static SPA**: `index.html` + `src/main.tsx` entry,
`vite build` → static assets in `dist/apps/ats-web/` (`outDir`), **no SSR, no
node runtime**. The FE reads no backend/auth env vars; backend URLs are
**relative paths** (`/v1`, `/auth`) resolved by a same-origin reverse proxy in
front of both backends (the FE has zero env knobs).

**Decision: `ats-web` deploys to S3 + CloudFront, NOT a container.** It consumes
the existing S3 data-plane module (`infrastructure/modules/s3-resume-bucket` is
the résumé bucket; the **static-site** bucket + CloudFront distribution is the
compute-IaC directive's work). Here we only **confirm the model** and **produce
the build artifact**:

```
npx nx build aramo-ats-web        # → dist/apps/ats-web/ (index.html + assets/)
```

CloudFront must serve `index.html` for all unmatched routes (SPA history-mode
fallback) and route `/v1` + `/auth` to the backend origin(s). That wiring is the
next (compute-IaC) directive — **not** built here.

> No node server is needed (no SSR), so **no HALT** — the serving model is
> unchanged from the static expectation.

---

## C. Local validation (account-independent)

The two backend images **build** and **boot in containers**, served via the D5
Postgres + Redis from `docker-compose.yml`. The overlay
`docker-compose.images.yml` swaps the `node dist/...` processes for the
containers on the **same network and seeded volume**.

```bash
# 0. (first time) bring the D5 stack up once so the DB volume is migrated+seeded
tools/local-stack.sh up && tools/local-stack.sh down   # leaves the seeded pg volume

# 1. load the env contract into the shell (handles the multi-line PEM keys that
#    compose's env_file parser cannot) and bring up the CONTAINERS
set -a && source .env && set +a
docker compose --env-file /dev/null \
  -f docker-compose.yml -f docker-compose.images.yml up --build -d

# 2. smoke — both containers serve a request
curl -i http://localhost:3001/.well-known/jwks.json     # auth-service → 200 JWKS
curl -i http://localhost:3000/v1/tenant/settings        # api → 401 (serving + authz live)

# 3. teardown
docker compose -f docker-compose.yml -f docker-compose.images.yml down
```

### Why `--env-file /dev/null` + shell pass-through

The real `.env` stores `AUTH_PRIVATE_KEY` / `AUTH_PUBLIC_KEY` as **literal
multi-line PEM**, which Docker Compose's `env_file` / project-`.env` parser
cannot read. So secrets are loaded into the **shell** (`source .env`, multi-line
safe) and passed to the containers by **bare name** under `environment:` (taken
verbatim from the process env). `--env-file /dev/null` stops compose from trying
to parse the multi-line `.env` for `${}` interpolation. `DATABASE_URL` /
`REDIS_URL` are pinned to the compose **service names** (`postgres`, `redis`) —
the `.env` values point at `localhost`, unreachable from inside the container.

### The D5 host-process path is preserved

`tools/local-stack.sh` (the `node dist/...` path) is **unchanged** and still
works. The overlay is purely additive — the same backing services, a different
way to run the two apps.

---

## D. No secrets in any image layer (assertion)

Asserted two ways:

1. **`.dockerignore` excludes** `.env`, `.env.*` (except `.env.example`), all
   `node_modules`, build output, and `**/prisma/generated` — the secret-bearing
   `.env` never enters the build context.
2. **Layer scan** (run after build):

```bash
# no .env anywhere in the filesystem of either image
docker run --rm --entrypoint sh aramo/api:local -c \
  'find / -name ".env" -o -name "*.pem" 2>/dev/null | grep -v /proc || echo NONE'
# no AKIA / PRIVATE KEY material in any layer's history
docker history --no-trunc aramo/api:local | grep -iE "AKIA|PRIVATE KEY" || echo "NONE"
```

Expected: `NONE`. Config arrives only as runtime env at `docker run` /
`compose up` time.

---

## Exit / handoff to compute-IaC

- Production Dockerfiles for `api` + `auth-service` — slim, non-root,
  env-driven, no baked secrets, TCP healthcheck. ✓
- `ats-web` confirmed static SPA + production build produced; **S3 + CloudFront**
  serving decision documented (wiring deferred to compute-IaC). ✓
- Containerized stack boots + smokes locally via the D5 harness; D5 host path
  preserved. ✓
- No secrets in any layer. ✓

**Next (separate directive):** push images to a registry (ECR) and run them on a
compute platform (Fargate) inside the VPC; provision the `ats-web` S3 static-site
bucket + CloudFront; build the in-VPC migration applier. All require the AWS
account that is being created out-of-band.
