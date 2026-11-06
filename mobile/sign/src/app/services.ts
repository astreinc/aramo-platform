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
import { buildLogoutUrl, type Provider } from '../auth/authorize';
import { describeDevice } from '../auth/installation';
import { createNativeAuthApi, type NativeAuthApi } from '../auth/nativeAuthApi';
import { SECURE_KEYS, secureKeyValue, type SecureKeyValue } from '../auth/secureKeyValue';
import { SessionManager } from '../auth/session';
import { signInWithProvider } from '../auth/signIn';
import { createTokenStore } from '../auth/tokenStore';
import { env, NATIVE_SIGNOUT_REDIRECT_URI, type AppEnv } from '../config/env';
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
  signIn(provider: Provider): Promise<void>;
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
    userAgent: `AramoSign/${Application.nativeApplicationVersion ?? '0.0.0'} (${Platform.OS} ${String(Platform.Version)})`,
  });
  const store = encryptedStore();
  const drafts = createDraftStore(store);
  const queryClient = createQueryClient();
  const persister = createEncryptedPersister(store);
  wireOnlineManager(queryClient);

  session.onBeforeSignOut(() => unregisterPush(workspace));
  wireDocumentTempCleanup(session, documentTempFiles);

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
    async signIn(provider) {
      await signInWithProvider(provider, {
        env,
        platform: Platform.OS,
        osVersion: Platform.Version,
        api: nativeAuth,
        session,
        describeDevice: () => describeDevice(kv),
        openAuthSession: (url, redirectUri) =>
          // Ephemeral: no shared browser cookies, so "sign out to use another account"
          // really switches identity (directive §7 C-10).
          WebBrowser.openAuthSessionAsync(url, redirectUri, { preferEphemeralSession: true }),
      });
      await scopeLocalDataToUser();
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
