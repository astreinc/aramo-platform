import { Injectable, Logger } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

// Per directive §3 + §8.2 step 9. Cognito ID token verification:
//   - Signature against Cognito JWKS (fetched + cached per
//     §3 Cognito verification key sourcing).
//   - iss matches expected Cognito issuer URL.
//   - aud matches AUTH_COGNITO_CLIENT_ID.
//   - exp not past.
//   - email present.
//   - email_verified satisfied (see normalization below).
//   - token_use === "id".
//
// Error CLASSING (Super-Admin-Login P4): token-content rejections
// (missing sub/email, email_not_verified, wrong token_use) throw a typed
// `CognitoVerificationError` so the orchestrator maps them to a 4xx
// auth_error (the IdP gave us a token we reject — a client/config fault,
// debuggable). Signature / JWKS / network / iss / aud / exp failures come
// out of jose's jwtVerify as plain Errors and remain 500 (genuine server
// or infra faults). The discriminator is `instanceof CognitoVerificationError`.
//
// email_verified normalization (Super-Admin-Login P1, verifier-side):
// Cognito emits `email_verified` as a real boolean for native users, but a
// federated IdP (Microsoft) surfaces it as the STRING "true". We accept the
// string ONLY when the token presents a trusted-federation provider signal
// (the `identities[].providerName` / `cognito:username` prefix, matched
// against AUTH_TRUSTED_IDP_NAMES). Native / untrusted tokens keep the strict
// boolean `=== true` gate. The gate is PARSED (we read the IdP's verified
// assertion), never REMOVED — an unverified native email still fails. The
// pre-token-generation Lambda is the full-milestone PROD normalization; this
// is the contained slice mechanism (no net-new Lambda/Terraform).

// Token-content rejection (4xx auth_error class). `reason` is surfaced as
// the orchestrator's auth_error reason and the controller's details.reason.
export class CognitoVerificationError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'CognitoVerificationError';
  }
}

interface CognitoFederatedIdentity {
  providerName?: string;
  providerType?: string;
  userId?: string;
}

export interface CognitoIdTokenClaims extends JWTPayload {
  email?: string;
  // boolean for native Cognito users; string "true"/"false" for federated.
  email_verified?: boolean | string;
  token_use?: string;
  // Federated-provider signals (present only on federated tokens). The
  // verifier did not read these pre-Super-Admin-Login; they scope the
  // string-normalization to trusted federation.
  identities?: CognitoFederatedIdentity[];
  'cognito:username'?: string;
}

export interface VerifiedCognitoIdToken {
  sub: string;
  email: string;
  email_verified: boolean;
  token_use: 'id';
}

@Injectable()
export class CognitoVerifierService {
  private readonly logger = new Logger(CognitoVerifierService.name);
  private cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  private cachedIssuer: string | undefined;

  async verify(idToken: string): Promise<VerifiedCognitoIdToken> {
    const domain = process.env['AUTH_COGNITO_DOMAIN'];
    const clientId = process.env['AUTH_COGNITO_CLIENT_ID'];
    if (domain === undefined || domain.length === 0) {
      throw new Error('AUTH_COGNITO_DOMAIN is not configured');
    }
    if (clientId === undefined || clientId.length === 0) {
      throw new Error('AUTH_COGNITO_CLIENT_ID is not configured');
    }
    const expectedIssuer = this.deriveIssuer(domain);
    const jwks = this.resolveJwks(expectedIssuer);

    const result = await jwtVerify<CognitoIdTokenClaims>(idToken, jwks, {
      issuer: expectedIssuer,
      audience: clientId,
      algorithms: ['RS256'],
    });
    const p = result.payload;
    if (typeof p.sub !== 'string' || p.sub.length === 0) {
      throw new CognitoVerificationError('missing_sub');
    }
    if (typeof p.email !== 'string' || p.email.length === 0) {
      throw new CognitoVerificationError('missing_email');
    }
    if (!this.isEmailVerified(p)) {
      throw new CognitoVerificationError('email_not_verified');
    }
    if (p.token_use !== 'id') {
      throw new CognitoVerificationError('wrong_token_use');
    }
    return {
      sub: p.sub,
      email: p.email,
      email_verified: true,
      token_use: 'id',
    };
  }

