# Aramo Sign — mobile app (iOS + Android)

One React Native + TypeScript codebase (Expo SDK, prebuild) for the Aramo Sign sender
and signer workspaces.

Governing instruments (LOCKED 2026-10-25, OneDrive `Aramo/locked/`):
- `Aramo-Sign-Mobile-Native-Application-Implementation-Directive-v1_0`
- M-A1 (native authentication consumer)
- M-A2 (mobile signing session and deep links)
- M-A3 (mobile-owned data contracts)

Design input: `design/aramo-Prototype/handoff/Aramo Sign - mobile app - Claude Code handoff.md`
and `platform/sign/Aramo Sign Mobile.dc.html`. Where the handoff and LOCKED text
disagree, LOCKED wins (directive §7).

This package sits **outside** the root npm workspaces (`apps/*`, `libs/*`). It has its own
`package.json` and `package-lock.json`, because the web monorepo pins React 18 and
React Native needs React 19. It never imports web libraries.

## Commands

Run these from `mobile/sign/`, or through Nx (project `sign-mobile`).

| npm | Nx | What |
|---|---|---|
| `npm ci` | `nx run sign-mobile:install` | install (Nx skips it when `node_modules` is current) |
| `npm run typecheck` | `nx run sign-mobile:typecheck` | `tsc --noEmit` |
| `npm run lint` | `nx run sign-mobile:lint` | ESLint (`eslint-config-expo` + repo rules) |
| `npm test` | `nx run sign-mobile:test` | jest (`jest-expo` preset) |
| `npm run generate:api` | `nx run sign-mobile:generate-api` | regenerate `src/api/generated/` from `openapi/sign.yaml` + `openapi/auth.yaml` |
| `npm run check:api` | `nx run sign-mobile:check-api` | CI drift check: fails if the generated types are stale |
| `npm run prebuild` | `nx run sign-mobile:prebuild` | regenerate `ios/` + `android/` from `app.config.ts` (no pod install) |
| — | `nx run sign-mobile:build-android` | `./gradlew :app:assembleRelease` (needs the Android SDK + JDK 17) |
| — | `nx run sign-mobile:build-ios` | `pod install` + `xcodebuild` (needs macOS + Xcode) |

The build targets are deliberately not named `build`, so the root
`nx run-many -t build --all` never starts a native build.

Development builds may override configuration with `EXPO_PUBLIC_*` variables. See
`src/config/env.ts`. Release builds accept only an https API origin.

## Versions (directive §13 D-1)

The rule: each dependency is a stable release published at least 14 days before
2026-10-25. `.npmrc` pins `save-exact=true` and `before=2026-10-10T23:59:59Z`, so npm
cannot resolve anything newer, including transitive dependencies. When you add a
dependency, move `before` to (today − 14 days) in the same change.

| Package | Version | Why |
|---|---|---|
| expo | 57.0.27 (2026-10-06) | SDK 57 is the newest SDK on a **stable** React Native. SDK 58's matrix targets RN 0.88, released 2026-10-15 (under 14 days; SDK 58.0.7 still listed `0.88.0-rc.4`). 57.0.27 is the newest SDK 57 patch older than 14 days. |
| react-native | 0.86.3 (2026-08-24) | SDK 57 matrix (`bundledNativeModules.json`) |
| react | 19.2.3 | SDK 57 matrix |
| typescript | 6.0.3 | SDK 57 template (`~6.0.3`) |
| expo-* modules | 57.0.x (exact pins in package.json) | newest patch, at least 14 days old, inside the SDK 57 `~` range |
| @react-navigation/native · native-stack · bottom-tabs | 7.5.0 · 7.20.0 · 7.20.0 | newest at least 14 days old; peers satisfied by screens 4.26.2 / safe-area 5.7.0 |
| react-native-screens · safe-area-context · gesture-handler · svg | 4.26.2 · 5.7.0 · 2.32.0 · 15.15.4 | SDK 57 matrix |
| react-native-pdf + react-native-blob-util | 7.0.5 + 0.25.1 | PDF renderer (see below). blob-util `1.0.0` is deprecated upstream as an RC. |
| @config-plugins/react-native-pdf · react-native-blob-util | 14.0.2 · 14.0.2 | official Expo config plugins (prebuild wiring) |
| react-native-document-scanner-plugin | 2.0.4 | document scanner (see below) |
| react-native-view-shot | 5.1.0 | rasterizes drawn signatures to PNG (C-19). SDK 57 matrix. |
| @tanstack/react-query · react-query-persist-client | 5.104.1 | query cache + persistence |
| openapi-typescript | 7.13.0 | type generation. Its `typescript ^5` peer is overridden to the app's TS 6. |
| jest-expo · jest · @testing-library/react-native | 57.0.5 · 29.7.0 · 13.3.3 | RNTL 14 needs a peer that has no stable release |
| eslint · eslint-config-expo | 9.39.5 · 57.0.2 | SDK 57 lint config (ESLint 9 flat config) |

