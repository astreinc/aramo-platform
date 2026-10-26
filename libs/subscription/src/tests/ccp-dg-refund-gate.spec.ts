import { describe, expect, it } from 'vitest';

import { APPLY_EXPLANATIONS } from '../lib/commercial/commercial-apply-records.js';
import { REFUND_POLICY_NOT_APPROVED } from '../lib/commercial/commercial-billing-adjustment.js';
import { POLICY_EDITABLE_KEYS } from '../lib/commercial/commercial-policy-governance.service.js';
import {
  COMMERCIAL_POLICY_OPTIONAL_KEYS,
  CommercialPolicyUnavailableError,
  REFUND_POLICY_KEYS,
  type CommercialPolicyContent,
  parseCommercialPolicyContent,
} from '../lib/commercial/commercial-policy.js';
import {
  REFUND_EXECUTION_NOT_RELEASED,
  decideRefundExecution,
  enabledRefundPolicyIdentity,
  refundPolicyGate,
  refundPolicyRefBindingError,
} from '../lib/commercial/refund-execution-gate.js';

import { seededPolicyV1 } from './fixtures/commercial-policy-seed.js';
import { TEST_REFUND_KEYS, TEST_REFUND_POLICY_REF, TEST_REFUND_POLICY_SHA256 } from './support/ccp-dg.js';

// CCP-DG (Aramo-CCP-Charter-Amendment-A2-Refund-Execution-Policy-Keys-v1_0-LOCKED) — the pure half of
// the refund dual gate: the RX-1 parser matrix, gate 2 (RX-6, RX-8 at apply, RX-9), the 2 × 2
// independence matrix (RX-7) and the RX-8 create binding. Test IDs are cited by
// doc/ccp/slices/CCP-DG-acceptance.md.

const V1 = seededPolicyV1().content as Record<string, unknown>;
const KEYS = { ...TEST_REFUND_KEYS } as Record<string, unknown>;
const parse = (extra: Record<string, unknown>): CommercialPolicyContent => parseCommercialPolicyContent({ ...V1, ...extra });
function malformed(extra: Record<string, unknown>): string[] | 'PARSED' {
  try {
    parse(extra);
    return 'PARSED';
  } catch (e) {
    expect(e).toBeInstanceOf(CommercialPolicyUnavailableError);
    expect((e as CommercialPolicyUnavailableError).reason).toBe('MALFORMED');
    return [...(e as CommercialPolicyUnavailableError).errors];
  }
}
const without = (o: Record<string, unknown>, ...k: string[]) => Object.fromEntries(Object.entries(o).filter(([x]) => !k.includes(x)));

