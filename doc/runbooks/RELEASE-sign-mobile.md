# Release runbook — Aramo Sign Mobile (native iOS and Android app)

Governing instruments, all LOCKED on 2026-10-25:
- `Aramo-Sign-Mobile-Native-Application-Implementation-Directive-v1_0-LOCKED`: §2, §4 B-13, §11, §12, §14 (P-1 to P-12) and §15;
- `Aramo-AUTH-SIGNIN-1-Amendment-M-A1-Native-Authentication-Consumer-v1_0-LOCKED`;
- `Aramo-Sign-Unified-Product-Amendment-M-A2-Mobile-Signing-Session-Deep-Links-v1_0-LOCKED`, especially §3;
- `Aramo-Sign-Unified-Product-Amendment-M-A3-Mobile-Owned-Data-Contracts-v1_0-LOCKED`.

SHA-256 values are in the `.sha256` sidecars.

**Status: DEPLOY=NO.** The directive does not authorize any of the following (§15):
- live Cognito client or trigger changes;
- production migrations or deployment;
- publishing Privacy Notice 1.1;
- enabling production push;
- store publication.

Each step below needs its own explicit authorization from the owner named in its row. This runbook contains no
secrets. Secret values live only in the files and stores it names.

## What each prerequisite unblocks

| # | Prerequisite | Owner | Unblocks | Acceptance criteria (§12) |
|---|---|---|---|---|
| G-089 | PreSignUp trigger v2 cutover | PO + Lead | Is the precondition for P-5 going live: native sign-up can never link providers by email | 2 (safely) |
| P-1 | Apple Developer Program (organization) | PO | The Team ID for `SIGN_IOS_APP_ID`; App ID `ai.aramo.sign`; Associated Domains; push capability; device builds | 1, 2, 5, 10, 16 |
| P-2 | APNs auth key (.p8), Key ID, Team ID | PO | iOS push delivery (`apns` adapter) | 10, 18 (revoked-device push) |
| P-3 | Google Play Console (organization) | PO | Package `ai.aramo.sign`; app-signing and upload-key SHA-256 for `assetlinks.json`; Play-signed builds | 1, 5, 10 |
| P-4 | Firebase project (FCM HTTP v1) | PO | Android push delivery (`fcm` adapter) | 10, 18 |
| P-5 | Cognito public client `aramo-sign-native` | PO + Lead | Native sign-in against production Cognito | 2, 3, 18 (code binding) |
| P-6 | nginx on the Sign host | Lead (deploy) | `/.well-known/*` association files, `/auth/native/`, `/v1/sign/me/`, edge rate limits | 5, 12, 16 |
| P-7 | Box `.env` additions | PO | Wires P-2, P-4 and P-5 into the containers | 2, 3, 10 |
| P-8 | Database migrations (additive) | Lead (deploy) | Feed, devices, preferences, saved signatures, contacts, revision, idempotency, native device sessions, redeemed codes | 3, 6–13, 17, 18 |
| P-9 | Legal: Privacy Notice 1.1, subprocessors, retention, store forms | PO + counsel | Any production use (§11); the store listings | 19, and §11 |
| P-10 | CI macOS runner, signing credentials | PO (cost) | The `mobile:ios` CI job; signed device builds | 1, 19 |
| P-11 | Store publication | PO | **Not authorized.** | — |
| P-12 | Sign commercial capabilities (templates, Personal mode) | PO | **Not activated** by this program. | 13 (non-production only) |

Until a prerequisite exists, every criterion that depends on it is reported **unverified** in Gate-5, never as release-ready
(§14, §15).

## Order

Do the steps in this order: G-089 first, then P-1, P-3, P-5, P-9, P-8, P-7, P-6, and finally P-2 and P-4 with push enabled last.

Why this order:
- G-089 comes first. Native sign-in must not become another path around the provider-linking safeguards (P-5, M-A1 §6).
- Legal (P-9) must precede any production use (§11).
- Migrations (P-8) come before any code that reads them.
- nginx (P-6) is deployed last of the server pieces, because the association files make links open the app.

---

## G-089 — PreSignUp v2 cutover (first)

1. Follow `infrastructure/cognito-triggers/CUTOVER.md` exactly. Record every precondition (C1 onwards) and its result.
   This is a separate approval checkpoint (`doc/runbooks/RELEASE-auth-signin-1.md` step 4).
2. Record the post-cutover `CodeSha256` and the rollback zip location in the deploy record.

**Unblocks:** P-5 may go live.

