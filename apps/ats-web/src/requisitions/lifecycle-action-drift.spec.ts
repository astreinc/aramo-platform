import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { lifecycleActionsFor, type LifecycleActionId } from './approval-affordance';
import { RECRUITING_STATUS_VALUES, type RecruitingStatus } from './types';

// L1-E lifecycle-action DRIFT spec (the recruiting-status-drift.spec.ts fs-read
// precedent — apps/ats-web CANNOT import @aramo/requisition or apps/api, a
// forbidden domain edge). The authoritative per-status legality is the BE
// TRANSITION_MATRIX (apps/api/src/policy/requisition-lifecycle.package.ts) and
// the targets are ACTION_TARGET_STATUS (libs/requisition/.../requisition-
// transitions.ts). This spec reads BOTH as TEXT and asserts the FE named-action
// table equals them, so a future BE matrix/target change fails HERE, not silently
// in the UI. The FE affordance is COSMETIC; this pins it honest to the authority.

const BE_MATRIX_SOURCE = resolve(
  __dirname,
  '../../../../apps/api/src/policy/requisition-lifecycle.package.ts',
);
const BE_TARGETS_SOURCE = resolve(
  __dirname,
  '../../../../libs/requisition/src/lib/dto/requisition-transitions.ts',
);

// The seven GOVERNED transition actions (the matrix keys). Close-submittals is
// NOT governed (it is an ordinary declared-status edit) and is asserted separately.
const GOVERNED_ACTIONS: readonly LifecycleActionId[] = [
  'CLOSE',
  'REOPEN',
  'PUT_ON_HOLD',
  'CANCEL',
  'SUBMIT_FOR_APPROVAL',
  'APPROVE',
  'REJECT',
];

// Extract one `ACTION: { ... }` block body from the TRANSITION_MATRIX literal.
function matrixBlock(source: string, action: string): string {
  const marker = `const TRANSITION_MATRIX`;
  const mStart = source.indexOf(marker);
  if (mStart === -1) throw new Error(`drift: TRANSITION_MATRIX not found in ${BE_MATRIX_SOURCE}`);
  const actionIdx = source.indexOf(`${action}: {`, mStart);
  if (actionIdx === -1) throw new Error(`drift: action ${action} not found in TRANSITION_MATRIX`);
  const openIdx = source.indexOf('{', actionIdx);
  const closeIdx = source.indexOf('}', openIdx);
  if (openIdx === -1 || closeIdx === -1) throw new Error(`drift: could not bound ${action} block`);
  return source.slice(openIdx + 1, closeIdx);
}

// Parse `status: 'ALLOW' | 'DENY'` pairs from an action block into a map.
function parseDecisions(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-z_]+):\s*'(ALLOW|DENY)'/g;
  let m: RegExpExecArray | null = re.exec(block);
  while (m !== null) {
    out[m[1]] = m[2];
    m = re.exec(block);
  }
  return out;
}

// Parse the ACTION_TARGET_STATUS map (`ACTION: 'status',`).
function parseTargets(source: string): Record<string, string> {
  const marker = 'ACTION_TARGET_STATUS';
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`drift: ACTION_TARGET_STATUS not found in ${BE_TARGETS_SOURCE}`);
  const openIdx = source.indexOf('{', start);
  const closeIdx = source.indexOf('};', openIdx);
  const body = source.slice(openIdx + 1, closeIdx);
  const out: Record<string, string> = {};
  const re = /([A-Z_]+):\s*'([a-z_]+)'/g;
  let m: RegExpExecArray | null = re.exec(body);
  while (m !== null) {
    out[m[1]] = m[2];
    m = re.exec(body);
  }
  return out;
}

const matrixSource = readFileSync(BE_MATRIX_SOURCE, 'utf8');
const targetsSource = readFileSync(BE_TARGETS_SOURCE, 'utf8');

// FULL scopes so both the canEditStatus and canApprove axes are open; no submitter
// so APPROVE is never SoD-suppressed — this yields the pure legality table.
const FULL_SCOPES = ['requisition:edit', 'requisition:approve'];
const feActionsAt = (status: RecruitingStatus): Set<LifecycleActionId> =>
  new Set(
    lifecycleActionsFor(status, FULL_SCOPES, { submitterId: null, actorId: null }).map(
      (a) => a.action,
    ),
  );

describe('L1-E lifecycle-action drift — FE table mirrors the BE authority', () => {
  it('every GOVERNED action is offered by the FE at EXACTLY the statuses the BE TRANSITION_MATRIX marks ALLOW', () => {
    for (const action of GOVERNED_ACTIONS) {
      const decisions = parseDecisions(matrixBlock(matrixSource, action));
      // The matrix authors every status explicitly (fail-closed) — sanity-check
      // the parse covered the full status space before comparing.
      expect(Object.keys(decisions).sort()).toEqual([...RECRUITING_STATUS_VALUES].sort());
      for (const status of RECRUITING_STATUS_VALUES) {
        const feOffers = feActionsAt(status).has(action);
        const beAllows = decisions[status] === 'ALLOW';
        expect(
          feOffers,
          `${action} @ ${status}: FE offers=${feOffers} but BE ALLOW=${beAllows}`,
        ).toBe(beAllows);
      }
    }
  });

  it('each FE governed action targets the status ACTION_TARGET_STATUS declares', () => {
    const targets = parseTargets(targetsSource);
    // Collect the FE toStatus for each governed action from wherever it is offered.
    const feTargets: Partial<Record<LifecycleActionId, string>> = {};
    for (const status of RECRUITING_STATUS_VALUES) {
      for (const aff of lifecycleActionsFor(status, FULL_SCOPES, { submitterId: null, actorId: null })) {
        feTargets[aff.action] = aff.toStatus;
      }
    }
    for (const action of GOVERNED_ACTIONS) {
      expect(feTargets[action], `${action} target`).toBe(targets[action]);
    }
  });

  it('Close-submittals (the non-governed edit) is offered on `open` ONLY', () => {
    for (const status of RECRUITING_STATUS_VALUES) {
      const offered = feActionsAt(status).has('CLOSE_SUBMITTALS');
      expect(offered, `CLOSE_SUBMITTALS @ ${status}`).toBe(status === 'open');
    }
  });
});
