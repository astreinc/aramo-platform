import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PRIVACY_REFERENCE_PATTERN,
  PRIVACY_REQUEST_STATUSES,
  PRIVACY_TERMINAL_STATUSES,
  PRIVACY_TRANSITIONS,
  isPrivacyTransitionLegal,
  newPrivacyReference,
  normalizePrivacyReference,
  privacyDeletionExecutionEnabled,
  privacyRequestDueAt,
} from '../lib/privacy/privacy-request.model.js';
import {
  decryptPrivacyEmail,
  encryptPrivacyEmail,
  isPlausibleEmail,
  newPrivacyProofToken,
  privacyEmailHash,
  privacyEmailKeyAvailable,
  privacyProofTokenHash,
} from '../lib/privacy/privacy-request-crypto.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.1 — the privacy-request model: the TM-L12
// lifecycle, the 30-day due date, the public reference, the staged execution flag
// (default OFF) and the email protection.

describe('privacy request model (M-A7 §3.1)', () => {
  it('follows RECEIVED → IDENTITY_VALIDATED → DATA_INVENTORY → (REFERRED | EXECUTING) → COMPLETED | DENIED | CANCELLED', () => {
    expect(isPrivacyTransitionLegal('RECEIVED', 'IDENTITY_VALIDATED')).toBe(true);
    expect(isPrivacyTransitionLegal('IDENTITY_VALIDATED', 'DATA_INVENTORY')).toBe(true);
    expect(isPrivacyTransitionLegal('DATA_INVENTORY', 'REFERRED_TO_ORGANIZATION')).toBe(true);
    expect(isPrivacyTransitionLegal('DATA_INVENTORY', 'EXECUTING')).toBe(true);
    expect(isPrivacyTransitionLegal('REFERRED_TO_ORGANIZATION', 'EXECUTING')).toBe(true);
    expect(isPrivacyTransitionLegal('EXECUTING', 'COMPLETED')).toBe(true);
    // No skipping identity validation or the inventory.
    expect(isPrivacyTransitionLegal('RECEIVED', 'EXECUTING')).toBe(false);
    expect(isPrivacyTransitionLegal('RECEIVED', 'DATA_INVENTORY')).toBe(false);
    expect(isPrivacyTransitionLegal('IDENTITY_VALIDATED', 'EXECUTING')).toBe(false);
    expect(isPrivacyTransitionLegal('DATA_INVENTORY', 'COMPLETED')).toBe(false);
    // Terminal statuses are final.
    for (const t of PRIVACY_TERMINAL_STATUSES) expect(PRIVACY_TRANSITIONS[t]).toEqual([]);
    expect(Object.keys(PRIVACY_TRANSITIONS).sort()).toEqual([...PRIVACY_REQUEST_STATUSES].sort());
  });

  it('is due 30 days after receipt', () => {
    const at = new Date('2026-10-28T00:00:00.000Z');
    expect(privacyRequestDueAt(at).toISOString()).toBe('2026-11-27T00:00:00.000Z');
  });

  it('references are PR-XXXX-XXXX-XXXX in Crockford base32 and normalize from typed input', () => {
    for (let i = 0; i < 200; i += 1) expect(newPrivacyReference()).toMatch(PRIVACY_REFERENCE_PATTERN);
    expect(newPrivacyReference(Buffer.alloc(12, 0))).toBe('PR-0000-0000-0000');
    expect(normalizePrivacyReference(' pr-7k3m-9qx2-h4td ')).toBe('PR-7K3M-9QX2-H4TD');
    expect(normalizePrivacyReference('PR-7K3M-9QX2-H4TU')).toBeNull();
    expect(normalizePrivacyReference(42)).toBeNull();
  });

  it('staged execution is OFF unless the flag is exactly 1', () => {
    expect(privacyDeletionExecutionEnabled({})).toBe(false);
    expect(privacyDeletionExecutionEnabled({ SIGN_PRIVACY_DELETION_EXECUTION_ENABLED: '' })).toBe(false);
    expect(privacyDeletionExecutionEnabled({ SIGN_PRIVACY_DELETION_EXECUTION_ENABLED: 'true' })).toBe(false);
    expect(privacyDeletionExecutionEnabled({ SIGN_PRIVACY_DELETION_EXECUTION_ENABLED: '0' })).toBe(false);
    expect(privacyDeletionExecutionEnabled({ SIGN_PRIVACY_DELETION_EXECUTION_ENABLED: '1' })).toBe(true);
  });
});

describe('privacy request email protection', () => {
  const env = { PRIVACY_REQUEST_EMAIL_KEY: randomBytes(32).toString('base64') };
  const saved = process.env['PRIVACY_REQUEST_EMAIL_KEY'];
  afterEach(() => {
    if (saved === undefined) delete process.env['PRIVACY_REQUEST_EMAIL_KEY'];
    else process.env['PRIVACY_REQUEST_EMAIL_KEY'] = saved;
  });

  it('fails closed without a 32-byte key', () => {
    expect(privacyEmailKeyAvailable({})).toBe(false);
    expect(privacyEmailKeyAvailable({ PRIVACY_REQUEST_EMAIL_KEY: Buffer.alloc(16).toString('base64') })).toBe(false);
    expect(() => privacyEmailHash('a@b.co', {})).toThrow(/not configured/);
    expect(() => encryptPrivacyEmail('a@b.co', {})).toThrow(/not configured/);
  });

  it('keyed hash is case-insensitive and never the email; ciphertext round-trips', () => {
    expect(privacyEmailHash(' Pat@Example.COM ', env)).toBe(privacyEmailHash('pat@example.com', env));
    expect(privacyEmailHash('pat@example.com', env)).not.toContain('pat');
    expect(privacyEmailHash('pat@example.com', env)).not.toBe(privacyEmailHash('pat@example.com', { PRIVACY_REQUEST_EMAIL_KEY: randomBytes(32).toString('base64') }));
    const ct = encryptPrivacyEmail('Pat@Example.com', env);
    expect(ct).not.toContain('example');
    expect(decryptPrivacyEmail(ct, env)).toBe('pat@example.com');
  });

  it('proof tokens are 256-bit and stored as SHA-256 only', () => {
    const { token, token_hash } = newPrivacyProofToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(token_hash).toBe(privacyProofTokenHash(token));
    expect(token_hash).not.toContain(token);
  });

  it('accepts plausible emails only', () => {
    expect(isPlausibleEmail('pat@example.com')).toBe(true);
    expect(isPlausibleEmail('pat@example')).toBe(false);
    expect(isPlausibleEmail('pat example.com')).toBe(false);
    expect(isPlausibleEmail(7)).toBe(false);
  });
});
