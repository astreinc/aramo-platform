// Composition root: builds every long-lived service once, wired to platform adapters.
// Screens reach them through useServices() (app/ServicesContext.tsx).
import type { QueryClient } from '@tanstack/react-query';
import type { Persister } from '@tanstack/react-query-persist-client';
import * as Application from 'expo-application';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { createGuestSigningClient, type GuestSigningClient } from '../api/guestSigningClient';
import type { FetchFn } from '../api/http';
import { createWorkspaceClient, type WorkspaceClient } from '../api/workspaceClient';
import type { LinkedResponse } from '../api/apple-contract-types';
import { buildLogoutUrl, type Provider } from '../auth/authorize';
import { describeDevice } from '../auth/installation';
import { createNativeAuthApi, type NativeAuthApi } from '../auth/nativeAuthApi';
import { SECURE_KEYS, secureKeyValue, type SecureKeyValue } from '../auth/secureKeyValue';
import { SessionManager } from '../auth/session';
import {
  appleSignupIdentity,
  linkProvider,
  signInWithProvider,
  type AppleSignupIdentity,
  type SignInOptions,
  type SignInOutcome,
} from '../auth/signIn';
import { createTokenStore } from '../auth/tokenStore';
import { env, NATIVE_SIGNOUT_REDIRECT_URI, type AppEnv } from '../config/env';
import { appleAuthorizationCode } from '../features/account/appleAuthNative';
import { revokeAppleBestEffort } from '../features/account/appleRevoke';
import { linkWithWorkspace } from '../features/account/signInMethods';
import { defaultStorePort, type StorePort } from '../features/plans/storePort';
import { createSignupApi, type SignupApi } from '../features/signup/signupApi';
import { clearGuestTokens } from '../links/guestTokenVault';
import { unregisterPush } from '../notifications/pushRegistration';
import { wireDocumentTempCleanup } from '../security/documentTempFiles';
import { documentTempFiles } from '../security/documentTempFilesNative';
import { createDraftStore, type DraftStore } from '../state/draftStore';
import type { EncryptedStore } from '../state/encryptedStore';
import { encryptedStore } from '../state/platformStorage';
import {
  createEncryptedPersister,
  createQueryClient,
  noteServerResponse,
  wireOnlineManager,
} from '../state/queryClient';
import { jwtSubject } from '../util/jwt';

export interface AppServices {
  readonly env: AppEnv;
  readonly kv: SecureKeyValue;
  readonly session: SessionManager;
  readonly nativeAuth: NativeAuthApi;
  /** Bearer + X-Aramo-Consumer transport for the signed-in user. */
  readonly workspace: WorkspaceClient;
  /** Capability-token transport for signing; never carries workspace credentials. */
  readonly guest: GuestSigningClient;
  /** Session-less native Personal signup (M-A11); never carries credentials. */
  readonly signup: SignupApi;
  /** M-A12 W1-G — the platform store (App Store / Google Play); null where unavailable. */
  readonly iap?: StorePort | null;
  readonly store: EncryptedStore;
  readonly drafts: DraftStore;
  readonly queryClient: QueryClient;
  readonly persister: Persister;
  /** A1 L-4: `linkHandle` attaches a pending link on this sign-in (proof (a)). */
  signIn(provider: Provider, options?: SignInOptions): Promise<SignInOutcome>;
  /** A1 L-3 path 1: add a sign-in method to the signed-in user (Account → Sign-in methods). */
  linkProvider(provider: Provider): Promise<LinkedResponse>;
  /** Apple Go-Live R-5 (native): Apple's email and name for signup prefill; no session. */
  appleSignupIdentity(): Promise<AppleSignupIdentity>;
  /** Apple Go-Live R-8: best-effort Apple token revocation before deletion. Never throws. */
  revokeApple(): Promise<boolean>;
  signOut(): Promise<void>;
}

function seenServer(res: Response): Response {
  noteServerResponse();
  return res;
}

