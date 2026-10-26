// OAuth 2.0 PKCE (RFC 7636, S256) plus `state` and `nonce` for the public native
// client (M-A1 §3.2). The verifier never leaves the device except in the token POST.
import * as Crypto from 'expo-crypto';

import { base64UrlEncode, utf8Encode } from '../util/bytes';

export interface CryptoPort {
  randomBytes(count: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
}

export const platformCrypto: CryptoPort = {
  randomBytes: (count) => Crypto.getRandomBytes(count),
  sha256: async (data) =>
    new Uint8Array(
      await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data as Uint8Array<ArrayBuffer>),
    ),
};

/** 32 random bytes as base64url: 43 chars, within RFC 7636's 43..128 verifier range. */
export function randomUrlSafe(crypto: CryptoPort, bytes = 32): string {
  return base64UrlEncode(crypto.randomBytes(bytes));
}

export async function codeChallengeS256(verifier: string, crypto: CryptoPort): Promise<string> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error('invalid PKCE verifier');
  return base64UrlEncode(await crypto.sha256(utf8Encode(verifier)));
}

export interface AuthRequestSecrets {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly state: string;
  readonly nonce: string;
}

/** Fresh, independent values for ONE authorization attempt. */
export async function createAuthRequestSecrets(
  crypto: CryptoPort = platformCrypto,
): Promise<AuthRequestSecrets> {
  const codeVerifier = randomUrlSafe(crypto, 32);
  return {
    codeVerifier,
    codeChallenge: await codeChallengeS256(codeVerifier, crypto),
    state: randomUrlSafe(crypto, 16),
    nonce: randomUrlSafe(crypto, 16),
  };
}

/** Constant-time string comparison for `state`. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
