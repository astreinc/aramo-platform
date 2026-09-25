import { describe, it, expect } from 'vitest';
import {
  OVERRIDE_POLICY_VALUES,
  DEFAULT_OVERRIDE_POLICY,
  isOverridePolicy,
  checksumDefinitions,
  type RequirementDefinitionInput,
} from '../lib/pre-start-requirement-vocab.js';
import {
  blockingIsAtLeastAsStrictAs,
  satisfactionPolicyIsAtLeastAsStrictAs,
  waiverModeIsAtLeastAsStrictAs,
  floorViolation,
  joinFloor,
  type StrictnessDims,
} from '../lib/floor-strictness.js';

// PR-1 (CSP directive §D4-A) — FLOOR is a monotonic strictness constraint across
// every strictness-bearing dimension. These are the pure comparators; existence is
// protected structurally by the union-only merge and is not a comparator here.
// Each comparator answers: is the more-specific OVERRIDE at-least-as-strict as the FLOOR?

describe('override_policy vocabulary', () => {
  it('is the closed set DEFAULT | FLOOR, default DEFAULT', () => {
    expect([...OVERRIDE_POLICY_VALUES]).toEqual(['DEFAULT', 'FLOOR']);
    expect(DEFAULT_OVERRIDE_POLICY).toBe('DEFAULT');
    expect(isOverridePolicy('FLOOR')).toBe(true);
    expect(isOverridePolicy('DEFAULT')).toBe(true);
    expect(isOverridePolicy('TENANT')).toBe(false);
    expect(isOverridePolicy(undefined)).toBe(false);
  });
});

describe('blocking strictness (linear: true is stricter than false)', () => {
  it('override at-least-as-strict as floor', () => {
    expect(blockingIsAtLeastAsStrictAs(true, true)).toBe(true); // same
    expect(blockingIsAtLeastAsStrictAs(true, false)).toBe(true); // strengthen
    expect(blockingIsAtLeastAsStrictAs(false, false)).toBe(true); // same
    expect(blockingIsAtLeastAsStrictAs(false, true)).toBe(false); // WEAKEN → reject
  });
});

describe('satisfaction_policy strictness (linear: VERIFICATION_REQUIRED is stricter than SELF_ATTEST)', () => {
  it('override at-least-as-strict as floor', () => {
    expect(satisfactionPolicyIsAtLeastAsStrictAs('VERIFICATION_REQUIRED', 'VERIFICATION_REQUIRED')).toBe(true);
    expect(satisfactionPolicyIsAtLeastAsStrictAs('VERIFICATION_REQUIRED', 'SELF_ATTEST')).toBe(true); // strengthen
    expect(satisfactionPolicyIsAtLeastAsStrictAs('SELF_ATTEST', 'SELF_ATTEST')).toBe(true);
    expect(satisfactionPolicyIsAtLeastAsStrictAs('SELF_ATTEST', 'VERIFICATION_REQUIRED')).toBe(false); // WEAKEN → reject
  });
});

describe('waiver_mode strictness (PARTIAL order: NOT_WAIVABLE dominates; 3 authority modes incomparable)', () => {
  it('NOT_WAIVABLE is the top — at-least-as-strict as every mode', () => {
    for (const m of ['NOT_WAIVABLE', 'CLIENT_AUTHORITY_ONLY', 'COMPLIANCE_AUTHORITY_ONLY', 'AUTHORIZED_INTERNAL'] as const) {
      expect(waiverModeIsAtLeastAsStrictAs('NOT_WAIVABLE', m)).toBe(true);
    }
  });
  it('reflexive: same mode satisfies its own floor', () => {
    expect(waiverModeIsAtLeastAsStrictAs('CLIENT_AUTHORITY_ONLY', 'CLIENT_AUTHORITY_ONLY')).toBe(true);
    expect(waiverModeIsAtLeastAsStrictAs('AUTHORIZED_INTERNAL', 'AUTHORIZED_INTERNAL')).toBe(true);
  });
  it('relaxing NOT_WAIVABLE to any authority-scoped mode is a WEAKEN → reject', () => {
    expect(waiverModeIsAtLeastAsStrictAs('AUTHORIZED_INTERNAL', 'NOT_WAIVABLE')).toBe(false);
    expect(waiverModeIsAtLeastAsStrictAs('CLIENT_AUTHORITY_ONLY', 'NOT_WAIVABLE')).toBe(false);
  });
  it('lateral change between incomparable authority modes → reject (floor mandated a specific authority)', () => {
    expect(waiverModeIsAtLeastAsStrictAs('COMPLIANCE_AUTHORITY_ONLY', 'CLIENT_AUTHORITY_ONLY')).toBe(false);
    expect(waiverModeIsAtLeastAsStrictAs('CLIENT_AUTHORITY_ONLY', 'AUTHORIZED_INTERNAL')).toBe(false);
  });
});

