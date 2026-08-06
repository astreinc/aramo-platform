// PlacementProcess fallthrough/terminal Reason Registry — Track 3 / E3.
// Directive: Aramo-Track3-E3-Fallthrough-Reason-Directive (LOCKED) + Amendment.
//
// This registry is the platform-canonical, code-backed, closed-enum source of
// truth for WHY a PlacementProcess entered a governed terminal/fallthrough
// state. It is deterministic, version-controlled, non-tenant-extensible (E3),
// ordered, queryable by target state, and independent of mutable display text
// (the label is snapshotted onto the event at write time — §7).
//
// It is NOT table-backed (§7): the repository has no persistent-canonical-
// registry pattern, and a code array + guards is the established house shape
// (client-talent-restriction-vocab / pipeline override-reason-codes). The
// TAXONOMY (the set of codes) is PO-ratified (Gate-6 ruling); the MACHINERY
// (validation, detail policy, persistence, outbox exclusion) is taxonomy-neutral
// and every proof derives its fixtures from this data, so a future re-ruling is
// a pure data swap.
//
// VOCABULARY: the person being placed is "talent" (the canonical entity term —
// talent_record_id). The colloquial synonym is a Tier-2-banned term
// (scripts/verify-vocabulary.sh); it never appears in a code, label, or comment.

import { PLACEMENT_STATES, lifecyclePositionOf, type PlacementState } from '../lifecycle/placement-lifecycle.js';

// ---------------------------------------------------------------------------
// Detail policy + status vocabularies (closed).
// ---------------------------------------------------------------------------

export const REASON_DETAIL_POLICIES = ['REQUIRED', 'OPTIONAL', 'PROHIBITED'] as const;
export type ReasonDetailPolicy = (typeof REASON_DETAIL_POLICIES)[number];

// Forward-compatible lifecycle: a code is retired, never deleted, so historical
// evidence referencing it stays interpretable. Only `active` codes are offered
// for a new transition.
export const REASON_STATUSES = ['active', 'retired'] as const;
export type ReasonStatus = (typeof REASON_STATUSES)[number];

// A deterministic maximum for reason detail, matching the repository convention
// for recruiter-authored justification free-text (advisory-resolution /
// verification-proposal / examination-override / submittal-revocation
// justifications, and placement offer_terms_summary — all MaxLength(2000)).
export const REASON_DETAIL_MAX = 2000;

// ---------------------------------------------------------------------------
// Governed targets — DERIVED from lifecycle position (TERMINAL), never
// independently authored, so the governed set cannot drift from the state
// machine. These are exactly the states for which edgeAuthorityClass === the
// terminate class, i.e. the four the E3 directive governs.
// ---------------------------------------------------------------------------

export const GOVERNED_TERMINAL_TARGETS: readonly PlacementState[] = PLACEMENT_STATES.filter(
  (s) => lifecyclePositionOf(s) === 'TERMINAL',
);

export function isGovernedTerminalTarget(to: PlacementState): boolean {
  return lifecyclePositionOf(to) === 'TERMINAL';
}

// ---------------------------------------------------------------------------
// Reason definition + the ratified registry (Gate-6 PO ruling).
// ---------------------------------------------------------------------------

export type PlacementReasonDefinition = {
  readonly code: string; // stable, lowercase-snake, the persisted key
  readonly label: string; // mutable display text; snapshotted at write (§7)
  readonly allowedTargets: readonly PlacementState[]; // subset of GOVERNED_TERMINAL_TARGETS
  readonly detailPolicy: ReasonDetailPolicy;
  readonly status: ReasonStatus;
  readonly order: number; // deterministic total-sort key (unique)
};

