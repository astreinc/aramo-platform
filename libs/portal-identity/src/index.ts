// Portal P1 (ADR-0016 / Aramo-Portal-P1-Directive) — portal-identity public
// surface. The passwordless portal identity + login-token substrate. Controller-
// rail PII by design (OUTSIDE the I14 wall); its wall is the portal refusal
// regime, not a no-PII rule.
export { PortalIdentityModule } from './lib/portal-identity.module.js';
export {
  PortalIdentityRepository,
  type PortalUserRow,
  type PortalLoginTokenRow,
} from './lib/portal-identity.repository.js';
export {
  generatePortalLoginToken,
  hashPortalLoginToken,
  portalLoginExpiresAt,
  PORTAL_LOGIN_TOKEN_BYTES,
  PORTAL_LOGIN_TTL_MS,
} from './lib/portal-login-token.js';
