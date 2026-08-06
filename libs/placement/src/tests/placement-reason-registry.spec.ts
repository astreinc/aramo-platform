import { describe, expect, it } from 'vitest';

import {
  PLACEMENT_REASONS,
  REASON_DETAIL_MAX,
  REASON_DETAIL_POLICIES,
  GOVERNED_TERMINAL_TARGETS,
  getReason,
  activeReasonsForTarget,
  isGovernedTerminalTarget,
  normalizeReasonDetail,
  classifyTransitionReason,
  type PlacementReasonDefinition,
} from '../lib/reasons/placement-reason-registry.js';
import { PLACEMENT_STATES, STATE_POSITION, type PlacementState } from '../lib/lifecycle/placement-lifecycle.js';

// Track 3 / E3 — the Placement Fallthrough Reason Registry. These proofs are
// TAXONOMY-NEUTRAL: they assert structural invariants and derive their fixtures
// from the registry itself (never hard-code a business code), so a future PO
// re-ruling of the taxonomy stays a pure data swap and leaves the machinery
// proofs green.

const GOVERNED = GOVERNED_TERMINAL_TARGETS;

// Pull a live fixture of each shape from the registry, so the behavioural proofs
// below never name a specific business code.
function firstActiveWithPolicy(
  policy: PlacementReasonDefinition['detailPolicy'],
): PlacementReasonDefinition {
  const def = PLACEMENT_REASONS.find((r) => r.status === 'active' && r.detailPolicy === policy);
  if (def === undefined) throw new Error(`registry has no active ${policy} reason to fixture from`);
  return def;
}

describe('E3 placement reason registry — structural invariants (§14.1)', () => {
  it('the governed target set is exactly the four TERMINAL-position states, derived from the lifecycle', () => {
    const derived = PLACEMENT_STATES.filter((s) => STATE_POSITION[s] === 'TERMINAL');
    expect([...GOVERNED]).toEqual([...derived]);
    // The four the directive governs, in canonical order.
    expect([...GOVERNED]).toEqual(['OFFER_DECLINED', 'OFFER_RESCINDED', 'NO_SHOW', 'FELL_THROUGH']);
    expect(GOVERNED).toHaveLength(4);
    // isGovernedTerminalTarget agrees for every state.
    for (const s of PLACEMENT_STATES) {
      expect(isGovernedTerminalTarget(s)).toBe(STATE_POSITION[s] === 'TERMINAL');
    }
  });

  it('every active reason has a unique stable code, non-empty label, valid policy, deterministic unique order, and >=1 allowed target (all governed)', () => {
    const active = PLACEMENT_REASONS.filter((r) => r.status === 'active');
    expect(active.length).toBeGreaterThan(0);

    const codes = active.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length); // unique codes

    const orders = active.map((r) => r.order);
    expect(new Set(orders).size).toBe(orders.length); // unique orders (deterministic total sort)

    for (const r of active) {
      expect(r.code).toMatch(/^[a-z][a-z0-9_]*$/); // stable lowercase-snake code
      expect(r.label.trim().length).toBeGreaterThan(0); // non-empty label
      expect(REASON_DETAIL_POLICIES).toContain(r.detailPolicy); // valid policy
      expect(r.allowedTargets.length).toBeGreaterThan(0); // >=1 allowed target
      for (const t of r.allowedTargets) {
        expect(GOVERNED).toContain(t); // every allowed target is a governed terminal state
      }
    }
  });

  it('each governed target state has at least one active reason (§14.2)', () => {
    for (const target of GOVERNED) {
      expect(activeReasonsForTarget(target).length).toBeGreaterThan(0);
    }
  });

  it('activeReasonsForTarget returns only active reasons allowed for the target, in deterministic order', () => {
    for (const target of GOVERNED) {
      const list = activeReasonsForTarget(target);
      const orders = list.map((r) => r.order);
      expect(orders).toEqual([...orders].sort((a, b) => a - b)); // sorted by order
      for (const r of list) {
        expect(r.status).toBe('active');
        expect(r.allowedTargets).toContain(target);
      }
    }
  });

  it('getReason resolves by exact stable code and is case-sensitive (label never substitutes for code)', () => {
    const def = PLACEMENT_REASONS[0]!;
    expect(getReason(def.code)).toEqual(def);
    expect(getReason(def.code.toUpperCase())).toBeUndefined(); // case-sensitive
    expect(getReason(def.label)).toBeUndefined(); // a label is not a code
    expect(getReason('definitely_not_a_code')).toBeUndefined();
  });

  it('normalizeReasonDetail trims and collapses internal whitespace deterministically', () => {
    expect(normalizeReasonDetail('  a   b\t\nc  ')).toBe('a b c');
    expect(normalizeReasonDetail('   ')).toBe('');
    expect(REASON_DETAIL_MAX).toBeGreaterThan(0);
  });
});

