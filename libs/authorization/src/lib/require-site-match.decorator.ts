import { SetMetadata } from '@nestjs/common';

import { REQUIRES_SITE_MATCH_KEY } from './authorization.metadata.js';

// @RequireSiteMatch()
//
// Marks a route as site-scoped. RolesGuard then enforces the A1a site-axis
// contract against the request:
//   - A tenant-wide principal (NO site_id claim) passes UNCONSTRAINED — it
//     holds authority over every site, so it is admitted on any requested
//     site. (The issuer omits the claim only for NULL-site memberships, so
//     a site-scoped user cannot strip their own claim to forge this.)
//   - A site-scoped principal (site_id claim PRESENT) must match: if the
//     route's requested site_id (path/query — see
//     RolesGuard.resolveRequestedSite) differs from the claim, the request
//     is rejected 403 INSUFFICIENT_PERMISSIONS (cross-site isolation).
//
// Routes that are tenant-wide (no site axis) omit the decorator entirely.
// Per A1a Ruling 5: consent/identity-read scopes stay tenant-wide; ATS
// operation scopes MAY carry the site dimension when applied to a
// site-decorated route. The decorator is the route-side opt-in.
export const RequireSiteMatch = () =>
  SetMetadata(REQUIRES_SITE_MATCH_KEY, true);