## P-1 — Apple Developer Program

1. Enrol the organization **Astre Consulting Services Inc**. Record the **Team ID** (10 characters).
2. Register the App ID **`ai.aramo.sign`**, then enable these capabilities on it:
   - **Associated Domains**;
   - **Push Notifications**.
3. Confirm that the checked-in iOS project (`mobile/sign/ios/`) declares the entitlement `applinks:sign.aramo.ai`.
4. Note the value `SIGN_IOS_APP_ID=<TEAMID>.ai.aramo.sign` for P-7.

**Unblocks:** signed device builds and iOS Universal Links (once P-6 is live).

## P-2 — APNs auth key

1. In the Apple Developer account, create an **APNs auth key** (.p8). Record its **Key ID**. The Team ID is from P-1.
2. Put the key **on the box as a file**, never inline in `.env`:
   ```
   sudo install -d -m 0750 -o root -g 1000 /opt/aramo/secrets
   sudo install -m 0440 -o root -g 1000 <downloaded>.p8 /opt/aramo/secrets/apns-key.p8
   ```
   Group `1000` is the `node` user that runs sign-service (`apps/sign-service/Dockerfile`, `USER node`).
3. Confirm that the sign-service service in `docker-compose.prod.yml` mounts `/opt/aramo/secrets` **read-only**, and
   that `APNS_KEY_PATH` points at the in-container path of that file.
4. Prepare these for P-7 (the key itself never appears in `.env`):
   - `APNS_KEY_ID`;
   - `APNS_TEAM_ID`;
   - `APNS_KEY_PATH`;
   - `APNS_TOPIC=ai.aramo.sign`.

**Unblocks:** the `apns` push adapter.

## P-3 — Google Play Console

1. Create the app with package **`ai.aramo.sign`** in the organization's Play Console.
2. Enrol in Play App Signing. From **Setup → App signing**, copy:
   - the **app-signing key** SHA-256 fingerprint;
   - the **upload key** SHA-256 fingerprint.
3. Note these values for P-7:
   - `SIGN_ANDROID_PACKAGE=ai.aramo.sign`;
   - `SIGN_ANDROID_CERT_SHA256S=<app-signing SHA-256>,<upload SHA-256>`, in `AA:BB:…` form, comma-separated.
4. Never add the debug keystore fingerprint to production.

**Unblocks:** Android App Links (once P-6 is live) and Play-signed builds.

## P-4 — Firebase (FCM HTTP v1)

1. Create a Firebase project linked to the Android app `ai.aramo.sign`. Record the **project id**.
2. Create a service account with the minimum role needed to send FCM messages, and download its JSON key.
3. Put the key **on the box as a file**, never inline in `.env`:
   ```
   sudo install -m 0440 -o root -g 1000 <downloaded>.json /opt/aramo/secrets/fcm-service-account.json
   ```
4. Prepare these for P-7:
   - `FCM_PROJECT_ID`;
   - `FCM_SERVICE_ACCOUNT_PATH`, the in-container path of the mounted file.

**Unblocks:** the `fcm` push adapter.

## P-5 — Cognito public app client `aramo-sign-native`

This is a production Cognito change. G-089 must already be done.

1. Create a **new** app client `aramo-sign-native` in the production pool with these settings:
   - **Client secret:** none (public client).
   - **Flow:** Authorization code grant only, with PKCE (S256) required by the native endpoint.
   - **Callback URLs:** `https://sign.aramo.ai/auth/native/callback` and `aramosign://auth/callback`.
   - **Sign-out URLs:** M-A1 §6 requires them but does not fix their values, so the Lead records them at this
     checkpoint.
   - **Identity providers:** Google and Microsoft.
   - **Token validity:** set at this checkpoint (M-A1 §6). Aramo's own refresh validity is server-side: 30 days
     sliding, unless the Lead rules otherwise (M-A1 §3).

   Do not change the **existing browser client** or its callbacks.
2. Do not use `aws cognito-idp update-user-pool`, because it resets every setting the call leaves out (`CUTOVER.md`
   §1). Create the client with `create-user-pool-client` only.
3. Note `SIGN_NATIVE_COGNITO_CLIENT_ID` for P-7. Production uses the default `SIGN_NATIVE_REDIRECT_URIS`, unless the Lead
   rules otherwise.

**Unblocks:** native sign-in, refresh rotation and device sessions against production.

