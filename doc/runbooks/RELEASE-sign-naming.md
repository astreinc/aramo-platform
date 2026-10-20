# Release runbook — Aramo Sign naming unification (esign → sign)

**Governing:** `Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED` (SHA-256 `fa0c08def6146cf5168ea6d074ab779d457bd0bfc6f752c5561a8cc54de97ed5`).

**Status: DEPLOY=NO.** Each production step below needs its own explicit authorization (§5): the merge, the production migration and deploy, the Cognito and `.env` changes, and executing the maintenance window. Earlier Sign runbooks use the old names and are historical.

## What changes

| Surface | Before | After |
|---|---|---|
| Service, compose service, container | `esign-service`, `aramo-prod-esign` | `sign-service`, `aramo-prod-sign` |
| Image | `aramo/esign-service` | `aramo/sign-service` (`ARAMO_SIGN_IMAGE`) |
| Database schema | `esign` | `sign` (`ALTER SCHEMA … RENAME`) |
| API | `/v1/esign/*`, `/v1/integrations/esign/events` | `/v1/sign/*`, `/v1/integrations/sign/events` |
| Webhook and S2S wire | `x-aramo-esign-*`, `aramo-esign-s2s-v1`, `esign.envelope.*` | `x-aramo-sign-*`, `aramo-sign-s2s-v1`, `sign.envelope.*` (historical names still accepted) |
| Auth consumer | `esign`: `/auth/esign/*`, cookies `aramo_*_esign` | `sign`: `/auth/sign/*`, cookies `aramo_*_sign` |
| Roles and scopes | `esign_*` (4), `esign:*` (13) | `sign_*`, `sign:*` (grants unchanged, linked by id) |
| Capability, product key | `esign` | `sign` |
| Subscription keys | `esign.envelopes` and the others | `sign.*` |
| Env vars | `ESIGN_*` (27 keys) | `tools/sign-naming/env-map.tsv` |

**Kept as they are (P-1 … P-5):**
- the `ESIGN_*` error codes and the `esign_role_not_entitled` reason;
- E-SIGN Act legal text;
- `/v1/webhooks/esignature/*`;
- historical `migration.sql` files;
- `SignatureEvent`, executed evidence, and delivered or dead outbox and delivery rows;
- object storage keys (`esign/source/…`) and capacity refs (`esign:executed:…`), which are addresses of stored data.

## `.env` key map (27 renamed; values carried over byte for byte)

Source of truth: `tools/sign-naming/env-map.tsv`. Applied by `tools/sign-naming/env-rename.sh`.

