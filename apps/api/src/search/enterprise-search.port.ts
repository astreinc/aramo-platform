import type { VisibilityContextShape } from '@aramo/common';

// Enterprise Search (GS-1) — the PERMANENT search boundary.
//
// Directive Aramo-Enterprise-Search-GS1-3-Directive-v1_0-LOCKED §3: domain and UI code
// depend on THIS contract, never on the PostgreSQL FTS / pg_trgm / pgvector mechanics
// behind it. The shape is deliberately forward-stable across the whole program:
//   - GS-2 activates the 'semantic' match signal — added to SearchMatchSignal WITHOUT
//     changing the request/response shape.
//   - GS-3 extends SearchEntityType with the broader entities — the union grows; the
//     contract does not.
// The point is the boundary, not these literal names (directive §3).
//
// Exposed under a STRING token (never the bare interface/class token) per the
// non-strict-lookup collision rule — see libs/requisition/src/lib/requisition.module.ts:66-70.
export const ENTERPRISE_SEARCH_PORT = 'ENTERPRISE_SEARCH_PORT';

// The entity kinds searchable in GS-1. GS-3 extends this union (Submittal / Placement /
// Document-metadata) behind the SAME contract; downstream code switches on the union.
export const SEARCH_ENTITY_TYPES = ['TALENT', 'REQUISITION', 'COMPANY', 'CONTACT'] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

// Which retrieval leg produced a hit — inspectable for tests/debug (directive §11), never
// a normal user surface. GS-1 activates 'exact' + 'lexical'; GS-2 adds 'semantic' here.
export type SearchMatchSignal = 'exact' | 'lexical';

export interface SearchMatch {
  // The strongest signal that produced this hit. Exact identifier hits outrank merely
  // lexical hits (directive §6, §18).
  signal: SearchMatchSignal;
  // The searchable representation that matched (e.g. 'name', 'requisition_number',
  // 'resume_text'). Field NAME only — never a raw PII field VALUE.
  field?: string;
  // Opaque relevance ordering weight; higher = more relevant. Deterministic, tested
  // (directive §18). Not exposed to end users.
  relevance: number;
}

// A LEAN search result. Carries ONLY what a result row renders plus its navigation
// target — never a full domain DTO, never compensation or contact-channel PII
// (directive §5, §8, §17). Because a hit carries no contact channel, the consent
// suppression overlay is structurally satisfied for GS-1 (nothing suppressible is
// surfaced); surfacing a channel later would require re-applying the overlay.
export interface SearchHit {
  entity_type: SearchEntityType;
  entity_id: string;
  display_label: string; // primary line (person / company / requisition name)
  subtitle: string | null; // secondary line (e.g. title, location)
  snippet: string | null; // matched-context excerpt where the leg provides one (résumé FTS)
  route: string; // in-app navigation target (e.g. `/talent/${id}`)
  match: SearchMatch;
}

// Actor authority is resolved by the CALLER (the controller, from the guard chain +
// VisibilityInterceptor) and passed in — the port never reads the request or guards
// itself, so it is testable in isolation and reusable by module + global + future
// headless callers.
//
// This is a TRANSPORT of already-resolved authority, NOT a second policy object: it
// carries the resolver's OUTPUT (the resolved VisibilityContext + resolved tenant/site)
// and must never accumulate visibility rules of its own. The rules live in the
// VisibilityResolver that produced `visibility` and in each domain's own read predicate
// that consumes it. Pool-open domains (Talent) ignore `visibility` and scope on
// tenant + optional site; visibility-set domains (Requisition/Company/Contact) pass
// `visibility` straight into their listForActor(visibility) reads.
export interface SearchAuthorityContext {
  tenant_id: string;
  site_id?: string;
  scopes: readonly string[];
  visibility: VisibilityContextShape;
}

export interface SearchRequest {
  query: string;
  // Absent / empty = every entity type the actor is authorized to search (global search).
  // A single type = module-scoped search. The orchestrator intersects the requested set
  // with the actor's <entity>:search scopes and never widens it (directive §5, §8).
  entity_types?: readonly SearchEntityType[];
  authority: SearchAuthorityContext;
  // Bounded per type; the orchestrator applies a default and a hard cap (directive §22).
  limit_per_type?: number;
  requestId: string;
}

export interface SearchEntityGroup {
  entity_type: SearchEntityType;
  hits: SearchHit[];
  // True when the type was requested but the actor lacks its <entity>:search scope — an
  // honest "unauthorized" distinct from an honest empty result (directive §23). The group
  // never leaks whether matching records exist behind a missing scope.
  unauthorized?: boolean;
}

export interface SearchResults {
  query: string;
  groups: SearchEntityGroup[];
}

// The permanent boundary. The GS-1 implementation is PostgreSQL-backed (exact + lexical);
// GS-2 makes it hybrid (adds the semantic leg + fusion) behind this same method.
export interface EnterpriseSearchPort {
  search(request: SearchRequest): Promise<SearchResults>;
}
