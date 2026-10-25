// Notification feed, unread count, read state (M-A3 §1). The badge and read state come
// from the server so they match across devices (handoff §4.7; acceptance §12.10).
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { useCallback } from 'react';

import type { WorkspaceClient } from '../../api/workspaceClient';
import { useServices, useSession } from '../../app/ServicesContext';
import { withAllRead, withRead, type FeedItem } from './notificationModel';

export const notificationKeys = {
  feed: ['sign', 'me', 'notifications'] as const,
  unread: ['sign', 'me', 'notifications', 'unread'] as const,
  prefs: ['sign', 'me', 'notification-preferences'] as const,
};

export interface FeedPage {
  readonly items: readonly FeedItem[];
  readonly next_cursor: string | null;
}

const PAGE = 30;

export async function fetchFeedPage(
  workspace: WorkspaceClient,
  cursor: string | null,
): Promise<FeedPage> {
  const r = await workspace.call('/v1/sign/me/notifications', 'get', {
    query: cursor ? { cursor, limit: PAGE } : { limit: PAGE },
  });
  return { items: r.items ?? [], next_cursor: r.next_cursor ?? null };
}

export function useFeed() {
  const { workspace } = useServices();
  return useInfiniteQuery({
    queryKey: notificationKeys.feed,
    queryFn: ({ pageParam }) => fetchFeedPage(workspace, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    meta: { persist: true },
  });
}

/** The unread count (tab badge + app icon badge). Polls while signed in. */
export function useUnreadCount() {
  const { workspace } = useServices();
  const { status } = useSession();
  return useQuery({
    queryKey: notificationKeys.unread,
    queryFn: async () => {
      const r = await workspace.call('/v1/sign/me/notifications/unread-count', 'get', {});
      const count = typeof r.count === 'number' ? r.count : 0;
      void Notifications.setBadgeCountAsync(count).catch(() => undefined);
      return count;
    },
    enabled: status === 'signedIn',
    refetchInterval: 60_000,
    meta: { persist: true },
  });
}

function patchFeed(qc: QueryClient, fn: (pages: FeedPage[]) => FeedPage[]): void {
  qc.setQueryData<InfiniteData<FeedPage, string | null>>(notificationKeys.feed, (d) =>
    d ? { ...d, pages: fn(d.pages) } : d,
  );
}

export async function markRead(
  workspace: WorkspaceClient,
  qc: QueryClient,
  id: string,
): Promise<void> {
  await workspace.call('/v1/sign/me/notifications/{id}/read', 'post', { path: { id } });
  patchFeed(qc, (pages) => withRead(pages, id, new Date().toISOString()));
  void qc.invalidateQueries({ queryKey: notificationKeys.unread });
}

export async function markAllRead(workspace: WorkspaceClient, qc: QueryClient): Promise<void> {
  await workspace.call('/v1/sign/me/notifications/read-all', 'post', {});
  patchFeed(qc, (pages) => withAllRead(pages, new Date().toISOString()));
  qc.setQueryData(notificationKeys.unread, 0);
  void Notifications.setBadgeCountAsync(0).catch(() => undefined);
}

export function useMarkRead() {
  const { workspace } = useServices();
  const qc = useQueryClient();
  return {
    one: useCallback((id: string) => markRead(workspace, qc, id), [workspace, qc]),
    all: useCallback(() => markAllRead(workspace, qc), [workspace, qc]),
  };
}
