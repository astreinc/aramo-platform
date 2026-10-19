# Release — Aramo Sign standalone: catalog, self-service billing, signup (Stripe)

Governing directives:
- `Aramo-Sign-Standalone-Product-Final-Implementation-Authorization-v1_0-LOCKED`
- `Aramo-Sign-Commercial-Plans-Legal-Framework-Amendment-A1-v1_0-LOCKED`, SHA-256 `93c3f974…`. It supersedes the single 100/month paid plan.

Each of these needs separate authorization: deploying, live keys, charging cards, opening public signup, Personal sending, and publishing any legal text. This runbook gives the order of operations once those are authorized.

## Plan catalog (A1)

| Plan | Key | Price | Term | E-Signs / forms | Templates | Storage | State |
|---|---|---|---|---|---|---|---|
| Free Personal | `aramo-sign-free-personal-v1` | $0 | month to month | 5 / 5 per month | 1 | 15 MiB | **INACTIVE**: Personal sending held; PO decisions pending |
| Standard Business | `aramo-sign-standard-business-v1` | $20/month | 12-month commitment, billed monthly | unlimited | unlimited | 10 GiB | sellable |
| Standard Professional | `aramo-sign-standard-professional-v1` | $15/month | 12-month commitment, billed monthly | unlimited | unlimited | 25 GiB | sellable to organizations with the `ats` entitlement |
| Enterprise | `aramo-sign-enterprise-v1` | contact sales | contract | — | — | — | nothing configured (contracted per agreement) |
| (operator) | `aramo-sign-included-v1` | — | — | 100 per month | — | not limited | pre-catalog; existing MANUAL subscriptions only; not offered |

- **Unlimited** is explicit: `unlimited = true` with a null quantity, never a sentinel number. Every send is still metered.
- **"$30 original"** is stored as a reference price with `reference_price_substantiated = false`, so it is never shown. Showing it requires a governed data change after it has been substantiated.
- **Features:** Standard plans include AI assist summary and team collaboration. Advanced analytics and custom domain are off.
- **Entitlement ≠ availability** (A1 review): `libs/subscription/src/lib/feature-availability.ts` marks what is built. Built: E-Signs, storage, team collaboration (the shared organization workspace with role-based access). Not built: forms, templates and AI assist summary. These stay in the plan definitions but are never advertised. The catalog reports `available` for each item, and the console shows only available ones.
- **Legacy plans:** `aramo-sign-business-v1` (the superseded 100/month plan seeded by an earlier revision of the M2 migration) is retired by A1 wherever it exists. It becomes non-sellable, inactive, operator-only and out of the catalog; its subscriptions are kept. An upgrade replay test proves this.

## What ships

**Migrations** (all additive):
- `subscription/20261019100000_subscription_lifecycle_billing`: lifecycle status, provider linkage, `CheckoutIntent`, `BillingEvent`.
- `subscription/20261019140000_sign_commercial_catalog_a1`:
  - the plan descriptor (price, commitment, eligibility, support, status);
  - explicit unlimited allowances;
  - `PlanCapacity` (storage, templates) and `PlanFeature`;
  - the `CapacityUsage` storage ledger;
  - the commitment and eligibility state on subscriptions;
  - `LegalAcceptance`;
  - the four catalog plans.
- `identity/20261019120000_sign_self_service_signup`: `SignupRequest`.
- `esign/20261018150000_esign_launch_notifications_access`.

**esign-service:**
- `v1/esign/billing/*`: the catalog with eligibility, account, checkout, billing portal, and the Stripe webhook.
- Storage quota on upload, typed `ESIGN_STORAGE_QUOTA_EXCEEDED` (409). Signed copies and certificates are recorded but never refused.
- Hourly reconcile, opt-in: Stripe re-fetch plus a Professional eligibility refresh.

**platform-admin:** public signup at `v1/signup/sign/*`, dark by default; `GET v1/signup/sign/terms`; the read-only operator `GET /platform/tenants/:id/sign`.

**esign-web:** Plan & billing with the catalog; public `/signup` and `/signup/verify`.

**platform-web:** the operator "Aramo Sign" tab.