| Old key | New key |
|---|---|
| `ESIGN_ATS_CLIENT_ID` | `SIGN_ATS_CLIENT_ID` |
| `ESIGN_ATS_CLIENT_SECRET` | `SIGN_ATS_CLIENT_SECRET` |
| `ESIGN_ATS_TRANSPORT` | `SIGN_ATS_TRANSPORT` |
| `ESIGN_BILLING_RECONCILE_ENABLED` | `SIGN_BILLING_RECONCILE_ENABLED` |
| `ESIGN_BILLING_RECONCILE_INTERVAL_MS` | `SIGN_BILLING_RECONCILE_INTERVAL_MS` |
| `ESIGN_DELIVERY_INTERVAL_MS` | `SIGN_DELIVERY_INTERVAL_MS` |
| `ESIGN_DELIVERY_WORKER_ENABLED` | `SIGN_DELIVERY_WORKER_ENABLED` |
| `ESIGN_DISCLOSURE_VERSION` | `SIGN_DISCLOSURE_VERSION` |
| `ESIGN_ENVELOPE_TTL_DAYS` | `SIGN_ENVELOPE_TTL_DAYS` |
| `ESIGN_EVENTS_SUBSCRIPTION_SECRET` | `SIGN_EVENTS_SUBSCRIPTION_SECRET` |
| `ESIGN_EVENT_BUS_TOPIC_ARN` | `SIGN_EVENT_BUS_TOPIC_ARN` |
| `ESIGN_EXECUTED_ACCESS_TTL_DAYS` | `SIGN_EXECUTED_ACCESS_TTL_DAYS` |
| `ESIGN_EXPIRY_INTERVAL_MS` | `SIGN_EXPIRY_INTERVAL_MS` |
| `ESIGN_EXPIRY_WORKER_ENABLED` | `SIGN_EXPIRY_WORKER_ENABLED` |
| `ESIGN_KMS_KEY_ID` | `SIGN_KMS_KEY_ID` |
| `ESIGN_KMS_SIGNING_ALGORITHM` | `SIGN_KMS_SIGNING_ALGORITHM` |
| `ESIGN_S2S_AUTH_LOG_UNTIL` | `SIGN_S2S_AUTH_LOG_UNTIL` |
| `ESIGN_S2S_AUTH_MODE` | `SIGN_S2S_AUTH_MODE` |
| `ESIGN_SENDER_WEB_BASE_URL` | `SIGN_SENDER_WEB_BASE_URL` |
| `ESIGN_SERVICE_URL` | `SIGN_SERVICE_URL` |
| `ESIGN_SIGN_WEB_BASE_URL` | `SIGN_WEB_BASE_URL` |
| `ESIGN_TENANT_HOST_URL_TEMPLATE` | `SIGN_TENANT_HOST_URL_TEMPLATE` |
| `ESIGN_WEBHOOK_SECRET_KEY` | `SIGN_WEBHOOK_SECRET_KEY` |
| `ESIGN_WEBHOOK_SIGNING_SECRET` | `SIGN_WEBHOOK_SIGNING_SECRET` |
| `ESIGN_WEBHOOK_TARGET_URL` | `SIGN_WEBHOOK_TARGET_URL` |
| `ARAMO_ESIGN_IMAGE` | `ARAMO_SIGN_IMAGE` |
| `AUTH_POST_LOGIN_PATH_ESIGN` | `AUTH_POST_LOGIN_PATH_SIGN` |

