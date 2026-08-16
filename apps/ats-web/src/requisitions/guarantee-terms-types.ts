// Track 7 / T7-P5 — FE mirror of the P3 guarantee-term-versioning contract. Hand-mirrored from
// libs/placement/src/lib/permanent/guarantee-term-version.ts + guarantee-terms-source.ts (ADR-0029
// no domain import); drift caught by ./guarantee-terms-drift.spec.ts. effective_from/effective_to
// are calendar DATE strings (yyyy-mm-dd) → render with the timezone-safe `formatDate`;
// recorded_at/created_at are instants → `formatInstant`. Money is a decimal string, rendered
// verbatim (never recomputed).

export const GUARANTEE_TERMS_SOURCE_VALUES = ['MANUAL', 'IMPORTED'] as const;
export type GuaranteeTermsSourceType = (typeof GUARANTEE_TERMS_SOURCE_VALUES)[number];

export const GUARANTEE_TERMS_SOURCE_LABELS: Record<GuaranteeTermsSourceType, string> = {
  MANUAL: 'Manual',
  IMPORTED: 'Imported',
};

// Feature-local remedy-policy vocabulary (the deliberate small duplication carried by the
// house convention — NOT a cross-feature import of @aramo/placement). Byte-checked by the
// guarantee-terms drift spec.
export const TERMS_REMEDY_POLICY_VALUES = ['REPLACEMENT', 'REFUND', 'PRORATED_CREDIT'] as const;
export type TermsRemedyPolicy = (typeof TERMS_REMEDY_POLICY_VALUES)[number];

export const TERMS_REMEDY_POLICY_LABELS: Record<TermsRemedyPolicy, string> = {
  REPLACEMENT: 'Replacement',
  REFUND: 'Refund',
  PRORATED_CREDIT: 'Prorated credit',
};

// The reusable, requisition-keyed, effective-dated guarantee-term version. effective_to === null
// is the open current tail. supersedes_version_id points at the predecessor a revision closed.
export interface GuaranteeTermVersionView {
  readonly id: string;
  readonly tenant_id: string;
  readonly requisition_id: string;
  readonly effective_from: string; // calendar DATE → formatDate
  readonly effective_to: string | null; // calendar DATE
  readonly guarantee_duration_days: number;
  readonly remedy_policy: string;
  readonly guarantee_exposure_amount: string; // decimal string
  readonly currency: string;
  readonly source_type: GuaranteeTermsSourceType;
  readonly source_reference: string | null;
  readonly source_version: string | null;
  readonly recorded_by: string;
  readonly recorded_at: string; // instant → formatInstant
  readonly supersedes_version_id: string | null;
  readonly correlation_id: string | null;
  readonly created_at: string; // instant
}

export interface GuaranteeTermVersionListResponse {
  readonly items: readonly GuaranteeTermVersionView[];
}

// The create/revise request body (both share the payload shape).
export interface GuaranteeTermsRequest {
  readonly effective_from: string; // yyyy-mm-dd
  readonly guarantee_duration_days: number;
  readonly remedy_policy: string;
  readonly guarantee_exposure_amount: string;
  readonly currency: string;
  readonly source_type: GuaranteeTermsSourceType;
  readonly source_reference?: string;
  readonly source_version?: string;
  readonly correlation_id?: string;
}
