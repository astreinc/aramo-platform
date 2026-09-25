import { apiClient } from '@aramo/fe-foundation';

// CSP PA-3 — the typed FE client for the Company → Policies admin surface. It speaks
// ONLY business-domain policy DTOs (§29): no generic engine predicates/PolicyPackage.
// Provenance (Inherited / Client override / Client-added / Tenant floor) is backend
// truth carried in each requirement's `provenance` — the FE never re-derives it (§6).

export type PolicyScope = 'TENANT' | 'CLIENT' | 'REQUISITION';

/** Per-requirement provenance flags. `tenant_floor` is absent for Engagement (§19). */
export interface RequirementProvenance {
  readonly inherited: boolean;
  readonly client_override: boolean;
  readonly client_added: boolean;
  readonly tenant_floor?: boolean;
}

/** The immutable layer a requirement's effective value was defined at. */
export interface RequirementSource {
  readonly scope: PolicyScope;
  readonly scope_ref: string | null;
  readonly package_name: string;
  readonly version: string;
  readonly checksum: string;
}

export interface EngagementLayerRef {
  readonly scope: PolicyScope;
  readonly package_name: string;
  readonly version: string;
  readonly checksum: string;
}

// ---- Client Submittal ------------------------------------------------------------
export interface ClientSubmittalEffectiveRequirement {
  readonly key: string;
  readonly effective: {
    readonly disposition: 'REQUIRED' | 'NOT_REQUIRED';
    readonly override_class: 'HARD_DENY' | 'OVERRIDABLE' | 'AUDIT_ONLY';
    readonly override_policy: 'DEFAULT' | 'FLOOR';
  };
  readonly source: RequirementSource;
  readonly provenance: Required<RequirementProvenance>;
}
export interface ClientSubmittalEffectiveView {
  readonly requirements: readonly ClientSubmittalEffectiveRequirement[];
  readonly layers: readonly RequirementSource[];
  readonly composite_version: string;
}
export interface ClientSubmittalRequirementDef {
  readonly key: string;
  readonly disposition: 'REQUIRED' | 'NOT_REQUIRED';
  readonly override_class: 'HARD_DENY' | 'OVERRIDABLE' | 'AUDIT_ONLY';
  readonly override_policy: 'DEFAULT' | 'FLOOR';
}
export interface PolicyLayer<Def> {
  readonly scope: PolicyScope;
  readonly scope_ref: string | null;
  readonly package_name: string;
  readonly present: boolean;
  readonly version: string | null;
  readonly checksum: string | null;
  readonly effective_from: string | null;
  readonly published_at: string | null;
  readonly published_by: string | null;
  readonly requirements: readonly Def[];
}
export interface ClientSubmittalLayersView {
  readonly tenant: PolicyLayer<ClientSubmittalRequirementDef>;
  readonly client: PolicyLayer<ClientSubmittalRequirementDef> | null;
  readonly requisition: PolicyLayer<ClientSubmittalRequirementDef> | null;
  readonly effective: ClientSubmittalEffectiveView | null;
}

// ---- Engagement ------------------------------------------------------------------
export type EngagementEnforcementMode = 'ADVISORY' | 'ENFORCING' | 'ENFORCING_WITH_OVERRIDE';
export interface EngagementRequirementDef {
  readonly channel: 'voice' | 'email';
  readonly required: boolean;
  readonly condition: string;
  readonly minimum_strength?: 'RECRUITER_ATTESTED' | 'PROVIDER_VERIFIED';
}
export interface EngagementEffectiveRequirement {
  readonly channel: 'voice' | 'email';
  readonly requirement: EngagementRequirementDef;
  readonly source: RequirementSource;
  readonly provenance: RequirementProvenance;
}
export interface EngagementEffectiveView {
  readonly requirements: readonly EngagementEffectiveRequirement[];
  readonly layers: readonly EngagementLayerRef[];
  readonly composite_version: string;
  readonly enforcement_mode: EngagementEnforcementMode;
}
export interface EngagementLayer extends Omit<PolicyLayer<EngagementRequirementDef>, 'scope_ref'> {
  readonly scope_ref: string | null;
  readonly enforcement_mode: EngagementEnforcementMode | null;
}
export interface EngagementLayersView {
  readonly tenant: EngagementLayer;
  readonly client: EngagementLayer | null;
  readonly requisition: EngagementLayer | null;
  readonly effective: EngagementEffectiveView | null;
}

