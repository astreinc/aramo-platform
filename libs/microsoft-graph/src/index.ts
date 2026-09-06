// @aramo/microsoft-graph — COMM-C2B Microsoft 365 (Graph) delegated provider.
// Microsoft-specific integration/provider code lives ONLY here and in the
// apps/api composition root (R20): Lane-2, Unified Talent Journey, Engagement
// policy/readiness, and the Communication evidence reads C3 consumes stay
// provider-neutral. This barrel exports the domain + ports; adapters that touch
// the network/secret store are wired at the composition root.

export {
  FORBIDDEN_SCOPE_PATTERNS,
  MICROSOFT_DELEGATED_SCOPES,
  MS_SCOPE_MAIL_SEND,
  MS_SCOPE_OFFLINE_ACCESS,
  MS_SCOPE_ONLINE_MEETINGS_RW,
  MS_SCOPE_OPENID,
  MS_SCOPE_PROFILE,
  MS_SCOPE_USER_READ,
  MicrosoftScopeViolationError,
  assertLeastPrivilegeScopes,
  microsoftScopeParam,
  type MicrosoftDelegatedScope,
} from './lib/domain/graph-scopes.js';

export {
  MICROSOFT_CAPABILITIES,
  MICROSOFT_PROVIDER_KEY,
  type MicrosoftCapability,
} from './lib/domain/microsoft-provider.js';

export {
  TOKEN_REFRESH_SKEW_SECONDS,
  assertNoTokenMaterial,
  redactTokenBundle,
  tokenNeedsRefresh,
  type DelegatedTokenBundle,
  type RedactedTokenMetadata,
} from './lib/domain/delegated-token.js';

export {
  MICROSOFT_DEFAULT_AUTHORITY_TENANT,
  MICROSOFT_LOGIN_AUTHORITY,
  MICROSOFT_OAUTH_STATE_TTL_SECONDS,
  MicrosoftOAuthStateError,
  buildMicrosoftAuthorizeUrl,
  buildMicrosoftTokenEndpoint,
  decryptMicrosoftOAuthState,
  encryptMicrosoftOAuthState,
  generateMicrosoftPkce,
  isMicrosoftOAuthStateExpired,
  type BuildAuthorizeUrlArgs,
  type MicrosoftOAuthStatePayload,
  type MicrosoftPkcePair,
} from './lib/domain/oauth-state.js';

export {
  MicrosoftConsentRevokedError,
  MICROSOFT_OAUTH_PORT,
  type AuthorizationCodeExchangeArgs,
  type MicrosoftOAuthPort,
  type MicrosoftTokenExchangeResult,
  type RefreshArgs,
} from './lib/ports/microsoft-oauth.port.js';

export {
  DELEGATED_TOKEN_STORE,
  type DelegatedTokenBinding,
  type DelegatedTokenStorePort,
} from './lib/ports/delegated-token-store.port.js';

export {
  PROVIDER_IDENTITY_STORE,
  type ProviderIdentityBinding,
  type ProviderIdentityStatus,
  type ProviderIdentityStorePort,
  type UpsertProviderIdentityArgs,
} from './lib/ports/provider-identity-store.port.js';

export {
  MICROSOFT_GRAPH_PORT,
  type GraphCreateMeetingArgs,
  type GraphMeetingResult,
  type GraphSendMailArgs,
  type GraphUserProfile,
  type MicrosoftGraphPort,
} from './lib/ports/microsoft-graph.port.js';

export {
  DelegatedAuthorizationService,
  MicrosoftIdentityNotBoundError,
  MicrosoftReauthRequiredError,
  type AuthorizationResultView,
  type CompleteAuthorizationArgs,
  type StartAuthorizationArgs,
  type StartAuthorizationResult,
  type UsableToken,
  type UsableTokenArgs,
} from './lib/delegated-authorization.service.js';