// The ratified minimum-viable taxonomy. Codes are shared across targets where the
// operational event is the same (talent_withdrew / other), so the state preserves
// lifecycle context without minting synonyms.
export const PLACEMENT_REASONS: readonly PlacementReasonDefinition[] = [
  // OFFER_DECLINED — the talent declines the extended offer.
  { code: 'talent_declined_compensation', label: 'Talent declined — compensation', allowedTargets: ['OFFER_DECLINED'], detailPolicy: 'OPTIONAL', status: 'active', order: 1 },
  { code: 'talent_declined_role_terms', label: 'Talent declined — role, schedule, or location', allowedTargets: ['OFFER_DECLINED'], detailPolicy: 'OPTIONAL', status: 'active', order: 2 },
  { code: 'talent_accepted_other_offer', label: 'Talent accepted another offer', allowedTargets: ['OFFER_DECLINED'], detailPolicy: 'OPTIONAL', status: 'active', order: 3 },
  // Shared: the talent withdrew — at offer (OFFER_DECLINED) or after acceptance,
  // pre-start (FELL_THROUGH). The target state preserves the lifecycle context.
  { code: 'talent_withdrew', label: 'Talent withdrew', allowedTargets: ['OFFER_DECLINED', 'FELL_THROUGH'], detailPolicy: 'OPTIONAL', status: 'active', order: 4 },

  // OFFER_RESCINDED — the client withdraws the offer.
  { code: 'client_budget_or_headcount_change', label: 'Client budget or headcount change', allowedTargets: ['OFFER_RESCINDED'], detailPolicy: 'OPTIONAL', status: 'active', order: 5 },
  { code: 'client_role_cancelled', label: 'Client cancelled the role', allowedTargets: ['OFFER_RESCINDED'], detailPolicy: 'OPTIONAL', status: 'active', order: 6 },
  { code: 'client_requirements_changed', label: 'Client requirements changed', allowedTargets: ['OFFER_RESCINDED'], detailPolicy: 'OPTIONAL', status: 'active', order: 7 },
  { code: 'offer_error_or_correction', label: 'Offer error or correction', allowedTargets: ['OFFER_RESCINDED'], detailPolicy: 'OPTIONAL', status: 'active', order: 8 },
  // detailPolicy PROHIBITED here is a DATA-CLASSIFICATION decision, NOT a
  // formatting preference. Free text beside a background or compliance
  // determination is exactly where an operator types THE FINDING ITSELF — the
  // specific adverse record about a named individual. That text would land on
  // PlacementProcessEvent, which is permanent outside a governed tenant reset.
  // Same class of concern as offer_terms_summary (excluded from the outbox in
  // PR #574 / placement.repository.ts), one layer down. Do NOT relax to OPTIONAL
  // without a data-classification ruling: the reason code alone is the fact; the
  // adjudication detail belongs to its owning system, never as free text here.
  { code: 'background_or_compliance_failure', label: 'Background or compliance failure', allowedTargets: ['OFFER_RESCINDED'], detailPolicy: 'PROHIBITED', status: 'active', order: 9 },

  // NO_SHOW — the talent did not start.
  { code: 'talent_unreachable', label: 'Talent unreachable', allowedTargets: ['NO_SHOW'], detailPolicy: 'OPTIONAL', status: 'active', order: 10 },
  { code: 'talent_withdrew_before_start', label: 'Talent withdrew before start', allowedTargets: ['NO_SHOW'], detailPolicy: 'OPTIONAL', status: 'active', order: 11 },
  { code: 'talent_started_elsewhere', label: 'Talent started elsewhere', allowedTargets: ['NO_SHOW'], detailPolicy: 'OPTIONAL', status: 'active', order: 12 },

  // FELL_THROUGH — broad pre-start fallthrough.
  // pre_start_requirement_failed owns the compliance-failure territory on this
  // path: it COLLAPSES documentation / background-check / drug-screen / work-
  // authorization failures. The specific failed requirement (and its sensitive
  // determination) is owned by libs/pre-start-requirement (E2), NOT duplicated
  // here — so detail is PROHIBITED for the same data-classification reason as
  // background_or_compliance_failure above.
  { code: 'pre_start_requirement_failed', label: 'Pre-start requirement failed', allowedTargets: ['FELL_THROUGH'], detailPolicy: 'PROHIBITED', status: 'active', order: 13 },
  { code: 'start_date_failed', label: 'Start date failed', allowedTargets: ['FELL_THROUGH'], detailPolicy: 'OPTIONAL', status: 'active', order: 14 },
  { code: 'client_cancelled', label: 'Client cancelled before start', allowedTargets: ['FELL_THROUGH'], detailPolicy: 'OPTIONAL', status: 'active', order: 15 },

  // Shared across all four governed targets. `other` carries REQUIRED detail —
  // the free-text IS the evidence of which distinction the registry is missing.
  // (High `other` usage is the intended signal for a v2 taxonomy, not user error.)
  { code: 'other', label: 'Other', allowedTargets: [...GOVERNED_TERMINAL_TARGETS], detailPolicy: 'REQUIRED', status: 'active', order: 16 },
];

// ---------------------------------------------------------------------------
// Pure lookups (no I/O, no error framework — unit-testable in isolation).
// ---------------------------------------------------------------------------

const BY_CODE: ReadonlyMap<string, PlacementReasonDefinition> = new Map(
  PLACEMENT_REASONS.map((r) => [r.code, r]),
);

