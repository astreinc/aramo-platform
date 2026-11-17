# CCP Billing Products — App Store approved-listing sync — Amendment A1 (LOCKED)

- **Date:** 2026-11-17.
- **Amends:** `DIRECTIVE-LOCKED.md` v1.0 in this folder (merged #1116, deployed `platform-admin` 6b7ddbe7).
- **Authority:** PO ruling A1-1, 2026-11-17: "Move everyone to $8". Existing App Store subscribers move to the new price too.
- **Track:** fast track. One adapter method plus its spec. No schema change, no UI change, no new setting.
- **Base:** `origin/main` 6b7ddbe7.

## 1. Incident (prod, 2026-11-17 12:45Z, after the v1.0 deploy)

- The PO pressed Retry on the Personal Standard v5 App Store row. The listing step now passes (v1.0).
- The price step sent `POST /v1/subscriptionPrices` with `startDate: null`. App Store Connect answered HTTP 409 `STATE_ERROR`, "Initial price cannot be created again after subscription is approved."
- The job settled NEEDS_ATTENTION again. v5 still has no APP_STORE pin, and new iOS purchases are still refused.

## 2. Change

1. `syncPrice` takes whether the App Store product is `APPROVED`.
2. On an approved product that already has a price in that territory, the new price is a **scheduled change**: `startDate` = tomorrow (UTC, `YYYY-MM-DD`) and `preserveCurrentPrice: false` (ruling A1-1). Apple always accepts a future date.
3. A change already scheduled to the same price point is kept: no second POST (an idempotent Retry).
4. A product Apple has not approved yet keeps today's behaviour: `startDate: null`.
5. `currentPrice` also returns the price points scheduled after today.
6. The sync completes, so the version is pinned at once. New iOS buyers pay the current price until the start date, then the new one; existing subscribers move from their next renewal on or after it.

## 3. Tests (`libs/subscription/src/tests/ccp-apple-asc-client.spec.ts`)

- The fake App Store Connect answers an initial price on an approved product with the live 409, and records scheduled changes.
- Approved product, new price: both territories scheduled for tomorrow with `preserveCurrentPrice: false`; the price in effect is unchanged; SYNCED.
- A retry with the change scheduled: no price written.
- Approved price already equal: no price written.
- A product not yet approved: the immediate price, as before.
- The v1.0 approved-listing tests now expect the scheduled change.

## 4. Out of scope

- The App Store text (the PO, in App Store Connect).
- Web (Stripe) subscribers keep their pinned price; this amendment changes only the App Store.

## 5. Ship plan

As v1.0 §6: Gate 5, PR, CI, merge, deploy `platform-admin` only, the PO presses Retry, verify the pin and the scheduled price at Apple.
