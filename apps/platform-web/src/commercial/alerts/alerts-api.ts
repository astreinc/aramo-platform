import { apiClient } from '@aramo/fe-foundation';

// CCP-UI-V12 — the typed client for Operations › Alerts (CCP-D3 + CCP-FIX1, READ-ONLY; there is
// no acknowledge, retry or resolve route: alerts open and resolve automatically, PLATFORM-UX-1
// Amendment A1-2):
//   GET /platform/commercial/alerts/billing       platform:billing:read
//   GET /platform/commercial/alerts/approvals     platform:approval:read
//   GET /platform/commercial/metrics/billing      platform:billing:read   (the configured thresholds)
//   GET /platform/commercial/metrics/approvals    platform:approval:read  (the same thresholds)
// Shapes mirror apps/platform-admin/src/app/platform/dto/commercial-observability.dto.ts.

export interface CommercialAlert {
  id: string;
  alert_type: string;
  /** BILLING | APPROVAL */
  family: string;
  /** billing_command | reconciliation_flag | webhook_inbox | usage_metric | product_entitlement | change_request */
  subject_kind: string;
  subject_id: string;
  tenant_id: string | null;
  product_key: string | null;
  /** OPEN | RESOLVED */
  status: string;
  detail: string;
  evidence: Record<string, unknown>;
  threshold_minutes: number | null;
  detection_count: number;
  first_detected_at: string;
  last_detected_at: string;
  resolved_at: string | null;
  resolution_detail: string | null;
}

export interface AlertThresholds {
  pending_provider_stuck_minutes: number;
  approval_expiry_lead_minutes: number;
}

export interface BillingMetrics {
  as_of: string;
  commands_by_state: Record<string, number>;
  commands_pending_provider_past_threshold: number;
  webhook_inbox_by_status: Record<string, number>;
  open_reconciliation_flags_by_reason: Record<string, number>;
  open_alerts_by_type: Record<string, number>;
  thresholds: AlertThresholds;
}

export interface ApprovalMetrics {
  as_of: string;
  change_requests_by_state: Record<string, number>;
  pending_approval_nearing_expiry: number;
  pending_approval_past_expiry: number;
  open_alerts_by_type: Record<string, number>;
  thresholds: AlertThresholds;
}

const A = '/platform/commercial/alerts';
const M = '/platform/commercial/metrics';
/** The route's maximum page. */
export const ALERT_PAGE = 200;

export const alertsApi = {
  billing(): Promise<{ alerts: CommercialAlert[]; next_cursor: string | null }> {
    return apiClient.get(`${A}/billing?limit=${String(ALERT_PAGE)}`);
  },
  approvals(): Promise<{ alerts: CommercialAlert[]; next_cursor: string | null }> {
    return apiClient.get(`${A}/approvals?limit=${String(ALERT_PAGE)}`);
  },
  billingMetrics(): Promise<BillingMetrics> {
    return apiClient.get(`${M}/billing`);
  },
  approvalMetrics(): Promise<ApprovalMetrics> {
    return apiClient.get(`${M}/approvals`);
  },
};
