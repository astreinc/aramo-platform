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
  private cachedDomain: string | undefined;

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
    const jwks = this.resolveJwks(domain);

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
  // To keep the directive's contract, we treat AUTH_COGNITO_DOMAIN as the
  // hosted-UI domain (used for the JWKS URL) and require the issuer URL
  // to be set via convention: the JWKS endpoint in Cognito sits at
  // `https://${domain}/.well-known/jwks.json`. For the `iss` claim
  // matching, AWS publishes the userpool URL; if AUTH_COGNITO_ISSUER is
  // set we use that, else we derive `https://${domain}` (which matches
  // hosted-UI domains for development setups). Operational deployments
  // SHOULD set AUTH_COGNITO_ISSUER explicitly.
  private deriveIssuer(domain: string): string {
    const explicit = process.env['AUTH_COGNITO_ISSUER'];
    if (explicit !== undefined && explicit.length > 0) return explicit;
    return `https://${domain}`;
  }

  private resolveJwks(domain: string): ReturnType<typeof createRemoteJWKSet> {
    if (this.cachedJwks !== undefined && this.cachedDomain === domain) {
      return this.cachedJwks;
    }
    const url = new URL(`https://${domain}/.well-known/jwks.json`);
    const jwks = createRemoteJWKSet(url);
    this.cachedJwks = jwks;
    this.cachedDomain = domain;
    return jwks;
  }
}
