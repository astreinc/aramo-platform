# Release — Aramo Sign self-service billing (Stripe)

Governing directive: `Aramo-Sign-Standalone-Product-Final-Implementation-Authorization-v1_0-LOCKED`.
Deploying, entering live keys, charging cards and opening public signup each need
separate authorization. This runbook is the order of operations once those are given.

## What ships

- Migration `libs/subscription/prisma/migrations/20261019100000_subscription_lifecycle_billing`
  (additive): subscription status + billing-provider linkage, `SELF_SERVICE` source, sellable
  plans, the catalog row `aramo-sign-business-v1` (100 envelopes / month, no rollover),
  `CheckoutIntent`, `BillingEvent`. Existing subscriptions become `ACTIVE` (no behaviour change).
- esign-service `v1/esign/billing/*`: plans, account, checkout, portal, and the Stripe webhook
  `POST /v1/esign/billing/webhook/stripe` (no session; Stripe-Signature verified over the raw body).
- nginx: `location /v1/esign/billing/` in the esign.aramo.ai server block.
- esign-web: Settings → Plan & billing, and the setup page for an organization admin who holds no
  Sign role yet.

## Behaviour

- Unset `STRIPE_SECRET_KEY` ⇒ checkout and portal answer `ESIGN_BILLING_UNAVAILABLE` (503) and the
  plan shows "Online checkout isn't available yet". Nothing is charged. Sending is unchanged.
- A subscription opens only when Stripe's verified webhook (or the reconcile sweep) reports it. The
  state is always re-fetched from Stripe before it is applied; each event id is processed once.
- The user who started checkout receives `esign_owner` only if they are still an active member of
  that tenant holding `org_admin` or `tenant_owner`. Nobody else's access changes.
- `past_due` keeps sending for `BILLING_PAST_DUE_GRACE_DAYS` (default 7), then sending stops.
  `unpaid` / `paused` stop sending at once. `canceled` ends the subscription. Envelopes already sent
  can always be signed and downloaded; only new sends are refused.
- A new paid subscription ends an open MANUAL / DEVELOPMENT subscription in the same transaction.

## Stripe setup (test mode first)

1. Product "Aramo Sign Business", one recurring monthly price. The amount is a commercial decision
   (open — see below); Aramo never stores or shows it.
2. Billing portal: allow payment-method update, invoice history, cancellation at period end.
3. Webhook endpoint `https://esign.aramo.ai/v1/esign/billing/webhook/stripe`, events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, the three
   subscription lifecycle events (created, updated, deleted), `invoice.paid`,
   `invoice.payment_failed`. Any other event is recorded `IGNORED`.
4. Box `.env` (never committed): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PLAN_PRICES=aramo-sign-business-v1=price_…`, `ESIGN_BILLING_RECONCILE_ENABLED=1`.
   `ESIGN_SENDER_WEB_BASE_URL=https://esign.aramo.ai` (checkout return URLs).

## Order

1. Back up the database. Apply the migration (BUILD before SEED: compiled image).
2. Recreate esign-service and nginx; verify `ARAMO_RELEASE_REVISION`.
3. Probe: `POST /v1/esign/billing/webhook/stripe` without a signature ⇒ 401 `AUTH_REQUIRED`.
4. Test mode end to end: an organization admin opens esign.aramo.ai → setup page → Subscribe →
   Stripe test card → back on Plan & billing ("Confirming…" then Active) → the admin now has the
   Sign console. Send one envelope; usage shows 1 of 100.
5. Live keys only after the live-charging authorization.

## Vocabulary boundary

Stripe's vendor-defined identifiers appear only in `libs/subscription/src/lib/billing/stripe-wire.ts`
and its contract spec `stripe-wire.spec.ts` — the two files with a file-scoped vocabulary
exemption (Architect ruling 2026-10-19, approved with restrictions). Every Aramo-owned model,
column, DTO and API uses `account_ref`; the adapter itself is fully gated.

## Rollback

Image rollback restores the code. The migration is additive and can stay. To stop self-service
without a rollback, unset `STRIPE_SECRET_KEY` and recreate esign-service: existing subscriptions
keep their last state.

## Open decisions (not invented here)

- Monthly price and currency; tax (Stripe Tax: `STRIPE_AUTOMATIC_TAX=1`).
- Trial policy (none is configured; Stripe trials map to `TRIALING`, which sends).
- Terms of service, privacy notice and the electronic-signature disclosure text (D-10;
  disclosure v1 is `LEGAL_PENDING`).
- Retention of documents and evidence after a subscription ends (they are kept today).
