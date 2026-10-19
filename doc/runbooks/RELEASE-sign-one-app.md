# Release runbook — Aramo Sign: one app, one address (Sign Unified Product S-2)

Governing: `Aramo-Sign-Unified-Product-Permission-Contract-Platform-API-Directive-v1_0-LOCKED`
(SHA-256 `1a827ebc81b6c93943da44a62b2e90b761defb6fdf1354fd04ab68b3a9520fe3`) §4.1, D-1 – D-3, as amended by
`Aramo-Sign-Unified-Product-D1-Host-Retirement-Addendum-v1_0-LOCKED` (SHA-256
`fc65d003dcdf497a03a45414e67441740f1cb6110a64e64aa788b6f9e2e29b45`): `sign.aramo.ai` is the only Sign address and
`esign.aramo.ai` is retired **with no redirect**. It amends the Host & Workspace Ruling v1.0 on host topology only.

**Status: DEPLOY=NO.** Production host, DNS, nginx and Cognito changes need their own explicit authorization (§9).
Until then production keeps the pre-S-2 layout (console on `esign.aramo.ai`, signer pages on `sign.aramo.ai`).

## What ships

| Piece | Where |
|---|---|
| One SPA `apps/sign-web` (`scope:sign`), two bundles by zone | `apps/sign-web/src/{zones.ts,main.tsx,guest/,workspace/}` |
| `apps/esign-web` | removed (moved into `apps/sign-web/src/workspace/`) |
| One nginx block `${NGINX_SIGN_SERVER_NAME}` | `deploy/nginx/templates/aramo.conf.template` |
| `${NGINX_ESIGN_SERVER_NAME}` | retired: `return 410;` only (never a redirect). It exists only so wildcard DNS never routes the retired name to the tenant app, and is removed with the DNS record. |
| One base URL `ARAMO_SIGN_BASE_URL` | `libs/esign/src/lib/sign-base-url.ts`. The fallbacks are `ESIGN_SIGN_WEB_BASE_URL`, then `ESIGN_SENDER_WEB_BASE_URL`. |
| Code defaults | `DEFAULT_SIGN_ENTRY_URL` and `DEFAULT_PRODUCT_HOST` → `sign.aramo.ai` |

No database migration.

### Zones on the one host

| Zone | Paths | Authority |
|---|---|---|
| Guest signing | `/s/:token`, `/d/:token`, `/v1/esign/signing/*` | Capability token only. No session call, no workspace code, `credentials: 'omit'`, `Cache-Control: no-store`, a first-party-only CSP. |
| Public entry | `/login`, `/signed-out`, `/signup`, `/v1/signup/sign/*` | None. Signup stays dark (`SIGN_PUBLIC_SIGNUP_ENABLED`). |
| Workspace | everything else, `/v1/esign/sender/*`, `/v1/esign/billing/*`, `/auth/*` | Aramo SSO (consumer `esign`) plus the Sign permission contract (S-1). |

**Edge rate limits:**
- `sign_guest`: 10 requests per second per address, burst 60.
- `sign_signup`: 10 requests per minute, burst 10.
- Over the limit returns 429.

**Security headers:**
- CSP, HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `Permissions-Policy` on the host.
- The guest pages set the full stricter set themselves.

## Activation (separately authorized)

1. **Cognito**: register `https://sign.aramo.ai/auth/esign/callback` and the sign-out URL `https://sign.aramo.ai/signed-out`
   on the app client. Remove the `esign.aramo.ai` entries once the cutover smoke checks pass (there is no compatibility window).
2. **Box `.env`**:
   - `AUTH_PRODUCT_HOSTS=sign.aramo.ai` (was `esign.aramo.ai`);
   - `ARAMO_SIGN_BASE_URL=https://sign.aramo.ai`;
   - `NGINX_SIGN_SERVER_NAME=sign.aramo.ai` (already set);
   - keep `NGINX_ESIGN_SERVER_NAME=esign.aramo.ai` until the DNS record is removed, so the retired name answers 410
     rather than reaching the tenant app.

   The seeded `auth.HostAuthProfile` PRODUCT row is a dark scaffold. The `AUTH_PRODUCT_HOSTS` env is what login uses.