export function getReason(code: string): PlacementReasonDefinition | undefined {
  return BY_CODE.get(code);
}

// Active reasons offered for a target, deterministically ordered (retired codes
// are never offered for a new selection).
export function activeReasonsForTarget(state: PlacementState): PlacementReasonDefinition[] {
  return PLACEMENT_REASONS.filter((r) => r.status === 'active' && r.allowedTargets.includes(state)).sort(
    (a, b) => a.order - b.order,
  );
}

// Deterministic whitespace normalisation: trim, then collapse internal runs to a
// single space. Whitespace-only detail normalises to '' (i.e. "no content").
export function normalizeReasonDetail(detail: string): string {
  return detail.trim().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Reason classification (pure) — the taxonomy-neutral validation core. Returns a
// discriminated result; the repository maps a rejection to PLACEMENT_REASON_INVALID
// (422). Kept AramoError-free so the registry stays dependency-light and fully
// unit-testable without the HTTP error framework.
// ---------------------------------------------------------------------------

export type ReasonEvidence = {
  readonly reason_code: string;
  readonly reason_label_snapshot: string;
  readonly reason_detail: string | null; // normalised; null when absent or PROHIBITED
};

export const REASON_REJECTION_REASONS = [
  'reason_required',
  'reason_unknown',
  'reason_retired',
  'reason_wrong_target',
  'detail_required',
  'detail_prohibited',
  'detail_too_long',
  'reason_on_non_governed_target',
] as const;
export type ReasonRejectionReason = (typeof REASON_REJECTION_REASONS)[number];

export type ReasonClassification =
  | { readonly ok: true; readonly evidence: ReasonEvidence | null }
  | { readonly ok: false; readonly reason: ReasonRejectionReason; readonly reason_code?: string; readonly length?: number };

export type ClassifyReasonInput = {
  readonly to: PlacementState;
  readonly reason_code?: string | null;
  readonly reason_detail?: string | null;
};

export function classifyTransitionReason(input: ClassifyReasonInput): ReasonClassification {
  const rawCode = input.reason_code ?? null;
  const rawDetail = input.reason_detail ?? null;

  // A non-governed target must carry NO reason input at all.
  if (!isGovernedTerminalTarget(input.to)) {
    if ((rawCode !== null && rawCode !== '') || (rawDetail !== null && rawDetail !== '')) {
      return { ok: false, reason: 'reason_on_non_governed_target', reason_code: rawCode ?? undefined };
    }
    return { ok: true, evidence: null };
  }

  // Governed target: a stable reason CODE is mandatory (never a label).
  if (rawCode === null || rawCode === '') {
    return { ok: false, reason: 'reason_required' };
  }
  const def = getReason(rawCode);
  if (def === undefined) {
    return { ok: false, reason: 'reason_unknown', reason_code: rawCode };
  }
  if (def.status !== 'active') {
    return { ok: false, reason: 'reason_retired', reason_code: rawCode };
  }
  if (!def.allowedTargets.includes(input.to)) {
    return { ok: false, reason: 'reason_wrong_target', reason_code: rawCode };
  }

  // Detail policy. Normalise first, so whitespace-only == "no content".
  const normalized = rawDetail === null ? '' : normalizeReasonDetail(rawDetail);
  const hasContent = normalized !== '';

  switch (def.detailPolicy) {
    case 'PROHIBITED':
      if (hasContent) return { ok: false, reason: 'detail_prohibited', reason_code: rawCode };
      return { ok: true, evidence: { reason_code: def.code, reason_label_snapshot: def.label, reason_detail: null } };
    case 'REQUIRED':
      if (!hasContent) return { ok: false, reason: 'detail_required', reason_code: rawCode };
      if (normalized.length > REASON_DETAIL_MAX)
        return { ok: false, reason: 'detail_too_long', reason_code: rawCode, length: normalized.length };
      return { ok: true, evidence: { reason_code: def.code, reason_label_snapshot: def.label, reason_detail: normalized } };
    case 'OPTIONAL':
      if (!hasContent)
        return { ok: true, evidence: { reason_code: def.code, reason_label_snapshot: def.label, reason_detail: null } };
      if (normalized.length > REASON_DETAIL_MAX)
        return { ok: false, reason: 'detail_too_long', reason_code: rawCode, length: normalized.length };
      return { ok: true, evidence: { reason_code: def.code, reason_label_snapshot: def.label, reason_detail: normalized } };
  }
}
