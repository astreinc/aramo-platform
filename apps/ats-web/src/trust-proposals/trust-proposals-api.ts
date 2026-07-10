import { apiClient } from '@aramo/fe-foundation';

import type { ProposalListItem, ProposalPage } from './types';

// The Trust Proposals worklist client (mirrors the identity-advisories-api
// convention). Consumes the TR-12 keyset list + the dismiss / mark-acted
// bookkeeping endpoints (all at talent:read; the real ACTs carry their own gates
// and are fired via their own clients). Tenant/actor come from the session cookie
// the apiClient attaches — never a param. ApiError propagates for the caller's
// error-messages mapping.

const BASE = '/v1/talent/identity/proposals';

// GET /v1/talent/identity/proposals — the enriched worklist, keyset-paginated.
// status defaults server-side to OPEN; kind/cursor/limit are optional.
export async function getProposals(params?: {
  status?: string;
  kind?: string;
  cursor?: string;
  limit?: number;
}): Promise<ProposalPage> {
  const search = new URLSearchParams();
  const status = params?.status;
  if (status !== undefined && status !== '') search.set('status', status);
  const kind = params?.kind;
  if (kind !== undefined && kind !== '') search.set('kind', kind);
  const cursor = params?.cursor;
  if (cursor !== undefined && cursor !== '') search.set('cursor', cursor);
  if (params?.limit !== undefined) search.set('limit', String(params.limit));
  const qs = search.toString();
  return apiClient.get<ProposalPage>(`${BASE}${qs === '' ? '' : `?${qs}`}`);
}

// POST /v1/talent/identity/proposals/:id/dismiss — justification required.
export async function dismissProposal(
  id: string,
  justification: string,
): Promise<ProposalListItem> {
  return apiClient.post<ProposalListItem>(
    `${BASE}/${encodeURIComponent(id)}/dismiss`,
    { justification },
  );
}

// POST /v1/talent/identity/proposals/:id/act — bookkeeping only (records ACTED).
// The real action was already fired via its own gated client; this marks the row.
export async function markProposalActed(
  id: string,
  note?: string,
): Promise<ProposalListItem> {
  return apiClient.post<ProposalListItem>(
    `${BASE}/${encodeURIComponent(id)}/act`,
    note !== undefined && note !== '' ? { note } : {},
  );
}
