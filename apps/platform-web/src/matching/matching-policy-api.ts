import { apiClient } from '@aramo/fe-foundation';

// ATI-SEP-1 A2 A-c (P1) — typed client for the platform-owned MatchingPolicy
// (/platform/matching-policy*). Edge-routed to apps/api (:3000 dev, api:3000 prod) —
// see vite.config / nginx. Rides the shared HttpOnly platform session cookie via
// apiClient. Platform tier only: tenants consume the policy and have no route to it.

export type MatchingPolicyStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';

// The role families the engine calibrates, in the engine's order (libs/matching
// ROLE_FAMILIES). platform-web cannot import libs/matching (scope:cip), so the list is
// mirrored here; the API refuses any document that does not carry exactly these.
export const ROLE_FAMILIES = [
  'backend_engineer',
  'frontend_engineer',
  'fullstack_engineer',
  'devops_sre',
  'data_engineer',
  'architect',
  'qa_test_engineer',
  'product_project_manager',
  'business_analyst',
] as const;
export type RoleFamily = (typeof ROLE_FAMILIES)[number];

export const ROLE_FAMILY_LABELS: Readonly<Record<RoleFamily, string>> = {
  backend_engineer: 'Backend engineer',
  frontend_engineer: 'Frontend engineer',
  fullstack_engineer: 'Full-stack engineer',
  devops_sre: 'DevOps / SRE',
  data_engineer: 'Data engineer',
  architect: 'Architect',
  qa_test_engineer: 'QA / test engineer',
  product_project_manager: 'Product / project manager',
  business_analyst: 'Business analyst',
};

// Inclusive count bounds (mirrors libs/matching EVIDENCE_COUNT_MIN / _MAX).
export const EVIDENCE_COUNT_MIN = 1;
export const EVIDENCE_COUNT_MAX = 20;

export interface RoleFamilyEvidenceThreshold {
  count: number;
  requires_ingested: boolean;
}
export type EvidenceThresholds = Record<RoleFamily, RoleFamilyEvidenceThreshold>;

export interface MatchingPolicyVersion {
  id: string;
  version_number: number;
  status: MatchingPolicyStatus;
  evidence_thresholds: EvidenceThresholds;
  note: string | null;
  created_by: string | null;
  created_at: string;
  activated_by: string | null;
  activated_at: string | null;
  retired_at: string | null;
}

export interface MatchingPolicyState {
  active: MatchingPolicyVersion | null;
  versions: MatchingPolicyVersion[];
}

export const matchingPolicyApi = {
  // platform:matching_policy:read
  getPolicy(): Promise<MatchingPolicyState> {
    return apiClient.get('/platform/matching-policy');
  },
  // platform:matching_policy:write
  createVersion(body: {
    evidence_thresholds: EvidenceThresholds;
    note?: string | null;
  }): Promise<MatchingPolicyVersion> {
    return apiClient.post('/platform/matching-policy/versions', body);
  },
  activateVersion(id: string): Promise<MatchingPolicyVersion> {
    return apiClient.post(`/platform/matching-policy/versions/${id}/activate`);
  },
};
