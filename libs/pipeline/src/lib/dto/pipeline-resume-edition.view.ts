import type { ResumeEditionSummary } from '../resume-edition-reader.port.js';

// TALENT-INTEL-1 TI-1D-D — the resume-edition state for a Talent×requisition,
// resolved through the Pipeline aggregate. Distinguishes the EXPLICIT working
// selection (Layer A), the Talent-global default (a SUGGESTION only — never
// authoritative for a requisition), and the ACTIVE editions the recruiter may
// newly select.
export interface PipelineResumeEditionAvailable {
  edition_id: string;
  purpose: string;
  label: string | null;
  // Resume Revision Lifecycle §3/§5 — the requisition this edition was tailored
  // for (null = general). The FE labels "Tailored for this requisition" when it
  // equals the panel's requisition_id, else "General resume".
  requisition_id: string | null;
  // Resume Revision Lifecycle §2/§10 — the per-lineage revision ordinal (Revision
  // 1,2,3…), DERIVED from created_at order across ALL of the Talent's editions.
  revision_number: number | null;
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
  // Resume Revision Lifecycle §9 — the lifecycle of the CURRENT working selection
  // ('active' | 'archived' | 'retracted'), or null when nothing is selected.
  selected_lifecycle_status: string | null;
  // Resume Revision Lifecycle §9 — true when an edition IS selected for this
  // requisition but is no longer active (archived/retracted). The requisition
  // panel surfaces "Resume requires attention · Choose resume"; the system never
  // silently switches to another edition — the recruiter owns the client-facing
  // choice. False when there is no selection or the selection is active.
  selected_requires_attention: boolean;
  // Editions eligible for a NEW selection (lifecycle=active).
  available_editions: PipelineResumeEditionAvailable[];
}

export function toAvailable(
  e: ResumeEditionSummary,
  revisionNumber: number | null = null,
): PipelineResumeEditionAvailable {
  return {
    edition_id: e.edition_id,
    purpose: e.purpose,
    label: e.label,
    requisition_id: e.requisition_id,
    revision_number: revisionNumber,
    filename: e.filename,
    mime_type: e.mime_type,
    created_at: e.created_at,
    is_default: e.is_default,
  };
}

// Resume Revision Lifecycle §2/§10 — per-lineage revision ordinals (Revision
// 1,2,3…), DERIVED from created_at order across ALL of the Talent's editions
// (active AND archived, so numbering is stable as editions are archived).
// Returns a Map(edition_id → ordinal). Deterministic id tiebreak for equal
// instants.
export function revisionOrdinals(
  editions: readonly ResumeEditionSummary[],
): Map<string, number> {
  const ascending = [...editions].sort((a, b) => {
    const delta = Date.parse(a.created_at) - Date.parse(b.created_at);
    return delta !== 0 ? delta : a.edition_id.localeCompare(b.edition_id);
  });
  const ordinals = new Map<string, number>();
  ascending.forEach((e, index) => ordinals.set(e.edition_id, index + 1));
  return ordinals;
}

// Resume Revision Lifecycle §5 — the eligible (active) editions a recruiter may
// newly select, ORDERED for the requisition picker:
//   1) the revision(s) tailored for THIS requisition (most recent first),
//   2) the general revisions (requisition_id == null), most recent first,
//   3) other active revisions (tailored for a DIFFERENT requisition), recent first.
// Archived/retracted are excluded entirely (never offered for new selection, §8).
// We never auto-select another requisition's tailored resume merely because it is
// newer (§5) — this only ORDERS; selection stays an explicit recruiter act.
export function orderedAvailableEditions(
  editions: readonly ResumeEditionSummary[],
  currentRequisitionId: string,
): PipelineResumeEditionAvailable[] {
  const ordinals = revisionOrdinals(editions);
  const tierOf = (e: ResumeEditionSummary): number => {
    if (e.requisition_id === currentRequisitionId) return 0;
    if (e.requisition_id === null) return 1;
    return 2;
  };
  return editions
    .filter((e) => e.lifecycle_status === 'active')
    .sort((a, b) => {
      const byTier = tierOf(a) - tierOf(b);
      if (byTier !== 0) return byTier;
      return Date.parse(b.created_at) - Date.parse(a.created_at); // recent first
    })
    .map((e) => toAvailable(e, ordinals.get(e.edition_id) ?? null));
}
