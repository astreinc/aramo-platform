import { apiClient } from '@aramo/fe-foundation';

import type { AdvisoryPage } from './types';

// The identity-advisory worklist client (mirrors the *-api.ts convention).
// Consumes the TR-6 enriched keyset list surface (core + identity:resolve).
// Tenant/actor come from the session cookie the apiClient attaches — never a
// param. ApiError propagates for the caller's error-messages mapping. The
// resolve POSTs live in ../sourcing/sourcing-api (approveAdvisory/dismiss-
// Advisory) and are reused as-is — the same privileged surface.

const ADVISORY_BASE = '/v1/talent/identity/advisories';

// GET /v1/talent/identity/advisories — the enriched worklist, keyset-paginated.
// status defaults server-side to PENDING_REVIEW; cursor/limit are optional.
export async function getAdvisories(params?: {
  status?: string;
  cursor?: string;
  limit?: number;
}): Promise<AdvisoryPage> {
  const search = new URLSearchParams();
  const status = params?.status;
  if (status !== undefined && status !== '') search.set('status', status);
  const cursor = params?.cursor;
  if (cursor !== undefined && cursor !== '') search.set('cursor', cursor);
  if (params?.limit !== undefined) search.set('limit', String(params.limit));
  const qs = search.toString();
  return apiClient.get<AdvisoryPage>(`${ADVISORY_BASE}${qs === '' ? '' : `?${qs}`}`);
}
