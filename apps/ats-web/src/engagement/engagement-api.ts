// COMM-C3 — engagement readiness client (ats-web). Provider-neutral; consumed by
// the requisition Talent drawer. No vendor key, no secret.

import { apiClient } from '@aramo/fe-foundation';

export type EngagementRequirementStatus =
  | 'satisfied'
  | 'not_required'
  | 'missing'
  | 'insufficient_strength'
  | 'unavailable'
  | 'no_producer';

export interface EngagementRequirementResult {
  readonly channel: 'voice' | 'email';
  readonly required: boolean;
  readonly status: EngagementRequirementStatus;
}

export interface EngagementChannelCapability {
  readonly channel: 'voice' | 'email';
  readonly available: boolean;
}

export interface EngagementReadiness {
  readonly governed: boolean;
  readonly policy_present: boolean;
  readonly satisfied: boolean;
  readonly unavailable: boolean;
  readonly missing: readonly ('voice' | 'email')[];
  readonly results: readonly EngagementRequirementResult[];
  readonly capabilities: readonly EngagementChannelCapability[];
}

export async function getEngagementReadiness(
  talentId: string,
  requisitionId: string,
): Promise<EngagementReadiness> {
  const qs = new URLSearchParams({ talent_id: talentId, requisition_id: requisitionId });
  return apiClient.get<EngagementReadiness>(`/v1/engagement/readiness?${qs.toString()}`);
}
