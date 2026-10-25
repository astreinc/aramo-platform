// TanStack Query: the in-memory cache for server data plus an ENCRYPTED persisted copy
// for offline reads (directive §9: "Lists and details show cached data marked offline").
//
// Persistence is opt-in per query: set `meta: { persist: true }` on list/detail queries.
// Guest signing data is never persisted (M-A2 §3.4) — don't set the flag there.
import { QueryClient, onlineManager, type Query } from '@tanstack/react-query';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import * as Network from 'expo-network';

import { ApiError } from '../api/errors';
import type { EncryptedStore } from './encryptedStore';

export const QUERY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_SLOT = 'query-cache';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: QUERY_CACHE_MAX_AGE_MS,
        staleTime: 30_000,
        // A refusal is an answer, not a transient failure: don't retry 4xx.
        retry: (count, error) =>
          !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
        networkMode: 'offlineFirst',
      },
      mutations: { retry: false, networkMode: 'online' },
    },
  });
}

export function shouldPersistQuery(query: Query): boolean {
  return query.state.status === 'success' && query.meta?.['persist'] === true;
}

export function createEncryptedPersister(store: EncryptedStore): Persister {
  return {
    async persistClient(client: PersistedClient) {
      await store.set(CACHE_SLOT, JSON.stringify(client));
    },
    async restoreClient() {
      const raw = await store.get(CACHE_SLOT);
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as PersistedClient;
      } catch {
        return undefined;
      }
    },
    async removeClient() {
      await store.remove(CACHE_SLOT);
    },
  };
}

/** Feed connectivity into TanStack's online manager (offline => paused, cached data shown). */
export function wireOnlineManager(): void {
  onlineManager.setEventListener((setOnline) => {
    const sub = Network.addNetworkStateListener((s) =>
      setOnline(s.isConnected !== false && s.isInternetReachable !== false),
    );
    return () => sub.remove();
  });
}
