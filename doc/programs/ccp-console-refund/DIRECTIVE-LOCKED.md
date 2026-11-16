# Aramo CCP — Console Refund Request Directive v1.0 (LOCKED)

**Status:** LOCKED — approved by the PO 2026-11-16 (Q1 adopt §2; Q2 (a) open subscriptions only, keep RF-5; Q3 Finance amount holders only; Q4 ship behind the open dual gate, proof refund first). Fast track. **Date:** 2026-11-16. **Baseline:** origin/main `3047b198` (production).
**Governs under:** ARAMO-COM-REFUND-POL-001 v1.0 (LOCKED, sha256 `cc8950ed…5f6c5`); Aramo-CCP-Refund-Execution-Release-Directive v1.0 (LOCKED); CCP Charter Amendments A1 (RF-1..RF-8) and A2 (RX-1..RX-10).
**Trigger:** PO 2026-11-16 — the refund dual gate is open in production (policy v2 ACTIVE with `ARAMO-COM-REFUND-POL-001@1.0`; `CCP_REFUND_EXECUTION_ENABLED=1` since 2026-11-16 01:47Z), but admin.aramo.ai has no way to start a refund. Refunds still run in the Stripe Dashboard (policy §7.6 interim).

## 1. Recon (origin/main 3047b198, 2026-11-16)
- **Server is complete.** A `REFUND` change request is created on `POST /platform/commercial/change-requests` with a closed payload: `amount_minor`, `currency`, `provider_invoice_ref` (`in_…`), `provider_payment_ref` (`pi_…`), `category` (R1–R8), `basis`, `refund_policy_ref`, optional `subscription_id` (`libs/subscription/src/lib/commercial/commercial-change-request.ts:648-662`, categories `:586-595`). It is approved, then applied on `/:id/billing-adjustment`, and dispatched to Stripe by the C1 durable command (`platform-commercial-billing-adjustment.controller.ts:53`).
- **The console never creates one.** Tenant › Commercial offers `plan | cancel | grant | revoke | recon | convert` only (`apps/platform-web/src/commercial/subscriptions/TenantCommercialDialogs.tsx:27,108-115`). The console already approves, applies and reports REFUND requests (`commercial-api.ts:173`, `commercial-model.ts:395,607`, refund report `platform-commercial-refund-report.controller.ts:53`).
- **The operator cannot see the payment id.** The tenant billing status lists Stripe invoices (`platform-commercial-billing-status.controller.ts:173`, `ProviderInvoiceState` in `billing-provider.port.ts:196-218`), but no response carries the `pi_…` payment reference, the amount already refunded or the refundable remainder. The provider already reads all three for one invoice (`readPaymentPicture`, `ProviderPaymentPicture` `billing-provider.port.ts:309-320`) and Aramo already counts its own outstanding refund reservations (`refundReservations`, `refund-remainder.gate.ts:90`).
- **Binding rule (Amendment A1 RF-5).** A refund is bound to the tenant's **open** SELF_SERVICE subscription and its billing account (`refund-remainder.gate.ts:65-67`); with no open self-service row the request is refused `REFUND_PAYMENT_MISMATCH / no_self_service_account`. A subscriber who has already cancelled cannot be refunded from the console. See ruling Q2.
- **One open request per tenant × product** (Q14) — a pending plan change blocks a refund request for the same tenant and product, and vice versa.

## 2. Work (fast track)
1. **Read endpoint** `GET /platform/commercial/tenants/:tenant_id/refundable-payments?product_key=…` — scope `platform:billing:read` plus the Finance amount permission (non-holders get 403, never amounts). For the newest paid Stripe invoices of the tenant's self-service subscription (at most 12): `invoice_ref`, `number`, `paid_at`, `period_start/end`, `currency`, `amount_paid_minor`, `refunded_minor` (provider), `reserved_minor` (Aramo outstanding REFUND requests), `remainder_minor`, `payment_ref`, `disputed` (bool), `live` (bool). Computed with the existing `readPaymentPicture` and `refundReservations` — no new rule, no write. A provider read failure returns the invoice with `remainder_minor: null` and `unverifiable: true` (never a guessed remainder).
2. **Console action** "Request refund" on Tenant › Commercial for a Stripe self-service product (new `DialogKind 'refund'` → `REFUND`). The dialog:
   - lists the refundable payments (item 1); invoices with no remainder, a dispute, or an unverifiable read are shown disabled with the reason;
   - amount defaults to the full remainder, editable down to $0.01, never above the remainder;
   - category (R1–R8, labels from the refund policy), basis (required, ≤2000 chars);
   - `refund_policy_ref` is filled from the ACTIVE policy and shown read-only; the action is hidden when the ACTIVE policy declares no refund keys;
   - before → after rows (payment, amount, currency, category) and the approval chain strip, like the other dialogs; typed confirmation of the tenant name.
   It creates and submits the request. Nothing executes until the chain is signed and the requester applies it (unchanged).
3. **Visibility:** the action shows only for holders of the Finance amount permission. The Approvals drawer already renders REFUND requests; no change.
4. **Contracts:** OpenAPI `openapi/platform.yaml` gains the read endpoint; the platform-web consumer pact (`pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts`) gains the read and the REFUND create interactions, verified by `pact/provider/src/verify-platform-admin.ts`.
5. **Tests:** model tests for remainder / default / bounds / disabled reasons; dialog tests (payload shape equals the server's closed key set; ref read-only from policy); controller test for the 403 non-holder path and the unverifiable path.

## 3. Out of scope
- Any change to the dual gate, the remainder rule, approval chains or apply (Amendments A1/A2 unchanged).
- App Store / Google Play / Razorpay refunds (policy exclusions stand; Apple and Google refund through their stores).
- Refunds from the sign.aramo.ai subscriber side.
- Bulk refunds, partial-per-line refunds, credit notes.

## 4. Rulings (PO 2026-11-16: Q1 yes, Q2 (a), Q3 yes, Q4 yes)
- **Q1 (scope):** adopt §2 items 1–5 as written.
- **Q2 (cancelled subscribers):** today a cancelled subscriber cannot be refunded from the console (RF-5 binds the open row). Options: **(a)** keep RF-5 — v1 refunds open subscriptions only; refunds after cancellation stay in the Stripe Dashboard under §7.6 *(recommended for this fast track)*; **(b)** extend the binding to the tenant's most recent SELF_SERVICE row (open or ended) with the same billing account — a Charter A1 change that needs a Lead ruling and an amendment before build.
- **Q3 (who requests):** Finance amount holders only (recommended), matching who applies.
- **Q4 (release):** ships behind the already-open dual gate; first live use is the proof refund on a $10 Personal Standard test purchase, then the subscription is cancelled.

## 5. Acceptance
- On prod, a finance admin opens Tenant › Commercial for the test tenant, sees the paid $10 invoice with remainder $10.00, requests a full refund (R7 goodwill, basis "launch proof"), the chain is signed, the request is applied, Stripe shows the refund with the command metadata, the webhook is recorded, and the refund report lists it.
- A second request on the same payment shows remainder $0.00 and is disabled.
- `nx run api` integration, platform-web tests, pact verification and the vocabulary check pass in CI.
