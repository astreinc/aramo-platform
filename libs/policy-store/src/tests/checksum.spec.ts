import { describe, expect, it } from 'vitest';

import { canonicalSerialize, checksumMatches, computeChecksum } from '../lib/checksum.js';

// Unit coverage for the §D17b integrity checksum. No database — pure functions.

describe('checksum — canonical serialization', () => {
  it('is deterministic for identical content', () => {
    const a = { name: 'p', version: '1.0.0', rules: [{ id: 'r1' }] };
    expect(computeChecksum(a)).toBe(computeChecksum({ ...a }));
  });

  it('is independent of object key order (JSONB re-serialization safe)', () => {
    const insertionA = { name: 'p', version: '1.0.0' };
    const insertionB = { version: '1.0.0', name: 'p' };
    // Different key insertion order — Postgres JSONB does not preserve it.
    expect(canonicalSerialize(insertionA)).toBe(canonicalSerialize(insertionB));
    expect(computeChecksum(insertionA)).toBe(computeChecksum(insertionB));
  });

  it('is sensitive to array order (rule order is significant)', () => {
    const forward = { rules: [{ id: 'a' }, { id: 'b' }] };
    const reversed = { rules: [{ id: 'b' }, { id: 'a' }] };
    expect(computeChecksum(forward)).not.toBe(computeChecksum(reversed));
  });

  it('changes when any value is altered', () => {
    const original = { name: 'p', version: '1.0.0', default_disposition: { decision: 'ALLOW' } };
    const tampered = { name: 'p', version: '1.0.0', default_disposition: { decision: 'DENY' } };
    expect(computeChecksum(original)).not.toBe(computeChecksum(tampered));
  });

  it('checksumMatches detects a tampered definition', () => {
    const definition = { name: 'p', version: '1.0.0', rules: [] };
    const stored = computeChecksum(definition);
    expect(checksumMatches(definition, stored)).toBe(true);
    expect(checksumMatches({ ...definition, version: '1.0.1' }, stored)).toBe(false);
  });
});
