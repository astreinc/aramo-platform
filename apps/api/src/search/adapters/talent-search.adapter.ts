import { Inject, Injectable, Logger } from '@nestjs/common';
import { TalentRecordRepository, type TalentRecordView } from '@aramo/talent-record';
import { EMBEDDING_PORT, type EmbeddingPort } from '@aramo/ai-draft';
import {
  TALENT_EMBEDDING_SEARCH_PORT,
  type TalentEmbeddingSearchPort,
} from '@aramo/talent-embedding';

import type {
  SearchAuthorityContext,
  SearchHit,
  SearchMatchSignal,
} from '../enterprise-search.port.js';
import type { SearchEntityAdapter } from '../search-entity-adapter.js';
import { EmbeddingProcessingConfig } from '../../embedding/embedding-processing.config.js';

// A conservative email shape — the exact-email leg fires only for an email-shaped query
// (precision; a free-text query never pays for a wasted exact lookup).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Per-leg base relevance. Exact-identifier hits sit above every lexical hit (directive
// §6/§18); within the lexical tier a name match outranks a resume-body match. The tiny
// per-position decrement preserves each leg's own source order deterministically through
// the orchestrator's relevance-desc sort without relying on sort stability. limit <= 50,
// so the decrements never let one leg's band cross into another's. Semantic relevance
// (1 - cosine_distance) lives in its OWN band (tier 2) — orderHits keeps it below lexical
// regardless of magnitude, so its scale never collides with the lexical band.
const RELEVANCE_EXACT = 1;
const RELEVANCE_NAME = 0.7;
const RELEVANCE_RESUME = 0.5;
const POSITION_STEP = 0.001;

// Signal precedence for the one-hit-per-record dedupe: exact > lexical > semantic.
const SIGNAL_RANK: Record<SearchMatchSignal, number> = { exact: 0, lexical: 1, semantic: 2 };

// Enterprise Search (GS-1 + GS-2A) — the Talent adapter. Owns Talent's authorized retrieval and
// maps rows to lean SearchHits; the orchestrator owns cross-cutting policy. Talent is pool-open,
// so "authority" is tenant + optional site (no per-record visibility resolver); every leg —
// exact-email, name, resume FTS, and the GS-2A semantic vector leg — is bound to that same
// contract by the repository / the visibility-co-located vector SQL, so no leg widens authority
// (watch-point 1). A record matched by more than one leg collapses to exactly one hit, keeping the
// strongest signal (watch-point 2).
//
// The semantic leg is FAIL-SOFT and DARK-GATED: it runs only when EMBEDDING_PROCESSING_ENABLED is
// on, and ANY failure (missing tenant key/provider/model → EmbeddingUnavailableError, or a
// transient outage) is swallowed with a warning — exact + lexical always return unchanged. This is
// the GS-1 stability invariant: activating semantic can never regress or break the base search.
@Injectable()
export class TalentSearchAdapter implements SearchEntityAdapter {
  readonly entity_type = 'TALENT' as const;
  readonly required_scope = 'talent:search';

  private readonly logger = new Logger(TalentSearchAdapter.name);

  constructor(
    private readonly repo: TalentRecordRepository,
    @Inject(EMBEDDING_PORT) private readonly embedding: EmbeddingPort,
    @Inject(TALENT_EMBEDDING_SEARCH_PORT) private readonly semanticSearch: TalentEmbeddingSearchPort,
    private readonly embeddingConfig: EmbeddingProcessingConfig,
  ) {}

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

    // Deterministic dedupe — ONE hit per TalentRecord. A record matched by multiple legs keeps the
    // highest-precedence signal (exact > lexical > semantic) and that signal's relevance; ties
    // within a signal take the max relevance. A resume-leg snippet is preserved.
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
      const newBetter = SIGNAL_RANK[signal] < SIGNAL_RANK[existing.match.signal];
      const sameBand = SIGNAL_RANK[signal] === SIGNAL_RANK[existing.match.signal];
      byId.set(row.id, {
        ...existing,
        snippet: existing.snippet ?? snippet,
        match: {
          signal: newBetter ? signal : existing.match.signal,
          relevance: newBetter
            ? relevance
            : sameBand
              ? Math.max(existing.match.relevance, relevance)
              : existing.match.relevance,
          field: newBetter ? field : existing.match.field,
        },
      });
    };

    exactRows.forEach((row) => merge(row, 'exact', RELEVANCE_EXACT, 'email', null));
    nameRows.forEach((row, i) => merge(row, 'lexical', RELEVANCE_NAME - i * POSITION_STEP, 'name', null));
    resumeRows.forEach((row, i) =>
      merge(row, 'lexical', RELEVANCE_RESUME - i * POSITION_STEP, 'resume_text', row.resume_snippet ?? null),
    );

    // GS-2A semantic leg — dark-gated + fail-soft. Never breaks exact/lexical.
    if (this.embeddingConfig.isEnabled()) {
      await this.mergeSemantic(q, tenant_id, site_id ?? null, limit, merge);
    }

    return [...byId.values()];
  }

  // Query-time embedding + visibility-co-located vector retrieval, hydrated to lean hits. Any
  // failure is swallowed (logged) so the base search always returns.
  private async mergeSemantic(
    q: string,
    tenant_id: string,
    site_id: string | null,
    limit: number,
    merge: (row: TalentRecordView, s: SearchMatchSignal, r: number, f: string, sn: string | null) => void,
  ): Promise<void> {
    try {
      const embedded = await this.embedding.embed({ tenant_id, text: q });
      const matches = await this.semanticSearch.searchSemanticForActor({
        tenant_id,
        site_id,
        query_vector: embedded.vector,
        limit,
      });
      if (matches.length === 0) return;
      // Hydrate each matched id to its live record (the vector query already scoped tenant/site;
      // findById re-confirms the row exists + is live before it surfaces).
      const rows = await Promise.all(
        matches.map((m) => this.repo.findById({ tenant_id, id: m.talent_record_id })),
      );
      matches.forEach((m, i) => {
        const row = rows[i];
        if (row === null || row === undefined || row.record_status !== 'live') return;
        // relevance = cosine similarity (1 - distance), clamped; lives in the semantic band only.
        merge(row, 'semantic', Math.max(0, 1 - m.distance), 'semantic', null);
      });
    } catch (err) {
      // Fail-soft: missing key/provider/model (EmbeddingUnavailableError) or a transient outage
      // must NEVER regress exact/lexical. Log + skip the semantic leg for this query.
      this.logger.warn(
        `talent semantic leg skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
