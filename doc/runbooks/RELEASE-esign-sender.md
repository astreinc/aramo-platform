# Release runbook — Aramo Sign sender console (PX-1, esign.aramo.ai)

Status: **DEPLOY=NO.** Shipping this needs its own deployment authorization. The Lead Host & Workspace Ruling v1.0
forbids activating the production E-Sign host, enabling Personal sending or provisioning commercial entitlements without
separate authorization.

Governing: `Aramo-E-Sign-Product-Experience-V1-Implementation-Directive-v1_0-LOCKED` (PX-1) and
`Aramo-E-Sign-Host-and-Workspace-Architecture-Ruling-v1_0-LOCKED`.

## What ships

| Piece | Where |
|---|---|
| Sender API `/v1/esign/sender/*` (22 routes) | `apps/esign-service/src/app/sender/` |
| Sender console | `apps/esign-web` → baked into the nginx image at `/srv/esign` |
| Front door | `deploy/nginx/templates/aramo.conf.template` server block `${NGINX_ESIGN_SERVER_NAME}` |
| App Home Sign tile target | `/v1/me/products` esign `entry_path` = `https://esign.aramo.ai/` (dark) |

No database migration. No new scope or role (the `esign:envelope:*` scopes and `esign_*` roles already exist).

## Prerequisites before any deploy

1. **Host binding.** `libs/auth-core/src/lib/host-binding.ts` refuses PRODUCT-host logins under `enforce`
   (`host_class_consumer_mismatch`). Production runs `AUTH_HOST_TENANT_BINDING=log`, so login works but logs the
   mismatch. A Lead ruling is needed before moving to `enforce`.
2. **`AUTH_PRODUCT_HOSTS=esign.aramo.ai`** in `/opt/aramo/.env` (auth-service).
3. **Cognito** (outside Terraform): register `https://esign.aramo.ai/auth/esign/callback` and the sign-out URL
   `https://esign.aramo.ai/signed-out` on the app client.
4. **DNS / TLS**: `esign.aramo.ai` → the box; the wildcard `*.aramo.ai` certificate covers it.
5. **Object storage**: OWNED source PDFs use `S3_RESUME_BUCKET` (compose passes it to esign-service). PX-V1 F1 names a
   dedicated E-Sign bucket as the target (IaC from the Mac); browser uploads go through the API, so no bucket CORS is
   needed for this path.
6. **Entitlements**: a tenant needs the `esign` capability and users a Sign role. Granting either is a plan decision.

## Deploy order (when authorized)

1. Build all images (`deploy/build-images.sh`), including esign-service and nginx (now 6 SPAs).
2. Recreate `esign-service` first (nginx resolves `esign-service:3003` at config load), then `auth-service`, then `nginx`
   with `NGINX_ESIGN_SERVER_NAME=esign.aramo.ai`.
3. Smoke: `curl -sI https://esign.aramo.ai/` → 200; `curl -s https://esign.aramo.ai/v1/esign/sender/context` →
   401 `AUTH_REQUIRED`; `curl -s https://esign.aramo.ai/v1/esign/envelopes` → the SPA (never the internal surface).
4. Only with separate authorization: set `ARAMO_SIGN_ENTRY_ENABLED=true` on api to light the App Home tile.

## Local-only changes that must never reach production

| Local change | Where | Why it can't reach prod |
|---|---|---|
| Local mailbox `MAILER_PROVIDER=outbox`, `MAILER_OUTBOX_DIR`, `MAILER_OUTBOX_DELIVER_TO` | `tools/local-stack.sh`, local `.env` | Not in `docker-compose.prod.yml` (prod services take an explicit env list); the mailer refuses `outbox` when `NODE_ENV=production`; CI wall `env:passthrough-check` fails if any of these appear in the prod compose or a mail-sending service lacks `NODE_ENV=production` |
| `ESIGN_TENANT_HOST_URL_TEMPLATE=http://localhost:4205` | `tools/local-stack.sh` | Not passed in prod; code default is `https://{slug}.aramo.ai` |
| `ARAMO_SIGN_ENTRY_ENABLED` / `ARAMO_SIGN_ENTRY_URL` | local `.env` only (if set) | Not passed to api in prod → App Home Sign tile stays dark |
| Local `esign` entitlement grant for the Astre tenant | local Postgres only | Data, not code; prod grants are a separate plan decision |
| Real SES sends from the laptop (allowlisted inbox) | local `.env` AWS credentials | Laptop-only; prod uses its own `/opt/aramo/.env` |
| pdfjs-dist unpacked by hand into the shared `node_modules` | developer machine | The branch records it in `package.json` / lockfile, so CI and image builds install it normally |

Before any deploy: `npm run env:passthrough-check`, `node --import jiti/register ci/scripts/verify-frontdoor-conf.ts`,
`git diff origin/main -- docker-compose.prod.yml` reviewed line by line, and confirm the box's `/opt/aramo/.env` has no
`MAILER_OUTBOX_*`, `LOCAL_MAIL` or `SES_ENDPOINT` entries.

## Rollback

Recreate nginx without `NGINX_ESIGN_SERVER_NAME` (the block then answers only `esign.localhost`) and roll esign-service
back to the previous image tag. Nothing persistent changes: drafts created in the console stay in the esign schema.
