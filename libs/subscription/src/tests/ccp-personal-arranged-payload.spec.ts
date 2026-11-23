import { describe, expect, it } from 'vitest';

import { CommercialPayloadError, EXTERNAL_REF_MAX_LENGTH, SUBSCRIPTION_ARRANGEMENTS, isSubscriptionArrangement, validatePayload } from '../lib/commercial/commercial-change-request.js';

// CCP-PERSONAL-ARRANGED-1 (P-2, PO ruling D-6) — the optional `arrangement` and `external_ref` members of a
// SUBSCRIPTION_OPEN payload (pure schema; the creation-time refusals are in ccp-personal-arranged-create.spec.ts).

const V = '0190dddd-0000-7000-8000-00000000a201';
const F = '0190dddd-0000-7000-8000-00000000a202';
const open = (extra: Record<string, unknown>) => ({ plan_key: 'aramo-sign-standard-personal-v1', plan_version_id: V, replaces_subscription_id: F, ...extra });
const errorsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CommercialPayloadError) return [...e.errors];
    throw e;
  }
  return [];
};

describe('CCP-PERSONAL-ARRANGED-1 SUBSCRIPTION_OPEN payload members', () => {
  it('ARR-P-1 the closed arrangement set is COMP and AGREED', () => {
    expect([...SUBSCRIPTION_ARRANGEMENTS]).toEqual(['COMP', 'AGREED']);
    expect(isSubscriptionArrangement('COMP')).toBe(true);
    expect(isSubscriptionArrangement('AGREED')).toBe(true);
    expect(isSubscriptionArrangement('comp')).toBe(false);
    expect(isSubscriptionArrangement(null)).toBe(false);
  });

  it('ARR-P-2 both members are optional; a well-formed arrangement and reference are accepted and kept in the payload', () => {
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({})))).toEqual([]);
    for (const arrangement of SUBSCRIPTION_ARRANGEMENTS) expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ arrangement })))).toEqual([]);
    const p = validatePayload('SUBSCRIPTION_OPEN', open({ arrangement: 'COMP', external_ref: 'HR-2026-0042' }));
    expect(p['arrangement']).toBe('COMP');
    expect(p['external_ref']).toBe('HR-2026-0042');
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ external_ref: 'x'.repeat(EXTERNAL_REF_MAX_LENGTH) })))).toEqual([]);
  });

  it('ARR-P-3 an unknown arrangement or a malformed reference is refused', () => {
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ arrangement: 'FREE' })))).toEqual(['arrangement must be one of COMP, AGREED']);
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ arrangement: null })))).toEqual(['arrangement must be one of COMP, AGREED']);
    const refError = `external_ref must be a non-empty single-line string of at most ${EXTERNAL_REF_MAX_LENGTH} characters`;
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ external_ref: 'x'.repeat(EXTERNAL_REF_MAX_LENGTH + 1) })))).toEqual([refError]);
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ external_ref: '   ' })))).toEqual([refError]);
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ external_ref: 'a\nb' })))).toEqual([refError]);
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ external_ref: 42 })))).toEqual([refError]);
  });

  it('ARR-P-4 the members belong to SUBSCRIPTION_OPEN only', () => {
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_CHANGE', { subscription_id: F, plan_key: 'aramo-sign-standard-personal-v1', plan_version_id: V, arrangement: 'COMP' }))).toEqual(['arrangement is not a field of this action']);
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_END', { subscription_id: F, external_ref: 'HR-1' }))).toEqual(['external_ref is not a field of this action']);
  });
});
