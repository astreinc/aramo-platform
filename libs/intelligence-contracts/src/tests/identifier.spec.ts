import { describe, expect, it } from 'vitest';

import {
  identifierDigest,
  identifierDigestOf,
  maskIdentifierValue,
  normalizeEmailIdentifier,
  normalizeIdentifierValue,
  normalizePhoneIdentifier,
} from '../index.js';

describe('identifier helpers (ATI-SEP-1 T10 WP3b)', () => {
  it('normalizes email and phone', () => {
    expect(normalizeEmailIdentifier('  A.B@Example.COM ')).toBe('a.b@example.com');
    expect(normalizePhoneIdentifier('(415) 555-0100')).toBe('+14155550100');
    expect(normalizePhoneIdentifier('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizeIdentifierValue('EMAIL', 'X@Y.io')).toBe('x@y.io');
    expect(normalizeIdentifierValue('PHONE', '415.555.0100')).toBe('+14155550100');
  });

  it('digest = sha256 hex of TYPE:normalized', () => {
    const d = identifierDigest('EMAIL', 'a@b.io');
    expect(d).toMatch(/^[a-f0-9]{64}$/);
    expect(identifierDigestOf('EMAIL', ' A@B.io ')).toBe(d);
    expect(identifierDigest('PHONE', 'a@b.io')).not.toBe(d);
  });

  it('masks like TI', () => {
    expect(maskIdentifierValue('jane@example.com')).toBe('j***@example.com');
    expect(maskIdentifierValue('+14155550100')).toBe('***00');
    expect(maskIdentifierValue('+12')).toBe('***');
  });
});
