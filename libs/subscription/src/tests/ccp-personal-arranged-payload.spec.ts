import { describe, expect, it } from 'vitest';

import {
  ARRANGEMENT_REQUIRED_REASON,
  CommercialPayloadError,
  EXTERNAL_REF_MAX_LENGTH,
  FREE_REPLACEMENT_NOT_PERSONAL_REASON,
  PLAN_TENANT_KIND_MISMATCH_REASON,
  SUBSCRIPTION_ARRANGEMENTS,
  isSubscriptionArrangement,
  subscriptionOpenRefusal,
  validatePayload,
} from '../lib/commercial/commercial-change-request.js';
import { COMMERCIAL_CHAIN_PANEL } from '../lib/commercial/commercial-operator-roster.service.js';

// CCP-PERSONAL-ARRANGED-1 (P-2, PO ruling D-6) — the optional `arrangement` and `external_ref` members of a
// SUBSCRIPTION_OPEN payload (pure schema), and the P-4 creation-time decision.

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

// CCP-PERSONAL-ARRANGED-1 (P-4, with P-1) — the creation-time decision (pure; the service reads its inputs
// inside the create transaction under the tenant lock).
describe('CCP-PERSONAL-ARRANGED-1 SUBSCRIPTION_OPEN creation-time refusals', () => {
  const at = (o: Partial<Parameters<typeof subscriptionOpenRefusal>[0]>) =>
    subscriptionOpenRefusal({ tenant_kind: 'PERSONAL', plan_tenant_kind: 'PERSONAL', replaced_source: 'FREE', arrangement: 'COMP', ...o });

  it('ARR-C-1 the reasons are stable', () => {
    expect([PLAN_TENANT_KIND_MISMATCH_REASON, FREE_REPLACEMENT_NOT_PERSONAL_REASON, ARRANGEMENT_REQUIRED_REASON]).toEqual(['plan_tenant_kind_mismatch', 'free_replacement_not_personal', 'arrangement_required']);
  });

  it('ARR-C-2 a PERSONAL tenant replaces its FREE row with a PERSONAL plan and an arrangement (COMP or AGREED)', () => {
    expect(at({})).toBeNull();
    expect(at({ arrangement: 'AGREED' })).toBeNull();
  });

  it('ARR-C-3 the plan tenant kind must match the tenant (any open, FREE replacement or not)', () => {
    expect(at({ plan_tenant_kind: 'BUSINESS' })).toBe('plan_tenant_kind_mismatch');
    expect(at({ tenant_kind: 'BUSINESS', plan_tenant_kind: 'PERSONAL', replaced_source: null, arrangement: undefined })).toBe('plan_tenant_kind_mismatch');
    expect(at({ tenant_kind: 'PERSONAL', plan_tenant_kind: 'BUSINESS', replaced_source: 'MANUAL', arrangement: undefined })).toBe('plan_tenant_kind_mismatch');
    // A plan for every kind (tenant_kind null) matches any tenant, except as a FREE replacement (R-1: PERSONAL plans only).
    expect(at({ tenant_kind: 'BUSINESS', plan_tenant_kind: null, replaced_source: null, arrangement: undefined })).toBeNull();
    expect(at({ plan_tenant_kind: null })).toBe('plan_tenant_kind_mismatch');
  });

  it('ARR-C-4 a FREE row is replaced only for a PERSONAL tenant', () => {
    expect(at({ tenant_kind: 'BUSINESS', plan_tenant_kind: null })).toBe('free_replacement_not_personal');
    expect(at({ tenant_kind: null, plan_tenant_kind: null })).toBe('free_replacement_not_personal');
  });

  it('ARR-C-5 a FREE replacement must name an arrangement; other opens need none', () => {
    expect(at({ arrangement: undefined })).toBe('arrangement_required');
    expect(at({ arrangement: 'NONE' })).toBe('arrangement_required');
    expect(at({ replaced_source: null, arrangement: undefined })).toBeNull();
    expect(at({ replaced_source: 'MANUAL', arrangement: undefined })).toBeNull();
    expect(at({ replaced_source: 'DEVELOPMENT', arrangement: undefined })).toBeNull();
  });

  it('ARR-C-6 an unknown plan or replaced row is left to the apply (PLAN_NOT_FOUND / G2)', () => {
    expect(at({ plan_tenant_kind: undefined })).toBeNull();
    expect(at({ plan_tenant_kind: undefined, arrangement: undefined })).toBe('arrangement_required');
    expect(at({ replaced_source: null, plan_tenant_kind: undefined, tenant_kind: 'BUSINESS', arrangement: undefined })).toBeNull();
  });
});

// CCP Amendment A3 AC-COMP-3 — the operator chain panel shows SUBSCRIPTION_OPEN as F, and F → O for COMP.
describe('CCP Amendment A3 chain panel', () => {
  it('AC-COMP-3 SUBSCRIPTION_OPEN is on the below-threshold (F) and above-threshold (F → O) chains', () => {
    const groups = COMMERCIAL_CHAIN_PANEL.filter((g) => g.actions.includes('SUBSCRIPTION_OPEN')).map((g) => g.key);
    expect(groups).toEqual(['ABOVE_THRESHOLD', 'BELOW_THRESHOLD']);
  });
});