describe('CCP-DG RX-1 — the three optional refund keys (all present or all absent; fail closed)', () => {
  it('DG-P-1 the key set: three optional keys after apply_expiry_hours, all editable on a draft (RX-11)', () => {
    expect(REFUND_POLICY_KEYS).toEqual(['refund_execution_enabled', 'refund_policy_ref', 'refund_policy_sha256']);
    expect(COMMERCIAL_POLICY_OPTIONAL_KEYS).toEqual(['apply_expiry_hours', ...REFUND_POLICY_KEYS]);
    for (const k of REFUND_POLICY_KEYS) expect(POLICY_EDITABLE_KEYS).toContain(k);
  });

  it('DG-P-2 all absent: v1 parses to the exact v1 shape, and absent means disabled (no default ever enables)', () => {
    const c = parseCommercialPolicyContent(V1);
    for (const k of REFUND_POLICY_KEYS) expect(k in c).toBe(false);
    expect(enabledRefundPolicyIdentity(c)).toBeNull();
    expect(Object.keys(V1).some((k) => (REFUND_POLICY_KEYS as readonly string[]).includes(k))).toBe(false);
  });

  it('DG-P-3 all present and valid: true and false both parse; only true enables (the identity is ref + sha)', () => {
    const on = parse(KEYS);
    expect(on).toMatchObject({ refund_execution_enabled: true, refund_policy_ref: TEST_REFUND_POLICY_REF, refund_policy_sha256: TEST_REFUND_POLICY_SHA256 });
    expect(enabledRefundPolicyIdentity(on)).toEqual({ refund_policy_ref: TEST_REFUND_POLICY_REF, refund_policy_sha256: TEST_REFUND_POLICY_SHA256 });
    const off = parse({ ...KEYS, refund_execution_enabled: false });
    expect(off.refund_execution_enabled).toBe(false);
    expect(enabledRefundPolicyIdentity(off)).toBeNull();
    // the example reference of the amendment, and the apply deadline alongside
    expect(parse({ ...KEYS, refund_policy_ref: 'ARAMO-COM-REFUND-POL-001@1.0', apply_expiry_hours: 72 }).refund_policy_ref).toBe('ARAMO-COM-REFUND-POL-001@1.0');
  });

  it('DG-P-4 each partial presence (6 subsets of 1 or 2 keys) is MALFORMED', () => {
    const subsets: string[][] = [['refund_execution_enabled'], ['refund_policy_ref'], ['refund_policy_sha256'], ['refund_execution_enabled', 'refund_policy_ref'], ['refund_execution_enabled', 'refund_policy_sha256'], ['refund_policy_ref', 'refund_policy_sha256']];
    for (const present of subsets) {
      const errs = malformed(Object.fromEntries(present.map((k) => [k, KEYS[k]])));
      expect(errs, present.join('+')).not.toBe('PARSED');
      expect((errs as string[]).join(' '), present.join('+')).toContain('all present or all absent');
    }
  });

  it('DG-P-5 each malformed value (wrong type, null, bad format) is MALFORMED', () => {
    const bad: Array<[string, unknown]> = [
      ['refund_execution_enabled', 'true'],
      ['refund_execution_enabled', 1],
      ['refund_execution_enabled', null],
      ['refund_policy_ref', null],
      ['refund_policy_ref', 42],
      ['refund_policy_ref', 'aramo-refund-policy@1.0'], // lower case
      ['refund_policy_ref', 'ARAMO-COM-REFUND-POL-001@1'], // no minor
      ['refund_policy_ref', 'ARAMO-COM-REFUND-POL-001@v1.0'],
      ['refund_policy_ref', 'ARAMO COM@1.0'],
      ['refund_policy_ref', '@1.0'],
      ['refund_policy_ref', 'ARAMO-COM-REFUND-POL-001@1.0 '],
      ['refund_policy_sha256', null],
      ['refund_policy_sha256', 'A'.repeat(64)], // upper case
      ['refund_policy_sha256', 'a'.repeat(63)],
      ['refund_policy_sha256', 'a'.repeat(65)],
      ['refund_policy_sha256', 'g'.repeat(64)],
      ['refund_policy_sha256', 7],
    ];
    for (const [k, v] of bad) expect(malformed({ ...KEYS, [k]: v }), `${k}=${JSON.stringify(v)}`).not.toBe('PARSED');
    // an unknown sibling key is still refused
    expect(malformed({ ...KEYS, refund_policy_version: '1.0' })).not.toBe('PARSED');
    expect(malformed(without(KEYS, 'refund_policy_sha256'))).not.toBe('PARSED');
  });
});

