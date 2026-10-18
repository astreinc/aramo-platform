# RELEASE — Aramo Sign envelope allowance (Multi-Provider PR 1)

Governing: `Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-v1_0-LOCKED.md`;
addendum `doc/directives/Aramo-E-Sign-Multi-Provider-Addendum-A1-Precedence-and-Traceability-v1_0.md`.

## What changes at deploy
- New schema `subscription` (migration `20261018120000_init_subscription_allowance`): plan catalog, subscriptions, allowance ledger. Additive; the only seed is the catalog row `aramo-sign-included-v1` (100 envelopes / month).
- esign-service refuses every Aramo Sign send for a tenant with no open subscription (`ESIGN_NOT_SUBSCRIBED`, 403) and at the limit (`ESIGN_ALLOWANCE_EXHAUSTED`, 409).

## Blocking prerequisite (needs separate authorization)
**Production tenants have no subscription.** Without one, RTR and Offer sends stop for every tenant the moment this ships. Before deploying, the PO must authorize opening a MANUAL subscription for each tenant that sends (anchor = the agreed billing date). There is no production command for this in PR 1 on purpose; the governed path is a Lead/PO decision.

## Never in production
- `npm run prisma:seed-dev-subscription` (DEVELOPMENT subscriptions). It refuses `NODE_ENV=production` and any `ARAMO_ENV` other than `local`/`test`. It is called only by `tools/local-stack.sh`.

## Verify after deploy
1. `SELECT key FROM subscription."Plan";` → `aramo-sign-included-v1`.
2. `SELECT count(*) FROM subscription."TenantSubscription" WHERE source = 'DEVELOPMENT';` → 0.
3. A send for a subscribed tenant: one `CONSUMED` row in `subscription."AllowanceUsage"` and one `esign.envelope.sent` row in `metering."UsageEvent"`.

## Rollback
Image rollback restores the previous send path. The `subscription` schema is additive and can stay.