**Status 2026-10-26: done.**
- Created by `terraform apply` of the reviewed saved plan for `infrastructure/cognito-native-client` (main `ace5499f`).
  The plan was 1 to add, 0 to change, 0 to destroy, and a re-plan showed no changes.
- Client id: `5g5uo1n5rdvuv1k98jt1lvv90h`.
- The browser client `aramo` was not changed.
- The Aramo-layer legacy-link gap was closed first (`CUTOVER.md` §1).

## P-9 — Legal (before any production use)

1. Publish **Privacy Notice 1.1** with re-acceptance. Version 1.0 is never edited silently (A1-11 item 6). The notice
   covers these new categories:
   - device push tokens and device metadata;
   - the notification feed;
   - saved signatures;
   - contacts.
2. Add **Apple (APNs)** and **Google (Firebase Cloud Messaging)** to the published subprocessor list at
   `https://sign.aramo.ai/legal/subprocessors`.
3. Record the retention rows (a PO and counsel decision):
   - device tokens are removed on sign-out, revocation or account close;
   - feed entries, saved signatures and contacts follow the account.
4. Prepare the Apple privacy labels and the Google Data-safety form to match items 1–3. Store publication (P-11) stays
   **not authorized**.

**Unblocks:** any production use of the app.

## P-8 — Database migrations (additive)

1. Back up the database first (`doc/runbooks/RELEASE-box.md`).
2. List the program's migrations from the merged commit. Never use a hand-typed list:
   ```
   git diff --name-only <pre-program main SHA> <program merge SHA> -- 'libs/*/prisma/migrations/*/migration.sql'
   ```
   They are the sign migrations (notifications, devices, preferences, saved signatures, contacts, envelope message,
   envelope revision, idempotency) and the auth-storage migrations (native device sessions, redeemed-code ledger). Every
   one is ADD-only.
3. Apply them with the box's standard migration path (`RELEASE-box.md`). `migrate-prod.sh` does not dump for you,
   so take the dump first. Migrate **before** the containers that read the new tables are recreated (migrate BEFORE
   code). If the release also seeds, follow that runbook's order: migrate, build, seed, recreate.

**Unblocks:** every new server surface.

## P-7 — Box `.env` additions

Edit `/opt/aramo/.env` on the box with `sudo`. Every name below is documented in `.env.prod.example`.

