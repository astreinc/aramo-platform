import { describe, it, expect } from 'vitest';

import {
  evaluateSubmittalReadiness,
  isRequisitionSubmittable,
  pipelineLinkVerdict,
  type ClientPolicyReadinessVerdict,
} from '../lib/submittal-readiness.js';
import type { SubmittalPolicyInputs } from '../lib/submittal-eligibility.port.js';

// SW-3 (Decision 3) — unit proofs for the UNIFIED authoritative readiness.
//
// The invariant: status === 'READY'  =>  the submit command cannot fail for any of
// the read-evaluable gates. This spec pins, per gate, that the composition surfaces
// the SAME typed deny_code the submit command raises (SUBMITTAL_STATE_INVALID,
// SUBMITTAL_PIPELINE_LINK_INVALID, REQUISITION_NOT_OPEN,
// SUBMITTAL_RESUME_SELECTION_REQUIRED, the eligibility codes, the client-policy
// reason_code). The submit-talent integration independently proves the submit side
// raises those codes for those states; sharing the same rule functions
// (pipelineLinkVerdict / isRequisitionSubmittable / canTransitionSubmittal /
// evaluateEligibility / the CSP engine) ties the two together.

const OPEN_POLICY: SubmittalPolicyInputs = {
  submittal_deadline: null,
  submittal_limit: null,
  manual_override: null,
  submittal_authority: 'ARAMO',
};

type Args = Parameters<typeof evaluateSubmittalReadiness>[0];

function ready(overrides: Partial<Args> = {}): Args {
  return {
    submittal_state: 'ready_for_review',
    submittal_state_can_send: true,
    pipeline: { ok: true, reason: null },
    requisition_status: 'open',
    resume_selected: true,
    policy: { inputs: OPEN_POLICY, consumed_count: 0 },
    rtr_verdict: null,
    restriction_active: false,
    engagement: 'dormant',
    client_policy: null,
    now: new Date('2026-10-02T12:00:00.000Z'),
    ...overrides,
  };
}

const req = (r: ReturnType<typeof evaluateSubmittalReadiness>, key: string) =>
  r.requirements.find((x) => x.key === key)!;
const firstBlocking = (r: ReturnType<typeof evaluateSubmittalReadiness>) =>
  r.requirements.find((x) => x.required && !x.satisfied);

