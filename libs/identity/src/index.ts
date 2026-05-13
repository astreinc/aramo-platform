export { IdentityModule } from './lib/identity.module.js';
export { IdentityService } from './lib/identity.service.js';
export { TenantService } from './lib/tenant.service.js';
export { RoleService } from './lib/role.service.js';
export { IdentityRepository } from './lib/identity.repository.js';
export { TenantRepository } from './lib/tenant.repository.js';
export { RoleRepository } from './lib/role.repository.js';
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
