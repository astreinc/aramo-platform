import { describe, expect, it } from 'vitest';

import { deriveQualifiedReadiness } from '../requisition-talent-board/requisition-talent-board-read.service.js';
import type { BoardResume } from '../requisition-talent-board/dto/requisition-talent-board.view.js';

// TB-4 (remediated) — the truthfulness invariant of the Qualified band, proven deterministically
// over the pure readiness function:
//   READY TO SUBMIT  ⟺  every applicable submit gate is satisfied
//   any unresolved / unavailable / blocked gate  →  NEEDS ACTION (never a false-positive Ready)
// The band consumes the REAL evaluateEligibility port; these cases pin each gate's contribution.

const RESUME_OK: BoardResume = { resume_edition_id: 're', source: 'working_selection', locked: false };
const RESUME_NONE: BoardResume = { resume_edition_id: null, source: 'none', locked: false };
const OPEN = { status: 'open' as const, reason: null };
const OPEN_INPUTS = {
  inputs: { submittal_deadline: null, submittal_limit: null, manual_override: null, submittal_authority: 'ARAMO' as const },
  consumed_count: 0,
};
const NOW = new Date('2026-01-15T00:00:00.000Z');

const base = {
  req_readiness: OPEN,
  resume: RESUME_OK,
  policy: OPEN_INPUTS,
  rtr_verdict: null,
  restriction_active: false,
  engagement: 'dormant' as const,
  now: NOW,
};

describe('deriveQualifiedReadiness — never a false-positive Ready (TB-4)', () => {
  it('all applicable gates satisfied (dormant engagement, open window, no restriction, résumé, RTR ungated) → ready', () => {
    const r = deriveQualifiedReadiness(base);
    expect(r.band).toBe('ready_to_submit');
    expect(r.blockers).toEqual([]);
  });

  it('client restriction active → NEEDS ACTION + client_restricted (never Ready)', () => {
    const r = deriveQualifiedReadiness({ ...base, restriction_active: true });
    expect(r.band).toBe('needs_action');
    expect(r.blockers).toContain('client_restricted');
  });

  it('engagement policy missing (governed, no effective policy) → NEEDS ACTION + engagement_policy_missing', () => {
    const r = deriveQualifiedReadiness({ ...base, engagement: 'policy_missing' });
    expect(r.band).toBe('needs_action');
    expect(r.blockers).toContain('engagement_policy_missing');
  });

  it('engagement policy PRESENT but per-talent unavailable → NEEDS ACTION, never Ready even when all else is clear', () => {
    const r = deriveQualifiedReadiness({ ...base, engagement: 'policy_present' });
    expect(r.band).toBe('needs_action');
    expect(r.blockers).toEqual(['engagement_readiness_unavailable']);
  });

  it('RTR required but not executed → NEEDS ACTION + rtr_not_executed', () => {
    const r = deriveQualifiedReadiness({
      ...base,
      rtr_verdict: { satisfied: false, deny: 'SUBMITTAL_RTR_NOT_EXECUTED', missing: ['RIGHT_TO_REPRESENT'] },
    });
    expect(r.band).toBe('needs_action');
    expect(r.blockers).toContain('rtr_not_executed');
  });

  it('no résumé selected → NEEDS ACTION + resume_not_selected (orthogonal Board pre-check)', () => {
    const r = deriveQualifiedReadiness({ ...base, resume: RESUME_NONE });
    expect(r.band).toBe('needs_action');
    expect(r.blockers).toContain('resume_not_selected');
  });

  it('paused submittal window → NEEDS ACTION + submittals_closed', () => {
    const r = deriveQualifiedReadiness({
      ...base,
      policy: { inputs: { ...OPEN_INPUTS.inputs, manual_override: 'PAUSED' }, consumed_count: 0 },
      req_readiness: { status: 'paused', reason: 'paused' },
    });
    expect(r.band).toBe('needs_action');
    expect(r.blockers).toContain('submittals_closed');
  });
});
