export { IdentityModule } from './lib/identity.module.js';
// Auth-Hardening IdentityModule-Split v1.0 — the SHARED identity read surface.
// Every module OUTSIDE apps/api's invite/role surface (company, visibility,
// task-via-forRoot-imports, auth-service, platform-admin) imports THIS module,
// not IdentityModule. It carries no invite ports and no lifecycle consumer, so
// a static import can never create the second, stub-bound instance that the
// forRoot IdentityModule used to collide with.
export { IdentityCoreModule } from './lib/identity-core.module.js';
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
// Domain-Enforcement P1 — the email-domain primitives. Exported so the
// platform-admin invitation service can run the SAME reject-personal gate
// (deriveAllowedDomainOrThrow) as a pre-check BEFORE Cognito AdminCreateUser
// (the authoritative enforcement still lives in TenantService.provisionTenant).
export {
  normalizeEmail,
  extractEmailDomain,
  isPersonalOrDisposableDomain,
  deriveAllowedDomainOrThrow,
} from './lib/util/email-domain.js';
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
// Invite-S2 (Pattern-2) — the public acceptance flow's lifecycle service,
// consumed by apps/api's un-guarded PublicInvitationController.
export {
  InvitationLifecycleService,
} from './lib/tenant-user/invitation-lifecycle.service.js';
export {
  INVITE_STATUSES,
  isInviteStatus,
  type InviteStatus,
} from './lib/tenant-user/invitation-token.js';
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
// Domain-Enforcement P2b — DNS-TXT domain-verification surface + resolver port.
// DnsResolverModule is wired into IdentityModule; these are exported so apps/api
// integration specs can prime the StubDnsAdapter (via DNS_RESOLVER_PORT) and
// assert the verification view/transitions.
export { DnsResolverModule } from './lib/dns/dns-resolver.module.js';
export {
  DNS_RESOLVER_PORT,
} from './lib/dns/dns-resolver.port.js';
export type { DnsResolverPort } from './lib/dns/dns-resolver.port.js';
export { NodeDnsAdapter } from './lib/dns/node-dns.adapter.js';
export { StubDnsAdapter } from './lib/dns/stub-dns.adapter.js';
export { DomainVerificationService } from './lib/domain-verification/domain-verification.service.js';
export type { DomainVerificationView } from './lib/domain-verification/domain-verification.view.js';
export {
  DOMAIN_VERIFICATION_STATUSES,
  isDomainVerificationStatus,
  generateDomainVerificationToken,
} from './lib/util/domain-verification.js';
export type { DomainVerificationStatus } from './lib/util/domain-verification.js';
