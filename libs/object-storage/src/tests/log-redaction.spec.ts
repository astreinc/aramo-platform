import { describe, expect, it } from 'vitest';

import { hashIdentifierForLog } from '../lib/log-redaction.js';

const ID_A = '8f9e4c2a-6b1d-4d7e-8a9f-1c2b3d4e5f60';
const ID_B = '7e8d9c4a-5b6c-4a8e-9f1d-2a3b4c5d6e7f';

// A8-3a Gate-5 review-item-3 — log-redaction proofs.
//
// The PII-floor access-log emits a HASHED talent_record_id. The hash
// must (a) be stable (same input → same output: group-by-talent
// correlation works), (b) differ across distinct inputs (no spurious
// correlation), (c) be a short hex prefix (the agreed shape), and
// (d) NOT reveal the raw id.

describe('A8-3a — hashIdentifierForLog (log-side redaction)', () => {
  it('is stable: same input produces the same hash', () => {
    expect(hashIdentifierForLog(ID_A)).toBe(hashIdentifierForLog(ID_A));
  });

  it('discriminates: distinct inputs produce distinct hashes', () => {
    expect(hashIdentifierForLog(ID_A)).not.toBe(hashIdentifierForLog(ID_B));
  });

  it('returns 16 lowercase hex characters', () => {
    const h = hashIdentifierForLog(ID_A);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not echo the raw id', () => {
    const h = hashIdentifierForLog(ID_A);
    expect(h).not.toContain(ID_A);
    expect(h).not.toContain('8f9e4c2a');
  });
});