`npx expo install --check` suggests newer SDK 57 patches (for example expo 57.0.31).
All of them are under 14 days old, and our pins sit inside the same `~` ranges.

**Minimum OS.** The SDK 57 module set sets the iOS floor at **16.4**
(`ExpoModulesCore.podspec` `:ios => '16.4'`), so `deploymentTarget` is 16.4. That is
still "iOS 16+" (directive §2), but it is not 16.0. Android `minSdkVersion` is **29**
(Android 10).

**PDF renderer: `react-native-pdf`** uses PDFKit on iOS and PdfiumAndroid on Android:
native rendering, which is what directive §2 asks for. It supports React Native's New
Architecture and works with prebuild through `@config-plugins/react-native-pdf`. It can
render a single page (`singlePage` / `page`) for field overlays, and reads the base64
download contract through `react-native-blob-util`. A WebView + pdf.js renderer was
rejected: it adds a web runtime to the signing surface, and overlays at PDF-point
geometry are harder to make accessible.

**Scanner: `react-native-document-scanner-plugin`** uses VisionKit
`VNDocumentCameraViewController` on iOS and the ML Kit Document Scanner on Android,
exactly what handoff §4.6 names. It is a codegen (New Architecture) module and ships an
Expo config plugin (camera usage string). It is maintained (2.x line from 2025-09) and
widely used. Pages come back as images: compose them into one PDF in the Send flow.

## Structure (`src/`)

```
App.tsx                 providers: services, encrypted query persistence, toasts, navigation, deep links
app/services.ts         composition root: builds every service once (session, clients, stores)
app/ServicesContext.tsx useServices(), useSession()
config/env.ts           API base (https://sign.aramo.ai), Cognito domain/client id, web links
api/
  generated/            GENERATED types (sign.ts, auth.ts) — never edit; npm run generate:api
  types.ts              path/method -> request/response type helpers over the generated types
  http.ts               the one fetch executor (no credentials of its own; path-traversal guard)
  workspaceClient.ts    Bearer + X-Aramo-Consumer: sign, refresh-on-401, If-Match, Idempotency-Key
  guestSigningClient.ts signing-token-only transport for /v1/sign/signing/*
  errors.ts             ApiError (reason = details.reason ?? code) + KNOWN_REASONS
  refusalMessages.ts    reason -> user copy (directive §7 wording)
auth/
  pkce.ts               verifier/challenge (S256), state, nonce
  authorize.ts          Cognito authorize URL, redirect selection, callback validation
  signIn.ts             the native sign-in flow (OS auth session -> /auth/native/sign/token)
  session.ts            SessionManager: restore, single-flight refresh, expiry, sign-out
  nativeAuthApi.ts      /auth/native/sign/{token,refresh,logout}
  tokenStore.ts         tokens at rest (SecureStore only)
  secureKeyValue.ts     the SecureStore adapter + every key name the app uses
  installation.ts       descriptive installation id + device descriptor
  biometric.ts          local confirmation / optional unlock (never sent to the server)
  callbackBus.ts        hands a deep-linked auth callback to the waiting sign-in
links/
  routeLink.ts          strict deep-link router (pure)
  guestTokenVault.ts    in-memory, single-use token hand-off (route params carry a handle)
  pendingTarget.ts      deep-link target kept across sign-in
navigation/             typed map (types.ts), RootNavigator, MainTabs, DeepLinkRouter
screens/                one folder per feature; placeholders are marked PLACEHOLDER
signing/useGuestSigningSession.ts  open/discard a guest session for a screen
state/
  queryClient.ts        TanStack Query + encrypted persister + online manager
  encryptedStore.ts     AES-256-GCM blob store (key in SecureStore, files in app documents)
  platformStorage.ts    expo-crypto / expo-file-system adapters
  draftStore.ts         offline Send-flow drafts (LocalDraft)
notifications/pushRegistration.ts  PUT/DELETE /v1/sign/me/devices/current (token registration only)
security/sensitiveScreen.ts        iOS app-switcher blur for sensitive screens
theme/                  handoff §3 tokens per platform (Platform.select) + pills, recipient colours
components/             Button, StatusPill, Card, ListRow/RowTile, Sheet, Toast, Banner, brand marks
util/                   bytes (base64/UTF-8), ids, jwt (sub only)
testing/fakes.ts        test doubles (never imported by app code)
```

