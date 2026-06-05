// AUTHZ-D4b — VisibilityContext structural type + Express request
// augmentation.
//
// Defined here in libs/common so every entity lib (company / requisition /
// pipeline / submittal / contact / activity) and their controllers can
// consume the type WITHOUT importing @aramo/visibility — the D4b Gate-5
// Ruling 1 cycle-avoidance discipline (the entity libs are downstream of
// libs/visibility in the dependency graph; the visibility resolver
// produces this shape and the entity repos consume it).
//
// The shape MUST match VisibilityContext in @aramo/visibility verbatim
// (a structural-type contract). Any drift here breaks the cascade.
export interface VisibilityContextShape {
  readonly tenant_id: string;
  readonly actor_user_id: string;
  readonly see_all_company: boolean;
  readonly see_all_requisition: boolean;
  readonly visible_client_ids: ReadonlySet<string> | null;
}

// Express Request augmentation — VisibilityInterceptor attaches three
// LAZY + MEMOIZED resolver functions on every request that touches a
// controller:
//
//   await req.resolveVisibility()              → VisibilityContextShape
//   await req.resolveVisibleRequisitionIds()   → ReadonlySet | null
//   await req.resolveVisiblePipelineIds()      → ReadonlySet | null
//
// Controllers call these as needed and pass the resolved values to the
// repo read methods. null on the derived sets means "see-all → no IN
// filter" (the requisition:read:all short-circuit). The interceptor
// memoizes each separately per request.
//
// The augmentation lives here (in libs/common) so every entity lib sees
// the typed Request without importing @aramo/visibility (the D4b Gate-5
// Ruling 1 cycle-avoidance).
declare module 'express-serve-static-core' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Request {
    resolveVisibility?: () => Promise<VisibilityContextShape>;
    resolveVisibleRequisitionIds?: () => Promise<ReadonlySet<string> | null>;
    resolveVisiblePipelineIds?: () => Promise<ReadonlySet<string> | null>;
  }
}
