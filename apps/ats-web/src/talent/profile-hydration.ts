// TALENT-INTEL-1 TI-1E-B1 — FE hand-mirror of the server profile-hydration
// projection + the pure DISPLAY adapter.
//
// The ats-web must not import @aramo/talent-record (domain-edge ban), so the
// hydration vocabulary is mirrored here 1:1 and profile-hydration.drift.spec.ts
// asserts it never drifts from the backend source
// (libs/talent-record/src/lib/talent-record-reconcile.repository.ts +
// libs/talent-record/src/lib/dto/profile-hydration.view.ts).
//
// The browser RENDERS server-owned state; it never reconstructs it. value_state
// drives empty/cleared; source_type drives provenance (null ⇒ no chip, NEVER
// FE-inferred); resolution drives the attention affordance. No write semantics
// live here (reads are additive; clearing still flows through the existing
// null PATCH).

export type HydrationValue = string | number | boolean | string[] | null;

// Vocabulary mirrored 1:1 from the BE source (talent-record-reconcile.repository
// .ts). Declared as const arrays so profile-hydration.drift.spec.ts can compare
// them against the BE union members at runtime; the types derive from the arrays.
export const HYDRATION_VALUE_STATES = ['UNKNOWN', 'SET', 'EXPLICITLY_CLEARED'] as const;
export const HYDRATION_SOURCE_TYPES = ['MANUAL', 'RESUME', 'RECONCILED', 'IMPORT'] as const;
export const HYDRATION_PROJECTION_POLICIES = ['AUTO', 'HOLD'] as const;
export const HYDRATION_RESOLUTION_STATUSES = ['NONE', 'PENDING_REVIEW', 'RESOLVED'] as const;
export const HYDRATION_RESOLUTION_REASONS = [
  'EVIDENCE_CONFLICT',
  'ACCEPTED_PROPOSED',
  'KEPT_CURRENT',
  'MANUAL_CONFIRMATION',
] as const;

export type HydrationValueState = (typeof HYDRATION_VALUE_STATES)[number];
export type HydrationSourceType = (typeof HYDRATION_SOURCE_TYPES)[number];
export type HydrationProjectionPolicy = (typeof HYDRATION_PROJECTION_POLICIES)[number];
export type HydrationResolutionStatus = (typeof HYDRATION_RESOLUTION_STATUSES)[number];
export type HydrationResolutionReason = (typeof HYDRATION_RESOLUTION_REASONS)[number];

export interface ProfileHydrationItem {
  readonly field_key: string;
  readonly current_value: HydrationValue;
  readonly value_state: HydrationValueState;
  readonly source_type: HydrationSourceType | null;
  readonly projection_policy: HydrationProjectionPolicy;
  readonly provenance: { readonly evidence_id: string } | null;
  readonly resolution_status: HydrationResolutionStatus;
  readonly resolution_reason: HydrationResolutionReason | null;
  readonly proposed_value: HydrationValue;
}

export interface ProfileHydrationResponse {
  readonly talent_record_id: string;
  readonly fields: readonly ProfileHydrationItem[];
}

// Recruiter-facing state vocabulary (ratified TI-1E-B1). UNKNOWN renders as the
// pervasive em-dash — deliberately NOT the word "Unknown" (that literal is
// already the availability_status STATED value, stated-fields.ts). "Cleared" and
// "Review required" are the governed-state affordances; "Review required" is a
// governed resolution condition, NOT a confidence indicator.
export const EMPTY_DISPLAY = '—';
export const CLEARED_LABEL = 'Cleared';
export const REVIEW_REQUIRED_LABEL = 'Review required';

export interface HydrationDisplay {
  readonly state: HydrationValueState;
  // Display text for the value: the typed value when SET, else the em-dash.
  readonly valueText: string;
  // "Cleared" when EXPLICITLY_CLEARED, else null — distinguishes a governed
  // clear from a never-set UNKNOWN (both otherwise show the em-dash).
  readonly clearedLabel: string | null;
  // The provenance chip source, taken VERBATIM from the server source_type;
  // null ⇒ no chip (plain operational value). Never inferred client-side.
  readonly provenance: HydrationSourceType | null;
  readonly needsReview: boolean;
  readonly reviewLabel: string | null;
  // The proposed value under an open review, formatted; null otherwise.
  readonly proposedText: string | null;
}

export function formatHydrationValue(v: HydrationValue): string {
  if (v === null) return EMPTY_DISPLAY;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

export function toHydrationDisplay(item: ProfileHydrationItem): HydrationDisplay {
  const isSet = item.value_state === 'SET';
  const isCleared = item.value_state === 'EXPLICITLY_CLEARED';
  const needsReview = item.resolution_status === 'PENDING_REVIEW';
  return {
    state: item.value_state,
    valueText: isSet ? formatHydrationValue(item.current_value) : EMPTY_DISPLAY,
    clearedLabel: isCleared ? CLEARED_LABEL : null,
    provenance: item.source_type,
    needsReview,
    reviewLabel: needsReview ? REVIEW_REQUIRED_LABEL : null,
    proposedText:
      needsReview && item.proposed_value !== null
        ? formatHydrationValue(item.proposed_value)
        : null,
  };
}

// Index a hydration response by field_key for O(1) per-field lookup at render.
export function indexHydration(
  res: ProfileHydrationResponse | null | undefined,
): Map<string, ProfileHydrationItem> {
  const m = new Map<string, ProfileHydrationItem>();
  // Defensive: a null/degenerate payload yields an empty map (fields fall back
  // to their plain operational value), never a crash.
  if (res == null || !Array.isArray(res.fields)) return m;
  for (const f of res.fields) m.set(f.field_key, f);
  return m;
}
