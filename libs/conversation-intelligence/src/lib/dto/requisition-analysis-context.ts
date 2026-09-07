import type { GoldenProfileContent } from '@aramo/job-domain';

// CI-B2 — the typed, allowlisted Requisition analysis-context payload.
// Per Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED.md §10 +
// §17 (sensitive-content minimization). This is the single authority for
// WHAT recruiting context a snapshot carries — a closed allowlist, not a
// free-form blob. The snapshot builder (buildRequisitionAnalysisContext)
// is the ONLY constructor of this shape; the persisted JSONB is exactly
// its output.
//
// MINIMUM-NECESSARY POSTURE (directive §10 + §17). The allowlist maps
// ONLY the directive-named recruiting-context categories that the
// current Requisition + GoldenProfile substrate actually provides:
//   - role: title + the ungated role-classification job facts;
//   - location: city / state / postal_code;
//   - work_arrangement: arrangement + its qualifying job facts;
//   - engagement: the ungated duration / schedule constraints;
//   - work_authorization: the stated authorization requirement;
//   - golden_profile: the captured GoldenProfile CONTENT (skills /
//     experience / constraints / critical_skills) — copied, not
//     pointed-at, because the source GoldenProfile is mutable.
//
// DELIBERATELY EXCLUDED (never read into the snapshot): every
// compensation actual (pay_rate_* / bill_rate_* / placement_fee_* /
// salary_*) and every financial-planning field (target_margin_percent /
// markup_percent_target / rate_card_id / min|max_bill_rate /
// min|max_pay_rate), plus advertised_* / public_listing, free-text
// description / notes, and provenance columns (recruiter_id / owner_id /
// entered_by_id / import_batch_id / source_system / external_req_id).
// Sensitivity masking is therefore by CONSTRUCTION — the builder has no
// branch that reads a gated field, so no caller authorization can cause
// a restricted value to enter a snapshot (directive §10 rules 16-17).
//
// The required/preferred/critical skill split inside golden_profile is
// NOT invented here — it already exists on GoldenProfileContent
// (@aramo/job-domain); the snapshot reflects the existing substrate
// faithfully (directive §10: do not invent a requirement model the
// substrate lacks).

export const REQUISITION_ANALYSIS_CONTEXT_SCHEMA_VERSION =
  'ci.requisition-analysis-context.v1';

export type RequisitionAnalysisContextSchemaVersion =
  typeof REQUISITION_ANALYSIS_CONTEXT_SCHEMA_VERSION;

// The authorized, allowlisted recruiting fields a source reader resolves
// from the Requisition row + GoldenProfile content. This is the input to
// the builder — the fields are already field-authorized (a reader must
// never populate a gated compensation / financial column here).
export interface RequisitionAnalysisSource {
  tenant_id: string;
  requisition_id: string;
  // The exact Requisition CAS token (Requisition.version) at read time.
  source_requisition_version: number;
  // The GoldenProfile reference at read time (null when unminted).
  golden_profile_id: string | null;

  // ---- Allowlisted recruiting context (ungated job facts) ----------
  title: string;
  job_type: string | null;
  labor_category: string | null;
  role_family: string | null;
  seniority_level: string | null;

  city: string | null;
  state: string | null;
  postal_code: string | null;

  work_arrangement: string | null;
  onsite_days_per_week: number | null;
  travel_percent: number | null;
  relocation_offered: boolean;

  duration_value: number | null;
  duration_unit: string | null;
  hours_per_week: number | null;
  extension_possible: boolean;

  work_authorization: string | null;

  // The captured GoldenProfile content (null when the requisition has no
  // minted profile, or the profile is not resolvable in-tenant).
  golden_profile_content: GoldenProfileContent | null;
}

export interface RequisitionAnalysisRoleContext {
  title: string;
  job_type: string | null;
  labor_category: string | null;
  role_family: string | null;
  seniority_level: string | null;
}

export interface RequisitionAnalysisLocation {
  city: string | null;
  state: string | null;
  postal_code: string | null;
}

export interface RequisitionAnalysisWorkArrangement {
  work_arrangement: string | null;
  onsite_days_per_week: number | null;
  travel_percent: number | null;
  relocation_offered: boolean;
}

export interface RequisitionAnalysisEngagement {
  duration_value: number | null;
  duration_unit: string | null;
  hours_per_week: number | null;
  extension_possible: boolean;
}

export interface RequisitionAnalysisGoldenProfile {
  golden_profile_id: string;
  content: GoldenProfileContent;
}

export interface RequisitionAnalysisContextV1 {
  schema_version: RequisitionAnalysisContextSchemaVersion;
  role: RequisitionAnalysisRoleContext;
  location: RequisitionAnalysisLocation;
  work_arrangement: RequisitionAnalysisWorkArrangement;
  engagement: RequisitionAnalysisEngagement;
  work_authorization: string | null;
  golden_profile: RequisitionAnalysisGoldenProfile | null;
}

// The single constructor of a snapshot payload. Deterministic + pure:
// it copies ONLY the allowlisted fields from the source. Extra keys on
// `source` (were a caller to smuggle any) are structurally dropped — the
// output is exactly the RequisitionAnalysisContextV1 shape, self-tagged
// with the schema version.
export function buildRequisitionAnalysisContext(
  source: RequisitionAnalysisSource,
): RequisitionAnalysisContextV1 {
  return {
    schema_version: REQUISITION_ANALYSIS_CONTEXT_SCHEMA_VERSION,
    role: {
      title: source.title,
      job_type: source.job_type,
      labor_category: source.labor_category,
      role_family: source.role_family,
      seniority_level: source.seniority_level,
    },
    location: {
      city: source.city,
      state: source.state,
      postal_code: source.postal_code,
    },
    work_arrangement: {
      work_arrangement: source.work_arrangement,
      onsite_days_per_week: source.onsite_days_per_week,
      travel_percent: source.travel_percent,
      relocation_offered: source.relocation_offered,
    },
    engagement: {
      duration_value: source.duration_value,
      duration_unit: source.duration_unit,
      hours_per_week: source.hours_per_week,
      extension_possible: source.extension_possible,
    },
    work_authorization: source.work_authorization,
    golden_profile:
      source.golden_profile_id !== null &&
      source.golden_profile_content !== null
        ? {
            golden_profile_id: source.golden_profile_id,
            content: source.golden_profile_content,
          }
        : null,
  };
}

// A defensive structural validator for a persisted / round-tripped
// payload. Not a schema engine — a minimal shape + schema-version guard
// so a reader can fail closed on a malformed or wrong-version blob rather
// than trust an arbitrary JSONB value. Returns the narrowed type or
// throws nothing (callers decide) — a boolean type guard.
export function isRequisitionAnalysisContextV1(
  value: unknown,
): value is RequisitionAnalysisContextV1 {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v['schema_version'] !== REQUISITION_ANALYSIS_CONTEXT_SCHEMA_VERSION) {
    return false;
  }
  return (
    typeof v['role'] === 'object' &&
    v['role'] !== null &&
    typeof v['location'] === 'object' &&
    v['location'] !== null &&
    typeof v['work_arrangement'] === 'object' &&
    v['work_arrangement'] !== null &&
    typeof v['engagement'] === 'object' &&
    v['engagement'] !== null
  );
}
