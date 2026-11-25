// TEMPLATE-IMPORT-1 (Aramo-Template-Word-Import-Directive-v1_1-LOCKED) — the limits, refusal
// reasons and warning codes of the Word import. Stable: the console and the OpenAPI contract
// read the same codes.

/** W-1 — the import route; main.ts mounts a route-scoped JSON parser with this limit for it ONLY. */
export const WORD_IMPORT_ROUTE = '/platform/document-templates/:id/versions/import';
/** A 10 MB .docx is ~13.4 MB as base64 (the fixed-form PDF upload precedent). */
export const WORD_IMPORT_MAX_BODY = '15mb';

// W-2 — file safety.
export const WORD_IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const WORD_IMPORT_MAX_ZIP_ENTRIES = 2000;
export const WORD_IMPORT_MAX_UNZIPPED_BYTES = 50 * 1024 * 1024;
export const WORD_IMPORT_TIMEOUT_MS = 20_000;
export const WORD_IMPORT_FILENAME_MAX = 255;

/** §3.1 — refusal reasons (details.reason). */
export const WORD_IMPORT_REFUSALS = [
  'import_not_editable',
  'import_file_type',
  'import_macros',
  'import_encrypted',
  'import_too_large',
  'import_too_many_entries',
  'import_unzipped_too_large',
  'import_timeout',
  'import_unreadable',
  'draft_exists',
] as const;
export type WordImportRefusal = (typeof WORD_IMPORT_REFUSALS)[number];

/** §3.2 — warning codes (one per kind of element that was dropped, split, lifted or flattened). */
export const WORD_IMPORT_WARNINGS = [
  'heading_level_merged',
  'list_level_lifted',
  'table_cells_unmerged',
  'table_flattened',
  'table_split',
  'image_dropped',
  'text_box_dropped',
  'note_dropped',
  'comment_dropped',
  'header_footer_dropped',
] as const;
export type WordImportWarningCode = (typeof WORD_IMPORT_WARNINGS)[number];

export interface WordImportWarning {
  readonly code: WordImportWarningCode;
  readonly count: number;
  /** A short example of the affected text (never more than 60 characters), when there is one. */
  readonly example?: string;
}

/** A refusal raised by the import pipeline; the controller turns it into a 422 / 409. */
export class WordImportRefusedError extends Error {
  constructor(
    readonly reason: WordImportRefusal,
    readonly details: Readonly<Record<string, string | number>> = {},
  ) {
    super(`Word import refused: ${reason}`);
    this.name = 'WordImportRefusedError';
  }
}
