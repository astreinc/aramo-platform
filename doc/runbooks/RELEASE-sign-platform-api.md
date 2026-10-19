# Release runbook — Aramo Sign platform API: applications, installations, credentials, webhooks (S-4, S-5)

Governing: `Aramo-Sign-Unified-Product-Permission-Contract-Platform-API-Directive-v1_0-LOCKED` (SHA-256
`1a827ebc81b6c93943da44a62b2e90b761defb6fdf1354fd04ab68b3a9520fe3`) §4.4. Activates ES-2 B-4.

**Status: DEPLOY=NO.** Production migrations and deployment, and any public third-party activation (D-13), need their own
authorization (§9). These surfaces are first-party only: they are served by esign-service on the internal network and
are **not** proxied by the public Sign host. `ci/scripts/verify-frontdoor-conf.ts` (k) pins that.

## Authority

**Effective Sign permissions = Principal authority ∩ Installation grants ∩ Delegated scope.** The computation is in
`apps/esign-service/src/app/integrations/effective-authority.ts`.

| Mode | Principal | Notes |
|---|---|---|
| USER (token exchange) | The user. Their Aramo access token is verified by `JwtAuthGuard`, and their Sign permissions are resolved server-side. | A first-party application's delegation profile applies only when the user holds its required platform permission (ATS: `document:execute`). No Sign role is issued. |
| APPLICATION (`client_credentials`) | The installation's integration identity, with the Sign role a Sign admin set (Admin, Sender or Viewer). | An asserted external role is honoured only if the installation may assert it and a tenant mapping exists. A mapping can only narrow. |

An integration acts only on envelopes its own application created (installation isolation).

## Surfaces

| Route | Purpose |
|---|---|
| `POST /v1/esign/oauth/token` | Issues a token: opaque, at most 300 s, audience `aramo-sign-api`, tenant-scoped, stored only as a digest. |
| `/v1/esign/api/*` | availability, envelopes (create, for-document, get, evidence, executed, send, remind, void) |
| `/v1/esign/sender/integrations/*` | Workspace administration (`esign:integration:manage`): installations, credentials (the secret is shown once), role mappings and webhook subscriptions. |
| `sign-integration.command.js` | Operator CLI: `first-party-credential`, `first-party-webhook`, `register-application`, `revoke-credential`. |

## Webhooks (S-5)

- **Routing:**
  - Events go to the envelope's installation subscriptions, plus the application-level subscriptions of a first-party application.
  - Each event becomes one delivery row per subscription, with its own retry state (15 attempts, then DEAD).
  - Each request is signed with the **subscription's own secret**: HMAC-SHA256 over `timestamp.body`.
  - Headers: `x-aramo-esign-timestamp`, `-signature`, `-event-id`, `-subscription-id`.
- **Secrets:** encrypted at rest with AES-256-GCM under `ESIGN_WEBHOOK_SECRET_KEY` (32 bytes, base64). If the key is
  unset, subscriptions are unavailable (503) and no delivery is signed.
- **Tenant-configured targets:** public HTTPS on port 443, no credentials in the URL. Private and loopback addresses are
  refused when the target is saved and again at connect time on every delivery, which closes the DNS-rebinding window.
  Operator `first-party-webhook` targets may be internal.
- **Legacy:** the old single target (`ESIGN_WEBHOOK_TARGET_URL` / `DOCUMENTS_API_URL`, with the shared
  `ESIGN_WEBHOOK_SIGNING_SECRET`) is used **only** for ATS envelopes while the ATS has no subscription. Envelopes of any
  other application, including Sign-app envelopes, are not delivered anywhere without a subscription.

## Activation (separately authorized)

1. Back up the database. Apply the migrations `20261019160000_sign_envelope_provenance`, `20261019170000_sign_integrations`
   and `20261019180000_sign_webhook_subscriptions` (additive), then run `seed-prod.sh`. The seed adds the S-1 scopes and grants.
2. Box `.env`: set `ESIGN_WEBHOOK_SECRET_KEY` (`openssl rand -base64 32`). Never reuse the legacy shared secret.
3. ATS migration (S-6), run in order:
   1. `first-party-credential aramo-ats`, then set the api's Sign client id and secret.
   2. `first-party-webhook aramo-ats http://api:3000/v1/integrations/esign/events`, then set the api's subscription secret.
   3. Recreate esign-service and api. Verify `ARAMO_RELEASE_REVISION`.
4. **Smoke checks:**
   - an RTR send (token exchange → `/v1/esign/api/envelopes` with `send`);
   - the completion write-back arrives with the subscription signature;
   - `SignWebhookDelivery` shows DELIVERED.
5. External applications: register with `register-application`. They are **not** reachable until public third-party
   activation is authorized and the front door exposes the routes.

## Rollback

Image rollback is safe: the tables are additive and unused by the older images. To stop an integration immediately,
revoke its installation in the Sign workspace; this revokes its credentials and every live token. To stop a webhook,
disable its subscription.
