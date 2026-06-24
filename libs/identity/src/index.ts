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
// Settings S3a — tenant-user lifecycle public surface. Exports the
// validator + saga service for testing; the Cognito port token + interface
// for apps/api to bind a live AWS-SDK adapter. The StubTenantCognitoAdapter
// is exported so apps/api can replace it cleanly.
export {
  RoleBundleValidator,
  SEE_ALL_ROLE_KEYS,
} from './lib/tenant-user/role-bundle-validator.js';
export {
  TenantUserLifecycleService,
} from './lib/tenant-user/tenant-user-lifecycle.service.js';
export type {
  InviteResult,
  DisableResult,
} from './lib/tenant-user/tenant-user-lifecycle.service.js';
// §5 Auth-Hardening D4 — the minimal assignable-roster row, consumed by
// apps/api's cross-schema AssignableUsersController.
export type { AssignableUserView } from './lib/identity.repository.js';
// §5 Auth-Hardening D4b — the name-resolver row (directory endpoint).
export type { DirectoryUserView } from './lib/identity.repository.js';
// Aramo-Identity-Me-Endpoint — the self-read display shape for GET /v1/me,
// consumed by apps/api's MeController.
export type { MeView } from './lib/identity.service.js';
export {
  TENANT_COGNITO_PORT,
  StubTenantCognitoAdapter,
} from './lib/tenant-user/tenant-cognito.port.js';
export type { TenantCognitoPort } from './lib/tenant-user/tenant-cognito.port.js';
// Settings S4 — AuditFinancialsGate port (the auditor_with_financials
// grant's policy precondition). apps/api binds the real adapter that
// reads via TenantSettingService.
export {
  AUDIT_FINANCIALS_GATE,
  StubAuditFinancialsGateAdapter,
} from './lib/tenant-user/audit-financials-gate.port.js';
export type { AuditFinancialsGate } from './lib/tenant-user/audit-financials-gate.port.js';
