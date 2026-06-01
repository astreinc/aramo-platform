import { SetMetadata } from '@nestjs/common';

import { REQUIRES_SITE_MATCH_KEY } from './authorization.metadata.js';

// @RequireSiteMatch()
//
// Marks a route as site-scoped: RolesGuard verifies that the resolved
// AuthContext.site_id matches the route's site_id (read from a path
// parameter or query — see RolesGuard.resolveRequestedSite). When the
// claim is absent, the request is rejected with INSUFFICIENT_PERMISSIONS.
//
// Routes that are tenant-wide (no site axis) omit the decorator entirely.
// Per A1a Ruling 5: consent/identity-read scopes stay tenant-wide; ATS
// operation scopes MAY carry the site dimension when applied to a
// site-decorated route. The decorator is the route-side opt-in.
export const RequireSiteMatch = () =>
  SetMetadata(REQUIRES_SITE_MATCH_KEY, true);
