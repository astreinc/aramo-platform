import { apiClient } from '@aramo/fe-foundation';

// CCP-UI-V12 — the typed client for Usage › Consumption (CCP-D1, READ-ONLY; counts only, never
// money, never ordered by volume):
//   GET /platform/commercial/usage/reconciliation   platform:subscription:read
//   GET /platform/commercial/usage/periods          platform:subscription:read
//       refused 409 USAGE_ROLLUP_NOT_RECONCILED unless the live reconciliation is RECONCILED
// Shapes mirror apps/platform-admin/src/app/platform/dto/commercial-usage.dto.ts.

export interface UsageCounts {
  consumed: number;
  consumed_send: number;
  consumed_historical: number;
  reserved: number;
}

export type UsageStatus = 'NOT_RUN' | 'RECONCILED' | 'NOT_RECONCILED';

export interface UsageMetricReconciliation {
  metric_key: string;
  product_key: string;
  status: UsageStatus;
  watermark: string | null;
  last_run_id: string | null;
  buckets: { source: number; rollup: number; pending: number; compared: number; mismatched: number };
  mismatch_count: number;
}

export interface UsageReconciliation {
  product_key: string;
  status: UsageStatus;
  checked_at: string;
  metrics: UsageMetricReconciliation[];
}

export interface UsagePeriod {
  tenant_id: string;
  metric_key: string;
  product_key: string;
  period_start: string;
  period_end: string | null;
  alignment: 'ALIGNED' | 'UNALIGNED';
  subscription_id: string | null;
  plan_version_id: string | null;
  included_quantity: number | null;
  unlimited: boolean | null;
  counts: UsageCounts;
  stale: boolean;
  computed_at: string;
}

export interface UsagePeriods {
  product_key: string;
  reconciliation: { status: 'RECONCILED'; checked_at: string };
  periods: UsagePeriod[];
  truncated: boolean;
}

const U = '/platform/commercial/usage';
/** The Sign envelopes metric (the design's "Metric: Sign envelopes"). */
export const SIGN_ENVELOPES = 'sign.envelopes';

export const usageApi = {
  reconciliation(): Promise<UsageReconciliation> {
    return apiClient.get(`${U}/reconciliation?product_key=sign`);
  },
  periods(): Promise<UsagePeriods> {
    return apiClient.get(`${U}/periods?product_key=sign&metric_key=${SIGN_ENVELOPES}&limit=500`);
  },
};
