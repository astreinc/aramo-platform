// AUTHZ-D4b — module constants.

// Max depth of the Axis-1 (management hierarchy) BFS during visibility
// resolution. Bounded per the directive §2 + D4a Lead-ruling 4
// (depth applies at TRAVERSAL, NOT at edge-creation — the write-side
// rejects only cycles via MANAGEMENT_CYCLE_REJECTED, not depth).
//
// A depth-4 (or deeper) report's UserClientAssignment is NOT inherited
// by the manager's visibility set — this is a deliberate ceiling so the
// transitive walk stays small + bounded.
export const MAX_MANAGEMENT_DEPTH = 3 as const;

// Scope keys consulted by the resolver. Both narrowed at D4a §6
// (company:read:all is TA + TO only; finance / back_office DO NOT
// receive it — they fall through to the union).
export const SCOPE_COMPANY_READ_ALL = 'company:read:all' as const;
export const SCOPE_REQUISITION_READ_ALL = 'requisition:read:all' as const;
