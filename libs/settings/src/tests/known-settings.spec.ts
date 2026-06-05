import { describe, expect, it } from 'vitest';

import {
  KNOWN_SETTINGS,
  KNOWN_SETTING_KEYS,
  isKnownSettingKey,
} from '../index.js';

// Settings S1 — known-settings registry shape proof.
//
// The S1 invariant (Gate-5 Ruling 1; commit plan §4 gate 9): the registry is
// SHIPPED EMPTY in S1. S2's pricing-model-default is the FIRST entry; until
// then the foundation runs against an empty registry and the GET /v1/tenant/
// settings response is `{}` for every tenant.
//
// These tests prove the FOUNDATION shape — registry-as-source-of-truth, the
// closed-set discipline, and the runtime guard. They are forward-compatible:
// when S2 adds the first key, the only assertion that flips is the count
// (and `isKnownSettingKey('compensation.display_default')` becomes true).
describe('KNOWN_SETTINGS — the closed-set registry (S1 ships EMPTY)', () => {
  it('S1 ships ZERO known-keys (the empty foundation)', () => {
    // The single load-bearing S1 invariant: building a generic write
    // validator now (without a concrete first known-key) would speculate
    // the audit-event shape — the over-build halt condition from the
    // directive §6. S2 lights the first entry up.
    expect(Object.keys(KNOWN_SETTINGS)).toEqual([]);
    expect(KNOWN_SETTING_KEYS).toEqual([]);
  });

  it('KNOWN_SETTING_KEYS is frozen (closed-set discipline)', () => {
    // The registry MUST be immutable at runtime — every consumer
    // (TenantSettingService.getAll, isKnownSettingKey, future validators)
    // assumes the key-set never mutates within a process. Mutation would
    // create surprising read-of-default behavior across requests.
    expect(Object.isFrozen(KNOWN_SETTING_KEYS)).toBe(true);
  });
});

describe('isKnownSettingKey — runtime guard', () => {
  it('rejects every input while the registry is empty', () => {
    // S1 acceptance: every input is rejected (registry empty). After S2,
    // the registered keys flip to `true`; everything else stays `false`.
    expect(isKnownSettingKey('compensation.display_default')).toBe(false);
    expect(isKnownSettingKey('import.failure_threshold_pct')).toBe(false);
    expect(isKnownSettingKey('anything_at_all')).toBe(false);
    expect(isKnownSettingKey('')).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(isKnownSettingKey(undefined)).toBe(false);
    expect(isKnownSettingKey(null)).toBe(false);
    expect(isKnownSettingKey(42)).toBe(false);
    expect(isKnownSettingKey({})).toBe(false);
    expect(isKnownSettingKey([])).toBe(false);
    expect(isKnownSettingKey(true)).toBe(false);
  });
});
