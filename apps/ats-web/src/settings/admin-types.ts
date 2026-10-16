// Settings Rebuild Directive 1 — hand-mirrored read shapes for the Import +
// Export live sections.
//
// ats-web stays a leaf consumer of the HTTP surface (the no-@aramo/* import
// rule): these re-declare the public View DTOs that libs/import and libs/export
// own. If a backend field lands, this file follows in lock-step at the next FE
// PR that binds it.

import { codeLabel } from '../ui/code-label';

// Mirror of libs/import dto/import-batch.view.ts (ImportBatchView).
export type ImportTargetEntity =
  | 'talent_record'
  | 'company'
  | 'contact'
  | 'requisition';

export type ImportBatchStatus =
  | 'pending'
  | 'committed'
  | 'partial'
  | 'failed'
  | 'reverted';

export interface ImportBatchView {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string | null;
  readonly imported_by_id: string;
  readonly target_entity: ImportTargetEntity;
  readonly source_filename: string;
  readonly row_count: number;
  readonly success_count: number;
  readonly failure_count: number;
  readonly status: ImportBatchStatus;
  readonly created_at: string;
  readonly committed_at: string | null;
  readonly reverted_at: string | null;
}

// Mirror of libs/import dto/import-batch.view.ts (ImportFailureView).
export interface ImportFailureView {
  readonly id: string;
  readonly tenant_id: string;
  readonly import_batch_id: string;
  readonly row_number: number;
  readonly failure_reason: string;
  readonly offending_fields: readonly string[];
  readonly original_row_data: Record<string, unknown>;
  readonly created_at: string;
}

// Mirror of libs/export field-catalog.ts (ExportEntityType) — the 5 R10-bounded
// ATS entities exported as CSV.
export type ExportEntityType =
  | 'company'
  | 'contact'
  | 'requisition'
  | 'talent_record'
  | 'pipeline';

export const EXPORT_ENTITIES: readonly {
  readonly type: ExportEntityType;
  readonly label: string;
  readonly description: string;
}[] = [
  { type: 'talent_record', label: 'Talent', description: 'Talent records (ATS fields only).' },
  { type: 'requisition', label: 'Requisitions', description: 'Open and historical job orders.' },
  { type: 'company', label: 'Companies', description: 'Client accounts.' },
  { type: 'contact', label: 'Contacts', description: 'Client-side people.' },
  { type: 'pipeline', label: 'Pipeline', description: 'Talent–requisition pipeline rows.' },
];

export const IMPORT_ENTITY_LABEL: Record<ImportTargetEntity, string> = {
  talent_record: 'Talent',
  company: 'Companies',
  contact: 'Contacts',
  requisition: 'Requisitions',
};

// ImportFailure.failure_reason is EITHER a bounded token (libs/import requisition-import
// mapper failure tokens, or an AramoError code / IMPORT_ERROR from the requisition writer)
// OR server-composed human text ("missing required field(s): title"). Tokens map (unknown
// tokens degrade to sentence case); human text renders as written.
export const IMPORT_FAILURE_REASON_LABELS: Readonly<Record<string, string>> = {
  INVALID_EXTERNAL_IDENTITY: 'Invalid source system or external requisition ID',
  MISSING_REQUIRED_FIELD: 'Missing a required field',
  INVALID_OPENINGS: 'Invalid number of openings',
  UNSUPPORTED_LIFECYCLE_STATUS: 'Unsupported status',
  GATED_STATUS_NOT_IMPORTABLE: 'This status cannot be imported',
  UNSUPPORTED_FIELD: 'Unsupported field',
  INVALID_COMMERCIAL_VALUE: 'Invalid bill rate',
  INVALID_DATE: 'Invalid date',
  IMPORT_ERROR: 'Could not import this row',
};
const IMPORT_FAILURE_TOKEN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
export function importFailureReasonLabel(reason: string): string {
  const t = reason.trim();
  return IMPORT_FAILURE_TOKEN.test(t) ? codeLabel(IMPORT_FAILURE_REASON_LABELS, t) : reason;
}
