import { describe, expect, it } from 'vitest';

import { composePolicyDecisions } from '../lib/compose.js';

import { mkDecision } from './_helpers.js';

// ADR §D12 — multi-package composition.
describe('§D12 composePolicyDecisions — most restrictive wins', () => {
  it('DENY beats every other verdict', () => {
    const out = composePolicyDecisions([
      mkDecision('ALLOW'),
      mkDecision('ALLOW_WITH_AUDIT', { effects: [{ kind: 'WRITE_AUDIT' }] }),
      mkDecision('REQUIRES_OVERRIDE', { required_capabilities: ['cap.a'] }),
      mkDecision('DENY', { reason_code: 'HARD_NO' }),
    ]);
    expect(out.decision).toBe('DENY');
    expect(out.reason_code).toBe('HARD_NO');
  });

  it('REQUIRES_OVERRIDE beats ALLOW_WITH_AUDIT and ALLOW', () => {
    const out = composePolicyDecisions([
      mkDecision('ALLOW'),
      mkDecision('ALLOW_WITH_AUDIT'),
      mkDecision('REQUIRES_OVERRIDE', { required_capabilities: ['cap.a'] }),
    ]);
    expect(out.decision).toBe('REQUIRES_OVERRIDE');
    expect(out.override_required).toBe(true);
  });

  it('ALLOW_WITH_AUDIT beats ALLOW', () => {
    const out = composePolicyDecisions([mkDecision('ALLOW'), mkDecision('ALLOW_WITH_AUDIT')]);
    expect(out.decision).toBe('ALLOW_WITH_AUDIT');
    expect(out.audit_required).toBe(true);
  });

  it('an empty set is ALLOW (policy adds no restriction)', () => {
    const out = composePolicyDecisions([]);
    expect(out.decision).toBe('ALLOW');
    expect(out.reason_code).toBe('NO_POLICY');
  });

  it('reason_code is deterministic — the first contributor at the winning level', () => {
    const out = composePolicyDecisions([
      mkDecision('DENY', { reason_code: 'FIRST' }),
      mkDecision('DENY', { reason_code: 'SECOND' }),
    ]);
    expect(out.reason_code).toBe('FIRST');
  });
});

describe('§D12 — effects union + dedupe', () => {
  it('unions distinct effect kinds', () => {
    const out = composePolicyDecisions([
      mkDecision('ALLOW_WITH_AUDIT', { effects: [{ kind: 'WRITE_AUDIT' }] }),
      mkDecision('ALLOW_WITH_AUDIT', { effects: [{ kind: 'REQUIRE_REASON' }] }),
    ]);
    expect(out.effects.map((e) => e.kind).sort()).toEqual(['REQUIRE_REASON', 'WRITE_AUDIT']);
    expect(out.reason_required).toBe(true);
    expect(out.audit_required).toBe(true);
  });

  it('dedupes identical effects (same kind, deep-equal params)', () => {
    const out = composePolicyDecisions([
      mkDecision('ALLOW_WITH_AUDIT', { effects: [{ kind: 'NOTIFY_ROLE', params: { role: 'x' } }] }),
      mkDecision('ALLOW_WITH_AUDIT', { effects: [{ kind: 'NOTIFY_ROLE', params: { role: 'x' } }] }),
    ]);
    expect(out.effects).toHaveLength(1);
  });

  it('fails closed on conflicting effects — same kind, differing params → DENY', () => {
    const out = composePolicyDecisions([
      mkDecision('ALLOW_WITH_AUDIT', { effects: [{ kind: 'SHOW_BANNER', params: { text: 'a' } }] }),
      mkDecision('ALLOW_WITH_AUDIT', { effects: [{ kind: 'SHOW_BANNER', params: { text: 'b' } }] }),
    ]);
    expect(out.decision).toBe('DENY');
    expect(out.reason_code).toBe('POLICY_EFFECT_CONFLICT');
    expect(out.effects).toEqual([]);
  });
});

describe('§D12 — override capabilities', () => {
  it('requires ALL capabilities when several packages REQUIRES_OVERRIDE', () => {
    const out = composePolicyDecisions([
      mkDecision('REQUIRES_OVERRIDE', { required_capabilities: ['cap.a'] }),
      mkDecision('REQUIRES_OVERRIDE', { required_capabilities: ['cap.b'] }),
      mkDecision('ALLOW'),
    ]);
    expect(out.decision).toBe('REQUIRES_OVERRIDE');
    expect([...out.required_capabilities].sort()).toEqual(['cap.a', 'cap.b']);
  });

  it('a DENY contributor moots override capabilities (fail-closed refusal)', () => {
    const out = composePolicyDecisions([
      mkDecision('REQUIRES_OVERRIDE', { required_capabilities: ['cap.a'] }),
      mkDecision('DENY'),
    ]);
    expect(out.decision).toBe('DENY');
    expect(out.required_capabilities).toEqual([]);
    expect(out.effects).toEqual([]);
  });
});
