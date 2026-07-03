import { describe, expect, it } from 'vitest';

import { normalizeEmail, normalizePhone } from '../index.js';

// TR-2a-1 — deterministic anchor normalizers (Decision 10, no LLM). The matcher
// keys on these; they must be pure + stable.
describe('normalizePhone (digit-strip)', () => {
  it('strips every non-digit', () => {
    expect(normalizePhone('+1 (555) 123-4567')).toBe('15551234567');
    expect(normalizePhone('555-123-4567')).toBe('5551234567');
    expect(normalizePhone('555.123.4567 ext 9')).toBe('55512345679');
  });

  it('is idempotent (normalize∘normalize === normalize)', () => {
    const once = normalizePhone('+1 (555) 123-4567');
    expect(normalizePhone(once)).toBe(once);
  });

  it('returns empty string when the input has no digits', () => {
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone('n/a')).toBe('');
    expect(normalizePhone('---')).toBe('');
  });

  it('is STRICTER than E.164 — a country-code difference does NOT collapse (split-bias)', () => {
    // Deliberate: digit-strip keeps `15551234567` ≠ `5551234567`. A missed merge
    // is recoverable; a wrong merge conflates two humans.
    expect(normalizePhone('+1 555 123 4567')).not.toBe(normalizePhone('555 123 4567'));
  });
});

describe('normalizeEmail (strict trim+lowercase, reused for anchors)', () => {
  it('lowercases + trims', () => {
    expect(normalizeEmail('  Ada.Lovelace@Example.COM ')).toBe('ada.lovelace@example.com');
  });

  it('does NOT strip plus-addressing or dots (strict — fingerprint-consistent)', () => {
    expect(normalizeEmail('ada+jobs@example.com')).not.toBe(normalizeEmail('ada@example.com'));
    expect(normalizeEmail('a.b@example.com')).not.toBe(normalizeEmail('ab@example.com'));
  });
});
