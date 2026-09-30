import { apiClient } from '@aramo/fe-foundation';

// Enterprise Search GS-1 — the SINGLE client for the unified /v1/search contract. Replaces
// the former per-entity fan-out (searchTalent/searchCompanies/…): the backend orchestrator
// now fans out server-side and returns grouped, authority-safe, lean hits. Both the full
// Search view and the ⌘K palette consume THIS client — one contract, one result shape, one
// authority model (the surfaces differ only in presentation, never in semantics).

export type SearchEntityType = 'TALENT' | 'REQUISITION' | 'COMPANY' | 'CONTACT';

export interface SearchMatch {
  readonly signal: 'exact' | 'lexical';
  readonly field?: string;
  readonly relevance: number;
}

export interface SearchHit {
  readonly entity_type: SearchEntityType;
  readonly entity_id: string;
  readonly display_label: string;
  readonly subtitle: string | null;
  // ts_headline excerpt (may contain <mark>…</mark>); rendered safely, never as raw HTML.
  readonly snippet: string | null;
  readonly route: string;
  readonly match: SearchMatch;
}

export interface SearchGroup {
  readonly entity_type: SearchEntityType;
  readonly hits: readonly SearchHit[];
  // True only when the type was explicitly requested but the actor lacks its search scope.
  readonly unauthorized?: boolean;
}

export interface SearchResults {
  readonly query: string;
  readonly groups: readonly SearchGroup[];
}

export interface EnterpriseSearchOptions {
  readonly entityTypes?: readonly SearchEntityType[];
  readonly limit?: number;
}

export async function enterpriseSearch(
  q: string,
  opts?: EnterpriseSearchOptions,
): Promise<SearchResults> {
  const params = new URLSearchParams({ q });
  if (opts?.entityTypes !== undefined && opts.entityTypes.length > 0) {
    params.set('entity_types', opts.entityTypes.join(','));
  }
  if (opts?.limit !== undefined) {
    params.set('limit', String(opts.limit));
  }
  return apiClient.get<SearchResults>(`/v1/search?${params.toString()}`);
}

// Presentation label per entity type — the recruiter's mental model. Semantics live in the
// backend; this is purely how a group is titled in the UI.
export const ENTITY_LABEL: Record<SearchEntityType, string> = {
  TALENT: 'Talent',
  REQUISITION: 'Requisitions',
  COMPANY: 'Companies',
  CONTACT: 'Contacts',
};
