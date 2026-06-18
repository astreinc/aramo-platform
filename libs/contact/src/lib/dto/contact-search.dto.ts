import type { ContactView } from './contact.view.js';

// Contact-spec amendment v1.0 — the native server-side faceted-search contract
// for contacts. Mirrors libs/company's CompanySearchQuery/Page EXACTLY (filter +
// sort + KEYSET cursor + facet COUNTS, single-schema against Contact columns
// only). The D4b visibility predicate is applied alongside (company_id IN
// visible_client_ids) exactly as listForActor does — and the "My contacts"
// scope narrows by owner_id, resolved SERVER-SIDE from the JWT (never a client
// filter over an all-contacts payload).
//
// Facet counts + `total` are computed over the BASE where (tenant + site + q +
// owner scope + visibility) — independent of the relationship_role/preference/
// company/flag SELECTIONS — so the facet-rail counts stay stable as the operator
// toggles filters. The page `items` are narrowed by the full selection set.

export type ContactSortKey = 'name' | 'created_at' | 'last_activity';
export type SortDir = 'asc' | 'desc';

export interface ContactFacetBucket {
  readonly value: string;
  readonly count: number;
}

export interface ContactFacets {
  readonly relationship_role: readonly ContactFacetBucket[];
  readonly preference: readonly ContactFacetBucket[];
  readonly company: readonly ContactFacetBucket[]; // value = company_id
  readonly hot: number;
  readonly quiet: number; // last_activity_at older than QUIET_DAYS, or never
  readonly former: number; // left_company
}

export interface ContactSearchQuery {
  readonly tenant_id: string;
  readonly site_id?: string;
  // filters (all native, single-schema)
  readonly q?: string; // first/last name ILIKE
  readonly owner_id?: string; // scope=mine → the actor's own contacts (server-derived)
  readonly relationship_role?: readonly string[];
  readonly preference?: readonly string[];
  readonly company_id?: readonly string[];
  readonly is_hot?: boolean;
  readonly quiet?: boolean; // going-quiet segment (>= QUIET_DAYS, or never)
  readonly former?: boolean; // include left-company contacts (default: excluded)
  // Cold-call queue — contactable (preference != do_not_contact) AND a work
  // phone present. Combined with sort=last_activity dir=asc this IS the
  // "who haven't I spoken to longest" queue. A REAL server filter (the
  // amendment added last_activity_at precisely so this need not be a seam).
  readonly cold_callable?: boolean;
  // sort + keyset cursor
  readonly sort?: ContactSortKey;
  readonly dir?: SortDir;
  readonly cursor?: string; // opaque (last row id, base64url)
  readonly page_size?: number;
}

export interface ContactSearchPage {
  readonly items: readonly ContactView[];
  readonly next_cursor: string | null;
  readonly facets: ContactFacets;
  // Full-set count over the base where (scope + q) — the "of M" in "N of M".
  readonly total: number;
}

// Contact quiet threshold — contacts cool faster than company accounts; the
// mockup's "Going quiet 14d+" segment sets this at 14 days (cf. company's 30).
export const QUIET_DAYS = 14;
