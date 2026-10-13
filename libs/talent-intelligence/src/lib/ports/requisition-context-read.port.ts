import type { VisibilityContextShape } from '@aramo/common';

// TIP-E2E INC-2 — RequisitionContextReadPort (ARAMO-TIP-E2E-INC-2-v1.0-LOCKED §3.1).
//
// A domain-owned, in-process READ contract returning authoritative requisition
// context under the actor's visibility. The lib owns the interface + token +
// neutral shapes ONLY; the concrete adapter (apps/api) composes RequisitionRepository
// + RequisitionSkillRequirementRepository with NO cross-schema SQL escape.
//
// Fail-closed / 404-conceal: resolveContext returns null when the requisition is
// absent OR out of the actor's visibility (never a leak, never an existence tell).
export const REQUISITION_CONTEXT_READ_PORT = Symbol('REQUISITION_CONTEXT_READ_PORT');

export type RequirementType = 'required' | 'preferred' | 'critical';

// A single requisition skill requirement, requisition-keyed (§4 / R5). Raw surface
// form is preserved even when not yet canonicalized; canonicalization_status is
// reported honestly (never fabricated).
export interface RequisitionSkillRequirementContract {
  readonly requirement_type: RequirementType;
  readonly raw_surface_form: string;
  readonly version_requirement: string | null;
  readonly canonical_skill_id: string | null;
  readonly canonical_version_id: string | null;
  readonly canonicalization_status: string | null;
}

// Full requisition context (single). The skill_requirements surface is INC-4-facing
// (§13): populated + integration-tested in INC-2, production-consumed by the
// downstream journey increment — NOT a completed user-facing capability here.
export interface RequisitionContext {
  readonly requisition_id: string;
  readonly status: string;
  readonly site_id: string | null;
  readonly company_id: string | null;
  readonly title: string | null;
  readonly requisition_number: number | null;
  readonly golden_profile_id: string | null;
  readonly skill_requirements: readonly RequisitionSkillRequirementContract[];
}

// Lean batch summary — the exact subset the INC-2 consumer (Talent-360) renders,
// mirroring the existing RequisitionSummaryRow shape (non-null id/number/title/
// company_id, per findSummariesByIds).
export interface RequisitionContextSummary {
  readonly id: string;
  readonly requisition_number: number;
  readonly title: string;
  readonly company_id: string;
  readonly status: string;
  readonly is_hot: boolean;
  readonly owner_id: string | null;
  readonly recruiter_id: string | null;
}

export interface RequisitionContextReadPort {
  // Single, FULL context incl. requisition-keyed skill requirements (§4). Returns
  // null when absent OR out-of-visibility (404-conceal). INC-4-facing full surface.
  resolveContext(input: {
    tenant_id: string;
    actor: VisibilityContextShape;
    requisition_id: string;
  }): Promise<RequisitionContext | null>;

  // Batch LEAN summary under actor visibility (§3.1, Condition 1). The port itself
  // applies tenant + actor + site visibility BEFORE returning; it does NOT trust the
  // caller to pre-resolve visibility and does NOT return arbitrary tenant-matched
  // ids. Hidden / cross-site / nonexistent ids are OMITTED from the returned map.
  resolveContexts(input: {
    tenant_id: string;
    actor: VisibilityContextShape;
    requisition_ids: readonly string[];
  }): Promise<ReadonlyMap<string, RequisitionContextSummary>>;
}