export function createAppServices(): AppServices {
  // Two DISTINCT fetch bindings so no shared wrapper can ever add headers to both.
  // M-A13 #4: a response (any status) proves connectivity; the response is untouched.
  const workspaceFetch: FetchFn = (url, init) => fetch(url, init).then(seenServer);
  const guestFetch: FetchFn = (url, init) => fetch(url, init).then(seenServer);
  const authFetch: FetchFn = (url, init) => fetch(url, init);
  const signupFetch: FetchFn = (url, init) => fetch(url, init);

  const kv = secureKeyValue;
  const nativeAuth = createNativeAuthApi({ baseUrl: env.apiBaseUrl, fetch: authFetch });
  const session = new SessionManager({ store: createTokenStore(kv), api: nativeAuth });
  const workspace = createWorkspaceClient({
    baseUrl: env.apiBaseUrl,
    fetch: workspaceFetch,
    session,
  });
  const guest = createGuestSigningClient({ baseUrl: env.apiBaseUrl, fetch: guestFetch });
  const signup = createSignupApi({
    baseUrl: env.apiBaseUrl,
    fetch: signupFetch,
    // Apple Go-Live R-9: iOS signs up with App Attest (client ios); Android with Play.
    client: Platform.OS === 'ios' ? 'ios' : 'android',
    userAgent: `AramoSign/${Application.nativeApplicationVersion ?? '0.0.0'} (${Platform.OS} ${String(Platform.Version)})`,
  });
  const store = encryptedStore();
  const drafts = createDraftStore(store);
  const queryClient = createQueryClient();
  const persister = createEncryptedPersister(store);
  wireOnlineManager(queryClient);

  session.onBeforeSignOut(() => unregisterPush(workspace));
  wireDocumentTempCleanup(session, documentTempFiles);

  // Ephemeral: no shared browser cookies, so "sign out to use another account" really
  // switches identity (directive §7 C-10).
  // preferUniversalLinks: on iOS 17.4+ the redirect is the https callback
  // (selectRedirectUri), which expo-web-browser matches with the .https(host:path:)
  // callback only when this is set; without it iOS waits for a custom "https" scheme
  // that never arrives and the callback page loads in the sheet. Needs the
  // webcredentials association. A custom-scheme redirect (iOS < 17.4) is unaffected.
  const openAuthSession = (url: string, redirectUri: string) =>
    WebBrowser.openAuthSessionAsync(url, redirectUri, { preferEphemeralSession: true, preferUniversalLinks: true });
  const authorizeDeps = {
    env,
    platform: Platform.OS,
    osVersion: Platform.Version,
    openAuthSession,
  };

  async function scopeLocalDataToUser(): Promise<void> {
    const token = await session.getAccessToken();
    const owner = token ? jwtSubject(token) : null;
    if (!owner) return;
    const previous = await kv.getItem(SECURE_KEYS.localOwner);
    if (previous && previous !== owner) {
      queryClient.clear();
      await store.wipe();
    }
    await kv.setItem(SECURE_KEYS.localOwner, owner);
  }

  return {
    env,
    kv,
    session,
    nativeAuth,
    workspace,
    guest,
    signup,
    iap: defaultStorePort(),
    store,
    drafts,
    queryClient,
    persister,
    async signIn(provider, options) {
      const outcome = await signInWithProvider(
        provider,
        {
          ...authorizeDeps,
          api: nativeAuth,
          session,
          describeDevice: () => describeDevice(kv),
        },
        options,
      );
      await scopeLocalDataToUser();
      return outcome;
    },
    linkProvider(provider) {
      return linkProvider(provider, {
        ...authorizeDeps,
        describeDevice: () => describeDevice(kv),
        link: linkWithWorkspace(workspace),
      });
    },
    appleSignupIdentity() {
      return appleSignupIdentity({ ...authorizeDeps, fetch: authFetch });
    },
    revokeApple() {
      return revokeAppleBestEffort({
        platform: Platform.OS,
        workspace,
        appleAuthorizationCode,
        openBrowser: (url) => WebBrowser.openBrowserAsync(url),
      });
    },
    async signOut() {
      // First, so no failure below can leave a document behind.
      documentTempFiles.wipe();
      await session.signOut();
      clearGuestTokens();
      queryClient.clear();
      await store.wipe();
      await kv.deleteItem(SECURE_KEYS.localOwner);
      // Android Custom Tabs share Chrome's cookies (iOS sign-in is ephemeral), so also
      // end the Cognito browser session. Best effort, after everything local is gone.
      if (Platform.OS === 'android' && env.cognitoDomain && env.nativeClientId) {
        await WebBrowser.openAuthSessionAsync(
          buildLogoutUrl({ cognitoDomain: env.cognitoDomain, clientId: env.nativeClientId }),
          NATIVE_SIGNOUT_REDIRECT_URI,
        ).catch(() => undefined);
      }
    },
  };
}
