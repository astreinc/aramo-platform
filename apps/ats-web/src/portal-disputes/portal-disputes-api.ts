import { apiClient } from '@aramo/fe-foundation';

// Portal P3b — the tenant dispute-disposition client (mirrors the *-api.ts
// convention; core + identity:resolve). Tenant/actor come from the session
// cookie the apiClient attaches — never a param. ApiError propagates.

const BASE = '/v1/talent/identity/portal-disputes';

export interface PortalDisputeItem {
  dispute_id: string;
  subject_id: string;
  item_type: string;
  status: string;
  arrived_at: string;
}

export interface PortalDisputeList {
  disputes: PortalDisputeItem[];
}

export interface PortalDisputeDispositionResult {
  dispute_id: string;
  status: string;
}

// GET /v1/talent/identity/portal-disputes — the tenant's dispute worklist.
export function getPortalDisputes(params?: { all?: boolean }): Promise<PortalDisputeList> {
  const qs = params?.all === true ? '?all=1' : '';
  return apiClient.get<PortalDisputeList>(`${BASE}${qs}`);
}

// The dispositions (each a recorded human action; identity:resolve).
export function triageDispute(id: string): Promise<PortalDisputeDispositionResult> {
  return apiClient.post<PortalDisputeDispositionResult>(`${BASE}/${encodeURIComponent(id)}/triage`, {});
}

export function correctDispute(id: string, note: string): Promise<PortalDisputeDispositionResult> {
  return apiClient.post<PortalDisputeDispositionResult>(`${BASE}/${encodeURIComponent(id)}/correct`, { note });
}

export function upholdDispute(id: string, note: string): Promise<PortalDisputeDispositionResult> {
  return apiClient.post<PortalDisputeDispositionResult>(`${BASE}/${encodeURIComponent(id)}/uphold`, { note });
}

export function requestInfoDispute(id: string, note: string): Promise<PortalDisputeDispositionResult> {
  return apiClient.post<PortalDisputeDispositionResult>(`${BASE}/${encodeURIComponent(id)}/request-info`, { note });
}
