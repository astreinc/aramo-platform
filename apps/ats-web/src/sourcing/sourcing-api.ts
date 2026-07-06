import { apiClient } from '@aramo/fe-foundation';

import type {
  AdvisoryView,
  PoolPage,
  SourcingRefType,
  SourcingResult,
  SubjectDetail,
} from './types';

// The sourcing domain client (mirrors the *-api.ts convention). Consumes the
// B-api sourcing surface (talent:source) + the existing advisory-resolution
// POSTs (identity:resolve). Tenant/actor come from the session cookie the
// apiClient attaches — never a param. ApiError propagates for the caller's
// error-messages mapping.

// GET /v1/sourcing/pool — the un-promoted pool, keyset-paginated oldest-first.
export async function getPool(
  params?: { cursor?: string | null; limit?: number },
): Promise<PoolPage> {
  const search = new URLSearchParams();
  const cursor = params?.cursor;
  if (cursor !== undefined && cursor !== null && cursor !== '') {
    search.set('cursor', cursor);
  }
  if (params?.limit !== undefined) search.set('limit', String(params.limit));
  const qs = search.toString();
  return apiClient.get<PoolPage>(`/v1/sourcing/pool${qs === '' ? '' : `?${qs}`}`);
}

// GET /v1/sourcing/pool/:subjectId — the subject drill-in (bands + evidence +
// refs + pending advisories).
export async function getSubjectDetail(subjectId: string): Promise<SubjectDetail> {
  return apiClient.get<SubjectDetail>(
    `/v1/sourcing/pool/${encodeURIComponent(subjectId)}`,
  );
}

// POST /v1/sourcing/pipeline — promote (gated) then associate to a requisition.
export async function addToPipeline(body: {
  ref_type: SourcingRefType;
  ref_id: string;
  requisition_id: string;
}): Promise<SourcingResult> {
  return apiClient.post<SourcingResult>('/v1/sourcing/pipeline', body);
}

// POST /v1/sourcing/bench — promote (gated) then add to the tenant pool bench.
export async function saveToBench(body: {
  ref_type: SourcingRefType;
  ref_id: string;
}): Promise<SourcingResult> {
  return apiClient.post<SourcingResult>('/v1/sourcing/bench', body);
}

// ── Advisory resolution — the EXISTING privileged surface, reused (identity:
// resolve). Merging two humans is not sourcer self-serve; the button is gated. ──

const ADVISORY_BASE = '/v1/talent/identity/advisories';

// POST :id/approve — execute the pointer-only merge. A contradicted advisory
// (has_contradiction) requires override_acknowledged + justification (R3).
export async function approveAdvisory(
  advisoryId: string,
  body?: {
    surviving_subject_id?: string;
    justification?: string;
    override_acknowledged?: boolean;
  },
): Promise<AdvisoryView> {
  return apiClient.post<AdvisoryView>(
    `${ADVISORY_BASE}/${encodeURIComponent(advisoryId)}/approve`,
    body ?? {},
  );
}

// POST :id/dismiss — not the same human (justification optional).
export async function dismissAdvisory(
  advisoryId: string,
  body?: { justification?: string },
): Promise<AdvisoryView> {
  return apiClient.post<AdvisoryView>(
    `${ADVISORY_BASE}/${encodeURIComponent(advisoryId)}/dismiss`,
    body ?? {},
  );
}

// POST :id/reverse — un-merge a MERGED advisory (justification REQUIRED, R4).
export async function reverseAdvisory(
  advisoryId: string,
  body: { justification: string },
): Promise<AdvisoryView> {
  return apiClient.post<AdvisoryView>(
    `${ADVISORY_BASE}/${encodeURIComponent(advisoryId)}/reverse`,
    body,
  );
}
