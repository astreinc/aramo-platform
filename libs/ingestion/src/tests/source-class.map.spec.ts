import { describe, expect, it } from 'vitest';

import { deriveSourceClass } from '../lib/source-class.map.js';

// TR-2a-B1 §6(a) [map logic] — the channel→source_class map (DDR-1 §4).
// Each mapped channel derives its ruled class; every unmapped/unknown channel
// falls to the fail-closed THIRD_PARTY_UNVERIFIED default. source_class is
// server-derived here, never caller-supplied.
describe('deriveSourceClass — channel→source_class map (DDR-1 §4)', () => {
  it('maps talent_direct (first-party declaration) to SELF', () => {
    expect(deriveSourceClass('talent_direct')).toBe('SELF');
  });

  it('maps github / astre_import / indeed to THIRD_PARTY_UNVERIFIED', () => {
    expect(deriveSourceClass('github')).toBe('THIRD_PARTY_UNVERIFIED');
    expect(deriveSourceClass('astre_import')).toBe('THIRD_PARTY_UNVERIFIED');
    expect(deriveSourceClass('indeed')).toBe('THIRD_PARTY_UNVERIFIED');
  });

  it('fail-closed: any unmapped / unknown / empty channel is THIRD_PARTY_UNVERIFIED', () => {
    // A new channel earns confirming status only by an explicit map amendment,
    // never by omission (DDR-1 §4 hard default).
    expect(deriveSourceClass('a_future_channel')).toBe('THIRD_PARTY_UNVERIFIED');
    expect(deriveSourceClass('some_unregistered_board')).toBe('THIRD_PARTY_UNVERIFIED');
    expect(deriveSourceClass('')).toBe('THIRD_PARTY_UNVERIFIED');
  });

  it('never derives a confirming class from the current map (no channel confirms yet)', () => {
    for (const source of ['talent_direct', 'github', 'astre_import', 'indeed', 'unknown']) {
      expect(deriveSourceClass(source)).not.toBe('THIRD_PARTY_VERIFIED');
    }
  });
});
