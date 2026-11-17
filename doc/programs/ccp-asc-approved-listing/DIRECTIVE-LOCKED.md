# CCP Billing Products — App Store approved-listing sync — Directive v1.0 (LOCKED)

- **Date:** 2026-11-17.
- **Authority:** PO ruling 2026-11-17, "Code fix (Recommended)": the sync skips the text edit when Apple's listing is approved, flags it, and still syncs prices and pins the version. The PO changes the text in App Store Connect; it goes to Apple with the next app version.
- **Governing:** CCP Billing Products LOCKED 3d2b67c1 + A1 b3499d63 (BP-2..BP-14, A1-1 store listing). This directive narrows A1-1 for an approved App Store listing only.
- **Track:** fast track. One adapter method plus its spec. No schema change, no UI change, no new setting.
- **Base:** `origin/main` 35ee5f88.

## 1. Incident (prod, 2026-11-17)

- Personal Standard v5 was published at 08:17:01Z. Its request listing is "Personal Standard" / "50 sends a month".
- The App Store product `ai.aramo.sign.personal_standard.monthly` is APPROVED. Its en-US localization is APPROVED and reads "Personal - Standard" / "25 sends a month".
- `AppleAscClient.syncLocalization` sent a PATCH. App Store Connect answered HTTP 409 `ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE`, "Cannot edit SubscriptionLocalization when it is in ACTIVE state".
- The job settled NEEDS_ATTENTION before the price, availability and pin steps. v5 therefore has no APP_STORE pin, and v4 is RETIRED. `StoreBillingService.createIntent` refuses every new iOS purchase with `store_product_not_available`, and the plans view lists no App Store product.

## 2. Substrate (audited 2026-11-17 against 35ee5f88)

- `libs/subscription/src/lib/billing/sync/apple-asc.client.ts`
  - `sync()` runs `syncLocalization` → `syncPrice` per territory → `syncAvailability` → `syncScreenshot`, then returns `status: 'SYNCED'` with `detail` (a manual-step note, or null).
  - `syncLocalization()` POSTs a missing en-US localization, returns when the text is equal, and otherwise PATCHes.
- `billing-products.service.ts` `drain()`: a returned outcome pins the store product and settles SYNCED with `last_error = outcome.detail`, which the console shows. A thrown PROVIDER_REJECTED settles NEEDS_ATTENTION with no pin.
- The console's Retry (BP-14) re-queues a NEEDS_ATTENTION job.

## 3. Change

1. `syncLocalization()` returns a note (`string | null`) instead of `void`.
2. When the en-US localization exists, its text differs, and its `state` is `APPROVED`: no PATCH. The note says the App Store text was not changed, quotes the live and the catalog text, and says to change it in App Store Connect.
3. When the PATCH is answered with a PROVIDER_REJECTED error whose body carries `UNMODIFIABLE` (any other locked state): the same note, no throw.
4. Any other PATCH or POST error propagates as today.
5. `sync()` carries on with prices, availability and the screenshot, and returns `detail` = the listing note and the review note, joined; null when neither applies.
6. Logging is unchanged: reason codes and product ids only.

## 4. Tests (`libs/subscription/src/tests/ccp-apple-asc-client.spec.ts`)

- The fake App Store Connect returns the localization `state`, and answers PATCH of an APPROVED localization with the live 409 body.
- An approved listing with different text: no PATCH, the price still moves, the result is SYNCED, `detail` names the listing note.
- A 409 UNMODIFIABLE on PATCH of a non-approved state: the same outcome.
- An editable listing (not yet approved): PATCHed as today. A different 409 still throws PROVIDER_REJECTED.

## 5. Out of scope (scope freeze)

- The Google Play HTTP 403 on create. That is a Play Console permission or propagation matter; the job re-checks hourly.
- Editing the App Store text. That is the PO, in App Store Connect.
- Excluding Sandbox purchases from revenue (F-1).

## 6. Ship plan

1. Gate 5: the spec, plus `nx` typecheck, lint and test for `subscription`; the vocabulary script.
2. Gate 6: commit, PR, CI green, merge (PO-authorized by the ruling above).
3. Deploy `platform-admin` only, by the RELEASE-box runbook: backup, build, rollback tag, recreate.
4. The PO presses Retry on the v5 App Store row in the console (catalog@ or the owner).
5. Verify: the row is SYNCED with the listing note; v5 has an APP_STORE pin; the plans endpoint lists the App Store product for a Personal tenant.
