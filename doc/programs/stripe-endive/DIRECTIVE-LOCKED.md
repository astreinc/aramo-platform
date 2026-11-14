# Aramo — Stripe API Upgrade + Live-Readiness Directive v1.0 (LOCKED)

**Status:** LOCKED — PO approved 2026-11-14 ("approved to implement"), rulings Q1–Q3 as recommended (§7). **Date:** 2026-11-14. **Baseline:** origin/main `5f2b582f` (deployed to prod 2026-11-14).
**Trigger:** PO ruling 2026-11-14 — do not go live on the old pinned API version; upgrade to the latest before switching Stripe to the live key.
**Sources:** substrate audit of origin/main `5f2b582f` (46 Stripe call sites, 5 transports, 3 pins); Stripe changelog pages read 2026-11-14 (cited per item).

## 1. Scope
Move every Stripe integration from `2024-06-20` to `2026-09-30.endive`, fix every call the intervening breaking changes affect, prove it end to end in test mode on prod, then (separately authorized) switch to the live key. No product behaviour change except where a ruling below says so.

Out of scope: Razorpay; Apple/Google store billing; Stripe Tax (CCP-C5 stays disabled); new features.

## 2. Pins (3, not 2)
| Pin | File | Moves |
|---|---|---|
| P1 `STRIPE_API_VERSION` | `libs/subscription/src/lib/billing/stripe-billing.provider.ts:64` | billing provider (26 calls), read adapter (3), catalog writer (6) |
| P2 `SIGN_STRIPE_API_VERSION` | `apps/sign-service/src/app/payments/stripe-connect-payment.provider.ts:38` | Sign Connect payments (6) |
| P3 `STRIPE_IDENTITY_API_VERSION` | `libs/sign/src/lib/identity-verification/stripe-identity.adapter.ts:29` | Sign identity verification (5) |

All three move to `2026-09-30.endive` (one shared value; stale version comments updated: `stripe-wire.ts:143,:273`, `usage-meter.port.ts:6`, provider `:87-88`, `:110-111`).

## 3. Breaking changes that hit our code (each verified against the Stripe changelog)
| # | Stripe change (release) | Our impact (audit ref) | Required fix |
|---|---|---|---|
| B-1 | Invoice `payment_intent`, `charge`, `paid` removed; payments now in `invoice.payments` / `InvoicePayment` (Basil 2025-03-31, changelog `add-support-for-multiple-partial-payments-on-invoices`) | `wireInvoicePayment` reads `payment_intent` (wire:240) → refund create (provider:351), refund list (:388, :405), dispute list (:406) | Read the payment intent via `expand[]=payments` → `payments.data[].payment.payment_intent` (type `payment_intent`); handle more than one payment per invoice (refund against the paid one; fail closed if ambiguous). |
| B-2 | Subscription/Invoice singular `discount` field and `coupon` param removed → `discounts` (Basil, `deprecate-singular-coupon-promotion-code`) | `wireSubscriptionDiscount` reads `obj['discount']` (wire:233), calls 14 and 20; DISCOUNT_REMOVE uses `DELETE /v1/subscriptions/{id}/discount` (provider:344) | Read `discounts` (expand as needed); remove by updating `discounts` (verify the DELETE route in test mode; keep only what Stripe documents at the new version). Apply already sends `discounts[0][coupon]` (wire:228) — no change. |
| B-3 | Discount `coupon` removed, `source{type,coupon}` added, coupon no longer auto-expanded (Clover 2025-09-30, `add-discount-source-property`) | Same reads as B-2 (`.coupon`, wire:233-235; provider:378-381) | Read `discount.source.coupon`. |
| B-4 | Subscriptions created via Checkout default to **flexible billing mode** at ≥ Clover (Clover, `billing-mode-default-flexible`) — changes proration and invoice calculation | Seat changes with `proration_behavior` (provider:303-308); all new Business/Personal subscriptions | **Ruling Q1.** Either accept flexible (re-verify seat proration) or send `subscription_data[billing_mode][type]=classic` to keep the tested behaviour. |
| B-5 | Checkout subscription created only after payment completes (Basil, `checkout-legacy-subscription-upgrade`) | `checkout.session.completed` reads `subscription` (provider:115-116); expire path (:313) | Confirm in test mode; no code change expected. |
| B-6 | Coupons without an end time no longer supported (Basil, `restrict-coupon-duration`) | Coupon create sends `duration=once` (wire:222-224) | Confirm `once` is accepted in test mode. |
| B-7 | Subscription period fields moved to items (Basil) | Already handled with fallback (provider:89-90) | Keep; add new-shape-only test. |
| B-8 | Invoice → subscription link moved to `parent.subscription_details.subscription` (Basil) | Already handled (provider:120, wire:144) | Keep; add new-shape-only test. |

