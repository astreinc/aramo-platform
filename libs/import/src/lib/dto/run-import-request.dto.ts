import type { ImportTargetEntity } from './import-target-entity.js';

// PR-A8-1 — input to POST /v1/imports.
//
// A8-1 accepts an ALREADY-CONFIRMED column→field mapping (mapping
// INFERENCE is A8-2, a separate PR). The `mapping` field is a flat
// column → entity-field map applied per-row to produce the entity DTO.
// The `rows` field is the input row set, each row a flat
// column → value map (the CSV reader's per-row hash).
//
// The engine validates field membership against the chosen target's
// schema; an unknown field in the mapping rejects per-row as a
// VALIDATION-failure (recorded in ImportFailure), not as a batch-level
// 400 — keeping malformed mappings off the rejection path so the
// failed-rows artifact remains the canonical "what to fix" surface.

export interface ConfirmedMapping {
  // CSV column name → target entity field name.
  // E.g. for target_entity = 'company':
  //   { 'Company Name': 'name', 'Street': 'address', 'City': 'city' }
  [csvColumn: string]: string;
}

export interface ImportRow {
  // The raw CSV row as a flat column → value map. The mapping is
  // applied per-row to produce the entity DTO.
  [csvColumn: string]: string | number | boolean | null;
}

export interface RunImportRequestDto {
  target_entity: ImportTargetEntity;
  source_filename: string;
  site_id?: string;
  mapping: ConfirmedMapping;
  rows: ImportRow[];
}
