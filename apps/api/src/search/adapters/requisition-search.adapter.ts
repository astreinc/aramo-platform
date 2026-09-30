import { Injectable } from '@nestjs/common';
import { RequisitionRepository, type RequisitionSearchRow } from '@aramo/requisition';

import type {
  SearchAuthorityContext,
  SearchHit,
  SearchMatchSignal,
} from '../enterprise-search.port.js';
import type { SearchEntityAdapter } from '../search-entity-adapter.js';

// Parse an exact requisition reference: "REQ-1042", "REQ1042", or a bare "1042".
const REFERENCE_RE = /^\s*(?:REQ-?)?(\d{1,9})\s*$/i;

// Exact reference outranks any title/description lexical hit (directive §6/§18); the small
// per-position decrement preserves the lexical leg's own source order deterministically.
const RELEVANCE_EXACT = 1;
const RELEVANCE_LEXICAL = 0.7;
const POSITION_STEP = 0.001;

// Enterprise Search (GS-1) — the Requisition adapter. Requisition is a visibility-set domain:
// the adapter passes the RESOLVED visibility straight into the repository's visibility-aware
// reads (it never recreates the A3/D4b rule), so no leg — including exact-number — widens
// authority. Hits are lean (no commercial fields); a requisition matched by more than one leg
// collapses to exactly one hit, exact preferred.
@Injectable()
export class RequisitionSearchAdapter implements SearchEntityAdapter {
  readonly entity_type = 'REQUISITION' as const;
  readonly required_scope = 'requisition:search';

  constructor(private readonly repo: RequisitionRepository) {}

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
    const merge = (row: RequisitionSearchRow, signal: SearchMatchSignal, relevance: number, field: string): void => {
      const existing = byId.get(row.id);
      if (existing === undefined) {
        byId.set(row.id, this.toHit(row, signal, relevance, field));
        return;
      }
      const upgrade = signal === 'exact' && existing.match.signal !== 'exact';
      byId.set(row.id, {
        ...existing,
        match: {
          signal: upgrade ? 'exact' : existing.match.signal,
          relevance: Math.max(existing.match.relevance, relevance),
          field: upgrade ? field : existing.match.field,
        },
      });
    };

    exactRows.forEach((row) => merge(row, 'exact', RELEVANCE_EXACT, 'requisition_number'));
    lexicalRows.forEach((row, i) => merge(row, 'lexical', RELEVANCE_LEXICAL - i * POSITION_STEP, 'title'));

    return [...byId.values()];
  }

  private toHit(row: RequisitionSearchRow, signal: SearchMatchSignal, relevance: number, field: string): SearchHit {
    return {
      entity_type: 'REQUISITION',
      entity_id: row.id,
      display_label: row.title,
      subtitle: this.subtitle(row),
      snippet: null,
      route: `/requisitions/${row.id}`,
      match: { signal, relevance, field },
    };
  }

  private subtitle(row: RequisitionSearchRow): string | null {
    const location = [row.city, row.state].filter((p): p is string => !!p).join(', ');
    const parts = [`REQ-${row.requisition_number}`, location || null].filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join(' · ') : null;
  }
}
