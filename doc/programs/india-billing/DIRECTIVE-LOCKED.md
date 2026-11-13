# Aramo India Billing Regions + Razorpay: Implementation Directive v1.0 (LOCKED)

**Status:** LOCKED 2026-11-13. PO (Purush) approved the directive and every §3 proposed ruling as written ("approved the directive start the implementation in fasttrack"). Fast track. Prepared by the Code Executor from recon.
**Baseline:** `origin/main` 3fc6e826 (#1104).
**Recon:** substrate audit of 2026-11-13 (sections R1–R11; cited below as R§).
**PO intent (2026-11-13):**
- Razorpay is the India billing system for Personal and Business web subscribers.
- Billing integrations are country-specific and fully decoupled, administered only in the admin console.
- GST and gateway registration are abstracted.
- India is built now and shipped **OFF**. The US goes live first.
- iPhone and Android in-app sales in India stay with the stores.
- Fast track.

---

## 1. Goal

1. A **country billing region** layer in the admin console. Each region carries: selling entity, web gateway, currency, tax registration (abstract), a Personal web switch, a Business web switch and a master switch.
   - United States = Stripe / USD / ON.
   - India = Razorpay / INR / **OFF**.
2. A **Razorpay** gateway at parity with the Stripe web flow for v1:
   - catalog sync from the console publish chain;
   - hosted checkout for subscriptions (UPI Autopay, cards, net banking);
   - webhooks into the existing inbox;
   - cancel;
   - per-seat quantity for Business;
   - status mapping.
3. Checkout, catalog and activation **route by the account's country** to that region's gateway.
4. Nothing sells in India until an operator turns the India region ON in the console, which the guards in §6 also hold.

## 2. Supersessions (explicit)

| Clause | Today | Superseded to |
|---|---|---|
| M-A12 A1-3 (`…M-A12-A1…LOCKED.md:34`) "Stripe stays US-only… INR applies to store billing until a separate ruling" | Web = Stripe, US/USD only | **This directive is that ruling.** Web billing is per region: US → Stripe/USD; IN → Razorpay/INR. Regional `IN/INR` prices become the Razorpay charge price for IN. |
| BP-2 (`…Billing-Products-One-Catalog…LOCKED.md:30`) "BUSINESS plans: billing product on web (Stripe) only" | Business = Stripe | BUSINESS = **web gateways only** (Stripe and/or Razorpay). Still never App Store or Google Play. |
| Sign Catalog v2 §4.3 (Personal paid to US residents only) | `PERSONAL_PAID_RESIDENCE = 'US'` | Personal paid sells to residents of any region whose Personal switch is ON. |
| Signup A1 "Organization Details US Only" (`us-organization.ts:82–83`, `TenantBillingRegionPolicy_region_check IN ('US')`) | Business signup US-only | Business signup accepts a country whose region Business switch is ON. India accepts only once ON. |
| CCP-C5 (Program Build Directive :95) tax HALT | Tax is a disabled constant | **Unchanged in v1.** See §5: GST fields are registration data only, with no calculation. Switching India ON requires a separate C5 amendment (GST) to be LOCKED. |

## 3. Proposed rulings for the recon's open questions

| # | Question (R open questions) | Ruling (PO-approved 2026-11-13) |
|---|---|---|
| Q1 | Business IN in scope? | **Yes, built OFF.** Personal IN and Business IN both ship dark. |
| Q2 | GST under C5 | v1 stores registration data only (§5). It computes no tax, sends no tax parameter, issues no GST invoice. India master switch ON is refused while the C5 GST amendment is not recorded as LOCKED (§6 guard G-3). |
| Q3 | Governance of region config | A governed CCP action **`BILLING_REGION_CHANGE`**: requester `platform:catalog:draft`, then the ACTIVE policy chain (Finance approval). The closed action set grows 17 → 18. The page is visible with `catalogRead`. |
| Q4 | Vocabulary exemption for the Razorpay wire file | **Yes**, on the same restrictions as `stripe-wire.ts` and `apple-asc-wire.ts`: a file-scoped vendor-wire module holding no Aramo logic, with lockstep `verify-vocabulary.sh` + `eslint.config.mjs` entries. |
| Q5 | Seller entity model | A `SellingEntity` table, referenced by region. US = the existing Aramo US entity. IN = "Aramo India" placeholder, inactive until registered. The merchant of record is shown on the checkout page and in the ToS reference. |
| Q6 | Authoritative routing country | Personal = `declared_residence` (latest PROVISIONED signup). Business = `identity.Tenant.country_code`. Activation guard: the gateway's region must equal the account's country (replaces the US-only `account_country` check for Razorpay). |
| Q7 | Razorpay v1 scope | Checkout, webhooks, cancel (end of period), seat quantity change, status mapping. Self-service manage is an **Aramo page** (Razorpay has no Stripe-style portal). **Out of v1, explicitly:** refunds, credits/adjustments, usage metering, renewal notices for IN. These stay Stripe-only, with a refusal for IN. |
| Q8 | IN price source | The version's `regional_prices` IN/INR **MONTH** entry is the Razorpay price. A Razorpay plan is created per published version (Razorpay plans are immutable). MONTH only in v1. A version with no IN price is not sold in India. |
| Q9 | TenantBillingAccount | One row per **(tenant, provider)**: the composite key replaces `tenant_id @id` (ADD-not-rename; migrate the existing rows). |
| Q10 | Region/gateway switch after subscribing | Refused in v1 (support path). Store and web mutual exclusion covers Razorpay too (§4.8). |

## 4. Work items

Seams follow recon R§ "Directive seams" order.

### 4.1 Region model (new; name avoids the existing `TenantBillingRegionPolicy`, recon D-3)
- **`subscription.BillingRegion`**: `country` (ISO-2, PK), `selling_entity_id`, `gateway` (`STRIPE` | `RAZORPAY`), `currency` (ISO-4217), `personal_web_enabled`, `business_web_enabled`, `enabled` (master), audit columns.
- **`subscription.SellingEntity`**: `id`, `display_name`, `legal_name`, `country`, `registration` (JSON: abstract registration data, see §5), `active`.
- **Seed:** US/Stripe/USD/ON (Personal ON per the existing flag, Business ON), and IN/Razorpay/INR/OFF.
- **Change path:** the governed `BILLING_REGION_CHANGE` action and apply service, with the DB CHECK widening for `CommercialChangeRequest_action_type_check` and `CommercialCatalogApplication_action_type_check`.

### 4.2 Provider key `RAZORPAY`
- **SQL:** widen the 17 provider CHECKs, the 3 partial indexes and the trigger (R2). Keep the 4 STRIPE-only CHECKs (commands, adjustments, self-service, account) STRIPE-only, except `TenantBillingAccount` (Q9) and commands (cancel and seat change need RAZORPAY).
- **Code:** add `RAZORPAY` to the unions: `BillingProviderKey`, `BillingProvider`/`BILLING_PROVIDERS`, the DTO, platform-web, OpenAPI `platform.yaml` (10) and `sign.yaml` `managed_by`, the mobile generated and hand types.

### 4.3 Gateway registry (replaces the single static binding)
- A `BillingGatewayRegistry` resolves the 5 ports by provider key. Stripe binds as today; Razorpay binds with `isConfigured()` = credentials present.
- `BILLING_PRICE_PROVIDER` / `effectiveProviderPrice` / `resolvePriceToVersion` take the provider.
- `syncSubscription` (`subscription-lifecycle.service.ts:919–924`) and the inbox (`billing-webhook-inbox.service.ts:99`, `:177`) route by the row's provider.

### 4.4 Country resolution port
`BILLING_COUNTRY_PORT` (bound in sign-service; subscription cannot import identity): Personal residence or Business `country_code`. A region lookup then decides the gateway, currency and whether selling is open.

### 4.5 Razorpay adapter (inside `libs/subscription`, no new lib, so no 3-place wiring)
- **`razorpay-wire.ts`:** vendor wire with the vocabulary exemption (Q4).
- **`razorpay-billing.provider.ts`:** checkout (hosted subscription link), cancel, quantity, retrieve, webhook signature verification (HMAC-SHA256 over the raw body), and status mapping into `mapProviderStatus` vocabulary.
- **Credentials:** env only: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`. They pass through compose and `.env.prod.example`. No env segment starts with `TAX` (C5-T-4).
- **C5-G-1:** extend the guard to pin the Razorpay key readers and API host.

### 4.6 Razorpay catalog writer
- `RazorpayCatalogWriter implements BillingProductSyncPort`. Added at `subscription.module.ts:83`.
- `eligibleProviders`: PERSONAL → Stripe, Razorpay, App Store, Google Play; BUSINESS → Stripe, Razorpay.
- Pin branch at `billing-products.service.ts:262`. The US-only filters at `:360`/`:390` become region-price aware. The Razorpay target price is the IN regional price.
- Console `PROVIDER_LABEL`: `RAZORPAY: 'Web India (Razorpay)'`.

### 4.7 Webhook
- `POST /v1/sign/billing/webhook/razorpay`, with a raw-body signature check, feeding the existing inbox.
- `api-surface-manifest.json` classifies it `XP`. OpenAPI path added. sign-service pact state added.

### 4.8 Store and web mutual exclusion
`storePurchaseBlock` treats any web gateway (`STRIPE` | `RAZORPAY`) as "managed elsewhere" (`store-billing.service.ts:120`, `:247`, `:289`). Mobile `managed_by` handles `RAZORPAY` like `STRIPE`.

### 4.9 Region-aware guards
`PERSONAL_PAID_RESIDENCE`, `billingCountrySupported`/`BILLING_COUNTRY_ALLOWED`, `lockedBillingProfile`/`lockRegion`, `usProfileIneligibility` and Business signup country validation all read the region table. A region OFF behaves exactly like today's refusals.

### 4.10 Console
- **Commercial → Billing regions** page: list, detail, and draft change → request publish → approve.
- The entity and registration form holds the abstract fields (§5).
- `RegionalPricesEditor` title becomes "Regional prices (stores and web)", with region-aware help text.
- `BillingProductsEditor` offers Razorpay on PERSONAL and BUSINESS plans.

### 4.11 sign-web
- Currency-aware price display (replace `usd()`).
- Provider-neutral copy (6 strings).
- Checkout redirect works for either gateway.
- An Aramo "Manage subscription" page (cancel, seats) for Razorpay.

### 4.12 Tests and contracts
- Unit and integration tests per seam.
- Pact: the sign-service and platform-admin verifiers pick up subscription migrations by scan. An identity migration (Business IN signup / region policy CHECK) needs a `libs/common/src/lib/testing/identity-migrations.ts` entry and a `pact/provider/src/verify-api.ts` registration if a returned shape changes.
- Run `ARAMO_RUN_INTEGRATION=1 nx run api` before push.

## 5. GST and registration abstraction (C5-safe)
- `SellingEntity.registration` is a JSON document of **named registration identifiers**, for example `{ "gstin": "...", "pan": "...", "state_code": "...", "place_of_supply_rule": "..." }`, plus a free-form note.
- It is data only. No code path computes, adds or sends tax.
- Field names avoid the C5-G-2 token regex and C5-T-4 env rule. They are validated by shape only (GSTIN 15-char pattern) and never shown to tenants until a C5 GST amendment says so.
- Prices are shown and charged as configured. Whether the IN price is GST-inclusive is a C5-amendment decision, recorded on the region (`price_tax_mode` = `UNSET` until then; the India master switch refuses ON while `UNSET`).

## 6. Dark-launch guards
- **G-1:** the India region seeds `enabled=false`, and Personal and Business switches false.
- **G-2:** `RAZORPAY_*` credentials absent ⇒ the Razorpay ports are `isConfigured()=false`; the writer reports NOT_CONFIGURED; checkout is refused.
- **G-3:** turning a region ON is refused unless its gateway is configured, its selling entity is `active`, and (for IN) `price_tax_mode` is set. That needs the C5 GST amendment.
- **G-4:** the env flag `SIGN_RAZORPAY_BILLING_ENABLED` (exactly `1` enables; default off) gates the webhook route (404 while dark) and the writer, as `SIGN_STORE_BILLING_ENABLED` does for stores.

## 7. Out of scope (v1)
- Refunds, credits and adjustments for IN.
- Usage metering for IN.
- Renewal notices for IN.
- Region switch after subscribing.
- YEAR prices on Razorpay.
- Routing iPhone or Android in-app purchases to Razorpay. **Forbidden by Apple App Review 3.1.1 and Google Play billing policy.** Stores remain the merchant of record for in-app sales in every country.

## 8. HALT conditions
- Any tax calculation, tax parameter or GST invoice (C5).
- Any path that sells in India while the region is OFF.
- Any App Store or Google Play product for a BUSINESS plan.
- Any Razorpay key in the DB, logs or chat.
- A recon-cited LOCKED clause not listed in §2 found in conflict.

## 9. Delivery
- One program branch → one integration PR (PO rule), full CI.
- Gate 5: local implementation plus verified diff. Gate 6: commit plan.
- No deploy without PO authorization.
- Razorpay **test** credentials are needed for the integration tests against the sandbox. They are supplied by the PO directly to the box/CI secret, never in chat.
