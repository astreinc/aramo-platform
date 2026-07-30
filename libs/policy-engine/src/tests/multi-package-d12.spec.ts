import { describe, expect, it } from 'vitest';

import {
  composePolicyDecisions,
  unionEffects,
} from '../lib/compose.js';
import { PolicyEngineError } from '../lib/errors.js';

import { mkDecision } from './_helpers.js';

// ADR §D12 (amended R1/R2/R3) — multi-package composition.
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

  it('R3 — an empty set is a caller error (no global default): it throws', () => {
    try {
      composePolicyDecisions([]);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as PolicyEngineError).code).toBe('EMPTY_COMPOSITION');
    }
  });

  it('reason_code is deterministic — the first contributor at the winning level', () => {
    const out = composePolicyDecisions([
      mkDecision('DENY', { reason_code: 'FIRST' }),
      mkDecision('DENY', { reason_code: 'SECOND' }),
    ]);
    expect(out.reason_code).toBe('FIRST');
  });
});

describe('§D12 — effects union + dedupe (R2)', () => {
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

  it('R2 — same kind with DIFFERENT params both survive (union, not conflict)', () => {
    const out = composePolicyDecisions([
      mkDecision('ALLOW_WITH_AUDIT', { effects: [{ kind: 'NOTIFY_ROLE', params: { role: 'manager' } }] }),
      mkDecision('ALLOW_WITH_AUDIT', { effects: [{ kind: 'NOTIFY_ROLE', params: { role: 'compliance' } }] }),
    ]);
    expect(out.decision).toBe('ALLOW_WITH_AUDIT');
    expect(out.effects).toHaveLength(2);
    expect(out.effects.map((e) => (e.params as { role: string }).role).sort()).toEqual([
      'compliance',
      'manager',
    ]);
  });

  it('R2 — the fail-closed guard still fires for a GENUINELY incompatible kind', () => {
    // No kind in the closed set is un-satisfiable twice, so this branch is
    // unreachable in production; exercise it with a synthetic exclusive kind.
    const exclusive = new Set<string>(['SHOW_BANNER']);
    const union = unionEffects(
      [
        { kind: 'SHOW_BANNER', params: { text: 'a' } },
        { kind: 'SHOW_BANNER', params: { text: 'b' } },
      ],
      exclusive,
    );
    expect(union.conflict).toBe(true);
    expect(union.effects).toEqual([]);
  });
});

describe('§D12 — override capabilities + R1 (DENY retains effects)', () => {
  it('requires ALL capabilities when several packages REQUIRES_OVERRIDE', () => {
    const out = composePolicyDecisions([
      mkDecision('REQUIRES_OVERRIDE', { required_capabilities: ['cap.a'] }),
      mkDecision('REQUIRES_OVERRIDE', { required_capabilities: ['cap.b'] }),
      mkDecision('ALLOW'),
    ]);
    expect(out.decision).toBe('REQUIRES_OVERRIDE');
    expect([...out.required_capabilities].sort()).toEqual(['cap.a', 'cap.b']);
  });

  it('R1 — a DENY RETAINS effects (audit + notify still discharged on refusal)', () => {
    const out = composePolicyDecisions([
      mkDecision('DENY', { reason_code: 'HARD_NO', effects: [{ kind: 'WRITE_AUDIT' }, { kind: 'NOTIFY_ROLE', params: { role: 'compliance' } }] }),
      mkDecision('ALLOW'),
    ]);
    expect(out.decision).toBe('DENY');
    expect(out.effects.map((e) => e.kind).sort()).toEqual(['NOTIFY_ROLE', 'WRITE_AUDIT']);
    expect(out.audit_required).toBe(true);
    // Override capabilities are moot on a hard DENY.
    expect(out.required_capabilities).toEqual([]);
  });

  it('R1 — a DENY contributor keeps a co-matched package’s effects too', () => {
    const out = composePolicyDecisions([
      mkDecision('REQUIRES_OVERRIDE', { required_capabilities: ['cap.a'], effects: [{ kind: 'WRITE_AUDIT' }] }),
      mkDecision('DENY', { reason_code: 'HARD_NO' }),
    ]);
    expect(out.decision).toBe('DENY');
    expect(out.effects.map((e) => e.kind)).toEqual(['WRITE_AUDIT']);
    expect(out.required_capabilities).toEqual([]);
  });
});
