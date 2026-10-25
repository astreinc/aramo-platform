// Server reads for Agreements, envelope detail and the received view. List and detail
// queries persist (encrypted) for offline reads (directive §9); signing data never does.
import { onlineManager, useQuery, type QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

import { isApiError } from '../../api/errors';
import type { WorkspaceClient } from '../../api/workspaceClient';
import { useServices } from '../../app/ServicesContext';
import type {
  BillingAccount,
  InboxList,
  LedgerEvent,
  SenderContext,
  SenderEnvelopeDetail,
  SenderEnvelopeList,
} from './types';

export const signKeys = {
  senderList: ['sign', 'sender', 'envelopes'] as const,
  inbox: ['sign', 'inbox'] as const,
  billing: ['sign', 'billing', 'account'] as const,
  context: ['sign', 'sender', 'context'] as const,
  /** Data: `{ detail, etag }` — W6 (Send flow) reads the ETag from here for If-Match. */
  detail: (id: string) => ['sign', 'sender', 'envelope', id] as const,
  events: (id: string) => ['sign', 'sender', 'envelope', id, 'events'] as const,
  localDrafts: ['sign', 'local-drafts'] as const,
};

const PERSIST = { persist: true } as const;

export interface DetailWithEtag {
  readonly detail: SenderEnvelopeDetail;
  readonly etag: string | null;
}

/** The sender list; null when the caller may not read sent envelopes (403). */
export async function fetchSenderList(
  workspace: WorkspaceClient,
): Promise<SenderEnvelopeList | null> {
  try {
    const r = await workspace.call('/v1/sign/sender/envelopes', 'get', {
      query: { tab: 'all', limit: 200 },
    });
    return r;
  } catch (e) {
    if (isApiError(e) && e.status === 403) return null;
    throw e;
  }
}

export async function fetchInbox(workspace: WorkspaceClient): Promise<InboxList> {
  const r = await workspace.call('/v1/sign/inbox', 'get', {});
  return r;
}

export async function fetchDetail(workspace: WorkspaceClient, id: string): Promise<DetailWithEtag> {
  const r = await workspace.callWithMeta('/v1/sign/sender/envelopes/{id}', 'get', { path: { id } });
  return { detail: r.data, etag: r.etag };
}

export function useSenderEnvelopes() {
  const { workspace } = useServices();
  return useQuery({
    queryKey: signKeys.senderList,
    queryFn: () => fetchSenderList(workspace),
    meta: PERSIST,
  });
}

export function useInbox() {
  const { workspace } = useServices();
  return useQuery({
    queryKey: signKeys.inbox,
    queryFn: () => fetchInbox(workspace),
    meta: PERSIST,
  });
}

export function useBillingAccount() {
  const { workspace } = useServices();
  return useQuery({
    queryKey: signKeys.billing,
    queryFn: async () => {
      try {
        return (await workspace.call('/v1/sign/billing/account', 'get', {})) as BillingAccount;
      } catch (e) {
        if (isApiError(e) && e.status === 403) return null;
        throw e;
      }
    },
    meta: PERSIST,
  });
}

export function useSenderContext(enabled = true) {
  const { workspace } = useServices();
  return useQuery({
    queryKey: signKeys.context,
    enabled,
    queryFn: async () =>
      (await workspace.call('/v1/sign/sender/context', 'get', {})) satisfies SenderContext,
    meta: PERSIST,
  });
}

export function useEnvelopeDetail(id: string) {
  const { workspace } = useServices();
  return useQuery({
    queryKey: signKeys.detail(id),
    queryFn: () => fetchDetail(workspace, id),
    meta: PERSIST,
  });
}

export function useEnvelopeEvents(id: string, enabled = true) {
  const { workspace } = useServices();
  return useQuery({
    queryKey: signKeys.events(id),
    queryFn: async () => {
      const r = await workspace.call('/v1/sign/sender/envelopes/{id}/events', 'get', {
        path: { id },
      });
      return (r.items ?? []) as LedgerEvent[];
    },
    enabled,
    meta: PERSIST,
  });
}

export function useLocalDrafts() {
  const { drafts } = useServices();
  return useQuery({ queryKey: signKeys.localDrafts, queryFn: () => drafts.list() });
}

/** Store a fresh detail answer (e.g. a remind/void response) together with its ETag. */
export function putDetail(qc: QueryClient, value: DetailWithEtag): void {
  qc.setQueryData(signKeys.detail(value.detail.id), value);
}

/** Connectivity as TanStack's online manager sees it (fed by expo-network). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => onlineManager.subscribe(cb),
    () => onlineManager.isOnline(),
    () => true,
  );
}

export const OFFLINE_ACTION_REASON = 'You’re offline. Connect to do this.';
