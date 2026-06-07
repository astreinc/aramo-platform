// Scope-gating primitive — the S5b/S5c precedent.
//
// The backend's authorization model is scopes-only: the session payload
// carries the actor's granted scopes (Session.scopes: string[]), and
// every protected route is `@RequireScopes(...)` gated on the API side.
// The FE mirror is `hasScope` + a `requireScope` axis on `RouteGuard`
// + a conditional render in the nav.
//
// Pattern (DO):
//   <RouteGuard requireScope="tenant:admin:settings">…</RouteGuard>
//   {hasScope(session, 'tenant:admin:user-manage') && <NavLink … />}
//
// Anti-pattern (DON'T): scattered `session.scopes.includes(…)` calls
// inside feature components. The whole point of the helper is to keep
// the lookup at the routing/nav boundary so a future scope-name change
// is a single-callsite rename.

import type { Session } from './session';

export function hasScope(session: Session, scope: string): boolean {
  return session.scopes.includes(scope);
}
