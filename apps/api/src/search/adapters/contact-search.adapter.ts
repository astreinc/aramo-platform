import { Injectable } from '@nestjs/common';
import { ContactRepository, type ContactSearchRow } from '@aramo/contact';

import type { SearchAuthorityContext, SearchHit } from '../enterprise-search.port.js';
import type { SearchEntityAdapter } from '../search-entity-adapter.js';

const RELEVANCE_LEXICAL = 0.7;
const POSITION_STEP = 0.001;

// Enterprise Search (GS-1) — the Contact adapter. Contact is a visibility-set domain; the
// adapter passes the RESOLVED visibility into the repository's visibility-aware read (it never
// recreates the company_id ∈ visible_client_ids rule). Contact domain reads support only
// substring name/title lexical search — no exact-identity search — so every hit is lexical
// (no invented exact/email authority path). The hit is PII-conservative: it exposes NO
// email/phone. Navigation targets the contact's company (no contact detail route exists).
@Injectable()
export class ContactSearchAdapter implements SearchEntityAdapter {
  readonly entity_type = 'CONTACT' as const;
  readonly required_scope = 'contact:search';

  constructor(private readonly repo: ContactRepository) {}

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
    // One visibility-filtered query; each contact appears once (dedupe inherent).
    return rows.map((row, i) => this.toHit(row, RELEVANCE_LEXICAL - i * POSITION_STEP));
  }

  private toHit(row: ContactSearchRow, relevance: number): SearchHit {
    return {
      entity_type: 'CONTACT',
      entity_id: row.id,
      display_label: `${row.first_name} ${row.last_name}`.trim(),
      subtitle: row.title,
      snippet: null,
      route: `/companies/${row.company_id}`,
      match: { signal: 'lexical', relevance, field: 'name' },
    };
  }
}
