// Auth-Decoupling PR-5b (ADR-0021 §4) — libs/auth-core public surface. The
// portable identity core (scope:auth): ports (tokens + interfaces), the two
// orchestrators, the three controllers, crypto/resolver services, redirect +
// portal-login helpers, and DTOs. Classes + tokens only (R-P5b-1 — NO
// AuthCoreModule); the composition root (auth.module.ts) + the adapters stay in
// apps/auth-service and import these. The scope:auth wall governs this lib; its
// closure is @aramo/common, @aramo/auth, @aramo/auth-storage — all scope:shared.

export { AUDIT_SINK } from './lib/audit-sink.port.js';
export type { AuditRecord, AuditSink } from './lib/audit-sink.port.js';
export { AuthController } from './lib/auth.controller.js';
export { CognitoVerificationError, CognitoVerifierService } from './lib/cognito-verifier.service.js';
export type { CognitoIdTokenClaims, VerifiedCognitoIdToken } from './lib/cognito-verifier.service.js';
export { CookieVerifierService } from './lib/cookie-verifier.service.js';
export type { CookieJwtPayload } from './lib/cookie-verifier.service.js';
export { ELIGIBILITY_POLICY } from './lib/eligibility-policy.port.js';
export type { EligibilityPolicy } from './lib/eligibility-policy.port.js';
export { EMAIL_SENDER } from './lib/email-sender.port.js';
export type { EmailSenderInput, EmailSenderResult, EmailSender } from './lib/email-sender.port.js';
export { HostAuthProfileService } from './lib/host-auth-profile.service.js';
export type { HostAuthResolution } from './lib/host-auth-profile.service.js';
export { HostBaseResolver } from './lib/host-base-resolver.service.js';
export { HOST_CONTEXT_DIRECTORY } from './lib/host-context-directory.port.js';
export type { HostContext, HostContextDirectory } from './lib/host-context-directory.port.js';
export { JwksController } from './lib/jwks.controller.js';
export { JwksService } from './lib/jwks.service.js';
export type { JwksKey, JwksDocument } from './lib/jwks.service.js';
export { ISSUER, ALG, ACCESS_TOKEN_TTL_SECONDS, JwtIssuerService, computeKid } from './lib/jwt-issuer.service.js';
export type { JwtIssuancePayload } from './lib/jwt-issuer.service.js';
export { PkceService } from './lib/pkce.service.js';
export type { PkcePair, PkceStatePayload } from './lib/pkce.service.js';
export { PortalAuthController } from './lib/portal-auth.controller.js';
export { PORTAL_IDENTITY_STORE } from './lib/portal-identity-store.port.js';
export type { PortalUser, PortalLoginToken, PortalIdentityStore } from './lib/portal-identity-store.port.js';
export { PortalLoginBudget } from './lib/portal-login-budget.js';
export { buildPortalLoginUrl, renderPortalLoginEmail } from './lib/portal-login-email.js';
export { PortalLoginService } from './lib/portal-login.service.js';
export type { PortalConsumeResult } from './lib/portal-login.service.js';
export { PRINCIPAL_DIRECTORY } from './lib/principal-directory.port.js';
export type { ResolveSessionInput, ResolveSessionResult, ResolveScopesInput, ResolveScopesResult, PrincipalDirectory } from './lib/principal-directory.port.js';
export { isDevPosture, parseHost, isDevHostname, deriveBaseFromHost, resolvePublicBaseUrl, deriveRedirectUri, derivePostLoginRedirect, deriveSignoutRedirect } from './lib/redirect-uri.js';
export type { ParsedHost } from './lib/redirect-uri.js';
export { RefreshOrchestratorService } from './lib/refresh-orchestrator.service.js';
export type { RefreshInput, RefreshResult } from './lib/refresh-orchestrator.service.js';
export { PORTAL_SESSION_SCOPES, SessionOrchestratorService } from './lib/session-orchestrator.service.js';
export type { CallbackInput, CallbackResult } from './lib/session-orchestrator.service.js';
export type { SessionResponseDto } from './lib/dto/session-response.dto.js';
export type { TenantSelectionTenantDto, TenantSelectionRequiredDetailsDto } from './lib/dto/tenant-selection-error.dto.js';