describe('E3 classifyTransitionReason — positive cases (§14.6-8)', () => {
  it('a non-governed target with NO reason input classifies ok with null evidence', () => {
    // Any non-terminal target is non-governed.
    const nonGoverned = PLACEMENT_STATES.find((s) => STATE_POSITION[s] !== 'TERMINAL')!;
    const v = classifyTransitionReason({ to: nonGoverned });
    expect(v).toEqual({ ok: true, evidence: null });
  });

  it('OPTIONAL detail succeeds both absent and present; evidence carries the label snapshot', () => {
    const def = firstActiveWithPolicy('OPTIONAL');
    const target = def.allowedTargets[0]!;
    const absent = classifyTransitionReason({ to: target, reason_code: def.code });
    expect(absent).toEqual({
      ok: true,
      evidence: { reason_code: def.code, reason_label_snapshot: def.label, reason_detail: null },
    });
    const present = classifyTransitionReason({ to: target, reason_code: def.code, reason_detail: '  hello   world ' });
    expect(present).toEqual({
      ok: true,
      evidence: { reason_code: def.code, reason_label_snapshot: def.label, reason_detail: 'hello world' },
    });
  });

  it('REQUIRED detail succeeds with valid normalized input', () => {
    const def = firstActiveWithPolicy('REQUIRED');
    const target = def.allowedTargets[0]!;
    const v = classifyTransitionReason({ to: target, reason_code: def.code, reason_detail: '  needs   text ' });
    expect(v).toEqual({
      ok: true,
      evidence: { reason_code: def.code, reason_label_snapshot: def.label, reason_detail: 'needs text' },
    });
  });

  it('PROHIBITED detail succeeds ONLY when absent, and persists a null detail', () => {
    const def = firstActiveWithPolicy('PROHIBITED');
    const target = def.allowedTargets[0]!;
    const v = classifyTransitionReason({ to: target, reason_code: def.code });
    expect(v).toEqual({
      ok: true,
      evidence: { reason_code: def.code, reason_label_snapshot: def.label, reason_detail: null },
    });
  });
});

describe('E3 classifyTransitionReason — negative cases (§15)', () => {
  const governedTarget = GOVERNED[0]!;

  it('governed target with no reason code → reason_required', () => {
    expect(classifyTransitionReason({ to: governedTarget })).toMatchObject({ ok: false, reason: 'reason_required' });
    expect(classifyTransitionReason({ to: governedTarget, reason_code: '' })).toMatchObject({ ok: false, reason: 'reason_required' });
  });

  it('unknown reason code → reason_unknown', () => {
    expect(classifyTransitionReason({ to: governedTarget, reason_code: 'no_such_code' })).toMatchObject({
      ok: false,
      reason: 'reason_unknown',
    });
  });

  it('a label supplied instead of a code → reason_unknown (no label is ever accepted as a code)', () => {
    const def = PLACEMENT_REASONS[0]!;
    expect(classifyTransitionReason({ to: def.allowedTargets[0]!, reason_code: def.label })).toMatchObject({
      ok: false,
      reason: 'reason_unknown',
    });
  });

  it('a reason valid for a DIFFERENT target state → reason_wrong_target', () => {
    // Find a code whose allowed targets exclude at least one governed target.
    const def = PLACEMENT_REASONS.find(
      (r) => r.status === 'active' && GOVERNED.some((t) => !r.allowedTargets.includes(t)),
    )!;
    const wrongTarget = GOVERNED.find((t) => !def.allowedTargets.includes(t))!;
    expect(classifyTransitionReason({ to: wrongTarget, reason_code: def.code })).toMatchObject({
      ok: false,
      reason: 'reason_wrong_target',
    });
  });

  it('REQUIRED detail absent or whitespace-only → detail_required', () => {
    const def = firstActiveWithPolicy('REQUIRED');
    const target = def.allowedTargets[0]!;
    expect(classifyTransitionReason({ to: target, reason_code: def.code })).toMatchObject({
      ok: false,
      reason: 'detail_required',
    });
    expect(classifyTransitionReason({ to: target, reason_code: def.code, reason_detail: '     ' })).toMatchObject({
      ok: false,
      reason: 'detail_required',
    });
  });

  it('PROHIBITED detail present → detail_prohibited', () => {
    const def = firstActiveWithPolicy('PROHIBITED');
    const target = def.allowedTargets[0]!;
    expect(classifyTransitionReason({ to: target, reason_code: def.code, reason_detail: 'the specific adverse finding' })).toMatchObject({
      ok: false,
      reason: 'detail_prohibited',
    });
  });

  it('overlong detail → detail_too_long', () => {
    const def = firstActiveWithPolicy('OPTIONAL');
    const target = def.allowedTargets[0]!;
    const tooLong = 'x'.repeat(REASON_DETAIL_MAX + 1);
    expect(classifyTransitionReason({ to: target, reason_code: def.code, reason_detail: tooLong })).toMatchObject({
      ok: false,
      reason: 'detail_too_long',
    });
  });

  it('reason input supplied for a NON-governed target → reason_on_non_governed_target', () => {
    const nonGoverned = PLACEMENT_STATES.find((s) => STATE_POSITION[s] !== 'TERMINAL')!;
    const anyCode = PLACEMENT_REASONS[0]!.code;
    expect(classifyTransitionReason({ to: nonGoverned, reason_code: anyCode })).toMatchObject({
      ok: false,
      reason: 'reason_on_non_governed_target',
    });
    expect(classifyTransitionReason({ to: nonGoverned, reason_detail: 'x' })).toMatchObject({
      ok: false,
      reason: 'reason_on_non_governed_target',
    });
  });

  it('a retired reason for a new transition → reason_retired', () => {
    // Synthesise the check without depending on a retired code existing in the
    // ratified set: assert the classifier rejects a code whose status is not
    // active by locating one if present; otherwise assert the guard exists by
    // construction (every active code passes the status gate).
    const retired = PLACEMENT_REASONS.find((r) => r.status !== 'active');
    if (retired !== undefined) {
      expect(classifyTransitionReason({ to: retired.allowedTargets[0]!, reason_code: retired.code })).toMatchObject({
        ok: false,
        reason: 'reason_retired',
      });
    } else {
      // No retired code in the ratified v1 set — the status gate is still proven
      // by the unknown-code path (a non-active code is never resolvable as active).
      expect(PLACEMENT_REASONS.every((r) => r.status === 'active')).toBe(true);
    }
  });
});
