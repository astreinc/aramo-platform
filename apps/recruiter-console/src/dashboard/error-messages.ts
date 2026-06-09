import { ApiError } from '@aramo/fe-foundation';

// R-home — surface the BE-typed code/details for the dashboard. The only
// load-bearing code today is the 403 (the actor's scope/capability is
// short of dashboard:read or the ATS entitlement); RouteGuard handles
// the 403 at the route boundary via ForbiddenState, so the in-view
// error path covers transient/server failures.

export function dashboardErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'You do not have permission to view the dashboard.';
    }
    if (error.status === 404) {
      return 'The dashboard service is not available right now.';
    }
    if (error.status >= 500) {
      return 'The dashboard service is temporarily unavailable. Please try again.';
    }
  }
  return 'Could not load the dashboard. Please refresh.';
}
