import { ForbiddenState, type Session } from '@aramo/fe-foundation';
import type { ReactNode } from 'react';

import { hasAdminScope } from './admin-access';

// AdminGate — the single scope guard for the whole `/admin/*` subtree
// (FE Consolidation Phase 1). Mirrors RouteGuard's authorization outcome
// (ForbiddenState, NOT a login redirect — the missing admin scope is a policy
// outcome, not an authentication failure) but gates on the `tenant:admin:*`
// family rather than a single exact scope.
//
// Reached only from inside App's authenticated branch, so the session is
// always present. The UI hide is UX; the backend rejects admin calls without
// the scope.

interface AdminGateProps {
  readonly session: Session;
  readonly children: ReactNode;
}

export function AdminGate({ session, children }: AdminGateProps) {
  if (!hasAdminScope(session)) {
    return <ForbiddenState scope="tenant:admin:*" />;
  }
  return <>{children}</>;
}
