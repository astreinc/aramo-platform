export { IdentityModule } from './lib/identity.module.js';
// Auth-Hardening IdentityModule-Split v1.0 — the SHARED identity read surface.
// Every module OUTSIDE apps/api's invite/role surface (company, visibility,
// task-via-forRoot-imports, auth-service, platform-admin) imports THIS module,
// not IdentityModule. It carries no invite ports and no lifecycle consumer, so
// a static import can never create the second, stub-bound instance that the
// forRoot IdentityModule used to collide with.
export { IdentityCoreModule } from './lib/identity-core.module.js';
export { IdentityService } from './lib/identity.service.js';
// IC-1 PR-1 (Amendment A1 §4) — the invite-email ownership classification the
// platform tier runs BEFORE any Cognito side effect, plus the audit vocabulary.
export type {
  InviteEmailOwnership,
  InviteTier,
  CrossTenantRejectionReason,
} from './lib/identity.service.js';
export { TenantService } from './lib/tenant.service.js';
// IC-2 PR-6 — live product-entitlement read (mint/refresh gate + resolver) and
// the pure consumer→capability / scope-namespace policy.
export { TenantEntitlementReader } from './lib/tenant-entitlement-reader.service.js';
export {
  requiredCapabilityForConsumer,
  filterScopesForConsumer,
  ESIGN_SCOPE_PREFIX,
  PLATFORM_SCOPE_PREFIX,
  ORG_SESSION_DOCUMENT_TEMPLATE_SCOPE_KEYS,
  SIGN_SESSION_DOCUMENT_TEMPLATE_SCOPE_KEYS,
  type ConsumerCapabilityRequirement,
  type ProductConsumer,
} from './lib/authorization/consumer-scope-policy.js';
// IC-3 PR-8 — the Sign SENDER authorization boundary (guard composition + the
// pure decision) a `v1/sign/sender/*` route mounts; see the module header for
// the activation dependency.
// D-ORG — the backend-authoritative product-availability projection (App Home).
export {
  ProductAvailabilityService,
  PRODUCT_KEYS,
  ATS_ENTRY_PATH,
  ORG_ENTRY_PATH,
  ORG_TEMPLATES_ENTRY_PATH,
  DEFAULT_SIGN_ENTRY_URL,
  signEntryUrl,
  signEntryActivated,
  type ProductKey,
  type ProductAvailability,
  type ProductAvailabilityView,
  type ProductUnavailableReason,
  type OrgAccess,
} from './lib/authorization/product-availability.service.js';
// Sign Unified Product S-1 — the Sign permission contract (scopes + built-in roles).
export {
  ESIGN_SCOPE,
  ESIGN_ROLE_KEYS,
  ESIGN_ROLE_PERMISSIONS,
  ESIGN_ROLE_DISPLAY,
  isEsignRoleKey,
  SIGN_ORGANIZATION_ROLE_KEYS,
  SIGN_ORGANIZATION_ROLE_DISPLAY,
  type EsignScope,
  type EsignRoleKey,
  type SignOrganizationRoleKey,
} from './lib/dto/esign-permissions.js';
export {
  EsignSenderBoundary,
  EsignSenderConsumerGuard,
  evaluateEsignSenderAuthorization,
  type EsignSenderDenialReason,
  type EsignSenderVerdict,
} from './lib/authorization/esign-sender-boundary.js';
// Inc-3 PR-3.8 (A) — the operator dashboard payload shape.
export type {
  PlatformDashboardData,
  PlatformDashboardStatusCount,
  PlatformDashboardOnboardingRow,
  PlatformDashboardActivityRow,
} from './lib/tenant.service.js';
export { RoleService } from './lib/role.service.js';
// HF-AUTH-1 — authorization-revision authority (bump paths + current-version read).
export { AuthorizationVersionService } from './lib/authorization-version.service.js';
export {
  bumpPrincipalVersion,
  bumpPrincipalsWithRoleVersion,
  ensureBaselineVersion,
} from './lib/authorization-version.ops.js';
// HF-AUTH-1 — the app-root binding for the compact-token authorization resolver
// (bind once via AuthorizationResolverModule.forRoot). Plus the pieces the
// test-auth harness composes directly.
export { AuthorizationResolverModule } from './lib/authorization/authorization-resolver.module.js';
export { IdentityEffectiveAuthorizationResolver } from './lib/authorization/identity-effective-authorization-resolver.js';
export {
  AUTHZ_RESOLVER_CONFIG,
  type AuthzResolverConfig,
} from './lib/authorization/identity-effective-authorization-resolver.js';
export { InMemoryScopeCache } from './lib/authorization/in-memory-scope-cache.js';
export { RedisScopeCache } from './lib/authorization/redis-scope-cache.js';
export {
  AUTHORIZATION_SCOPE_CACHE,
  type AuthorizationScopeCache,
} from './lib/authorization/scope-cache.port.js';
// Platform-Console Increment-2 PR-1 — tenant lifecycle vocabulary. Exported so
// the auth-service mint gate + platform-admin action endpoints share the single
// source of truth for statuses / transitions / mint-deny set.
export {
  TENANT_STATUSES,
  type TenantStatus,
  isTenantStatus,
  TENANT_TRANSITIONS,
  isLegalTransition,
  MINT_DENYING_STATUSES,
  // IC-4 PR-9 — the system actor id for automatic lifecycle writes (J-9 owner
  // first-session activation runs in the auth-service adapter).
  SYSTEM_SERVICE_ACCOUNT_ID,
} from './lib/util/tenant-lifecycle.js';
// IC-4 PR-9 — tenant KIND vocabulary (BUSINESS | PERSONAL), the closed personal
// capability set and the first-session activation owner keys (J-9).
export {
  TENANT_KINDS,
  type TenantKind,
  isTenantKind,
  DEFAULT_TENANT_KIND,
  PERSONAL_TENANT_CAPABILITIES,
  TENANT_ACTIVATING_OWNER_ROLE_KEYS,
} from './lib/util/tenant-kind.js';
export { IdentityRepository } from './lib/identity.repository.js';
export { TenantRepository } from './lib/tenant.repository.js';
// Platform-Console Increment-2 PR-1.5 (A1) — the platform-operator list row shape.
export type { PlatformTenantListRow } from './lib/tenant.repository.js';
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
  // Platform-Console Increment-2 PR-2 (G1) — the tenant.* lifecycle event family
  // + the audit row shape, exported for the platform-admin audit read endpoint.
  TENANT_LIFECYCLE_EVENT_TYPES,
} from './lib/audit/identity-audit.repository.js';
export type { AuditEventRow } from './lib/audit/identity-audit.repository.js';
export type {
  ActorType,
  EventType,
  WriteAuditEventInput,
} from './lib/audit/identity-audit.repository.js';
export { IdentityAuditService } from './lib/audit/identity-audit.service.js';
export { PrismaService } from './lib/prisma/prisma.service.js';
export {
  SEED_ROLE_KEYS,
  PLATFORM_ROLE_KEYS,
  TENANT_ASSIGNABLE_ROLE_KEYS,
  ORG_ADMIN_SCOPE_KEYS,
  ESIGN_PRODUCT_ROLE_KEYS,
  ESIGN_SENDER_SCOPE_KEY,
  ATS_PRODUCT_ROLE_KEYS,
  ORG_ROLE_KEYS,
  RETIRED_ROLE_KEYS,
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
  // Sign Personal (Free) Launch v1.1 §2 / §3.8 — the one classification + Gmail duplicate key.
  classifyEmailDomain,
  canonicalEmailForDuplicates,
  type EmailDomainClass,
} from './lib/util/email-domain.js';
// Subdomain-Identity Directive A — the subdomain-slug primitives. Exported so
// apps/api's public cert-eligibility ask-endpoint can extract the slug from the
// inbound host (extractTenantSlugFromHost) and so the slug validator
// (deriveSlugOrThrow) is testable; the authoritative provision-time enforcement
// lives in TenantService.provisionTenant.
export {
  normalizeSlug,
  deriveSlugOrThrow,
  extractTenantSlugFromHost,
} from './lib/util/tenant-slug.js';
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
// ROLES-1 PR-1 (§4) — owner-only grant authority + the last-owner invariant marker/mapper.
export type { OwnerRoleAuthority } from './lib/identity.service.js';
export {
  TENANT_OWNER_ROLE_KEY,
  TENANT_LAST_OWNER_DB_MARKER,
  isTenantLastOwnerViolation,
  rethrowTenantLastOwner,
} from './lib/util/tenant-last-owner.js';
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

