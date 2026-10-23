import { apiClient } from '@aramo/fe-foundation';

import type { IntelligenceStatus } from '../talent/dossier-api';

// Portal P3b → ATI-SEP-1 T10 WP3b — the tenant dispute-disposition client (core +
// identity:resolve). The disputes live in Talent Intelligence; the ATS relays.
// Tenant/actor come from the session cookie the apiClient attaches — never a
// param. ApiError propagates.

const BASE = '/v1/talent/identity/portal-disputes';

export interface PortalDisputeItem {
  dispute_id: string;
  /** This workspace's records on the disputed talent. */
  talent_record_ids: string[];
  assertion_id: string;
  /** The disputed assertion type. */
  item_type: string;
  contributed_by: string;
  status: string;
  arrived_at: string;
  updated_at: string;
  triage_due_at: string;
  reinvestigation_due_at: string;
}

export interface PortalDisputeList {
  intelligence_status: IntelligenceStatus;
  disputes: PortalDisputeItem[];
  next_cursor: string | null;
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
