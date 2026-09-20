import type { TalentResumeEditionWithDocumentRow } from '@aramo/talent-extraction';

// TALENT-INTEL-1 TI-1D-C — the résumé-edition read model. filename / mime_type /
// uploaded_at are PROJECTED from the mandatory TalentDocument join (file_type ←
// mime_type, ingestion_at ← uploaded_at — ruling E: derive, never store on the
// edition). is_default is the presentation default (NOT "newest = truth").
export interface TalentResumeEditionView {
  edition_id: string;
  talent_document_id: string;
  attachment_id: string | null;
  purpose: string;
  label: string | null;
  lifecycle_status: string;
  created_at: string;
  filename: string;
  mime_type: string;
  uploaded_at: string;
  is_default: boolean;
  // TALENT-INTEL-1 (TI-1F-A) — the governed-extraction lifecycle for this
  // edition, DERIVED from its ResumeExtractionDraft (no new source of truth):
  // PROCESSING | READY_FOR_REVIEW | ACCEPTED | REJECTED | FAILED, or null for an
  // edition with no draft (created before TI-1F-A). READ-ONLY projection.
  processing_status: string | null;
}

export interface TalentResumeEditionsResponse {
  talent_id: string;
  editions: TalentResumeEditionView[];
}

export function toResumeEditionView(
  row: TalentResumeEditionWithDocumentRow,
): TalentResumeEditionView {
  return {
    edition_id: row.id,
    talent_document_id: row.talent_document_id,
    attachment_id: row.attachment_id,
    purpose: row.purpose,
    label: row.label,
    lifecycle_status: row.lifecycle_status,
    created_at: row.created_at.toISOString(),
    filename: row.document_filename,
    mime_type: row.document_mime_type,
    uploaded_at: row.document_uploaded_at.toISOString(),
    is_default: row.is_default,
    processing_status: row.processing_status,
  };
}