**Sign launch keys that keep their names** (already product-named or vendor-named, so not renamed):
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PLAN_PRICES`, `STRIPE_AUTOMATIC_TAX`, `STRIPE_PORTAL_CONFIGURATION`
- `BILLING_PAST_DUE_GRACE_DAYS`
- `SIGN_PUBLIC_SIGNUP_ENABLED`, `SIGN_PROFESSIONAL_ELIGIBILITY`, `SIGN_POST_TERMINATION_EXPORT_DAYS`, `SIGN_SALES_CONTACT_URL`
- `ARAMO_SIGN_ENTRY_ENABLED`, `ARAMO_SIGN_ENTRY_URL`, `ARAMO_SIGN_BASE_URL`
- `NGINX_SIGN_SERVER_NAME`, `AUTH_PRODUCT_HOSTS`

The later Stripe sandbox step uses the `STRIPE_*` names above unchanged.

**Renamed launch-related keys:**
- `ESIGN_BILLING_RECONCILE_*` → `SIGN_BILLING_RECONCILE_*`
- `ESIGN_DISCLOSURE_VERSION` → `SIGN_DISCLOSURE_VERSION`
- `ESIGN_EXPIRY_WORKER_ENABLED` / `_INTERVAL_MS` → `SIGN_EXPIRY_*`
- `ESIGN_KMS_*` → `SIGN_KMS_*`

## Database mechanics

Seven migrations apply, in order. They are guarded, idempotent and verify their postconditions:

| Migration | Effect |
|---|---|
| `libs/identity/…/20261020100000_sign_role_display_names` | Role descriptions "Sign …" (PR #988) |
| `libs/entitlement/…/20261020130000_sign_naming_capability` | Enum value `esign` → `sign` |
| `libs/identity/…/20261020130100_sign_naming_role_scope_keys` | Role and scope keys |
| `libs/auth-storage/…/20261020130200_sign_naming_consumer` | Revokes live `esign` refresh tokens |
| `libs/subscription/…/20261020130300_sign_naming_keys` | Plan, usage and feature keys |
| `libs/sign/…/20261020130400_sign_naming_schema` | Schema rename, Sign API permission arrays, the first-party ATS subscription path |
| `libs/documents/…/20261020130500_sign_naming_erasure_guard` | S2 erasure guard body, plus a catalog-wide check that no function or view references `esign.` |

**Ledger (§3.1).** `tools/db-sync-local.sh` first runs `tools/sign-naming/ledger-reconcile.sh`. It re-keys the 11 historical `libs/esign/…` ledger rows to `libs/sign/…`, but only when every row matches a pinned digest (`tools/sign-naming/ledger-manifest.tsv`), no renamed row exists yet, and the database holds schema `esign` alone. Anything else is **refused (exit 3) with nothing changed**.

**Proof:** `bash tools/sign-naming/naming.pg-integration.sh` runs 34 real-Postgres checks:
- fresh install;
- upgrade from the pre-rename tree with no historical replay;
- refusal of two partial states;
- an idempotent re-run;
- reverse, then forward again.

## Production-copy rehearsal (2026-10-20, measured)

The rehearsal ran on the production box, isolated: a throwaway `pgvector/pgvector:pg17` container on its own Docker network, with no ports and no access to production containers. Everything was removed afterwards.

| Step | Measured |
|---|---|
| Read-only dump of production | 29,350,462 bytes in 0.91 s |
| Restore into the throwaway container (DR restore rehearsal) | 5.51 s, 0 errors |
| Pre-rename tree on the copy | 0 pending (identical to production) |
| **Forward run** (re-key 11 rows, then apply 7) | **23.06 s**, rc 0, no historical replay |
| Postconditions | See below |
| Re-run | 0 applied |
| **Reverse** (`tools/sign-naming/reverse.sql`) | **0.18 s**, rc 0; the pre-rename tree then reports 0 pending |
| Forward again | 20.36 s, rc 0 (re-key, then the 6 naming migrations) |

**Postconditions on the copy:**
- schema `sign` exists and `esign` does not;
- enum values `core, ats, portal, sourcing, sign`, with 1 tenant entitlement on `sign`;
- roles `sign_admin, sign_owner, sign_sender, sign_viewer`, with **4 existing role assignments preserved**;
- 13 `sign:` scopes and 0 `esign:` scopes;
- 6 `esign` refresh tokens, 0 live;
- 0 `esign.*` subscription keys;
- the ATS subscription points at `http://api:3000/v1/integrations/sign/events`, and `aramo-ats` permissions are `sign:*`;
- 1 envelope and 9 signature events, unchanged;
- the erasure guard names `sign`.

### Carry-over proof (production copy, before → after the forward run)

| Item | Before | After |
|---|---|---|
| Astre capabilities | `ats, core, esign, portal` | `ats, core, portal, sign` |
| Astre subscription | `aramo-sign-included-v1`, MANUAL, ACTIVE, operator (sellable=false) | unchanged |
| Its allowance | `esign.envelopes = 100 / MONTHLY`, 0 used | `sign.envelopes = 100 / MONTHLY`, 0 used |
| Plan catalog | free-personal (FREE, INACTIVE), standard-business (SELF_SERVICE), standard-professional (SELF_SERVICE), enterprise (CONTACT_SALES), included-v1 (OPERATOR) | unchanged (4 public plans + the operator plan) |
| IN_PROGRESS ATS envelope | `source_application=aramo-ats`, signer VIEWED, 1 ACTIVE unexpired signing session | unchanged: still signable |
| Sign role assignments | 4 | 4 (keys renamed, grants kept) |

### Baseline note (PO instruction of 2026-10-20)

The instruction assumed production on `95ee222e` with 9 Sign migrations and the #984 seed pending. Production was verified read-only on 2026-10-20:
- Backends run `0262e0e9` and nginx runs `9f4ead1c`.
- All 9 migrations are recorded as applied, and the #984 seed scopes are present.
- The newest backup is 2026-10-19.

The rehearsals above therefore ran from the **real** production baseline.

## Maintenance window

