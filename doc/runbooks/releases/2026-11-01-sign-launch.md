# Release brief — Sign feature parity + PLAN_CREATE + ToS v2.0 + usage metering (2026-11-01)

**Use with:** `doc/runbooks/RELEASE-box.md` v2.6 (canonical procedure). This brief is only the
release-specific header block, the checks this release adds, and its hard stops. A fresh Claude Code
session runs it on the box after PR #1057 merges.

**Authorization (must exist before STEP 1):**
- PO: deploy "all changes to PROD tonight when #1057 merges" (2026-11-01). The session must still get
  the PO's explicit go at the start of the window (it is a separate chat).
- Lead Architect approval of the 13 migrations below. **If the session cannot see a recorded Lead
  approval, it STOPS before STEP 3 and asks the PO.**

## Header block (fill TARGET_SHA)

```
═══ FILL IN BEFORE RUNNING ═══
TARGET_SHA   = <40-hex main HEAD after #1057 merged: git rev-parse origin/main>
SERVICES     = sign-service api talent-intake-worker auth-service platform-admin nginx
               (sign-service built AND running before nginx is recreated; api ⇒ talent-intake-worker;
                talent-intelligence-service only if `git diff --stat 06372585 TARGET_SHA -- apps/talent-intelligence-service libs/intelligence-*` is non-empty)
RUN_MIGRATE  = yes
RUN_SEED     = no   (unless STEP 0 finds a seed change; then STOP and ask)
NOTES        = see "This release" below
═════════════════════════════
```

**Currently in PROD:** `06372585` (2026-10-31). Rollback tag: whatever STEP 1/RELEASE-box pins
for the running images (`:rollback-06372585`); the previous floor `:rollback-68928d79` stays.

## This release

Merged since `06372585`: #1045 (backlog doc), #1047 (Cognito invite username fix), #1048 (monitoring,
runbooks, RELEASE-box v2.6), #1049 (Sign reports), #1050 (CCP PLAN_CREATE), #1056 (Sign feature
parity: templates, branding, custom roles, Personal → Business upgrade, witness/delegate/access code,
RFC 3161 timestamps, SMS/WhatsApp/OTP, ID verification/KBA, payments, AATL seal, QES/e-stamp ports,
sign-in UX fixes), #1057 (ToS v2.0 registered dark + acceptance gate; usage metering A3/A4).

Everything new ships **dark** except three features the PO switched on (templates, reports, access
code via the signer page/API). User-visible changes tonight: the sign-in page "Create account"
links, the clearer unverified-Microsoft-email error, the cleaner Personal account name, and the
Platform Console invite fix (finance@ can now be invited).

### Migrations (13) — STEP 3

Expected pending after `06372585` (verify with `bash deploy/migrate-prod.sh --status` first; the
list must match exactly — any extra pending migration = STOP and report):

| Schema | Migration |
|---|---|
| subscription | `20261101120000_sign_catalog_v2` |
| sign | `20261101130000_sign_tenant_branding` |
| identity | `20261101150000_sign_custom_roles` |
| sign | `20261101150000_sign_report_indexes` |
| sign | `20261101200000_sign_trusted_timestamp` |
| subscription | `20261101200000_ccp_plan_create` |
| sign | `20261101300000_sign_executed_document_seal` |
| sign | `20261101310000_sign_qes_estamp_ports` |
| sign | `20261101400000_sign_messaging_sms_whatsapp_otp` |
| sign | `20261102100000_sign_witness_delegate_access_code` |
| sign | `20261102130000_sign_recipient_identity_verification` |
| sign | `20261102190000_sign_payments` |
| subscription | `20261101300000_sign_usage_metering` |

- **Migrate BEFORE any code** (STEP 3 before STEP 5). In particular `identity 20261101150000_sign_custom_roles`
  must be applied before the new auth-service starts: auth-service reads it on every Sign token.
- `migrate-prod.sh` re-runs the domain-role grants after the gate; the new Sign tables must show in
  its converged postcondition (the Sign role has full privilege on every `sign` table; no ATS role
  touches one).
