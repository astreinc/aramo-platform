import type { ResumeEditionSummary } from '../resume-edition-reader.port.js';

// TALENT-INTEL-1 TI-1D-D — the résumé-edition state for a Talent×requisition,
// resolved through the Pipeline aggregate. Distinguishes the EXPLICIT working
// selection (Layer A), the Talent-global default (a SUGGESTION only — never
// authoritative for a requisition), and the ACTIVE editions the recruiter may
// newly select.
export interface PipelineResumeEditionAvailable {
  edition_id: string;
  purpose: string;
  label: string | null;
  filename: string;
  mime_type: string;
  created_at: string;
  is_default: boolean;
}

export interface PipelineResumeEditionView {
  pipeline_id: string;
  talent_record_id: string;
  requisition_id: string;
  // The explicit working selection for THIS requisition; null when the recruiter
  // has never selected an edition (the default is only a suggestion, not a binding).
  selected_edition_id: string | null;
  selected_at: string | null;
  selected_by: string | null;
  // The Talent-global presentation default — a suggestion only.
  default_edition_id: string | null;
  // Editions eligible for a NEW selection (lifecycle=active).
  available_editions: PipelineResumeEditionAvailable[];
}

export function toAvailable(e: ResumeEditionSummary): PipelineResumeEditionAvailable {
  return {
    edition_id: e.edition_id,
    purpose: e.purpose,
    label: e.label,
    filename: e.filename,
    mime_type: e.mime_type,
    created_at: e.created_at,
    is_default: e.is_default,
  };
}