// Aramo Sign launch — self-service BUSINESS signup request store.
export {
  SignupRequestRepository,
  SIGNUP_PROVISIONING_STALE_MS,
  type SignupRequestRow,
} from './lib/signup-request.repository.js';

// AUTH-SIGNIN-1 R1/R2 — provider pin cohort + no cross-provider merge.
export {
  IdentityProviderPolicyService,
  FEDERATED_IDPS,
  normalizeIdp,
  type FederatedIdp,
  type IdpDecision,
} from './lib/identity-provider-policy.service.js';

// Sign Signup Amendment A1 (LOCKED) — organization details at signup, US only.
export { OrganizationRegionService } from './lib/organization-region.service.js';
export {
  US_STATE_CODES,
  BILLING_REGION_US,
  ORGANIZATION_COUNTRY_NOT_SUPPORTED,
  ORGANIZATION_DETAILS_INVALID,
  ORGANIZATION_PROFILE_INCOMPLETE,
  AUTHORITY_STATEMENT_VERSION,
  authorityStatement,
  normalizeUsPhone,
  usProfileIneligibility,
  validateUsOrganizationDetails,
  type ProfileAddressFields,
  type UsOrganizationDetails,
} from './lib/util/us-organization.js';

// Domain-Enforcement P3 (LOCKED) — one organization per email domain: the domain
// claim (PROVISIONAL | AUTHORITATIVE | LAPSED | RELEASED), its operator actions
// and the opt-in expiry sweep.
export {
  DomainClaimService,
  DOMAIN_CLAIM_PROVISIONAL_DAYS,
  DOMAIN_CLAIM_STATES,
  domainUnavailableError,
  isHolderIndexViolation,
  normalizeClaimDomain,
  type DomainClaimState,
  type DomainClaimTx,
  type DomainClaimView,
  type DomainExceptionView,
  type PromoteOutcome,
} from './lib/domain-claim/domain-claim.service.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) — Personal (Free) signup:
// eligibility (§6.6), activation mode + pilot cap (§10), risk rating (§6.2), one-time
// codes (§3.2 / §6.3), the GeoIP / SMS / robot-check ports, the tenant risk state +
// send gate (§6.3–§6.6) and the signup / invite / lapse store (§3, §7, §10).
export {
  PERSONAL_ALLOWED_COUNTRIES,
  DEFAULT_PERSONAL_ALLOWED_COUNTRIES,
  phoneRegion,
  normalizeE164,
  PERSONAL_SIGNUP_MODES,
  personalSignupMode,
  DEFAULT_PERSONAL_PILOT_CAP,
  personalPilotCap,
  type PersonalSignupMode,
} from './lib/util/personal-eligibility.js';
export {
  PERSONAL_RISK_DECISIONS,
  DEFAULT_PERSONAL_RISK_CONFIG,
  personalRiskConfig,
  decisionForPoints,
  looksRandom,
  ratePersonalSignup,
  type PersonalRiskDecision,
  type PersonalRiskConfig,
  type PersonalRiskResult,
  type PersonalRiskSignal,
  type PersonalSignupSignalsInput,
  type NetworkKind,
  type RobotVerdict,
} from './lib/personal/personal-risk-rating.js';
export {
  PERSONAL_OTP_DIGITS,
  PERSONAL_OTP_TTL_MS,
  PERSONAL_OTP_MAX_ATTEMPTS,
  PERSONAL_OTP_RESEND_GAP_MS,
  PERSONAL_OTP_MAX_SENDS_PER_DAY,
  generatePersonalOtp,
  hashPersonalOtp,
  checkPersonalOtp,
  mayResendPersonalOtp,
  type PersonalOtpChannel,
  type PersonalOtpCheck,
} from './lib/personal/personal-otp.js';
export {
  GEO_IP_PORT,
  GEOIP_RECHECK_MS,
  MaxmindGeoIpAdapter,
  HOSTING_ASN_KEYWORDS,
  geoEvidenceOf,
  mmdbVersion,
  safeGeoLookup,
  unknownGeoEvidence,
  type GeoEvidence,
  type GeoIpLookup,
  type GeoIpPort,
} from './lib/personal/geo-ip.port.js';
export {
  SMS_VERIFICATION_PORT,
  LogSmsAdapter,
  DisabledSmsAdapter,
  smsVerificationAdapterFromEnv,
  type SmsVerificationPort,
} from './lib/personal/sms-verification.port.js';
export {
  ROBOT_CHECK_PORT,
  TurnstileRobotCheckAdapter,
  DisabledRobotCheck,
  TestModeRobotCheck,
  TURNSTILE_SITEVERIFY_URL,
  robotCheckAdapterFromEnv,
  type RobotCheckPort,
} from './lib/personal/robot-check.port.js';
export {
  PersonalRiskService,
  TENANT_RISK_STATES,
  evaluatePersonalSend,
  restrictionInForce,
  sendLocation,
  SEND_LOCATION_YOUNG_ACCOUNT_DAYS,
  type SendLocation,
  type TenantRiskStateValue,
  type TenantRiskStateView,
  type PersonalSendRefusal,
  type PersonalSendVerdict,
} from './lib/personal/personal-risk.service.js';
export {
  PersonalSignupRepository,
  PERSONAL_SIGNUP_TTL_MS,
  PERSONAL_INVITE_TTL_MS,
  PERSONAL_UNBOUND_LAPSE_DAYS,
  PERSONAL_ABANDONED_PURGE_DAYS,
  PERSONAL_REFUSED_RETENTION_DAYS,
  PERSONAL_ABANDONED_STATUSES,
  PERSONAL_PROVISIONING_STALE_MS,
  generatePersonalInviteCode,
  hashPersonalInviteCode,
  initialRiskState,
  geoEvidenceFromJson,
  type PersonalSignupRow,
  type PersonalSignupStatus,
  type PersonalReviewItem,
} from './lib/personal/personal-signup.repository.js';
