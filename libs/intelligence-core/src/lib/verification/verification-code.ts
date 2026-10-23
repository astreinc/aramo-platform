import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { VERIFICATION_CODE_LENGTH } from '@aramo/intelligence-contracts';

// ATI-SEP-1 T4 — the one-time code. It is NEVER stored and never travels through
// the outbox: it is DERIVED when needed as
//
//     HMAC-SHA256(INTELLIGENCE_VERIFICATION_CODE_KEY, verification_id ':' code_salt)
//       → first 4 bytes as uint32 → mod 10^6 → zero-padded to 6 digits
//
// and the row stores only code_hash = sha256(code_salt ':' code). A database
// read alone yields neither the code nor a way to derive it.

export const INTELLIGENCE_VERIFICATION_CODE_KEY_ENV = 'INTELLIGENCE_VERIFICATION_CODE_KEY';
const MIN_KEY_LENGTH = 32;

export class VerificationUnavailableError extends Error {
  constructor() {
    super(`${INTELLIGENCE_VERIFICATION_CODE_KEY_ENV} is not configured (>= ${MIN_KEY_LENGTH} characters) — verification is unavailable.`);
    this.name = 'VerificationUnavailableError';
  }
}

export const VERIFICATION_CODE_SERVICE = Symbol('VERIFICATION_CODE_SERVICE');

export class VerificationCodeService {
  private constructor(private readonly key: string | null) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): VerificationCodeService {
    const key = env[INTELLIGENCE_VERIFICATION_CODE_KEY_ENV]?.trim() ?? '';
    return new VerificationCodeService(key.length >= MIN_KEY_LENGTH ? key : null);
  }

  static withKey(key: string): VerificationCodeService {
    if (key.length < MIN_KEY_LENGTH) throw new VerificationUnavailableError();
    return new VerificationCodeService(key);
  }

  get available(): boolean {
    return this.key !== null;
  }

  newSalt(): string {
    return randomBytes(16).toString('hex');
  }

  codeFor(verificationId: string, salt: string): string {
    if (this.key === null) throw new VerificationUnavailableError();
    const mac = createHmac('sha256', this.key).update(`${verificationId}:${salt}`, 'utf8').digest();
    const n = mac.readUInt32BE(0) % 10 ** VERIFICATION_CODE_LENGTH;
    return String(n).padStart(VERIFICATION_CODE_LENGTH, '0');
  }

  static hash(salt: string, code: string): string {
    return createHash('sha256').update(`${salt}:${code}`, 'utf8').digest('hex');
  }

  static matches(salt: string, code: string, storedHash: string): boolean {
    const a = Buffer.from(VerificationCodeService.hash(salt, code), 'utf8');
    const b = Buffer.from(storedHash, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
