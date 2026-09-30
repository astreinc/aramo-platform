// Enterprise Search (GS-1) — the per-domain adapter seam.
//
// The orchestrator (EnterpriseSearchReadService) owns cross-cutting policy — scope
// gating, fan-out, exact-first ordering, bounded limits, honest unauthorized/empty
// groups — and knows NOTHING about any single domain's storage. Each domain contributes
// one adapter that owns its own authorized retrieval and maps rows to lean SearchHits.
// This keeps the orchestration logic pure and unit-testable (fake adapters) while each
// adapter is integration-tested against its real repository (directive §8: reuse
// domain-owned search capabilities, converge them behind the boundary).
//
// GS-3 adds Submittal/Placement/Document adapters implementing this SAME seam; the
// orchestrator does not change. Adapters are injected as an array under a string token.
import type { SearchAuthorityContext, SearchEntityType, SearchHit } from './enterprise-search.port.js';

export const SEARCH_ENTITY_ADAPTERS = 'SEARCH_ENTITY_ADAPTERS';

export interface SearchEntityAdapter {
  // The entity type this adapter serves.
  readonly entity_type: SearchEntityType;
  // The seeded scope the actor must hold to search this entity (reused, not new —
  // e.g. 'talent:search'). The orchestrator, never the adapter, enforces it; the
  // adapter declares it so the orchestrator stays domain-agnostic.
  readonly required_scope: string;
  // Retrieve authorized, lean hits for the query. The adapter MUST scope to the
  // authority context exactly as its owning domain's ForActor read would (tenant +
  // visibility sets); it must never widen authority (directive §5). `limit` is the
  // already-bounded per-type cap decided by the orchestrator.
  search(query: string, authority: SearchAuthorityContext, limit: number): Promise<SearchHit[]>;
}
