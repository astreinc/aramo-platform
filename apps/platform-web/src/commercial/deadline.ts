import { useEffect, useState } from 'react';

import { governanceApi, type PolicyList } from '../commercial-governance/governance-api';

import { alertsApi } from './alerts/alerts-api';
import type { ChangeRequest } from './commercial-api';
import { DEFAULT_NEAR_HOURS, type DeadlineContext } from './commercial-model';

// CCP-UI-V12 (CCP-UI v1.1 AM-3…AM-6; v1.2 §17.1 D-1, D-2; Charter Amendment A1 AD-2) — the apply
// deadline of a request, for DISPLAY: final approval + the `apply_expiry_hours` of the policy
// version the request snapshotted (`policy_version_id`; versions are immutable, so the value is
// exact). A version without the key has no deadline (policy v1). The A3 read carries no deadline
// field (MBC-V12-2). Apply authority is the server's alone (`apply_actionable`). The amber lead is
// read from configuration (GET /platform/commercial/metrics/approvals `thresholds`, TD-D3-2).

export interface DeadlineSources {
  readonly policies: PolicyList | null;
  readonly nearHours: number;
}

const H = 3_600_000;

/** The request's deadline context; undefined until the policy versions are read. */
export function deadlineOf(r: Pick<ChangeRequest, 'policy_version_id' | 'approved_at'>, src: DeadlineSources): DeadlineContext | undefined {
  if (src.policies === null) return undefined;
  const v = src.policies.versions.find((x) => x.id === r.policy_version_id);
  const hours = v?.content?.apply_expiry_hours;
  const applyBy = r.approved_at !== null && typeof hours === 'number' ? new Date(Date.parse(r.approved_at) + hours * H) : null;
  return { applyBy, policyVersion: v?.version_number ?? null, nearHours: src.nearHours };
}

/** "v2", and whether it is the active version (the inbox Policy column; the drawer Policy fact). */
export function policyOf(id: string, policies: PolicyList | null): { readonly number: number; readonly active: boolean; readonly activeNumber: number | null } | null {
  if (policies === null) return null;
  const v = policies.versions.find((x) => x.id === id);
  if (v === undefined) return null;
  const a = policies.versions.find((x) => x.status === 'ACTIVE');
  return { number: v.version_number, active: v.status === 'ACTIVE', activeNumber: a?.version_number ?? null };
}

/** The ACC-1 withdraw hint of a failed policy activation (the policy list's `open_request`). */
export function withdrawActionable(requestId: string, policies: PolicyList | null): boolean {
  return (policies?.versions ?? []).some((v) => v.open_request?.id === requestId && v.open_request.withdraw_actionable === true);
}

/** The policy versions (platform:approval:read) and the configured near-expiry lead, read once. */
export function useDeadlineSources(): DeadlineSources & { readonly reload: () => void } {
  const [policies, setPolicies] = useState<PolicyList | null>(null);
  const [nearHours, setNear] = useState(DEFAULT_NEAR_HOURS);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    governanceApi.listPolicyVersions().then(
      (p) => {
        if (!cancelled) setPolicies(p);
      },
      () => undefined,
    );
    alertsApi.approvalMetrics().then(
      (m) => {
        if (!cancelled) setNear(Math.round(m.thresholds.approval_expiry_lead_minutes / 60));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [tick]);
  return { policies, nearHours, reload: () => setTick((t) => t + 1) };
}