// ---- Pre-Start -------------------------------------------------------------------
export interface PreStartRequirementDef {
  readonly requirement_type: string;
  readonly label: string;
  readonly blocking: boolean;
  readonly owner_role: string | null;
  readonly sequence: number;
  readonly waiver_mode: 'NOT_WAIVABLE' | 'CLIENT_AUTHORITY_ONLY' | 'AUTHORIZED_INTERNAL';
  readonly satisfaction_policy: 'SELF_ATTEST' | 'VERIFICATION_REQUIRED';
  readonly override_policy: 'DEFAULT' | 'FLOOR';
}
export interface PreStartEffectiveRequirement extends PreStartRequirementDef {
  readonly source: { readonly scope: PolicyScope; readonly scope_ref_id: string; readonly version: string };
  readonly provenance: Required<RequirementProvenance>;
}
export interface PreStartEffectiveView {
  readonly scope: PolicyScope;
  readonly scope_ref_id: string;
  readonly version: string;
  readonly checksum: string;
  readonly published_at: string | null;
  readonly published_by: string | null;
  readonly definitions: readonly PreStartEffectiveRequirement[];
  readonly layers: readonly { scope: PolicyScope; scope_ref_id: string; version: string; checksum: string }[];
}
export interface PreStartLayer {
  readonly scope: PolicyScope;
  readonly scope_ref_id: string;
  readonly present: boolean;
  readonly version: string | null;
  readonly checksum: string | null;
  readonly published_at: string | null;
  readonly published_by: string | null;
  readonly definitions: readonly PreStartRequirementDef[];
}
export interface PreStartLayersView {
  readonly tenant: PreStartLayer;
  readonly client: PreStartLayer | null;
  readonly requisition: PreStartLayer | null;
  readonly effective: PreStartEffectiveView | null;
}

// ---- History (shared shape) ------------------------------------------------------
export interface PolicyVersionHistoryEntry {
  readonly version: string;
  readonly effective_from?: string | null;
  readonly effective_to: string | null;
  readonly published_at: string | null;
  readonly published_by: string | null;
  readonly checksum: string;
  readonly status: 'current' | 'scheduled' | 'superseded';
}

function q(companyId: string | null, requisitionId?: string | null): string {
  const p = new URLSearchParams();
  if (companyId) p.set('company_id', companyId);
  if (requisitionId) p.set('requisition_id', requisitionId);
  const s = p.toString();
  return s ? `?${s}` : '';
}
function historyQ(scope: PolicyScope, scopeRef: string | null): string {
  const p = new URLSearchParams({ scope });
  if (scopeRef) p.set('scope_ref', scopeRef);
  return `?${p.toString()}`;
}

// ---- Client Submittal endpoints --------------------------------------------------
export function getClientSubmittalEffective(
  companyId: string | null,
  requisitionId?: string | null,
): Promise<{ effective: ClientSubmittalEffectiveView | null }> {
  return apiClient.get(`/v1/client-submittal-policy/effective${q(companyId, requisitionId)}`);
}
export function getClientSubmittalLayers(
  companyId: string | null,
  requisitionId?: string | null,
): Promise<{ layers: ClientSubmittalLayersView }> {
  return apiClient.get(`/v1/client-submittal-policy/layers${q(companyId, requisitionId)}`);
}
export function getClientSubmittalHistory(
  scope: PolicyScope,
  scopeRef: string | null,
): Promise<{ versions: readonly PolicyVersionHistoryEntry[] }> {
  return apiClient.get(`/v1/client-submittal-policy/history${historyQ(scope, scopeRef)}`);
}
export function publishClientSubmittal(body: {
  scope: PolicyScope;
  scope_ref?: string | null;
  version: string;
  requirements: readonly ClientSubmittalRequirementDef[];
}): Promise<{ published: unknown }> {
  return apiClient.post('/v1/client-submittal-policy', body);
}

// ---- Engagement endpoints --------------------------------------------------------
export function getEngagementEffective(
  companyId: string | null,
  requisitionId?: string | null,
): Promise<{ governed: boolean; effective: EngagementEffectiveView | null }> {
  return apiClient.get(`/v1/engagement/policy/effective${q(companyId, requisitionId)}`);
}
export function getEngagementLayers(
  companyId: string | null,
  requisitionId?: string | null,
): Promise<{ layers: EngagementLayersView }> {
  return apiClient.get(`/v1/engagement/policy/layers${q(companyId, requisitionId)}`);
}
export function getEngagementHistory(
  scope: PolicyScope,
  scopeRef: string | null,
): Promise<{ versions: readonly PolicyVersionHistoryEntry[] }> {
  return apiClient.get(`/v1/engagement/policy/history${historyQ(scope, scopeRef)}`);
}
export function publishEngagement(body: {
  scope: PolicyScope;
  scope_ref?: string | null;
  version: string;
  schema_version: number;
  requirements: readonly EngagementRequirementDef[];
  enforcement_mode?: EngagementEnforcementMode;
}): Promise<{ published: unknown }> {
  return apiClient.post('/v1/engagement/policy', body);
}

// ---- Pre-Start endpoints ---------------------------------------------------------
export function getPreStartEffective(
  companyId: string | null,
  requisitionId?: string | null,
): Promise<{ effective: PreStartEffectiveView | null }> {
  return apiClient.get(`/v1/pre-start-requirement/effective${q(companyId, requisitionId)}`);
}
export function getPreStartLayers(
  companyId: string | null,
  requisitionId?: string | null,
): Promise<{ layers: PreStartLayersView }> {
  return apiClient.get(`/v1/pre-start-requirement/layers${q(companyId, requisitionId)}`);
}
export function getPreStartHistory(
  scope: PolicyScope,
  scopeRef: string | null,
): Promise<{ versions: readonly PolicyVersionHistoryEntry[] }> {
  return apiClient.get(`/v1/pre-start-requirement/history${historyQ(scope, scopeRef)}`);
}