- **G-073 HARD CHECK (before STEP 3):** confirm the destructive ATI-SEP-1 migration
  `20261024170000_ati_sep_1_drop_legacy_trust_schemas` is either already recorded in
  `public._local_migrations` or NOT pending. If it shows as pending, **STOP**: applying this release
  would run that drop, which needs a separate PO authorization and an archive first (ADR-0036).
  Report and wait.

### Environment — NO `.env` changes tonight

This release adds many optional env vars (SMS/WhatsApp, Stripe Connect/Identity, seal, TSA, QES,
e-stamp, `SIGN_USAGE_BILLING_ENABLED`, `SIGN_PERSONAL_UPGRADE_ENABLED`, messaging limits). **Leave them
all unset.** None is a required (`:?`) interpolation; unset = feature off. Do not edit `.env`.
(`env:passthrough-check` must still pass in STEP 0.)

### nginx

The nginx template adds `location /v1/sign/payments/webhook/` → sign-service (dark: 404 until
Connect is configured). nginx is rebuilt because the SPAs (sign-web, platform-web) changed. Run
`nginx -t` in its own ssh call; sign-service must be running first.

### Must stay OFF after deploy (verify, do not change)

- `libs/subscription/src/lib/feature-availability.ts`: **switched ON by PO authorization 2026-11-01:**
  `sign.templates`, `sign.reports`, `sign.access_code` (AVAILABLE). Every other new `sign.*` key is
  `NOT_AVAILABLE` (branding, custom_roles, trusted_timestamp, witness_signing, delegate_signing,
  sms_delivery, whatsapp_delivery, sms_otp, id_verification, kba, payments,
  document_seal, qes, india_estamp, metering keys). Flipping any is a separate PO authorization (R-8).
- ToS v2.0: `effective_from: null` in both `libs/subscription/src/lib/legal/legal-documents.ts` and
  `apps/sign-web/src/workspace/legal/catalog.ts`. Nobody is offered or owes v2.0 tonight. Release
  day is a separate PR after counsel answers B5.3, B9.1 and the four bracketed periods.
- Notification worker stays paused (=0). Retention/purge settings unchanged (`SIGN_PURGE_ENABLED=1`
  as before).

### STEP 9 smoke (in addition to RELEASE-box)

1. `https://sign.aramo.ai` sign-in page shows the Personal / Business "Create account" links.
2. An existing Business and an existing Personal user can sign in and open the workspace with no
   terms dialog (v2.0 is not in effect).
3. `GET /v1/sign/sender/context` (signed in, Business): `features.templates`, `features.reports` and
   `features.access_code` are true; every other new key is false. Reports page loads for a Business
   admin; Templates page lists adopted templates (empty if none adopted) — not an error.
4. Platform Console: the catalog shows unit-price fields on a draft plan version (D2) and nothing
   is published; the invite flow returns success for a test alias invite only if the PO asks for one.
5. `docker logs` for sign-service, auth-service, api, platform-admin: no ERROR at boot; auth-service
   mints a Sign token (custom-roles path, zero custom roles) — sign-in works end to end.
6. Monitoring probe (`doc/runbooks/sign/monitoring-and-alerts.md`) reports healthy, if installed.

### Hard stops specific to this release

- Pending set ≠ the 13 above → STOP.
- G-073 drop pending → STOP.
- No recorded Lead migration approval → STOP before STEP 3.
- Any `.env` change needed to boot → STOP (none should be).
- auth-service unhealthy or Sign sign-in fails after recreate → ROLLBACK auth-service first
  (the custom-roles table is additive; the old image ignores it).

### After the window

- Write the deploy report to OneDrive `Aramo/documents/` (not `locked/`), per RELEASE-box REPORT.
- Update `PROD=` in Claude memory and `Aramo-Sign-GoLive-Todo.md` item 4.
- Follow-ups for the PO: invite finance@ (now works), monitoring Terraform from the Mac
  (`infrastructure-monitoring/`) + box install, Stripe live, console price approvals, counsel answers
  for ToS v2.0, feature flips one by one.