## Rules the feature screens must keep

1. **Two transports, never mixed (M-A2 §2.1).**
   - Use `services.workspace` for every signed-in call.
   - Use `services.guest.open(token)` only for `/v1/sign/signing/*`.
   - The workspace client refuses signing paths. The guest client refuses everything
     else and never sends `Authorization`.
   - Inbox signing: call `POST /v1/sign/inbox/:id/sign` on the workspace client, then
     `guest.open(returnedToken)`, then `discard()` when the task ends.
   - The emailed-token **claim** (`POST /v1/sign/inbox/claim {token}`) is a workspace call
     by contract. It is not guest signing.
2. **Tokens stay in memory.**
   - Never put a capability token in navigation params, the query cache, drafts, logs,
     analytics or the clipboard.
   - The router stashes link tokens in `guestTokenVault`; screens receive a handle.
   - Don't add `meta: { persist: true }` to signing queries.
3. **No logging of data.** ESLint bans `console.*`. `ApiError.message` is only the reason.
4. **Render the server's decision.**
   - Key UI off `ApiError.reason` and `refusalMessage()`.
   - Show `permissions` / `allowance` exactly as the backend returns them (directive §4).
   - Don't re-derive policy on the device.
5. **Concurrency (M-A3 §6).**
   - Every native draft write, send and void must pass `ifMatch`: the ETag from the last
     read, or `{ id, revision }`. A missing one is `428`.
   - On `revision_mismatch` (`412`), refetch and show the current state
     (`error.currentRevision`). Never resubmit against a stale envelope.
6. **Idempotency (M-A3 §7/§8).**
   - Create `newIdempotencyKey()` once per user action (remind, document upload).
   - Reuse that key on every retry of the action.
7. **Offline (directive §9).**
   - Persist list/detail queries with `meta: { persist: true }` (encrypted at rest).
   - Show `<OfflineBanner/>` and disable server actions while offline.
   - Drafts go through `services.drafts`.
   - Signing completion always needs a live connection.
8. **Native components first** (handoff §3). Use native-stack headers and large titles,
   and register sheets as `presentation: 'formSheet'` routes when they need detents.
   Record every deviation from the prototype's measurements in the PR.
