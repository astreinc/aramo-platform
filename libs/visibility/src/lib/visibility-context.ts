// AUTHZ-D4b — VisibilityContext (the composed visibility predicate result).
//
// The READ-SIDE half of the D4 record-level visibility model. Returned by
// VisibilityResolverService.resolveForActor and threaded down to the 6-entity
// cascade (company / requisition / pipeline / submittal / contact / activity)
// via the repository read-method parameter.
//
// The context is PURE DATA — no methods. Lazy derived-set resolution
// (visible_requisition_ids, visible_pipeline_ids) lives on the resolver
// service (per-request memoized) so the context object stays serializable
// and the resolver retains the single authority for cross-schema reads.
//
// Composition (Amendment v1.1 §4.3):
//   visible_client_ids = direct                                    (UserClientAssignment, actor)
//                      ∪ direct(transitive-reports[depth ≤ 3])      (ManagementEdge BFS down → UserClientAssignment)
//                      ∪ pod-clients                                (TeamMembership → TeamClientOwnership, active pods)
//                      ∪ [ALL if company:read:all]                  (TA + TO only; D4a §6 ruling)

export interface VisibilityContext {
  // Provenance — the actor the context was resolved for. Pinned so
  // memoized derived sets (visible_requisition_ids etc.) cannot be
  // accidentally re-used across actors.
  readonly tenant_id: string;
  readonly actor_user_id: string;

  // The two see-all short-circuits (mutually independent — A3 ruling +
  // D4a §6: company:read:all = TA+TO; requisition:read:all = TA+).
  // When true, the corresponding entity reads skip the IN-set filter.
  readonly see_all_company: boolean;
  readonly see_all_requisition: boolean;

  // The composed union — null when see_all_company (no need to materialize).
  // ReadonlySet for cheap O(1) membership checks; the entity repos convert
  // to Array for Prisma `IN` clauses at the call site.
  readonly visible_client_ids: ReadonlySet<string> | null;
}
