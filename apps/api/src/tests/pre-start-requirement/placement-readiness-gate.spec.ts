import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { BlockingAssessment } from '@aramo/pre-start-requirement';

import { PlacementReadinessService } from '../../pre-start-requirement/placement-readiness.service.js';
import { RealReadinessEvaluator, type ReadinessEvaluator } from '../../pre-start-requirement/readiness-evaluator.js';

// Track 3 / E2 (§14 A2-R) — readiness gate proof via an INJECTED evaluator, never
// an environment bypass. THE FOUR-PART PROOF:
//   1. No bypass token exists on the readiness path (no process.env / SKIP_*).
//   2. Real evaluator     -> happy green, both refusals green.
//   3. Permissive double  -> happy STAYS green, both refusals FAIL (asymmetry).
//   4. Real evaluator restored -> all green.
// Part 3's asymmetry is the proof: a fixture that breaks the refusals but not the
// happy path shows the gate is load-bearing, not that the harness works.

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const PLACEMENT = '00000000-0000-0000-0000-0000000000bb';

function service(evaluator: ReadinessEvaluator) {
  const transition = vi.fn().mockResolvedValue({ id: PLACEMENT, state: 'READY_TO_START' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new PlacementReadinessService({ transition } as any, evaluator);
  return { svc, transition };
}

// The REAL evaluator delegates to the domain assessBlocking (here a mocked repo
// returning the scenario's assessment).
function realEvaluator(assessment: BlockingAssessment): ReadinessEvaluator {
  const repo = { assessBlocking: vi.fn().mockResolvedValue(assessment) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new RealReadinessEvaluator(repo as any);
}

// A PERMISSIVE test double: always "ready" regardless of input — the gate-less
// implementation. Lives ONLY in test wiring.
const permissiveEvaluator: ReadinessEvaluator = {
  assess: async (_t, placement_process_id) => ({
    placement_process_id,
    materialized: true,
    total: 0,
    unresolved_blocking: [],
    ready: true,
  }),
};

const HAPPY: BlockingAssessment = { placement_process_id: PLACEMENT, materialized: true, total: 2, unresolved_blocking: [], ready: true };
const NO_SNAPSHOT: BlockingAssessment = { placement_process_id: PLACEMENT, materialized: false, total: 0, unresolved_blocking: [], ready: false };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const UNRESOLVED: BlockingAssessment = { placement_process_id: PLACEMENT, materialized: true, total: 2, unresolved_blocking: [{ blocking: true, status: 'PENDING' } as any], ready: false };
const input = { tenant_id: TENANT, placement_process_id: PLACEMENT };

// ---- Part 1: no environment bypass token -------------------------------------

describe('§14 A2-R part 1 — no environment bypass token', () => {
  // Strip comments so the guard scans CODE, not the prose that (deliberately)
  // names the tokens it forbids.
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  }

  it('neither the gate service nor the evaluator reads process.env or any bypass token', () => {
    const here = resolve(__dirname, '..', '..', 'pre-start-requirement');
    const gate = stripComments(readFileSync(resolve(here, 'placement-readiness.service.ts'), 'utf8'));
    const evaluator = stripComments(readFileSync(resolve(here, 'readiness-evaluator.ts'), 'utf8'));
    for (const code of [gate, evaluator]) {
      expect(code).not.toMatch(/process\.env/);
      expect(code).not.toMatch(/\bSKIP_[A-Z_]+\b/);
      expect(code).not.toMatch(/\b[A-Z_]*BYPASS[A-Z_]*\b/);
    }
  });
});

// ---- Part 2 + 4: real evaluator (asserted twice — restored is the same path) --

describe.each([
  ['part 2 — real evaluator', 'first'],
  ['part 4 — real evaluator restored', 'second'],
])('§14 A2-R %s', (_label) => {
  it('happy path transitions', async () => {
    const { svc, transition } = service(realEvaluator(HAPPY));
    await svc.markReadyToStart(input, 'r');
    expect(transition).toHaveBeenCalledOnce();
  });
  it('missing snapshot is refused (PRE_START_NOT_READY / materialization_absent)', async () => {
    const { svc, transition } = service(realEvaluator(NO_SNAPSHOT));
    await expect(svc.markReadyToStart(input, 'r')).rejects.toMatchObject({
      code: 'PRE_START_NOT_READY',
      context: { details: { reason: 'materialization_absent' } },
    });
    expect(transition).not.toHaveBeenCalled();
  });
  it('unresolved blocking is refused (PRE_START_NOT_READY / blocking_unresolved)', async () => {
    const { svc, transition } = service(realEvaluator(UNRESOLVED));
    await expect(svc.markReadyToStart(input, 'r')).rejects.toMatchObject({
      code: 'PRE_START_NOT_READY',
      context: { details: { reason: 'blocking_unresolved' } },
    });
    expect(transition).not.toHaveBeenCalled();
  });
});

// ---- Part 3: permissive double — happy stays green, BOTH refusals fail --------

describe('§14 A2-R part 3 — permissive double proves the gate is load-bearing', () => {
  it('happy path STAYS green', async () => {
    const { svc, transition } = service(permissiveEvaluator);
    await svc.markReadyToStart(input, 'r');
    expect(transition).toHaveBeenCalledOnce();
  });

  // Under the permissive double, the refusal scenarios NO LONGER refuse — the
  // transition proceeds. This is the asymmetry: swapping in an implementation
  // that skips the check breaks exactly the refusal guarantees, proving the real
  // evaluator's checks are what enforce them.
  it('missing snapshot NO LONGER refuses (would-be refusal fails)', async () => {
    const { svc, transition } = service(permissiveEvaluator);
    await svc.markReadyToStart(input, 'r'); // does NOT throw
    expect(transition).toHaveBeenCalledOnce();
  });
  it('unresolved blocking NO LONGER refuses (would-be refusal fails)', async () => {
    const { svc, transition } = service(permissiveEvaluator);
    await svc.markReadyToStart(input, 'r'); // does NOT throw
    expect(transition).toHaveBeenCalledOnce();
  });
});