9. **Accessibility** (handoff §7). Touch targets ≥ `theme.size.minTouch`, Dynamic Type
   (don't fix font sizes), labels on every control, and no animation where reduced motion
   is on.

## Adding a feature screen

1. Replace the placeholder file in `src/screens/<feature>/`. Keep the export name.
2. Add new routes in `navigation/types.ts` and register them in `RootNavigator.tsx`.
   Don't put tokens in params.
3. Call APIs with the typed helper:
   `workspace.call('/v1/sign/sender/envelopes/{id}', 'get', { path: { id } })`.
   Use `callWithMeta` when you need the ETag.
   For a route not yet in the YAML, use `workspace.request<T>({ method, path, ... })`, and
   switch to `call()` after `npm run generate:api`.
4. Add jest tests next to the code in `__tests__/`.

## Auth flow (M-A1)

1. `signIn(provider)` creates a PKCE verifier, `state` and `nonce`, and builds the
   Cognito authorize URL (`identity_provider` `Google` / `microsoft`, as on the web).
2. It opens the URL with `WebBrowser.openAuthSessionAsync` (ASWebAuthenticationSession /
   Custom Tabs, ephemeral session). There is no embedded webview.
3. It validates the exact callback and `state` in constant time.
4. It POSTs `{code, code_verifier, redirect_uri, nonce, device}` to
   `/auth/native/sign/token` and stores the result in SecureStore.

Callback choice:
- iOS 17.4 and later: `https://sign.aramo.ai/auth/native/callback`.
- iOS 16.4–17.3: `aramosign://auth/callback`, because the OS auth session can only match a
  custom scheme there.
- Android: the https App Link by default. `EXPO_PUBLIC_SIGN_ANDROID_REDIRECT=custom`
  switches to the fallback.

Session behaviour:
- **Refresh** is single-flight: concurrent 401s share one rotation, so they never trip
  reuse detection.
- A refused refresh ends the session. The user returns to Sign in, and an open envelope
  or signing target is kept for after sign-in.
- A network failure keeps the session.
- **Sign-out**, in order:
  1. remove the push device (while still authenticated);
  2. `/auth/native/sign/logout`;
  3. clear SecureStore;
  4. wipe the encrypted store and the query cache.

On-device data is scoped to the signed-in user's `sub`, so a different user signing in
wipes it.

## Storage

| What | Where |
|---|---|
| access / refresh token, session meta, installation id, storage key, preferences | SecureStore (Keychain / Keystore), `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`. Keys: `SECURE_KEYS` in `auth/secureKeyValue.ts`. |
| drafts, persisted query cache | AES-256-GCM ciphertext in `Documents/aramo-sign-store/`, slot name bound as AAD |
| capability tokens | memory only |

Android `allowBackup` is `false`.

## Native projects (prebuild)

`ios/` and `android/` are generated by `expo prebuild --no-install` from `app.config.ts`,
and they are checked in. Change `app.config.ts`, then run `npm run prebuild`; don't
hand-edit the generated projects. What they configure:

- Bundle id / application id `ai.aramo.sign`; scheme `aramosign`.
- iOS: `applinks:sign.aramo.ai` and `aps-environment` (development) entitlements.
- Android: an `autoVerify` intent filter for `https://sign.aramo.ai` `/s/`, `/d/` and
  `/auth/native/callback`.
- Camera and Face ID usage strings.
- ATS arbitrary loads off. Cleartext is allowed only in the Android **debug** manifest
  (Metro).
- No storage-wide Android permissions.

**Not generated here** (they need Xcode, CocoaPods or the Android SDK):
- `ios/Pods` and `ios/Podfile.lock`: the first `pod install` (CI / a Mac with Xcode)
  creates the lock, which should then be committed;
- any compiled build;
- signing.

## Known gaps and open items

- **Android app-switcher blur.** Android has no snapshot-only control (`FLAG_SECURE` also
  blocks screenshots, which directive §12.16 must not do), so it is not applied there.
  iOS blur is wired (`useAppSwitcherProtection`).
- **Push on Android** needs the Firebase config (`google-services.json`, directive P-4)
  and the `expo-notifications` Android FCM setup. Without it, `registerForPush` returns
  `'unavailable'` and the in-app feed still works.
- **iOS release builds** need `aps-environment` = production (`expo-notifications`
  plugin `mode`) and the P-1 Team ID.
- **Production values** (Cognito domain, native client id) are unset. Sign-in shows
  "Sign-in isn’t available in this build" until they are provided at build time.
- **Web links.** `WEB_LINKS.help` (`/help`) is assumed to exist on the Sign host;
  `/legal/terms` and `/legal/privacy` match routes sign-web serves.
- **App icon and splash** are Expo defaults until brand assets are supplied.
