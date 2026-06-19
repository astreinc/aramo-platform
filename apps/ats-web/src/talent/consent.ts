// Add-Talent — the 5-scope consent-capture model.
//
// The scope keys + captured-method values are hand-mirrored from
// libs/consent/src/lib/dto/consent-grant-request.dto.ts (CONSENT_SCOPES /
// CONSENT_CAPTURED_METHODS — the closed enums that match openapi/common.yaml).
// These are REAL: POST /v1/consent/grant accepts exactly these scopes.
//
// ──────────────────────────────────────────────────────────────────────────
// KEYING HALT (Lead ruling, this PR):
//   The consent grant keys on a `talent_id` that is the CORE Talent id
//   (@IsUUID, cross-schema). A freshly-created ATS TalentRecord has a
//   nullable `core_talent_id` that is unset at create. Minting a thin Core
//   Talent + overlay at ATS-create to populate it would VIOLATE the locked
//   LINK-NOT-CREATE invariant (ats-batch4b-talent-link.integration.spec.ts:
//   bit-identical talent.* row-counts under ATS ops) and Proof 6 (the
//   single authorized `.talent.create(` call site lives in canonicalization
//   ONLY). Core-creation/resolution belongs in canonicalization (ingestion-
//   driven), NOT the ATS adapter.
//
//   THEREFORE: this PR captures consent in the UI to full parity and gates
//   the save on it, but does NOT fire POST /v1/consent/grant — firing it
//   keyed to the ATS record id would be a wrong-key write (consent-data
//   corruption on the moat). The grant is a documented backend-first carry:
//   it goes live once the Core-creation seam exists and core_talent_id is
//   populated through canonicalization. See doc/go-live-known-limitations.md.
// ──────────────────────────────────────────────────────────────────────────

// Hand-mirrored — keep in lockstep with CONSENT_SCOPES (libs/consent).
export type ConsentScope =
  | 'profile_storage'
  | 'resume_processing'
  | 'matching'
  | 'contacting'
  | 'cross_tenant_visibility';

// Hand-mirrored — CONSENT_CAPTURED_METHODS. The Add-Talent flow is a
// recruiter capturing on the talent's behalf.
export type ConsentCapturedMethod =
  | 'self_signup'
  | 'recruiter_capture'
  | 'upload_flow'
  | 'import';

export interface ConsentScopeDef {
  readonly key: ConsentScope;
  readonly label: string;
  readonly summary: string;
  // Required scopes gate the save (the talent cannot be stored + its résumé
  // cannot be indexed without them — the two operations the Add-Talent flow
  // actually performs).
  readonly required: boolean;
  // Default checked-state the recruiter starts from (they can toggle any
  // non-required scope off before saving).
  readonly defaultOn: boolean;
}

// The capture parameters that WOULD be recorded on each grant once the
// keying carry is closed (rendered as the capture metadata in the UI).
export const CONSENT_CAPTURED_METHOD: ConsentCapturedMethod = 'recruiter_capture';
export const CONSENT_EXPIRY_LABEL = '12 months';

export const CONSENT_SCOPE_DEFS: readonly ConsentScopeDef[] = [
  {
    key: 'profile_storage',
    label: 'Store profile',
    summary: 'Keep this person’s record in your workspace.',
    required: true,
    defaultOn: true,
  },
  {
    key: 'resume_processing',
    label: 'Process résumé',
    summary: 'Extract and index résumé text for search.',
    required: true,
    defaultOn: true,
  },
  {
    key: 'matching',
    label: 'Matching',
    summary: 'Allow Aramo to surface them against open reqs.',
    required: false,
    defaultOn: true,
  },
  {
    key: 'contacting',
    label: 'Contacting',
    summary: 'Reach out by email or phone.',
    required: false,
    defaultOn: true,
  },
  {
    key: 'cross_tenant_visibility',
    label: 'Cross-tenant visibility',
    summary: 'Share beyond your tenant.',
    required: false,
    defaultOn: false,
  },
] as const;

export type ConsentState = Readonly<Record<ConsentScope, boolean>>;

export function defaultConsentState(): ConsentState {
  const state = {} as Record<ConsentScope, boolean>;
  for (const def of CONSENT_SCOPE_DEFS) {
    state[def.key] = def.defaultOn;
  }
  return state;
}

// The required scopes are all granted — the gate the save honors.
export function requiredConsentGranted(state: ConsentState): boolean {
  return CONSENT_SCOPE_DEFS.filter((d) => d.required).every((d) => state[d.key]);
}
