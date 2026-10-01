import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CompanyRepository,
  CompanyEmbeddingRepository,
  type CompanySearchRow,
  type CompanySemanticMatch,
} from '@aramo/company';
import { EMBEDDING_PORT, type EmbeddingPort } from '@aramo/ai-draft';

import type {
  SearchAuthorityContext,
  SearchHit,
  SearchMatchSignal,
} from '../enterprise-search.port.js';
import type { SearchEntityAdapter } from '../search-entity-adapter.js';
import { EmbeddingProcessingConfig } from '../../embedding/embedding-processing.config.js';

const RELEVANCE_EXACT = 1;
const RELEVANCE_LEXICAL = 0.7;
const POSITION_STEP = 0.001;

// Signal precedence for one-hit-per-record dedupe: exact > lexical > semantic.
const SIGNAL_RANK: Record<SearchMatchSignal, number> = { exact: 0, lexical: 1, semantic: 2 };

// Enterprise Search (GS-1 + GS-2C) — the Company adapter. Company is a visibility-set domain; every
// leg (exact-name/lexical via the repo, and the GS-2C semantic vector leg) passes the RESOLVED
// visibility into the repository / the co-located vector SQL (see_all_company OR id ∈
// visible_client_ids), so no leg widens authority. Hits are lean (no commercial fields). The semantic
// leg is DARK-gated + FAIL-SOFT: any failure is swallowed with a warning so exact + lexical always
// return unchanged (the GS-1 stability invariant).
@Injectable()
export class CompanySearchAdapter implements SearchEntityAdapter {
  readonly entity_type = 'COMPANY' as const;
  readonly required_scope = 'company:search';

  private readonly logger = new Logger(CompanySearchAdapter.name);

  constructor(
    private readonly repo: CompanyRepository,
    @Inject(EMBEDDING_PORT) private readonly embedding: EmbeddingPort,
    private readonly embeddingRepo: CompanyEmbeddingRepository,
    private readonly embeddingConfig: EmbeddingProcessingConfig,
  ) {}

  async search(query: string, authority: SearchAuthorityContext, limit: number): Promise<SearchHit[]> {
    const q = query.trim();
    if (q === '') return [];
    const qLower = q.toLowerCase();

    const rows = await this.repo.searchLexicalForActor({
      tenant_id: authority.tenant_id,
      visibility: authority.visibility,
      site_id: authority.site_id,
      q,
      limit,
    });

    const byId = new Map<string, SearchHit>();
    rows.forEach((row, i) => {
      const exact = row.name.toLowerCase() === qLower;
      const signal: SearchMatchSignal = exact ? 'exact' : 'lexical';
      const relevance = exact ? RELEVANCE_EXACT : RELEVANCE_LEXICAL - i * POSITION_STEP;
      this.merge(byId, row.id, this.toHit(row.id, row.name, row.industry, row.city, row.state, signal, relevance, 'name'), signal, relevance, 'name');
    });

    // GS-2C semantic leg — dark-gated + fail-soft; visibility co-located in the vector SQL.
    if (this.embeddingConfig.isEnabled()) {
      await this.mergeSemantic(q, authority, limit, byId);
    }

    return [...byId.values()];
  }

  private async mergeSemantic(
    q: string,
    authority: SearchAuthorityContext,
    limit: number,
    byId: Map<string, SearchHit>,
  ): Promise<void> {
    try {
      const embedded = await this.embedding.embed({ tenant_id: authority.tenant_id, text: q });
      const matches: CompanySemanticMatch[] = await this.embeddingRepo.searchSemanticForActor({
        tenant_id: authority.tenant_id,
        visibility: authority.visibility,
        site_id: authority.site_id,
        query_vector: embedded.vector,
        limit,
      });
      for (const m of matches) {
        const relevance = Math.max(0, 1 - m.distance);
        this.merge(
          byId,
          m.company_id,
          this.toHit(m.company_id, m.name, m.industry, m.city, m.state, 'semantic', relevance, 'semantic'),
          'semantic',
          relevance,
          'semantic',
        );
      }
    } catch (err) {
      this.logger.warn(
        `company semantic leg skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private merge(
    byId: Map<string, SearchHit>,
    id: string,
    fresh: SearchHit,
    signal: SearchMatchSignal,
    relevance: number,
    field: string,
  ): void {
    const existing = byId.get(id);
    if (existing === undefined) {
      byId.set(id, fresh);
      return;
    }
    const newBetter = SIGNAL_RANK[signal] < SIGNAL_RANK[existing.match.signal];
    const sameBand = SIGNAL_RANK[signal] === SIGNAL_RANK[existing.match.signal];
    byId.set(id, {
      ...existing,
      match: {
        signal: newBetter ? signal : existing.match.signal,
        relevance: newBetter ? relevance : sameBand ? Math.max(existing.match.relevance, relevance) : existing.match.relevance,
        field: newBetter ? field : existing.match.field,
      },
    });
  }

  private toHit(
    id: string,
    name: string,
    industry: string | null,
    city: string | null,
    state: string | null,
    signal: SearchMatchSignal,
    relevance: number,
    field: string,
  ): SearchHit {
    const location = [city, state].filter((p): p is string => !!p).join(', ');
    const parts = [industry, location || null].filter((p): p is string => !!p);
    return {
      entity_type: 'COMPANY',
      entity_id: id,
      display_label: name,
      subtitle: parts.length > 0 ? parts.join(' · ') : null,
      snippet: null,
      route: `/companies/${id}`,
      match: { signal, relevance, field },
    };
  }
}
