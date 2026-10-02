import type { SavedListVisibility } from './dto/saved-list-visibility.js';

// CRM-1 — SavedList visibility policy (pure, DB-free). The repository composes
// `readableWhere` INTO its tenant-scoped Prisma `where` (never a post-query
// filter, so another actor's PRIVATE list never leaves the DB) and calls
// `mutateDecision` before any entry write. Kept as pure functions so the
// authority rules are unit-provable without a database.

// The actor identity needed to resolve PRIVATE/TENANT visibility.
//   - actor_id = AuthContext.sub
//   - is_admin = the actor holds saved-list:delete (tenant_admin / tenant_owner
//     only, Ruling 1) — the architecture-supported admin-tier signal
//     (directive §5.2 "existing administrator authority"). Never an FE flag.
export interface VisibilityActor {
  actor_id: string;
  is_admin: boolean;
}

// READ predicate: an actor may SEE a list when it is tenant-visible, OR they are
// its creator, OR they are admin-tier. Returned as a Prisma `where` fragment to
// be ANDed with the tenant scope. An admin sees everything in-tenant (empty
// disjunction).
export function readableWhere(
  actor: VisibilityActor,
): { OR: Array<Record<string, unknown>> } | Record<string, never> {
  if (actor.is_admin) return {};
  return {
    OR: [{ visibility: 'tenant' }, { owner_id: actor.actor_id }],
  };
}

// MUTATE decision (PO ruling — creator + admin only, for BOTH private and
// tenant lists):
//   - 'not_found'  → the actor cannot even SEE the list (no existence leak)
//   - 'forbidden'  → visible (tenant) but neither creator nor admin
//   - 'ok'         → creator or admin
export function mutateDecision(
  list: { owner_id: string; visibility: SavedListVisibility },
  actor: VisibilityActor,
): 'ok' | 'not_found' | 'forbidden' {
  const canSee =
    actor.is_admin ||
    list.owner_id === actor.actor_id ||
    list.visibility === 'tenant';
  if (!canSee) return 'not_found';
  const canMutate = actor.is_admin || list.owner_id === actor.actor_id;
  return canMutate ? 'ok' : 'forbidden';
}
