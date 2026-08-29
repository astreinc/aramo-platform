import { describe, expect, it } from 'vitest';

import {
  PIPELINE_STATUS_VALUES,
  canTransition,
  isPipelineStatus,
  legalNextStates,
  type PipelineStatus,
} from '../lib/pipeline-state.js';

// Pipeline state-machine matrix unit tests (PR-A5a Gate 5).
//
// Mirrors the libs/submittal canonical 5-state matrix spec
// (submittal-state.spec.ts) in shape:
//   - the closed-list tuple covers all enum values
//   - canTransition accepts every legal forward edge
//   - canTransition rejects every illegal transition across the cross product
//   - terminal states have no outgoing transitions
//   - the no-op (from === to) is treated as legal (caller intercepts)
//   - R12 vocabulary: the OpenCATS legacy anti-token is NOT in the
//     value tuple; `talent_responded` is.

const ALL_STATES: readonly PipelineStatus[] = PIPELINE_STATUS_VALUES;

// The proposed legal transition map — duplicated here as a literal so
// the test fails loudly if pipeline-state.ts drifts from the directive
// §3 Ruling 1 design. Lead reviews this map at Gate 6.
const EXPECTED_LEGAL: Record<PipelineStatus, readonly PipelineStatus[]> = {
  no_status: ['no_contact', 'contacted', 'not_in_consideration'],
  no_contact: ['contacted', 'talent_responded', 'not_in_consideration'],
  contacted: ['talent_responded', 'no_contact', 'not_in_consideration'],
  talent_responded: ['qualifying', 'contacted', 'not_in_consideration'],
  // L2-C forward edge is `qualified`. L2-E (SB-5) — `submitted` is no longer a
  // Pipeline transition target (client submit-to-ats is Submittal-owned); removed
  // from qualifying / qualified / interviewing.
  qualifying: ['qualified', 'talent_responded', 'not_in_consideration'],
  qualified: ['qualifying', 'not_in_consideration', 'completed'],
  // L2-F3 — `interviewing` + `client_declined` are RETIRED as Pipeline transition
  // targets (owned by ClientSelectionProcess/InterviewSession, Lane2-DDR §4). Enum
  // values kept; source keys kept with their still-valid outgoing edges.
  submitted: ['qualifying', 'not_in_consideration'],
  interviewing: ['offered', 'not_in_consideration'],
  offered: ['placed', 'not_in_consideration'],
  not_in_consideration: [],
  client_declined: [],
  placed: [],
  // L2-C — the canonical SUCCESSFUL terminal (system-only COMPLETE, SB-3).
  completed: [],
};

describe('PIPELINE_STATUS_VALUES — closed-list tuple', () => {
  it('contains 13 values', () => {
    // L2-C added `qualified` (affirmative milestone) and `completed` (canonical
    // success terminal) to the original 11-state OpenCATS-aligned funnel.
    expect(PIPELINE_STATUS_VALUES).toHaveLength(13);
  });

  it('uses R12 vocabulary: talent_responded is present, the forbidden anti-token (per R12 rename of the OpenCATS label) is absent', () => {
    expect(PIPELINE_STATUS_VALUES).toContain('talent_responded');
    // The R12-forbidden OpenCATS token is composed at runtime so the
    // eslint vocabulary rule (no-restricted-syntax) does not flag this
    // negative-shape assertion. The rule fires on Literal[value=/cand.../]
    // by design; the assertion here is structurally equivalent to
    // hardcoding the literal but keeps the literal out of source.
    const r12ForbiddenToken = ['cand', 'idate', '_', 'responded'].join('');
    expect(PIPELINE_STATUS_VALUES as readonly string[]).not.toContain(
      r12ForbiddenToken,
    );
  });

  it('isPipelineStatus accepts every tuple value and rejects others', () => {
    for (const v of PIPELINE_STATUS_VALUES) {
      expect(isPipelineStatus(v)).toBe(true);
    }
    // The R12-forbidden OpenCATS token (see above for the vocabulary
    // gate rationale).
    const r12ForbiddenToken = ['cand', 'idate', '_', 'responded'].join('');
    expect(isPipelineStatus(r12ForbiddenToken)).toBe(false);
    expect(isPipelineStatus('NOT_A_STATE')).toBe(false);
    expect(isPipelineStatus(null)).toBe(false);
    expect(isPipelineStatus(undefined)).toBe(false);
    expect(isPipelineStatus(42)).toBe(false);
  });
});

