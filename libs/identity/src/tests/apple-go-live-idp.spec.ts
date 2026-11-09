import { describe, expect, it } from 'vitest';

import {
  FEDERATED_IDPS,
  PERSONAL_IDPS,
  idpAllowedForTenantKind,
  normalizeIdp,
} from '../lib/identity-provider-policy.service.js';
import {
  LINK_OTP_MAX_ATTEMPTS,
  checkLinkOtp,
  generateLinkOtp,
  hashLinkOtp,
  mayResendLinkOtp,
} from '../lib/account-link/link-otp.js';
import { hashLinkHandle } from '../lib/account-link/identity-link.service.js';

// Apple Go-Live (LOCKED) R-1 / R-4 and Amendment A1 (LOCKED) L-4 — pure units.

describe('Apple Go-Live R-1 — provider normalization', () => {
  it('apple is a federated provider; SignInWithApple aliases to apple', () => {
    expect(FEDERATED_IDPS).toEqual(['google', 'microsoft', 'apple']);
    expect(normalizeIdp('apple')).toBe('apple');
    expect(normalizeIdp(' Apple ')).toBe('apple');
    expect(normalizeIdp('SignInWithApple')).toBe('apple');
    expect(normalizeIdp('signinwithapple')).toBe('apple');
    expect(normalizeIdp('google')).toBe('google');
    expect(normalizeIdp('facebook')).toBeNull();
    expect(normalizeIdp('ambiguous')).toBe('ambiguous');
  });
});

describe('Apple Go-Live R-4 — Personal provider set', () => {
  it('PERSONAL allows google and apple, refuses microsoft; BUSINESS allows all three', () => {
    expect(PERSONAL_IDPS).toEqual(['google', 'apple']);
    expect(idpAllowedForTenantKind('PERSONAL', 'google')).toBe(true);
    expect(idpAllowedForTenantKind('PERSONAL', 'apple')).toBe(true);
    expect(idpAllowedForTenantKind('PERSONAL', 'microsoft')).toBe(false);
    for (const idp of FEDERATED_IDPS) {
      expect(idpAllowedForTenantKind('BUSINESS', idp)).toBe(true);
      expect(idpAllowedForTenantKind(null, idp)).toBe(true);
    }
  });
});

describe('A1 L-4 (b) — link email code', () => {
  const now = new Date('2026-11-08T12:00:00Z');
  const later = new Date(now.getTime() + 60_000);
  it('6 digits; hash bound to the link', () => {
    const code = generateLinkOtp();
    expect(code).toMatch(/^\d{6}$/);
    expect(hashLinkOtp('link-a', code)).not.toBe(hashLinkOtp('link-b', code));
  });
  it('ok / mismatch / expired / exhausted / none', () => {
    const state = { hash: hashLinkOtp('l', '123456'), expires_at: later, attempts: 0 };
    expect(checkLinkOtp(state, 'l', '123456', now)).toBe('ok');
    expect(checkLinkOtp(state, 'l', ' 123456 ', now)).toBe('ok');
    expect(checkLinkOtp(state, 'l', '654321', now)).toBe('mismatch');
    expect(checkLinkOtp(state, 'other', '123456', now)).toBe('mismatch');
    expect(checkLinkOtp(state, 'l', 'abc', now)).toBe('mismatch');
    expect(checkLinkOtp({ ...state, expires_at: now }, 'l', '123456', now)).toBe('expired');
    expect(checkLinkOtp({ ...state, attempts: LINK_OTP_MAX_ATTEMPTS }, 'l', '123456', now)).toBe('exhausted');
    // No code issued (unknown email at start) is counted, then exhausted like any other.
    expect(checkLinkOtp({ hash: null, expires_at: null, attempts: 0 }, 'l', '123456', now)).toBe('none');
    expect(checkLinkOtp({ hash: null, expires_at: null, attempts: 5 }, 'l', '123456', now)).toBe('exhausted');
  });
  it('resend: 60 s gap and at most 5 sends', () => {
    expect(mayResendLinkOtp({ last_sent_at: null, sends: 0, now })).toBe(true);
    expect(mayResendLinkOtp({ last_sent_at: new Date(now.getTime() - 59_000), sends: 1, now })).toBe(false);
    expect(mayResendLinkOtp({ last_sent_at: new Date(now.getTime() - 60_000), sends: 1, now })).toBe(true);
    expect(mayResendLinkOtp({ last_sent_at: null, sends: 5, now })).toBe(false);
  });
  it('the handle is stored only as its SHA-256 (base64url)', () => {
    const h = hashLinkHandle('Q'.repeat(43));
    expect(h).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h).not.toContain('QQQQ');
  });
});
