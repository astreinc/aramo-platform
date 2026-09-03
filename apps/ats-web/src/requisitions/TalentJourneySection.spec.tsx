import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { TalentRequisitionJourney } from '../pipeline/talent-journey-api';

import { TalentJourneySection } from './TalentJourneySection';

// S3-FIX regression — the drawer's Talent Journey must behave as a GOVERNED
// next-action cockpit: milestone completion only on real owner proof, Offer gated
// on ClientSelection SELECTED, no premature Create/Make offer. These prove the
// workflow-sequencing fix (a just-added no_contact Talent must NOT show Offer).

type Sub = TalentRequisitionJourney['sub_states'];
function makeJourney(
  stages: TalentRequisitionJourney['stages'],
  sub: Sub,
  actions: TalentRequisitionJourney['actions'] = [],
): TalentRequisitionJourney {
  const current =
    stages.length === 0 ? 'SOURCED' : stages[stages.length - 1]!.stage;
  return {
    requisition_id: 'r1',
    talent_record_id: 't1',
    current_journey_stage: current,
    stages,
    sub_states: sub,
    actions,
  };
}

function renderSection(
  journey: TalentRequisitionJourney,
  over: { canAdvancePipeline?: boolean } = {},
) {
  const onRecruitingAdvance = vi.fn();
  render(
    <MemoryRouter>
      <TalentJourneySection
        journey={journey}
        talentRecordId="t1"
        requisitionId="r1"
        canAdvancePipeline={over.canAdvancePipeline ?? true}
        onRecruitingAdvance={onRecruitingAdvance}
        pipelineBusy={false}
        error={null}
      />
    </MemoryRouter>,
  );
  return { onRecruitingAdvance };
}

// The rail milestone <li> class (done/current/pending), scoped to the rail list.
function railState(label: string): string {
  const list = screen.getByRole('list', { name: 'Talent journey' });
  return within(list).getByText(label).closest('li')?.className ?? '';
}

