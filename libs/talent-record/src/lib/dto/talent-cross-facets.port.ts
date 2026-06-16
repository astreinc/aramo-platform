import type { NativeFacetBucket } from './talent-search.dto.js';

// Segment 4b — cross-schema facet COUNTS (full-set) + the materialize guard.
//
// The counts themselves are COMPOSED in apps/api (the only layer permitted to
// read activity / consent / pipeline) by a global interceptor: the lib
// controller stashes the parsed TalentSearchQuery on the request, the
// interceptor runs the Seg-3 batch accessors over the FULL filtered key set
// (resolve-then-filter, never a cross-schema join), bounded by the guard, and
// merges this shape onto the paged response. The lib only carries the result
// SHAPE (single-schema-clean) — it imports none of the cross-schema modules.

export interface CrossFacets {
  // true when the matched set exceeds the materialize guard → counts are not
  // computed (the UI asks the user to narrow filters). `matched` is capped at
  // guard+1 when over.
  readonly over_guard: boolean;
  readonly matched: number;
  readonly guard: number;
  // recency bucket counts mirror the FE (today | 7d | 30d | stale).
  readonly recency: Readonly<Record<string, number>>;
  readonly consent: readonly NativeFacetBucket[];
  readonly stage: readonly NativeFacetBucket[];
}
