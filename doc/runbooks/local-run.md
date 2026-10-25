# Runbook — local run/serve (the full stack)

**§5 Auth-Hardening D5 (3.6) Part A.** Ends the hand-run `node dist/...` story.
One command brings up the whole local stack — **Postgres + Redis + `auth-service`
(:3001) + `api` (:3000) + `ats-web` (:4201)** — reproducibly, from this doc.

> Operability only — no production auth change. Local browser login (a real
> session through a login UI) needs a real IdP; that's the recon-gated Part B
> (see the bottom). Staging (Step 4) has real Cognito, so the §5 staging-deferred
> login confirmations are verified there regardless.

## Prerequisites

- **Docker** (for Postgres + Redis) — `docker compose` v2.
- **Node** (repo toolchain) + `npm ci` already run.
- **psql / libpq** for `db:sync:local` (`brew install libpq`; the script also
  finds the keg-only `/opt/homebrew/opt/libpq/bin/psql`).
- **OpenSSL** (to generate the session-signing keys, once).

## 1. Configure `.env` (once)

```sh
cp .env.example .env
```

`.env.example` already carries local-sensible defaults for everything except the
secrets you must generate. The keys the stack needs locally:

| Key | Local value | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://aramo:aramo@localhost:5432/aramo?schema=public` | matches `docker-compose.yml` |
| `REDIS_URL` | `redis://localhost:6379` | BullMQ queues |
| `AUTH_PRIVATE_KEY` / `AUTH_PUBLIC_KEY` | generate (below) | RS256 session signing — never commit |
| `AUTH_PKCE_STATE_KEY` | `openssl rand -base64 32` | PKCE state cipher |
| `AUTH_AUDIENCE` | `aramo-local` | |
| **`AUTH_PUBLIC_BASE_URL`** | `http://localhost:4201` | **required for login** — auth-service derives the hosted-UI callback per consumer as `${AUTH_PUBLIC_BASE_URL}/auth/<consumer>/callback` at authorize + token-exchange (Amendment v1.2). Use `localhost` (not `127.0.0.1`) so it matches the vite dev host and the host-only PKCE cookie survives the callback. Register each derived callback on the Cognito app client. |
| `AUTH_COGNITO_REDIRECT_URI` | *(deprecated)* | Amendment v1.2 fallback only — if `AUTH_PUBLIC_BASE_URL` is unset, its **origin** is used as the base. Prefer `AUTH_PUBLIC_BASE_URL`. |
| **`AUTH_POST_LOGIN_REDIRECT`** | `http://localhost:4201` | **required** — `/callback` 302s here; throws if unset (D2). Setting it is what makes `auth.integration` test-39 pass off-CI. |
| **`AUTH_COGNITO_SIGNOUT_REDIRECT`** | `http://localhost:4201/login` | **required** — Cognito `/logout` return URL; throws if unset (D3). |
| `AUTH_ALLOW_INSECURE_COOKIES` | `true` | local http; prod still forces Secure via `NODE_ENV=production` |
| `AUTH_COGNITO_*` (domain/client/pools/issuer) | real Cognito values | needed only for the **login** flow (Part B) — the stack BOOTS without them; they're read at request time |

