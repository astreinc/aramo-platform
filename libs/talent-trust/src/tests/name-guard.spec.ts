import { describe, expect, it } from 'vitest';

import { namesFlatlyConflict } from '../lib/name-guard.js';

// TR-2a-B2 (Amendment §2.2) — the CONFIRMED-arm NAME predicate. Pure, the worked
// cases from the amendment, plus the absence rule and normalization.
describe('namesFlatlyConflict — CONFIRMED-arm NAME guard (Amendment §2.2)', () => {
  it('shared token → NO conflict (nickname variance tolerated): Bob Smith vs Robert Smith', () => {
    expect(namesFlatlyConflict('Bob Smith', 'Robert Smith')).toBe(false);
  });

  it('zero overlap → conflict: Jane Doe vs Priya Sharma', () => {
    expect(namesFlatlyConflict('Jane Doe', 'Priya Sharma')).toBe(true);
  });

  it('zero overlap → conflict (conservative): Bob Jones vs Robert Smith', () => {
    expect(namesFlatlyConflict('Bob Jones', 'Robert Smith')).toBe(true);
  });

  it('absence NEVER conflicts — null / undefined / empty on either side', () => {
    expect(namesFlatlyConflict(null, 'Jane Doe')).toBe(false);
    expect(namesFlatlyConflict('Jane Doe', null)).toBe(false);
    expect(namesFlatlyConflict(undefined, 'Jane Doe')).toBe(false);
    expect(namesFlatlyConflict('', 'Jane Doe')).toBe(false);
    expect(namesFlatlyConflict('   ', 'Jane Doe')).toBe(false);
    expect(namesFlatlyConflict(null, null)).toBe(false);
  });

  it('normalizes: case-insensitive, diacritics folded, punctuation stripped', () => {
    // Same person, different casing/diacritics/punctuation → shared tokens → no conflict.
    expect(namesFlatlyConflict('JOSÉ García', 'jose garcia')).toBe(false);
    expect(namesFlatlyConflict("O'Brien, Sean", 'sean obrien')).toBe(false);
    // Genuinely different → conflict even after normalization.
    expect(namesFlatlyConflict('José García', 'Priya Sharma')).toBe(true);
  });

  it('is symmetric', () => {
    expect(namesFlatlyConflict('Jane Doe', 'Priya Sharma')).toBe(
      namesFlatlyConflict('Priya Sharma', 'Jane Doe'),
    );
  });
});