**ats-web:** the e-signature panel shows "N sent · unlimited" on unlimited plans.

**Legal drafts:** `doc/legal/aramo-sign/*.md`. All are DRAFT / LEGAL-PENDING and pinned by `libs/subscription/src/lib/legal/legal-documents.ts`.

## Behaviour

**Billing availability**
- With `STRIPE_SECRET_KEY` unset, checkout and the portal answer `ESIGN_BILLING_UNAVAILABLE` (503). Nothing is charged.
- **A live key (`sk_live_` / `rk_live_`) refuses checkout while no Terms of Service version is APPROVED** (`TERMS_NOT_APPROVED`). Live charging is therefore impossible without approved terms.
- In test mode, checkout proceeds and records no terms.

**Subscriptions and sending**
- A subscription opens only from Stripe's verified state, re-fetched before it is applied. The checkout initiator receives `esign_owner` only if they hold `org_admin` or `tenant_owner`.
- **Standard Professional is OFF until the PO confirms the qualifying rule (D16).** The platform can prove the live `ats` entitlement on an ACTIVE tenant, but not that the ATS relationship is paid: ATS has no commercial subscription record. With `SIGN_PROFESSIONAL_ELIGIBILITY=ATS_ENTITLEMENT`, checkout requires both. A later lapse is recorded as `eligibility_state = LAPSED`. Sending and the commitment are kept and the lapse is shown to the tenant and the operator. There is no automatic downgrade or price change.
- **Billing portal for commitment plans:** refused (`PORTAL_NOT_CONFIGURED`) unless `STRIPE_PORTAL_CONFIGURATION` names a Stripe portal configuration whose cancellation settings match the approved annual terms. This prevents the default portal from implying month-to-month cancellation.
- **Commitment:** `commitment_end` is the anchor plus 12 months, tracked separately from the monthly `current_period_end`. Cancelling inside the commitment sets `cancel_requested_within_commitment` for follow-up. No fee is applied.
- **Past due:** sending continues for `BILLING_PAST_DUE_GRACE_DAYS` (default 7), then stops. `unpaid` or `paused` stops at once. `canceled` ends the subscription. Envelopes already sent can always be signed and downloaded.

**Storage, documents and retention**
- **Storage:** uploads reserve their bytes under a per-tenant lock before the write. A failed write or a removed draft document releases them. Nothing stored is ever removed by the quota.
- **Ending a subscription deletes nothing.** The export window `SIGN_POST_TERMINATION_EXPORT_DAYS` (90 proposed) stays unset until the retention policy is approved.

**Legal text**
- **Signer disclosure:** v1 is served by default. v2 (the A1 consent text) is served only with `ESIGN_DISCLOSURE_VERSION=v2`, after legal approval. The consent checkbox is never preselected.

## Stripe setup (test mode)

1. Two products, each with one recurring **monthly** USD price:
   - Standard Business, $20.00;
   - Standard Professional, $15.00.

   The Stripe amount must equal the catalog list price.
2. **Billing portal:** create a dedicated portal configuration (payment method, invoices) whose cancellation settings follow the approved annual terms (D4), and set `STRIPE_PORTAL_CONFIGURATION=bpc_…`. Without it the portal stays refused for commitment plans.
3. **Webhook** `https://esign.aramo.ai/v1/esign/billing/webhook/stripe`, with these events:
   - `checkout.session.completed` and `checkout.session.async_payment_succeeded`;
   - the three subscription lifecycle events (created, updated, deleted);
   - `invoice.paid` and `invoice.payment_failed`.

   Any other event is recorded `IGNORED`.
4. **Box `.env`:**
   - `STRIPE_SECRET_KEY` (`sk_test_…`) and `STRIPE_WEBHOOK_SECRET`;
   - `STRIPE_PLAN_PRICES=aramo-sign-standard-business-v1=price_…,aramo-sign-standard-professional-v1=price_…`;
   - `ESIGN_BILLING_RECONCILE_ENABLED=1`;
   - `ESIGN_SENDER_WEB_BASE_URL=https://esign.aramo.ai`;
   - optionally `SIGN_SALES_CONTACT_URL`.

## Order