describe('TalentJourneySection — workflow sequencing', () => {
  // Test 1 + Test 8 — a newly-added Talent (no_contact, no downstream owner rows).
  it('new Talent (no_contact): Recruiting current, all downstream PENDING, no offer/submittal CTA', () => {
    const { onRecruitingAdvance } = renderSection(
      makeJourney(
        [{ stage: 'SOURCED', owner: 'pipeline', source_object_id: 'p1' }],
        { pipeline_stage: 'no_contact', selection_state: null, offer_state: null },
      ),
    );
    expect(railState('Recruiting')).toContain('rc-cjr__m--current');
    // Test 8 — no downstream row ⇒ NEVER completed; all future lanes pending.
    for (const m of ['Client', 'Offer', 'Pre-Start', 'Employment']) {
      expect(railState(m)).toContain('rc-cjr__m--pending');
    }
    // No premature later-owner actions.
    expect(screen.queryByText(/Create offer/i)).toBeNull();
    expect(screen.queryByText(/Make offer/i)).toBeNull();
    expect(screen.queryByText('Prepare submittal')).toBeNull();
    // Primary CTA = the legal recruiting action.
    const cta = screen.getByRole('button', { name: 'Contact Talent' });
    cta.click();
    expect(onRecruitingAdvance).toHaveBeenCalledWith('contacted');
  });

  // Test 2 — Qualified: recruiting current, Prepare submittal available, offer absent.
  it('qualified: Recruiting current, Prepare submittal present, Create offer absent', () => {
    renderSection(
      makeJourney(
        [{ stage: 'QUALIFIED', owner: 'pipeline', source_object_id: 'p1' }],
        { pipeline_stage: 'qualified', selection_state: null, offer_state: null },
      ),
    );
    expect(railState('Recruiting')).toContain('rc-cjr__m--current');
    expect(screen.getByText('Prepare submittal')).toBeTruthy();
    expect(screen.queryByText(/Create offer/i)).toBeNull();
  });

  // Test 3 — Client Review: Client current, Recruiting done, offer absent.
  it('client review: Client current, Recruiting done, Create offer absent', () => {
    renderSection(
      makeJourney(
        [
          { stage: 'QUALIFIED', owner: 'pipeline', source_object_id: 'p1' },
          { stage: 'SUBMITTED', owner: 'submittal', source_object_id: 's1' },
          { stage: 'CLIENT_REVIEW', owner: 'client-selection', source_object_id: 'cs1' },
        ],
        {
          pipeline_stage: 'qualified',
          submittal_state: 'submitted_to_ats',
          selection_state: 'CLIENT_REVIEW',
          offer_state: null,
        },
      ),
    );
    expect(railState('Recruiting')).toContain('rc-cjr__m--done');
    expect(railState('Client')).toContain('rc-cjr__m--current');
    expect(railState('Offer')).toContain('rc-cjr__m--pending');
    expect(screen.queryByText(/Create offer/i)).toBeNull();
  });

  // Test 4 — Interview: Client current, interview surfaced, offer absent.
  it('interview: Client current, interview shown, offer absent', () => {
    renderSection(
      makeJourney(
        [
          { stage: 'QUALIFIED', owner: 'pipeline', source_object_id: 'p1' },
          { stage: 'SUBMITTED', owner: 'submittal', source_object_id: 's1' },
          { stage: 'INTERVIEW', owner: 'interview', source_object_id: 'cs1' },
        ],
        {
          pipeline_stage: 'qualified',
          submittal_state: 'submitted_to_ats',
          selection_state: 'INTERVIEW',
          interview_state: 'SCHEDULED',
          offer_state: null,
        },
      ),
    );
    expect(railState('Client')).toContain('rc-cjr__m--current');
    expect(screen.getAllByText(/Interview/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Create offer/i)).toBeNull();
  });

  // Test 5 — Client Selected: Client done, Offer current/actionable.
  it('selected: Client done, Offer current, Create-offer next step present', () => {
    renderSection(
      makeJourney(
        [
          { stage: 'QUALIFIED', owner: 'pipeline', source_object_id: 'p1' },
          { stage: 'SUBMITTED', owner: 'submittal', source_object_id: 's1' },
          { stage: 'CLIENT_REVIEW', owner: 'client-selection', source_object_id: 'cs1' },
        ],
        {
          pipeline_stage: 'qualified',
          submittal_state: 'submitted_to_ats',
          selection_state: 'SELECTED',
          offer_state: null,
        },
      ),
    );
    expect(railState('Client')).toContain('rc-cjr__m--done');
    expect(railState('Offer')).toContain('rc-cjr__m--current');
    expect(screen.getByText('Create offer for this Talent')).toBeTruthy();
  });

  // Test 6 — Offer exists: Offer milestone reached from a real offer row.
  it('offer exists: Offer milestone is current from a real offer row', () => {
    renderSection(
      makeJourney(
        [
          { stage: 'QUALIFIED', owner: 'pipeline', source_object_id: 'p1' },
          { stage: 'CLIENT_REVIEW', owner: 'client-selection', source_object_id: 'cs1' },
          { stage: 'OFFER', owner: 'offer', source_object_id: 'o1' },
        ],
        { pipeline_stage: 'qualified', selection_state: 'SELECTED', offer_state: 'SENT' },
      ),
    );
    expect(railState('Offer')).toContain('rc-cjr__m--current');
    expect(railState('Client')).toContain('rc-cjr__m--done');
  });

  // Test 7 — authorization: without pipeline:change-status the advance CTA is absent.
  it('authorization: no pipeline:change-status ⇒ recruiting advance CTA absent', () => {
    renderSection(
      makeJourney(
        [{ stage: 'SOURCED', owner: 'pipeline', source_object_id: 'p1' }],
        { pipeline_stage: 'no_contact', selection_state: null, offer_state: null },
      ),
      { canAdvancePipeline: false },
    );
    expect(screen.queryByRole('button', { name: 'Contact Talent' })).toBeNull();
    expect(screen.getByText(/do not have permission/i)).toBeTruthy();
  });

  // Placement in PRE_START must be Pre-Start (NOT Employment) — the owner→milestone
  // bug the recruiter progression surfaced. Employment is only reached at STARTED.
  it('placement PRE_START: Pre-Start current, Offer done, Employment pending', () => {
    renderSection(
      makeJourney(
        [
          { stage: 'QUALIFIED', owner: 'pipeline', source_object_id: 'p1' },
          { stage: 'CLIENT_REVIEW', owner: 'client-selection', source_object_id: 'cs1' },
          { stage: 'OFFER', owner: 'offer', source_object_id: 'o1' },
          { stage: 'PRE_START', owner: 'placement', source_object_id: 'pl1' },
        ],
        {
          pipeline_stage: 'qualified',
          selection_state: 'SELECTED',
          offer_state: 'ACCEPTED',
          placement_state: 'PRE_START',
        },
      ),
    );
    expect(railState('Pre-Start')).toContain('rc-cjr__m--current');
    expect(railState('Offer')).toContain('rc-cjr__m--done');
    expect(railState('Employment')).toContain('rc-cjr__m--pending');
  });

  it('placement STARTED: Employment current, Pre-Start done', () => {
    renderSection(
      makeJourney(
        [
          { stage: 'OFFER', owner: 'offer', source_object_id: 'o1' },
          { stage: 'STARTED', owner: 'placement', source_object_id: 'pl1' },
        ],
        {
          pipeline_stage: 'qualified',
          selection_state: 'SELECTED',
          offer_state: 'ACCEPTED',
          placement_state: 'STARTED',
        },
      ),
    );
    expect(railState('Employment')).toContain('rc-cjr__m--current');
    expect(railState('Pre-Start')).toContain('rc-cjr__m--done');
  });
});
