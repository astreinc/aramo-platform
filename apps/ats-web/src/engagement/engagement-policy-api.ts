// COMM-C3 — Tenant Engagement Policy admin client (ats-web). Provider-neutral:
// requirements speak only channel (voice/email) + neutral evidence terms; NO
// vendor key ever crosses this boundary. Draft is a UI-only editing state — only
// publish() writes a policy version (the enforcement boundary).

import { apiClient } from '@aramo/fe-foundation';

export type EngagementChannel = 'voice' | 'email';
export type EngagementEvidenceStrength = 'RECRUITER_ATTESTED' | 'PROVIDER_VERIFIED';

export interface EngagementCapability {
  readonly channel: EngagementChannel;
  readonly available: boolean;
}

export interface VoiceRequirement {
  readonly channel: 'voice';
  readonly required: boolean;
  readonly condition: 'two_way_conversation';
  readonly minimum_strength: EngagementEvidenceStrength;
}

export interface EmailRequirement {
  readonly channel: 'email';
  readonly required: boolean;
  readonly condition: 'recorded_evidence';
}

export type EngagementRequirement = VoiceRequirement | EmailRequirement;

export interface EffectiveEngagementPolicy {
  readonly requirements: readonly EngagementRequirement[];
  readonly layers: ReadonlyArray<{ scope: string; version: string; checksum: string }>;
  readonly composite_version: string;
}

/** The C3 three-state, expressed for the admin surface. */
export interface EngagementPolicyState {
  /** Has the tenant EVER published a policy? false = never configured / dormant. */
  readonly governed: boolean;
  /** The resolved TENANT-scoped effective policy (or null). */
  readonly effective: EffectiveEngagementPolicy | null;
}

export interface PublishEngagementPolicyInput {
  readonly version: string;
  readonly scope: 'TENANT' | 'CLIENT' | 'REQUISITION';
  readonly scope_ref?: string;
  readonly schema_version: 1;
  readonly requirements: readonly EngagementRequirement[];
}

export async function getEngagementCapabilities(): Promise<EngagementCapability[]> {
  const res = await apiClient.get<{ items: EngagementCapability[] }>('/v1/engagement/capabilities');
  return res.items;
}

/** Tenant-level policy state (no scope refs → the TENANT default layer). */
export async function getEngagementPolicyState(): Promise<EngagementPolicyState> {
  return apiClient.get<EngagementPolicyState>('/v1/engagement/policy/effective');
}

export async function publishEngagementPolicy(input: PublishEngagementPolicyInput): Promise<void> {
  await apiClient.post('/v1/engagement/policy', input);
}
