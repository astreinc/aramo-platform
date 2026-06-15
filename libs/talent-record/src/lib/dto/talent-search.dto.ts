import type { TalentRecordView } from './talent-record.view.js';

// Segment 4 — the native server-side faceted-search contract (single-schema).
// Filter + sort + KEYSET cursor pagination + full-set facet counts all run
// inside libs/talent-record against TalentRecord columns ONLY. Cross-schema
// fields (last_activity / consent / stage) are composed in apps/api (Seg 3
// accessors) — never joined here.

export type TalentSortKey =
  | 'name'
  | 'created_at'
  | 'owner'
  | 'location'
  | 'availability'
  | 'engagement'
  | 'hot';

export type SortDir = 'asc' | 'desc';
export type SkillMatch = 'any' | 'all';

export interface NativeFacetBucket {
  readonly value: string;
  readonly count: number;
}

// Full-set facet COUNTS for the native facets the UI renders (availability /
// engagement / source / hot). Skills counts are NOT here — they stay
// client-side "within loaded" until Skills Taxonomy (Seg-4 ruling).
export interface NativeFacets {
  readonly availability: readonly NativeFacetBucket[];
  readonly engagement: readonly NativeFacetBucket[];
  readonly source: readonly NativeFacetBucket[];
  readonly hot: number;
}

export interface TalentSearchQuery {
  readonly tenant_id: string;
  readonly site_id?: string;
  // filters (all native, single-schema)
  readonly q?: string; // name ILIKE (first/last)
  readonly skills?: readonly string[]; // key_skills ILIKE per term
  readonly skill_match?: SkillMatch;
  readonly availability_status?: readonly string[];
  readonly engagement_type?: readonly string[];
  readonly source?: readonly string[];
  readonly is_hot?: boolean;
  readonly owner_id?: readonly string[];
  readonly location?: string; // city/state ILIKE
  // preset / My-team resolved-ids allowlist (resolve-then-filter; null = none).
  readonly id_allowlist?: readonly string[] | null;
  // sort + keyset cursor
  readonly sort?: TalentSortKey;
  readonly dir?: SortDir;
  readonly cursor?: string; // opaque (the last row id, base64url)
  readonly page_size?: number;
}

export interface TalentSearchPage {
  readonly items: readonly TalentRecordView[];
  readonly next_cursor: string | null;
  readonly facets: NativeFacets;
}
