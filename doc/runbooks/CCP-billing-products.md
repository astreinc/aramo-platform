# Runbook: CCP Billing Products (one catalog across web and apps)

Governing directive: `Aramo-CCP-Billing-Products-One-Catalog-Directive-v1_0-LOCKED.md` (sha256 `3d2b67c1…`)
and Amendment A1 (`…-v1_0-A1-LOCKED.md`, sha256 `b3499d63…`: store listing, explicit countries).

The admin console is the one place where a plan's billing products are created, priced and linked:
Stripe (web), App Store (iPhone) and Google Play (Android). After a `PLAN_VERSION_PUBLISH` request is
approved (Finance, then Owner) and applied, the platform-admin worker makes each provider match the
catalog and only then links the version for purchase. Nothing is created or priced by hand in App Store
Connect, the Play Console or the Stripe dashboard.

## 1. What stays outside the console (one-time, per store)

These are store-mandated account steps. None of them is a product or a price.

| Store | Step |
|---|---|
| Apple | Paid Apps agreement, bank, tax, EU trader status |
| Apple | App Store Server Notifications V2 URL (production + sandbox): `https://sign.aramo.ai/v1/sign/billing/webhook/app-store` |
| Apple | Sandbox tester accounts |
| Apple | App Store Connect API **team key** with the **App Manager** role (Users and Access → Integrations → App Store Connect API → Team Keys). The `.p8` downloads once: keep it in the password manager. |
| Apple | The first subscription goes to Apple review together with an app version (Apple rule): App Store Connect → the subscription → Add for Review, then submit the app version |
| Google | Payments profile; a service account invited to the Play Console with subscription and financial permissions; an app build that declares the billing permission on a track; Real-time developer notifications (Pub/Sub) |
| Stripe | Account and tax settings; the live key only when live Stripe is authorized |

## 2. Configuration (platform-admin; every value unset = off)

| Variable | Meaning |
|---|---|
| `CCP_BILLING_SYNC_ENABLED` | `1` turns the worker on (master switch). Anything else: no provider is ever called. |
| `CCP_BILLING_SYNC_INTERVAL_MS` | Worker interval (default 60000, minimum 1000). |
| `CCP_ASC_API_ISSUER_ID` | App Store Connect issuer id (the team's; same as `SIGN_APPLE_IAP_ISSUER_ID`). |
| `CCP_ASC_API_KEY_ID` | The team key id (e.g. `9S9F8ABUFN`). |
| `CCP_ASC_API_PRIVATE_KEY_B64` | base64 of the team key `.p8`. |
| `CCP_ASC_APP_ID` | The app's Apple id (Aramo Sign: `6832497286`). |
| `CCP_ASC_SUBSCRIPTION_GROUP_ID` | The subscription group (Aramo Sign: `22560615`). |
| `SIGN_GOOGLE_PLAY_PACKAGE`, `SIGN_GOOGLE_PLAY_CREDENTIALS_B64` | Google Play (shared with sign-service). |
| `STRIPE_SECRET_KEY`, `STRIPE_API_BASE` | Stripe (read only through the Stripe adapter's reader). |

Secrets go into the box `.env` by pipe, never through chat or the repo. Example for the App Store key,
run on the operator's Mac (the key never prints):

```
base64 < ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8 | tr -d '\n' \
  | ssh ubuntu@<box> 'v=$(cat); sudo sh -c "printf \"CCP_ASC_API_PRIVATE_KEY_B64=%s\n\" \"$v\" >> /opt/aramo/.env"'
```

Take an env snapshot first (`deploy/backup/aramo-env-snapshot.sh --label pre-billing-sync`), then
recreate platform-admin only (`RELEASE-box.md` step 6, pinned to the running image).

## 3. Using it

1. **Draft** a new version of the plan (Catalog → plan → New draft) and set prices. Regional prices also
   decide where the apps sell: the App Store and Google Play sell a plan in the US and in each country
   that has a regional price, at exactly that price. Pick the country from the list; the currency is the
   App Store's currency there (for India: IN / INR 999.00).
2. **Request publish.** The dialog shows the billing products: one row per channel the plan may sell on
   (Personal: web, iPhone, Android; Business: web only). Ids default to `ai.aramo.sign.<plan>.monthly`
   (stores) and `aramo_sign_<plan>` (Stripe), and are permanent once synced. A new App Store product needs
   the review screenshot (an iPhone screenshot of the in-app Plans screen). **Preview prices** shows the
   exact price per channel and country; a store without that exact price is refused, never rounded.
   Unticking a channel the plan sells on today is an explicit "stop selling" the approvers see.
   A store product also needs the **store listing**: the name (2–30 characters) and description (1–45)
   shoppers see on the App Store and Google Play (Apple's limits; the plan's internal description is never
   sent). **Preview prices** is required before the request; it lists any country a store sells the plan in
   today that this version has no price for. Tick each one to confirm the stop, or add its regional price.
   Without that, the sync refuses to narrow the store's countries.
3. **Approve** (Finance, then Owner). Approvers see the channels, the stops and the preview prices.
4. **Apply.** One sync job per channel is queued. The worker runs them; the version screen's
   **Billing products** panel shows each channel: Syncing, In sync (with the store's state, for example
   `READY_TO_SUBMIT`), Retrying, Needs attention (with the provider's error) or Not connected.
   The Owner can **Retry** a failed one.
5. A channel sells the version only once its sync succeeded.

## 4. Price check

Finance (`platform:billing:read`) sees the **Price check** under the version's billing products, and the
same data at `GET /platform/commercial/store-price-reconciliation` (`billing_products`): the catalog
price against each channel's live price per country, the US price included. It reports; it blocks
nothing.

## 5. Failure handling

| Status | Meaning | Action |
|---|---|---|
| Retrying (`FAILED`) | Network, 5xx or throttling | Automatic backoff (1 min → 6 h), then Needs attention |
| Needs attention | The provider refused (e.g. no exact price point, description too long), or a newer version superseded this one | Fix the catalog (a new version) or the store account step, then Retry |
| Not connected (`NOT_CONFIGURED`) | That provider's credentials are not set | Configure them; the job re-checks hourly |

A store product is never deleted (Apple never frees an id). To stop selling, publish a version that
stops selling on that channel.
