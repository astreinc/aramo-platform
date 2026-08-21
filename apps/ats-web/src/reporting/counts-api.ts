import { apiClient } from '@aramo/fe-foundation';

// P2-A (REQ-PIXEL-PARITY-1-A2) — rail nav count pills. Both counts come from
// TRUTHFUL, uncapped, report:read-gated report endpoints — NOT list length,
// which is 50-capped (RequisitionsListView LIST_CAP). The requisitions total is
// A3-visibility-scoped (matches the list breadth); the talent count is
// tenant-wide (per the tenant-counts DTO note).

interface RequisitionRollupView {
  readonly total: number;
  readonly by_status: Readonly<Record<string, number>>;
}

interface TenantCountsView {
  readonly talent_records: number;
}

export async function getRequisitionCount(): Promise<number> {
  const r = await apiClient.get<RequisitionRollupView>(
    '/v1/reports/requisition-rollup',
  );
  return r.total;
}

export async function getTalentCount(): Promise<number> {
  const r = await apiClient.get<TenantCountsView>('/v1/reports/tenant-counts');
  return r.talent_records;
}
