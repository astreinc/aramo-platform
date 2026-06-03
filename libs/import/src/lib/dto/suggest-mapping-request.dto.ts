import type { ImportTargetEntity } from './import-target-entity.js';

// PR-A8-2 — input to POST /v1/imports/suggest-mapping.
//
// A8-2 is a SUGGEST step that feeds A8-1's import. The user uploads
// their CSV in the UI, the UI reads the header row + a handful of
// sample rows, and posts THIS shape to ask "what does this look like
// it maps to?" The response (SuggestMappingResponseDto) carries the
// inferred mapping + per-field reference docs + per-column samples.
//
// The contract is SUGGEST-not-auto-apply (ADR-0015 + the PR-A8-2
// directive §3): A8-2 never runs an import on its own suggestion;
// the user reviews / corrects, and the CONFIRMED mapping is what
// they pass to A8-1's POST /v1/imports.
export interface SuggestMappingRequestDto {
  target_entity: ImportTargetEntity;
  // The CSV's header row, in order. Each entry is the original header
  // string (the response's source_column field echoes it verbatim).
  headers: string[];
  // A handful of sample rows for data-shape inference. The keys are
  // the source-column headers (same strings as `headers`); the values
  // are the raw cell values. The suggestion service samples the first
  // ~10 rows for shape detection — passing more is permitted but
  // ignored beyond that.
  sample_rows: Array<Record<string, string | number | boolean | null>>;
  // Optional site scope — same semantic as POST /v1/imports's
  // site_id: the RolesGuard's @RequireSiteMatch decorator reads it
  // from the query/path; for the suggest endpoint it's a query param.
  site_id?: string;
}
