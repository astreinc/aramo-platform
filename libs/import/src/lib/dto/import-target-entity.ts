// PR-A8-1 — the 4 ATS targets the engine can import into. Mirrors the
// `ImportTargetEntity` PG enum in the prisma schema. Vocabulary-locked
// per R12 — the canonical Aramo terms only (talent_record / requisition).

export const IMPORT_TARGET_ENTITY_VALUES = [
  'company',
  'contact',
  'requisition',
  'talent_record',
] as const;

export type ImportTargetEntity = (typeof IMPORT_TARGET_ENTITY_VALUES)[number];

export function isImportTargetEntity(v: unknown): v is ImportTargetEntity {
  return (
    typeof v === 'string' &&
    (IMPORT_TARGET_ENTITY_VALUES as readonly string[]).includes(v)
  );
}

// ImportBatchStatus mirrors the PG enum.
export const IMPORT_BATCH_STATUS_VALUES = [
  'pending',
  'committed',
  'partially_committed',
  'rejected',
  'reverted',
] as const;

export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUS_VALUES)[number];
