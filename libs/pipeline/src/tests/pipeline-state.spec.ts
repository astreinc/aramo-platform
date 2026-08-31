import { describe, expect, it } from 'vitest';

import {
  PIPELINE_STATUS_VALUES,
  canTransition,
  isPipelineStatus,
  legalNextStates,
  type PipelineStatus,
} from '../lib/pipeline-state.js';

// Pipeline state-machine matrix unit tests.
//
//   - the closed-list tuple covers all enum values (canonical 7-state)
//   - canTransition accepts every legal forward/backward/exit edge
//   - canTransition rejects every illegal transition across the cross product
//   - terminal states have no outgoing transitions
//   - the no-op (from === to) is treated as legal (caller intercepts)
//   - R12 vocabulary: the OpenCATS legacy anti-token is NOT in the value tuple;
//     `talent_responded` is.

const ALL_STATES: readonly PipelineStatus[] = PIPELINE_STATUS_VALUES;

// The canonical legal transition map — duplicated here as a literal so the test
// fails loudly if pipeline-state.ts drifts. The Pipeline owns recruiting progress
// only; everything past `qualified` is downstream-owned and never a Pipeline status.
const EXPECTED_LEGAL: Record<PipelineStatus, readonly PipelineStatus[]> = {
  no_contact: ['contacted', 'talent_responded', 'not_in_consideration'],
  contacted: ['talent_responded', 'no_contact', 'not_in_consideration'],
  talent_responded: ['qualifying', 'contacted', 'not_in_consideration'],
  qualifying: ['qualified', 'talent_responded', 'not_in_consideration'],
  // `qualified → completed` is legal ONLY so the system COMPLETE precondition validates.
  qualified: ['qualifying', 'not_in_consideration', 'completed'],
  not_in_consideration: [],
  completed: [],
};

describe('PIPELINE_STATUS_VALUES — closed-list tuple', () => {
  it('contains the canonical 7 values', () => {
    expect(PIPELINE_STATUS_VALUES).toHaveLength(7);
    expect([...PIPELINE_STATUS_VALUES].sort()).toEqual([
      'completed',
      'contacted',
      'no_contact',
      'not_in_consideration',
      'qualified',
      'qualifying',
      'talent_responded',
    ]);
  });

  it('uses R12 vocabulary: talent_responded is present, the forbidden anti-token (per R12 rename of the OpenCATS label) is absent', () => {
    expect(PIPELINE_STATUS_VALUES).toContain('talent_responded');
    // The R12-forbidden OpenCATS token is composed at runtime so the eslint
    // vocabulary rule does not flag this negative-shape assertion.
    const r12ForbiddenToken = ['cand', 'idate', '_', 'responded'].join('');
    expect(PIPELINE_STATUS_VALUES as readonly string[]).not.toContain(
      r12ForbiddenToken,
    );
  });

  it('isPipelineStatus accepts every tuple value and rejects others', () => {
    for (const v of PIPELINE_STATUS_VALUES) {
      expect(isPipelineStatus(v)).toBe(true);
    }
    // The retired legacy values are no longer valid Pipeline statuses.
    for (const retired of ['no_status', 'submitted', 'interviewing', 'offered', 'client_declined', 'placed']) {
      expect(isPipelineStatus(retired)).toBe(false);
    }
    const r12ForbiddenToken = ['cand', 'idate', '_', 'responded'].join('');
    expect(isPipelineStatus(r12ForbiddenToken)).toBe(false);
    expect(isPipelineStatus('NOT_A_STATE')).toBe(false);
    expect(isPipelineStatus(null)).toBe(false);
    expect(isPipelineStatus(undefined)).toBe(false);
    expect(isPipelineStatus(42)).toBe(false);
  });
});

describe('canTransition — legal forward + backward + exit edges', () => {
  it('accepts every transition in the canonical map', () => {
    for (const [from, toList] of Object.entries(EXPECTED_LEGAL)) {
      for (const to of toList) {
        expect(
          canTransition(from as PipelineStatus, to),
          `expected ${from} -> ${to} to be legal`,
        ).toBe(true);
      }
    }
  });

  it('accepts the recruiter forward chain (no_contact -> qualified)', () => {
    expect(canTransition('no_contact', 'contacted')).toBe(true);
    expect(canTransition('contacted', 'talent_responded')).toBe(true);
    expect(canTransition('talent_responded', 'qualifying')).toBe(true);
    expect(canTransition('qualifying', 'qualified')).toBe(true);
    // `qualified` is the last Pipeline-owned state; the downstream aggregates
    // (Submittal / Client-Selection / Offer / Placement) advance independently.
    expect(canTransition('qualified', 'completed')).toBe(true); // system COMPLETE precondition
    expect(canTransition('qualified', 'qualifying')).toBe(true); // back-correction
  });

  it('accepts one-step-backward correction edges', () => {
    expect(canTransition('contacted', 'no_contact')).toBe(true);
    expect(canTransition('talent_responded', 'contacted')).toBe(true);
    expect(canTransition('qualifying', 'talent_responded')).toBe(true);
  });

  it('every non-terminal offers a disposition exit to not_in_consideration', () => {
    for (const from of ['no_contact', 'contacted', 'talent_responded', 'qualifying', 'qualified'] as const) {
      expect(canTransition(from, 'not_in_consideration')).toBe(true);
    }
  });

  it('treats no-op (from === to) as legal — the repo intercepts separately', () => {
    for (const v of ALL_STATES) {
      expect(canTransition(v, v)).toBe(true);
    }
  });
});

describe('canTransition — terminal states have no outgoing edges', () => {
  it.each(['not_in_consideration', 'completed'] as const)(
    'rejects every transition out of %s except no-op',
    (terminal) => {
      for (const to of ALL_STATES) {
        if (to === terminal) {
          expect(canTransition(terminal, to)).toBe(true); // no-op
        } else {
          expect(
            canTransition(terminal, to),
            `expected ${terminal} -> ${to} to be rejected`,
          ).toBe(false);
        }
      }
    },
  );
});

describe('canTransition — illegal transitions across the cross product', () => {
  it('rejects every non-listed transition', () => {
    for (const from of ALL_STATES) {
      const legal = new Set([from, ...EXPECTED_LEGAL[from]]);
      for (const to of ALL_STATES) {
        const actual = canTransition(from, to);
        const expected = legal.has(to);
        expect(
          actual,
          `${from} -> ${to}: expected ${String(expected)}, got ${String(actual)}`,
        ).toBe(expected);
      }
    }
  });

  it('rejects nonsense jumps', () => {
    expect(canTransition('no_contact', 'completed')).toBe(false);
    expect(canTransition('no_contact', 'qualified')).toBe(false);
    expect(canTransition('contacted', 'qualified')).toBe(false);
    expect(canTransition('talent_responded', 'completed')).toBe(false);
    // `completed` is reachable ONLY from `qualified` (the system COMPLETE precondition).
    expect(canTransition('qualifying', 'completed')).toBe(false);
  });
});

describe('legalNextStates — UI affordance enumeration', () => {
  it('matches the canTransition matrix for every source state', () => {
    for (const from of ALL_STATES) {
      const enumerated = legalNextStates(from);
      const legalFromMatrix = ALL_STATES.filter(
        (to) => to !== from && canTransition(from, to),
      );
      expect([...enumerated].sort()).toEqual([...legalFromMatrix].sort());
    }
  });
});
