import { describe, expect, it } from 'vitest';

import type { TalentRequisitionJourney } from '../pipeline/talent-journey-api';

import { deriveSteps, deriveExceptions } from './offer-start-steps';

function journey(overrides: {
  sub?: Record<string, string | null>;
  doc?: TalentRequisitionJourney['offer_document'];
}): TalentRequisitionJourney {
  return {
    requisition_id: 'r1',
    talent_record_id: 't1',
    current_journey_stage: 'OFFER',
    stages: [],
    sub_states: {
      pipeline_stage: null,
      submittal_state: null,
      selection_state: null,
      interview_state: null,
      offer_state: null,
      placement_state: null,
      pre_start_state: null,
      assignment_state: null,
      ...(overrides.sub ?? {}),
    },
    actions: [],
    offer_document: overrides.doc ?? null,
  };
}

const statusOf = (steps: readonly { key: string; status: string }[], key: string) =>
  steps.find((s) => s.key === key)?.status;

describe('deriveSteps — server-fact-driven, no FE business state', () => {
  it('client selected only → client_selected done, offer_prepared current, later steps future', () => {
    const steps = deriveSteps(journey({ sub: { selection_state: 'SELECTED' } }));
    expect(statusOf(steps, 'client_selected')).toBe('done');
    expect(statusOf(steps, 'offer_prepared')).toBe('current');
    expect(statusOf(steps, 'sent')).toBe('future');
  });

  it('offer SENT + offer-letter AWAITING_SIGNATURE → sent done, signed_accepted current', () => {
    const steps = deriveSteps(journey({ sub: { selection_state: 'SELECTED', offer_state: 'SENT' }, doc: { owner: 'documents', document_id: 'd1', status: 'AWAITING_SIGNATURE' } }));
    expect(statusOf(steps, 'sent')).toBe('done');
    expect(statusOf(steps, 'signed_accepted')).toBe('current');
  });

  it('§2.5: EXECUTED letter but offer still SENT → signed_accepted NOT done (acceptance is separate)', () => {
    const steps = deriveSteps(journey({ sub: { offer_state: 'SENT' }, doc: { owner: 'documents', document_id: 'd1', status: 'EXECUTED' } }));
    expect(statusOf(steps, 'signed_accepted')).toBe('current'); // document signed, but not accepted → not done
  });

  it('offer ACCEPTED + EXECUTED letter → signed_accepted done, pre_start current', () => {
    const steps = deriveSteps(journey({ sub: { offer_state: 'ACCEPTED' }, doc: { owner: 'documents', document_id: 'd1', status: 'EXECUTED' } }));
    expect(statusOf(steps, 'signed_accepted')).toBe('done');
    expect(statusOf(steps, 'pre_start')).toBe('current');
  });

  it('declined offer → signed_accepted marked declined', () => {
    const steps = deriveSteps(journey({ sub: { offer_state: 'DECLINED' } }));
    expect(statusOf(steps, 'signed_accepted')).toBe('declined');
  });

  it('direct-hire relabels the final steps', () => {
    const steps = deriveSteps(journey({ sub: { placement_state: 'STARTED' } }), 'DIRECT_HIRE');
    expect(steps.find((s) => s.key === 'assignment')?.label).toBe('Start confirmed');
    expect(steps.find((s) => s.key === 'started')?.label).toBe('Placement');
  });

  it('OMITS internal approval entirely (no real approval authority — §6.2 GAP)', () => {
    const steps = deriveSteps(journey({ sub: { offer_state: 'SENT' } }));
    expect(steps.some((s) => /approval/i.test(s.label))).toBe(false);
  });
});

describe('deriveExceptions — exceptions only (§2.3)', () => {
  it('no exceptions in the happy path', () => {
    expect(deriveExceptions(journey({ sub: { offer_state: 'SENT' } }))).toHaveLength(0);
  });
  it('expired offer, declined offer and blocked pre-start each surface', () => {
    expect(deriveExceptions(journey({ sub: { offer_state: 'EXPIRED' } }))[0]?.key).toBe('offer_expired');
    expect(deriveExceptions(journey({ sub: { offer_state: 'DECLINED' } }))[0]?.key).toBe('offer_declined');
    expect(deriveExceptions(journey({ sub: { placement_state: 'BLOCKED' } }))[0]?.key).toBe('pre_start_blocked');
  });
});
