import { SetMetadata } from '@nestjs/common';

import { REQUIRED_SCOPES_KEY } from './authorization.metadata.js';

// @RequireScopes('submittal:create', 'submittal:approve')
//
// Attaches a closed list of scope keys to the route/handler. RolesGuard
// reads the metadata and requires AuthContext.scopes to be a SUPERSET
// (every required scope present). All-or-nothing per A1a directive
// Ruling 2; "any-of" semantics are deliberately not introduced here.
//
// Scope keys must match the SCOPE_KEY_FORMAT regex seeded in
// libs/identity (lower-snake-colon vocabulary, no UUIDs in keys —
// per Ruling 5 the site dimension rides AuthContext.site_id, not the
// scope key).
export const RequireScopes = (...scopes: string[]) =>
  SetMetadata(REQUIRED_SCOPES_KEY, scopes);
