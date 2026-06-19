// Admin-access gate (FE Consolidation Phase 1).
//
// The unified ats-web shell hosts both the recruiter surface (always) and an
// admin-gated section (Phase 2+ ports settings/users/org/teams/assignments/
// consent here). The admin section is shown only to a principal holding a
// `tenant:admin:*` scope.
//
// SERVER IS THE GATE. This helper drives a UX hide + an in-UI ForbiddenState;
// it is NOT the security boundary. Every admin API the ported modules will call
// is `@RequireScopes(...)`-gated on the backend, so a recruiter hand-typing an
// admin URL is rejected by the server regardless of what the UI renders.
//
// Why a prefix check (not RouteGuard's single-exact `requireScope`): the
// directive gates the *section* on the `tenant:admin:*` family, and the
// per-module routes that arrive in Phase 2+ each carry their own specific scope
// (e.g. `tenant:admin:settings`, `tenant:admin:user-manage`). fe-foundation's
// RouteGuard stays frozen; this app-local helper expresses the family gate.

import type { Session } from '@aramo/fe-foundation';

export const ADMIN_SCOPE_PREFIX = 'tenant:admin:';

/** True when the session carries any `tenant:admin:*` scope. */
export function hasAdminScope(session: Session): boolean {
  return session.scopes.some((scope) => scope.startsWith(ADMIN_SCOPE_PREFIX));
}