  // email_verified gate with trusted-federation normalization (P1).
  //   - boolean `true` always passes (native + already-normalized federation).
  //   - string "true" passes ONLY for a trusted-federation provider.
  //   - everything else (false, "false", undefined, string "true" from an
  //     untrusted/native token) FAILS — the gate is intact.
  private isEmailVerified(p: CognitoIdTokenClaims): boolean {
    if (p.email_verified === true) return true;
    if (p.email_verified === 'true' && this.isTrustedFederation(p)) return true;
    return false;
  }

  // Reads the federated-provider signal (the `identities[].providerName`
  // claim, with a `cognito:username` "<ProviderName>_..." prefix fallback)
  // and matches it against AUTH_TRUSTED_IDP_NAMES (comma-separated, case-
  // insensitive). Empty config → no provider is trusted, so string-form
  // email_verified never passes (fail-closed). This is the signal the
  // verifier did not previously read.
  private isTrustedFederation(p: CognitoIdTokenClaims): boolean {
    const configured = (process.env['AUTH_TRUSTED_IDP_NAMES'] ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    if (configured.length === 0) return false;

    if (Array.isArray(p.identities)) {
      for (const ident of p.identities) {
        const name = (ident?.providerName ?? '').toLowerCase();
        if (name.length > 0 && configured.includes(name)) return true;
      }
    }

    const username =
      typeof p['cognito:username'] === 'string' ? p['cognito:username'] : '';
    const underscore = username.indexOf('_');
    if (underscore > 0) {
      const prefix = username.slice(0, underscore).toLowerCase();
      if (configured.includes(prefix)) return true;
    }
    return false;
  }

  // Cognito issuer URL pattern, per AWS docs:
  // https://cognito-idp.<region>.amazonaws.com/<userPoolId>
  // The hosted-UI domain (AUTH_COGNITO_DOMAIN) is distinct from the issuer
  // URL. PR-8.0a-Reground accepts either an explicit override env or the
  // canonical Cognito issuer derivation.
  //
  // A real Cognito user pool emits `iss` = the userpool URL
  //   https://cognito-idp.<region>.amazonaws.com/<userPoolId>
  // and serves its JWKS at `<iss>/.well-known/jwks.json` — NOT under the
  // hosted-UI domain. So when AUTH_COGNITO_ISSUER is set we use it for both
  // the `iss` check (deriveIssuer) AND the JWKS URL (resolveJwks). When it
  // is unset we fall back to `https://${domain}`, preserving the original
  // dev/hosted-domain behaviour where issuer and JWKS share the domain.
  // Operational deployments against a real pool MUST set AUTH_COGNITO_ISSUER.
  private deriveIssuer(domain: string): string {
    const explicit = process.env['AUTH_COGNITO_ISSUER'];
    if (explicit !== undefined && explicit.length > 0) return explicit;
    return `https://${domain}`;
  }

  // JWKS URL is derived from the (issuer) base so it tracks a real pool's
  // cognito-idp endpoint when AUTH_COGNITO_ISSUER is set, and the hosted-UI
  // domain when it is not. Cache keyed on the issuer base.
  private resolveJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
    if (this.cachedJwks !== undefined && this.cachedIssuer === issuer) {
      return this.cachedJwks;
    }
    const base = issuer.replace(/\/+$/, '');
    const url = new URL(`${base}/.well-known/jwks.json`);
    const jwks = createRemoteJWKSet(url);
    this.cachedJwks = jwks;
    this.cachedIssuer = issuer;
    return jwks;
  }
}
