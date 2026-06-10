import { Injectable, Logger } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

// Per directive §3 + §8.2 step 9. Cognito ID token verification:
//   - Signature against Cognito JWKS (fetched + cached per
//     §3 Cognito verification key sourcing).
//   - iss matches expected Cognito issuer URL.
//   - aud matches AUTH_COGNITO_CLIENT_ID.
//   - exp not past.
//   - email present.
//   - email_verified === true.
//   - token_use === "id".
//
// Failure of any check → caller maps to 500 INTERNAL_ERROR with
// `error.details.reason = "cognito_verification_failed"`.

export interface CognitoIdTokenClaims extends JWTPayload {
  email?: string;
  email_verified?: boolean;
  token_use?: string;
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
      throw new Error('cognito_id_token_missing_sub');
    }
    if (typeof p.email !== 'string' || p.email.length === 0) {
      throw new Error('cognito_id_token_missing_email');
    }
    if (p.email_verified !== true) {
      throw new Error('cognito_id_token_email_not_verified');
    }
    if (p.token_use !== 'id') {
      throw new Error('cognito_id_token_wrong_token_use');
    }
    return {
      sub: p.sub,
      email: p.email,
      email_verified: true,
      token_use: 'id',
    };
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
