import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  RequisitionRepository,
  RequisitionEmbeddingRepository,
  type RequisitionSearchRow,
  type RequisitionSemanticMatch,
} from '@aramo/requisition';
import { EMBEDDING_PORT, type EmbeddingPort } from '@aramo/ai-draft';

import type {
  SearchAuthorityContext,
  SearchHit,
  SearchMatchSignal,
} from '../enterprise-search.port.js';
import type { SearchEntityAdapter } from '../search-entity-adapter.js';
import { EmbeddingProcessingConfig } from '../../embedding/embedding-processing.config.js';

// Parse an exact requisition reference: "REQ-1042", "REQ1042", or a bare "1042".
const REFERENCE_RE = /^\s*(?:REQ-?)?(\d{1,9})\s*$/i;

const RELEVANCE_EXACT = 1;
const RELEVANCE_LEXICAL = 0.7;
const POSITION_STEP = 0.001;

// Signal precedence for one-hit-per-record dedupe: exact > lexical > semantic.
const SIGNAL_RANK: Record<SearchMatchSignal, number> = { exact: 0, lexical: 1, semantic: 2 };

// Enterprise Search (GS-1 + GS-2B) — the Requisition adapter. Requisition is a visibility-set domain:
// every leg (exact-number, title/description lexical, and the GS-2B semantic vector leg) passes the
// RESOLVED visibility into the repository / the OR-union-co-located vector SQL, so no leg widens
// authority. Terminal Requisitions stay eligible (no lifecycle-state filter). Hits are lean (no
// commercial fields). The semantic leg is DARK-gated + FAIL-SOFT: any failure is swallowed with a
// warning so exact + lexical always return unchanged (the GS-1 stability invariant).
@Injectable()
export class RequisitionSearchAdapter implements SearchEntityAdapter {
  readonly entity_type = 'REQUISITION' as const;
  readonly required_scope = 'requisition:search';

  private readonly logger = new Logger(RequisitionSearchAdapter.name);

  constructor(
    private readonly repo: RequisitionRepository,
    @Inject(EMBEDDING_PORT) private readonly embedding: EmbeddingPort,
    private readonly embeddingRepo: RequisitionEmbeddingRepository,
    private readonly embeddingConfig: EmbeddingProcessingConfig,
  ) {}

  async search(query: string, authority: SearchAuthorityContext, limit: number): Promise<SearchHit[]> {
    const q = query.trim();
    if (q === '') return [];
    const { tenant_id, visibility, site_id } = authority;

    const refMatch = REFERENCE_RE.exec(q);
    const requisitionNumber = refMatch ? Number(refMatch[1]) : null;

    const [exactRows, lexicalRows] = await Promise.all([
      requisitionNumber !== null
        ? this.repo.searchByReferenceForActor({ tenant_id, visibility, site_id, requisition_number: requisitionNumber, limit })
        : Promise.resolve<RequisitionSearchRow[]>([]),
      this.repo.searchLexicalForActor({ tenant_id, visibility, site_id, q, limit }),
    ]);

    const byId = new Map<string, SearchHit>();
    const mergeRow = (row: RequisitionSearchRow, signal: SearchMatchSignal, relevance: number, field: string): void =>
      this.merge(byId, row.id, this.toHit(row.id, row.title, row.requisition_number, row.city, row.state, signal, relevance, field), signal, relevance, field);

    exactRows.forEach((row) => mergeRow(row, 'exact', RELEVANCE_EXACT, 'requisition_number'));
    lexicalRows.forEach((row, i) => mergeRow(row, 'lexical', RELEVANCE_LEXICAL - i * POSITION_STEP, 'title'));

    // GS-2B semantic leg — dark-gated + fail-soft; visibility co-located in the vector SQL.
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
      const matches: RequisitionSemanticMatch[] = await this.embeddingRepo.searchSemanticForActor({
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
          m.requisition_id,
          this.toHit(m.requisition_id, m.title, m.requisition_number, m.city, m.state, 'semantic', relevance, 'semantic'),
          'semantic',
          relevance,
          'semantic',
        );
      }
    } catch (err) {
      // Fail-soft: any semantic-leg failure must NEVER regress exact/lexical.
      this.logger.warn(
        `requisition semantic leg skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // One hit per requisition: keep the highest-precedence signal (exact > lexical > semantic) and that
  // signal's relevance; same-band → max relevance.
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
    title: string,
    requisitionNumber: number,
    city: string | null,
    state: string | null,
    signal: SearchMatchSignal,
    relevance: number,
    field: string,
  ): SearchHit {
    const location = [city, state].filter((p): p is string => !!p).join(', ');
    const parts = [`REQ-${requisitionNumber}`, location || null].filter((p): p is string => !!p);
    return {
      entity_type: 'REQUISITION',
      entity_id: id,
      display_label: title,
      subtitle: parts.length > 0 ? parts.join(' · ') : null,
      snippet: null,
      route: `/requisitions/${id}`,
      match: { signal, relevance, field },
    };
  }
}