describe('floorViolation — first violated strictness dimension, or null when satisfied', () => {
  const floor: StrictnessDims = { blocking: true, waiver_mode: 'NOT_WAIVABLE', satisfaction_policy: 'VERIFICATION_REQUIRED' };
  it('null when the override is at-least-as-strict on every dimension', () => {
    expect(floorViolation({ blocking: true, waiver_mode: 'NOT_WAIVABLE', satisfaction_policy: 'VERIFICATION_REQUIRED' }, floor)).toBeNull();
  });
  it('flags blocking weakening', () => {
    expect(floorViolation({ blocking: false, waiver_mode: 'NOT_WAIVABLE', satisfaction_policy: 'VERIFICATION_REQUIRED' }, floor)).toBe('blocking');
  });
  it('flags waiver_mode weakening (the example: NOT_WAIVABLE relaxed to AUTHORIZED_INTERNAL)', () => {
    expect(floorViolation({ blocking: true, waiver_mode: 'AUTHORIZED_INTERNAL', satisfaction_policy: 'VERIFICATION_REQUIRED' }, floor)).toBe('waiver_mode');
  });
  it('flags satisfaction_policy weakening (VERIFICATION_REQUIRED relaxed to SELF_ATTEST)', () => {
    expect(floorViolation({ blocking: true, waiver_mode: 'NOT_WAIVABLE', satisfaction_policy: 'SELF_ATTEST' }, floor)).toBe('satisfaction_policy');
  });
});

describe('checksum identity — override_policy participates (CSP PR-1 guardrail #1)', () => {
  const base: RequirementDefinitionInput = {
    requirement_type: 'BACKGROUND_CHECK',
    label: 'Background check',
    blocking: true,
    owner_role: null,
    sequence: 1,
    waiver_mode: 'NOT_WAIVABLE',
    satisfaction_policy: 'VERIFICATION_REQUIRED',
  };
  it('DEFAULT and FLOOR (all else identical) produce DIFFERENT immutable identities', () => {
    const asDefault = checksumDefinitions([{ ...base, override_policy: 'DEFAULT' }]);
    const asFloor = checksumDefinitions([{ ...base, override_policy: 'FLOOR' }]);
    expect(asDefault).not.toBe(asFloor);
  });
  it('absent override_policy checksums identically to explicit DEFAULT (the column default)', () => {
    const absent = checksumDefinitions([{ ...base }]);
    const explicitDefault = checksumDefinitions([{ ...base, override_policy: 'DEFAULT' }]);
    expect(absent).toBe(explicitDefault);
  });
});

describe('joinFloor — accumulates the STRICTEST floor down-scope (partial-order safe)', () => {
  it('a strengthening at an intermediate layer raises the floor for deeper layers', () => {
    const tenantFloor: StrictnessDims = { blocking: true, waiver_mode: 'CLIENT_AUTHORITY_ONLY', satisfaction_policy: 'SELF_ATTEST' };
    const clientStronger: StrictnessDims = { blocking: true, waiver_mode: 'NOT_WAIVABLE', satisfaction_policy: 'VERIFICATION_REQUIRED' };
    const joined = joinFloor(tenantFloor, clientStronger);
    expect(joined).toEqual({ blocking: true, waiver_mode: 'NOT_WAIVABLE', satisfaction_policy: 'VERIFICATION_REQUIRED' });
    // REQUISITION now cannot drop below the raised (effective) floor
    expect(floorViolation({ blocking: true, waiver_mode: 'NOT_WAIVABLE', satisfaction_policy: 'SELF_ATTEST' }, joined)).toBe('satisfaction_policy');
  });
  it('join only ever runs on overrides that already satisfy the floor (comparable waiver pair)', () => {
    const floor: StrictnessDims = { blocking: false, waiver_mode: 'CLIENT_AUTHORITY_ONLY', satisfaction_policy: 'SELF_ATTEST' };
    // same-mode override keeps the floor mode; blocking strengthens
    expect(joinFloor(floor, { blocking: true, waiver_mode: 'CLIENT_AUTHORITY_ONLY', satisfaction_policy: 'SELF_ATTEST' })).toEqual({
      blocking: true,
      waiver_mode: 'CLIENT_AUTHORITY_ONLY',
      satisfaction_policy: 'SELF_ATTEST',
    });
  });
});