Generate the session-signing keypair (paste both PEMs into `.env`, double-quoted
— dotenv supports multiline values):

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /tmp/aramo_priv.pem
openssl pkey -in /tmp/aramo_priv.pem -pubout -out /tmp/aramo_pub.pem
# then in .env:  AUTH_PRIVATE_KEY="$(cat /tmp/aramo_priv.pem)"  /  AUTH_PUBLIC_KEY="$(cat /tmp/aramo_pub.pem)"
```

## 2. Bring the stack up

```sh
tools/local-stack.sh up
```

That single command runs the whole sequence:

1. `docker compose up -d` — Postgres + Redis (waits for Postgres ready).
2. `tools/db-sync-local.sh` — applies every migration to the dev DB (see
   [`local-db-sync.md`](./local-db-sync.md)).
3. seeds the identity role/scope catalog.
4. `nx build api auth-service`.
5. `tools/local-run-link.sh` — links `@aramo/*` + Prisma clients so `node dist/`
   resolves at runtime.
6. starts the three apps in the background (logs under `.local-stack/`).

When it's up:

- **FE** → http://localhost:4201 (vite proxies `/auth`→:3001, `/v1`→:3000, so
  everything is one origin and the HttpOnly session cookie binds cleanly)
- **api** → :3000 · **auth-service** → :3001

```sh
tools/local-stack.sh status     # what's running (apps + infra)
tools/local-stack.sh logs       # tail app logs
tools/local-stack.sh down       # stop the 3 apps + docker compose down
```

Faster restarts: `SKIP_BUILD=1 tools/local-stack.sh up` (reuse `dist/`),
`SKIP_SEED=1` (skip the catalog seed). A schema change still needs
`tools/db-sync-local.sh` (auto-run by `up`).

## App Home and the tenant-host topology locally (D-ORG)

Production serves one tenant host: App Home at `/`, Organization Administration at `/org/`, the ATS at `/ats/`
(nginx). Locally the same topology lives on **http://localhost:4205** — the App Home dev server forwards `/ats/` to
the ATS dev server (:4201), so App Home → ATS works on one origin with one cookie jar. The ATS is also reachable
directly at http://localhost:4201/ats/ (`/` and `/ats` redirect to `/ats/`).

Each consumer signs in through its own callback, derived from the host you browse on. Cognito accepts only exact
registered URLs, so the app client needs, per local origin you use:

| Origin | Callback URLs | Sign-out URL |
|---|---|---|
| `http://localhost:4205` (App Home topology) | `/auth/org/callback`, `/auth/recruiter/callback` | `/signed-out` |
| `http://localhost:4201` (ATS directly) | `/auth/recruiter/callback` (existing) | `/signed-out` |
| `http://localhost:4206` (Aramo Sign sender console) | `/auth/sign/callback` | `/signed-out` |

A missing one shows Cognito's `redirect_mismatch` page.

## Aramo Sign locally (one app: workspace + guest signing)

`tools/local-stack.sh up` also starts the one Aramo Sign application (`apps/sign-web`) on **http://localhost:4206** —
the local stand-in for `sign.aramo.ai`. Its workspace signs in as the `esign` consumer; the dev server proxies `/auth` →
auth-service, `/v1/esign/{sender,billing,signing}` → esign-service and `/v1/signup/sign` → platform-admin. `/` opens the
workspace the backend assigns: `/sign/` for a business tenant, `/personal/` for a personal tenant. Requirements:

- the tenant holds the Sign subscription (`entitlement."TenantEntitlement"` row `esign`) and the user a Sign role
  (Sign Owner / Admin / Sender to send — a Sender sees only their own envelopes; Sign Viewer reads every envelope);
- `/auth/sign/callback` and `/signed-out` on `http://localhost:4206` are registered on the Cognito app client;
- PDF uploads use the same local object storage as résumés (`S3_RESUME_BUCKET` / `S3_ENDPOINT` from `.env`).

Signers open `http://localhost:4206/s/<token>` (the guest-signing zone of the same app; no sign-in). Local email goes to a **local outbox** instead of any
email service: `tools/local-stack.sh` sets `MAILER_PROVIDER=outbox` and `MAILER_OUTBOX_DIR=.local-stack/mail`, so every
invitation, reminder and completion email is written there. Read them, with their links, with:

```sh
node tools/local-mail.cjs        # latest 10 (or: node tools/local-mail.cjs 30)
```

To also receive real emails in your own inbox, list your address(es) in `.env` — only these go through SES (needs
`SES_FROM_ADDRESS` and the local AWS credentials), every other recipient stays in the local outbox:

```sh
MAILER_OUTBOX_DELIVER_TO=you@example.com
SES_FROM_ADDRESS="Aramo <support@aramo.ai>"
```

`LOCAL_MAIL=stub tools/local-stack.sh up` restores the log-only stub. The outbox mailer refuses to start when
`NODE_ENV=production`. The console's links back to App Home / Organization use `ESIGN_TENANT_HOST_URL_TEMPLATE`
(local-stack default `http://localhost:4205`). Each SPA dev server keeps its own Vite dependency cache
(`node_modules/.vite/<app>`); if a page ever renders blank with `504 Outdated Optimize Dep` in the console, stop the
server, delete that app's cache folder and start it again.

## test-39 (auth.integration) — fixed

`auth.integration` test-39 (`/callback` issues cookies) drives the login-success
path, which 302s to `AUTH_POST_LOGIN_REDIRECT` and **throws when it's unset**. CI
set it ambiently → green; a local run did not → failed. The spec now sets
`AUTH_POST_LOGIN_REDIRECT` (and `AUTH_COGNITO_SIGNOUT_REDIRECT`) in its own
`beforeAll`, so it is **self-contained** — test-39 passes locally and in CI with
no ambient env. To run the DB-gated integration suites locally (Docker required):

```sh
ARAMO_RUN_INTEGRATION=1 npx nx test auth-service
```

## Known local flake — `auth.site-axis.integration`

`auth.site-axis.integration.spec.ts` spins its own Postgres **testcontainer**
(it uses the REAL TenantService/RoleService, unlike `auth.integration` which
stubs them). On some machines the container start/port-map is slow and the spec
intermittently times out on the first cold run — a **Docker/testcontainer
flake, not a logic failure**. Workaround: pre-pull the image
(`docker pull postgres:17`) and re-run; it passes on a warm Docker. It is not in
the standard CI gate (the testcontainer suites run under `ARAMO_RUN_INTEGRATION=1`).

## Login locally (Part B — recon-gated)

The stack boots and serves every surface, but a **real browser login**
(recruiter/admin → Cognito hosted-UI → session) needs a real IdP. Two existing
paths today:

- The live e2e (`apps/ats-web/e2e/`) drives **real Cognito** against this local
  stack — provide `RC_E2E_USERNAME` / `RC_E2E_PASSWORD` for a least-privilege
  test recruiter (see `apps/ats-web/e2e/README.md`).
- A **local mock-IdP** (so login runs with no real Cognito) is the §5 D5 Part B
  recon item — strongly preferred over any bypass, but only if it's
  prod-impossible by construction. Until it lands, local login uses real Cognito
  (above) or defers to staging.
