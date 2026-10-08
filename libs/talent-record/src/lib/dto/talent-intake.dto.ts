import type { TalentIntakeDraftRow } from '@aramo/talent-evidence';

// Durable Async Résumé-First Talent Intake — HTTP request/response + view DTOs.
// The GET view is the AUTHORITATIVE read model (recruiters recover work from it,
// not from browser state). Internal fields (child error codes, raw failure codes)
// are NEVER projected — only recruiter-safe prose.

export interface CreateTalentIntakeDraftRequestDto {
  filename: string;
  content_type: string;
}

export interface CreateTalentIntakeDraftResponse {
  draft_id: string;
  upload_url: string;
  storage_key: string;
  processing_status: string;
  expires_at: string;
}

export interface CompleteTalentIntakeUploadRequestDto {
  // Optional browser-computed byte digest; the server independently verifies the
  // object exists (headObject) and records authoritative size/content-type.
  artifact_sha256?: string;
}

export interface PatchTalentIntakeReviewRequestDto {
  review: unknown; // IntakeReviewPayload — validated loosely at the boundary
  expected_version: number;
}

export interface TalentIntakeAcceptedView {
  draft_id: string;
  processing_status: string;
}

// Draft-level duplicate projection (§15 / PO duplicate-authority ruling). Reuses
// the SAME tenant-wide, live-only, case-insensitive email1 authority as the
// create-time 409 (TalentRecordRepository.findDuplicateByEmail) — surfaced at
// review time so the recruiter learns of the collision before pressing Create,
// NOT a new detector. V1: an active-email duplicate is a hard create block
// (409 preserved), so `continue_anyway` is always false — the FE renders Open
// existing Talent + Discard, never "Continue anyway". Phone dedup is deferred.
export interface TalentIntakeDuplicateView {
  talent_record_id: string;
  display_name: string;
  title: string | null;
  location: string | null; // "City, ST" when available
  reason: 'email';
  continue_anyway: boolean;
}

// Recruiter-facing completeness guidance (§5.1 "n of 5 required"). This is a
// COMPLETENESS indicator, NOT the create gate — creation is governed by the
// backend `promote_to_talent` action (canonical admission), never by this count.
export interface TalentIntakeRequired {
  met: number;
  total: number;
}

export interface TalentIntakeDraftView {
  id: string;
  source_filename: string | null; // null for non-upload (artifact-less) sources
  mime_type: string | null;
  size_bytes: number | null;
  processing_status: string;
  review_status: string;
  // The grounded governed prefill under review (recruiter-safe; NOT evidence).
  structured_payload: unknown;
  // Persisted recruiter review values + per-field origin.
  review_payload: unknown;
  warning: string | null; // recruiter-safe prose
  failure: string | null; // recruiter-safe prose
  promoted_talent_record_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  processing_completed_at: string | null;
  // Authoritative recruiter-touch instant (§22) — recruiter-sourced actions only,
  // never background extraction. Drives the My Desk 3-day staleness rule.
  last_touched_at: string | null;
  // Possible existing Talent (email match), or null. Backend authority — the FE
  // never invents duplicate detection.
  duplicate: TalentIntakeDuplicateView | null;
  // Completeness guidance (NOT the create gate — see TalentIntakeRequired).
  required: TalentIntakeRequired;
  // Canonical admission satisfied (§9) — the backend create authority.
  admissible: boolean;
  // Backend-owned eligibility — the FE does not duplicate this logic.
  actions: string[];
}

export interface TalentIntakeDraftListItemView {
  id: string;
  source_filename: string | null; // null for non-upload (artifact-less) sources
  processing_status: string;
  review_status: string;
  promoted_talent_record_id: string | null;
  created_at: string;
  updated_at: string;
  last_touched_at: string | null;
  required: TalentIntakeRequired;
  admissible: boolean;
  // Review/extracted person name when known, else null (§5.1 name precedence —
  // the FE falls back to the filename). Never fabricates a TalentRecord identity.
  display_name: string | null;
}

export interface TalentIntakeDraftListView {
  items: TalentIntakeDraftListItemView[];
}

function iso(d: Date | null): string | null {
  return d === null ? null : new Date(d).toISOString();
}

// Backend-owned available actions (Talent Draft Recovery §10 / action-availability).
// `duplicateBlocksCreate` is true when an active-email duplicate exists: creation
// is blocked (the promote-time 409 is preserved — PO ruling), so promote is NOT
// offered; the FE surfaces Open existing Talent + Discard instead.
export function talentIntakeActions(
  row: TalentIntakeDraftRow,
  opts: { duplicateBlocksCreate?: boolean } = {},
): string[] {
  const actions: string[] = [];
  const terminal =
    row.processing_status === 'READY' ||
    row.processing_status === 'PARTIAL' ||
    row.processing_status === 'FAILED';
  const promoted = row.promoted_talent_record_id !== null;
  if (!promoted) {
    actions.push('edit_draft');
    if (row.processing_status === 'FAILED' || row.processing_status === 'PARTIAL') {
      // Both retry (same artifact) and replace (new artifact) are offered on a
      // non-success extraction (§13).
      actions.push('retry_extraction');
      actions.push('replace_resume');
    }
    if (terminal && opts.duplicateBlocksCreate !== true) {
      actions.push('promote_to_talent');
    }
    // Explicit discard is always available on an unpromoted draft (§18) — there
    // is no age-based auto-deletion.
    actions.push('discard');
  }
  return actions;
}

