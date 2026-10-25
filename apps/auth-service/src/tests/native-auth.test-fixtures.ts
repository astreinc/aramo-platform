import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';

import { createLocalJWKSet, exportJWK, SignJWT, type createRemoteJWKSet, type JWK } from 'jose';
import { CognitoVerifierService } from '@aramo/auth-core';
import type {
  NativeCodeExchange,
  NativeCodeExchangeInput,
  NativeCodeExchangeResult,
} from '@aramo/auth-core';

// AUTH-SIGNIN-1 Amendment M-A1 — test doubles for the external Cognito side of
// the native exchange. NEVER calls Cognito: a fake hosted UI issues codes bound
// to (client, redirect_uri, PKCE challenge, nonce, identity) and answers the
// token endpoint the way Cognito does (invalid_grant on any mismatch / reuse),
// signing the ID token with a local RSA key that a local-JWKS verifier trusts.

export const FAKE_COGNITO_DOMAIN = 'auth.example.com';
export const FAKE_COGNITO_ISSUER = `https://${FAKE_COGNITO_DOMAIN}`;
export const NATIVE_CLIENT_ID = 'aramo-sign-native-test';
export const BROWSER_CLIENT_ID = 'aramo-browser-test';
export const APP_LINK_CALLBACK = 'https://sign.aramo.ai/auth/native/callback';
export const SCHEME_CALLBACK = 'aramosign://auth/callback';

export interface FakeIdentity {
  sub: string;
  email: string;
  // Federated provider ('google' | 'microsoft'); rides `identities[].providerName`.
  idp: 'google' | 'microsoft' | null;
}

interface IssuedCode {
  client_id: string;
  redirect_uri: string;
  challenge: string;
  nonce: string | null;
  identity: FakeIdentity;
  used: boolean;
  // Overrides used by the wrong-audience / wrong-issuer tests.
  aud?: string;
  iss?: string;
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function newVerifier(): string {
  return randomBytes(48).toString('base64url');
}

export class FakeCognito implements NativeCodeExchange {
  private readonly codes = new Map<string, IssuedCode>();
  readonly privateKey: KeyObject;
  readonly jwk: Promise<JWK>;
  exchangeCalls = 0;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.jwk = exportJWK(publicKey).then((j) => ({ ...j, kid: 'fake-cognito', alg: 'RS256', use: 'sig' }));
  }

  // The hosted UI's authorize + login: returns a fresh authorization code.
  authorize(args: {
    client_id?: string;
    redirect_uri?: string;
    verifier: string;
    nonce: string | null;
    identity: FakeIdentity;
    aud?: string;
    iss?: string;
  }): string {
    const code = randomBytes(18).toString('base64url');
    this.codes.set(code, {
      client_id: args.client_id ?? NATIVE_CLIENT_ID,
      redirect_uri: args.redirect_uri ?? APP_LINK_CALLBACK,
      challenge: pkceChallenge(args.verifier),
      nonce: args.nonce,
      identity: args.identity,
      used: false,
      ...(args.aud !== undefined ? { aud: args.aud } : {}),
      ...(args.iss !== undefined ? { iss: args.iss } : {}),
    });
    return code;
  }

  async exchange(input: NativeCodeExchangeInput): Promise<NativeCodeExchangeResult> {
    this.exchangeCalls += 1;
    const issued = this.codes.get(input.code);
    if (issued === undefined || issued.used) return { kind: 'rejected', oauth_error: 'invalid_grant' };
    if (issued.client_id !== input.client_id) return { kind: 'rejected', oauth_error: 'invalid_client' };
    if (issued.redirect_uri !== input.redirect_uri) return { kind: 'rejected', oauth_error: 'invalid_grant' };
    if (pkceChallenge(input.code_verifier) !== issued.challenge) return { kind: 'rejected', oauth_error: 'invalid_grant' };
    issued.used = true;
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      email: issued.identity.email,
      email_verified: true,
      token_use: 'id',
      ...(issued.nonce !== null ? { nonce: issued.nonce } : {}),
      ...(issued.identity.idp !== null
        ? { identities: [{ providerName: issued.identity.idp === 'google' ? 'Google' : 'microsoft' }] }
        : {}),
    };
    const jwk = await this.jwk;
    const idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid! })
      .setSubject(issued.identity.sub)
      .setIssuer(issued.iss ?? FAKE_COGNITO_ISSUER)
      .setAudience(issued.aud ?? issued.client_id)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(this.privateKey);
    return { kind: 'ok', id_token: idToken };
  }
}

// The real CognitoVerifierService, trusting the fake's key set instead of a
// remote JWKS (resolveJwks is the only override; every claim check is real).
export function localJwksVerifier(fake: FakeCognito): CognitoVerifierService {
  class LocalJwksCognitoVerifier extends CognitoVerifierService {
    private set: ReturnType<typeof createLocalJWKSet> | undefined;
    protected override resolveJwks(): ReturnType<typeof createRemoteJWKSet> {
      if (this.set === undefined) throw new Error('local jwks not loaded');
      return this.set as unknown as ReturnType<typeof createRemoteJWKSet>;
    }
    async load(): Promise<this> {
      this.set = createLocalJWKSet({ keys: [await fake.jwk] });
      return this;
    }
  }
  const v = new LocalJwksCognitoVerifier();
  // load() is awaited by callers via ensureLoaded below.
  (v as unknown as { __loading: Promise<unknown> }).__loading = v.load();
  return v;
}

export async function ensureVerifierLoaded(v: CognitoVerifierService): Promise<void> {
  await (v as unknown as { __loading: Promise<unknown> }).__loading;
}

export function nativeEnv(): Record<string, string> {
  return {
    AUTH_COGNITO_DOMAIN: FAKE_COGNITO_DOMAIN,
    AUTH_COGNITO_CLIENT_ID: BROWSER_CLIENT_ID,
    AUTH_TRUSTED_IDP_NAMES: 'google,microsoft',
    SIGN_NATIVE_COGNITO_CLIENT_ID: NATIVE_CLIENT_ID,
  };
}