Checked and **not affecting us** (audit: 0 occurrences): `payment_method_types` removal (Endive), billing-cycle-anchor format (Endive), Checkout `ui_mode` enum (Dahlia), `total_count` expansion, upcoming-invoice API, legacy usage records, `iterations`, promotion codes, credit-note `refund`. Identity verification and Connect application fees: no breaking change listed in the changelog for the fields we use (re-verified by the test run in §5).

## 4. Live-mode holds (found by the audit — would block go-live even after the key switch)
The code deliberately refuses live billing today:
- `billing-command.service.ts:489-493` — every billing command (self-service cancel, CCP adjustments: credit, discount, refund) stays PENDING when the key is live.
- `billing-status-read.service.ts:140-143` — billing status reads return `LIVE_MODE_HELD`.
- `usage-provider-report.service.ts:67` — usage reports held in live mode.

**Ruling Q2:** replace the hard-coded holds with one explicit server switch (proposed `SIGN_STRIPE_LIVE_BILLING_ENABLED=1`, default off), so a live key alone never activates live commands; the switch is flipped only in the authorized go-live window.

## 5. Proof (gate before any live key)
1. Unit/integration: the 13 spec files with inline Stripe shapes (audit §8) move to the new shapes; the version-literal assertion (`sign-usage-metering.spec.ts:101`) updated; new-shape-only cases for B-1…B-8. Full CI incl. `ARAMO_RUN_INTEGRATION=1 nx run api`.
2. Deploy to prod (still test key). Test-mode end to end against real Stripe test mode, recorded in a report:
   Personal checkout → active; Business checkout with seats → active; seat increase/decrease (proration per Q1); cancel at period end (self-service); credit grant + reverse; discount apply + remove; refund of a paid invoice; disputes list read; billing portal session; catalog sync (product + price); webhook delivery on the 2026-09-30 endpoint (11 events) incl. renewal via a test clock.
3. Sign Connect payments and identity verification: exercised in test mode if their keys are configured; otherwise covered by specs only (they are not part of the US billing go-live).

## 6. Go-live (separate PO authorization after §5 passes)
Live webhook endpoint (already created, 2026-09-30, 11 events); live key (restricted "full access except sensitive operations" — verify refunds work under it in §5 with a test restricted key); `STRIPE_PORTAL_CONFIGURATION` (live); flip the Q2 switch; publish new plan versions with Stripe (Personal Standard after Apple approves iOS 1.0; Business after counsel signs Business ToS 2.1); one real purchase + refund.

## 7. Rulings (PO 2026-11-14 — recommended options adopted)
- **Q1 billing mode — RULED (a) flexible.** Options were: (a) adopt flexible now — no live subscriptions exist, so this is the cheapest moment, and it is Stripe's default going forward (recommended); or (b) pin classic.
- **Q2 live switch — RULED: explicit switch `SIGN_STRIPE_LIVE_BILLING_ENABLED` (default off).** Options were: add the explicit `SIGN_STRIPE_LIVE_BILLING_ENABLED` switch (recommended) vs. remove the holds outright.
- **Q3 scope — RULED: all three pins.** Options were: upgrade Connect payments and identity verification in the same change (recommended — one version across the integration) vs. billing only.

## 8. Delivery
One branch off origin/main, one PR (`feat/stripe-api-endive`), Gate-5 local diff → Gate-6 commit plan → PO-authorized merge → deploy per RELEASE-box v2.6 (no migration expected).