describe('CCP-DG RX-5…RX-9 — the dual gate (pure)', () => {
  const ENABLED = parse(KEYS);
  const ENABLED_OTHER_PARAMS = parse({ ...KEYS, credit_escalation_threshold_minor: 100_000, apply_expiry_hours: 72 });
  const DISABLED_FALSE = parse({ ...KEYS, refund_execution_enabled: false });
  const ABSENT = parse({});
  const OTHER_SHA = parse({ ...KEYS, refund_policy_sha256: 'b'.repeat(64) });
  const OTHER_REF = parse({ ...KEYS, refund_policy_ref: 'ARAMO-COM-REFUND-POL-TEST@1.1' });

  it('DG-G-1 the 2 × 2 independence matrix (RX-7): switch on/off × policy enabled/not — exactly ONE combination proceeds', () => {
    const rows: string[] = [];
    for (const switch_on of [false, true]) {
      for (const policy of ['enabled', 'not_enabled'] as const) {
        const c = policy === 'enabled' ? ENABLED : ABSENT;
        const d = decideRefundExecution({ switch_on, active: c, snapshot: c, payload_ref: TEST_REFUND_POLICY_REF });
        rows.push(`${switch_on ? 'on' : 'off'}/${policy}=${d.ok ? 'PROCEED' : d.refusal}`);
      }
    }
    expect(rows).toEqual([
      `off/enabled=${REFUND_EXECUTION_NOT_RELEASED}`,
      `off/not_enabled=${REFUND_EXECUTION_NOT_RELEASED}`,
      'on/enabled=PROCEED',
      `on/not_enabled=${REFUND_POLICY_NOT_APPROVED}`,
    ]);
    expect(rows.filter((r) => r.endsWith('PROCEED'))).toHaveLength(1);
    // Both outcomes are reported: activating a policy never overrides the switch; the switch never bypasses the policy.
    expect(decideRefundExecution({ switch_on: false, active: ENABLED, snapshot: ENABLED, payload_ref: TEST_REFUND_POLICY_REF })).toEqual({ ok: false, refusal: REFUND_EXECUTION_NOT_RELEASED, gate_1_released: false, gate_2: 'APPROVED' });
    expect(decideRefundExecution({ switch_on: true, active: ABSENT, snapshot: ABSENT, payload_ref: TEST_REFUND_POLICY_REF })).toEqual({ ok: false, refusal: REFUND_POLICY_NOT_APPROVED, gate_1_released: true, gate_2: 'ACTIVE_POLICY_NOT_ENABLED' });
  });

  it('DG-G-2 snapshot vs current (RX-6): the same refund identity proceeds even when the full documents differ (unrelated parameters, other checksums); another sha or ref is refused', () => {
    expect(refundPolicyGate({ active: ENABLED_OTHER_PARAMS, snapshot: ENABLED, payload_ref: TEST_REFUND_POLICY_REF })).toBe('APPROVED');
    expect(refundPolicyGate({ active: ENABLED, snapshot: ENABLED_OTHER_PARAMS, payload_ref: TEST_REFUND_POLICY_REF })).toBe('APPROVED');
    expect(refundPolicyGate({ active: OTHER_SHA, snapshot: ENABLED, payload_ref: TEST_REFUND_POLICY_REF })).toBe('REFUND_POLICY_IDENTITY_CHANGED');
    expect(refundPolicyGate({ active: OTHER_REF, snapshot: ENABLED, payload_ref: TEST_REFUND_POLICY_REF })).toBe('REFUND_POLICY_IDENTITY_CHANGED');
  });

  it('DG-G-3 both versions must enable (RX-6) and revocation stops new execution for every request (RX-9); unavailable policies fail closed', () => {
    expect(refundPolicyGate({ active: ABSENT, snapshot: ENABLED, payload_ref: TEST_REFUND_POLICY_REF })).toBe('ACTIVE_POLICY_NOT_ENABLED');
    expect(refundPolicyGate({ active: DISABLED_FALSE, snapshot: ENABLED, payload_ref: TEST_REFUND_POLICY_REF })).toBe('ACTIVE_POLICY_NOT_ENABLED');
    expect(refundPolicyGate({ active: ENABLED, snapshot: ABSENT, payload_ref: TEST_REFUND_POLICY_REF })).toBe('SNAPSHOT_POLICY_NOT_ENABLED');
    expect(refundPolicyGate({ active: ENABLED, snapshot: DISABLED_FALSE, payload_ref: TEST_REFUND_POLICY_REF })).toBe('SNAPSHOT_POLICY_NOT_ENABLED');
    expect(refundPolicyGate({ active: null, snapshot: ENABLED, payload_ref: TEST_REFUND_POLICY_REF })).toBe('ACTIVE_POLICY_UNAVAILABLE');
    expect(refundPolicyGate({ active: ENABLED, snapshot: null, payload_ref: TEST_REFUND_POLICY_REF })).toBe('SNAPSHOT_POLICY_UNAVAILABLE');
  });

  it('DG-G-4 RX-8 at apply: the payload must name the refund policy (a proposal ref under the same identity is refused)', () => {
    expect(refundPolicyGate({ active: ENABLED, snapshot: ENABLED, payload_ref: 'aramo-refund-policy@v1-draft' })).toBe('PAYLOAD_REF_MISMATCH');
    expect(refundPolicyGate({ active: ENABLED, snapshot: ENABLED, payload_ref: undefined })).toBe('PAYLOAD_REF_MISMATCH');
  });

  it('DG-G-5 RX-8 at create: bound when the snapshot declares the keys (enabled or not); a proposal only when it does not', () => {
    expect(refundPolicyRefBindingError(ENABLED, TEST_REFUND_POLICY_REF)).toBeNull();
    expect(refundPolicyRefBindingError(ENABLED, 'ARAMO-COM-REFUND-POL-999@9.9')).toEqual({ declared_ref: TEST_REFUND_POLICY_REF });
    expect(refundPolicyRefBindingError(DISABLED_FALSE, 'ARAMO-COM-REFUND-POL-999@9.9')).toEqual({ declared_ref: TEST_REFUND_POLICY_REF });
    expect(refundPolicyRefBindingError(ABSENT, 'aramo-refund-policy@v1-draft')).toBeNull();
  });

  it('DG-G-6 the two refusals are stable codes with operator explanations (RX-D1)', () => {
    expect(REFUND_EXECUTION_NOT_RELEASED).toBe('REFUND_EXECUTION_NOT_RELEASED');
    expect(REFUND_POLICY_NOT_APPROVED).toBe('REFUND_POLICY_NOT_APPROVED');
    expect(APPLY_EXPLANATIONS[REFUND_EXECUTION_NOT_RELEASED]).toMatch(/not been released/);
    expect(APPLY_EXPLANATIONS[REFUND_POLICY_NOT_APPROVED]).toMatch(/refund policy has not been approved/);
  });
});
