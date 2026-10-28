// Composition root: builds every long-lived service once, wired to platform adapters.
// Screens reach them through useServices() (app/ServicesContext.tsx).
import type { QueryClient } from '@tanstack/react-query';
import type { Persister } from '@tanstack/react-query-persist-client';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { createGuestSigningClient, type GuestSigningClient } from '../api/guestSigningClient';
import type { FetchFn } from '../api/http';
import { createWorkspaceClient, type WorkspaceClient } from '../api/workspaceClient';
import type { Provider } from '../auth/authorize';
import { describeDevice } from '../auth/installation';
import { createNativeAuthApi, type NativeAuthApi } from '../auth/nativeAuthApi';
import { SECURE_KEYS, secureKeyValue, type SecureKeyValue } from '../auth/secureKeyValue';
import { SessionManager } from '../auth/session';
import { signInWithProvider } from '../auth/signIn';
import { createTokenStore } from '../auth/tokenStore';
import { env, type AppEnv } from '../config/env';
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
  readonly store: EncryptedStore;
  readonly drafts: DraftStore;
  readonly queryClient: QueryClient;
  readonly persister: Persister;
  signIn(provider: Provider): Promise<void>;
  signOut(): Promise<void>;
}

export function createAppServices(): AppServices {
  // Two DISTINCT fetch bindings so no shared wrapper can ever add headers to both.
  const workspaceFetch: FetchFn = (url, init) => fetch(url, init);
  const guestFetch: FetchFn = (url, init) => fetch(url, init);
  const authFetch: FetchFn = (url, init) => fetch(url, init);

  const kv = secureKeyValue;
  const nativeAuth = createNativeAuthApi({ baseUrl: env.apiBaseUrl, fetch: authFetch });
  const session = new SessionManager({ store: createTokenStore(kv), api: nativeAuth });
  const workspace = createWorkspaceClient({
    baseUrl: env.apiBaseUrl,
    fetch: workspaceFetch,
    session,
  });
  const guest = createGuestSigningClient({ baseUrl: env.apiBaseUrl, fetch: guestFetch });
  const store = encryptedStore();
  const drafts = createDraftStore(store);
  const queryClient = createQueryClient();
  const persister = createEncryptedPersister(store);
  wireOnlineManager();

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
    },
  };
}
