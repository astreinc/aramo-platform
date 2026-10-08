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
}

export interface TalentIntakeDraftListView {
  items: TalentIntakeDraftListItemView[];
}

function iso(d: Date | null): string | null {
  return d === null ? null : new Date(d).toISOString();
}

// Backend-owned available actions (directive §8.8 / §20-action-availability).
export function talentIntakeActions(row: TalentIntakeDraftRow): string[] {
  const actions: string[] = [];
  const terminal =
    row.processing_status === 'READY' ||
    row.processing_status === 'PARTIAL' ||
    row.processing_status === 'FAILED';
  const promoted = row.promoted_talent_record_id !== null;
  if (!promoted) {
    actions.push('edit_draft');
    if (row.processing_status === 'FAILED' || row.processing_status === 'PARTIAL') {
      actions.push('retry_extraction');
    }
    if (terminal) {
      actions.push('promote_to_talent');
    }
  }
  return actions;
}

export function toTalentIntakeDraftView(row: TalentIntakeDraftRow): TalentIntakeDraftView {
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
    actions: talentIntakeActions(row),
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
  };
}