**Before the window (no outage):**
1. Authorization for the merge, deploy, window, Cognito and `.env` changes.
2. **Cognito (PO):** add `https://sign.aramo.ai/auth/sign/callback`. Keep `/auth/esign/callback` until the smoke checks pass. The sign-out URL `https://sign.aramo.ai/signed-out` is unchanged.
3. On the box:
   - tag rollback images `:rollback-<prev>` for api, auth-service, platform-admin, esign-service and nginx;
   - land the new `main`;
   - run `deploy/build-images.sh <sha>` (about 85 min).
   - Running containers keep their image IDs, so there is no outage yet.
4. **Drain check.** Proceed only when all of these hold:
   - no `PENDING` or `RETRYING` rows in `esign."OutboxEvent"` or `esign."SignWebhookDelivery"`;
   - no tenant-configured third-party subscription exists;
   - `DEAD` rows are recorded.
5. Dry-run the env rename: `bash tools/sign-naming/env-rename.sh /opt/aramo/.env`. It lists the keys only and never prints a value.

**Window (write-frozen for Sign).** Times marked *measured* come from the rehearsal or from today's recreates. The others are estimates to confirm on the night.

| t | Action | Duration |
|---|---|---|
| 0 | Stop `aramo-prod-esign` (freezes Sign) and `aramo-prod-auth`. Stopping auth closes the window in which the old auth-service would mint recruiter tokens without filtering the renamed `sign:` scopes. | seconds |
| +0:10 | `pg_dump` backup into `/opt/aramo-backups` | 0.91 s *measured* |
| +0:15 | `deploy/migrate-prod.sh`: re-key, then 7 migrations | 23.06 s *measured* |
| +0:40 | `tools/sign-naming/env-rename.sh /opt/aramo/.env --apply` (backup, verified by digest) | seconds |
| +0:50 | Remove the stopped `aramo-prod-esign` container. Then `compose up -d --force-recreate sign-service auth-service api platform-admin talent-intake-worker`, then `nginx` (after `sign-service` is healthy). | 30 s to healthy (recreates on 2026-10-19 observed healthy at 30 s) |
| +1:30 | Smoke checks (below) | 3 min (estimate) |
| +4:30 | **Rollback decision point** | — |

**Expected impact:** about 5 minutes with Sign unavailable, from the stop to the end of the smoke checks.

**ATS impact:**
- **Unaffected:** ATS pages and APIs stay up. The api is only recreated, for about 30 s.
- **New sign-ins and session refreshes** are unavailable while auth-service is stopped, about 1.5 min.
- **RTR and Offer document signing,** and anything that checks the Sign capability, return errors from the migration until the api is recreated, about 1 min.

**Smoke checks:**
- `curl -sI https://sign.aramo.ai/sign/` returns 200;
- `/v1/sign/sender/context` without a session returns 401;
- `/v1/esign/sender/context` returns HTML, because it is no longer routed;
- Sign workspace sign-in through `/auth/sign/callback` works;
- a guest link `/s/<token>` loads;
- the inbox lists;
- the ATS RTR test send gets a Sign API token exchange (consumer `recruiter`) and creates an envelope;
- the completion webhook arrives with `x-aramo-sign-*` headers, and the executed artifact is pulled with the event grant;
- `docker logs` show no `esign` schema errors.

## Rollback

- **Before the decision point** (writes still frozen): the **reverse forward migration**, not a restore.
  1. Stop sign-service and auth-service.
  2. `psql --single-transaction -f tools/sign-naming/reverse.sql` (0.18 s *measured*). It restores the names and the legacy ledger, and un-records the 6 naming migrations.
  3. Restore `.env` from the env-rename backup.
  4. `git checkout <prev>` on the box.
  5. Start the `:rollback-<prev>` images.
  6. Users whose `esign` refresh tokens were revoked sign in again.
- **After the decision point:** roll forward. Fix forward rather than reverse.
- **Disaster recovery only:** restore the window's `pg_dump` (rehearsed at 5.51 s). This is a controlled decision. Account for any writes made after the backup; none exist while the window is write-frozen.

## After the window

1. Remove `/auth/esign/callback` from Cognito.
2. Update any operator notes that reference `ESIGN_*` keys or `aramo-prod-esign`.
3. The next PR may remove the historical-name tolerance once no `esign.*` rows can be redelivered.
