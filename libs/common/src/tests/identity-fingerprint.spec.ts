import { describe, expect, it } from 'vitest';

import {
  computeEmailFingerprint,
  normalizeEmail,
  loadIdentityPepper,
} from '../lib/util/identity-fingerprint.js';

// Step 4a — the tenant-side email fingerprint primitive (the I14 privacy
// wall). Tests inject an explicit pepper so they never touch the env.

const PEPPER = 'test-pepper-do-not-use-in-prod';

describe('computeEmailFingerprint', () => {
  it('is deterministic — same input + pepper yields the same fingerprint', () => {
    const a = computeEmailFingerprint('jane@example.com', PEPPER);
    const b = computeEmailFingerprint('jane@example.com', PEPPER);
    expect(a).toBe(b);
  });

  it('produces a 64-char lowercase hex digest (HMAC-SHA256)', () => {
    const fp = computeEmailFingerprint('jane@example.com', PEPPER);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different emails', () => {
    const a = computeEmailFingerprint('jane@example.com', PEPPER);
    const b = computeEmailFingerprint('john@example.com', PEPPER);
    expect(a).not.toBe(b);
  });

  it('normalizes lowercase + trim before hashing (case/whitespace insensitive)', () => {
    const canonical = computeEmailFingerprint('jane@example.com', PEPPER);
    expect(computeEmailFingerprint('JANE@example.com', PEPPER)).toBe(canonical);
    expect(computeEmailFingerprint('  Jane@Example.com  ', PEPPER)).toBe(canonical);
  });

  it('depends on the pepper — a different pepper yields a different fingerprint', () => {
    const a = computeEmailFingerprint('jane@example.com', PEPPER);
    const b = computeEmailFingerprint('jane@example.com', 'a-different-pepper');
    expect(a).not.toBe(b);
  });

  it('never leaks the raw email into the output (opaque digest)', () => {
    const fp = computeEmailFingerprint('jane@example.com', PEPPER);
    expect(fp).not.toContain('@');
    expect(fp).not.toContain('jane');
    expect(fp).not.toContain('example');
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Jane@Example.COM ')).toBe('jane@example.com');
  });
});

describe('loadIdentityPepper (fail-loud)', () => {
  const VAR = 'ARAMO_IDENTITY_PEPPER';

  it('throws a 500 AramoError when the pepper env-var is unset', () => {
    const saved = process.env[VAR];
    delete process.env[VAR];
    try {
      expect(() => loadIdentityPepper()).toThrowError(/ARAMO_IDENTITY_PEPPER/);
    } finally {
      if (saved !== undefined) process.env[VAR] = saved;
    }
  });

  it('throws when the pepper is the empty string (no silent degrade)', () => {
    const saved = process.env[VAR];
    process.env[VAR] = '';
    try {
      expect(() => loadIdentityPepper()).toThrowError(/ARAMO_IDENTITY_PEPPER/);
    } finally {
      if (saved === undefined) delete process.env[VAR];
      else process.env[VAR] = saved;
    }
  });

  it('returns the pepper when set, and computeEmailFingerprint uses it by default', () => {
    const saved = process.env[VAR];
    process.env[VAR] = PEPPER;
    try {
      expect(loadIdentityPepper()).toBe(PEPPER);
      // No explicit pepper arg → falls back to the env loader.
      expect(computeEmailFingerprint('jane@example.com')).toBe(
        computeEmailFingerprint('jane@example.com', PEPPER),
      );
    } finally {
      if (saved === undefined) delete process.env[VAR];
      else process.env[VAR] = saved;
    }
  });
});
