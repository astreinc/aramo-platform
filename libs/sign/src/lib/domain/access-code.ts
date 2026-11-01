import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED (2bd74ca5) §1.9 — the
// per-recipient ACCESS CODE a sender sets and the recipient must enter before viewing.
//
//   - Stored ONLY as a salted scrypt hash ("scrypt$N$r$p$salt$hash", base64url). The
//     code itself is never stored, returned, logged or written to the ledger.
//   - Entered once per signing session (SigningSession.access_code_verified_at).
//   - MAX_ACCESS_CODE_ATTEMPTS failed entries lock the recipient out of the envelope
//     (Signer.access_code_locked_at); every live session is revoked.
//   - Each result is a ledger event (verified / failed / locked) and the verification
//     is printed on the certificate of completion.

export const ACCESS_CODE_MIN_LENGTH = 4;
export const ACCESS_CODE_MAX_LENGTH = 32;
export const MAX_ACCESS_CODE_ATTEMPTS = 5;

export const ACCESS_CODE_VERIFIED_EVENT = 'ACCESS_CODE_VERIFIED';
export const ACCESS_CODE_FAILED_EVENT = 'ACCESS_CODE_FAILED';
export const ACCESS_CODE_LOCKED_EVENT = 'ACCESS_CODE_LOCKED';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const PREFIX = 'scrypt';

/** The normalized code (trimmed), or null when it is not a valid access code. */
export function normalizeAccessCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim();
  if (code.length < ACCESS_CODE_MIN_LENGTH || code.length > ACCESS_CODE_MAX_LENGTH) return null;
  // Printable characters only (no control characters, no line breaks).
  if (!/^[\x20-\x7E]+$/.test(code)) return null;
  return code;
}

export function hashAccessCode(code: string, salt: Buffer = randomBytes(16)): string {
  const key = scryptSync(code, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [PREFIX, String(SCRYPT_N), String(SCRYPT_R), String(SCRYPT_P), salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Constant-time comparison of an entered code with a stored hash. A malformed hash never verifies. */
export function verifyAccessCode(entered: unknown, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (!Number.isInteger(N) || !Number.isInteger(R) || !Number.isInteger(P) || N <= 1 || R <= 0 || P <= 0) return false;
  const expected = Buffer.from(keyB64, 'base64url');
  if (expected.length === 0) return false;
  // An entry that is not even a well-formed code still costs one scrypt (no timing hint).
  const code = typeof entered === 'string' ? entered.trim() : '';
  const actual = scryptSync(code, Buffer.from(saltB64, 'base64url'), expected.length, { N, r: R, p: P });
  return timingSafeEqual(actual, expected);
}
