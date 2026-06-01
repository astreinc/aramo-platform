import { SetMetadata } from '@nestjs/common';

import type { Capability } from './capability.js';
import { REQUIRED_CAPABILITIES_KEY } from './entitlement.metadata.js';

// @RequireCapability('ats')
//
// Attaches a closed list of capability keys to the route/handler.
// EntitlementGuard reads the metadata and requires the tenant
// (AuthContext.tenant_id) to be entitled to EVERY listed capability
// (all-or-nothing — mirrors @RequireScopes semantics per PR-A1a).
//
// DISTINCT AXIS from @RequireScopes (PR-A1b Ruling 1):
//   - @RequireCapability gates the TENANT axis (tenant-level capability).
//   - @RequireScopes gates the USER/ROLE axis (per-principal permission).
// Both decorators are independently composable on the same handler.
// A scoped user in an unentitled tenant is still rejected at the
// EntitlementGuard step, never reaching RolesGuard.
export const RequireCapability = (...capabilities: Capability[]) =>
  SetMetadata(REQUIRED_CAPABILITIES_KEY, capabilities);
