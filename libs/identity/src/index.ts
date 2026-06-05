export { IdentityModule } from './lib/identity.module.js';
export { IdentityService } from './lib/identity.service.js';
export { TenantService } from './lib/tenant.service.js';
export { RoleService } from './lib/role.service.js';
export { IdentityRepository } from './lib/identity.repository.js';
export { TenantRepository } from './lib/tenant.repository.js';
export { RoleRepository } from './lib/role.repository.js';
// AUTHZ-D4b — exported for consumption by libs/visibility (the D4b
// resolver reads ManagementEdge for the Axis-1 transitive-reports walk
// and TeamMembership for the Axis-2 pod-membership lookup). The repos
// were already exposed as module providers post-D4a; the explicit barrel
// re-exports are added so libs/visibility can inject them directly via
// the @aramo/identity import path.
export { ManagementEdgeRepository } from './lib/management-edge.repository.js';
export { TeamRepository } from './lib/team.repository.js';
export {
  IdentityAuditRepository,
  ACTOR_TYPES,
  EVENT_TYPES,
  TENANT_SCOPED_EVENT_TYPES,
} from './lib/audit/identity-audit.repository.js';
export type {
  ActorType,
  EventType,
  WriteAuditEventInput,
} from './lib/audit/identity-audit.repository.js';
export { IdentityAuditService } from './lib/audit/identity-audit.service.js';
export { PrismaService } from './lib/prisma/prisma.service.js';
export {
  SEED_ROLE_KEYS,
  SEED_SCOPE_KEYS,
  SCOPE_KEY_FORMAT,
} from './lib/dto/index.js';
export type {
  UserDto,
  TenantDto,
  MembershipDto,
  RoleDto,
  ScopeDto,
  ServiceAccountDto,
  ExternalIdentityDto,
  SeedRoleKey,
  SeedScopeKey,
} from './lib/dto/index.js';
export {
  encodeCursor,
  decodeCursor,
  CursorDecodeError,
} from './lib/util/identity-audit-cursor.js';
export type { IdentityAuditCursorPayload } from './lib/util/identity-audit-cursor.js';