| Var | Service | Value source | Notes |
|---|---|---|---|
| `SIGN_NATIVE_COGNITO_CLIENT_ID` | auth-service | P-5 | A public identifier |
| `SIGN_NATIVE_REDIRECT_URIS` | auth-service | default | Leave unset to use the default pair |
| `SIGN_PUSH_DELIVERY` | sign-service | `disabled` | Stays `disabled` until the final step |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` | sign-service | P-1, P-2 | Identifiers only |
| `APNS_KEY_PATH` | sign-service | P-2 | A file path, never the key |
| `FCM_PROJECT_ID` | sign-service | P-4 | |
| `FCM_SERVICE_ACCOUNT_PATH` | sign-service | P-4 | A file path, never the JSON |
| `SIGN_IOS_APP_ID` | nginx | P-1 | `<TEAMID>.ai.aramo.sign` |
| `SIGN_ANDROID_PACKAGE` | nginx | P-3 | `ai.aramo.sign` |
| `SIGN_ANDROID_CERT_SHA256S` | nginx | P-3 | Comma list of SHA-256 fingerprints |

Before deploying, run the local-only guard from the Mac: `node --import jiti/register ci/scripts/verify-env-passthrough.ts`.

**Unblocks:** the containers can see P-2, P-4 and P-5.

**Status 2026-10-26: `SIGN_NATIVE_COGNITO_CLIENT_ID` only (PO-authorized, for an internal device test).**
- **Change:** only `SIGN_NATIVE_COGNITO_CLIENT_ID` was set, after an `.env` backup.
  `SIGN_NATIVE_REDIRECT_URIS` was left unset, so the default pair applies.
- **Recreated:** auth-service only. The other containers were not touched.
- **Verified:** `POST /auth/native/sign/token` refused before the change (`native_client_not_configured`). After the
  change it reached the Cognito exchange (`code_exchange_rejected` for a dummy code). Browser sign-in was unchanged.
- **Pre-check:** nothing user-facing starts the native flow.
  - No web app links to it.
  - The app-association files are still empty.
  - There is no published app.
  - The native pages were not yet deployed.
  - The token route applies the same principal resolution as browser sign-in, so the result is never more access
    than the browser already gives.
- **Still pending:** P-9 legal (Privacy Notice 1.1, subprocessors) remains a precondition for any production use
  beyond internal testing. The push and app-link variables are unset.

## P-6 — nginx on the Sign host

The image comes from `deploy/nginx/Dockerfile`, and the edge contract is in `deploy/nginx/README.md` ("Sign host: rate
limits" and "Sign host: app-association files"). `ci/scripts/verify-frontdoor-conf.ts` rules (k) and (n) to (s) pin it.

What it adds:
- the `/auth/native/` location, to auth-service, in zone `sign_native_auth`;
- the `/v1/sign/me/` location, to sign-service, in zone `sign_workspace`;
- `limit_req` on `/v1/sign/sender/`, `/inbox`, `/legal/`, `/account/` and `/billing/` (zone `sign_workspace`), and on
  `/auth/` (zone `sign_auth`);
- the exact `application/json` locations `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`.
  These files are rendered at container start from the three `SIGN_*` variables.

Steps:
1. Build and recreate nginx (build is not recreate):
   ```
   sudo docker compose -p aramo-singlebox -f docker-compose.prod.yml build nginx
   sudo docker compose -p aramo-singlebox -f docker-compose.prod.yml up -d nginx
   ```
   Run `nginx -t` in its own ssh call:
   ```
   sudo docker exec aramo-prod-nginx nginx -t
   ```
   The association files are rendered only at start, so **restart** nginx after any `SIGN_*` change. A reload is not
   enough.
2. Check the start log. It must show `40-aramo-app-links: … associated <id>` for both files, with no `WARNING`:
   ```
   sudo docker logs aramo-prod-nginx 2>&1 | grep 40-aramo-app-links
   ```
3. Verify from outside the box:
   ```
   curl -sS -D - https://sign.aramo.ai/.well-known/apple-app-site-association
   curl -sS -D - https://sign.aramo.ai/.well-known/assetlinks.json
   ```
   Each file must return `200`, `Content-Type: application/json` and `Cache-Control: public, max-age=3600`, with no
   redirect.
   - The iOS file lists exactly `/s/*`, `/d/*` and `/auth/native/callback` for `<TEAMID>.ai.aramo.sign`.
   - The Android file lists `ai.aramo.sign` with both fingerprints.
4. Check what the platforms see:
   - Apple's CDN serves its cached copy at `https://app-site-association.cdn-apple.com/a/v1/sign.aramo.ai`. It refreshes
     on Apple's schedule.
   - Google: `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://sign.aramo.ai&relation=delegate_permission/common.handle_all_urls`.
   - On a device: `adb shell pm get-app-links ai.aramo.sign` shows `sign.aramo.ai: verified`.
5. Check the edge limits by sending more requests than the burst to a harmless path. The extra requests must return
   `429`, not `5xx`.
6. Confirm that web signing is unchanged. Without the app installed, `https://sign.aramo.ai/s/<token>` still opens the web
   signer (M-A2 §3.1).

**Rollback:** unset the three `SIGN_*` variables and restart nginx. The files then associate nothing and every link opens
the browser again. For a full rollback, use the previous nginx image tag.

**Unblocks:** verified links (acceptance criterion 5), native sign-in through the edge, and the edge limits (criterion 12).

## P-2 / P-4 — enable push (last)

1. Use a non-production device first. Set `SIGN_PUSH_DELIVERY` to `apns` or `fcm` as the M-A3 adapter contract defines,
   then recreate sign-service. **Enabling push in production needs its own authorization (§15).**
2. Verify on real devices:
   - a push arrives for each notification type;
   - preferences are honoured;
   - generic lock-screen text is the default;
   - no capability token appears in any payload;
   - a revoked device receives nothing from jobs queued before the revocation (§12.10, §12.18).

**Unblocks:** acceptance criterion 10.

## P-10 — CI macOS runner and signing credentials

1. The `mobile-sign` workflow (`.github/workflows/mobile-sign.yml`) uses no secrets. It runs:
   - `mobile:android` (ubuntu);
   - `mobile:ios` (macOS, Simulator, unsigned);
   - `mobile:openapi-client-drift`.

   It is **not** part of `deployment-gate`.
2. Making these jobs required checks, or adding signed device builds, is a separate PO decision. It covers runner cost
   and where the signing credentials live. Never add signing credentials to the repository.

## Never in this program

- Store publication (P-11).
- Activation of templates or Personal mode (P-12).
- Running Terraform from the box. Infra runs from the Mac.