describe('evaluateSubmittalReadiness — unified authoritative readiness', () => {
  it('all gates satisfied → READY, every requirement satisfied, no deny surfaced', () => {
    const r = evaluateSubmittalReadiness(ready());
    expect(r.status).toBe('READY');
    expect(r.requirements.every((x) => x.satisfied)).toBe(true);
    expect(firstBlocking(r)).toBeUndefined();
    // Generic FE-ready shape present on every requirement.
    for (const x of r.requirements) {
      expect(x).toMatchObject({
        key: expect.any(String),
        label: expect.any(String),
        required: expect.any(Boolean),
        satisfied: expect.any(Boolean),
        severity: expect.stringMatching(/blocking|overridable|info/),
        source: expect.any(String),
      });
    }
  });

  it('submittal state not sendable → BLOCKED, submittal_state first-blocking, SUBMITTAL_STATE_INVALID', () => {
    const r = evaluateSubmittalReadiness(ready({ submittal_state: 'created', submittal_state_can_send: false }));
    expect(r.status).toBe('BLOCKED');
    expect(firstBlocking(r)!.key).toBe('submittal_state');
    expect(req(r, 'submittal_state')).toMatchObject({ satisfied: false, deny_code: 'SUBMITTAL_STATE_INVALID' });
    expect(req(r, 'submittal_state').reason).toContain('created');
    expect(req(r, 'submittal_state').remediation).toBeTruthy();
  });

  it('pipeline link invalid → pipeline_link blocking, SUBMITTAL_PIPELINE_LINK_INVALID', () => {
    const r = evaluateSubmittalReadiness(ready({ pipeline: { ok: false, reason: 'not_live' } }));
    expect(r.status).toBe('BLOCKED');
    expect(req(r, 'pipeline_link')).toMatchObject({ satisfied: false, deny_code: 'SUBMITTAL_PIPELINE_LINK_INVALID' });
    expect(req(r, 'pipeline_link').reason).toContain('not_live');
  });

  it('requisition not open → requisition_open blocking, REQUISITION_NOT_OPEN', () => {
    const r = evaluateSubmittalReadiness(ready({ requisition_status: 'on_hold' }));
    expect(req(r, 'requisition_open')).toMatchObject({ satisfied: false, deny_code: 'REQUISITION_NOT_OPEN' });
  });

  it('resume not selected → resume_selected blocking, SUBMITTAL_RESUME_SELECTION_REQUIRED', () => {
    const r = evaluateSubmittalReadiness(ready({ resume_selected: false }));
    expect(req(r, 'resume_selected')).toMatchObject({ satisfied: false, deny_code: 'SUBMITTAL_RESUME_SELECTION_REQUIRED' });
  });

  it('predictive quota exhausted → submittal_window blocking, SUBMITTAL_LIMIT_REACHED (NOT the authoritative consume)', () => {
    const r = evaluateSubmittalReadiness(
      ready({ policy: { inputs: { ...OPEN_POLICY, submittal_limit: 1 }, consumed_count: 1 } }),
    );
    expect(req(r, 'submittal_window')).toMatchObject({ satisfied: false, deny_code: 'SUBMITTAL_LIMIT_REACHED' });
    expect(req(r, 'submittal_window').remediation).toContain('transactionally');
  });

  it('active client restriction → client_restriction blocking, TALENT_RESTRICTED_AT_CLIENT', () => {
    const r = evaluateSubmittalReadiness(ready({ restriction_active: true }));
    expect(req(r, 'client_restriction')).toMatchObject({ satisfied: false, deny_code: 'TALENT_RESTRICTED_AT_CLIENT' });
  });

  it('engagement policy missing → engagement blocking, CLIENT_SUBMITTAL_ENGAGEMENT_POLICY_MISSING', () => {
    const r = evaluateSubmittalReadiness(ready({ engagement: 'policy_missing' }));
    expect(req(r, 'engagement')).toMatchObject({ satisfied: false, deny_code: 'CLIENT_SUBMITTAL_ENGAGEMENT_POLICY_MISSING' });
  });

  it('engagement applicable-but-not-batch-evaluable → engagement unsatisfied (never a false-positive READY)', () => {
    const r = evaluateSubmittalReadiness(ready({ engagement: 'policy_present' }));
    expect(r.status).toBe('BLOCKED');
    expect(req(r, 'engagement').satisfied).toBe(false);
  });

  it('RTR verdict unsatisfied → rtr blocking, SUBMITTAL_RTR_NOT_EXECUTED', () => {
    const r = evaluateSubmittalReadiness(
      ready({ rtr_verdict: { satisfied: false, deny: 'SUBMITTAL_RTR_NOT_EXECUTED' } }),
    );
    expect(req(r, 'rtr')).toMatchObject({ satisfied: false, deny_code: 'SUBMITTAL_RTR_NOT_EXECUTED' });
  });

  it('client policy hard-denied → client_policy BLOCKING with the CSP reason_code', () => {
    const cp: ClientPolicyReadinessVerdict = {
      applicable: true,
      satisfied: false,
      reason_code: 'CLIENT_SUBMITTAL_WORK_AUTHORIZATION_PRESENT_REQUIRED',
      overridable: false,
    };
    const r = evaluateSubmittalReadiness(ready({ client_policy: cp }));
    expect(r.status).toBe('BLOCKED');
    expect(req(r, 'client_policy')).toMatchObject({
      satisfied: false,
      severity: 'blocking',
      deny_code: 'CLIENT_SUBMITTAL_WORK_AUTHORIZATION_PRESENT_REQUIRED',
    });
  });

  it('client policy overridable → NEEDS_ACTION (not BLOCKED), severity overridable', () => {
    const cp: ClientPolicyReadinessVerdict = {
      applicable: true,
      satisfied: false,
      reason_code: 'CLIENT_SUBMITTAL_BILL_RATE_PRESENT_REQUIRED',
      overridable: true,
    };
    const r = evaluateSubmittalReadiness(ready({ client_policy: cp }));
    expect(r.status).toBe('NEEDS_ACTION');
    expect(req(r, 'client_policy').severity).toBe('overridable');
  });

  it('ungoverned tenant (no client policy) → no client_policy requirement emitted', () => {
    const r = evaluateSubmittalReadiness(ready({ client_policy: null }));
    expect(r.requirements.find((x) => x.key === 'client_policy')).toBeUndefined();
    expect(r.status).toBe('READY');
  });

  it('gate ORDER matches the submit command: first-blocking is submittal_state when several fail', () => {
    const r = evaluateSubmittalReadiness(
      ready({
        submittal_state: 'created',
        submittal_state_can_send: false,
        pipeline: { ok: false, reason: 'missing' },
        requisition_status: 'closed',
        resume_selected: false,
      }),
    );
    expect(firstBlocking(r)!.key).toBe('submittal_state');
    // and the ordered keys follow the submit gate order.
    const keys = r.requirements.map((x) => x.key);
    expect(keys.slice(0, 4)).toEqual(['submittal_state', 'pipeline_link', 'requisition_open', 'resume_selected']);
  });
});

describe('shared structural predicates (enforced identically by the submit command)', () => {
  it('isRequisitionSubmittable: only open', () => {
    expect(isRequisitionSubmittable('open')).toBe(true);
    for (const s of ['on_hold', 'submittals_closed', 'closed', 'draft', null]) {
      expect(isRequisitionSubmittable(s)).toBe(false);
    }
  });

  it('pipelineLinkVerdict: returns the first invalidating reason, else ok', () => {
    const expected = { tenant_id: 't', requisition_id: 'r', talent_id: 'a' };
    expect(pipelineLinkVerdict({ pipeline_id: null, episode: null, episode_is_live: false, expected }))
      .toEqual({ ok: false, reason: 'missing' });
    expect(pipelineLinkVerdict({ pipeline_id: 'p', episode: null, episode_is_live: false, expected }))
      .toEqual({ ok: false, reason: 'not_found' });
    const base = { tenant_id: 't', requisition_id: 'r', talent_record_id: 'a' };
    expect(pipelineLinkVerdict({ pipeline_id: 'p', episode: { ...base, tenant_id: 'x' }, episode_is_live: true, expected }).reason).toBe('tenant_mismatch');
    expect(pipelineLinkVerdict({ pipeline_id: 'p', episode: { ...base, requisition_id: 'x' }, episode_is_live: true, expected }).reason).toBe('requisition_mismatch');
    expect(pipelineLinkVerdict({ pipeline_id: 'p', episode: { ...base, talent_record_id: 'x' }, episode_is_live: true, expected }).reason).toBe('talent_mismatch');
    expect(pipelineLinkVerdict({ pipeline_id: 'p', episode: base, episode_is_live: false, expected }).reason).toBe('not_live');
    expect(pipelineLinkVerdict({ pipeline_id: 'p', episode: base, episode_is_live: true, expected })).toEqual({ ok: true, reason: null });
  });
});