// Completeness guidance (§5.1) — 5 recruiter-facing items: name, email, phone,
// city+state, résumé attached. GUIDANCE ONLY; it never gates creation (the
// backend `promote_to_talent` action is the Create authority). City/state and
// résumé are intentionally NOT admission requirements (§9) — they are shown here
// only to help the recruiter complete a rich profile.
export function computeRequiredSummary(row: TalentIntakeDraftRow): TalentIntakeRequired {
  const fields =
    row.review_payload !== null &&
    typeof row.review_payload === 'object' &&
    'fields' in (row.review_payload as Record<string, unknown>)
      ? ((row.review_payload as { fields?: Record<string, { value?: unknown }> }).fields ?? {})
      : {};
  const has = (key: string): boolean => {
    const v = fields[key]?.value;
    return typeof v === 'string' && v.trim() !== '';
  };
  const checks = [
    has('first_name') && has('last_name'),
    has('email1'),
    has('phone_cell'),
    has('city') && has('state'),
    row.storage_key !== null, // résumé attached
  ];
  return { met: checks.filter(Boolean).length, total: checks.length };
}

// Canonical admission (§9) — a name, a primary email, and a cell phone. This is
// the ONLY creation gate; extraction state and the completeness guidance never
// gate it. Surfaced so the FE "Ready to create" pill + Create button reflect the
// backend create authority (not the prototype's 5-item checklist).
export function computeAdmissible(row: TalentIntakeDraftRow): boolean {
  const fields =
    row.review_payload !== null &&
    typeof row.review_payload === 'object' &&
    'fields' in (row.review_payload as Record<string, unknown>)
      ? ((row.review_payload as { fields?: Record<string, { value?: unknown }> }).fields ?? {})
      : {};
  const has = (key: string): boolean => {
    const v = fields[key]?.value;
    return typeof v === 'string' && v.trim() !== '';
  };
  return has('first_name') && has('last_name') && has('email1') && has('phone_cell');
}

// Review/extracted person name (first + last) when present, else null. Never
// fabricates a Talent identity — the FE falls back to the filename (§5.1).
export function computeDraftDisplayName(row: TalentIntakeDraftRow): string | null {
  const fields =
    row.review_payload !== null &&
    typeof row.review_payload === 'object' &&
    'fields' in (row.review_payload as Record<string, unknown>)
      ? ((row.review_payload as { fields?: Record<string, { value?: unknown }> }).fields ?? {})
      : {};
  const str = (key: string): string => {
    const v = fields[key]?.value;
    return typeof v === 'string' ? v.trim() : '';
  };
  const name = `${str('first_name')} ${str('last_name')}`.trim();
  return name === '' ? null : name;
}

export function toTalentIntakeDraftView(
  row: TalentIntakeDraftRow,
  opts: { duplicate?: TalentIntakeDuplicateView | null } = {},
): TalentIntakeDraftView {
  const duplicate = opts.duplicate ?? null;
  return {
    id: row.id,
    source_filename: row.source_filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    processing_status: row.processing_status,
    review_status: row.review_status,
    structured_payload: row.structured_payload ?? null,
    review_payload: row.review_payload ?? null,
    // warning_code / failure_detail hold recruiter-safe prose (set by the worker
    // from the shared orchestrator). The internal code lives on the child and is
    // never projected here.
    warning: (row.warning_code as string | null) ?? null,
    failure: (row.failure_detail as string | null) ?? null,
    promoted_talent_record_id: row.promoted_talent_record_id,
    version: row.version,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    processing_completed_at: iso(row.processing_completed_at),
    last_touched_at: iso(row.last_touched_at),
    duplicate,
    required: computeRequiredSummary(row),
    admissible: computeAdmissible(row),
    actions: talentIntakeActions(row, {
      duplicateBlocksCreate: duplicate !== null && duplicate.continue_anyway === false,
    }),
  };
}

export function toTalentIntakeDraftListItemView(
  row: TalentIntakeDraftRow,
): TalentIntakeDraftListItemView {
  return {
    id: row.id,
    source_filename: row.source_filename,
    processing_status: row.processing_status,
    review_status: row.review_status,
    promoted_talent_record_id: row.promoted_talent_record_id,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    last_touched_at: iso(row.last_touched_at),
    required: computeRequiredSummary(row),
    admissible: computeAdmissible(row),
    display_name: computeDraftDisplayName(row),
  };
}
