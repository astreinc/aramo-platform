import type { ActiveEducationEntryRow } from '@aramo/talent-evidence';

import type { EducationRow } from './talent-360.ports.js';

// ATS-QA-1 I-4 — the one mapping from a current TalentEducationEntry row to the
// wire shape, shared by the Talent 360 read and the education write responses so
// both always return the same entry shape.
export function toEducationRow(r: ActiveEducationEntryRow): EducationRow {
  return {
    id: r.id,
    institution_name: r.institution_name,
    degree_name: r.degree_name,
    field_of_study: r.field_of_study,
    conferred_date: r.conferred_date === null ? null : r.conferred_date.toISOString().slice(0, 10),
    source: r.source,
    source_document_id: r.source_document_id,
    source_refs: [...r.source_refs],
    corrects_entry_id: r.corrects_entry_id,
    recorded_at: r.created_at.toISOString(),
  };
}
