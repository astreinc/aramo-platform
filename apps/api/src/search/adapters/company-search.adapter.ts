import { Injectable } from '@nestjs/common';
import { CompanyRepository, type CompanySearchRow } from '@aramo/company';

import type {
  SearchAuthorityContext,
  SearchHit,
  SearchMatchSignal,
} from '../enterprise-search.port.js';
import type { SearchEntityAdapter } from '../search-entity-adapter.js';

const RELEVANCE_EXACT = 1;
const RELEVANCE_LEXICAL = 0.7;
const POSITION_STEP = 0.001;

// Enterprise Search (GS-1) — the Company adapter. Company is a visibility-set domain; the
// adapter passes the RESOLVED visibility into the repository's visibility-aware read (it
// never recreates the id ∈ visible_client_ids rule). One query returns each authorized
// company once (dedupe inherent); an exact name match is tagged as an 'exact' retrieval
// signal derived from those already-authorized rows — never a separate authority path. Hits
// are lean (no commercial fields).
@Injectable()
export class CompanySearchAdapter implements SearchEntityAdapter {
  readonly entity_type = 'COMPANY' as const;
  readonly required_scope = 'company:search';

  constructor(private readonly repo: CompanyRepository) {}

  async search(query: string, authority: SearchAuthorityContext, limit: number): Promise<SearchHit[]> {
    const q = query.trim();
    if (q === '') return [];
    const rows = await this.repo.searchLexicalForActor({
      tenant_id: authority.tenant_id,
      visibility: authority.visibility,
      site_id: authority.site_id,
      q,
      limit,
    });
    const qLower = q.toLowerCase();
    return rows.map((row, i) => {
      const exact = row.name.toLowerCase() === qLower;
      const signal: SearchMatchSignal = exact ? 'exact' : 'lexical';
      const relevance = exact ? RELEVANCE_EXACT : RELEVANCE_LEXICAL - i * POSITION_STEP;
      return this.toHit(row, signal, relevance);
    });
  }

  private toHit(row: CompanySearchRow, signal: SearchMatchSignal, relevance: number): SearchHit {
    return {
      entity_type: 'COMPANY',
      entity_id: row.id,
      display_label: row.name,
      subtitle: this.subtitle(row),
      snippet: null,
      route: `/companies/${row.id}`,
      match: { signal, relevance, field: 'name' },
    };
  }

  private subtitle(row: CompanySearchRow): string | null {
    const location = [row.city, row.state].filter((p): p is string => !!p).join(', ');
    const parts = [row.industry, location || null].filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join(' · ') : null;
  }
}