3. **Billing provider** (when Stripe is configured): the webhook endpoint is `https://sign.aramo.ai/v1/esign/billing/webhook/stripe`.
   The retired host answers 410, so the provider must be configured on `sign.aramo.ai` only.
4. Build the images, then recreate auth-service, esign-service, platform-admin and api, then nginx. Verify `ARAMO_RELEASE_REVISION`.
5. **Smoke checks:**
   - `curl -sI https://sign.aramo.ai/sign/` returns 200 with `Content-Security-Policy`.
   - `curl -sI https://sign.aramo.ai/s/x` returns 200 with `Cache-Control: no-store` and a CSP without third-party origins.
   - `curl -sI 'https://esign.aramo.ai/sign/envelopes?tab=waiting'` returns **410** with no `Location` header (never a 30x).
   - `curl -s https://sign.aramo.ai/v1/esign/sender/context` returns 401 `AUTH_REQUIRED`.
   - A signer link issued **before** the release still signs (`/s/<token>` on `sign.aramo.ai` is unchanged).
   - Workspace sign-in on `sign.aramo.ai` reaches Microsoft through Cognito.

## Retiring `esign.aramo.ai` (no redirect)

**Inventory of production, taken read-only on 2026-10-19 at release `5fda0db2`:**

| Reference | Finding | Transition |
|---|---|---|
| Signer links (`/s/…`) and signed-copy links (`/d/…`) | Always built from `ESIGN_SIGN_WEB_BASE_URL=https://sign.aramo.ai`. **None use `esign.aramo.ai`.** | Unaffected. The 1 live signing session and the 1 in-progress envelope keep working. |
| Live signed-copy grants | 0 | — |
| Sender emails (console links) | `ESIGN_SENDER_WEB_BASE_URL` was never set, so **no email ever linked `esign.aramo.ai`** | Links now use `ARAMO_SIGN_BASE_URL`. |
| Envelopes created in the console | 0 | — |
| `AUTH_PRODUCT_HOSTS` | `esign.aramo.ai` | Set to `sign.aramo.ai` at cutover. |
| Cognito callback and sign-out | `esign.aramo.ai/auth/esign/callback` and `/signed-out` are registered | Register the `sign.aramo.ai` pair first. Remove the `esign.aramo.ai` pair after cutover. |
| App Home Sign tile | Dark (`ARAMO_SIGN_ENTRY_ENABLED=false`); the default URL is now `https://sign.aramo.ai/` | — |
| Stripe return URLs and webhook | Not configured | When configured, use `sign.aramo.ai` only. |
| Bookmarks | The console has been reachable on `esign.aramo.ai` since 2026-10-19 (release `5fda0db2`). The nginx access log does not record the host, so usage cannot be measured. | Users reopen `sign.aramo.ai`. The retired name answers 410. |

**Cutover order (separately authorized):**
1. Register the Cognito URLs for `sign.aramo.ai`.
2. Set `AUTH_PRODUCT_HOSTS=sign.aramo.ai` and `ARAMO_SIGN_BASE_URL`.
3. Deploy, then run the smoke checks.
4. Verify that `esign.aramo.ai` answers 410 and never 30x.
5. Remove the `esign.aramo.ai` Cognito URLs.
6. Later, remove the DNS record and the 410 block.

## Rollback

An image rollback restores the two-app layout. No data changes. If only the host move must be undone, set
`AUTH_PRODUCT_HOSTS` back and recreate auth-service and nginx with the prior image.

## Tests

- `apps/sign-web/src/zones.spec.ts`:
  - the zone map;
  - the guest code imports neither `@aramo/fe-foundation` nor workspace code;
  - every guest API call omits credentials.
- `ci/scripts/verify-frontdoor-conf.ts` (k) and (k2):
  - exactly the four Sign `/v1` locations;
  - the rate limits;
  - the host-wide and guest headers;
  - the guest shell served in place;
  - the retired esign host answers 410 only and never redirects (a redirect fails the gate).
