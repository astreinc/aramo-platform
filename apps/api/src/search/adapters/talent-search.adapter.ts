import { Injectable } from '@nestjs/common';
import { TalentRecordRepository, type TalentRecordView } from '@aramo/talent-record';

import type {
  SearchAuthorityContext,
  SearchHit,
  SearchMatchSignal,
} from '../enterprise-search.port.js';
import type { SearchEntityAdapter } from '../search-entity-adapter.js';

// A conservative email shape — the exact-email leg fires only for an email-shaped query
// (precision; a free-text query never pays for a wasted exact lookup).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Per-leg base relevance. Exact-identifier hits sit above every lexical hit (directive
// §6/§18); within the lexical tier a name match outranks a résumé-body match. The tiny
// per-position decrement preserves each leg's own source order deterministically through
// the orchestrator's relevance-desc sort without relying on sort stability. limit <= 50,
// so the decrements never let one leg's band cross into another's.
const RELEVANCE_EXACT = 1;
const RELEVANCE_NAME = 0.7;
const RELEVANCE_RESUME = 0.5;
const POSITION_STEP = 0.001;

// Enterprise Search (GS-1) — the Talent adapter. Owns Talent's authorized retrieval and
// maps rows to lean SearchHits; the orchestrator owns cross-cutting policy. Talent is
// pool-open, so "authority" is tenant + optional site (no per-record visibility resolver);
// every leg — including exact-email — is bound to that same contract by the repository, so
// no leg widens authority (watch-point 1). A record matched by more than one leg collapses
// to exactly one hit (watch-point 2).
@Injectable()
export class TalentSearchAdapter implements SearchEntityAdapter {
  readonly entity_type = 'TALENT' as const;
  readonly required_scope = 'talent:search';

  constructor(private readonly repo: TalentRecordRepository) {}

  async search(query: string, authority: SearchAuthorityContext, limit: number): Promise<SearchHit[]> {
    const q = query.trim();
    if (q === '') return [];
    const tenant_id = authority.tenant_id;
    const site_id = authority.site_id;

    const [exactRows, nameRows, resumeRows] = await Promise.all([
      EMAIL_RE.test(q)
        ? this.repo.searchByExactEmail({ tenant_id, site_id, email: q, limit })
        : Promise.resolve<TalentRecordView[]>([]),
      this.repo.list({ tenant_id, site_id, q, limit }),
      this.repo.searchByResumeText({ tenant_id, site_id, resume_q: q, limit }),
    ]);

    // Deterministic dedupe — ONE hit per TalentRecord. A record matched by multiple legs
    // keeps the best signal, the max relevance, and (if the résumé leg matched) the
    // ts_headline snippet.
    const byId = new Map<string, SearchHit>();
    const merge = (
      row: TalentRecordView,
      signal: SearchMatchSignal,
      relevance: number,
      field: string,
      snippet: string | null,
    ): void => {
      const existing = byId.get(row.id);
      if (existing === undefined) {
        byId.set(row.id, this.toHit(row, signal, relevance, field, snippet));
        return;
      }
      const upgrade = signal === 'exact' && existing.match.signal !== 'exact';
      byId.set(row.id, {
        ...existing,
        snippet: existing.snippet ?? snippet,
        match: {
          signal: upgrade ? 'exact' : existing.match.signal,
          relevance: Math.max(existing.match.relevance, relevance),
          field: upgrade ? field : existing.match.field,
        },
      });
    };

    exactRows.forEach((row) => merge(row, 'exact', RELEVANCE_EXACT, 'email', null));
    nameRows.forEach((row, i) => merge(row, 'lexical', RELEVANCE_NAME - i * POSITION_STEP, 'name', null));
    resumeRows.forEach((row, i) =>
      merge(row, 'lexical', RELEVANCE_RESUME - i * POSITION_STEP, 'resume_text', row.resume_snippet ?? null),
    );

    return [...byId.values()];
  }

  private toHit(
    row: TalentRecordView,
    signal: SearchMatchSignal,
    relevance: number,
    field: string,
    snippet: string | null,
  ): SearchHit {
    return {
      entity_type: 'TALENT',
      entity_id: row.id,
      display_label: `${row.first_name} ${row.last_name}`.trim(),
      subtitle: this.subtitle(row),
      snippet,
      route: `/talent/${row.id}`,
      match: { signal, relevance, field },
    };
  }

  private subtitle(row: TalentRecordView): string | null {
    const location = [row.city, row.state].filter((p): p is string => !!p).join(', ');
    const parts = [row.title, location || null].filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join(' · ') : null;
  }
}
