import { describe, expect, it } from 'vitest';

import { redactPii, luhnCheck, abaCheck } from '../lib/redaction.js';

// M5 PR-5 §4.15 — redaction unit spec. Five PII patterns + Luhn / ABA
// validation gates per directive Ruling 6.

describe('redactPii', () => {
  it('redacts a US SSN', () => {
    const r = redactPii('SSN 123-45-6789 is here');
    expect(r.redactedText).toBe('SSN [REDACTED:SSN] is here');
    expect(r.spanCount).toBe(1);
  });

  it('does not redact an invalid SSN with area 000', () => {
    const r = redactPii('SSN 000-12-3456');
    expect(r.redactedText).toBe('SSN 000-12-3456');
    expect(r.spanCount).toBe(0);
  });

  it('redacts an email address', () => {
    const r = redactPii('Contact me at a.user@example.com today');
    expect(r.redactedText).toBe('Contact me at [REDACTED:EMAIL] today');
    expect(r.spanCount).toBe(1);
  });

  it('redacts a US phone number', () => {
    const r = redactPii('Call (555) 123-4567 now');
    expect(r.redactedText).toBe('Call [REDACTED:PHONE] now');
    expect(r.spanCount).toBe(1);
  });

  it('redacts a Luhn-valid credit-card number', () => {
    // 4242424242424242 is the canonical Stripe test Luhn-valid card.
    const r = redactPii('CC 4242424242424242 saved');
    expect(r.redactedText).toBe('CC [REDACTED:CC] saved');
    expect(r.spanCount).toBe(1);
  });

  it('does NOT redact a Luhn-invalid 16-digit number', () => {
    const r = redactPii('Bogus 1234567812345678');
    expect(r.redactedText).toBe('Bogus 1234567812345678');
    expect(r.spanCount).toBe(0);
  });

  it('redacts an ABA-valid 9-digit routing number', () => {
    // 011000015 = canonical Federal Reserve Bank Boston routing.
    const r = redactPii('Route 011000015 to account');
    expect(r.redactedText).toBe('Route [REDACTED:ROUTING] to account');
    expect(r.spanCount).toBe(1);
  });

  it('does NOT redact an ABA-invalid 9-digit number (also rejected as SSN by area=987)', () => {
    // SSN regex rejects 9XX area numbers; ABA check fails; so 987654321
    // passes through unredacted across all 5 patterns.
    const r = redactPii('Bogus 987654321');
    expect(r.redactedText).toBe('Bogus 987654321');
    expect(r.spanCount).toBe(0);
  });

  it('redacts multiple PII spans in one string with combined count', () => {
    const r = redactPii('user@x.com and 123-45-6789 together');
    expect(r.redactedText).toBe('[REDACTED:EMAIL] and [REDACTED:SSN] together');
    expect(r.spanCount).toBe(2);
  });

  it('returns spanCount = 0 for clean text', () => {
    const r = redactPii('No PII in this sentence.');
    expect(r.redactedText).toBe('No PII in this sentence.');
    expect(r.spanCount).toBe(0);
  });

  it('luhnCheck returns true for a known-valid card', () => {
    expect(luhnCheck('4242424242424242')).toBe(true);
  });

  it('abaCheck returns true for 011000015 and false for 123456789', () => {
    expect(abaCheck('011000015')).toBe(true);
    expect(abaCheck('123456789')).toBe(false);
  });
});