1. Back up the database. Apply the migrations (BUILD before SEED: compiled image).
2. Recreate esign-service, platform-admin, api and nginx. Verify `ARAMO_RELEASE_REVISION`.
3. Probes:
   - the webhook without a signature returns 401;
   - `GET /v1/signup/sign/terms` returns 404 (signup dark).
4. Test-mode end to end:
   - an org admin on esign.aramo.ai sees the setup page;
   - Standard Business → Stripe test card → "Confirming…" → Active;
   - the console opens;
   - send 101 or more envelopes: none is refused;
   - upload a document and watch the storage meter.
5. Live keys only after the live-charging authorization **and** an APPROVED Terms of Service version.

## Rollback

An image rollback restores the code; the migrations are additive and can stay. To stop self-service without a rollback, unset `STRIPE_SECRET_KEY` and recreate esign-service.

## Vocabulary boundary

Stripe's vendor-defined identifiers appear only in `libs/subscription/src/lib/billing/stripe-wire.ts` and its contract spec `stripe-wire.spec.ts`. These are the two file-scoped vocabulary exemptions, ratified by the Lead Architect (A1 §4). Every Aramo-owned model, column, DTO and API uses `account_ref`; the adapter itself is fully gated.

## Decision register (open; nothing here is invented)

| # | Decision | Owner | Blocks | Current safe state |
|---|---|---|---|---|
| D1 | Free Personal: do the 5 E-Signs and 5 forms reset monthly? Trial policy? | PO | Free Personal activation | catalogued INACTIVE, monthly as recommended |
| D2 | Personal-product sending authorization | PO / Lead | Free Personal | refused server-side |
| D3 | Substantiation of the $30 reference price | PO / Legal | showing a comparison price | stored, not shown |
| D4 | Annual terms: auto-renewal, cancellation notice, early termination, refunds; the Stripe portal cancellation setting | PO / Legal | live charging | commitment tracked; early cancel flagged; no fee |
| D5 | Terms of Service, Privacy Policy and DPA, consent disclosure v2, retention policy: legal approval and publication URLs | Legal / PO | live charging, public signup, disclosure v2 | all DRAFT; nothing presented for acceptance |
| D6 | Retention durations and the post-termination export window (90 days proposed) | Legal | export-window enforcement | unset; no deletion of any kind |
| D7 | Standard Professional when ATS lapses: keep to term end, auto-move to Business, or contact? | PO | — | LAPSED flagged; plan and sending kept |
| D8 | Astre's existing MANUAL `aramo-sign-included-v1` (100/month): keep until it self-subscribes, or move it to unlimited? | PO | — | unchanged (100/month) until Astre subscribes |
| D9 | Storage units: binary (MiB/GiB) chosen as the reading that never under-delivers | PO | — | binary |
| D10 | Fair-use / anti-abuse policy text for unlimited plans | Legal / PO | public paid launch | metering only; no numeric limit |
| D11 | Signup abuse protection beyond the per-IP and per-address limits (CAPTCHA vendor) | Lead / PO | public signup | per-IP and per-address limits |
| D12 | Enterprise sales contact (`SIGN_SALES_CONTACT_URL`) | PO | — | "Contact Aramo" text only |
| D13 | AI assist summary: build, data-processing disclosure, provider | PO / Lead | marketing the feature | catalogued, not built |
| D14 | Operator capability grant/revoke and operator-opened subscriptions | Lead / PO | — | not built (read-only operator view) |
| D15 | Host binding `enforce`; KMS evidence key and dedicated bucket (Terraform; `doc4-esign.tf:18`) | Lead / infra | hardening | `log` mode; software signer |
| D16 | What qualifies as an ATS subscription for Standard Professional: is the live `ats` entitlement on an ACTIVE tenant enough, or is a paid ATS contract record required (none exists today)? | PO / Lead | Standard Professional sales | OFF (`SIGN_PROFESSIONAL_ELIGIBILITY` unset) |
| D17 | Confirm "team collaboration" means the shared organization workspace with role-based Sign access (built), or something more | PO | advertising it | advertised as built |
| D18 | The Stripe portal configuration for commitment plans (cancellation settings matching D4) | PO / Legal | online billing management | portal refused for commitment plans |
