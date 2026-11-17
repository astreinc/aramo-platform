# Aramo Sign: Android Play Release Build (vc7) — Directive v1.0 (LOCKED)

- **Date:** 2026-11-17.
- **Authority:** the PO, 2026-11-17: "you can draft and complete the step 2". Step 2 is the next Android build for the first production release.
- **Governing:** M-A9 LOCKED dd496593 governs public Android release (gates G-1..G-9). This directive builds the release build. It does **not** publish it.
- **Base:** `origin/main` 95b32152.

## 1. Substrate (audited 2026-11-17)

- `mobile/sign/app.config.ts`: `android.versionCode: 5` on main. vc6 was built locally on 2026-11-08 (19d1ee7e) and never committed, so the next upload must be **≥ 7**.
- **Sign-out redirect (audit item G-06): closed, no change needed.** The Cognito native client `5g5uo1n5rdvuv1k98jt1lvv90h` (pool us-east-1_4fKlnGfaW) lists `aramosign://auth/signed-out` and `https://sign.aramo.ai/auth/native/signed-out` in LogoutURLs. The app uses the first (`src/config/env.ts:22`).
- **Play Billing:** `src/features/plans/expoIapStore.ts` covers:
  - subs fetch with the Android `offerTokenAndroid`;
  - `requestPurchase.google` with `obfuscatedAccountId` = the intent's `app_account_token`. The server reads `obfuscatedExternalAccountId` as `intent_id` (`store-state.ts`), and `app_account_token == intent_id` (`store-billing.service.ts:254`).
  - `finishTransaction(isConsumable:false)`, which acknowledges, plus restore and manage.

  The flow is covered by `purchaseFlow.test.ts` through a fake StorePort. **The adapter itself has no test.**
- **Play Console:** we declared Advertising ID = **No**. `blockedPermissions` does not list `com.google.android.gms.permission.AD_ID`, so a library could merge it in.
- **Build-time setting:** `EXPO_PUBLIC_SIGN_PLAY_CLOUD_PROJECT_NUMBER` (Play Integrity, used by M-A11 native signup) has no default. Absent means integrity is unavailable.
- **Prod (2026-11-17):** the 4 `SIGN_GOOGLE_PLAY_*` settings are live, and the push of purchase notifications is verified (200).

## 2. Change

1. `app.config.ts`: set `android.versionCode` to **7**. `version` stays as on main.
2. `app.config.ts`: add `com.google.android.gms.permission.AD_ID` to `android.blockedPermissions`. This matches the Play declaration.
3. New `src/features/plans/__tests__/expoIapStore.test.ts`, with `expo-iap` mocked and `Platform.OS = 'android'`:
   - the Android product carries `offerToken`;
   - the purchase request sends `obfuscatedAccountId` = the account token, plus `subscriptionOffers` with that offer token;
   - `finish` → `finishTransaction({isConsumable:false})`;
   - `manageSubscriptions` deep-links with the package name and SKU;
   - a user cancel maps to `cancelled`.
4. The release AAB is built from the merged commit:
   - JDK 17, with the upload key from `~/.gradle/gradle.properties`;
   - `EXPO_PUBLIC_SIGN_PLAY_CLOUD_PROJECT_NUMBER` = the aramo-prod project number, which the PO supplies;
   - the merged manifest is checked for **no** AD_ID, CAMERA or storage permissions;
   - output `~/Desktop/aramo-sign-vc7-<sha>.aab` with its SHA-256.

## 3. Out of scope

- Uploading to Production and sending it for review. That is the PO, in Play Console, under the M-A9 gates.
- CCP creation of the Google Play subscription. That is the PO, in the admin console, in parallel.
- Push (FCM). It is off on both platforms.

## 4. Gates

- Gate 5:
  - `npx tsc --noEmit` and the jest suite in `mobile/sign`: green;
  - the vocabulary script: green;
  - diff verified.
- Gate 6: commit, PR, CI green, merge. Then build and checksum the AAB, and hand it to the PO for upload.
