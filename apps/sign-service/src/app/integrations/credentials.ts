import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Sign Unified Product S-4 — credential and token material. Every secret is 32
// bytes of CSPRNG output; only its sha256(base64url) digest is ever stored (the
// signing-token precedent, libs/sign signing-token.ts). The prefixes make a
// leaked value recognisable for secret scanning.

export const SIGN_API_AUDIENCE = 'aramo-sign-api';
// Integration access tokens are short-lived (directive §4.4.3).
export const SIGN_ACCESS_TOKEN_TTL_SECONDS = 300;

const material = (prefix: string): string => `${prefix}${randomBytes(32).toString('base64url')}`;

export const newClientId = (): string => `sgc_${randomBytes(18).toString('base64url')}`;
export const newClientSecret = (): string => material('sgs_');
export const newAccessToken = (): string => material('sgt_');

export function digest(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('base64url');
}

// Constant-time comparison of a presented secret with a stored digest.
export function secretMatches(presented: string, storedDigest: string): boolean {
  const a = Buffer.from(digest(presented), 'utf8');
  const b = Buffer.from(storedDigest, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
