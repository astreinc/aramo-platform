import { apiClient } from '@aramo/fe-foundation';

import type {
  GuaranteeTermVersionListResponse,
  GuaranteeTermVersionView,
  GuaranteeTermsRequest,
} from './guarantee-terms-types';

// Track 7 / T7-P5 — the ats-web guarantee-terms client. The reusable requisition-level terms are
// keyed by (tenant, requisitionId); the UI reads/writes them from the Requisition detail →
// Guarantee Terms tab. Reads require placement:permanent:read; writes require
// placement:permanent:terms:write. recorded_by = JWT sub, never the wire. Pact:
// pact/consumers/ats-web/src/permanent-placement.consumer.test.ts.

const BASE = '/v1/permanent-placement-guarantee-terms/requisitions';

// GET history (placement:permanent:read) — newest effective_from first.
export async function listGuaranteeTerms(
  requisitionId: string,
): Promise<GuaranteeTermVersionListResponse> {
  return apiClient.get<GuaranteeTermVersionListResponse>(`${BASE}/${encodeURIComponent(requisitionId)}`);
}

// GET the effective/current version at an optional as_of calendar date (defaults to today).
// A 404 means no effective version — the caller renders an empty state.
export async function getEffectiveGuaranteeTerms(
  requisitionId: string,
  asOf?: string,
): Promise<GuaranteeTermVersionView> {
  const qs = asOf === undefined || asOf === '' ? '' : `?as_of=${encodeURIComponent(asOf)}`;
  return apiClient.get<GuaranteeTermVersionView>(
    `${BASE}/${encodeURIComponent(requisitionId)}/effective${qs}`,
  );
}

// POST create the initial (open) version (placement:permanent:terms:write). 409 on overlap.
export async function createGuaranteeTerms(
  requisitionId: string,
  body: GuaranteeTermsRequest,
): Promise<GuaranteeTermVersionView> {
  return apiClient.post<GuaranteeTermVersionView>(
    `${BASE}/${encodeURIComponent(requisitionId)}`,
    body,
  );
}

// POST revise (first-close the current version + insert the successor) (terms:write). 404 when
// there is no open version to revise; 422 on a backdated/invalid effective window.
export async function reviseGuaranteeTerms(
  requisitionId: string,
  body: GuaranteeTermsRequest,
): Promise<GuaranteeTermVersionView> {
  return apiClient.post<GuaranteeTermVersionView>(
    `${BASE}/${encodeURIComponent(requisitionId)}/revise`,
    body,
  );
}
