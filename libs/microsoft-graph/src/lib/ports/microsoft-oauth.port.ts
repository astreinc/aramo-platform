// COMM-C2B — Microsoft OAuth token endpoint port (R2/R4). The concrete adapter
// (apps/api composition root) performs the server-side authorization-code
// exchange and refresh over HTTPS to the Microsoft token endpoint. Tokens
// returned here are handed straight to the secret-store custody path — never to
// the browser, never to Postgres, never logged (R3).

export const MICROSOFT_OAUTH_PORT = 'MICROSOFT_OAUTH_PORT';

export interface MicrosoftTokenExchangeResult {
  readonly access_token: string;
  readonly refresh_token: string;
  /** Seconds until the access token expires (Microsoft `expires_in`). */
  readonly expires_in: number;
  readonly token_type: string;
  /** Scopes Microsoft actually granted. */
  readonly scope: string;
  /** Microsoft tenant id (`tid`) — from the id_token claims. */
  readonly ms_tenant_id: string;
  /** Microsoft user/object id (`oid`/`sub`) — from the id_token claims. */
  readonly ms_object_id: string;
}

export interface AuthorizationCodeExchangeArgs {
  readonly code: string;
  readonly codeVerifier: string;
  readonly clientId: string;
  /** Confidential-client secret (resolved from the connector secret path, R3). */
  readonly clientSecret?: string;
  readonly redirectUri: string;
  readonly authorityTenant?: string;
}

export interface RefreshArgs {
  readonly refreshToken: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly authorityTenant?: string;
}

/** Signals Microsoft rejected the refresh (revoked/expired consent) — R4/R19. */
export class MicrosoftConsentRevokedError extends Error {
  constructor(message = 'microsoft consent revoked or expired') {
    super(message);
    this.name = 'MicrosoftConsentRevokedError';
  }
}

export interface MicrosoftOAuthPort {
  exchangeAuthorizationCode(args: AuthorizationCodeExchangeArgs): Promise<MicrosoftTokenExchangeResult>;
  /** Throws MicrosoftConsentRevokedError when the refresh is rejected (R4). */
  refresh(args: RefreshArgs): Promise<MicrosoftTokenExchangeResult>;
}
