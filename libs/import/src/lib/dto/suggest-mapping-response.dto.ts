import type { FieldType } from '../mapping/field-catalog.js';

import type { ImportTargetEntity } from './import-target-entity.js';

// PR-A8-2 — response from POST /v1/imports/suggest-mapping.
//
// Per-target-field: which CSV column the heuristic suggests, plus
// confidence + reason so the user (and the UI) can judge whether to
// accept. Required fields with no match are flagged via the
// `unmatched_required_fields` convenience list — the UI must require
// the user to map these (or supply them out-of-band, e.g. company_id)
// before the import can run.

export type MappingConfidence = 'high' | 'medium' | 'low' | 'none';

// `synonym`     — the header matched the field by name or alias.
// `data-shape`  — the column's sampled VALUES matched the field's
//                  expected type (email/phone/date/etc).
// `unmatched`   — no signal; the user must map the field manually or
//                 leave it unmapped (optional fields) / supply out-of-
//                 band (required FK fields).
export type MappingReason = 'synonym' | 'data-shape' | 'unmatched';

export interface SuggestedFieldMapping {
  field: string;
  suggested_source_column: string | null;
  confidence: MappingConfidence;
  reason: MappingReason;
}

export interface FieldReferenceDoc {
  field: string;
  type: FieldType;
  required: boolean;
  example: string;
  accepted_synonyms: string[];
}

export interface SourceColumnSamples {
  source_column: string;
  sample_values: Array<string | null>;
}

export interface SuggestMappingResponseDto {
  target_entity: ImportTargetEntity;
  // Per-target-field suggestion (catalog order — stable).
  suggestions: SuggestedFieldMapping[];
  // Convenience: required fields whose suggestion is `unmatched`. The
  // UI should require the user to resolve each one.
  unmatched_required_fields: string[];
  // Per-target-field metadata — type, required?, example, synonyms.
  // The PO's correction #1 (the suggest/confirm contract carries the
  // reference docs alongside the suggestion).
  reference_docs: FieldReferenceDoc[];
  // Per-source-column sample values (clipped). The PO's correction
  // #1 — the response carries samples so the UI shows the user the
  // ACTUAL values under each column next to the field it's suggested
  // to map to.
  samples: SourceColumnSamples[];
  // Echo of DATA_SHAPE_THRESHOLD — surfaced so the UI can tell the
  // user "data-shape confidence requires ≥ 50% of sampled values to
  // match the pattern."
  data_shape_threshold: number;
}
