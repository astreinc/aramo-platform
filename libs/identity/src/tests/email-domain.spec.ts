import { describe, expect, it } from 'vitest';

import {
  normalizeEmail,
  extractEmailDomain,
  isPersonalOrDisposableDomain,
  deriveAllowedDomainOrThrow,
  classifyEmailDomain,
  APPLE_PRIVATE_RELAY_DOMAIN,
} from '../lib/util/email-domain.js';

// Domain-Enforcement P1 — the email-domain primitives + the dataset wiring.
// Proves the two maintained npm datasets (free-email-domains +
// disposable-email-domains-js) are bundled and consulted, and that the
// single-source provision gate (deriveAllowedDomainOrThrow) throws/returns
// the documented shapes.
describe('email-domain — normalize + extract', () => {
  it('normalizeEmail trims + lowercases', () => {
    expect(normalizeEmail('  Divya@AstreInc.com  ')).toBe('divya@astreinc.com');
  });

  it('extractEmailDomain returns the normalized routing domain', () => {
    expect(extractEmailDomain('  Owner@Astreinc.COM ')).toBe('astreinc.com');
    // Uses the LAST '@' so a quoted local-part still yields the domain.
    expect(extractEmailDomain('"weird@local"@astreinc.com')).toBe(
      'astreinc.com',
    );
  });

  it('extractEmailDomain returns "" for a malformed (domain-less) input', () => {
    expect(extractEmailDomain('not-an-email')).toBe('');
  });
});

describe('email-domain — personal/disposable detection (dataset wiring)', () => {
  it('flags free/personal providers', () => {
    for (const d of ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com']) {
      expect(isPersonalOrDisposableDomain(d)).toBe(true);
    }
  });

  it('flags disposable/throwaway providers', () => {
    expect(isPersonalOrDisposableDomain('mailinator.com')).toBe(true);
  });

  it('does NOT flag a business domain', () => {
    expect(isPersonalOrDisposableDomain('astreinc.com')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isPersonalOrDisposableDomain('GMAIL.COM')).toBe(true);
  });
});

describe('email-domain — deriveAllowedDomainOrThrow (single-source provision gate)', () => {
  it('returns the normalized business domain', () => {
    expect(deriveAllowedDomainOrThrow('Owner@Astreinc.com', 'rq')).toBe(
      'astreinc.com',
    );
  });

  it('throws personal_email_not_allowed for a personal provider', () => {
    expect(() => deriveAllowedDomainOrThrow('a@gmail.com', 'rq')).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        context: expect.objectContaining({
          details: expect.objectContaining({
            reason: 'personal_email_not_allowed',
          }),
        }),
      }),
    );
  });

  it('throws invalid_owner_email for a malformed email', () => {
    expect(() => deriveAllowedDomainOrThrow('garbage', 'rq')).toThrowError(
      expect.objectContaining({
        context: expect.objectContaining({
          details: expect.objectContaining({ reason: 'invalid_owner_email' }),
        }),
      }),
    );
  });
});

// Apple Go-Live R-6 — the Hide My Email relay domain is personal (never business or
// disposable), so a relay address can only take Personal signup.
describe('email-domain — Apple private relay (R-6)', () => {
  it('classes privaterelay.appleid.com as personal, case-insensitively', () => {
    expect(APPLE_PRIVATE_RELAY_DOMAIN).toBe('privaterelay.appleid.com');
    expect(classifyEmailDomain('privaterelay.appleid.com')).toBe('personal');
    expect(classifyEmailDomain('PrivateRelay.AppleID.com')).toBe('personal');
    expect(extractEmailDomain('x7k2abc@privaterelay.appleid.com')).toBe('privaterelay.appleid.com');
  });
  it('is refused as a tenant owner domain (business signup)', () => {
    expect(isPersonalOrDisposableDomain('privaterelay.appleid.com')).toBe(true);
    expect(() => deriveAllowedDomainOrThrow('x7k2abc@privaterelay.appleid.com', 'r')).toThrow();
  });
  it('does not widen to other appleid.com hosts', () => {
    expect(classifyEmailDomain('appleid.com')).not.toBe('personal');
  });
});
