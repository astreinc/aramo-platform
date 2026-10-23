import { describe, expect, it } from 'vitest';
import {
  identifierDigest as contractDigest,
  identifierDigestOf,
  maskIdentifierValue,
  normalizeEmailIdentifier,
  normalizePhoneIdentifier,
} from '@aramo/intelligence-contracts';

import { identifierDigest, maskDestination, normalizeEmail, normalizePhone } from '../index.js';

// ATI-SEP-1 T10 WP3b — drift pin: the ATS matches TI proposal digests and masked
// verification values back to its own record fields with the PURE helpers in
// @aramo/intelligence-contracts. They must stay byte-identical to TI's own.

const EMAILS = ['  Priya.N@Example.COM ', 'a@b.io', 'x@y.z'];
const PHONES = ['(415) 555-0100', '+44 20 7946 0958', '4155550100', '555-0100', '+1-415-555-0100'];

describe('identifier helpers — contracts ≡ intelligence-core', () => {
  it('email normalization + digest + mask', () => {
    for (const raw of EMAILS) {
      const n = normalizeEmail(raw);
      expect(normalizeEmailIdentifier(raw)).toBe(n);
      expect(contractDigest('EMAIL', n)).toBe(identifierDigest('EMAIL', n));
      expect(identifierDigestOf('EMAIL', raw)).toBe(identifierDigest('EMAIL', n));
      expect(maskIdentifierValue(n)).toBe(maskDestination(n));
    }
  });

  it('phone normalization + digest + mask', () => {
    for (const raw of PHONES) {
      const n = normalizePhone(raw);
      expect(normalizePhoneIdentifier(raw)).toBe(n);
      expect(contractDigest('PHONE', n)).toBe(identifierDigest('PHONE', n));
      expect(identifierDigestOf('PHONE', raw)).toBe(identifierDigest('PHONE', n));
      expect(maskIdentifierValue(n)).toBe(maskDestination(n));
    }
  });
});
