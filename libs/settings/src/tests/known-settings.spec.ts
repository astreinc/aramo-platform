import { describe, expect, it } from 'vitest';

import {
  isCompensationDisplayDefault,
  isKnownSettingKey,
  KNOWN_SETTINGS,
  KNOWN_SETTING_KEYS,
} from '../index.js';

// Settings S2 — known-settings registry shape proofs (the closed-set
// contract). S1 shipped EMPTY; S2 lights up the FIRST entry:
// `compensation.display_default` with the PO-chosen `both` default.

describe('KNOWN_SETTINGS — the closed-set registry (S2: first key)', () => {
  it('ships exactly one known-key — compensation.display_default', () => {
    expect(Object.keys(KNOWN_SETTINGS)).toEqual([
      'compensation.display_default',
    ]);
    expect(KNOWN_SETTING_KEYS).toEqual(['compensation.display_default']);
  });

  it('compensation.display_default carries the PO-chosen default `both`', () => {
    const definition = KNOWN_SETTINGS['compensation.display_default'];
    expect(definition.key).toBe('compensation.display_default');
    expect(definition.default).toBe('both');
  });

  it('compensation.display_default validator (the S2 PRECEDENT) accepts the 3 enum values', () => {
    const definition = KNOWN_SETTINGS['compensation.display_default'];
    expect(definition.validate('spread')).toBe(true);
    expect(definition.validate('markup')).toBe(true);
    expect(definition.validate('both')).toBe(true);
  });

  it('compensation.display_default validator rejects every other value', () => {
    const definition = KNOWN_SETTINGS['compensation.display_default'];
    // Adjacent enum-looking strings — the closed-set is exactly 3.
    expect(definition.validate('SPREAD')).toBe(false);
    expect(definition.validate('margin_percent')).toBe(false);
    expect(definition.validate('')).toBe(false);
    // Wrong type shapes.
    expect(definition.validate(0)).toBe(false);
    expect(definition.validate(true)).toBe(false);
    expect(definition.validate(null)).toBe(false);
    expect(definition.validate(undefined)).toBe(false);
    expect(definition.validate({})).toBe(false);
    expect(definition.validate([])).toBe(false);
  });

  it('KNOWN_SETTING_KEYS is frozen (closed-set discipline)', () => {
    expect(Object.isFrozen(KNOWN_SETTING_KEYS)).toBe(true);
  });
});

describe('isCompensationDisplayDefault — exported validator predicate', () => {
  it('matches the registry validator (single source of truth)', () => {
    expect(isCompensationDisplayDefault('spread')).toBe(true);
    expect(isCompensationDisplayDefault('markup')).toBe(true);
    expect(isCompensationDisplayDefault('both')).toBe(true);
    expect(isCompensationDisplayDefault('margin_percent')).toBe(false);
    expect(isCompensationDisplayDefault(42)).toBe(false);
  });
});

describe('isKnownSettingKey — runtime guard (the controller boundary check)', () => {
  it('accepts the registered key', () => {
    expect(isKnownSettingKey('compensation.display_default')).toBe(true);
  });

  it('rejects unregistered keys (the unknown-key-at-write halt)', () => {
    expect(isKnownSettingKey('compensation.display.default')).toBe(false);
    expect(isKnownSettingKey('compensation_display_default')).toBe(false);
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
