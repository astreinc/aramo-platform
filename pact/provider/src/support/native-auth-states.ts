import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';

import { createLocalJWKSet, exportJWK, SignJWT, type createRemoteJWKSet, type JWK } from 'jose';
import {
  CognitoVerifierService,
  type NativeCodeExchange,
  type NativeCodeExchangeInput,
  type NativeCodeExchangeResult,
} from '@aramo/auth-core';

// AUTH-SIGNIN-1 Amendment M-A1 — provider-side support for the sign-mobile pact
// (pact/consumers/sign-mobile). Cognito is NEVER contacted: a fake token endpoint
// sits behind NATIVE_CODE_EXCHANGE and signs ID tokens with a local key that a
// local-JWKS CognitoVerifierService trusts (every claim check stays real). The
// fixed values MUST match pact/consumers/sign-mobile/src/native-auth.consumer.test.ts.

export const PACT_NATIVE_CLIENT_ID = 'pact-sign-native-client';
export const PACT_NATIVE_CODE = 'pact-native-authorization-code';
export const PACT_NATIVE_VERIFIER = 'pact-native-code-verifier-0123456789abcdefghijklmnop';
export const PACT_NATIVE_NONCE = 'pact-native-nonce-0001';
export const PACT_NATIVE_REFRESH = 'pact-native-refresh-token-0001';
export const PACT_NATIVE_BEARER = 'Bearer pact-native-access-token';
export const PACT_NATIVE_SUB = 'pact-native-cognito-sub';
export const PACT_NATIVE_REDIRECT = 'https://sign.aramo.ai/auth/native/callback';

export function sha256Base64Url(s: string): string {
  return createHash('sha256').update(s).digest('base64url');
}

interface Registered {
  verifier_challenge: string;
  nonce: string;
}

// The fake Cognito token endpoint: a code is redeemable once, only by the native
// client, the registered redirect and the matching PKCE verifier.
export class PactFakeCognito implements NativeCodeExchange {
  private readonly codes = new Map<string, Registered>();
  private readonly key: KeyObject;
  readonly jwk: Promise<JWK>;
  readonly issuer: string;

  constructor(domain: string) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.key = privateKey;
    this.jwk = exportJWK(publicKey).then((j) => ({ ...j, kid: 'pact-fake-cognito', alg: 'RS256', use: 'sig' }));
    this.issuer = `https://${domain}`;
  }

  register(code: string, verifier: string, nonce: string): void {
    this.codes.set(code, { verifier_challenge: sha256Base64Url(verifier), nonce });
  }

  async exchange(input: NativeCodeExchangeInput): Promise<NativeCodeExchangeResult> {
    const r = this.codes.get(input.code);
    if (
      r === undefined ||
      input.client_id !== PACT_NATIVE_CLIENT_ID ||
      input.redirect_uri !== PACT_NATIVE_REDIRECT ||
      sha256Base64Url(input.code_verifier) !== r.verifier_challenge
    ) {
      return { kind: 'rejected', oauth_error: 'invalid_grant' };
    }
    this.codes.delete(input.code);
    const jwk = await this.jwk;
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({
      email: 'pact@aramo.dev',
      email_verified: true,
      token_use: 'id',
      nonce: r.nonce,
      identities: [{ providerName: 'Google' }],
    })
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid! })
      .setSubject(PACT_NATIVE_SUB)
      .setIssuer(this.issuer)
      .setAudience(PACT_NATIVE_CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(this.key);
    return { kind: 'ok', id_token: idToken };
  }

  // The real verifier, trusting this fake's key set instead of a remote JWKS.
  async verifier(): Promise<CognitoVerifierService> {
    const set = createLocalJWKSet({ keys: [await this.jwk] });
    class LocalJwksCognitoVerifier extends CognitoVerifierService {
      protected override resolveJwks(): ReturnType<typeof createRemoteJWKSet> {
        return set as unknown as ReturnType<typeof createRemoteJWKSet>;
      }
    }
    return new LocalJwksCognitoVerifier();
  }
}