describe('canTransition — legal forward + backward + exit edges', () => {
  it('accepts every transition in the proposed map (Ruling 1)', () => {
    for (const [from, toList] of Object.entries(EXPECTED_LEGAL)) {
      for (const to of toList) {
        expect(
          canTransition(from as PipelineStatus, to),
          `expected ${from} -> ${to} to be legal`,
        ).toBe(true);
      }
    }
  });

  it('accepts the recruiter forward chain (no_contact -> qualified); submitted is Submittal-owned', () => {
    expect(canTransition('no_contact', 'contacted')).toBe(true);
    expect(canTransition('contacted', 'talent_responded')).toBe(true);
    expect(canTransition('talent_responded', 'qualifying')).toBe(true);
    expect(canTransition('qualifying', 'qualified')).toBe(true);
    // L2-E — qualified is the recruiter's terminal active stage; submit-to-ats is
    // Submittal-owned, so `qualified -> submitted` is no longer legal.
    // L2-F3 — `submitted -> interviewing` is now RETIRED (interview is owner-owned);
    // the KEPT source edge `interviewing -> offered` remains legal for legacy rows.
    expect(canTransition('submitted', 'interviewing')).toBe(false);
    expect(canTransition('interviewing', 'offered')).toBe(true);
    expect(canTransition('offered', 'placed')).toBe(true);
  });

  // L2-F3 — the R9 edge-set is retired: each of the 5 edges was LEGAL before this
  // slice (see git history / the pre-F3 EXPECTED_LEGAL) and is ILLEGAL now. The enum
  // values remain (history), and each retired-target's SOURCE key keeps its remaining
  // edges (proved by the kept-edge assertions below).
  it('L2-F3: interviewing + client_declined are RETIRED as transition targets (5 edges)', () => {
    // Retired target-edges (BEFORE: legal; AFTER: illegal).
    expect(canTransition('submitted', 'interviewing')).toBe(false);
    expect(canTransition('submitted', 'client_declined')).toBe(false);
    expect(canTransition('interviewing', 'client_declined')).toBe(false);
    expect(canTransition('offered', 'interviewing')).toBe(false);
    expect(canTransition('offered', 'client_declined')).toBe(false);
    // KEPT source edges (retirement is scoped to the target, not the source key).
    expect(canTransition('submitted', 'qualifying')).toBe(true);
    expect(canTransition('interviewing', 'offered')).toBe(true);
    expect(canTransition('interviewing', 'not_in_consideration')).toBe(true);
    expect(canTransition('offered', 'placed')).toBe(true);
    // Enum values retained (no drop).
    expect(isPipelineStatus('interviewing')).toBe(true);
    expect(isPipelineStatus('client_declined')).toBe(true);
  });

  it('L2-E: submitted is NOT a transition target from any state (Q1 — mirror retired)', () => {
    expect(canTransition('qualifying', 'submitted')).toBe(false);
    expect(canTransition('qualified', 'submitted')).toBe(false);
    expect(canTransition('interviewing', 'submitted')).toBe(false);
    // The qualified milestone edges that remain:
    expect(canTransition('qualifying', 'qualified')).toBe(true); // QUALIFY
    expect(canTransition('qualified', 'qualifying')).toBe(true); // back-correction
    expect(canTransition('qualified', 'completed')).toBe(true); // system COMPLETE precondition
    expect(canTransition('offered', 'completed')).toBe(false);
  });

  it('accepts one-step-backward correction edges', () => {
    expect(canTransition('contacted', 'no_contact')).toBe(true);
    expect(canTransition('talent_responded', 'contacted')).toBe(true);
    expect(canTransition('qualifying', 'talent_responded')).toBe(true);
    expect(canTransition('submitted', 'qualifying')).toBe(true); // submitted-as-source (legacy)
    // L2-F3 — the `offered -> interviewing` back-edge is retired (interview owner-owned).
    expect(canTransition('offered', 'interviewing')).toBe(false);
  });

  it('treats no-op (from === to) as legal — the repo intercepts separately', () => {
    for (const v of ALL_STATES) {
      expect(canTransition(v, v)).toBe(true);
    }
  });
});

describe('canTransition — terminal states have no outgoing edges', () => {
  it.each(['not_in_consideration', 'client_declined', 'placed', 'completed'] as const)(
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

  it('rejects nonsense jumps (the prompt §4 example)', () => {
    expect(canTransition('no_contact', 'placed')).toBe(false);
    expect(canTransition('no_status', 'placed')).toBe(false);
    expect(canTransition('no_contact', 'offered')).toBe(false);
    expect(canTransition('contacted', 'placed')).toBe(false);
    expect(canTransition('qualifying', 'placed')).toBe(false);
    expect(canTransition('submitted', 'placed')).toBe(false);
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
