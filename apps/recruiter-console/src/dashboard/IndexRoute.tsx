import { Navigate } from 'react-router-dom';
import { hasScope, useSession } from '@aramo/fe-foundation';

import { DashboardView } from './DashboardView';

// IndexRoute — the recruiter-console root path dispatcher.
//
// The directive's UX intent: actors with dashboard:read see the
// Dashboard; actors without it fall back to /requisitions (the prior
// index target preserved as the no-dashboard landing). This is NOT
// what fe-foundation's RouteGuard does — RouteGuard renders
// ForbiddenState on a missing scope, which would surface a forbidden
// page on the recruiter's home and is the wrong UX for an actor whose
// next-best route is the requisitions list.
//
// We honor the directive's intent here with a tiny session-aware
// dispatcher. fe-foundation stays FROZEN (no RouteGuard fallback-prop
// addition; promote that pattern when a 2nd consumer appears — the
// rule-of-three discipline).
//
// Loading / unauthenticated states fall to the same useSession + redirect
// pattern the rest of the app uses; the outer App.tsx already wraps this
// with a RouteGuard that drives those, so this dispatcher only fires on
// authenticated sessions.
export function IndexRoute() {
  const state = useSession();

  if (state.status !== 'authenticated') {
    // The outer RouteGuard owns loading + unauthenticated; in
    // practice we should not render in those states. Render nothing
    // defensively — no flash of either page.
    return null;
  }

  if (hasScope(state.session, 'dashboard:read')) {
    return <DashboardView session={state.session} />;
  }

  // The dashboard:read-less actor lands on /requisitions (the prior
  // index behavior preserved).
  return <Navigate to="/requisitions" replace />;
}
