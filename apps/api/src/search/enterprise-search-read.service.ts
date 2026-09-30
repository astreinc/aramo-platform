import { Inject, Injectable } from '@nestjs/common';

import {
  SEARCH_ENTITY_TYPES,
  type EnterpriseSearchPort,
  type SearchEntityGroup,
  type SearchEntityType,
  type SearchHit,
  type SearchRequest,
  type SearchResults,
} from './enterprise-search.port.js';
import { SEARCH_ENTITY_ADAPTERS, type SearchEntityAdapter } from './search-entity-adapter.js';

// Enterprise Search (GS-1) — the orchestrator. apps/api is the ONLY layer allowed to know
// all owners (talent-journey-read.service precedent); GET-only, issues ZERO writes. It owns
// the cross-cutting policy and NOTHING domain-specific:
//   - scope gating: an adapter is invoked only when the actor holds its :search scope, and
//     is NEVER called otherwise (directive §5 — search must not widen authority);
//   - fan-out: authorized adapters run concurrently;
//   - ordering: within each group, exact-signal hits precede lexical, then relevance desc
//     (directive §6, §18 — exact identifiers outrank merely lexical/semantic matches);
//   - bounded limits (directive §22);
//   - honest groups (directive §23): an explicitly-requested type the actor cannot search
//     returns an `unauthorized` group; global search silently OMITS unauthorized types so
//     their existence is never revealed.
// GS-2 adds the semantic leg + fusion inside the adapters; this orchestration is unchanged.

// Bounded per-type result sizes (directive §22). Default keeps the palette snappy; the cap
// is a hard ceiling regardless of caller input.
export const SEARCH_DEFAULT_LIMIT_PER_TYPE = 10;
export const SEARCH_MAX_LIMIT_PER_TYPE = 50;

@Injectable()
export class EnterpriseSearchReadService implements EnterpriseSearchPort {
  private readonly byType: ReadonlyMap<SearchEntityType, SearchEntityAdapter>;

  constructor(
    @Inject(SEARCH_ENTITY_ADAPTERS) adapters: readonly SearchEntityAdapter[],
  ) {
    const map = new Map<SearchEntityType, SearchEntityAdapter>();
    for (const adapter of adapters) {
      if (map.has(adapter.entity_type)) {
        throw new Error(`duplicate search adapter for entity_type ${adapter.entity_type}`);
      }
      map.set(adapter.entity_type, adapter);
    }
    this.byType = map;
  }

  async search(request: SearchRequest): Promise<SearchResults> {
    const query = request.query?.trim() ?? '';
    if (query === '') {
      return { query, groups: [] };
    }

    const limit = Math.min(request.limit_per_type ?? SEARCH_DEFAULT_LIMIT_PER_TYPE, SEARCH_MAX_LIMIT_PER_TYPE);

    // Explicit entity_types = module-scoped (or a caller-chosen subset). Absent/empty =
    // global search over every wired type.
    const explicit = request.entity_types && request.entity_types.length > 0 ? request.entity_types : null;
    const targetTypes = explicit ?? SEARCH_ENTITY_TYPES.filter((t) => this.byType.has(t));

    const groups: SearchEntityGroup[] = [];
    const authorized: { entity_type: SearchEntityType; adapter: SearchEntityAdapter }[] = [];

    for (const type of targetTypes) {
      const adapter = this.byType.get(type);
      if (adapter === undefined) {
        // A type with no wired adapter (e.g. a GS-3 type not yet implemented) is omitted —
        // never fabricated.
        continue;
      }
      if (!request.authority.scopes.includes(adapter.required_scope)) {
        // Explicit request → honest unauthorized group (never reveals whether records exist).
        // Global search → omit silently.
        if (explicit) {
          groups.push({ entity_type: type, hits: [], unauthorized: true });
        }
        continue;
      }
      authorized.push({ entity_type: type, adapter });
    }

    const settled = await Promise.all(
      authorized.map(async ({ entity_type, adapter }) => ({
        entity_type,
        hits: this.orderHits(await adapter.search(query, request.authority, limit)),
      })),
    );
    for (const group of settled) {
      groups.push({ entity_type: group.entity_type, hits: group.hits });
    }

    // Deterministic group order (canonical entity-type order) regardless of fan-out timing.
    groups.sort(
      (a, b) => SEARCH_ENTITY_TYPES.indexOf(a.entity_type) - SEARCH_ENTITY_TYPES.indexOf(b.entity_type),
    );
    return { query, groups };
  }

  // Exact-signal hits precede lexical; within a tier, higher relevance first (directive §18).
  private orderHits(hits: SearchHit[]): SearchHit[] {
    // Frozen three-band order (GS-2A): exact → lexical → semantic. Relevance orders only
    // WITHIN a band; a band boundary always dominates the relevance weight. An exact hit
    // outranks every lexical hit, and a lexical hit outranks every semantic hit, regardless
    // of relevance magnitude.
    const tier = (h: SearchHit): number =>
      h.match.signal === 'exact' ? 0 : h.match.signal === 'lexical' ? 1 : 2;
    return [...hits].sort((a, b) => tier(a) - tier(b) || b.match.relevance - a.match.relevance);
  }
}
