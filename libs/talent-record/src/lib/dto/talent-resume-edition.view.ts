import type { TalentResumeEditionWithDocumentRow } from '@aramo/talent-extraction';

// TALENT-INTEL-1 TI-1D-C — the resume-edition read model. filename / mime_type /
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
  // Resume Revision Lifecycle §2/§10 — the per-lineage revision ordinal (Revision
  // 1, 2, 3…), DERIVED at read time from created_at order (D-3 PO ruling: NOT a
  // stored column). null only on a single-row path with no list context.
  revision_number: number | null;
  // Resume Revision Lifecycle §3 — the AUTHORITATIVE requisition/client the
  // revision was tailored for (null for a general revision). Never inferred from
  // filename or contents; the recruiter/requisition-context upload sets it.
  requisition_id: string | null;
  client_context_id: string | null;
  // Resume Revision Lifecycle §3 — lineage: the edition this one was derived from.
  derived_from_edition_id: string | null;
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

// TALENT-INTEL-1 TI-1H §9 — per-edition resume text (preview). Reading edition R
// returns R's OWN redacted text — never another edition's. redacted_text is null
// while the async re-extract is pending/failed (status carries which). Only
// redacted text is ever exposed (D4 — raw resume text is never returned).
export interface TalentResumeEditionTextView {
  talent_id: string;
  edition_id: string;
  status: string;
  redacted_text: string | null;
  extracted_at: string | null;
}

export function toResumeEditionView(
  row: TalentResumeEditionWithDocumentRow,
  revisionNumber: number | null = null,
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
    revision_number: revisionNumber,
    requisition_id: row.requisition_id,
    client_context_id: row.client_context_id,
    derived_from_edition_id: row.derived_from_edition_id,
    processing_status: row.processing_status,
  };
}

// Resume Revision Lifecycle §2/§10 — the per-lineage revision ordinals, DERIVED
// (D-3 PO ruling: not stored). Editions are ranked oldest→newest by created_at so
// the first upload is "Revision 1"; a stable tiebreak on id keeps equal instants
// deterministic. Returns a Map(edition_id → ordinal).
function revisionOrdinals(
  rows: readonly TalentResumeEditionWithDocumentRow[],
): Map<string, number> {
  const ascending = [...rows].sort((a, b) => {
    const delta = a.created_at.getTime() - b.created_at.getTime();
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
  const ordinals = new Map<string, number>();
  ascending.forEach((row, index) => ordinals.set(row.id, index + 1));
  return ordinals;
}

// The derived revision ordinal for ONE edition, given its sibling list.
export function revisionOrdinalOf(
  rows: readonly TalentResumeEditionWithDocumentRow[],
  editionId: string,
): number | null {
  return revisionOrdinals(rows).get(editionId) ?? null;
}

// List-aware mapper: projects the whole collection WITH derived revision ordinals.
export function toResumeEditionViews(
  rows: readonly TalentResumeEditionWithDocumentRow[],
): TalentResumeEditionView[] {
  const ordinals = revisionOrdinals(rows);
  return rows.map((row) => toResumeEditionView(row, ordinals.get(row.id) ?? null));
}
